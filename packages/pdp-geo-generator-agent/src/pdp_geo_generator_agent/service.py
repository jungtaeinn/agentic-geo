"""Top-level asynchronous PDP GEO generation orchestration."""

from __future__ import annotations

import copy
import inspect
import json
import re
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any, cast

from ._json import as_dict, as_list, clean_text, omit_none
from .content_planning import create_pdp_geo_evidence_ledger, plan_pdp_geo_content
from .copy_refiner import refine_pdp_geo_copy
from .final_proofreader import (
    SENTENCE_SEPARABLE_PUBLIC_COPY_PATHS,
    create_pdp_geo_public_copy_provenance,
    create_pdp_geo_public_copy_provenance_decision_diagnostics,
    final_proofread_pdp_geo_artifacts,
    reconcile_pdp_geo_public_copy_provenance,
)
from .generation import (
    collect_pdp_geo_plan_render_shortfalls,
    ensure_pdp_geo_faq_plan_coverage,
    generate_pdp_geo_artifacts,
)
from .graph_integrity import (
    capture_structured_content_snapshot,
    repair_pdp_schema_graph_integrity,
    synchronize_structured_content_with_graph,
)
from .keyword_normalizer import normalize_product_review_keywords
from .models import PdpGeoGenerationInput
from .normalization import normalize_pdp_product
from .product_normalizer import normalize_pdp_product_with_agent
from .quality_gate import (
    collect_concept_shortfalls,
    collect_quality_gate_shortfalls,
    count_unresolved_public_copy_findings,
    create_concept_gate_feedback,
    create_quality_eval_input,
    create_quality_gate_feedback,
    evaluate_pdp_geo_artifact_quality,
    judge_concept_embodiment_safely,
    quality_gate_scores,
    resolve_quality_gate_settings,
    should_adopt_corrected_artifacts,
    to_concept_assessment_diagnostics,
)
from .rag.manifest import PDP_GEO_GENERATOR_RAG_MANIFEST
from .rag.policy import compile_pdp_geo_policy_checklist
from .rag.profile_store import read_pdp_geo_generator_rag_profile
from .rag.reasoning import create_pdp_geo_reasoning
from .rag.retrieval import (
    apply_custom_pdp_geo_rerank,
    assemble_pdp_geo_rag_chunks,
    create_pdp_geo_rag_query,
    create_pdp_geo_rag_query_plan,
    create_pdp_geo_rag_usage_diagnostics,
    hydrate_selected_pdp_geo_rag_documents,
    infer_pdp_geo_brand_rag_scope,
    merge_pdp_geo_rag_documents,
    resolve_pdp_geo_rag_settings,
    scope_pdp_geo_brand_rag_documents,
    select_final_rag_chunks,
)
from .token_usage import merge_token_usages
from .validation import apply_safe_public_copy_repairs, serialize_schema_markup, validate_pdp_geo_artifacts

_PIPELINE: tuple[tuple[str, str, str], ...] = (
    ("input", "입력 검증", "임의 상품 JSON과 옵션을 검증"),
    ("normalize", "상품 신호 정규화", "REST/API/PDP JSON을 내부 ProductSignal로 변환"),
    ("rag-load", "RAG 프로필 로드", "schema.org, E-E-A-T, CEP, GEO, BestPractice, locale 용어집 로드"),
    ("chunk", "RAG chunk 구성", "버전 문서와 상품 컨텍스트를 검색 가능한 chunk로 준비"),
    ("embed", "임베딩 구성", "로컬 또는 managed vector store 임베딩 전략 적용"),
    ("retrieve", "RAG 검색", "상품/locale/schema 목표에 맞는 관련 문서 검색"),
    ("rerank", "리랭킹", "schema, locale, terminology, GEO 관련성을 기준으로 재정렬"),
    ("generate", "GEO 산출물 생성 및 최종 교정", "JSON-LD 생성 후 선택적으로 별도 fluency-only proofreading 모델 호출"),
    ("validate", "문법 검증", "JSON-LD 구조와 공개 문구 검증"),
    ("repair", "검증 결과 기록", "자동 수정 없이 validation findings를 diagnostics에 기록"),
    ("quality-gate", "품질 게이트 자가 보정", "GEO/CEP/E-E-A-T 루브릭으로 자가 평가 후 미달 시 표적 보정 1회"),
    ("artifact", "최종 아티팩트 생성", "복사 가능한 schemaMarkup과 content 결과 생성"),
)
_KOREAN_RENDERER_REVIEW_ATTRIBUTION_SPACING = re.compile(r"(?<=[.!?。！？])(?=라고\s+언급했습니다)")
_PUBLIC_COPY_SENTENCE_SPLIT = re.compile(r"(?<=[.!?。！？])\s+|\n+")
_FAQ_PUBLIC_COPY_PATH = re.compile(r"^FAQPage\.mainEntity\[(?P<index>\d+)\]\.(?:name|acceptedAnswer\.text)$")
_HOW_TO_PUBLIC_COPY_PATH = re.compile(r"^HowTo\.step\[(?P<index>\d+)\]\.text$")
# The reasons a binder decision can give for an omission.  ``noProvenanceEntry``
# belongs here because it is the one that says the field was never recorded at
# all; leaving it out sent every such omission to the fallback below, which
# reports an unresolved binding and so hides that there was no entry to resolve.
_PUBLIC_COPY_OMISSION_REASONS = frozenset(
    {
        "noEligibleEvidence",
        "assertionFrameRejected",
        "directSupportRejected",
        "noProvenanceEntry",
        "unresolvedBinding",
    }
)
_CONTENT_PLANNING_MODEL_OUTCOMES = frozenset({"notCalled", "admitted", "rejected", "unavailable"})
_FAQ_MODEL_RECOVERY_OUTCOMES = frozenset({"notNeeded", "pending", "admitted", "rejected", "unavailable"})
_SAFE_FAQ_DIAGNOSTIC_ID = re.compile(r"faq-[a-z0-9][a-z0-9-]{0,159}$")


class _Tracker:
    def __init__(self, callback: object) -> None:
        self.callback = callback
        self.steps = [
            {"id": identifier, "title": title, "description": description, "status": "pending"}
            for identifier, title, description in _PIPELINE
        ]

    async def mark(self, identifier: str, status: str, message: str) -> None:
        step = next(item for item in self.steps if item["id"] == identifier)
        step["status"] = status
        step["message"] = message
        step["startedAt" if status == "running" else "completedAt"] = (
            datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        )
        if callable(self.callback):
            outcome = self.callback(dict(step))
            if inspect.isawaitable(outcome):
                await outcome

    def snapshot(self) -> list[dict[str, Any]]:
        return [dict(step) for step in self.steps]


def _normalize_renderer_review_attribution_spacing(value: object) -> object:
    """Normalize only the fixed Korean renderer review-attribution boundary.

    The renderer joins a period-terminated approved review body directly to
    ``라고 언급했습니다``.  The whitespace is punctuation-only, so normalize
    it before the final safe-repair stage can report a needless mutation.  The
    recursive shape preserves JSON-LD, script-tag, HTML, and visible-section
    parity without admitting or changing any review claim.
    """

    if isinstance(value, str):
        return _KOREAN_RENDERER_REVIEW_ATTRIBUTION_SPACING.sub(" ", value)
    if isinstance(value, Mapping):
        mapping = cast(Mapping[str, Any], value)
        return {key: _normalize_renderer_review_attribution_spacing(item) for key, item in mapping.items()}
    if isinstance(value, list):
        return [_normalize_renderer_review_attribution_spacing(item) for item in cast(list[Any], value)]
    return value


class QualityGateBlockedError(RuntimeError):
    """A publish-blocking quality-gate failure with safe terminal diagnostics."""

    def __init__(self, message: str, diagnostics: Mapping[str, Any]) -> None:
        super().__init__(message)
        self.diagnostics = dict(diagnostics)


def _safe_process_snapshot(tracker: _Tracker) -> list[dict[str, str]]:
    """Keep stage identity/status without progress copy that can contain source text."""

    allowed_statuses = {"pending", "running", "done", "error"}
    return [
        {"id": identifier, "status": status}
        for step in tracker.snapshot()
        if isinstance(identifier := step.get("id"), str)
        if isinstance(status := step.get("status"), str) and status in allowed_statuses
    ]


def _safe_quality_gate_shortfalls(values: object) -> list[str]:
    """Retain actionable gate categories while excluding generated copy/warnings."""

    safe: list[str] = []
    for raw in as_list(values):
        text = str(raw)
        normalized = text.casefold()
        if "public-copy provenance" in normalized:
            count = next((token for token in text.split() if token.isdecimal()), "")
            safe.append(
                f"{count} unresolved public-copy provenance warning(s)"
                if count
                else "Unresolved public-copy provenance warning(s)"
            )
        elif "faq plan/render structural coverage" in normalized:
            safe.append("FAQ plan/render structural coverage shortfall.")
        elif "howto plan/render structural coverage" in normalized:
            safe.append("HowTo plan/render structural coverage shortfall.")
        elif text.startswith(("GEO ", "CEP ", "E-E-A-T ", "concept ")):
            safe.append(text[:120])
        elif "validation warning" in normalized:
            safe.append("Unresolved validation warning(s).")
        else:
            safe.append("Quality-gate shortfall detected.")
    return list(dict.fromkeys(safe))


def _safe_quality_gate_reason(quality: Mapping[str, Any]) -> str:
    """Never attach source-derived corrective feedback to terminal error text."""

    reason = str(quality.get("reason") or "")
    if reason.startswith("Quality gate blocked final artifact after corrective refinement"):
        return "Quality gate blocked final artifact after corrective refinement."
    if quality.get("blockingShortfalls"):
        return "Quality gate blocked final artifact."
    return reason[:240] if reason else "Quality gate blocked final artifact."


def _safe_quality_gate_scores(values: object) -> dict[str, int | float]:
    return {
        key: value
        for key in ("overall", "geo", "cep", "eeat")
        if isinstance(value := as_dict(values).get(key), int | float) and not isinstance(value, bool)
    }


def _safe_public_copy_finding_reason(value: object) -> str:
    """Classify trusted validation defects without echoing public-copy text."""

    issue = str(value).casefold()
    if "missing" in issue:
        return "Final public-copy provenance binding is missing."
    if "ambiguous" in issue:
        return "Final public-copy provenance binding is ambiguous."
    if "does not correspond" in issue:
        return "Final public-copy provenance binding does not match a published field."
    if "hash" in issue or "evidence" in issue or "text does not match" in issue:
        return "Final public-copy provenance binding does not match finalized evidence."
    return "Final public-copy provenance did not validate."


def _safe_public_copy_validation_findings(validation: Mapping[str, Any]) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    for raw in as_list(validation.get("validationFindings")):
        finding = as_dict(raw)
        if finding.get("source") != "public-copy-provenance":
            continue
        field = finding.get("field")
        if not isinstance(field, str) or not field:
            continue
        findings.append(
            {
                "field": field[:240],
                "source": "public-copy-provenance",
                "reason": _safe_public_copy_finding_reason(finding.get("issue") or finding.get("reason")),
            }
        )
    return findings


def _safe_public_copy_provenance_summary(value: object) -> dict[str, Any]:
    field_paths = list(
        dict.fromkeys(
            field_path[:240]
            for raw in as_list(value)
            if isinstance(field_path := as_dict(raw).get("fieldPath"), str) and field_path
        )
    )
    return {"count": len(field_paths), "fieldPaths": field_paths}


def _safe_public_copy_provenance_decisions(value: object) -> list[dict[str, Any]]:
    """Keep the terminal failure envelope limited to the diagnostic allowlist."""

    phases = {"initial", "afterProofreader", "afterSafeRepair", "correctedCandidate"}
    outcomes = {"bound", "protected", "unsupported", "unrecorded", "notPresent"}
    reasons = {
        "noEligibleEvidence",
        "assertionFrameRejected",
        "directSupportRejected",
        "noProvenanceEntry",
        "planTextMismatch",
        "notPresent",
        "directSupportAccepted",
        "verbatimSource",
    }
    safe: list[dict[str, Any]] = []
    for raw in as_list(value):
        item = as_dict(raw)
        field_path = item.get("fieldPath")
        phase = item.get("phase")
        outcome = item.get("outcome")
        reason = item.get("reason")
        sentence_index = item.get("sentenceIndex")
        if (
            not isinstance(field_path, str)
            or not field_path
            or not isinstance(phase, str)
            or phase not in phases
            or not isinstance(outcome, str)
            or outcome not in outcomes
            or not isinstance(reason, str)
            or reason not in reasons
            or not (sentence_index is None or isinstance(sentence_index, int) and not isinstance(sentence_index, bool))
        ):
            continue
        plan = as_dict(item.get("plan"))
        role_counts = {
            role: count
            for role, count in as_dict(item.get("eligibleRoleCounts")).items()
            if role in {"identity", "description", "benefit", "effect", "ingredient", "audience", "usage", "metric", "faq", "review", "source", "commerce"}
            if isinstance(count, int) and not isinstance(count, bool) and count >= 0
        }
        safe.append(
            {
                "fieldPath": field_path[:240],
                "phase": phase,
                "sentenceIndex": sentence_index,
                "outcome": outcome,
                "reason": reason,
                "plan": {
                    "mode": plan.get("mode") if plan.get("mode") in {"model", "nonModel"} else "nonModel",
                    "fieldIncluded": plan.get("fieldIncluded") if isinstance(plan.get("fieldIncluded"), bool) else None,
                    "textHashMatch": plan.get("textHashMatch") if isinstance(plan.get("textHashMatch"), bool) else None,
                },
                "eligibleEvidenceCount": _safe_nonnegative_count(item.get("eligibleEvidenceCount")),
                "eligibleRoleCounts": role_counts,
                "selectedEvidenceCount": _safe_nonnegative_count(item.get("selectedEvidenceCount")),
            }
        )
    return safe


def _safe_nonnegative_count(value: object) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def _safe_corrective_diagnostics(value: object) -> dict[str, Any]:
    """Expose only final corrective outcomes, never feedback or candidate copy."""

    data = as_dict(value)
    reasons = {
        "notNeeded",
        "noCorrectiveRuntime",
        "correctiveNotApplied",
        "adopted",
        "provenanceRegression",
        "structuralShortfall",
        "notImproved",
    }
    paths = list(
        dict.fromkeys(
            path[:240]
            for raw in as_list(data.get("correctedMissingPaths"))
            if isinstance(path := raw, str) and path
        )
    )
    reason = data.get("adoptionReason")
    return {
        "correctiveApplied": data.get("correctiveApplied") is True,
        "correctedMissingPaths": paths,
        "adoptionReason": reason if reason in reasons else "notNeeded",
        "structuralShortfallCount": _safe_nonnegative_count(data.get("structuralShortfallCount")),
        "provenanceRegressionDelta": _safe_nonnegative_count(data.get("provenanceRegressionDelta")),
    }


def _provenance_decision_missing_paths(value: object) -> list[str]:
    """Collapse sentence-level unsupported outcomes into their public field paths."""

    return list(
        dict.fromkeys(
            field_path
            for raw in as_list(value)
            if as_dict(raw).get("outcome") in {"unsupported", "notPresent"}
            if isinstance(field_path := as_dict(raw).get("fieldPath"), str) and field_path
        )
    )


def _safe_stage_execution(stage: object) -> dict[str, object]:
    """Publish what a stage did, including whether its model produced anything.

    ``called``/``applied`` alone cannot separate a refused proposal from a
    provider that was never reached, so a stage that records the outcome of its
    model call publishes that too.
    """

    data = as_dict(stage)
    execution: dict[str, object] = {
        "called": data.get("called") is True,
        "applied": data.get("applied") is True,
    }
    model_call = as_dict(data.get("modelCall"))
    if model_call:
        execution["modelCall"] = {
            "called": model_call.get("called") is True,
            "outcome": clean_text(model_call.get("outcome")),
        }
    return execution


def _safe_faq_diagnostic_ids(values: object) -> list[str]:
    """Retain only generated relationship identifiers at the public summary boundary."""

    return list(
        dict.fromkeys(
            identifier
            for raw in as_list(values)
            if isinstance(identifier := raw, str)
            if _SAFE_FAQ_DIAGNOSTIC_ID.fullmatch(identifier) is not None
        )
    )


def _safe_content_planning_diagnostics(planning: object, faq_membership: object | None = None) -> dict[str, Any]:
    """Summarize FAQ planning without copying model prose, evidence text, or runtime configuration."""

    stage = as_dict(planning)
    plan = as_dict(stage.get("plan"))
    admission = as_dict(plan.get("admissionDiagnostics"))
    raw_fields = [as_dict(raw) for raw in as_list(admission.get("fields")) if as_dict(raw)]
    faq_fields = [
        field
        for field in raw_fields
        if clean_text(field.get("field")).casefold().startswith("faq[")
    ]
    initial_fields = (
        [as_dict(raw) for raw in as_list(admission.get("faqInitialFields")) if as_dict(raw)]
        if "faqInitialFields" in admission
        else faq_fields
    )
    accepted_fields = [field for field in faq_fields if clean_text(field.get("outcome")).casefold() == "accepted"]
    rejected_fields = [field for field in faq_fields if clean_text(field.get("outcome")).casefold() == "rejected"]
    accepted_ids = _safe_faq_diagnostic_ids([field.get("rowId") for field in accepted_fields])
    rejected_ids = _safe_faq_diagnostic_ids([field.get("rowId") for field in rejected_fields])
    membership_rows = [
        as_dict(raw)
        for raw in as_list(faq_membership if faq_membership is not None else plan.get("faqMembership"))
        if as_dict(raw)
    ]
    membership_ids = _safe_faq_diagnostic_ids([row.get("id") for row in membership_rows])
    membership_id_set = set(membership_ids)
    unrecovered_ids = [identifier for identifier in rejected_ids if identifier not in membership_id_set]
    unrecovered_count = sum(
        1
        for field in rejected_fields
        if clean_text(field.get("rowId")) not in membership_id_set
    )
    model_call = as_dict(admission.get("modelCall"))
    model_outcome = clean_text(model_call.get("outcome"))
    recovery = as_dict(admission.get("faqModelRecovery"))
    recovery_outcome = clean_text(recovery.get("outcome"))
    relationship_cards = [as_dict(raw) for raw in as_list(plan.get("faqRelationshipCards")) if as_dict(raw)]

    return {
        "called": stage.get("called") is True,
        "applied": stage.get("applied") is True,
        "modelCall": {
            "called": model_call.get("called") is True,
            "outcome": model_outcome if model_outcome in _CONTENT_PLANNING_MODEL_OUTCOMES else "notCalled",
        },
        "faqRelationshipCards": {
            "count": len(relationship_cards),
            "cardIds": _safe_faq_diagnostic_ids([card.get("id") for card in relationship_cards]),
        },
        "faqInitialPlan": {
            "candidateCount": len(initial_fields),
            "candidateRowIds": _safe_faq_diagnostic_ids([field.get("rowId") for field in initial_fields]),
        },
        "faqAdmission": {
            "acceptedCount": len(accepted_fields),
            "acceptedRowIds": accepted_ids,
            "rejectedCount": len(rejected_fields),
            "rejectedRowIds": rejected_ids,
        },
        "faqModelRecovery": {
            "called": recovery.get("called") is True,
            "outcome": recovery_outcome if recovery_outcome in _FAQ_MODEL_RECOVERY_OUTCOMES else "notNeeded",
            "requestedCardIds": _safe_faq_diagnostic_ids(recovery.get("requestedCardIds")),
        },
        "faqSafeDegradation": {
            "active": unrecovered_count > 0,
            "omittedRowCount": unrecovered_count,
            "omittedRowIds": unrecovered_ids,
        },
        "faqMembership": {"count": len(membership_rows), "rowIds": membership_ids},
    }


def _quality_gate_runtime_stage_summary(
    *,
    product_normalization: object,
    keyword_normalization: object,
    planning: object,
    copy_refinement: object,
    final_proofreading: object,
    retrieved_count: int,
    selected_rag_count: int,
) -> dict[str, Any]:
    """Publish execution booleans/counts only; never runtime/provider configuration."""

    return {
        "productNormalization": _safe_stage_execution(product_normalization),
        "keywordNormalization": _safe_stage_execution(keyword_normalization),
        "contentPlanning": _safe_stage_execution(planning),
        "copyRefinement": _safe_stage_execution(copy_refinement),
        "finalProofreading": _safe_stage_execution(as_dict(final_proofreading).get("diagnostics")),
        "rag": {"retrievedCount": retrieved_count, "selectedRagCount": selected_rag_count},
    }


def _quality_gate_blocked_diagnostics(
    *,
    tracker: _Tracker,
    quality: Mapping[str, Any],
    validation: Mapping[str, Any],
    public_copy_provenance: object,
    product_normalization: object,
    keyword_normalization: object,
    planning: object,
    copy_refinement: object,
    final_proofreading: object,
    public_copy_provenance_decisions: object,
    retrieved_count: int,
    selected_rag_count: int,
) -> dict[str, Any]:
    """Build the failure-only diagnostic envelope consumed by console clients."""

    scores: dict[str, dict[str, int | float]] = {"initial": _safe_quality_gate_scores(quality.get("initialScores"))}
    corrected_scores = _safe_quality_gate_scores(quality.get("correctedScores"))
    if corrected_scores:
        scores["corrected"] = corrected_scores
    return {
        "process": _safe_process_snapshot(tracker),
        "qualityGate": {
            "enabled": quality.get("enabled") is True,
            "attempted": quality.get("attempted") is True,
            "adopted": quality.get("adopted") is True,
            "reason": _safe_quality_gate_reason(quality),
            "shortfalls": _safe_quality_gate_shortfalls(quality.get("shortfalls")),
            "blockingShortfalls": _safe_quality_gate_shortfalls(quality.get("blockingShortfalls")),
            "scores": scores,
            "correctiveDiagnostics": _safe_corrective_diagnostics(quality.get("correctiveDiagnostics")),
        },
        "validationFindings": _safe_public_copy_validation_findings(validation),
        "finalPublicCopyProvenance": _safe_public_copy_provenance_summary(public_copy_provenance),
        "publicCopyProvenanceDecisionDiagnostics": _safe_public_copy_provenance_decisions(
            public_copy_provenance_decisions
        ),
        "contentPlanning": _safe_content_planning_diagnostics(planning),
        "runtimeStages": _quality_gate_runtime_stage_summary(
            product_normalization=product_normalization,
            keyword_normalization=keyword_normalization,
            planning=planning,
            copy_refinement=copy_refinement,
            final_proofreading=final_proofreading,
            retrieved_count=retrieved_count,
            selected_rag_count=selected_rag_count,
        ),
    }


def _schema_node_has_type(node: Mapping[str, Any], type_name: str) -> bool:
    """Return whether a JSON-LD node carries one exact schema type."""

    raw_type = node.get("@type")
    return raw_type == type_name or type_name in [clean_text(item) for item in as_list(raw_type)]


def _schema_node(graph: Sequence[Mapping[str, Any]], type_name: str) -> dict[str, Any] | None:
    node = next((item for item in graph if _schema_node_has_type(item, type_name)), None)
    return cast(dict[str, Any] | None, node)


def _final_public_copy_failure_paths(validation: Mapping[str, Any]) -> list[str]:
    """Return only final public-copy paths that require isolation."""

    return list(
        dict.fromkeys(
            field
            for raw in as_list(validation.get("validationFindings"))
            if as_dict(raw).get("source") == "public-copy-provenance"
            if isinstance(field := as_dict(raw).get("field"), str) and field
        )
    )


def _current_provenance_decisions(
    decisions: Sequence[Mapping[str, Any]], phase: str, field_path: str
) -> list[dict[str, Any]]:
    """Select the sentence diagnostics for the artifact currently being published."""

    return [
        dict(row)
        for raw in decisions
        if (row := as_dict(raw)).get("phase") == phase
        if row.get("fieldPath") == field_path
    ]


def _public_copy_omission_reason(decisions: Sequence[Mapping[str, Any]]) -> str:
    """Choose a bounded, copy-free diagnostic reason for a safe omission.

    A rejected sentence carries the reason it was rejected for, and that is the
    one worth reporting because it names what could not be proven.  Only when
    no sentence was rejected does the field-level cause matter: the entry was
    never written, so nothing in the field was recorded.  Reporting that is the
    point of the second rank -- the fallback below names an unresolved binding,
    which describes nothing and hid exactly this case.
    """

    for outcome in ("unsupported", "unrecorded"):
        for row in decisions:
            if row.get("outcome") == outcome and row.get("reason") in _PUBLIC_COPY_OMISSION_REASONS:
                return str(row["reason"])
    return "unresolvedBinding"


def _unsupported_sentence_indexes(decisions: Sequence[Mapping[str, Any]]) -> set[int]:
    return {
        index
        for row in decisions
        if row.get("outcome") == "unsupported"
        if isinstance(index := row.get("sentenceIndex"), int) and not isinstance(index, bool) and index >= 0
    }


def _public_copy_sentences(value: object) -> list[str]:
    return [part for part in _PUBLIC_COPY_SENTENCE_SPLIT.split(clean_text(value)) if part]


def _public_copy_omission(
    *, field_path: str, action: str, reason: str, count: int, sentence_index: int | None
) -> dict[str, Any]:
    """Build the success-diagnostics record without generated copy or evidence."""

    return {
        "fieldPath": field_path,
        "action": action,
        "reason": reason,
        "count": max(1, count),
        "sentenceIndex": sentence_index,
    }


def _isolate_unbound_public_copy(
    *,
    schema_markup: Mapping[str, Any],
    content: Mapping[str, Any],
    validation: Mapping[str, Any],
    decisions: Sequence[Mapping[str, Any]],
    phase: str,
    locale: str,
) -> dict[str, Any]:
    """Omit only final public-copy units whose source binding cannot be proven.

    A quality gate must never turn one rejected sentence into a zero-result
    run.  This step works only from final validation paths and the already
    sanitized, sentence-level provenance decisions.  It never repairs a
    clause, synthesizes replacement wording, or copies plan evidence IDs.
    """

    failed_paths = _final_public_copy_failure_paths(validation)
    if not failed_paths:
        return {"schemaMarkup": dict(schema_markup), "content": dict(content), "omissions": []}

    markup = copy.deepcopy(dict(schema_markup))
    json_ld = copy.deepcopy(as_dict(markup.get("jsonLd")))
    graph = [copy.deepcopy(as_dict(raw)) for raw in as_list(json_ld.get("@graph")) if as_dict(raw)]
    snapshot = capture_structured_content_snapshot(cast(list[Mapping[str, object]], graph))
    next_content = copy.deepcopy(dict(content))
    sections = copy.deepcopy(as_dict(next_content.get("sections")))
    next_content["sections"] = sections
    omissions: list[dict[str, Any]] = []

    description_paths = [path for path in failed_paths if path in SENTENCE_SEPARABLE_PUBLIC_COPY_PATHS]
    for path in description_paths:
        kind = "Product" if path == "Product.description" else "WebPage"
        node = _schema_node(graph, kind)
        if node is None:
            continue
        current = clean_text(node.get("description"))
        if not current:
            continue
        path_decisions = _current_provenance_decisions(decisions, phase, path)
        rejected_indexes = _unsupported_sentence_indexes(path_decisions)
        sentences = _public_copy_sentences(current)
        retained = [sentence for index, sentence in enumerate(sentences) if index not in rejected_indexes]
        reason = _public_copy_omission_reason(path_decisions)
        if rejected_indexes and retained:
            node["description"] = " ".join(retained)
            if kind == "Product":
                sections["description"] = node["description"]
            omissions.append(
                _public_copy_omission(
                    field_path=path,
                    action="sentenceOmitted",
                    reason=reason,
                    count=len(rejected_indexes),
                    sentence_index=min(rejected_indexes),
                )
            )
        else:
            node.pop("description", None)
            if kind == "Product":
                sections["description"] = ""
            omissions.append(
                _public_copy_omission(
                    field_path=path,
                    action="fieldOmitted",
                    reason=reason,
                    count=len(sentences) or 1,
                    sentence_index=min(rejected_indexes) if rejected_indexes else None,
                )
            )

    faq_paths: dict[int, str] = {}
    how_to_paths: dict[int, str] = {}
    for path in failed_paths:
        if match := _FAQ_PUBLIC_COPY_PATH.fullmatch(path):
            faq_paths.setdefault(int(match.group("index")), path)
        elif match := _HOW_TO_PUBLIC_COPY_PATH.fullmatch(path):
            how_to_paths.setdefault(int(match.group("index")), path)

    faq = _schema_node(graph, "FAQPage")
    if faq is not None and faq_paths:
        entities = [copy.deepcopy(as_dict(raw)) for raw in as_list(faq.get("mainEntity")) if as_dict(raw)]
        retained_entities = [entity for index, entity in enumerate(entities) if index not in faq_paths]
        for index, path in sorted(faq_paths.items()):
            if index >= len(entities):
                continue
            path_decisions = _current_provenance_decisions(decisions, phase, path)
            rejected_indexes = _unsupported_sentence_indexes(path_decisions)
            omissions.append(
                _public_copy_omission(
                    field_path=path,
                    action="faqItemOmitted",
                    reason=_public_copy_omission_reason(path_decisions),
                    count=1,
                    sentence_index=min(rejected_indexes) if rejected_indexes else None,
                )
            )
        faq["mainEntity"] = retained_entities

    how_to = _schema_node(graph, "HowTo")
    had_schema_how_to = how_to is not None
    if how_to is not None and how_to_paths:
        steps = [copy.deepcopy(as_dict(raw)) for raw in as_list(how_to.get("step")) if as_dict(raw)]
        failed_steps = [(index, path) for index, path in sorted(how_to_paths.items()) if index < len(steps)]
        if failed_steps:
            # An ordered HowTo is a source procedure, not independent display
            # rows. Removing a middle source step and renumbering the rest
            # would falsely claim a new contiguous procedure, so omit it as
            # one atomic public-copy unit.
            _index, path = failed_steps[0]
            path_decisions = _current_provenance_decisions(decisions, phase, path)
            rejected_indexes = _unsupported_sentence_indexes(path_decisions)
            omissions.append(
                _public_copy_omission(
                    field_path="HowTo",
                    action="howToSequenceOmitted",
                    reason=_public_copy_omission_reason(path_decisions),
                    count=len(steps),
                    sentence_index=min(rejected_indexes) if rejected_indexes else None,
                )
            )
            graph = [node for node in graph if node is not how_to]

    if not omissions:
        return {"schemaMarkup": markup, "content": next_content, "omissions": []}

    integrity = repair_pdp_schema_graph_integrity(cast(list[Mapping[str, object]], graph), locale)
    final_graph = [copy.deepcopy(as_dict(raw)) for raw in as_list(integrity.get("graph")) if as_dict(raw)]
    parity = synchronize_structured_content_with_graph(
        {
            "sections": sections,
            "graph": cast(list[Mapping[str, object]], final_graph),
            "snapshot": snapshot,
        }
    )
    final_sections = copy.deepcopy(as_dict(parity.get("sections")))
    if had_schema_how_to and _schema_node(final_graph, "HowTo") is None:
        final_sections["howToUse"] = ""
    next_content["sections"] = final_sections
    next_content["html"] = ""
    json_ld["@graph"] = final_graph
    return {
        "schemaMarkup": serialize_schema_markup(json_ld),
        "content": next_content,
        "omissions": omissions,
    }


def _remaining_structural_shortfalls_after_public_copy_omissions(
    shortfalls: Sequence[str], omissions: Sequence[Mapping[str, Any]]
) -> list[str]:
    """Keep structural failures except rows deliberately removed by provenance isolation."""

    omitted_faq_rows = sum(item.get("action") == "faqItemOmitted" for item in omissions)
    omitted_how_to_rows = sum(
        int(item.get("count") or 0)
        for item in omissions
        if item.get("action") in {"howToStepOmitted", "howToSequenceOmitted"}
        and isinstance(item.get("count"), int)
        and not isinstance(item.get("count"), bool)
    )
    retained: list[str] = []
    for shortfall in shortfalls:
        match = re.search(r"expected\s+(\d+).*?rendered\s+(\d+).*?and\s+(\d+)\s+visible", shortfall)
        if shortfall.startswith("FAQ plan/render structural coverage shortfall") and match:
            expected, rendered, visible = (int(value) for value in match.groups())
            if max(expected - rendered, expected - visible, 0) <= omitted_faq_rows:
                continue
        if shortfall.startswith("HowTo plan/render structural coverage shortfall") and match:
            expected, rendered, visible = (int(value) for value in match.groups())
            if max(expected - rendered, expected - visible, 0) <= omitted_how_to_rows:
                continue
        retained.append(shortfall)
    return retained


def _normalize_step_message(
    product_name: str, product_normalization: Mapping[str, Any], keyword_normalization_applied: bool
) -> str:
    """Keep the public progress copy aligned with ``createNormalizeStepMessage``."""

    if product_normalization.get("applied"):
        action = "상품 신호를 에이전트 정규화로 보강"
    elif product_normalization.get("called"):
        action = "상품 신호 에이전트 정규화를 검토"
    else:
        action = "상품 신호를 부트스트랩 정규화"
    actions = [action, *( ["리뷰 키워드 오타 후보를 보정"] if keyword_normalization_applied else [])]
    return f"{product_name} {'하고 '.join(actions)}했습니다."


async def generate_pdp_geo(
    input_: Mapping[str, Any] | PdpGeoGenerationInput, options: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    """Generate a deterministic GEO artifact from arbitrary product JSON.

    The retained TypeScript runtime is never invoked here.  This coroutine owns
    the Python normalization, local-RAG, rendering, validation, and live stage
    callback contracts.
    """
    runtime = dict(options or {})
    tracker = _Tracker(runtime.get("onProgress"))

    await tracker.mark("input", "running", "입력 JSON과 GEO 생성 옵션을 검증합니다.")
    parsed = input_ if isinstance(input_, PdpGeoGenerationInput) else PdpGeoGenerationInput.model_validate(input_)
    await tracker.mark("input", "done", "입력 JSON을 표준 요청으로 검증했습니다.")

    await tracker.mark("normalize", "running", "상품 JSON 구조를 자동 추론하고 fieldMapping을 적용합니다.")
    profile = await read_pdp_geo_generator_rag_profile()
    profile_documents = [
        dict(cast(Mapping[str, Any], item)) for item in as_list(profile.get("documents")) if isinstance(item, Mapping)
    ]
    profile_analysis_prompt = str(profile.get("analysisPrompt") or "")
    normalized = normalize_pdp_product(
        parsed.product,
        {
            "hints": parsed.hints.to_wire() if parsed.hints else {},
            "fieldMapping": parsed.field_mapping.to_wire() if parsed.field_mapping else {},
            "sourceUrl": parsed.source.url if parsed.source else "",
        },
    )
    parsed_rag = parsed.rag.to_wire() if parsed.rag else {}
    product_normalization_documents = merge_pdp_geo_rag_documents(
        scope_pdp_geo_brand_rag_documents(
            [
                *profile_documents,
                *[dict(cast(Mapping[str, Any], item)) for item in as_list(runtime.get("ragDocuments")) if isinstance(item, Mapping)],
                *[dict(cast(Mapping[str, Any], item)) for item in as_list(parsed_rag.get("documents")) if isinstance(item, Mapping)],
            ],
            as_dict(normalized["product"]),
            parsed.hints.to_wire() if parsed.hints else None,
        )
    )
    if _should_report_model_gate(runtime, "customProductNormalizer", "productNormalization"):
        await tracker.mark("normalize", "running", "상품 신호 정규화 모델을 호출합니다.")
    product_normalization = await normalize_pdp_product_with_agent(
        {
            "rawProduct": parsed.product,
            "bootstrapProduct": normalized["product"],
            "locale": normalized["locale"],
            "market": normalized.get("market"),
            "source": parsed.source.to_wire() if parsed.source else None,
            "hints": parsed.hints.to_wire() if parsed.hints else None,
            "fieldMapping": parsed.field_mapping.to_wire() if parsed.field_mapping else None,
            "analysisPrompt": (
                parsed_rag.get("analysisPrompt")
                or runtime.get("analysisPrompt")
                or profile_analysis_prompt
            ),
            "ragDocuments": product_normalization_documents,
        },
        runtime,
    )
    normalized["product"] = product_normalization["product"]
    # A model may classify a source language but must not override caller-selected
    # locale/market.  This mirrors the TS control-plane preservation contract.
    normalized["locale"] = parsed.hints.locale if parsed.hints and parsed.hints.locale else normalized["locale"]
    normalized["market"] = (
        (parsed.hints.market if parsed.hints and parsed.hints.market else None)
        or product_normalization.get("market")
        or normalized.get("market")
    )
    normalized["evidence"] = [*normalized["evidence"], *product_normalization["evidence"]]
    if _should_report_model_gate(runtime, "customKeywordNormalizer", "keywordNormalization"):
        await tracker.mark("normalize", "running", "리뷰 키워드 정규화 모델을 호출합니다.")
    keyword_normalization = await normalize_product_review_keywords(
        normalized["product"], normalized["locale"], normalized.get("market"), runtime
    )
    normalized["product"] = keyword_normalization["product"]
    normalized["evidence"] = [*normalized["evidence"], *keyword_normalization["evidence"]]
    await tracker.mark(
        "normalize",
        "done",
        _normalize_step_message(
            str(normalized["product"].get("name") or "Untitled product"),
            product_normalization,
            bool(keyword_normalization.get("applied")),
        ),
    )

    await tracker.mark("rag-load", "running", "패키지 RAG 프로필과 런타임 RAG 문서를 로드합니다.")
    scoped_documents = scope_pdp_geo_brand_rag_documents(
        [
            *profile_documents,
            *[dict(cast(Mapping[str, Any], item)) for item in as_list(runtime.get("ragDocuments")) if isinstance(item, Mapping)],
            *[dict(cast(Mapping[str, Any], item)) for item in as_list(parsed_rag.get("documents")) if isinstance(item, Mapping)],
        ],
        as_dict(normalized["product"]),
        parsed.hints.to_wire() if parsed.hints else None,
    )
    # The TypeScript call spreads runtime settings first, then request settings:
    # explicit request controls win while document duplicates remain last-write-wins.
    rag_input = {
        **as_dict(runtime.get("rag")),
        **parsed_rag,
        "analysisPrompt": parsed_rag.get("analysisPrompt") or runtime.get("analysisPrompt") or profile_analysis_prompt,
        "documents": scoped_documents,
    }
    settings = resolve_pdp_geo_rag_settings(rag_input)
    analysis_prompt_name = str(PDP_GEO_GENERATOR_RAG_MANIFEST["analysisPrompt"])
    rag_documents = merge_pdp_geo_rag_documents(
        [
            {"name": analysis_prompt_name, "content": settings.get("analysisPrompt") or profile_analysis_prompt, "version": "v1"},
            *[dict(cast(Mapping[str, Any], item)) for item in as_list(settings.get("documents")) if isinstance(item, Mapping)],
        ]
    )
    documents = [item for item in rag_documents if item.get("name") != analysis_prompt_name]
    trusted_names = {analysis_prompt_name, *(str(item.get("name")) for item in profile_documents)}
    policy_documents = [
        {**item, "trusted": item.get("name") in trusted_names}
        for item in rag_documents
    ]
    policy = compile_pdp_geo_policy_checklist(policy_documents, as_dict(settings.get("policyChecklist")))
    await tracker.mark(
        "rag-load",
        "done",
        (
            f"{len(rag_documents)}개 RAG 문서를 로드하고 {policy['coverage']['totalRules']}개 정책 규칙을 컴파일했습니다 "
            f"(프롬프트 주입 {policy['coverage']['injectedRules']}개, critical "
            f"{policy['coverage']['injectedCriticalRules']}/{policy['coverage']['criticalRules']}개)."
        ),
    )

    managed = settings.get("mode") == "managed-vector-store-rag"
    await tracker.mark("chunk", "running", "Managed vector store의 색인 chunk를 사용합니다." if managed else "로컬 RAG 문서를 chunk로 분할합니다.")
    await tracker.mark("chunk", "done", "Managed vector store chunk 구성을 선택했습니다." if managed else "로컬 RAG chunk 구성을 준비했습니다.")
    await tracker.mark("embed", "running", "Managed vector store 임베딩을 사용합니다." if managed else "로컬 hash embedding을 구성합니다.")
    await tracker.mark(
        "embed",
        "done",
        f"{settings.get('provider')} 임베딩 검색 모드를 선택했습니다." if managed else "로컬 provider-neutral embedding을 구성했습니다.",
    )

    await tracker.mark("retrieve", "running", "상품, locale, schema target 기반 RAG query plan을 생성합니다.")
    hints = parsed.hints.to_wire() if parsed.hints else {}
    query_plan = create_pdp_geo_rag_query_plan(
        normalized["product"],
        normalized["locale"],
        normalized.get("market"),
        settings,
        as_list(hints.get("updateTargets")),
    )
    retrieved = await assemble_pdp_geo_rag_chunks(
        {
            "queryPlan": query_plan,
            "product": normalized["product"],
            "locale": normalized["locale"],
            "market": normalized.get("market"),
            "documents": documents,
            "settings": settings,
            "apiKey": runtime.get("apiKey"),
            "customRetriever": runtime.get("customRetriever"),
            "customUrlResolver": runtime.get("customUrlResolver"),
            "customEmbedder": runtime.get("customEmbedder"),
        }
    )
    await tracker.mark(
        "retrieve",
        "done",
        (
            f"{len(as_list(query_plan.get('queries')))}개 subquery로 {len(retrieved)}개 RAG chunk를 검색했습니다."
            if query_plan.get("mode") == "agentic-subquery-planning"
            else f"{len(retrieved)}개 RAG chunk를 검색했습니다."
        ),
    )

    await tracker.mark(
        "rerank",
        "running",
        "커스텀 cross-encoder reranker로 검색 후보를 재정렬합니다."
        if runtime.get("customReranker") is not None
        else "검색된 chunk를 schema/locale/GEO 관련성 기준으로 정렬합니다.",
    )
    reranked = await apply_custom_pdp_geo_rerank(
        retrieved,
        create_pdp_geo_rag_query(as_dict(normalized["product"]), str(normalized["locale"]), normalized.get("market")),
        runtime.get("customReranker"),
    )
    brand_scope = infer_pdp_geo_brand_rag_scope(as_dict(normalized["product"]), parsed.hints.to_wire() if parsed.hints else None)
    selected = select_final_rag_chunks(
        reranked,
        int(settings.get("maxChunks", 14)),
        {"brandOverlayDocuments": as_list(brand_scope.get("overlayDocuments"))},
    )
    hydrated_documents = hydrate_selected_pdp_geo_rag_documents(selected, documents, settings)
    reasoning_request = {
        "product": normalized["product"],
        "locale": normalized["locale"],
        "market": normalized.get("market"),
        "ragChunks": selected,
        "hydratedRagDocuments": hydrated_documents,
    }
    reasoning = await _resolve_reasoning(runtime.get("customReasoner"), reasoning_request)
    await tracker.mark(
        "rerank",
        "done",
        f"{len(selected)}개 chunk를 최종 컨텍스트로 선택하고 {len(reasoning['principles'])}개 RAG+상품근거 판단을 구성했습니다.",
    )

    await tracker.mark("generate", "running", "GEO 최적화 schema markup과 PDP content를 생성합니다.")
    ledger = create_pdp_geo_evidence_ledger(normalized["product"], normalized["locale"])
    if _should_report_model_gate(runtime, "customContentPlanner", "contentPlanning"):
        await tracker.mark("generate", "running", "evidence-bound content/schema planning 모델을 호출합니다.")
    planning = await plan_pdp_geo_content(
        {
            "product": normalized["product"],
            "locale": normalized["locale"],
            "market": normalized.get("market"),
            "hints": hints,
            "evidenceLedger": ledger,
            "ragChunks": selected,
            "policyRules": policy["injectedRules"],
        },
        runtime,
    )
    # ``applied`` is set only after strict wire admission; semantic failures
    # have already been removed field-locally by content planning.  Keep this
    # boolean separate from the subsequently coverage-normalized plan so no
    # merely truthy planner result can grant the renderer's model-copy bypass.
    semantic_plan_admitted = planning.get("applied") is True
    if planning.get("called") and not planning.get("applied"):
        warnings = as_list(planning.get("warnings"))
        suffix = f" (사유: {str(warnings[0])[:160]})" if warnings else ""
        await tracker.mark("generate", "running", f"evidence-bound planning이 적용되지 않아 보수적 source-backed 렌더러로 진행합니다{suffix}.")
    planning["plan"] = ensure_pdp_geo_faq_plan_coverage(
        {
            "plan": planning["plan"],
            "product": normalized["product"],
            "locale": normalized["locale"],
            "market": normalized.get("market"),
            "ragChunks": selected,
            "reasoning": reasoning,
            "evidenceLedger": ledger,
        }
    )
    # ``generate_pdp_geo_artifacts`` also supports direct, hand-assembled
    # inputs.  Mark only this already-admitted service plan so its natural
    # descriptions and FAQ wording are not re-screened by direct-helper guards.
    render_plan = {
        **as_dict(planning["plan"]),
        **({"_admittedContentPlan": True} if semantic_plan_admitted else {}),
    }
    generated = generate_pdp_geo_artifacts(
        {
            "product": normalized["product"],
            "locale": normalized["locale"],
            "market": normalized.get("market"),
            "sourceUrl": parsed.source.url if parsed.source else None,
            "hints": hints,
            "ragChunks": selected,
            "ragDocuments": rag_documents,
            "reasoning": reasoning,
            "contentPlan": render_plan,
        }
    )
    generated["schemaMarkup"] = as_dict(_normalize_renderer_review_attribution_spacing(generated["schemaMarkup"]))
    generated["content"] = as_dict(_normalize_renderer_review_attribution_spacing(generated["content"]))
    # The renderer is the only stage that finalizes which AI-authored FAQ rows
    # may be public.  Carry its identity/evidence sidecar unchanged through
    # later copy stages; those stages may improve prose but may not replace or
    # reconstruct FAQ membership.
    faq_membership = copy.deepcopy(generated["faqMembership"])

    # An evidence-admitted model plan normally bypasses the optional refiner
    # when both description fields are complete.  That shortcut used to leave
    # its live FAQ rows outside the BestPractice-aware FAQ pass entirely.
    # Treat only an actually rendered, non-deterministic admitted FAQ row as
    # a quality candidate: source fallback coverage must not spend a model
    # call, and an empty/non-rendered FAQ has nothing for the refiner to
    # improve.
    admitted_faq_quality_candidate = (
        semantic_plan_admitted
        and _has_admitted_model_faq_quality_candidates(
            as_dict(planning["plan"]), generated["schemaMarkup"], generated["faqMembership"]
        )
        and _can_run_corrective_refinement(runtime)
    )
    should_run_copy_refinement = (
        not bool(planning.get("applied"))
        or not (
            as_dict(planning["plan"]).get("productDescription", {}).get("include")
            and as_dict(planning["plan"]).get("webPageDescription", {}).get("include")
        )
        or as_dict(runtime.get("copyRefinement")).get("enabled") is True
        or admitted_faq_quality_candidate
    )
    initial_refinement_provenance_rollback: dict[str, Any] | None = None
    pre_refinement_schema_markup = copy.deepcopy(generated["schemaMarkup"])
    pre_refinement_content = copy.deepcopy(generated["content"])
    copy_refinement: dict[str, Any]
    if should_run_copy_refinement:
        if _should_report_model_gate(runtime, "customCopyRefiner", "copyRefinement"):
            await tracker.mark("generate", "running", "final reasoning/copy refinement 모델을 호출합니다.")
        copy_refinement = await refine_pdp_geo_copy(
            copy.deepcopy(
                {
                    "product": normalized["product"],
                    "locale": normalized["locale"],
                    "market": normalized.get("market"),
                    "schemaMarkup": pre_refinement_schema_markup,
                    "content": pre_refinement_content,
                    "faqMembership": copy.deepcopy(faq_membership),
                    "evidenceLedger": ledger,
                    "ragChunks": selected,
                    "hydratedRagDocuments": hydrated_documents,
                    "reasoning": reasoning,
                    "policyRules": policy["injectedRules"],
                    "inferredSearchQueries": generated["inferredSearchQueries"],
                }
            ),
            runtime,
        )
    else:
        copy_refinement = {
            "schemaMarkup": generated["schemaMarkup"],
            "content": generated["content"],
            "faqMembership": copy.deepcopy(faq_membership),
            "evidence": [],
            "warnings": [],
            "called": False,
            "applied": False,
            "rejections": [],
            "modelCall": {"called": False, "outcome": "notCalled"},
        }
    # New refiners echo this sidecar.  Preserve the renderer's original value
    # here as well so legacy/custom refiners that omit the additive field (or
    # attempt to replace it) cannot alter the canonical membership.
    copy_refinement = {**copy_refinement, "faqMembership": copy.deepcopy(faq_membership)}
    if copy_refinement.get("applied") is not True:
        copy_refinement = {
            **copy_refinement,
            "schemaMarkup": pre_refinement_schema_markup,
            "content": pre_refinement_content,
        }
    else:
        _, pre_refinement_validation = _validate_final_public_copy_candidate(
            pre_refinement_schema_markup,
            pre_refinement_content,
            planning["plan"],
            ledger,
            copy.deepcopy(faq_membership),
            normalized["product"],
            normalized["locale"],
        )
        candidate_schema_markup = _enforce_planner_refused_webpage_description(
            copy_refinement["schemaMarkup"], planning["plan"]
        )
        _, refinement_validation = _validate_final_public_copy_candidate(
            candidate_schema_markup,
            copy_refinement["content"],
            planning["plan"],
            ledger,
            copy.deepcopy(faq_membership),
            normalized["product"],
            normalized["locale"],
        )
        initial_refinement_provenance_rollback = _introduced_public_copy_provenance_diagnostics(
            pre_refinement_validation, refinement_validation
        )
        if initial_refinement_provenance_rollback:
            copy_refinement = {
                **copy_refinement,
                "schemaMarkup": pre_refinement_schema_markup,
                "content": pre_refinement_content,
                "applied": False,
                "warnings": [
                    "Initial copy refinement was rolled back because it introduced unresolved public-copy provenance paths.",
                ],
                "evidence": [
                    {
                        "field": "copy.refinement.provenance",
                        "source": "quality-gate",
                        "value": "Initial copy refinement was rolled back after provenance validation.",
                    },
                ],
                "rejections": [
                    {
                        "field": "copy.refinement.provenance",
                        "reason": "Initial copy refinement was rolled back after provenance validation.",
                    }
                ],
            }
    generated["schemaMarkup"] = copy_refinement["schemaMarkup"]
    generated["content"] = copy_refinement["content"]
    generated["faqMembership"] = copy.deepcopy(faq_membership)
    generated["schemaMarkup"] = _enforce_planner_refused_webpage_description(
        generated["schemaMarkup"], planning["plan"]
    )
    # Keep the TypeScript assembly order: renderer evidence, planning evidence,
    # then refinement evidence.  A previous port duplicated renderer records
    # here and re-appended planning evidence while serializing diagnostics.
    generated["evidence"] = _deduplicate_evidence(
        [*as_list(generated["evidence"]), *as_list(planning.get("evidence")), *as_list(copy_refinement["evidence"])]
    )
    public_copy_provenance = create_pdp_geo_public_copy_provenance(
        {
            "schemaMarkup": generated["schemaMarkup"],
            "contentPlan": planning["plan"],
            "evidenceLedger": ledger,
            "faqMembership": copy.deepcopy(faq_membership),
        }
    )
    initial_provenance_decisions = create_pdp_geo_public_copy_provenance_decision_diagnostics(
        {
            "schemaMarkup": generated["schemaMarkup"],
            "contentPlan": planning["plan"],
            "evidenceLedger": ledger,
            "faqMembership": copy.deepcopy(faq_membership),
            "publicCopyProvenance": public_copy_provenance,
        },
        phase="initial",
    )
    if _should_report_model_gate(runtime, "customFinalProofreader", "finalProofreading"):
        await tracker.mark("generate", "running", "final fluency-only proofreading 모델을 호출합니다.")
    final_proofreading = await final_proofread_pdp_geo_artifacts(
        {
            "product": normalized["product"],
            "locale": normalized["locale"],
            "market": normalized.get("market"),
            "schemaMarkup": generated["schemaMarkup"],
            "content": generated["content"],
            "evidenceLedger": ledger,
            "faqMembership": copy.deepcopy(faq_membership),
            "contentPlan": planning["plan"],
            "publicCopyProvenance": public_copy_provenance,
        },
        runtime,
    )
    final_proofreading = {**final_proofreading, "faqMembership": copy.deepcopy(faq_membership)}
    generated["schemaMarkup"] = final_proofreading["schemaMarkup"]
    generated["content"] = final_proofreading["content"]
    generated["faqMembership"] = copy.deepcopy(faq_membership)
    generated["schemaMarkup"] = _enforce_planner_refused_webpage_description(
        generated["schemaMarkup"], planning["plan"]
    )
    generated["evidence"] = _deduplicate_evidence(
        [*as_list(generated["evidence"]), *as_list(final_proofreading["evidence"])]
    )
    after_proofreader_provenance_decisions = create_pdp_geo_public_copy_provenance_decision_diagnostics(
        {
            "schemaMarkup": generated["schemaMarkup"],
            "contentPlan": planning["plan"],
            "evidenceLedger": ledger,
            "faqMembership": copy.deepcopy(faq_membership),
            "publicCopyProvenance": final_proofreading.get("finalPublicCopyProvenance", []),
        },
        phase="afterProofreader",
    )
    await tracker.mark(
        "generate",
        "done",
        (
            "근거와 구조를 잠근 상태에서 최종 문장 교정을 적용했습니다."
            if as_dict(final_proofreading["diagnostics"]).get("applied")
            else "보수적 스키마 적합성 판단으로 근거가 확인된 산출물을 생성했습니다."
        ),
    )

    await tracker.mark(
        "repair",
        "running",
        "결정적 문장 정규화(sentence-QA) 리페어만 적용하고 구조·클레임 변경은 진단으로 남깁니다.",
    )
    safe = apply_safe_public_copy_repairs(
        {
            "schemaMarkup": generated["schemaMarkup"],
            "content": generated["content"],
            "fallbackProductName": as_dict(generated["content"]).get("sections", {}).get("productName"),
            "fallbackDescription": as_dict(generated["content"]).get("sections", {}).get("description"),
            "locale": normalized["locale"],
            "sourceProduct": normalized["product"],
        }
    )
    generated["schemaMarkup"], generated["content"] = safe["schemaMarkup"], safe["content"]
    generated["schemaMarkup"] = _enforce_planner_refused_webpage_description(
        generated["schemaMarkup"], planning["plan"]
    )
    public_copy_provenance = reconcile_pdp_geo_public_copy_provenance(
        {
            "schemaMarkup": generated["schemaMarkup"],
            "contentPlan": planning["plan"],
            "evidenceLedger": ledger,
            "faqMembership": copy.deepcopy(faq_membership),
            "publicCopyProvenance": final_proofreading.get("finalPublicCopyProvenance", []),
        }
    )
    after_safe_repair_provenance_decisions = create_pdp_geo_public_copy_provenance_decision_diagnostics(
        {
            "schemaMarkup": generated["schemaMarkup"],
            "contentPlan": planning["plan"],
            "evidenceLedger": ledger,
            "faqMembership": copy.deepcopy(faq_membership),
            "publicCopyProvenance": public_copy_provenance,
        },
        phase="afterSafeRepair",
    )
    public_copy_provenance_decisions = [
        *initial_provenance_decisions,
        *after_proofreader_provenance_decisions,
        *after_safe_repair_provenance_decisions,
    ]
    current_provenance_decision_phase = "afterSafeRepair"
    public_copy_omissions: list[dict[str, Any]] = []
    applied_repairs = as_list(safe.get("appliedRepairs"))
    await tracker.mark(
        "repair",
        "done",
        (
            f"{len(applied_repairs)}개 결정적 문장 리페어를 적용했습니다. 구조·클레임 변경은 적용하지 않고 진단으로 남깁니다."
            if applied_repairs
            else "적용할 결정적 문장 리페어가 없었습니다. 산출물을 그대로 보존했습니다."
        ),
    )

    await tracker.mark("validate", "running", "리페어 적용 이후 JSON-LD와 공개 문구를 읽기 전용으로 검증합니다.")
    validation = validate_pdp_geo_artifacts(
        {
            "schemaMarkup": generated["schemaMarkup"],
            "content": generated["content"],
            "fallbackProductName": as_dict(generated["content"]).get("sections", {}).get("productName"),
            "fallbackDescription": as_dict(generated["content"]).get("sections", {}).get("description"),
            "locale": normalized["locale"],
            "sourceProduct": normalized["product"],
            "contentPlan": planning["plan"],
            "faqMembership": copy.deepcopy(faq_membership),
            "evidenceLedger": ledger,
            "publicCopyProvenance": public_copy_provenance,
        }
    )
    await tracker.mark(
        "validate",
        "done",
        "검증 경고 없이 통과했습니다."
        if not validation["validationWarnings"]
        else f"{len(validation['validationWarnings'])}개 검증 경고를 확인했습니다.",
    )

    await tracker.mark("quality-gate", "running", "GEO/CEP/E-E-A-T 품질 루브릭으로 산출물을 자가 평가합니다.")
    corrective_available = _can_run_corrective_refinement(runtime)
    gate = resolve_quality_gate_settings(as_dict(runtime.get("qualityGate")), corrective_available)
    rag_usage = create_pdp_geo_rag_usage_diagnostics(selected, reasoning)
    # In the TS contract this optional diagnostics field is ``undefined`` when
    # disabled, and therefore absent from the JSON response.  Retain that
    # distinction instead of exposing an ``enabled: false`` pseudo-result.
    quality: dict[str, Any] | None = None
    if gate["enabled"]:
        quality = {
            "enabled": True,
            "thresholds": gate["thresholds"],
            "shortfalls": [],
            "attempted": False,
            "adopted": False,
        }
        initial_artifact = _quality_artifact_input(
            generated["schemaMarkup"],
            validation,
            safe["appliedRepairs"],
            normalized,
            generated,
            ledger,
            planning["plan"],
            rag_usage,
        )
        evaluation = evaluate_pdp_geo_artifact_quality(initial_artifact)
        scores = quality_gate_scores(evaluation)
        shortfalls = collect_quality_gate_shortfalls(
            scores,
            gate["thresholds"],
            len(validation["validationWarnings"]),
            count_unresolved_public_copy_findings(validation["validationFindings"]),
        )
        structural_shortfalls = collect_pdp_geo_plan_render_shortfalls(
            as_dict(planning["plan"]),
            as_dict(generated["schemaMarkup"]),
            as_dict(generated["content"]),
        )
        shortfalls.extend(structural_shortfalls)
        quality["correctiveDiagnostics"] = {
            "correctiveApplied": False,
            "correctedMissingPaths": [],
            "adoptionReason": "notNeeded" if not shortfalls else "noCorrectiveRuntime",
            "structuralShortfallCount": len(structural_shortfalls),
            "provenanceRegressionDelta": 0,
        }
        initial_concept = (
            await judge_concept_embodiment_safely(
                _quality_eval_input(initial_artifact), as_dict(gate.get("conceptJudge")), str(normalized["locale"])
            )
            if gate.get("conceptJudge")
            else None
        )
        if initial_concept and initial_concept.get("assessment") is not None:
            shortfalls.extend(collect_concept_shortfalls(initial_concept["assessment"], gate["thresholds"]))
        quality.update(
            {
                "initialScores": scores,
                "initialWarningCount": len(validation["validationWarnings"]),
                "shortfalls": shortfalls,
                **(
                    {"conceptAssessment": to_concept_assessment_diagnostics(initial_concept["assessment"])}
                    if initial_concept and initial_concept.get("assessment") is not None
                    else {}
                ),
                "reason": "Quality gate passed without correction."
                if not shortfalls
                else "Quality gate shortfalls were detected.",
            }
        )
        if shortfalls:
            cast(dict[str, Any], quality["correctiveDiagnostics"])["adoptionReason"] = "noCorrectiveRuntime"
        if shortfalls and corrective_available:
            quality["attempted"] = True
            corrective_diagnostics = cast(dict[str, Any], quality["correctiveDiagnostics"])
            corrective_diagnostics["adoptionReason"] = "correctiveNotApplied"
            pre_corrective_schema_markup = copy.deepcopy(generated["schemaMarkup"])
            pre_corrective_content = copy.deepcopy(generated["content"])
            corrective = await refine_pdp_geo_copy(
                copy.deepcopy(
                    {
                        "product": normalized["product"],
                        "locale": normalized["locale"],
                        "market": normalized.get("market"),
                        "schemaMarkup": pre_corrective_schema_markup,
                        "content": pre_corrective_content,
                        "faqMembership": copy.deepcopy(faq_membership),
                        "evidenceLedger": ledger,
                        "ragChunks": selected,
                        "hydratedRagDocuments": hydrated_documents,
                        "reasoning": reasoning,
                        "policyRules": policy["injectedRules"],
                        "inferredSearchQueries": generated["inferredSearchQueries"],
                        "refinementFeedback": [
                            *create_quality_gate_feedback(
                                evaluation,
                                scores,
                                as_dict(gate.get("thresholds")),
                                validation["validationWarnings"],
                            ),
                            *[
                                {"field": "quality-gate:structure", "reason": shortfall}
                                for shortfall in structural_shortfalls
                            ],
                            *(
                                create_concept_gate_feedback(initial_concept["assessment"], gate["thresholds"])
                                if initial_concept and initial_concept.get("assessment") is not None
                                else []
                            ),
                        ],
                    }
                ),
                runtime,
            )
            corrective = {**corrective, "faqMembership": copy.deepcopy(faq_membership)}
            if corrective["applied"]:
                corrective_diagnostics["correctiveApplied"] = True
                corrected_safe = apply_safe_public_copy_repairs(
                    {
                        "schemaMarkup": corrective["schemaMarkup"],
                        "content": corrective["content"],
                        "fallbackProductName": as_dict(corrective["content"]).get("sections", {}).get("productName"),
                        "fallbackDescription": as_dict(corrective["content"]).get("sections", {}).get("description"),
                        "locale": normalized["locale"],
                        "sourceProduct": normalized["product"],
                    }
                )
                corrected_safe["schemaMarkup"] = _enforce_planner_refused_webpage_description(
                    corrected_safe["schemaMarkup"], planning["plan"]
                )
                corrected_public_copy_provenance = create_pdp_geo_public_copy_provenance(
                    {
                        "schemaMarkup": corrected_safe["schemaMarkup"],
                        "contentPlan": planning["plan"],
                        "evidenceLedger": ledger,
                        "faqMembership": copy.deepcopy(faq_membership),
                    }
                )
                corrected_validation = validate_pdp_geo_artifacts(
                    {
                        "schemaMarkup": corrected_safe["schemaMarkup"],
                        "content": corrected_safe["content"],
                        "fallbackProductName": as_dict(corrected_safe["content"]).get("sections", {}).get("productName"),
                        "fallbackDescription": as_dict(corrected_safe["content"]).get("sections", {}).get("description"),
                        "locale": normalized["locale"],
                        "sourceProduct": normalized["product"],
                        "contentPlan": planning["plan"],
                        "faqMembership": copy.deepcopy(faq_membership),
                        "evidenceLedger": ledger,
                        "publicCopyProvenance": corrected_public_copy_provenance,
                    }
                )
                corrected_provenance_decisions = create_pdp_geo_public_copy_provenance_decision_diagnostics(
                    {
                        "schemaMarkup": corrected_safe["schemaMarkup"],
                        "contentPlan": planning["plan"],
                        "evidenceLedger": ledger,
                        "faqMembership": copy.deepcopy(faq_membership),
                        "publicCopyProvenance": corrected_public_copy_provenance,
                    },
                    phase="correctedCandidate",
                )
                public_copy_provenance_decisions.extend(corrected_provenance_decisions)
                corrected_generated = {**generated, "evidence": [*generated["evidence"], *corrective["evidence"]]}
                corrected_artifact = _quality_artifact_input(
                    corrected_safe["schemaMarkup"],
                    corrected_validation,
                    corrected_safe["appliedRepairs"],
                    normalized,
                    corrected_generated,
                    ledger,
                    planning["plan"],
                    rag_usage,
                )
                corrected_evaluation = evaluate_pdp_geo_artifact_quality(corrected_artifact)
                corrected_scores = quality_gate_scores(corrected_evaluation)
                corrected_concept = (
                    await judge_concept_embodiment_safely(
                        _quality_eval_input(corrected_artifact), as_dict(gate.get("conceptJudge")), str(normalized["locale"])
                    )
                    if gate.get("conceptJudge") and initial_concept and initial_concept.get("assessment") is not None
                    else None
                )
                quality["correctedScores"] = corrected_scores
                quality["correctedWarningCount"] = len(corrected_validation["validationWarnings"])
                if corrected_concept and corrected_concept.get("assessment") is not None:
                    quality["correctedConceptAssessment"] = to_concept_assessment_diagnostics(corrected_concept["assessment"])
                corrected_structural_shortfalls = collect_pdp_geo_plan_render_shortfalls(
                    as_dict(planning["plan"]),
                    as_dict(corrected_safe["schemaMarkup"]),
                    as_dict(corrected_safe["content"]),
                )
                corrected_provenance_regression = _introduced_public_copy_provenance_diagnostics(
                    validation, corrected_validation
                )
                corrective_diagnostics.update(
                    {
                        "correctedMissingPaths": _provenance_decision_missing_paths(corrected_provenance_decisions),
                        "structuralShortfallCount": len(corrected_structural_shortfalls),
                        "provenanceRegressionDelta": _safe_nonnegative_count(
                            as_dict(corrected_provenance_regression).get("findingCount")
                        ),
                    }
                )
                if corrected_provenance_regression:
                    quality["rejectedCorrectedPublicCopyProvenance"] = corrected_provenance_regression
                if (
                    not corrected_structural_shortfalls
                    and not corrected_provenance_regression
                    and should_adopt_corrected_artifacts(
                        {
                            "scores": scores,
                            "warningCount": len(validation["validationWarnings"]),
                            "conceptScore": _concept_score(initial_concept),
                        },
                        {
                            "scores": corrected_scores,
                            "warningCount": len(corrected_validation["validationWarnings"]),
                            "conceptScore": _concept_score(corrected_concept),
                        },
                    )
                ):
                    generated["schemaMarkup"] = corrected_safe["schemaMarkup"]
                    generated["content"] = corrected_safe["content"]
                    generated["faqMembership"] = copy.deepcopy(faq_membership)
                    generated["evidence"] = [*generated["evidence"], *corrective["evidence"]]
                    safe = corrected_safe
                    validation = corrected_validation
                    public_copy_provenance = corrected_public_copy_provenance
                    current_provenance_decision_phase = "correctedCandidate"
                    quality["adopted"] = True
                    corrective_diagnostics["adoptionReason"] = "adopted"
                    quality["reason"] = "Corrected artifacts scored measurably better and were adopted."
                elif corrected_provenance_regression:
                    corrective_diagnostics["adoptionReason"] = "provenanceRegression"
                    quality["reason"] = "Corrected artifacts introduced unresolved public-copy provenance and were rolled back."
                elif corrected_structural_shortfalls:
                    corrective_diagnostics["adoptionReason"] = "structuralShortfall"
                    quality["reason"] = "Corrected artifacts did not restore plan/render structural coverage and were rolled back."
                else:
                    corrective_diagnostics["adoptionReason"] = "notImproved"
                    quality["reason"] = "Corrected artifacts did not measurably improve and were rolled back."
            else:
                quality["reason"] = "Corrective refinement produced no applicable edits; initial artifacts were kept."
        elif shortfalls:
            quality["reason"] = "Quality gate shortfalls were detected but no corrective model runtime is configured."
    isolation = _isolate_unbound_public_copy(
        schema_markup=as_dict(generated["schemaMarkup"]),
        content=as_dict(generated["content"]),
        validation=validation,
        decisions=public_copy_provenance_decisions,
        phase=current_provenance_decision_phase,
        locale=str(normalized["locale"]),
    )
    public_copy_omissions = [as_dict(item) for item in as_list(isolation.get("omissions")) if as_dict(item)]
    if public_copy_omissions:
        generated["schemaMarkup"] = as_dict(isolation["schemaMarkup"])
        generated["content"] = as_dict(isolation["content"])
        generated["evidence"] = _deduplicate_evidence(
            [
                *as_list(generated["evidence"]),
                {
                    "field": "publicCopyProvenance",
                    "source": "quality-gate",
                    "value": f"Omitted {len(public_copy_omissions)} public-copy unit(s) without final evidence bindings.",
                },
            ]
        )
        public_copy_provenance = create_pdp_geo_public_copy_provenance(
            {
                "schemaMarkup": generated["schemaMarkup"],
                "contentPlan": planning["plan"],
                "evidenceLedger": ledger,
                "faqMembership": copy.deepcopy(faq_membership),
            }
        )
        validation = validate_pdp_geo_artifacts(
            {
                "schemaMarkup": generated["schemaMarkup"],
                "content": generated["content"],
                "fallbackProductName": as_dict(generated["content"]).get("sections", {}).get("productName"),
                "fallbackDescription": as_dict(generated["content"]).get("sections", {}).get("description"),
                "locale": normalized["locale"],
                "sourceProduct": normalized["product"],
                "contentPlan": planning["plan"],
                "faqMembership": copy.deepcopy(faq_membership),
                "evidenceLedger": ledger,
                "publicCopyProvenance": public_copy_provenance,
            }
        )

    if quality is not None:
        if public_copy_omissions:
            quality["publicCopyOmissionCount"] = len(public_copy_omissions)
            quality["reason"] = "Quality gate completed after omitting public-copy units without final evidence bindings."
        if quality["attempted"]:
            blocking_shortfalls = _remaining_structural_shortfalls_after_public_copy_omissions(
                collect_pdp_geo_plan_render_shortfalls(
                    as_dict(planning["plan"]),
                    as_dict(generated["schemaMarkup"]),
                    as_dict(generated["content"]),
                ),
                public_copy_omissions,
            )
            if blocking_shortfalls:
                quality["blockingShortfalls"] = blocking_shortfalls
                quality["reason"] = "Quality gate blocked final artifact after corrective refinement: " + "; ".join(
                    blocking_shortfalls
                )
                await tracker.mark("quality-gate", "error", quality["reason"])
                raise QualityGateBlockedError(
                    quality["reason"],
                    _quality_gate_blocked_diagnostics(
                        tracker=tracker,
                        quality=quality,
                        validation=validation,
                        public_copy_provenance=public_copy_provenance,
                        product_normalization=product_normalization,
                        keyword_normalization=keyword_normalization,
                        planning=planning,
                        copy_refinement=copy_refinement,
                        final_proofreading=final_proofreading,
                        public_copy_provenance_decisions=public_copy_provenance_decisions,
                        retrieved_count=len(retrieved),
                        selected_rag_count=len(selected),
                    ),
                )
        await tracker.mark("quality-gate", "done", quality["reason"])
    else:
        await tracker.mark(
            "quality-gate",
            "done",
            "품질 게이트가 비활성화되어 자가 평가를 건너뛰었습니다."
            if not public_copy_omissions
            else "최종 근거가 결속되지 않은 공개 문구만 제외하고 나머지 산출물을 보존했습니다.",
        )

    await tracker.mark("artifact", "running", "최종 GEO 아티팩트를 직렬화합니다.")
    generated_at = datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    runtime_usage = _create_runtime_usage(
        runtime,
        settings,
        {
            "productNormalization": product_normalization,
            "keywordNormalization": keyword_normalization,
            "contentPlanning": planning,
            "copyRefinement": copy_refinement,
            "finalProofreading": final_proofreading,
            "retrievedCount": len(retrieved),
            "selectedRagCount": len(selected),
            "ragDocumentCount": len(rag_documents),
        },
    )
    diagnostics = {
        "normalizedProduct": normalized["product"],
        "evidenceLedger": ledger,
        "contentPlan": planning["plan"],
        "contentPlanning": _safe_content_planning_diagnostics(planning, faq_membership),
        "ocrSentences": normalized.get("ocrSentences", []),
        "recommendations": generated["recommendations"],
        "evidence": _deduplicate_evidence(
            [
                *as_list(normalized["evidence"]),
                *as_list(generated["evidence"]),
                *[
                {"field": "validation", "source": "schema-validator", "value": warning}
                for warning in validation["validationWarnings"]
            ],
            ]
        ),
        # JSON.stringify prints a whole JavaScript Number as ``1``; Python's
        # json module would otherwise expose an equivalent ``1.0``.  Normalize
        # only at this public diagnostics boundary after all retrieval math is
        # complete, retaining source ordering and non-integral precision.
        "selectedRagChunks": _wire_numbers(selected),
        "hydratedRagDocuments": hydrated_documents,
        "policyCoverage": _wire_numbers(policy["coverage"]),
        "reasoning": reasoning,
        "ragQueryPlan": query_plan,
        "ragUsage": rag_usage,
        "runtimeUsage": runtime_usage,
        "terminology": generated["terminology"],
        "inferredSearchQueries": generated["inferredSearchQueries"],
        "finalProofreading": final_proofreading["diagnostics"],
        "finalPublicCopyProvenance": public_copy_provenance,
        "publicCopyProvenanceDecisionDiagnostics": public_copy_provenance_decisions,
        **({"publicCopyOmissions": public_copy_omissions} if public_copy_omissions else {}),
        **(
            {"copyRefinementProvenanceRollback": initial_refinement_provenance_rollback}
            if initial_refinement_provenance_rollback
            else {}
        ),
        "validationWarnings": validation["validationWarnings"],
        "validationFindings": validation["validationFindings"],
        "validationRepairs": safe["appliedRepairs"],
        **({"qualityGate": quality} if quality is not None else {}),
        "ragMode": settings["mode"],
        "generatedAt": generated_at,
    }
    result = {
        **({"source": parsed.source.to_wire()} if parsed.source else {}),
        "locale": normalized["locale"],
        "market": normalized.get("market"),
        "schemaMarkup": generated["schemaMarkup"],
        "content": generated["content"],
        "diagnostics": diagnostics,
        "generatedAt": generated_at,
        "ragProfile": profile.get("profile"),
    }
    await tracker.mark("artifact", "done", "최종 GEO schema/content 아티팩트를 생성했습니다.")
    # Direct library callers share the same public JSON boundary as REST.
    # TypeScript's JSON.stringify omits undefined object properties, whereas
    # Python would otherwise expose the internal ``None`` values as ``null``.
    # Normalize once here so direct and REST diagnostics/artifacts retain an
    # identical deterministic wire shape.
    return as_dict(omit_none({"result": result, "diagnostics": diagnostics, "process": tracker.snapshot()}))


async def _resolve_reasoning(custom_reasoner: object | None, request: Mapping[str, Any]) -> dict[str, Any]:
    if custom_reasoner is None:
        return create_pdp_geo_reasoning(request)
    method = getattr(custom_reasoner, "reason", None)
    if not callable(method):
        return create_pdp_geo_reasoning(request)
    value = method(dict(request))
    result = await value if inspect.isawaitable(value) else value
    return as_dict(result) or create_pdp_geo_reasoning(request)


def _quality_artifact_input(
    schema_markup: object,
    validation: Mapping[str, Any],
    repairs: object,
    normalized: Mapping[str, Any],
    generated: Mapping[str, Any],
    ledger: object,
    plan: object,
    rag_usage: object,
) -> dict[str, Any]:
    return {
        "schemaMarkup": schema_markup,
        "locale": normalized.get("locale"),
        "normalizedProduct": normalized.get("product", {}),
        "validationWarnings": validation.get("validationWarnings", []),
        "validationRepairs": repairs,
        "evidence": [*as_list(normalized.get("evidence")), *as_list(generated.get("evidence"))],
        "evidenceLedger": ledger,
        "contentPlan": plan,
        "ragUsage": rag_usage,
    }


def _validate_final_public_copy_candidate(
    schema_markup: object,
    content: object,
    content_plan: object,
    evidence_ledger: object,
    faq_membership: object,
    source_product: object,
    locale: object,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Return final provenance and validation for an uncommitted artifact candidate."""

    provenance = create_pdp_geo_public_copy_provenance(
        {
            "schemaMarkup": schema_markup,
            "contentPlan": content_plan,
            "evidenceLedger": evidence_ledger,
            "faqMembership": copy.deepcopy(faq_membership),
        }
    )
    sections = as_dict(as_dict(content).get("sections"))
    validation = validate_pdp_geo_artifacts(
        {
            "schemaMarkup": schema_markup,
            "content": content,
            "fallbackProductName": sections.get("productName"),
            "fallbackDescription": sections.get("description"),
            "locale": locale,
            "sourceProduct": source_product,
            "contentPlan": content_plan,
            "faqMembership": copy.deepcopy(faq_membership),
            "evidenceLedger": evidence_ledger,
            "publicCopyProvenance": provenance,
        }
    )
    return provenance, validation


def _introduced_public_copy_provenance_diagnostics(
    baseline_validation: Mapping[str, Any], candidate_validation: Mapping[str, Any]
) -> dict[str, Any] | None:
    """Describe only provenance paths a candidate adds beyond its current artifact."""

    baseline_paths = {
        field
        for raw in as_list(baseline_validation.get("validationFindings"))
        if (finding := as_dict(raw)).get("source") == "public-copy-provenance"
        if isinstance(field := finding.get("field"), str) and field
    }
    introduced = [
        finding
        for raw in as_list(candidate_validation.get("validationFindings"))
        if (finding := as_dict(raw)).get("source") == "public-copy-provenance"
        if isinstance(finding.get("field"), str) and finding["field"] not in baseline_paths
    ]
    if not introduced:
        return None
    return {
        "findingCount": len(introduced),
        "fieldPaths": list(dict.fromkeys(str(finding["field"]) for finding in introduced)),
    }


def _enforce_planner_refused_webpage_description(schema_markup: object, content_plan: object) -> dict[str, Any]:
    """Preserve deterministic source fallback when a model field is omitted.

    A semantic-plan rejection means only that the model wording did not earn
    publication.  The renderer has already replaced it with source-backed
    WebPage copy; deleting that value here would turn one local rejection into
    an erased schema surface.
    """

    del content_plan
    return as_dict(schema_markup)


def _deduplicate_evidence(records: object) -> list[dict[str, Any]]:
    """Retain first-seen evidence records while removing wire-identical copies.

    Provenance is JSON-shaped at this boundary.  A canonical JSON fingerprint
    preserves the renderer/planner/refiner ordering while making accidental
    repeated records impossible to expose in diagnostics.
    """

    unique: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in as_list(records):
        record = as_dict(raw)
        if not record:
            continue
        fingerprint = json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
        if fingerprint in seen:
            continue
        seen.add(fingerprint)
        unique.append(record)
    return unique


def _wire_numbers(value: object) -> object:
    """Match JSON.stringify's integral-number spelling without sorting maps."""

    if isinstance(value, Mapping):
        mapping = cast(Mapping[str, object], value)
        return {key: _wire_numbers(item) for key, item in mapping.items()}
    if isinstance(value, list):
        return [_wire_numbers(item) for item in cast(list[object], value)]
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def _quality_eval_input(artifact: Mapping[str, Any]) -> dict[str, Any]:
    return create_quality_eval_input(artifact)


def _concept_score(result: Mapping[str, Any] | None) -> float | None:
    assessment = as_dict(as_dict(result).get("assessment"))
    score = assessment.get("overallScore")
    return float(score) if isinstance(score, int | float) and not isinstance(score, bool) else None


_MODEL_RUNTIME_STAGES = frozenset(
    {
        "product-normalization",
        "keyword-normalization",
        "content-planning",
        "copy-refinement",
        "final-proofreading",
    }
)


def _runtime_stage_model_fields(runtime: Mapping[str, Any], settings_key: str) -> dict[str, object]:
    """Expose the selected model/deployment only for the stage that used it."""

    settings = as_dict(runtime.get(settings_key))
    configured_provider = settings.get("provider")
    inherits_parent = not configured_provider or configured_provider == runtime.get("provider")
    model = settings.get("model") or (runtime.get("model") if inherits_parent else None)
    deployment = settings.get("deployment")
    if deployment is None and inherits_parent:
        deployments = as_dict(runtime.get("deployments"))
        deployment = deployments.get("proofreading" if settings_key == "finalProofreading" else "reasoning")
        if deployment is None:
            deployment = runtime.get("deployment")
    return {
        **({"model": model} if model else {}),
        **({"deployment": deployment} if deployment else {}),
    }


def _runtime_model_stage(
    runtime: Mapping[str, Any],
    result: Mapping[str, Any],
    *,
    stage: str,
    label: str,
    settings_key: str,
    custom_keys: Sequence[str],
) -> dict[str, Any]:
    """Represent one optional generation stage without inventing a final model call."""

    called = result.get("called") is True
    custom_key = next((key for key in custom_keys if runtime.get(key) is not None), "")
    if called and custom_key:
        provider, service = "custom", custom_key
        details = f"{custom_key} was called."
        model_fields: dict[str, object] = {}
    elif called:
        stage_settings = as_dict(runtime.get(settings_key))
        configured_provider = stage_settings.get("provider") or runtime.get("provider") or "unknown"
        provider = _runtime_provider_label(configured_provider)
        service = provider
        details = f"{label} called the configured provider."
        model_fields = _runtime_stage_model_fields(runtime, settings_key)
    else:
        provider, service = "deterministic", "source-backed deterministic fallback"
        details = f"No custom/provider {label.casefold()} call was made; the deterministic source-backed path was used."
        model_fields = {}
    return {
        "stage": stage,
        "label": label,
        "provider": provider,
        "service": service,
        "called": called,
        **model_fields,
        **({"tokenUsage": result["usage"]} if result.get("usage") is not None else {}),
        "details": details,
    }


def _create_runtime_usage(
    runtime: Mapping[str, Any], settings: Mapping[str, Any], context: Mapping[str, Any]
) -> dict[str, Any]:
    """Expose the same provider/token accounting shape as the Node diagnostics."""

    provider = _runtime_provider_label(runtime.get("provider"))
    embedding_provider = runtime.get("embedding", {}).get("provider") if isinstance(runtime.get("embedding"), Mapping) else settings.get("embeddingProvider")
    reranker_provider = runtime.get("reranker", {}).get("provider") if isinstance(runtime.get("reranker"), Mapping) else settings.get("rerankerProvider")
    product_normalization = as_dict(context.get("productNormalization"))
    keyword_normalization = as_dict(context.get("keywordNormalization"))
    content_planning = as_dict(context.get("contentPlanning"))
    copy_refinement = as_dict(context.get("copyRefinement"))
    proofreading = as_dict(context.get("finalProofreading"))
    proofreading_diagnostics = as_dict(proofreading.get("diagnostics"))
    proof_usage = proofreading.get("usage")
    proof_called = proofreading_diagnostics.get("called") is True
    steps = [
        _runtime_model_stage(
            runtime,
            product_normalization,
            stage="product-normalization",
            label="Product normalization",
            settings_key="productNormalization",
            custom_keys=("customProductNormalizer",),
        ),
        _runtime_model_stage(
            runtime,
            keyword_normalization,
            stage="keyword-normalization",
            label="Review-keyword normalization",
            settings_key="keywordNormalization",
            custom_keys=("customKeywordNormalizer",),
        ),
        {
            "stage": "chunking",
            "label": "Chunking",
            "provider": "deterministic",
            "service": "section-aware deterministic chunking",
            "called": True,
            "details": f"{context.get('ragDocumentCount', 0)} RAG documents prepared as section-aware chunks. No model is used.",
        },
        {
            "stage": "embedding",
            "label": "Embedding",
            "provider": _runtime_provider_label(embedding_provider),
            "service": f"{embedding_provider} embedding",
            **(
                {"model": as_dict(runtime.get("embedding")).get("model") or settings.get("embeddingModel")}
                if as_dict(runtime.get("embedding")).get("model") or settings.get("embeddingModel")
                else {}
            ),
            "called": settings.get("mode") == "managed-vector-store-rag",
            "details": "Managed/vector retrieval mode is configured."
            if settings.get("mode") == "managed-vector-store-rag"
            else "Generator local-versioned RAG uses local contextual hybrid vectors and lexical signals unless a managed retriever is configured.",
        },
        {
            "stage": "retrieval",
            "label": "Retrieval",
            "provider": _runtime_provider_label(settings.get("provider")),
            "service": f"{settings.get('provider')} managed vector search"
            if settings.get("mode") == "managed-vector-store-rag"
            else "local-versioned RAG hybrid search",
            "mode": settings.get("mode"),
            "called": True,
            "details": f"{context.get('retrievedCount', 0)} chunks retrieved before {context.get('selectedRagCount', 0)} chunks were selected for generation.",
        },
        {
            "stage": "reranking",
            "label": "Reranking",
            "provider": _runtime_provider_label(reranker_provider),
            "service": f"{reranker_provider} ordering",
            "called": runtime.get("customReranker") is not None
            or (settings.get("mode") == "managed-vector-store-rag" and settings.get("rerankerProvider") != "local-hybrid"),
            "details": "Local-versioned mode applies contextual hybrid reranking, RRF-style lexical/semantic fusion metadata, and coverage-aware chunk selection before strategic GEO/CEP/E-E-A-T reasoning.",
        },
        {
            "stage": "ocr",
            "label": "OCR/structure extraction",
            "provider": provider,
            "service": provider,
            "called": False,
            "details": "Generator consumes OCR evidence from the extractor result; it does not run image OCR itself.",
        },
        _runtime_model_stage(
            runtime,
            content_planning,
            stage="content-planning",
            label="Evidence-bound content planning",
            settings_key="contentPlanning",
            custom_keys=("customContentPlanner", "contentPlanner"),
        ),
        _runtime_model_stage(
            runtime,
            copy_refinement,
            stage="copy-refinement",
            label="Copy refinement",
            settings_key="copyRefinement",
            custom_keys=("customCopyRefiner",),
        ),
        _runtime_model_stage(
            runtime,
            {"called": proof_called, **({"usage": proof_usage} if proof_usage is not None else {})},
            stage="final-proofreading",
            label="Final proofreading",
            settings_key="finalProofreading",
            custom_keys=("customFinalProofreader",),
        ),
    ]
    totals = merge_token_usages([step.get("tokenUsage") for step in steps if step.get("tokenUsage") is not None])
    called_without_usage = any(
        step.get("called") is True and step.get("stage") in _MODEL_RUNTIME_STAGES and not step.get("tokenUsage")
        for step in steps
    )
    return {
        "steps": steps,
        "tokenTotals": totals or {},
        "tokenNote": "Token counts are summed from provider usage metadata returned by model APIs."
        if totals
        else "A generator runtime stage was called, but no provider token usage metadata was returned."
        if called_without_usage
        else "No generator model call returned token usage; deterministic chunking/retrieval/reranking stages do not consume LLM tokens.",
    }


def _runtime_provider_label(provider: object) -> str:
    if provider == "azure-openai":
        return "azure-api"
    if provider == "aistudio":
        return "external-agent"
    return str(provider or "mock")


def _has_admitted_model_faq_quality_candidates(
    plan: Mapping[str, Any], schema_markup: Mapping[str, Any], faq_membership: object
) -> bool:
    """Return whether an admitted model FAQ survived rendering for one quality pass.

    Coverage rows marked ``_deterministicCoverage`` are conservative renderer
    recovery, not model-authored public copy.  Do not use their presence to
    invoke the refiner.  Membership is deliberately compared as an internal
    stable ID/evidence sidecar; mutable public Q&A text must not decide whether
    the model gets a refinement pass.
    """

    if clean_text(plan.get("mode")) != "model":
        return False

    def is_faq_page(node: Mapping[str, Any]) -> bool:
        node_type = node.get("@type")
        return node_type == "FAQPage" or isinstance(node_type, list) and "FAQPage" in node_type

    def canonical_rows(value: object) -> list[tuple[str, tuple[str, ...]]] | None:
        rows: list[tuple[str, tuple[str, ...]]] = []
        seen: set[str] = set()
        for raw in as_list(value):
            row = as_dict(raw)
            row_id = clean_text(row.get("id"))
            evidence_ids = tuple(
                dict.fromkeys(clean_text(identifier) for identifier in as_list(row.get("evidenceIds")) if clean_text(identifier))
            )
            if not row_id or row_id in seen or not evidence_ids:
                return None
            seen.add(row_id)
            rows.append((row_id, evidence_ids))
        return rows

    expected = canonical_rows(plan.get("faqMembership"))
    rendered = canonical_rows(faq_membership)
    if not expected or not rendered or expected != rendered:
        return False

    graph = as_list(as_dict(as_dict(schema_markup).get("jsonLd")).get("@graph"))
    rendered_entities = [
        entity
        for raw_node in graph
        if is_faq_page(node := as_dict(raw_node))
        for raw_entity in as_list(node.get("mainEntity"))
        if (entity := as_dict(raw_entity)).get("@type") == "Question"
    ]
    return len(rendered_entities) == len(rendered)


def _can_run_corrective_refinement(runtime: Mapping[str, Any]) -> bool:
    """Whether the quality gate may spend its one corrective refinement pass."""

    if runtime.get("customCopyRefiner") is not None:
        return True
    settings = as_dict(runtime.get("copyRefinement"))
    if settings.get("enabled") is False:
        return False
    provider = str(settings.get("provider") or runtime.get("provider") or "mock")
    api_key = settings.get("apiKey") or runtime.get("apiKey")
    return bool(api_key) and provider not in {"mock", "custom"}


def _should_report_model_gate(runtime: Mapping[str, Any], custom_key: str, settings_key: str) -> bool:
    """Report repeated stage events only for a callable/custom or live model call."""

    if runtime.get(custom_key) is not None:
        return True
    settings = as_dict(runtime.get(settings_key))
    if settings.get("enabled") is False:
        return False
    provider = str(settings.get("provider") or runtime.get("provider") or "mock")
    enabled = settings.get("enabled")
    has_key = bool(settings.get("apiKey") or runtime.get("apiKey"))
    return bool((enabled if isinstance(enabled, bool) else has_key) and provider not in {"mock", "custom"})


generatePdpGeo = generate_pdp_geo
