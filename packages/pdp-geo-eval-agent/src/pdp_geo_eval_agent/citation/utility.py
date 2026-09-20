"""GEU-style deterministic utility parsers, scorers, and release gate."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import cast

from neo_js_compat import js_round

from ..models import (
    CitationQualityScore,
    CitationSupportJudgment,
    EvidenceContradiction,
    ExtractedClaim,
    KeypointCoverageScore,
    KeypointJudgment,
    UtilityGateResult,
    UtilityGateThresholds,
    WeakClaim,
)
from ..prompts.citation_utility import (
    build_citation_support_prompt,
    build_claim_extraction_prompt,
    build_keypoint_judge_prompt,
)
from .engine import complete_with_provider

CITATION_SUPPORT_VALUES = {"no_support": 0.0, "partial_support": 0.5, "full_support": 1.0}
DEFAULT_UTILITY_GATE_THRESHOLDS = UtilityGateThresholds(
    min_visibility_delta=0.0,
    max_kpc=0.0,
    min_kpr=0.8,
    min_citation_precision=0.7,
)
PDP_COPY_UTILITY_GATE_THRESHOLDS = UtilityGateThresholds(
    min_visibility_delta=DEFAULT_UTILITY_GATE_THRESHOLDS.min_visibility_delta,
    max_kpc=DEFAULT_UTILITY_GATE_THRESHOLDS.max_kpc,
    min_kpr=0.0,
    min_citation_precision=DEFAULT_UTILITY_GATE_THRESHOLDS.min_citation_precision,
)


def parse_keypoint_judgments(raw: str, expected_ids: Sequence[str]) -> dict[str, KeypointJudgment]:
    parsed = _parse_json_object(raw)
    judgments: dict[str, KeypointJudgment] = {}
    for evidence_id in expected_ids:
        entry = parsed.get(evidence_id)
        if not isinstance(entry, Mapping):
            raise ValueError(f'Keypoint judge response is missing evidence id "{evidence_id}".')
        record = _record(cast(object, entry))
        label = record.get("label")
        justification = record.get("justification")
        if not isinstance(label, str) or label not in {"Supported", "Omitted", "Contradicted"}:
            raise ValueError(f'Keypoint judge returned an invalid label for "{evidence_id}": {_js_string(label)}')
        if not isinstance(justification, str) or not justification.strip():
            raise ValueError(f'Keypoint judge returned no justification for "{evidence_id}".')
        judgments[evidence_id] = KeypointJudgment(label=label, justification=justification.strip())
    return judgments


def parse_extracted_claims(raw: str) -> list[ExtractedClaim]:
    parsed = _parse_json_object(raw)
    raw_claims = parsed.get("claims")
    if not isinstance(raw_claims, list):
        raise ValueError('Claim extraction response has no "claims" array.')
    claims: list[ExtractedClaim] = []
    for index, entry in enumerate(_objects(cast(object, raw_claims))):
        record = _record(entry)
        claim = record.get("claim")
        if not isinstance(claim, str) or not claim.strip():
            raise ValueError(f"Extracted claim {index + 1} has no text.")
        raw_indices = record.get("sourceIndices")
        source_indices = [
            value
            for value in _objects(cast(object, raw_indices))
            if isinstance(value, int) and not isinstance(value, bool)
        ] if isinstance(raw_indices, list) else []
        raw_claim_id = record.get("claimId")
        claim_id = raw_claim_id if isinstance(raw_claim_id, int) and not isinstance(raw_claim_id, bool) else index + 1
        claims.append(ExtractedClaim(claim_id=claim_id, claim=claim.strip(), source_indices=source_indices))
    return claims


def parse_citation_support(raw: str) -> CitationSupportJudgment:
    parsed = _parse_json_object(raw)
    support = parsed.get("support")
    justification = parsed.get("justification")
    if not isinstance(support, str) or support not in CITATION_SUPPORT_VALUES:
        raise ValueError(f"Citation support judge returned an invalid level: {_js_string(support)}")
    if not isinstance(justification, str) or not justification.strip():
        raise ValueError("Citation support judge returned no justification.")
    return CitationSupportJudgment(support=support, justification=justification.strip())


def score_keypoint_coverage(
    judgments: Mapping[str, KeypointJudgment | Mapping[str, object]],
) -> KeypointCoverageScore:
    supported = 0
    omitted = 0
    contradicted = 0
    contradictions: list[EvidenceContradiction] = []
    for evidence_id, raw_judgment in judgments.items():
        judgment = _coerce_keypoint_judgment(raw_judgment)
        if judgment.label == "Supported":
            supported += 1
        elif judgment.label == "Contradicted":
            contradicted += 1
            contradictions.append(EvidenceContradiction(evidence_id=evidence_id, justification=judgment.justification))
        else:
            omitted += 1
    total = len(judgments)
    return KeypointCoverageScore(
        kpr=supported / total if total else 0.0,
        kpc=contradicted / total if total else 0.0,
        supported=supported,
        omitted=omitted,
        contradicted=contradicted,
        total=total,
        contradictions=contradictions,
    )


def score_citation_quality(
    claims: Sequence[ExtractedClaim | Mapping[str, object]],
    supports_by_claim: Mapping[int, Sequence[CitationSupportJudgment | Mapping[str, object]]],
) -> CitationQualityScore:
    normalized_claims = [_coerce_claim(claim) for claim in claims]
    total_claims = len(normalized_claims)
    if total_claims == 0:
        return CitationQualityScore(precision=None, recall=None, cited_claims=0, total_claims=0, weak_claims=[])

    cited_claims = [claim for claim in normalized_claims if claim.source_indices]
    precision_scores: list[float] = []
    weak_claims: list[WeakClaim] = []
    for claim in cited_claims:
        supports = [_coerce_citation_support(item) for item in supports_by_claim.get(claim.claim_id, [])]
        if not supports:
            precision_scores.append(CITATION_SUPPORT_VALUES["no_support"])
            weak_claims.append(
                WeakClaim(
                    claim=claim.claim,
                    best_support="no_support",
                    justification="All cited source indices are out of range (hallucinated citation).",
                )
            )
            continue
        best = max(supports, key=lambda support: CITATION_SUPPORT_VALUES[support.support])
        precision_scores.append(CITATION_SUPPORT_VALUES[best.support])
        if best.support != "full_support":
            weak_claims.append(WeakClaim(claim=claim.claim, best_support=best.support, justification=best.justification))

    return CitationQualityScore(
        precision=sum(precision_scores) / len(precision_scores) if precision_scores else 0.0,
        recall=len(cited_claims) / total_claims,
        cited_claims=len(cited_claims),
        total_claims=total_claims,
        weak_claims=weak_claims,
    )


def evaluate_utility_gate(
    input_: object,
    thresholds: UtilityGateThresholds = DEFAULT_UTILITY_GATE_THRESHOLDS,
) -> UtilityGateResult:
    failures: list[str] = []
    skipped_checks: list[str] = []
    visibility_delta = _field(input_, "visibilityDelta", "visibility_delta")
    if visibility_delta is None:
        skipped_checks.append("visibilityDelta")
    elif _float(visibility_delta) < thresholds.min_visibility_delta:
        failures.append(f"visibility delta {_round(_float(visibility_delta))} is below {thresholds.min_visibility_delta}")

    raw_coverage = _field(input_, "keypointCoverage", "keypoint_coverage")
    if raw_coverage is None:
        skipped_checks.append("keypointCoverage")
    else:
        coverage = _coerce_coverage(raw_coverage)
        if coverage.kpc > thresholds.max_kpc:
            failures.append(
                f"KPC {_round(coverage.kpc)} exceeds {thresholds.max_kpc} ({coverage.contradicted} contradicted evidence item(s))"
            )
        if coverage.kpr < thresholds.min_kpr:
            failures.append(f"KPR {_round(coverage.kpr)} is below {thresholds.min_kpr}")

    raw_quality = _field(input_, "citationQuality", "citation_quality")
    if raw_quality is None or _coerce_quality(raw_quality).precision is None:
        skipped_checks.append("citationQuality")
    else:
        quality = _coerce_quality(raw_quality)
        if quality.precision is not None and quality.precision < thresholds.min_citation_precision:
            failures.append(
                f"citation precision {_round(quality.precision)} is below {thresholds.min_citation_precision}"
            )
    return UtilityGateResult(pass_=not failures, failures=failures, skipped_checks=skipped_checks)


async def judge_keypoint_coverage(
    config: Mapping[str, object],
    evidence: Sequence[Mapping[str, object]],
    public_text: str,
) -> dict[str, object]:
    """Judge generated PDP copy against every evidence-ledger item."""
    if not evidence:
        raise ValueError("judgeKeypointCoverage requires a non-empty evidence ledger.")
    prompt = build_keypoint_judge_prompt(list(evidence), public_text)
    expected_ids = [_js_string(item.get("id")) for item in evidence]
    judgments = await _call_judge_with_retries(
        lambda: complete_with_provider(config, prompt["system"], prompt["user"]),
        lambda raw: parse_keypoint_judgments(raw, expected_ids),
    )
    return {"score": score_keypoint_coverage(judgments), "judgments": judgments}


async def judge_citation_quality(
    config: Mapping[str, object], answer: str, documents: Sequence[str]
) -> CitationQualityScore:
    """Extract engine claims then judge each in-range cited document."""
    extraction_prompt = build_claim_extraction_prompt(answer)
    claims = await _call_judge_with_retries(
        lambda: complete_with_provider(config, extraction_prompt["system"], extraction_prompt["user"]),
        parse_extracted_claims,
    )
    supports_by_claim: dict[int, list[CitationSupportJudgment]] = {}
    for claim in claims:
        if not claim.source_indices:
            continue
        supports: list[CitationSupportJudgment] = []
        for source_index in claim.source_indices:
            if source_index < 0 or source_index >= len(documents):
                continue
            document = documents[source_index]
            support_prompt = build_citation_support_prompt(claim.claim, document)
            supports.append(await _call_judge_with_retries(
                lambda prompt=support_prompt: complete_with_provider(config, prompt["system"], prompt["user"]),
                parse_citation_support,
            ))
        supports_by_claim[claim.claim_id] = supports
    return score_citation_quality(claims, supports_by_claim)


def _parse_json_object(raw: str) -> dict[str, object]:
    text = re_strip_fence(raw.strip())
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end < start:
        raise ValueError("Judge response contains no JSON object.")
    parsed = json.loads(text[start : end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("Judge response is not a JSON object.")
    return _record(cast(object, parsed))


async def _call_judge_with_retries[JudgeValue](
    request: Callable[[], Awaitable[str]], parse: Callable[[str], JudgeValue]
) -> JudgeValue:
    max_retries = 3
    last_error: Exception | None = None
    for attempt in range(max_retries):
        try:
            return parse(await request())
        except Exception as error:
            last_error = error
            if attempt < max_retries - 1:
                await asyncio.sleep(2**attempt)
    raise RuntimeError(f"Judge call failed after {max_retries} attempts: {last_error if last_error else 'undefined'}")


def re_strip_fence(text: str) -> str:
    if text.lower().startswith("```json"):
        text = text[7:].lstrip()
    elif text.startswith("```"):
        text = text[3:].lstrip()
    if text.rstrip().endswith("```"):
        text = text.rstrip()[:-3].rstrip()
    return text


def _coerce_keypoint_judgment(value: object) -> KeypointJudgment:
    if isinstance(value, KeypointJudgment):
        return value
    record = _record(value)
    return KeypointJudgment(label=_text(record.get("label")), justification=_text(record.get("justification")))


def _coerce_claim(value: object) -> ExtractedClaim:
    if isinstance(value, ExtractedClaim):
        return value
    record = _record(value)
    raw_indices = record.get("sourceIndices", record.get("source_indices", []))
    return ExtractedClaim(
        claim_id=_integer(record.get("claimId", record.get("claim_id", 0))),
        claim=_text(record.get("claim")),
        source_indices=[item for item in _objects(raw_indices) if isinstance(item, int) and not isinstance(item, bool)],
    )


def _coerce_citation_support(value: object) -> CitationSupportJudgment:
    if isinstance(value, CitationSupportJudgment):
        return value
    record = _record(value)
    return CitationSupportJudgment(support=_text(record.get("support")), justification=_text(record.get("justification")))


def _coerce_coverage(value: object) -> KeypointCoverageScore:
    if isinstance(value, KeypointCoverageScore):
        return value
    record = _record(value)
    raw_contradictions = record.get("contradictions", [])
    contradictions = [
        EvidenceContradiction(
            evidence_id=_text(_record(item).get("evidenceId", _record(item).get("evidence_id", ""))),
            justification=_text(_record(item).get("justification")),
        )
        for item in _objects(raw_contradictions)
        if _record(item)
    ]
    return KeypointCoverageScore(
        kpr=_float(record.get("kpr", 0)),
        kpc=_float(record.get("kpc", 0)),
        supported=_integer(record.get("supported", 0)),
        omitted=_integer(record.get("omitted", 0)),
        contradicted=_integer(record.get("contradicted", 0)),
        total=_integer(record.get("total", 0)),
        contradictions=contradictions,
    )


def _coerce_quality(value: object) -> CitationQualityScore:
    if isinstance(value, CitationQualityScore):
        return value
    record = _record(value)
    raw_weak_claims = record.get("weakClaims", record.get("weak_claims", []))
    return CitationQualityScore(
        precision=_optional_float(record.get("precision")),
        recall=_optional_float(record.get("recall")),
        cited_claims=_integer(record.get("citedClaims", record.get("cited_claims", 0))),
        total_claims=_integer(record.get("totalClaims", record.get("total_claims", 0))),
        weak_claims=[
            WeakClaim(
                claim=_text(_record(item).get("claim")),
                best_support=_text(_record(item).get("bestSupport", _record(item).get("best_support", ""))),
                justification=_text(_record(item).get("justification")),
            )
            for item in _objects(raw_weak_claims)
            if _record(item)
        ],
    )


def _field(value: object, *names: str) -> object:
    for name in names:
        if isinstance(value, Mapping) and name in value:
            return _record(cast(object, value))[name]
        if not isinstance(value, Mapping) and hasattr(value, name):
            return cast(object, getattr(value, name))
    return None


def _round(value: float) -> float:
    return js_round(value * 1000) / 1000


def _js_string(value: object) -> str:
    if value is None:
        return "undefined"
    return str(value)


def _objects(value: object) -> list[object]:
    return list(cast(list[object], value)) if isinstance(value, list) else []


def _record(value: object) -> dict[str, object]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[object, object], value).items()}


def _text(value: object) -> str:
    return str(value) if value is not None else ""


def _float(value: object) -> float:
    return float(value) if isinstance(value, (int, float, str)) and not isinstance(value, bool) else 0.0


def _optional_float(value: object) -> float | None:
    return _float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _integer(value: object) -> int:
    return int(value) if isinstance(value, (int, float, str)) and not isinstance(value, bool) else 0
