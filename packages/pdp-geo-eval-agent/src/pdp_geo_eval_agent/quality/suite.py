"""Pure presentation helpers for quality and citation-probe results."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import cast
from urllib.parse import urlparse

from neo_js_compat import js_code_unit_length, js_round


@dataclass(slots=True)
class EasyImprovementItem:
    text: str
    sub_items: list[str] | None = None

    def to_wire(self) -> dict[str, object]:
        result: dict[str, object] = {"text": self.text}
        if self.sub_items is not None:
            result["subItems"] = self.sub_items
        return result


@dataclass(frozen=True, slots=True)
class EvaluationSuiteCopy:
    """Typed presentation copy for one evaluator language."""

    kicker: str
    title: str
    note: str
    quality_block_title: str
    probe_block_title: str
    easy_title: str
    easy_citation_item: Callable[[str], str]
    easy_validation_intro: Callable[[int], str]
    easy_kpc_item: Callable[[int], str]
    citation_tile_sub: Callable[[float, float], str]
    citation_tile_enable_hint: str
    citation_tile_error: str
    citation_detail_label: str
    probe_detail_heading: str
    easy_headline: Callable[[str, str, int], str]
    easy_all_good: str
    easy_empty: str
    dim_friendly: dict[str, str]
    quality_prompt_button: str
    probe_prompt_button: str
    prompt_copied_label: str
    prompt_hint: str
    probe_off_hint: str
    probe_error_title: str
    probe_headline_up: Callable[[float, float, float], str]
    probe_headline_flat: Callable[[float, float], str]
    probe_headline_down: Callable[[float, float, float], str]
    probe_share_explainer: str
    citation_row_label: str
    narrative_method: Callable[[int, str, str], str]
    narrative_why_up: Callable[[str, str, int], str]
    narrative_why_up_no_attribution: Callable[[str], str]
    narrative_why_down: str
    narrative_why_flat: str
    attribution_label: str
    overall_attribution_label: str
    image_attribution_label: str
    overall_image_attribution_label: str
    image_other_label: str
    section_labels: dict[str, str]
    more_sentences: Callable[[int], str]
    probe_subline: Callable[[int, str], str]
    vanilla_label: str
    generated_label: str
    safety_pass_title: str
    safety_fail_title: str
    safety_pass_note: str
    safety_delta_fail: str
    safety_kpc_fail: Callable[[int], str]
    safety_kpr_info: Callable[[int, int], str]
    detail_summary: str
    outcome_labels: dict[str, str]
    query_share: Callable[[float, float], str]
    query_source_labels: dict[str, str]
    warnings_label: str
    interpretation: str


def get_evaluation_suite_copy(language: str) -> EvaluationSuiteCopy:
    if language == "ko":
        return EvaluationSuiteCopy(
            kicker="후속 평가", title="품질 진단 + 인용 테스트",
            note="생성된 산출물을 두 단계로 점검합니다. ① 구조·근거 품질 진단(항상 실행), ② 모의 AI 검색엔진 인용 테스트(설정에서 프로브를 켠 경우). 인용률 예측이 아닌 보수적 진단입니다.",
            quality_block_title="① 품질 진단 · GEO / CEP / E-E-A-T", probe_block_title="② 인용 테스트 · Citation Probe",
            easy_title="무엇을 바꾸면 좋아지나요", easy_citation_item=lambda query: f'[인용] "{query}" 질문에 직접 답하는 문장을 콘텐츠에 추가하세요.',
            easy_validation_intro=lambda count: f"자동 점검이 지목한 문구 {count}건 — 각 항목을 아래 표시된 위치에서 고쳐주세요:",
            easy_kpc_item=lambda count: f"[필수] 상품 근거와 어긋나는 문장 {count}건을 먼저 수정하세요. 게시 전 반드시 확인이 필요합니다.",
            citation_tile_sub=lambda vanilla, generated: f"원본 {vanilla}% → 생성 {generated}%", citation_tile_enable_hint="설정에서 프로브를 켜면 측정됩니다", citation_tile_error="실행되지 않았어요",
            citation_detail_label="인용 테스트 상세", probe_detail_heading="인용 테스트", easy_headline=lambda label, friendly, score: f"{label}({friendly}) 영역이 {score}점으로 가장 낮아요. 아래 항목부터 반영하면 효과가 가장 큽니다.",
            easy_all_good="세 영역 모두 양호해요. 아래 항목을 반영하면 더 안정적입니다.", easy_empty="지금 바로 고쳐야 할 항목이 없습니다.",
            dim_friendly={"geo": "AI가 읽는 구조", "cep": "고객 질문·상황 표현", "eeat": "신뢰 근거 표현"}, quality_prompt_button="LLM 개선 프롬프트 복사", probe_prompt_button="LLM 인용 개선 프롬프트 복사", prompt_copied_label="복사됨",
            prompt_hint="복사한 프롬프트를 Claude Code 같은 LLM에 붙여넣으면, 이 진단을 근거로 한 수정안을 받아 재생성 → 재평가하는 개선 사이클을 돌릴 수 있습니다.", probe_off_hint="설정 → 입력 설정에서 인용 프로브를 켜면, 이 콘텐츠가 AI 답변에서 원본 PDP보다 얼마나 더 인용되는지 함께 측정합니다.", probe_error_title="인용 테스트가 실행되지 않았어요",
            probe_headline_up=lambda vanilla, generated, delta: f"원본 PDP만 있을 때 AI 답변은 우리 상품 정보를 {vanilla}%만 인용했지만, 생성 콘텐츠로 바꾸자 {generated}%를 인용했어요 (+{delta}%p).",
            probe_headline_flat=lambda vanilla, generated: f"원본 PDP와 생성 콘텐츠가 AI 답변에서 비슷한 비중으로 인용됐어요 ({vanilla}% → {generated}%).",
            probe_headline_down=lambda vanilla, generated, delta: f"생성 콘텐츠({generated}%)가 원본 PDP({vanilla}%)보다 AI 답변에서 덜 인용됐어요 ({delta}%p). 아래 프롬프트로 보완하거나 원본 유지를 검토하세요.",
            probe_share_explainer="인용 비중은 AI가 우리 문서 1개와 경쟁 문서 4개를 함께 참고해 답변을 쓸 때, 답변 문장들이 우리 문서를 출처로 인용한 비율이에요. 높을수록 AI 답변에 우리 상품 정보가 더 많이 쓰였다는 뜻입니다.", citation_row_label="AI 답변 인용 비중",
            narrative_method=lambda count, breakdown, engine: f"고객이 물어볼 법한 질문 {count}개({breakdown})를 만들어, 우리 문서 1개와 경쟁 문서 4개를 나란히 준 모의 AI 검색엔진({engine})에게 질문마다 답변을 쓰게 했어요. 같은 조건에서 문서만 원본 PDP ↔ 생성 콘텐츠로 바꿔 두 번씩 테스트했습니다.",
            narrative_why_up=lambda query, section_label, share_pct: f'가장 크게 오른 질문은 "{query}"였어요. 이 답변에서 인용의 {share_pct}%를 {section_label} 섹션이 벌었는데, 질문에 직접 답하는 문장이 그 섹션에 있었기 때문이에요.', narrative_why_up_no_attribution=lambda query: f'가장 크게 오른 질문은 "{query}"였어요. 생성 콘텐츠에 이 질문에 직접 답하는 문장이 있었기 때문이에요.', narrative_why_down="생성 콘텐츠가 질문에 직접 답하지 못한 경우가 많았어요. 아래 'LLM 인용 개선 프롬프트'로 부족한 질문부터 보강하는 것을 권합니다.", narrative_why_flat="두 버전 모두 질문에 비슷한 수준으로 답해서 인용 차이가 나지 않았어요.",
            attribution_label="인용 기여", overall_attribution_label="전체 인용 기여 (어느 섹션이 인용을 벌었나)", image_attribution_label="이미지 기여", overall_image_attribution_label="전체 이미지별 인용 기여 (어느 이미지가 인용을 벌었나)", image_other_label="이미지 근거 없는 인용",
            section_labels={"productName": "상품명", "description": "설명", "productDescription": "상품 설명 (Product)", "webPageDescription": "페이지 설명 (WebPage)", "quickFacts": "핵심 정보", "benefits": "효능", "ingredients": "성분", "howToUse": "사용법", "faq": "FAQ", "other": "기타(미매칭)"},
            more_sentences=lambda count: f" 외 {count}문장", probe_subline=lambda count, engine: f"같은 질문 {count}개와 같은 경쟁 문서를 두고, 원본 PDP와 생성 콘텐츠를 각각 넣어 모의 AI 검색엔진({engine})의 답변 인용을 비교한 결과입니다.", vanilla_label="원본 PDP", generated_label="생성 콘텐츠", safety_pass_title="안전 점검 통과", safety_fail_title="안전 점검 주의", safety_pass_note="인용이 줄지 않았고, 상품 근거와 어긋나는 문장도 발견되지 않았어요.", safety_delta_fail="생성 콘텐츠가 원본보다 덜 인용됐어요.", safety_kpc_fail=lambda count: f"생성 문장 중 상품 근거와 어긋나는 내용이 {count}건 발견됐어요. 게시 전 반드시 해당 문장을 확인하세요.", safety_kpr_info=lambda supported, total: f"상품 근거 {total}개 중 {supported}개가 콘텐츠에 반영됐어요. 요약 콘텐츠 특성상 일부 생략은 정상입니다.", detail_summary="상세 내용", outcome_labels={"improved": "크게 개선", "flat": "비슷함", "worse": "원본이 우세"}, query_share=lambda vanilla, generated: f"원본일 때 {vanilla}% → 생성 후 {generated}% 인용", query_source_labels={"content-plan-faq": "콘텐츠 플랜 FAQ", "content-plan-cep": "콘텐츠 플랜 CEP", "template": "카테고리 템플릿"}, warnings_label="경고", interpretation="모의 엔진 기준, 이 상품 하나에 대한 1회성 비교입니다. 다른 상품·다른 실행과 비교하거나 실제 인용 확률로 해석하지 마세요.",
        )
    return EvaluationSuiteCopy(
        kicker="Follow-up evaluation", title="Quality diagnosis + citation test", note="The output is checked in two stages: (1) structure/evidence quality diagnosis (always on), (2) a simulated-engine citation test (when the probe is enabled in settings). Conservative diagnostics, not citation-rate predictions.", quality_block_title="1. Quality diagnosis · GEO / CEP / E-E-A-T", probe_block_title="2. Citation test · Citation Probe", easy_title="What to change", easy_citation_item=lambda query: f'[Citation] Add sentences that directly answer "{query}".', easy_validation_intro=lambda count: f"Copy flagged by automated checks ({count}) — fix each item where indicated below:", easy_kpc_item=lambda count: f"[Critical] Fix {count} sentence(s) that contradict the product evidence before publishing.", citation_tile_sub=lambda vanilla, generated: f"vanilla {vanilla}% → generated {generated}%", citation_tile_enable_hint="Enable the probe in settings to measure", citation_tile_error="Did not run", citation_detail_label="Citation test detail", probe_detail_heading="Citation test", easy_headline=lambda label, friendly, score: f"{label} ({friendly}) scored lowest at {score}. Applying the items below yields the biggest gains.", easy_all_good="All three areas look healthy. The items below make them even sturdier.", easy_empty="Nothing needs an immediate fix.", dim_friendly={"geo": "structure AI reads", "cep": "customer questions & context", "eeat": "trust & evidence wording"}, quality_prompt_button="Copy LLM improvement prompt", probe_prompt_button="Copy LLM citation prompt", prompt_copied_label="Copied", prompt_hint="Paste the copied prompt into an LLM such as Claude Code to get diagnosis-grounded fixes, then regenerate and re-evaluate — a quality improvement loop.", probe_off_hint="Enable the citation probe in Settings → Input to also measure how much more this content gets cited in AI answers than the vanilla PDP.", probe_error_title="Citation test did not run", probe_headline_up=lambda vanilla, generated, delta: f"With only the vanilla PDP, the AI answer cited our product content just {vanilla}% of the time — after switching to the generated content it cited us {generated}% (+{delta}%p).", probe_headline_flat=lambda vanilla, generated: f"The vanilla PDP and the generated content were cited about equally in the AI answer ({vanilla}% → {generated}%).", probe_headline_down=lambda vanilla, generated, delta: f"The generated content ({generated}%) was cited less than the vanilla PDP ({vanilla}%) in the AI answer ({delta}%p). Consider the prompt below or keeping the original.", probe_share_explainer="Citation share is how much of the AI answer cites our document when the AI writes from our document plus 4 competitor documents. Higher means more of the answer came from our product content.", citation_row_label="AI-answer citation share", narrative_method=lambda count, breakdown, engine: f"We built {count} question(s) customers would actually ask ({breakdown}) and had a simulated AI search engine ({engine}) answer each one from our document plus 4 competitor documents. Under identical conditions, only the document was swapped: vanilla PDP vs generated content.", narrative_why_up=lambda query, section_label, share_pct: f'The biggest gain came on "{query}". The {section_label} section earned {share_pct}% of the citations in that answer, because it contained sentences that directly answer the question.', narrative_why_up_no_attribution=lambda query: f'The biggest gain came on "{query}", because the generated content contains sentences that directly answer it.', narrative_why_down="The generated content often failed to answer the questions directly. Use the citation-improvement prompt below, starting with the weakest questions.", narrative_why_flat="Both versions answered the questions about equally well, so citations did not shift.", attribution_label="Citation contribution", overall_attribution_label="Overall contribution (which section earned the citations)", image_attribution_label="Image contribution", overall_image_attribution_label="Overall image contribution (which image earned the citations)", image_other_label="citations without image lineage", section_labels={"productName": "Product name", "description": "Description", "productDescription": "Product description", "webPageDescription": "WebPage description", "quickFacts": "Quick facts", "benefits": "Benefits", "ingredients": "Ingredients", "howToUse": "How to use", "faq": "FAQ", "other": "other (unmatched)"}, more_sentences=lambda count: f" +{count} more", probe_subline=lambda count, engine: f"Result of testing the vanilla PDP and the generated content against the same {count} question(s) and identical competitor documents on a simulated AI search engine ({engine}).", vanilla_label="Vanilla PDP", generated_label="Generated content", safety_pass_title="Safety check passed", safety_fail_title="Safety check — attention", safety_pass_note="Citations did not drop and no sentence contradicts the product evidence.", safety_delta_fail="The generated content was cited less than the original.", safety_kpc_fail=lambda count: f"{count} generated sentence(s) contradict the product evidence. Review them before publishing.", safety_kpr_info=lambda supported, total: f"{supported} of {total} evidence items are reflected in the content. Some omission is normal for summary copy.", detail_summary="Details", outcome_labels={"improved": "Much improved", "flat": "About the same", "worse": "Original wins"}, query_share=lambda vanilla, generated: f"cited {vanilla}% with vanilla → {generated}% with generated", query_source_labels={"content-plan-faq": "content-plan FAQ", "content-plan-cep": "content-plan CEP", "template": "category template"}, warnings_label="Warnings", interpretation="One-shot comparison for this product on a simulated engine. Never compare across products or runs, and never read it as a production citation probability.",
    )


def share_to_pct(value: float) -> int:
    return int(js_round(value * 100))


def format_pct_delta(value: float) -> str:
    percentage = share_to_pct(value)
    return f"{'+' if percentage > 0 else ''}{percentage}%p"


def probe_query_outcome(delta_wordpos: float) -> str:
    if delta_wordpos > 0.05:
        return "improved"
    if delta_wordpos < -0.05:
        return "worse"
    return "flat"


def build_easy_improvement_summary(evaluation: object, suite: EvaluationSuiteCopy, validation_pointer_prefix: str) -> dict[str, object]:
    dimensions = sorted(_objects(_field(evaluation, "dimensions", [])), key=lambda dimension: _integer(_field(dimension, "score", 0)))
    items: list[EasyImprovementItem] = []
    for dimension in dimensions:
        for improvement in _strings(_field(dimension, "improvements", [])):
            if len(items) >= 3:
                break
            if validation_pointer_prefix and improvement.startswith(validation_pointer_prefix):
                details = _strings(_field(evaluation, "validation_details", _field(evaluation, "validationDetails", [])))
                if not any(item.sub_items is not None for item in items) and details:
                    items.append(EasyImprovementItem(f"[{_string(_field(dimension, 'label'))}] {suite.easy_validation_intro(len(details))}", details[:3]))
                continue
            line = f"[{_string(_field(dimension, 'label'))}] {improvement}"
            if not any(item.text == line for item in items):
                items.append(EasyImprovementItem(line))
    lowest = dimensions[0] if dimensions else None
    headline = suite.easy_headline(_string(_field(lowest, "label")), suite.dim_friendly.get(_string(_field(lowest, "id")), ""), _integer(_field(lowest, "score"))) if lowest is not None and _integer(_field(lowest, "score", 0)) < 90 else suite.easy_all_good
    return {"headline": headline, "items": items}


def build_probe_safety_notes(probe: object, suite: EvaluationSuiteCopy) -> list[str]:
    notes: list[str] = []
    mean_delta = _field(_field(probe, "mean", {}), "delta", {})
    if _number(_field(mean_delta, "wordpos", 0)) < 0:
        notes.append(suite.safety_delta_fail)
    coverage = _field(probe, "keypoint_coverage", _field(probe, "keypointCoverage"))
    if coverage is not None:
        contradicted = _integer(_field(coverage, "contradicted", 0))
        if contradicted > 0:
            notes.append(suite.safety_kpc_fail(contradicted))
        notes.append(suite.safety_kpr_info(_integer(_field(coverage, "supported")), _integer(_field(coverage, "total"))))
    gate = _field(probe, "gate", {})
    passed = _boolean(_field(gate, "pass_", _field(gate, "pass", False)))
    if passed:
        notes.insert(0, suite.safety_pass_note)
    return notes


def format_query_source_breakdown(probe: object, suite: EvaluationSuiteCopy) -> str:
    counts: dict[str, int] = {}
    for query in _objects(_field(probe, "queries", [])):
        source = _string(_field(query, "query_source", _field(query, "querySource")))
        counts[source] = counts.get(source, 0) + 1
    return " · ".join(f"{suite.query_source_labels.get(source, source)} {count}" for source, count in counts.items())


def build_probe_narrative_why(probe: object, suite: EvaluationSuiteCopy, delta_pct: int) -> str:
    if delta_pct < 0:
        return suite.narrative_why_down
    if delta_pct == 0:
        return suite.narrative_why_flat
    queries = sorted(_objects(_field(probe, "queries", [])), key=lambda query: _number(_field(_field(query, "delta", {}), "wordpos", 0)), reverse=True)
    if not queries:
        return suite.narrative_why_flat
    best_query = queries[0]
    attribution = _objects(_field(best_query, "section_attribution", _field(best_query, "sectionAttribution", [])))
    top_section = next((item for item in attribution if _string(_field(item, "section_id", _field(item, "sectionId"))) != "other"), None)
    if top_section is not None and _number(_field(top_section, "share", 0)) >= 0.2:
        identifier = _string(_field(top_section, "section_id", _field(top_section, "sectionId")))
        return suite.narrative_why_up(_string(_field(best_query, "query")), suite.section_labels.get(identifier, identifier), share_to_pct(_number(_field(top_section, "share"))))
    return suite.narrative_why_up_no_attribution(_string(_field(best_query, "query")))


def truncate_quote(value: str, maximum: int = 110) -> str:
    trimmed = value.strip()
    return trimmed if js_code_unit_length(trimmed) <= maximum else f"{_slice_utf16_units(trimmed, maximum - 1).rstrip()}…"


def _slice_utf16_units(value: str, end: int) -> str:
    """Mirror JavaScript ``value.slice(0, end)`` over UTF-16 code units."""
    return value.encode("utf-16-le", "surrogatepass")[: max(0, end) * 2].decode("utf-16-le", "surrogatepass")


def format_section_attribution(attribution: Sequence[object], suite: EvaluationSuiteCopy, format_id: Callable[[str], str] | None = None) -> str:
    formatter: Callable[[str], str] = format_id or (lambda identifier: suite.section_labels.get(identifier, identifier))
    return " · ".join(
        f"{formatter(_string(_field(item, 'section_id', _field(item, 'sectionId'))))} {share_to_pct(_number(_field(item, 'share')))}%"
        for item in [item for item in attribution if _number(_field(item, "share", 0)) >= 0.05][:3]
    )


def format_image_section_id(identifier: str, suite: EvaluationSuiteCopy) -> str:
    if identifier == "other":
        return suite.image_other_label
    try:
        pathname = urlparse(identifier).path if urlparse(identifier).scheme else urlparse(identifier, scheme="https").path
        basename = next((part for part in reversed(pathname.split("/")) if part), "")
        return basename or identifier
    except Exception:
        return identifier


def _field(value: object, name: str, default: object = None) -> object:
    if isinstance(value, Mapping):
        return cast(Mapping[str, object], value).get(name, default)
    return getattr(value, name, default)


def _objects(value: object) -> list[object]:
    return list(cast(list[object], value)) if isinstance(value, list) else []


def _strings(value: object) -> list[str]:
    return [item for item in _objects(value) if isinstance(item, str)]


def _string(value: object) -> str:
    return value if isinstance(value, str) else ""


def _number(value: object) -> float:
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else 0.0


def _integer(value: object) -> int:
    return int(_number(value))


def _boolean(value: object) -> bool:
    return value is True
