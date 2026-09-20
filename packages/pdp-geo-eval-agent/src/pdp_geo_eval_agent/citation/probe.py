"""Inline paired citation-probe helpers."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import cast

from neo_js_compat import js_code_unit_length, js_round

from ..models import CitationVisibilityScore, KeypointCoverageScore
from .engine import generate_engine_answer, geo_eval_engine_id
from .metrics import attribute_citations_to_sections, score_citation_visibility
from .utility import PDP_COPY_UTILITY_GATE_THRESHOLDS, evaluate_utility_gate, judge_keypoint_coverage

GEO_EVAL_TARGET_SLOT = 2
CITATION_PROBE_INTERPRETATION = (
    "Paired one-shot diagnostic for this product only: generated vs vanilla PDP text competing on identical "
    "queries, distractors, and engine. Not a production citation-probability estimate and not comparable across "
    "products or runs."
)


@dataclass(slots=True)
class CitationProbeQuery:
    query: str
    source: str

    def to_wire(self) -> dict[str, str]:
        return {"query": self.query, "source": self.source}


@dataclass(slots=True)
class _AttributionBucket:
    weight: float
    count: int
    sentences: list[str]


def build_generated_source_text(sections: object) -> str:
    """Flatten public-content sections in evaluator source order."""
    values = [
        _field(sections, "productName", "product_name"),
        _field(sections, "description"),
        _field(sections, "quickFacts", "quick_facts"),
        _field(sections, "benefits"),
        _field(sections, "ingredients"),
        _field(sections, "howToUse", "how_to_use"),
        _field(sections, "faq"),
    ]
    return "\n\n".join(value for value in values if isinstance(value, str) and value.strip())


def derive_probe_queries(context: object, max_queries: int) -> list[CitationProbeQuery]:
    """Derive customer questions with the legacy FAQ → CEP → template priority."""
    locale = _as_string(_field(context, "locale"))
    korean = _is_korean(locale)
    category = _as_string(_field(context, "category")).strip() or ("제품" if korean else "product")
    queries: list[CitationProbeQuery] = []
    seen: set[str] = set()

    def push(query: str, source: str) -> None:
        trimmed = query.strip()
        key = trimmed.lower()
        if js_code_unit_length(trimmed) >= 8 and key not in seen and len(queries) < max_queries:
            seen.add(key)
            queries.append(CitationProbeQuery(query=trimmed, source=source))

    content_plan = _field(context, "contentPlan", "content_plan")
    faq = _field(content_plan, "faq") if content_plan is not None else None
    for item in _sequence(faq):
        if _field(item, "include") is True:
            question = _as_string(_field(item, "question"))
            if question.strip():
                push(question, "content-plan-faq")

    cep = _field(content_plan, "cep") if content_plan is not None else None
    for item in _sequence(cep):
        need = _as_string(_field(item, "need")).strip()
        if not need:
            continue
        situation = _as_string(_field(item, "situation")).strip()
        if korean:
            query = f"{need}에 도움이 되는 {category} 추천해주세요.{f' ({situation})' if situation else ''}"
        else:
            query = f"Which {category} helps with {need}{f' ({situation})' if situation else ''}?"
        push(query, "content-plan-cep")

    benefits = _sequence(_field(context, "benefits"))
    benefit = next((value.strip() for value in benefits if isinstance(value, str) and value.strip()), "")
    templates = (
        [
            f"{benefit}에 좋은 {category}는 어떤 게 있나요?" if benefit else f"어떤 {category}를 골라야 하나요?",
            f"{category}는 스킨케어 순서에서 언제 어떻게 사용하는 게 좋나요?",
            f"{category}를 고를 때 성분이나 제형에서 뭘 확인해야 하나요?",
        ]
        if korean
        else [
            f"What {category} is good for {benefit}?" if benefit else f"How do I choose a good {category}?",
            f"How and when should I use a {category} in my routine?",
            f"What should I check when choosing a {category}?",
        ]
    )
    for template in templates:
        push(template, "template")
    return queries


def build_probe_distractors(locale: str, category: str | None = None) -> list[str]:
    """Return the fixed locale/category competitor documents for an inline probe."""
    korean = _is_korean(locale)
    item = category.strip() if isinstance(category, str) and category.strip() else ("제품" if korean else "product")
    if korean:
        return [
            f"{item} 고르는 법 총정리. 같은 {item}(이)라도 피부 타입과 사용 상황에 따라 만족도가 크게 갈립니다. 먼저 자신의 주요 고민을 한 가지로 정리하고, 그 고민에 맞는 핵심 성분이 충분히 들어 있는지 전성분표에서 확인하세요. 사용감은 리뷰보다 샘플이나 소용량으로 직접 확인하는 것이 정확합니다. 어떤 {item}(이)든 최소 2주 이상 꾸준히 사용해 보고 판단하는 것이 좋으며, 새 제품은 팔 안쪽에 패치 테스트 후 얼굴에 사용하는 편이 안전합니다.",
            f"루미필드 데일리 {item}. 판테놀과 마데카소사이드, 저분자 히알루론산을 담아 데일리 사용에 부담이 없습니다. 피부과 테스트 완료, 민감성 피부 사용 가능. 아침저녁 세안 후 적당량을 부드럽게 흡수시켜 주세요. 무향, 무색소. 루미필드 — 매일의 피부 습관을 만드는 브랜드.",
            f"{item} 특가 — 재고 있음, 오늘 주문 시 내일 도착. 상품 정보: 국내 정식 수입, 사용 부위 얼굴. 함께 많이 구매한 상품: 화장솜, 수분 크림, 선크림. 포토 리뷰 작성 시 적립금 지급. 교환/반품은 미개봉 상품에 한해 7일 이내 가능합니다. 판매자 공지: 배송 지역에 따라 1-2일 지연될 수 있습니다.",
            f"커뮤니티 글: {item} 뭐 쓰는지 궁금해요. 요즘 쓰던 게 단종돼서 갈아탈 곳을 찾는 중입니다. 댓글 1: 저는 성분 단순한 걸로 정착했어요, 이것저것 많이 든 건 오히려 안 맞더라고요. 댓글 2: 유튜버 추천템 사봤는데 저한테는 별로였어요. 결국 직접 써봐야 압니다. 댓글 3: 세일 기간에 소용량부터 사보세요. 댓글 4: 저자극이라고 광고해도 전성분은 꼭 확인하세요.",
        ]
    return [
        f"How to choose a {item} that actually works for you. Start by narrowing your main concern to one thing, then check the ingredient list for actives that address it at a meaningful position. Texture preferences matter more than marketing: try a sample or travel size before committing. Give any {item} at least two weeks of consistent use before judging results, and patch test new formulas on your inner arm first.",
        f"NovaField Daily {item}. A gentle daily formula with panthenol, madecassoside, and low-molecular hyaluronic acid. Dermatologist tested, suitable for sensitive skin. Apply morning and evening after cleansing. Fragrance-free, no added colorants. NovaField — everyday skin habits, simplified.",
        f"{item} — In stock, ships in 1-2 business days. Product details: for facial use, imported, authenticity guaranteed by the marketplace seller program. Frequently bought together: cotton pads, moisturizer, sunscreen. Write a photo review for reward points. Returns accepted within 7 days for unopened items only.",
        f"Forum thread: What {item} is everyone using? Mine got discontinued and I need a replacement. Reply 1: I settled on something with a short ingredient list — the kitchen-sink formulas broke me out. Reply 2: Bought an influencer pick and it did nothing for me, you really have to test yourself. Reply 3: Grab a mini size during sales before buying full size. Reply 4: \"Gentle\" on the label means nothing, read the full ingredient list.",
    ]


async def run_citation_probe(context: object, options: object) -> dict[str, object]:
    """Run the paired vanilla/generated citation diagnostic.

    Individual query failures degrade to warnings; only total failure rejects
    the probe, matching the TypeScript UI contract.
    """
    warnings: list[str] = []
    max_queries = max(1, _as_number(_field(options, "maxQueries", "max_queries"), 3))
    probe_queries = _resolve_probe_queries(context, max_queries, warnings)
    if not probe_queries:
        raise RuntimeError("Citation probe could not derive any customer query for this product.")
    generated_text = _as_string(_field(context, "generatedText", "generated_text"))
    vanilla_text = _as_string(_field(context, "vanillaText", "vanilla_text"))
    if not generated_text.strip() or not vanilla_text.strip():
        raise RuntimeError("Citation probe requires non-empty generated and vanilla texts.")
    locale = _as_string(_field(context, "locale"))
    category = _field(context, "category")
    distractors = build_probe_distractors(locale, category if isinstance(category, str) else None)
    vanilla_sources = _insert_target(distractors, vanilla_text)
    generated_sources = _insert_target(distractors, generated_text)
    engine = _mapping_or_none(_field(options, "engine"))
    if engine is None:
        raise ValueError("Citation probe requires an engine config.")

    async def run_query(probe_query: CitationProbeQuery) -> dict[str, object] | None:
        try:
            vanilla_answer, generated_answer = await asyncio.gather(
                generate_engine_answer(engine, probe_query.query, vanilla_sources),
                generate_engine_answer(engine, probe_query.query, generated_sources),
            )
            vanilla = score_citation_visibility(_as_string(_field(vanilla_answer, "answer")), len(vanilla_sources), GEO_EVAL_TARGET_SLOT)
            generated = score_citation_visibility(_as_string(_field(generated_answer, "answer")), len(generated_sources), GEO_EVAL_TARGET_SLOT)
            generated_sections = _sequence(_field(context, "generatedSections", "generated_sections"))
            image_sections = _sequence(_field(context, "imageSections", "image_sections"))
            section_attribution = attribute_citations_to_sections(_as_string(_field(generated_answer, "answer")), GEO_EVAL_TARGET_SLOT, generated_sections) if generated_sections else None
            image_attribution = attribute_citations_to_sections(_as_string(_field(generated_answer, "answer")), GEO_EVAL_TARGET_SLOT, image_sections) if image_sections else None
            result: dict[str, object] = {
                "query": probe_query.query,
                "querySource": probe_query.source,
                "vanilla": _to_share(vanilla),
                "generated": _to_share(generated),
                "delta": {"wordpos": _round(generated.wordpos - vanilla.wordpos), "word": _round(generated.word - vanilla.word), "pos": _round(generated.pos - vanilla.pos)},
                "hallucinatedCitations": sorted(set([*vanilla.shares.hallucinated_citations, *generated.shares.hallucinated_citations])),
            }
            if section_attribution:
                result["sectionAttribution"] = [item.to_wire() for item in section_attribution]
            if image_attribution:
                result["imageAttribution"] = [item.to_wire() for item in image_attribution]
            return result
        except Exception as error:
            warnings.append(f'Query "{probe_query.query}" failed: {error}')
            return None

    settled = await asyncio.gather(*(run_query(query) for query in probe_queries))
    query_results = [result for result in settled if result is not None]
    if not query_results:
        raise RuntimeError(f"Citation probe failed for every query. {' / '.join(warnings)}")
    keypoint_coverage: KeypointCoverageScore | None = None
    if _field(options, "includeUtility", "include_utility") is True:
        ledger = _records(_field(context, "evidenceLedger", "evidence_ledger"))
        if not ledger:
            warnings.append("Utility judge skipped: evidence ledger is empty.")
        else:
            try:
                # TypeScript uses ``options.judge ?? options.engine``: an
                # explicitly supplied empty object remains the judge config.
                configured_judge = _field(options, "judge")
                judge = engine if configured_judge is None else _mapping(configured_judge)
                judge_result = await judge_keypoint_coverage(judge, ledger, generated_text)
                score = judge_result["score"]
                if isinstance(score, KeypointCoverageScore):
                    keypoint_coverage = score
            except Exception as error:
                warnings.append(f"Keypoint-coverage judge failed: {error}")
    mean = {
        "vanilla": _mean_share([result["vanilla"] for result in query_results]),
        "generated": _mean_share([result["generated"] for result in query_results]),
        "delta": _mean_share([result["delta"] for result in query_results]),
    }
    gate = evaluate_utility_gate({"visibilityDelta": mean["delta"]["wordpos"], "keypointCoverage": keypoint_coverage}, PDP_COPY_UTILITY_GATE_THRESHOLDS)
    result: dict[str, object] = {
        "engineId": geo_eval_engine_id(engine),
        "probedAt": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "queries": query_results,
        "mean": mean,
        "gate": gate.to_wire(),
        "warnings": warnings,
        "interpretation": CITATION_PROBE_INTERPRETATION,
    }
    if keypoint_coverage is not None:
        result["keypointCoverage"] = keypoint_coverage.to_wire()
    section_attribution = _combine_attributions(query_results, "sectionAttribution")
    image_attribution = _combine_attributions(query_results, "imageAttribution")
    if section_attribution is not None:
        result["sectionAttribution"] = section_attribution
    if image_attribution is not None:
        result["imageAttribution"] = image_attribution
    return result


def _is_korean(locale: str) -> bool:
    return locale.lower().startswith("ko")


def _sequence(value: object) -> Sequence[object]:
    return cast(Sequence[object], value) if isinstance(value, Sequence) and not isinstance(value, str) else []


def _as_string(value: object) -> str:
    return value if isinstance(value, str) else ""


def _mapping(value: object) -> Mapping[str, object]:
    return _mapping_or_none(value) or {}


def _mapping_or_none(value: object) -> Mapping[str, object] | None:
    if not isinstance(value, Mapping):
        return None
    mapping = cast(Mapping[object, object], value)
    return cast(Mapping[str, object], mapping) if all(isinstance(key, str) for key in mapping) else None


def _records(value: object) -> list[Mapping[str, object]]:
    return [record for item in _sequence(value) if (record := _mapping_or_none(item)) is not None]


def _field(value: object, *names: str) -> object:
    for name in names:
        if isinstance(value, Mapping) and name in value:
            return cast(Mapping[str, object], value).get(name)
        if not isinstance(value, Mapping) and hasattr(value, name):
            return getattr(value, name)
    return None


def _round(value: float) -> float:
    return js_round(value * 1000) / 1000


def _resolve_probe_queries(context: object, max_queries: int, warnings: list[str]) -> list[CitationProbeQuery]:
    explicit = _sequence(_field(context, "queries"))
    if explicit:
        return [CitationProbeQuery(query=query, source="template") for query in explicit[:max_queries] if isinstance(query, str)]
    derived = derive_probe_queries(context, max_queries)
    if derived and all(query.source == "template" for query in derived):
        warnings.append("No content-plan FAQ/CEP queries available; probe used generic category templates.")
    return derived


def _insert_target(distractors: Sequence[str], target_text: str) -> list[str]:
    sources = list(distractors)
    sources.insert(GEO_EVAL_TARGET_SLOT, target_text)
    return sources


def _to_share(score: CitationVisibilityScore) -> dict[str, float]:
    return {"wordpos": _round(score.wordpos), "word": _round(score.word), "pos": _round(score.pos)}


def _mean_share(shares: Sequence[object]) -> dict[str, float]:
    count = max(1, len(shares))
    return {key: _round(sum(_as_float(_mapping(share).get(key)) for share in shares) / count) for key in ("wordpos", "word", "pos")}


def _combine_attributions(query_results: Sequence[Mapping[str, object]], key: str) -> list[dict[str, object]] | None:
    attributed = [result for result in query_results if _records(result.get(key))]
    if not attributed:
        return None
    buckets: dict[str, _AttributionBucket] = {}
    total_weight = 0
    for result in attributed:
        attribution = _records(result.get(key))
        query_weight = sum(_as_number(item.get("citedSentences"), 0) for item in attribution)
        for item in attribution:
            identifier = _as_string(item.get("sectionId"))
            bucket = buckets.setdefault(identifier, _AttributionBucket(weight=0.0, count=0, sentences=[]))
            bucket.weight += _as_float(item.get("share")) * query_weight
            bucket.count += _as_number(item.get("citedSentences"), 0)
            for sentence in _sequence(item.get("sentences")):
                if isinstance(sentence, str) and len(bucket.sentences) < 4 and sentence not in bucket.sentences:
                    bucket.sentences.append(sentence)
        total_weight += query_weight
    if total_weight == 0:
        return None
    return sorted(
        [{"sectionId": identifier, "share": _round(bucket.weight / total_weight), "citedSentences": bucket.count, "sentences": bucket.sentences} for identifier, bucket in buckets.items()],
        key=lambda item: _as_float(item["share"]), reverse=True,
    )


def _as_number(value: object, default: int) -> int:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else default


def _as_float(value: object) -> float:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0.0
