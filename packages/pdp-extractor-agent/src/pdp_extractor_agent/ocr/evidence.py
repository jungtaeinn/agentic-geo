"""Public OCR evidence assembly and provider-independent diagnostics."""

from __future__ import annotations

import inspect
import re
from collections.abc import Iterable, Mapping, Sequence
from datetime import UTC, datetime
from typing import Any, cast
from urllib.parse import urlparse

from .._json_types import as_list, as_mapping
from ..providers import create_keyword_classifier
from ..rag.retrieval import create_product_extractor_rag_query, retrieve_product_extractor_rag_documents_with_runtime
from .blocks import (
    is_ocr_safety_or_caution_value,
    normalize_ocr_comparison_text,
    parse_ocr_block_sections,
    section_heading_category,
    segment_item_sentences,
)
from .layout import parse_image_ocr_payload_text
from .metrics import metric_claims_from_ocr_layout
from .pipeline import (
    combine_ocr_candidates,
    join_slice_candidates,
    layout_field_facts,
    reconcile_ocr_readings,
    split_numbered_usage_steps,
)
from .relations import verify_ocr_layout_groups
from .slicing import prepare_image_ocr_inputs, strip_slice_fragment

_CATEGORIES = (
    "product",
    "price",
    "benefit",
    "effect",
    "ingredient",
    "usage",
    "faq",
    "review",
    "metric",
    "trend",
    "unknown",
)
_HEURISTIC_KEYWORDS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("product", re.compile(r"serum|cream|essence|ampoule|toner|lotion|cleanser|mask|선크림|세럼|크림|에센스|앰플|토너|로션|마스크", re.I)),
    ("price", re.compile(r"(?:\$|₩)\s*[\d,.]+|[\d,]+\s*원|price|sale|discount|가격|할인", re.I)),
    ("ingredient", re.compile(r"ginseng|retinol|niacinamide|peptide|hyaluronic|ceramide|collagen|panax|vitamin|성분|원료|BotanicalComplex|인삼|레티놀|나이아신아마이드|펩타이드|히알루론산|세라마이드|콜라겐|비타민", re.I)),
    ("benefit", re.compile(r"보습|수분|진정|탄력|장벽|광채|영양|고밀도|자생력|hydration|moisture|moisturizing|soothing|brightening|firming|anti-aging|radiance|elasticity|resilience|plumpness", re.I)),
    ("effect", re.compile(r"효과|개선|완화|케어|주름|잔주름|피부결|리프팅|effect|improve|improved|improvement|care|reduce|diminish|diminished|fine lines|wrinkles|texture|even|elastic|firmer|lift|lifting|firmness", re.I)),
    ("usage", re.compile(r"use|apply|morning|night|ritual|pump|face|neck|사용|도포|아침|저녁|루틴|펌프|얼굴|목", re.I)),
    ("faq", re.compile(r"\?|faq|question|answer|what are|how does|can i|자주|질문|답변", re.I)),
    ("review", re.compile(r"촉촉|흡수|만족|재구매|가벼운|산뜻|review|rating|customer|smooth|satisfied|repurchase|stars", re.I)),
    ("metric", re.compile(r"\b\d+(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?\s?(?:ml|mL|oz|fl\.?\s?oz|weeks?|days?|hours?|stars?|drops?|pumps?|times?|점|개|명|회|주|일|시간|퍼센트)\b", re.I)),
)
_LOCAL_COMMERCE_TEXT = re.compile(
    r"cart|checkout|shipping|returns?|refund|subscribe|newsletter|discount|coupon|sale|"
    r"장바구니|구매하기|배송|교환|반품|환불|쿠폰|할인|적립|혜택 적용가",
    re.I,
)
_LOCAL_BENEFIT_VALUE = re.compile(
    r"보습|수분|진정|탄력|장벽|광채|영양|고밀도|자생력|피부|hydration|moisture|"
    r"moisturizing|soothing|brightening|barrier|firming|firmness|radiance|elasticity|resilience|plumpness",
    re.I,
)
_LOCAL_EFFECT_VALUE = re.compile(
    r"주름|잔주름|피부결|리프팅|탄력|개선|완화|효과|firmness|firmer|elastic|texture|"
    r"even|wrinkles?|fine lines|lift|improve|improved|reduce|diminish|diminished",
    re.I,
)
_LOCAL_INGREDIENT_VALUE = re.compile(
    r"인삼|레티놀|나이아신아마이드|펩타이드|히알루론산|세라마이드|콜라겐|비타민|성분|"
    r"ginseng|panax|retinol|niacinamide|peptide|hyaluronic|ceramide|collagen|vitamin|"
    r"water|aqua|glycerin|extract",
    re.I,
)
_LOCAL_USAGE_VALUE = re.compile(
    r"how to use|directions?|\b(?:apply|dispense|smooth|press|massage|rinse|pat|spread|lather|spray|spritz)\b|"
    r"\buse\s+(?:morning|night|daily|twice|once|after|before|with|on|to)\b|"
    r"사용법|사용 방법|사용방법|적당량|덜어|펴\s*발|바르|바릅|문지르|펌프(?:하여|해|합니다|하세요)|눌러|두드려|흡수시켜|흡수시킵|"
    r"분사|뿌려|스프레이",
    re.I,
)
_LOCAL_METRIC_VALUE = re.compile(
    r"\b\d+(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?\s?"
    r"(?:ml|mL|oz|fl\.?\s?oz|weeks?|days?|hours?|stars?|drops?|pumps?|times?)\b|"
    r"\b\d+(?:\.\d+)?\s?(?:점|개|명|회|주|일|시간|퍼센트)\b",
    re.I,
)
_LOCAL_SKIN_TYPE_VALUE = re.compile(
    r"\b(?:all|normal|dry|oily|combination|sensitive|acne[-\s]?prone|mature|dehydrated|balanced|"
    r"blemish[-\s]?prone)\s+skin(?:\s+types?)?\b|"
    r"(?<![가-힣])(?:건성|건조(?:한)?|민감(?:한|성)?|복합(?:성)?|지성|중성|여드름성|트러블성|모든)\s*"
    r"피부(?:\s*타입)?(?=$|[\s,，;；:：.!?。！？/&]|(?:에|은|는|이|가|도|를|을|와|과|및|또는))",
    re.I,
)
_LOCAL_AUDIENCE_CUE = re.compile(
    r"\b(?:recommended|suitable|ideal|works?\s+best|best|made|designed|formulated|for)\b|"
    r"추천|권장|적합|사용\s*대상|대상\s*피부|피부\s*타입",
    re.I,
)
_LOCAL_AUDIENCE_ONLY_FILLER = re.compile(
    r"\b(?:recommended|suitable|ideal|works?\s+best|best|made|designed|formulated|for|skin\s*types?|"
    r"and|or)\b|추천(?:됩니다|되며|합니다|한다)?|권장(?:됩니다|되며|합니다|한다)?|"
    r"적합(?:합니다|한)?|사용\s*대상|대상\s*피부|피부\s*타입|또는|및|와|과|에|에게",
    re.I,
)
_LOCAL_DANGLING_KOREAN_CLAUSE = re.compile(r"(?:하고|하며|이고|이며|거나|면서|도록|는데|해서|하여|해)$")
_LOCAL_ENGLISH_SAFETY_PANEL_ITEM_START = re.compile(
    r"\b(?:hypersensitive\s+skin|sensitive\s+skin(?:\s+panel)?|dermatologist(?:ically)?|"
    r"allerg(?:y|en)|non[-\s]?comedogenic|hypoallergenic|irritation|patch)\s+"
    r"(?:test(?:ed|ing)?|assessment|check)\b",
    re.I,
)
_LOCAL_KOREAN_SAFETY_PANEL_ITEM_START = re.compile(
    r"(?:민감\s*피부\s*자극|피부과|알레르기|알러지|여드름성\s*피부\s*사용\s*적합|논코메도제닉|"
    r"저자극|패치|첩포)\s*(?:테스트|시험|검사|평가)",
    re.I,
)
_EVIDENCE_HARD_COMMERCE = re.compile(
    r"레이어\s*(?:열기|닫기)|장바구니|구매하기|바로구매|제품 수량|상품 수량|수량 감소|수량 증가|총 상품가|"
    r"혜택 적용가|네이버페이|뷰티포인트|적립 제외|사용 제외|재입고|알림 신청|레이어 닫기|판매자 정보|"
    r"상품정보제공 고시|배송/교환/반품|배송지역|배송기간|배송비|교환/반품|반품/교환|청약철회|고객센터|"
    r"택배기사|회수 상품|반송 주소|구매안전서비스|에스크로|KG이니시스|무료배송|첫 구매 혜택|혜택보기|"
    r"cart|checkout|shipping|returns?|refund|subscribe|newsletter",
    re.I,
)
_EVIDENCE_POLICY_COMMERCE = re.compile(
    r"배송|교환|반품|환불|주문취소|청약철회|고객변심|택배|반송|회수|미성년자|법정대리인|이용약관|"
    r"도서지역|사서함|배송비|판매자|고시",
    re.I,
)
_EVIDENCE_PRODUCT_CARE = re.compile(
    r"피부|보습|수분|탄력|장벽|광채|영양|진정|주름|잔주름|피부결|고밀도|자생력|인삼|레티놀|"
    r"나이아신아마이드|펩타이드|히알루론산|세라마이드|콜라겐|비타민|성분|효능|효과|사용법|도포|"
    r"세럼|크림|에센스|앰플|토너|로션|serum|cream|essence|ampoule|skin|hydration|moisture|"
    r"firming|firmness|firmer|elastic|radiance|resilience|plumpness|wrinkle|ingredient|retinol|"
    r"niacinamide|peptide|hyaluronic|apply",
    re.I,
)
_EVIDENCE_STRONG_PRODUCT_CARE = re.compile(
    r"피부|보습|수분|탄력|장벽|광채|주름|피부결|인삼|레티놀|나이아신아마이드|펩타이드|효능|"
    r"효과|사용법|도포|hydration|firming|wrinkle|ingredient|retinol|niacinamide|apply",
    re.I,
)
_EVIDENCE_REVIEW = re.compile(
    r"리뷰|후기|평점|별점|재구매|만족|흡수|촉촉|review|rating|stars?|repurchase|satisfied|smooth|customer",
    re.I,
)
_EVIDENCE_FAQ = re.compile(r"\?|FAQ|Q&A|자주|질문|답변", re.I)
_EVIDENCE_METRIC = re.compile(
    r"\b\d+(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?\s?(?:weeks?|days?|hours?|drops?|pumps?|times?)\b|주|일|시간|회",
    re.I,
)
_LOCAL_DECLARATIVE_BENEFIT_PREDICATE = re.compile(
    r"^(?:(?:[a-z][a-z'-]*ly)\s+){0,2}(?:(?:is|are|was|were|has|have|had|can|could|will|would|may|might)\b|"
    r"(?:[a-z][a-z'-]{2,}(?:s|es|ies|ed))\b)\s+\S",
    re.I,
)
_LOCAL_NON_BENEFIT_DECLARATIVE_PREDICATE = re.compile(
    r"^(?:is|are|was|were|has|have|had|contains?|includes?|features?|comes?|costs?|priced|available|ships?|"
    r"sells?|weighs?|measures?|looks?|appears?|called|named|made|designed)\b",
    re.I,
)
_LOCAL_NEGATIVE_OR_ADVERSE_CLAUSE = re.compile(
    r"\b(?:does\s+not|doesn't|do\s+not|cannot|can't|lacks?|fails?\s+to|causes?|triggers?|irritates?|"
    r"harms?|damages?|worsens?|aggravates?)\b|(?:않(?:습니다|아요|는다)?|못\s|부작용|자극(?:을|이)?\s*(?:유발|발생)|악화|손상)",
    re.I,
)
_LOCAL_SUITABILITY_CONTEXT = re.compile(
    r"\b(?:determine|decide|find\s+out)\s+whether\b|\bright\s+for\s+you\b|"
    r"(?:나에게|본인에게)\s*(?:맞는지|적합한지)",
    re.I,
)
_LOCAL_REVIEW_CONTEXT = re.compile(
    r"\b(?:reviews?|customers?|ratings?|rated|stars?|verified\s+(?:buyer|customer)|repurchase)\b|"
    r"리뷰|후기|평점|고객\s*후기|재구매",
    re.I,
)
def assemble_image_ocr_evidence(
    ocr: Mapping[str, Any],
    semantic_facts: Mapping[str, Any],
    _sections: Sequence[Mapping[str, Any]],
    _product_name: str,
    *,
    diagnostics: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the stable public OCR fragment from model/fixture output."""

    raw_texts = as_list(ocr.get("extractedTexts") or ocr.get("imageTexts")) or []
    image_texts: list[dict[str, Any]] = []
    text_blocks: list[str] = []
    insights: list[dict[str, Any]] = []
    keywords: dict[str, list[str]] = {category: [] for category in _CATEGORIES}
    layout_reported = 0
    layout_kept = 0
    roles = {role: 0 for role in ("title", "body", "label", "value", "footnote")}
    discarded: list[dict[str, str]] = []
    for raw in raw_texts:
        raw_mapping = as_mapping(raw)
        if raw_mapping is None:
            continue
        image_url = _string(raw_mapping.get("imageUrl"))
        text = _string(raw_mapping.get("text"))
        if not image_url or not text:
            continue
        source_urls = [
            value
            for value in as_list(raw_mapping.get("imageUrls")) or []
            if isinstance(value, str) and value
        ]
        public: dict[str, Any] = {
            "imageUrl": image_url,
            "imageUrls": source_urls or [image_url],
            "text": text,
        }
        confidence = raw_mapping.get("confidence")
        if isinstance(confidence, (int, float)) and not isinstance(confidence, bool):
            public["confidence"] = float(confidence)
        image_texts.append(public)
        if text not in text_blocks:
            text_blocks.append(text)
        for raw_keyword in as_list(raw_mapping.get("keywords")) or []:
            keyword_mapping = as_mapping(raw_keyword)
            if keyword_mapping is None:
                continue
            category, keyword = _string(keyword_mapping.get("category")), _string(keyword_mapping.get("keyword"))
            if category in keywords and keyword and keyword not in keywords[category]:
                keywords[category].append(keyword)
        for raw_insight in as_list(raw_mapping.get("sentenceInsights")) or []:
            insight_mapping = as_mapping(raw_insight)
            if insight_mapping is None or not _string(insight_mapping.get("text")):
                continue
            # Sentence attribution and local parser provenance are diagnostic
            # internals.  The public TS artifact intentionally exposes only
            # the stable sentence-evidence projection below; copying the raw
            # classifier mapping would leak confidence/source/role metadata.
            insight: dict[str, Any] = {
                "imageUrl": (source_urls or [image_url])[0],
                "imageUrls": source_urls or [image_url],
                "text": _string(insight_mapping.get("text")),
            }
            category = _string(insight_mapping.get("category"))
            if category:
                insight["category"] = category
            raw_keywords = as_list(insight_mapping.get("keywords")) or []
            # ``GeoSentenceInsight.keywords`` is required in the public TS
            # contract.  A provider omission normalizes to an empty array,
            # not an absent property.
            insight["keywords"] = [value for value in raw_keywords if isinstance(value, str) and value.strip()]
            insight_semantic_facts = as_mapping(insight_mapping.get("semanticFacts"))
            if insight_semantic_facts is not None:
                insight["semanticFacts"] = dict(insight_semantic_facts)
            insights.append(insight)
        raw_groups = as_list(raw_mapping.get("groups"))
        if raw_groups is not None:
            layout_reported += len(raw_groups)
            verified = verify_ocr_layout_groups(text, raw_groups)
            if verified is None:
                discarded.append({"imageUrl": image_url, "reason": "quorum"})
            else:
                layout_kept += len(verified)
                for group in verified:
                    group_mapping = as_mapping(group)
                    for line in (as_list(group_mapping.get("lines")) if group_mapping is not None else []) or []:
                        line_mapping = as_mapping(line)
                        if line_mapping is not None and line_mapping.get("role") in roles:
                            roles[str(line_mapping["role"])] += 1
    # semanticFacts is a public cross-stage contract.  Keep all fields from
    # the classifier (not just metric claims), because service consumers use
    # usage steps, evidence sentences, citations, and declared links too.
    public_facts: dict[str, Any] = {}
    for field, value in semantic_facts.items():
        values = as_list(value)
        mapping = as_mapping(value)
        if values is not None:
            public_facts[field] = [dict(item) if (item := as_mapping(raw)) is not None else raw for raw in values]
        elif mapping is not None:
            public_facts[field] = dict(mapping)
        elif value is not None:
            public_facts[field] = value
    result: dict[str, Any] = {
        "ocr": {
            "imageTexts": image_texts,
            "textBlocks": text_blocks,
            "sentenceInsights": insights,
            "semanticFacts": public_facts,
        },
        "keywords": keywords,
    }
    if diagnostics is not None and layout_reported:
        diagnostics["layout"] = {
            "groupsReported": layout_reported,
            "groupsKept": layout_kept,
            "lineRoles": roles,
            "sliceStitches": 0,
            "structureDiscarded": discarded,
        }
    return result


def build_image_ocr_runtime_usage(steps: Sequence[Mapping[str, Any]]) -> dict[str, Any] | None:
    """Collapse repeated runtime labels while retaining summed token accounting."""

    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    totals = {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0}
    for raw in steps:
        if not raw.get("called"):
            continue
        stage, label = str(raw.get("stage") or "ocr"), str(raw.get("label") or "OCR")
        key = (stage, label)
        row = grouped.setdefault(
            key,
            {
                "stage": stage,
                "label": label,
                "called": True,
                "tokenUsage": {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0},
            },
        )
        token_usage = as_mapping(raw.get("tokenUsage"))
        if token_usage is not None:
            for token in totals:
                amount = token_usage.get(token)
                if isinstance(amount, int) and not isinstance(amount, bool):
                    row["tokenUsage"][token] += amount
                    totals[token] += amount
    return {"steps": list(grouped.values()), "tokenTotals": totals} if grouped else None


async def extract_image_ocr_evidence(
    request: Mapping[str, Any], options: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    """Run the common vision/slicing/classification pipeline for public OCR.

    The service and the standalone entrypoint intentionally share this path:
    callers with an ordinary provider configuration get a real adapter from the
    factory, while explicitly injected clients retain their long-standing test
    and application escape hatch.
    """

    runtime = dict(options or {})
    provider = runtime.get("provider", "mock")
    provider_name = _provider_name(provider)
    warnings: list[dict[str, str]] = []
    urls: list[str] = []
    for value in as_list(request.get("imageUrls")) or []:
        url = str(value)
        if urlparse(url).scheme not in {"http", "https"}:
            warnings.append(
                {"code": "IMAGE_OCR_TARGET_SKIPPED", "message": f"Skipped a non-http(s) image OCR target: {url[:40]}"}
            )
        elif url not in urls:
            urls.append(url)

    client = runtime.get("provider_client") or runtime.get("client")
    if client is None and provider != "mock":
        client = create_keyword_classifier(runtime)
    extracted_method = getattr(client, "extract_image_text", None) or getattr(client, "extractImageTexts", None)
    classify_method = getattr(client, "classify_keywords", None) or getattr(client, "classifyKeywords", None)
    targets: dict[str, dict[str, Any]] = {
        url: {"imageUrl": url, "sliced": False, "status": "empty", "textLength": 0, "issues": []} for url in urls
    }
    runtime_steps: list[dict[str, Any]] = []
    # Preserve provider vision rows ahead of DOM/data-ocr fallback rows.  The
    # model's 1-based evidenceIndex addresses this exact order in the retained
    # runtime, so prepending deterministic rows changes public attribution.
    extra_candidates = _request_extra_candidates(request)
    provider_candidates: list[dict[str, Any]] = []
    inputs: list[dict[str, str]] = []

    if provider == "mock" or not callable(extracted_method):
        if urls:
            warnings.append(
                {
                    "code": "IMAGE_OCR_PROVIDER_NOT_CONFIGURED"
                    if provider == "mock"
                    else "IMAGE_OCR_PROVIDER_NOT_AVAILABLE",
                    "message": (
                        f"{len(urls)} product-detail image OCR candidates were found, but image OCR was skipped because the active provider is mock. Configure an image-capable provider such as OpenAI to extract visible text from PDP images."
                        if provider == "mock"
                        else f"{len(urls)} product-detail image OCR candidates were found, but the active provider does not support visible text extraction from images."
                    ),
                }
            )
    elif urls:
        inputs = await _prepare_inputs(urls, runtime, targets)
        for batch in _vision_batches(inputs):
            try:
                response = await _call(
                    extracted_method,
                    {
                        "source": request.get("source"),
                        "productName": request.get("productName"),
                        "imageUrls": [item["displayUrl"] for item in batch],
                        "imageInputs": batch,
                    },
                )
                rows = _provider_image_rows(response, [item["displayUrl"] for item in batch])
                runtime_steps.append(
                    _model_step("ocr", "OCR/structure extraction", response, f"{len(batch)} product-detail image inputs sent for visible text extraction.")
                )
                if any(_is_dense_input(item) for item in batch) and rows:
                    rows = await _verify_dense_readings(
                        extracted_method,
                        rows,
                        batch,
                        request,
                        runtime_steps,
                        targets,
                    )
                for row in rows:
                    image_url = strip_slice_fragment(str(row.get("imageUrl") or ""))
                    if image_url in targets and str(row.get("text") or "").strip():
                        target = targets[image_url]
                        target["status"] = "extracted"
                        target["textLength"] += len(str(row["text"]))
                        confidence = row.get("confidence")
                        if isinstance(confidence, int | float) and not isinstance(confidence, bool):
                            target["confidence"] = min(float(target.get("confidence", confidence)), float(confidence))
                    provider_candidates.append(row)
            except Exception as error:  # provider failures are observable warnings, never fabricated OCR text
                message = str(error) or "Image OCR provider failed."
                code = "IMAGE_OCR_QUOTA_EXCEEDED" if _is_quota_or_billing_error(message) else "IMAGE_OCR_PROVIDER_FAILED"
                warnings.append(
                    {
                        "code": code,
                        "message": "OpenAI image OCR quota exceeded. Check the OpenAI project billing, usage limits, and model access before retrying image OCR."
                        if code == "IMAGE_OCR_QUOTA_EXCEEDED"
                        else f"Image OCR failed for 1 batch(es): {message}",
                    }
                )
                for item in batch:
                    target = targets.get(strip_slice_fragment(item["displayUrl"]))
                    if target is not None:
                        target["status"] = "failed"
                        target["issues"].append(f"Image OCR request failed: {message}")
                runtime_steps.append(
                    _model_step("ocr", "OCR/structure extraction", {}, f"{len(batch)} product-detail image inputs failed: {message}")
                )
                if code == "IMAGE_OCR_QUOTA_EXCEEDED":
                    break

    merge_stats: dict[str, Any] = {
        "duplicatesAbsorbed": 0,
        "overlapJoins": 0,
        "layoutSliceStitches": 0,
        "unmatchedBoundaries": [],
        "layoutDiscarded": [],
    }
    # Provider rows become canonical OCR readings before deterministic DOM /
    # section fallbacks join the evidence stream.  A tall image's later slice
    # often needs its preceding provider slice for product context, whereas a
    # fallback is independently source-backed and must not be swallowed by a
    # commerce provider row with a coincidental visual-line overlap.
    reconciled_provider_candidates = combine_ocr_candidates(
        join_slice_candidates(_with_source_order(provider_candidates), merge_stats), merge_stats
    )
    # The provider's 1-based evidenceIndex addresses canonical provider rows
    # first, then deterministic fallbacks.  Source order is assigned after
    # that provider-only reconciliation, matching the retained TS flow.
    ordered_candidates = _with_source_order([*reconciled_provider_candidates, *extra_candidates])
    dropped_candidates: list[dict[str, str]] = []
    evidence_candidates: list[dict[str, Any]] = []
    filter_product_evidence = request.get("filterProductEvidence") is not False
    for candidate in ordered_candidates:
        text = _string(candidate.get("text")) or ""
        if not filter_product_evidence or _is_product_evidence_candidate(text, str(request.get("productName") or "")):
            evidence_candidates.append(candidate)
            continue
        dropped_candidates.append(
            {
                "imageUrl": _string(candidate.get("imageUrl")) or "",
                "reason": "Filtered out as non-product/commerce text before merging.",
                "textPreview": _ocr_text_preview(text),
            }
        )
    # The 80-row budget is applied after the canonical product-evidence gate.
    # The second combine is idempotent for reconciled candidates and retains
    # the shared TS score-then-source-order cap behavior.
    merged = combine_ocr_candidates(evidence_candidates, merge_stats, 80)
    classified: dict[str, Any] = {}
    classification_failed = 0
    if merged and callable(classify_method):
        try:
            rag_documents = await _retrieve_policy_documents(request, runtime, merged)
            classified_value = await _call(
                classify_method,
                {
                    "source": request.get("source"),
                    "productName": request.get("productName"),
                    "imageTexts": merged,
                    "analysisPrompt": runtime.get("analysisPrompt"),
                    "ragDocuments": rag_documents,
                },
            )
            classified_mapping = as_mapping(classified_value)
            classified = dict(classified_mapping) if classified_mapping is not None else {}
            runtime_steps.append(
                _model_step(
                    "final",
                    "Semantic OCR classification/reasoning",
                    classified,
                    f"{len(merged)} OCR text candidates semantically classified.",
                )
            )
        except Exception as error:
            classification_failed = 1
            message = str(error) or "OCR keyword provider failed."
            warnings.append({"code": "OCR_PROVIDER_FAILED", "message": message})
            runtime_steps.append(
                _model_step("final", "Semantic OCR classification/reasoning", {}, f"OCR classification failed: {message}")
            )

    classified = _resolve_classified_attribution(merged, classified)
    classification_confidence = 0.54 if classification_failed else 0.72 if merged else 0.0
    enriched = _attach_classification(merged, classified, classification_confidence)
    enriched, local_facts = _append_local_semantic_fallback(
        enriched, str(request.get("productName") or ""), classification_confidence
    )
    semantic_facts = _merge_semantic_fact_mappings(
        as_mapping(classified.get("semanticFacts")) or {}, local_facts, product_name=str(request.get("productName") or "")
    )
    layout: dict[str, Any] = {}
    assembled = assemble_image_ocr_evidence(
        {"extractedTexts": enriched},
        semantic_facts,
        [],
        str(request.get("productName") or ""),
        diagnostics=layout,
    )
    layout_mapping = as_mapping(layout.get("layout"))
    merge_discarded = [
        dict(item)
        for raw in as_list(merge_stats["layoutDiscarded"]) or []
        if (item := as_mapping(raw)) is not None
    ]
    unmatched_boundaries = [
        dict(item)
        for raw in as_list(merge_stats["unmatchedBoundaries"]) or []
        if (item := as_mapping(raw)) is not None
    ][:12]
    if layout_mapping is not None:
        existing_discarded = [
            dict(item)
            for raw in as_list(layout_mapping.get("structureDiscarded")) or []
            if (item := as_mapping(raw)) is not None
        ]
        layout["layout"] = {
            **layout_mapping,
            "sliceStitches": merge_stats["layoutSliceStitches"],
            "structureDiscarded": [*existing_discarded, *merge_discarded],
            **({"unmatchedBoundaries": unmatched_boundaries} if unmatched_boundaries else {}),
        }
    elif merge_discarded:
        # TS emits slice rejection diagnostics even when no stitched group is
        # retained for layout verification.  Without this public envelope the
        # caller cannot distinguish a clean no-layout OCR response from an
        # untrusted boundary that deliberately lost its structure.
        layout["layout"] = {
            "groupsReported": 0,
            "groupsKept": 0,
            "lineRoles": {role: 0 for role in ("title", "body", "label", "value", "footnote")},
            "sliceStitches": merge_stats["layoutSliceStitches"],
            "structureDiscarded": merge_discarded,
            **({"unmatchedBoundaries": unmatched_boundaries} if unmatched_boundaries else {}),
        }
    if not merged and urls and not any(
        warning["code"].endswith("FAILED")
        or warning["code"] in {"IMAGE_OCR_PROVIDER_NOT_CONFIGURED", "IMAGE_OCR_PROVIDER_NOT_AVAILABLE"}
        for warning in warnings
    ):
        warnings.append(
            {
                "code": "IMAGE_OCR_NO_TEXT_EXTRACTED",
                "message": f"{len(urls)} product-detail image OCR candidates were sent to the image OCR provider, but no readable product text was returned. Check image accessibility, OCR model output, or whether the provider can read the target locale.",
            }
        )
    for target in targets.values():
        if target["status"] == "empty" and not target["issues"]:
            target["issues"].append("No readable text was returned for this image.")
        if target["status"] == "extracted" and isinstance(target.get("confidence"), float) and target["confidence"] < 0.6:
            target["issues"].append(
                f"Low transcription confidence ({target['confidence']}). Consider re-running OCR for this image."
            )
    generated_at = datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    categories = assembled["keywords"]
    # Keep diagnostic attribution rich even though the public OCR projection
    # above intentionally omits those internal fields.
    relation_ocr = {
        "sentenceInsights": [
            dict(insight)
            for candidate in enriched
            for raw_insight in as_list(candidate.get("sentenceInsights")) or []
            if (insight := as_mapping(raw_insight)) is not None
        ]
    }
    diagnostics: dict[str, Any] = {
        "warnings": warnings,
        "runtimeUsage": build_image_ocr_runtime_usage(runtime_steps),
        "ocr": {
            "provider": provider_name,
            "targetsConsidered": len(urls),
            "inputsSent": len(inputs),
            "targets": list(targets.values()),
            "combination": {
                "candidatesIn": len(evidence_candidates),
                "duplicatesAbsorbed": merge_stats["duplicatesAbsorbed"],
                "overlapJoins": merge_stats["overlapJoins"],
                "droppedCandidates": dropped_candidates[:20],
                "candidatesOut": len(merged),
            },
            "classification": {
                "batches": 1 if merged else 0,
                "failedBatches": classification_failed,
                "providerKeywords": len(_keyword_rows(classified)),
                "sentenceInsights": len(_insight_rows(classified)),
                "confidence": classification_confidence,
            },
            "utilization": {
                "textBlocksInResult": len(assembled["ocr"]["textBlocks"]),
                "keywordsAttached": sum(len(values) for values in categories.values()),
                "sentenceInsightsByCategory": _insight_counts(assembled["ocr"]["sentenceInsights"]),
                "ragChunksFromOcr": 0,
                "unusedTexts": [],
            },
            "issues": _ocr_issues(targets, classification_failed),
            "relations": _relation_diagnostics(relation_ocr, semantic_facts),
            **layout,
        },
        "generatedAt": generated_at,
    }
    # Candidate keywords are needed by the service while it builds OCR-backed
    # sections, but are deliberately absent from public ``imageTexts``.  Keep
    # this parallel, private runtime channel in candidate order instead of
    # widening the public source-extraction contract.
    candidate_keywords = [
        [
            dict(keyword)
            for raw_keyword in as_list(candidate.get("keywords")) or []
            if (keyword := as_mapping(raw_keyword)) is not None
        ]
        for candidate in enriched
    ]
    return {
        **assembled,
        "_candidateKeywords": candidate_keywords,
        "diagnostics": diagnostics,
        "generatedAt": generated_at,
    }


def _provider_name(provider: object) -> str:
    return provider if isinstance(provider, str) else provider.__class__.__name__.replace("Provider", "").casefold()


async def _call(method: object, request: Mapping[str, Any]) -> object:
    if not callable(method):
        return {}
    value = method(request)
    return await value if inspect.isawaitable(value) else value


def _request_extra_candidates(request: Mapping[str, Any]) -> list[dict[str, Any]]:
    values = as_list(request.get("extraCandidates") or request.get("imageTexts")) or []
    return [dict(item) for raw in values if (item := as_mapping(raw)) is not None and _string(item.get("text"))]


def _with_source_order(candidates: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Assign the retained first-seen image order without replacing explicit order."""

    order_by_image: dict[str, int] = {}
    ordered: list[dict[str, Any]] = []
    for raw in candidates:
        candidate = dict(raw)
        image_url = _string(candidate.get("imageUrl"))
        # A tall image yields several display fragment rows in Python, while
        # the TS adapter converts those to one base URL before ordering.
        key = strip_slice_fragment(image_url) if image_url else ""
        if key and key not in order_by_image:
            order_by_image[key] = len(order_by_image)
        source_order = candidate.get("sourceOrder")
        if not isinstance(source_order, int) or isinstance(source_order, bool):
            candidate["sourceOrder"] = order_by_image.get(key, len(order_by_image))
        ordered.append(candidate)
    return ordered


async def _prepare_inputs(
    urls: Sequence[str], runtime: Mapping[str, Any], targets: Mapping[str, dict[str, Any]]
) -> list[dict[str, str]]:
    prepared: list[dict[str, str]] = []
    slicing_fetcher = runtime.get("slicingFetcher") or runtime.get("slicing_fetcher")
    # Production uses the real image preflight.  A mocked provider transport
    # cannot serve arbitrary CDN image URLs, so tests can supply a slicing
    # fetcher; otherwise retain the URL unchanged for the adapter.
    use_default_fetcher = runtime.get("transport") is None
    for url in urls:
        if callable(slicing_fetcher) or use_default_fetcher:
            result = await prepare_image_ocr_inputs(
                url,
                fetcher=cast(Any, slicing_fetcher) if callable(slicing_fetcher) else None,
            )
        else:
            result = {"sliced": False, "inputs": [{"displayUrl": url, "inputUrl": url}]}
        target = targets.get(url)
        if target is not None and result.get("sliced"):
            target["sliced"] = True
            target["sliceCount"] = len(as_list(result.get("inputs")) or [])
        for raw in as_list(result.get("inputs")) or []:
            item = as_mapping(raw)
            display, input_url = (
                _string(item.get("displayUrl")) if item is not None else None,
                _string(item.get("inputUrl")) if item is not None else None,
            )
            if display and input_url:
                prepared.append({"displayUrl": display, "inputUrl": input_url})
    return prepared


def _vision_batches(inputs: Sequence[Mapping[str, str]]) -> list[list[dict[str, str]]]:
    batches: list[list[dict[str, str]]] = []
    current: list[dict[str, str]] = []
    current_is_dense = False
    for raw in inputs:
        item = {"displayUrl": str(raw["displayUrl"]), "inputUrl": str(raw["inputUrl"])}
        dense = _is_dense_input(item)
        limit = 4 if dense else 8
        if current and (dense != current_is_dense or len(current) >= limit):
            batches.append(current)
            current = []
        current.append(item)
        current_is_dense = dense
    if current:
        batches.append(current)
    return batches


def _is_dense_input(item: Mapping[str, str]) -> bool:
    return item.get("inputUrl", "").startswith("data:") or "#ocr-slice-" in item.get("displayUrl", "")


def _provider_image_rows(response: object, requested_urls: Sequence[str]) -> list[dict[str, Any]]:
    normalized = parse_image_ocr_payload_text(response, requested_urls) if isinstance(response, str) else response
    mapping = as_mapping(normalized)
    rows: list[dict[str, Any]] = []
    image_values = as_list(mapping.get("images")) if mapping is not None else None
    for position, raw in enumerate(image_values or []):
        item = as_mapping(raw)
        if item is None:
            continue
        text = _string(item.get("text"))
        url = _string(item.get("imageUrl"))
        index = item.get("index")
        if not url and isinstance(index, int) and not isinstance(index, bool) and 1 <= index <= len(requested_urls):
            url = requested_urls[index - 1]
        if not url and position < len(requested_urls):
            url = requested_urls[position]
        if not url or not text:
            continue
        row: dict[str, Any] = {"imageUrl": url, "text": text, "imageUrls": [strip_slice_fragment(url)]}
        confidence = item.get("confidence")
        if isinstance(confidence, int | float) and not isinstance(confidence, bool):
            row["confidence"] = max(0.0, min(1.0, float(confidence)))
        groups = as_list(item.get("groups"))
        if groups is not None:
            row["groups"] = [dict(group) for raw_group in groups if (group := as_mapping(raw_group)) is not None]
        rows.append(row)
    return rows


async def _verify_dense_readings(
    method: object,
    rows: list[dict[str, Any]],
    batch: Sequence[Mapping[str, str]],
    request: Mapping[str, Any],
    runtime_steps: list[dict[str, Any]],
    targets: Mapping[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    dense = [dict(item) for item in batch if _is_dense_input(item)]
    if not dense:
        return rows
    try:
        response = await _call(
            method,
            {
                "source": request.get("source"),
                "productName": request.get("productName"),
                "imageUrls": [item["displayUrl"] for item in dense],
                "imageInputs": dense,
            },
        )
        runtime_steps.append(
            _model_step("ocr", "OCR verification reading", response, f"{len(dense)} dense product-detail image input(s) re-transcribed so only shared text is kept.")
        )
    except Exception:
        return rows
    second = {str(row["imageUrl"]): str(row["text"]) for row in _provider_image_rows(response, [item["displayUrl"] for item in dense])}
    output: list[dict[str, Any]] = []
    for row in rows:
        display_url = str(row["imageUrl"])
        reread = second.get(display_url)
        if not reread:
            output.append(row)
            continue
        text, dropped = reconcile_ocr_readings(str(row["text"]), reread)
        base = strip_slice_fragment(display_url)
        if dropped and base in targets:
            targets[base]["issues"].append(
                f"{len(dropped)} token(s) differed between two readings and were dropped as unverified: {', '.join(dropped[:6])}"
            )
        if len(text) >= 8:
            next_row = dict(row)
            next_row["text"] = text
            output.append(next_row)
    return output


async def _retrieve_policy_documents(
    request: Mapping[str, Any], runtime: Mapping[str, Any], candidates: Sequence[Mapping[str, Any]]
) -> list[dict[str, Any]]:
    try:
        return await retrieve_product_extractor_rag_documents_with_runtime(
            {
                "query": create_product_extractor_rag_query(
                    {
                        "source": request.get("source", ""),
                        "productName": request.get("productName"),
                        "imageTexts": list(candidates),
                    }
                ),
                "documents": runtime.get("ragDocuments") or [],
                "settings": runtime.get("rag"),
                "embedding": runtime.get("embedding"),
                "reranker": runtime.get("reranker"),
                "onRuntimeStep": runtime.get("_runtimeStepCallback")
                or runtime.get("onRuntimeStep")
                or runtime.get("on_runtime_step"),
            }
        )
    except Exception:
        return []


def _model_step(stage: str, label: str, response: object, details: str) -> dict[str, Any]:
    mapping = as_mapping(response)
    usage = as_mapping(mapping.get("usage")) if mapping is not None else None
    return {
        "stage": stage,
        "label": label,
        "called": True,
        **({"tokenUsage": dict(usage)} if usage is not None else {}),
        "details": details,
    }


def _keyword_rows(classified: Mapping[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for raw in as_list(classified.get("keywords")) or []:
        item = as_mapping(raw)
        if item is None:
            continue
        keyword, category = _string(item.get("keyword")), _string(item.get("category"))
        if keyword and category in _CATEGORIES:
            row: dict[str, Any] = {"keyword": keyword, "category": category}
            confidence = item.get("confidence")
            if isinstance(confidence, int | float) and not isinstance(confidence, bool):
                row["confidence"] = float(confidence)
            rows.append(row)
    return rows


def _heuristic_keyword_rows(text: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for category, matcher in _HEURISTIC_KEYWORDS:
        rows.extend({"keyword": match.group(0), "category": category} for match in matcher.finditer(text))
    return _merge_keyword_rows(rows)


def _merge_keyword_rows(*groups: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for group in groups:
        for raw in group:
            keyword, category = _string(raw.get("keyword")), _string(raw.get("category"))
            if not keyword or category not in _CATEGORIES:
                continue
            key = category, keyword.casefold()
            if key not in seen:
                seen.add(key)
                row: dict[str, Any] = {"keyword": keyword, "category": category}
                confidence = raw.get("confidence")
                if isinstance(confidence, int | float) and not isinstance(confidence, bool):
                    row["confidence"] = float(confidence)
                output.append(row)
    return output


def _insight_rows(classified: Mapping[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for raw in as_list(classified.get("sentenceInsights")) or []:
        item = as_mapping(raw)
        if item is None:
            continue
        text, category = _string(item.get("text")), _string(item.get("category"))
        if not text or category not in _CATEGORIES:
            continue
        row: dict[str, Any] = {"text": text, "category": category}
        keywords = as_list(item.get("keywords"))
        if keywords is not None:
            row["keywords"] = [str(value) for value in keywords if isinstance(value, str) and value.strip()]
        semantic_facts = as_mapping(item.get("semanticFacts"))
        if semantic_facts is not None:
            row["semanticFacts"] = dict(semantic_facts)
        evidence_index = item.get("evidenceIndex")
        if isinstance(evidence_index, int) and not isinstance(evidence_index, bool):
            row["evidenceIndex"] = evidence_index
        for key in ("confidence", "source", "attribution", "roleSource"):
            value = item.get(key)
            if value is not None:
                row[key] = value
        rows.append(row)
    return rows


def _candidate_image_urls(candidate: Mapping[str, Any]) -> list[str]:
    values = [value for value in as_list(candidate.get("imageUrls")) or [] if isinstance(value, str) and value]
    image_url = _string(candidate.get("imageUrl"))
    return values or ([image_url] if image_url else [])


def _resolve_declared_attribution(value: Mapping[str, Any], candidates: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Attach only a valid 1-based provider evidence index to source image URLs."""

    result = dict(value)
    evidence_index = result.get("evidenceIndex")
    if isinstance(evidence_index, int) and not isinstance(evidence_index, bool) and 1 <= evidence_index <= len(candidates):
        image_urls = _candidate_image_urls(candidates[evidence_index - 1])
        if image_urls:
            result["imageUrls"] = image_urls
            result["attribution"] = "declared"
        return result
    # Provider imageUrls are not independently trusted: they must be declared
    # against the exact candidate list, just as the retained TS adapter does.
    result.pop("imageUrls", None)
    result.pop("attribution", None)
    return result


def _resolve_classified_attribution(
    candidates: Sequence[Mapping[str, Any]], classified: Mapping[str, Any]
) -> dict[str, Any]:
    """Resolve model evidence indexes before public OCR facts are assembled."""

    result = dict(classified)
    facts = as_mapping(result.get("semanticFacts"))
    if facts is None:
        return result
    resolved_facts: dict[str, Any] = dict(facts)
    for key in ("metricClaims", "ingredientBenefitLinks", "citations"):
        rows: list[Any] = []
        for raw in as_list(facts.get(key)) or []:
            mapping = as_mapping(raw)
            rows.append(_resolve_declared_attribution(mapping, candidates) if mapping is not None else raw)
        resolved_facts[key] = rows
    result["semanticFacts"] = resolved_facts
    return result


def _attach_classification(
    candidates: Sequence[Mapping[str, Any]], classified: Mapping[str, Any], confidence: float
) -> list[dict[str, Any]]:
    keywords = _keyword_rows(classified)
    insights = [_resolve_declared_attribution(item, candidates) for item in _insight_rows(classified)]
    output: list[dict[str, Any]] = []
    for index, candidate in enumerate(candidates, start=1):
        row = dict(candidate)
        text = str(row.get("text") or "")
        lower = text.casefold()
        row["keywords"] = _merge_keyword_rows(
            [item for item in keywords if item["keyword"].casefold() in lower], _heuristic_keyword_rows(text)
        )[:16]
        if not isinstance(row.get("confidence"), int | float) or isinstance(row.get("confidence"), bool):
            row["confidence"] = confidence
        attached: list[dict[str, Any]] = []
        for insight in insights:
            evidence_index = insight.get("evidenceIndex")
            if evidence_index == index and insight.get("imageUrls"):
                attached.append({key: value for key, value in insight.items() if key != "evidenceIndex"})
            elif evidence_index is None and insight["text"].casefold() in lower:
                fuzzy = {key: value for key, value in insight.items() if key != "evidenceIndex"}
                fuzzy["imageUrls"] = _candidate_image_urls(candidate)
                fuzzy["attribution"] = "fuzzy"
                attached.append(fuzzy)
        row["sentenceInsights"] = attached
        output.append(row)
    return output


def _append_local_semantic_fallback(
    candidates: Sequence[Mapping[str, Any]], product_name: str, confidence: float
) -> tuple[list[dict[str, Any]], dict[str, list[Any]]]:
    """Keep deterministic layout/line facts when semantic classification is empty.

    The provider's structural OCR is itself source evidence.  TS always adds
    local section/line insights after resolving declared and fuzzy classifier
    insights; otherwise an empty classifier incorrectly turns a well-read PDP
    image into no product facts at all.
    """

    facts: dict[str, list[Any]] = {
        "ingredients": [],
        "benefits": [],
        "effects": [],
        "skinTypes": [],
        "usageSteps": [],
        "safetyTests": [],
        "metricClaims": [],
        "evidenceSentences": [],
        "ingredientBenefitLinks": [],
        "citations": [],
    }
    output: list[dict[str, Any]] = []
    for raw in candidates:
        candidate = dict(raw)
        image_urls = _candidate_image_urls(candidate)
        groups: list[dict[str, Any]] = []
        for raw_group in as_list(candidate.get("groups")) or []:
            group = as_mapping(raw_group)
            if group is not None:
                groups.append(dict(group))
        text = _string(candidate.get("text")) or ""
        verified = verify_ocr_layout_groups(text, groups) if groups else None
        units = _local_evidence_units(text, verified, product_name)
        provider_insights: list[dict[str, Any]] = []
        for raw_insight in as_list(candidate.get("sentenceInsights")) or []:
            insight = as_mapping(raw_insight)
            if insight is None:
                continue
            insight_text = _string(insight.get("text")) or ""
            insight_category = _string(insight.get("category"))
            if (
                insight_category in {"benefit", "effect", "ingredient", "usage"}
                and _is_local_incomplete_claim_fragment(insight_text)
            ):
                # A classifier can label a clipped OCR tail, but it cannot
                # restore the omitted predicate. Keep the raw OCR block for
                # audit while withholding the incomplete public role.
                continue
            provider_insights.append(dict(insight))
        # Headings in the source image declare both the semantic category and
        # its visual boundary.  A shorter provider paraphrase of that same
        # source unit must not replace or duplicate it.
        declared_units = [value for _category, value, role_source in units if role_source == "section-heading"]
        insights: list[dict[str, Any]] = [
            insight
            for insight in provider_insights
            if not _is_local_packaging_formula_context(_string(insight.get("text")) or "")
            and not any(_sentence_texts_overlap(_string(insight.get("text")) or "", value) for value in declared_units)
        ]
        seen = {_comparison_key(_string(item.get("text")) or "") for item in insights}
        for category, value, role_source in units:
            key = _comparison_key(value)
            if not key:
                continue
            is_declared = role_source == "section-heading"
            relation = _local_direct_ingredient_outcome(value, product_name)
            product_subject = _is_local_product_subject_predicate(value, product_name)
            if category in {"safety", "audience"}:
                # ``safetyTests`` is a semantic-fact channel rather than a
                # sentence-insight category. Audience rows likewise feed
                # ``skinTypes`` rather than benefit copy. Do not let an
                # attached provider role re-publish either source role as
                # product efficacy or an application step.
                insights = [
                    insight
                    for insight in insights
                    if not _semantic_texts_overlap(_string(insight.get("text")) or "", value)
                ]
                seen = {_comparison_key(_string(item.get("text")) or "") for item in insights}
            elif relation is not None or product_subject:
                # A provider may reasonably label an ingredient relation as
                # either an ingredient or a benefit. A product-subject claim
                # can only remain a benefit. Preserve compatible source
                # metadata while replacing incompatible role labels.
                insights = [
                    insight
                    for insight in insights
                    if not (
                        _semantic_texts_overlap(_string(insight.get("text")) or "", value)
                        and _string(insight.get("category"))
                        not in ({"benefit"} if product_subject else {"ingredient", "benefit"})
                    )
                ]
                seen = {_comparison_key(_string(item.get("text")) or "") for item in insights}
            if not is_declared and any(
                _string(insight.get("category")) == category
                and _semantic_texts_overlap(_string(insight.get("text")) or "", value)
                for insight in insights
            ) and relation is None and not product_subject:
                continue
            _append_local_fact(facts, category, value, image_urls, product_name)
            if category in {"evidence", "safety", "audience"}:
                continue
            if key not in seen:
                insights.append(
                    {
                        "text": value,
                        "category": category,
                        "keywords": _sentence_keyword_names(candidate, value),
                        "imageUrls": image_urls,
                        "attribution": "local",
                        "source": "local",
                        "roleSource": role_source,
                        "confidence": confidence,
                    }
                )
                seen.add(key)
        if verified is not None:
            for claim in metric_claims_from_ocr_layout(verified, product_name):
                row: dict[str, Any] = dict(claim)
                source_text = _scoped_metric_source_text(verified, claim)
                if source_text:
                    row["sourceText"] = source_text
                if image_urls:
                    row["imageUrls"] = image_urls
                _append_unique_value(facts["metricClaims"], row)
        candidate["sentenceInsights"] = insights
        output.append(candidate)
    return output, facts


def _scoped_metric_source_text(groups: Sequence[Mapping[str, Any]], claim: Mapping[str, Any]) -> str:
    """Rebuild one metric's source text from its chart group and annotations only."""

    metric = _string(claim.get("metric"))
    value = _string(claim.get("value"))
    if not metric or not value:
        return ""
    metric_key, value_key = _comparison_key(metric), _comparison_key(value)
    unit = _string(claim.get("unit")) or ""
    timing_key = _comparison_key(_string(claim.get("timing")) or "")
    by_id = {str(group.get("id")): group for group in groups if group.get("id") is not None}
    for group in groups:
        group_id = str(group.get("id") or "")
        parent_id = _string(group.get("parentId"))
        parent = by_id.get(parent_id) if parent_id else None
        title = _string(group.get("title")) or (_string(parent.get("title")) if parent else None)
        if _comparison_key(title or "") != metric_key:
            continue
        lines = [as_mapping(raw) for raw in as_list(group.get("lines")) or []]
        value_lines = [
            line
            for line in lines
            if line is not None
            and _string(line.get("role")) == "value"
            and value_key in _comparison_key(_string(line.get("text")) or "")
            and _line_has_exact_metric_measurement(_string(line.get("text")) or "", value, unit)
            and (
                not timing_key
                or timing_key == _comparison_key(_string(line.get("pairedLabel")) or "")
            )
        ]
        if not value_lines:
            continue
        related_ids = {group_id, parent_id or ""}
        fragments: list[str] = []

        def append_fragment(fragment: str | None) -> None:
            if fragment and fragment not in fragments:
                fragments.append(fragment)

        append_fragment(title)
        for line in value_lines:
            line_text, paired_label = _string(line.get("text")), _string(line.get("pairedLabel"))
            append_fragment(f"{paired_label}: {line_text}" if paired_label and line_text else line_text)
        for annotation in groups:
            if _string(annotation.get("annotates")) not in related_ids:
                continue
            for raw_line in as_list(annotation.get("lines")) or []:
                line = as_mapping(raw_line)
                if line is not None:
                    append_fragment(_string(line.get("text")))
        return " ".join(fragments)
    return ""


def _line_has_exact_metric_measurement(text: str, value: str, unit: str) -> bool:
    """Match the selected value/unit pair, not a prefix shared by another chart line."""

    measurement = re.escape(value)
    if unit and not value.casefold().endswith(unit.casefold()):
        unit_pattern = r"[%％]" if unit in {"%", "％"} else re.escape(unit)
        measurement = rf"{measurement}\s*{unit_pattern}"
    return re.search(rf"(?<![\w.,]){measurement}(?![\w.,])", text, re.I) is not None


def _sentence_keyword_names(candidate: Mapping[str, Any], sentence: str) -> list[str]:
    sentence_key = normalize_ocr_comparison_text(sentence)
    rows = _merge_keyword_rows(
        [item for raw in as_list(candidate.get("keywords")) or [] if (item := as_mapping(raw)) is not None],
        _heuristic_keyword_rows(sentence),
    )
    return [
        keyword
        for row in rows
        if (keyword := _string(row.get("keyword")))
        and (keyword_key := normalize_ocr_comparison_text(keyword))
        and keyword_key in sentence_key
    ][:10]


def _local_evidence_units(
    text: str, verified_groups: Sequence[Mapping[str, Any]] | None, product_name: str
) -> list[tuple[str, str, str]]:
    if verified_groups is not None:
        facts = layout_field_facts(verified_groups, product_name)
        units: list[tuple[str, str, str]] = []
        for field, category in (
            ("ingredients", "ingredient"),
            ("benefits", "benefit"),
            ("effects", "effect"),
            ("usage", "usage"),
            ("safety", "safety"),
            ("metrics", "metric"),
        ):
            for raw_value in facts[field]:
                value = _string(raw_value)
                if value is None or not _is_declared_section_item_value(value):
                    continue
                if _is_local_packaging_formula_context(value):
                    units.append(("evidence", value, "section-heading"))
                    continue
                units.append(("safety" if is_ocr_safety_or_caution_value(value) else category, value, "section-heading"))
        return units

    units: list[tuple[str, str, str]] = []
    # Resolve visual section boundaries before attempting inline numbered-step
    # rescue.  Running that rescue over the full flattened OCR blob lets an
    # unpunctuated final step consume the next section heading/body; TS applies
    # it to each already-owned item instead.
    for section in parse_ocr_block_sections(text):
        heading = _string(section.get("heading")) or ""
        category = _local_section_category(heading)
        for raw_item in as_list(section.get("items")) or []:
            item = as_mapping(raw_item)
            value = _string(item.get("text")) if item is not None else None
            if value is None:
                continue
            numbered_usage, remainder = split_numbered_usage_steps(value)
            if numbered_usage:
                for step in numbered_usage:
                    if is_ocr_safety_or_caution_value(step):
                        units.append(("safety", step, "line-parser"))
                    else:
                        # The heading + contiguous source ordinals already
                        # establish a customer procedure.  A fixed lexical
                        # action list would otherwise discard valid verbs such
                        # as "glide", "circle", or future dosage-specific
                        # instructions before they reach semanticFacts.
                        units.append(("usage", step, "line-parser"))
                # The remainder belongs to the unstructured path, matching TS:
                # sequence ownership declares usage only for rescued steps.
                values = segment_item_sentences(remainder)
                declared_category: str | None = None
            else:
                declares_measurement = (
                    category is not None
                    and category not in {"effect", "metric"}
                    and _is_local_measurement_timeline(value)
                )
                declared_category = category if category is not None and not declares_measurement else None
                values = [value] if declared_category is not None else segment_item_sentences(value)
            for sentence in values:
                clean = _string(sentence)
                if clean is None:
                    continue
                if _is_local_packaging_formula_context(clean):
                    # Packaging copy can explain how a formula is protected,
                    # but it neither names an ingredient nor instructs a
                    # customer how to use the product. Preserve it as exact
                    # evidence without assigning either public role.
                    units.append(("evidence", clean, "section-heading" if declared_category is not None else "line-parser"))
                    continue
                role_source = "section-heading" if declared_category is not None else "line-parser"
                if _local_skin_type_values(clean):
                    # Audience evidence belongs to ``skinTypes``.  Preserve a
                    # mixed audience/outcome sentence in its ordinary role as
                    # well, but never publish an audience-only sentence as a
                    # duplicate benefit or effect.
                    units.append(("audience", clean, role_source))
                    if _is_local_audience_only_statement(clean):
                        continue
                inferred = (
                    "safety"
                    if is_ocr_safety_or_caution_value(clean)
                    else declared_category or _local_sentence_category(clean, product_name)
                )
                if inferred is not None and _is_local_sentence_insight_value(
                    clean, inferred, declared=declared_category is not None, product_name=product_name
                ):
                    units.append((inferred, clean, role_source))
    return units


def _local_section_category(heading: str) -> str | None:
    # OCR ingress and local fallback must use one source-heading taxonomy;
    # otherwise an accepted heading such as FORMULA cannot publish its local
    # ingredient fact when semantic classification is empty.
    return section_heading_category(heading)


def _local_sentence_category(value: str, product_name: str = "") -> str | None:
    lowered = value.casefold()
    if _is_local_commerce_text(value):
        return None
    if _is_local_packaging_formula_context(value):
        return None
    if is_ocr_safety_or_caution_value(value):
        return "safety"
    if _is_local_review_context(value):
        return "review"
    if _is_local_non_benefit_context(value):
        return None
    if _is_local_measurement_timeline(value):
        return "metric" if _LOCAL_METRIC_VALUE.search(value) else "effect"
    if _is_local_product_subject_predicate(value, product_name):
        return "benefit"
    if _is_local_declarative_product_benefit(value, product_name):
        return "benefit"
    # A complete subject/predicate source sentence carries both the entity
    # and outcome. Resolve that relationship before incidental use words can
    # misroute it, while retaining an explicit ingredient lexical role when
    # the source itself supplies one.
    if _local_direct_ingredient_outcome(value, product_name) is not None:
        return "ingredient" if _LOCAL_INGREDIENT_VALUE.search(value) or any(
            token in lowered for token in ("ingredient", "판테놀")
        ) else "benefit"
    if _LOCAL_USAGE_VALUE.search(value):
        return "usage"
    if _LOCAL_EFFECT_VALUE.search(value):
        return "effect"
    if _LOCAL_INGREDIENT_VALUE.search(value) or any(
        token in lowered for token in ("ingredient", "판테놀")
    ):
        return "ingredient"
    if _LOCAL_BENEFIT_VALUE.search(value):
        return "benefit"
    if _LOCAL_METRIC_VALUE.search(value):
        return "metric"
    if "?" in value or re.search(r"faq|question|answer|자주|질문|답변", value, re.I):
        return "faq"
    return None


def _local_direct_ingredient_outcome(
    value: str, product_name: str = "", *, include_product_subject: bool = False
) -> tuple[str, str] | None:
    """Read an explicit OCR ingredient/outcome predicate without a name list.

    Product pages frequently name a proprietary or ordinary ingredient that
    is not in a curated vocabulary. The relation is usable only when one
    source sentence itself supplies its grammatical subject and outcome; this
    preserves a relationship rather than guessing one from adjacent OCR text.
    """

    text = " ".join(value.split())
    if not text or _is_local_commerce_text(text) or _is_local_review_context(text):
        return None
    if _is_local_packaging_formula_context(text):
        return None
    if _is_local_non_benefit_context(text):
        return None
    english = re.match(
        r"^(?P<ingredient>.+?)\s+(?:helps?|supports?|improves?|maintains?|protects?|strengthens?|soothes?|"
        r"calms?|enhances?|contributes?\s+to|detangles?|delivers?|keeps?)\s+(?P<outcome>.+?)[.!?。！？]?$",
        text,
        re.I,
    )
    korean = re.match(
        r"^(?P<ingredient>.+?)(?:이|가|은|는)\s+(?P<outcome>.+?)\s*(?:에\s*)?(?:도움을?\s*(?:줍니다|줘요|줌)|"
        r"돕습니다|도와줍니다|기여합니다|개선(?:에|을)?\s*도움|향상(?:에|을)?\s*도움|보호(?:에|를)?\s*도움)[.!?。！？]?$",
        text,
    )
    match = english or korean
    if match is None:
        return None
    ingredient = " ".join(match.group("ingredient").split()).strip(" ,:;-–—")
    outcome = " ".join((match.groupdict().get("outcome") or "").split()).strip(" ,:;-–—")
    if (
        not ingredient
        or not outcome
        or len(ingredient) > 80
        or len(outcome) > 180
        or len(ingredient.split()) > 6
        or re.fullmatch(r"(?:this|that|it|the product|the formula|our|your|customers?)", ingredient, re.I)
        or _is_local_commerce_text(ingredient)
        or _is_local_commerce_text(outcome)
    ):
        return None
    if _is_local_product_relation_subject(ingredient, product_name) and not include_product_subject:
        return None
    return ingredient, outcome


def _is_local_product_subject_predicate(value: str, product_name: str = "") -> bool:
    relation = _local_direct_ingredient_outcome(value, product_name, include_product_subject=True)
    return relation is not None and _is_local_product_relation_subject(relation[0], product_name)


def _is_local_declarative_product_benefit(value: str, product_name: str = "") -> bool:
    """Recognize an explicit source declaration without an efficacy-verb allowlist.

    Product OCR frequently shortens a source-backed claim to a direct finite
    clause such as ``Adds lightweight volume.``.  The predicate grammar is
    intentionally broad, but it is only admitted after source-role guards and
    never produces a derived ingredient/outcome link.  A named product subject
    gives the strongest proof; a complete leading finite clause covers the
    common product-copy ellipsis without guessing a relationship from adjacent
    OCR lines.
    """

    text = " ".join(value.split())
    if not text or _is_local_commerce_text(text) or is_ocr_safety_or_caution_value(text):
        return False
    if _is_local_review_context(text) or re.search(r"\b(?:returns?|refund|coupon)\b", text, re.I):
        return False
    if _is_local_non_benefit_context(text) or _is_local_procedural_instruction(text):
        return False

    predicate = _product_named_predicate(text, product_name)
    if predicate is None:
        # OCR detail panels often omit the already-visible product subject;
        # retain only a complete finite clause, not an arbitrary label or noun
        # co-occurrence.
        predicate = text
    if _LOCAL_NON_BENEFIT_DECLARATIVE_PREDICATE.search(predicate):
        return False
    return _LOCAL_DECLARATIVE_BENEFIT_PREDICATE.search(predicate) is not None


def _product_named_predicate(value: str, product_name: str) -> str | None:
    """Return a direct product predicate when the source begins with its name."""

    name = " ".join(product_name.split()).strip()
    if not name:
        return None
    match = re.match(rf"^{re.escape(name)}(?=\s|[:,;—–-])\s*(?:[:,;—–-]\s*)?(?P<predicate>.+)$", value, re.I)
    return " ".join(match.group("predicate").split()) if match is not None else None


def _is_local_non_benefit_context(value: str) -> bool:
    """Reject polarity, adverse, and suitability prose from efficacy facts."""

    return _LOCAL_NEGATIVE_OR_ADVERSE_CLAUSE.search(value) is not None or _LOCAL_SUITABILITY_CONTEXT.search(value) is not None


def _is_local_review_context(value: str) -> bool:
    """Keep customer-language evidence out of product efficacy channels."""

    return _LOCAL_REVIEW_CONTEXT.search(value) is not None


def _is_local_procedural_instruction(value: str) -> bool:
    """Keep imperative application instructions out of declarative benefit intake."""

    return bool(
        re.search(r"\b(?:how to use|directions?|application|ritual|routine)\b|사용법|사용 방법|사용방법", value, re.I)
        or re.match(r"^(?:apply|dispense|press|massage|rinse|pat|spread|lather|spray|spritz|use)\b", value, re.I)
        or re.match(r"^(?:적당량|덜어|펴\s*발|바르|문지르|펌프(?:하여|해|합니다|하세요)|눌러|두드려|분사|뿌려)", value)
    )


def _is_local_product_relation_subject(subject: str, product_name: str = "") -> bool:
    """Reject a finished-product subject without maintaining a product-name list."""

    normalized = _relation_subject_key(subject)
    if not normalized:
        return True
    normalized_name = _relation_subject_key(product_name)
    without_article = re.sub(r"^(?:an?|the|this|that|these|those|our|your)\s+", "", normalized)
    if normalized_name and without_article == normalized_name:
        return True
    if re.match(r"^(?:an?|the|this|that|these|those|our|your)\b", normalized, re.I):
        return True
    # These are generic finished-product heads, not an ingredient dictionary.
    # A named compound or proprietary complex remains eligible regardless of
    # its spelling, while "Ocean Wash" and "Ceramide cream" do not become
    # fabricated ingredient entities merely because they have a predicate.
    return bool(
        re.search(
            r"\b(?:product|item|serum|cream|lotion|essence|toner|shampoo|conditioner|cleanser|wash|mask|oil|"
            r"mist|gel|balm|foam|primer|foundation|concealer|sunscreen|sunblock|spray|styler|treatment|"
            r"moisturizer|makeup|soap|제품|상품|세럼|크림|로션|에센스|토너|샴푸|컨디셔너|클렌저|"
            r"워시|마스크|오일|미스트|젤|밤|폼|프라이머|파운데이션|선크림|스프레이|트리트먼트)$",
            normalized,
            re.I,
        )
    )


def _relation_subject_key(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9가-힣]+", " ", value.casefold())).strip()


def _is_local_packaging_formula_context(value: str) -> bool:
    """Recognize a packaging feature statement without turning it into a product role.

    This is deliberately a grammatical source-role guard, not a product or
    ingredient allowlist. A packaging subject that protects a formula is
    still preserved in source evidence, while an actual named ingredient in a
    separate sentence remains eligible for the ingredient relation parser.
    """

    text = " ".join(value.split())
    return bool(
        re.match(
            r"^(?:the\s+)?(?:(?:airless|vacuum)\s+)?(?:pump|bottle|jar|packaging|container|applicator|"
            r"dispenser|tube|cap)\b",
            text,
            re.I,
        )
        and re.search(r"\bformula\b", text, re.I)
    )


def _local_skin_type_values(value: str, *, require_audience_cue: bool = True) -> list[str]:
    """Extract explicitly targeted skin types without turning care copy into audience facts."""

    text = " ".join(value.split())
    if not text or _is_local_commerce_text(text) or is_ocr_safety_or_caution_value(text):
        return []
    if require_audience_cue and not _LOCAL_AUDIENCE_CUE.search(text):
        return []
    return _unique_strings(match.group(0).strip() for match in _LOCAL_SKIN_TYPE_VALUE.finditer(text))


def _is_local_audience_only_statement(value: str) -> bool:
    """Recognize a direct target-skin statement that contains no separate product outcome."""

    text = " ".join(value.split())
    if not _local_skin_type_values(text):
        return False
    remainder = _LOCAL_SKIN_TYPE_VALUE.sub(" ", text)
    remainder = _LOCAL_AUDIENCE_ONLY_FILLER.sub(" ", remainder)
    remainder = re.sub(r"[\s,，;；:：./&·•()\[\]{}'\"!?。！？-]+", "", remainder)
    return not remainder


def _is_local_incomplete_claim_fragment(value: str) -> bool:
    """Reject an unpunctuated Korean OCR tail before it becomes a semantic outcome."""

    text = " ".join(value.split()).rstrip(".。！？!?")
    return bool(re.search(r"[가-힣]", text) and _LOCAL_DANGLING_KOREAN_CLAUSE.search(text))


def _atomic_safety_source_values(value: str) -> list[str]:
    """Split a flattened safety panel into source-exact test statements when boundaries are visible."""

    raw_text = value.strip()
    text = " ".join(raw_text.split())
    # English product-detail panels commonly pair each compact test label with
    # a Korean translation. Prefer the English labels as boundaries so the
    # translation stays attached to its own label rather than becoming a
    # duplicate safety row. Korean-only panels retain their visible test rows.
    matches = list(_LOCAL_ENGLISH_SAFETY_PANEL_ITEM_START.finditer(text))
    if not matches:
        matches = list(_LOCAL_KOREAN_SAFETY_PANEL_ITEM_START.finditer(text))
    if not matches:
        # This helper owns flattened visual panels only. Retain an ordinary
        # multiline provider fact verbatim so the safety merge can recognize
        # and replace it with the separately observed source rows.
        return [raw_text] if raw_text else []
    values: list[str] = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        item = text[match.start() : end].strip(" ,;|/·•")
        # A flattened pane often appends badges or awards after a completed
        # test. Keep the exact test statement, rather than giving that tail a
        # second chance to become a public safety value.
        completion = re.search(r"(?:테스트|시험|검사|평가)\s*완료", item)
        if completion is not None:
            item = item[: completion.end()]
        if item:
            values.append(item)
    return _unique_strings(values) or ([raw_text] if raw_text else [])


def _is_local_sentence_insight_value(
    value: str, category: str, *, declared: bool, product_name: str = ""
) -> bool:
    """Keep local OCR fallback at the TS evidence-value boundary.

    OCR lines without a source heading need both a semantic category and
    category-specific evidence.  Otherwise labels such as ``Visible supplied
    OCR text`` become invented benefit facts merely because they were read.
    A verified heading is a stronger source relationship, but still cannot
    publish tick marks, bare measurements, or footnotes.
    """

    text = " ".join(value.split())
    if len(text) > 900 or _is_local_commerce_text(text):
        return False
    if category == "safety":
        return declared or is_ocr_safety_or_caution_value(text)
    if declared:
        return _is_declared_section_item_value(text)
    if not _is_publishable_undeclared_local_unit(text):
        return False
    if _is_local_incomplete_claim_fragment(text):
        return False
    if category == "benefit":
        return bool(
            _LOCAL_BENEFIT_VALUE.search(text)
            or _is_local_product_subject_predicate(text, product_name)
            or _is_local_declarative_product_benefit(text, product_name)
            or _local_direct_ingredient_outcome(text, product_name) is not None
        )
    if category == "effect":
        return bool(_LOCAL_EFFECT_VALUE.search(text))
    if category == "ingredient":
        return bool(_LOCAL_INGREDIENT_VALUE.search(text))
    if category == "usage":
        return bool(_LOCAL_USAGE_VALUE.search(text)) and not _is_local_measurement_timeline(text)
    if category == "metric":
        return _has_predicated_measurement(text) and bool(
            _LOCAL_METRIC_VALUE.search(text)
            and (_LOCAL_BENEFIT_VALUE.search(text) or _LOCAL_EFFECT_VALUE.search(text))
        )
    if category in {"faq", "review"}:
        return True
    return False


def _is_publishable_undeclared_local_unit(value: str) -> bool:
    if len(value) < 12 or _looks_like_standalone_ocr_heading(value):
        return False
    return len(value.split()) >= 3 or bool(re.search(r"[가-힣ぁ-んァ-ン]", value))


def _looks_like_standalone_ocr_heading(value: str) -> bool:
    if re.match(r"^(?:ingredients?|전성분|全成分)\s*:", value, re.I):
        return False
    words = value.split()
    if len(words) > 8 or re.search(r"[.!?。！？]", value):
        return False
    if re.search(
        r"\b(?:is|are|was|were|has|have|combines?|contains?|supports?|helps?|enhances?|"
        r"improves?|diminish(?:es|ed)?)\b",
        value,
        re.I,
    ):
        return False
    return bool(
        re.search(r"[A-Z가-힣]", value)
        and re.search(r"effect|ingredient|benefit|formula|peptide|ginseng|효능|효과|성분|원료", value, re.I)
    )


def _is_declared_section_item_value(value: str) -> bool:
    text = " ".join(value.split())
    return (
        6 <= len(text) <= 900
        and not _is_local_commerce_text(text)
        and _has_predicated_measurement(text)
        and not bool(re.match(r"^[※*＊†‡]", text))
    )


def _has_predicated_measurement(value: str) -> bool:
    remainder = re.sub(r"[+\-−±]?\d+(?:[.,]\d+)?\s*(?:[^\s\d]{1,4})?", " ", value)
    remainder = re.sub(r"[%％]|[+\-−±*＊※·•]|[()\[\]{}]|[/／,、.:;~〜]", " ", remainder)
    return len(" ".join(remainder.split())) >= 2


def _is_local_measurement_timeline(value: str) -> bool:
    return bool(
        re.search(
            r"(?:before use|after use|immediately after use|after\s+\d+(?:\.\d+)?\s?(?:weeks?|days?|hours?)|"
            r"(?:사용|도포)\s*(?:전|직후|후)|사용\s+\d)",
            value,
            re.I,
        )
        and re.search(
            r"result|improv|hydration|moisture|barrier|texture|firmness|wrinkle|clinical|"
            r"결과|개선|효과|측정|수분|보습|장벽|피부결|탄력|주름|%|\d",
            value,
            re.I,
        )
        and not _has_strong_usage_instruction_cue(value)
    )


def _has_strong_usage_instruction_cue(value: str) -> bool:
    """Match TS's exception for real instructions beginning with time words."""

    return bool(_LOCAL_USAGE_VALUE.search(value))


def _is_local_commerce_text(value: str) -> bool:
    return bool(_LOCAL_COMMERCE_TEXT.search(value))


def _is_product_evidence_candidate(text: str, product_name: str = "") -> bool:
    """Keep only the TS product-evidence subset before any OCR merge/classifier call."""

    value = re.sub(r"\s+", " ", text).strip()
    if not value or _is_non_product_commerce_text(value):
        return False
    return bool(
        _EVIDENCE_PRODUCT_CARE.search(value)
        or is_ocr_safety_or_caution_value(value)
        or _local_direct_ingredient_outcome(value) is not None
        or _is_local_declarative_product_benefit(value, product_name)
        or _declares_product_section_role(text)
        or _EVIDENCE_REVIEW.search(value)
        or (_EVIDENCE_FAQ.search(value) and _EVIDENCE_PRODUCT_CARE.search(value))
        or (_EVIDENCE_METRIC.search(value) and _EVIDENCE_PRODUCT_CARE.search(value))
    )


def _is_non_product_commerce_text(value: str) -> bool:
    if _EVIDENCE_HARD_COMMERCE.search(value):
        return True
    return (
        len(value) > 120
        and bool(_EVIDENCE_POLICY_COMMERCE.search(value))
        and len(_EVIDENCE_STRONG_PRODUCT_CARE.findall(value)) < 2
    )


def _declares_product_section_role(text: str) -> bool:
    return any(
        (heading := _string(section.get("heading"))) is not None and section_heading_category(heading) is not None
        for section in parse_ocr_block_sections(text)
    )


def _ocr_text_preview(value: str) -> str:
    """Match the short, whitespace-cleaned diagnostics preview used by the TS collector."""

    return re.sub(r"\s+", " ", value).strip()[:160]


def _append_local_fact(
    facts: dict[str, list[Any]], category: str, value: str, image_urls: Sequence[str], product_name: str = ""
) -> None:
    relation = _local_direct_ingredient_outcome(value, product_name)
    if category == "ingredient":
        _append_unique_value(facts["ingredients"], relation[0] if relation is not None else value)
        if relation is None and _has_benefit_or_effect_language(value):
            _append_unique_value(
                facts["ingredientBenefitLinks"],
                {
                    "sentence": value,
                    "sourceText": value,
                    **({"imageUrls": list(image_urls)} if image_urls else {}),
                },
            )
    elif category == "benefit":
        _append_unique_value(facts["benefits"], value)
    elif category == "effect":
        _append_unique_value(facts["effects"], value)
    elif category == "usage":
        _append_unique_value(facts["usageSteps"], value)
    elif category == "safety":
        for safety_value in _atomic_safety_source_values(value):
            _append_unique_value(facts["safetyTests"], safety_value)
    elif category == "audience":
        for skin_type in _local_skin_type_values(value):
            _append_unique_value(facts["skinTypes"], skin_type)
    elif category == "metric":
        _append_unique_value(
            facts["metricClaims"],
            {"sentence": value, "sourceText": value, **({"imageUrls": list(image_urls)} if image_urls else {})},
        )
    if relation is not None:
        ingredient, benefit = relation
        if category != "ingredient":
            _append_unique_value(facts["ingredients"], ingredient)
        _append_unique_value(
            facts["ingredientBenefitLinks"],
            {
                "ingredient": ingredient,
                "benefit": benefit,
                "sentence": value,
                "sourceText": value,
                **({"imageUrls": list(image_urls)} if image_urls else {}),
            },
        )
    _append_unique_value(facts["evidenceSentences"], value)


def _has_benefit_or_effect_language(value: str) -> bool:
    return bool(
        re.search(
            r"benefit|effect|support|help|improve|care|hydration|moisture|barrier|firm|elastic|texture|"
            r"효능|효과|개선|케어|보습|수분|장벽|탄력|피부결",
            value,
            re.IGNORECASE,
        )
    )


def _append_merged_semantic_value(result: dict[str, Any], field: str, value: Any) -> None:
    existing = result.get(field)
    if existing is None:
        target: list[Any] = []
        result[field] = target
    elif isinstance(existing, list):
        target = cast(list[Any], existing)
    else:
        return
    _append_unique_value(target, value)


def _merge_semantic_fact_mappings(*mappings: Mapping[str, Any], product_name: str = "") -> dict[str, Any]:
    """Merge list-valued semantic facts without collapsing image-linked rows."""

    result: dict[str, Any] = {}
    for mapping in mappings:
        for field, value in mapping.items():
            values = as_list(value)
            if values is None:
                if field not in result and value is not None:
                    result[field] = dict(value) if (nested := as_mapping(value)) is not None else value
                continue
            for raw_value in values:
                if (
                    field in {"ingredients", "benefits", "effects", "usageSteps"}
                    and isinstance(raw_value, str)
                    and _is_local_packaging_formula_context(raw_value)
                ):
                    # Keep source context in evidenceSentences, but do not
                    # let a provider's lexical label publish the packaging
                    # predicate as an ingredient, outcome, or instruction.
                    continue
                if (
                    field in {"ingredients", "benefits", "effects", "usageSteps"}
                    and isinstance(raw_value, str)
                    and _is_local_incomplete_claim_fragment(raw_value)
                ):
                    # The raw OCR block remains available for audit, but a
                    # clipped clause cannot support a public semantic role.
                    continue
                if isinstance(raw_value, str):
                    audience_values = _local_skin_type_values(
                        raw_value, require_audience_cue=field != "skinTypes"
                    )
                    if field == "skinTypes" and audience_values:
                        for skin_type in audience_values:
                            _append_merged_semantic_value(result, "skinTypes", skin_type)
                        continue
                    if audience_values and field in {"ingredients", "benefits", "effects", "usageSteps"}:
                        for skin_type in audience_values:
                            _append_merged_semantic_value(result, "skinTypes", skin_type)
                        if _is_local_audience_only_statement(raw_value):
                            continue
                if (
                    field in {"ingredients", "effects", "usageSteps"}
                    and isinstance(raw_value, str)
                    and _is_local_product_subject_predicate(raw_value, product_name)
                ):
                    target_field = "benefits"
                else:
                    target_field = (
                        "safetyTests"
                        if field in {"benefits", "effects", "usageSteps"}
                        and isinstance(raw_value, str)
                        and is_ocr_safety_or_caution_value(raw_value)
                        else "benefits"
                        if field in {"ingredients", "effects", "usageSteps"}
                        and isinstance(raw_value, str)
                        and _local_direct_ingredient_outcome(raw_value, product_name) is not None
                        else field
                    )
                if target_field == "safetyTests" and isinstance(raw_value, str):
                    for safety_value in _atomic_safety_source_values(raw_value):
                        _append_merged_semantic_value(result, target_field, safety_value)
                    continue
                _append_merged_semantic_value(
                    result, target_field, dict(nested) if (nested := as_mapping(raw_value)) is not None else raw_value
                )
    safety_tests = as_list(result.get("safetyTests"))
    if safety_tests is not None:
        result["safetyTests"] = _atomic_safety_facts(safety_tests)
    return result


def _atomic_safety_facts(values: Sequence[Any]) -> list[Any]:
    """Keep one source-exact fact per safety test and drop only redundant panel dumps."""

    output: list[Any] = []
    exact_keys: set[str] = set()
    bare_label_indexes: dict[str, int] = {}
    for value in values:
        if not isinstance(value, str):
            output.append(value)
            continue
        value_key = normalize_ocr_comparison_text(value)
        if not value_key or value_key in exact_keys:
            continue
        atomic_keys = {
            normalize_ocr_comparison_text(other)
            for other in values
            if isinstance(other, str)
            and other != value
            and (other_key := normalize_ocr_comparison_text(other))
            and len(other_key) < len(value_key)
            and other_key in value_key
        }
        if re.search(r"[;\n]", value) and len(atomic_keys) >= 2:
            continue
        key = _safety_fact_key(value)
        bare_label = _is_bare_safety_panel_label(value)
        existing_index = bare_label_indexes.get(key)
        if bare_label:
            if existing_index is None:
                bare_label_indexes[key] = len(output)
                output.append(value)
                exact_keys.add(value_key)
            continue
        if not bare_label and existing_index is not None:
            # A provider may expose only ``DERMATOLOGIST TESTED`` while the
            # OCR pane contains its source-exact completion. Replace that
            # bare panel label, but never collapse two substantive statements
            # that happen to start with the same test family.
            output[existing_index] = value
            exact_keys.add(value_key)
            continue
        output.append(value)
        exact_keys.add(value_key)
    return output


def _safety_fact_key(value: str) -> str:
    match = _LOCAL_ENGLISH_SAFETY_PANEL_ITEM_START.search(value)
    if match is None:
        match = _LOCAL_KOREAN_SAFETY_PANEL_ITEM_START.search(value)
    return normalize_ocr_comparison_text(match.group(0) if match is not None else value)


def _is_bare_safety_panel_label(value: str) -> bool:
    """Whether a value is only a panel label, with no test-specific detail."""

    text = " ".join(value.split()).strip(" ,;|/·•.。")
    match = _LOCAL_ENGLISH_SAFETY_PANEL_ITEM_START.fullmatch(text)
    if match is not None:
        return True
    # A Korean label may visibly include only its generic completion marker.
    match = _LOCAL_KOREAN_SAFETY_PANEL_ITEM_START.match(text)
    if match is None:
        return False
    suffix = text[match.end() :].strip(" ,;|/·•.。")
    return suffix in {"", "완료"}


def _append_unique_value(values: list[Any], value: Any) -> None:
    key = _comparison_key(value)
    if key and all(_comparison_key(item) != key for item in values):
        values.append(value)


def _unique_strings(values: Iterable[str]) -> list[str]:
    output: list[str] = []
    for raw_value in values:
        value = " ".join(raw_value.split())
        if value and value not in output:
            output.append(value)
    return output


def _comparison_key(value: object) -> str:
    if isinstance(value, str):
        return " ".join(value.casefold().split())
    mapping = as_mapping(value)
    if mapping is not None:
        return "|".join(f"{key}:{_comparison_key(item)}" for key, item in sorted(mapping.items()))
    return str(value)


def _sentence_texts_overlap(left: str, right: str) -> bool:
    """Retained containment test for provider versus declared OCR sections."""

    first, second = normalize_ocr_comparison_text(left), normalize_ocr_comparison_text(right)
    return bool(first and second and (first == second or first in second or second in first))


def _semantic_texts_overlap(left: str, right: str) -> bool:
    """Keep local non-section backfill only when it adds a new semantic unit."""

    if _sentence_texts_overlap(left, right):
        return True
    first = set(re.findall(r"[a-z0-9][a-z0-9-]{2,}|[가-힣]{2,}", left.casefold()))
    second = set(re.findall(r"[a-z0-9][a-z0-9-]{2,}|[가-힣]{2,}", right.casefold()))
    return len(first & second) >= (2 if any(re.search(r"[가-힣]", value) for value in (left, right)) else 3)


def _relation_diagnostics(ocr: Mapping[str, Any], semantic_facts: Mapping[str, Any]) -> dict[str, Any]:
    """Mirror the TS audit block for attribution and semantic image links."""

    sentences: list[dict[str, Any]] = []
    for raw in as_list(ocr.get("sentenceInsights")) or []:
        insight = as_mapping(raw)
        if insight is None:
            continue
        sentences.append(
            {
                "text": _string(insight.get("text")) or "",
                "category": _string(insight.get("category")) or "unknown",
                "imageUrls": [value for value in as_list(insight.get("imageUrls")) or [] if isinstance(value, str)],
                "attribution": _string(insight.get("attribution")) or "fuzzy",
            }
        )

    def count_links(key: str) -> dict[str, int]:
        rows = as_list(semantic_facts.get(key)) or []
        mappings = [as_mapping(raw) for raw in rows]
        return {
            "total": len(rows),
            "withImage": sum(
                1
                for mapping in mappings
                if mapping is not None and any(isinstance(url, str) and url for url in as_list(mapping.get("imageUrls")) or [])
            ),
        }

    return {
        "sentences": sentences[:120],
        "attributionCounts": {
            "declared": sum(1 for item in sentences if item["attribution"] == "declared"),
            "fuzzy": sum(1 for item in sentences if item["attribution"] == "fuzzy"),
            "local": sum(1 for item in sentences if item["attribution"] == "local"),
        },
        "semanticFactLinks": {
            "metricClaims": count_links("metricClaims"),
            "ingredientBenefitLinks": count_links("ingredientBenefitLinks"),
            "citations": count_links("citations"),
        },
    }


def _insight_counts(insights: Sequence[Mapping[str, Any]]) -> dict[str, int]:
    output: dict[str, int] = {}
    for insight in insights:
        category = _string(insight.get("category"))
        if category:
            output[category] = output.get(category, 0) + 1
    return output


def _ocr_issues(targets: Mapping[str, Mapping[str, Any]], failed_classification: int) -> list[str]:
    issues: list[str] = []
    for target in targets.values():
        if target.get("status") == "failed":
            issues.append(f"Image OCR failed: {target['imageUrl']}")
        elif target.get("status") == "empty":
            issues.append(f"No readable text extracted: {target['imageUrl']}")
        elif isinstance(target.get("confidence"), float) and target["confidence"] < 0.6:
            issues.append(f"Low OCR confidence ({target['confidence']}): {target['imageUrl']}")
    if failed_classification:
        issues.append("1 of 1 OCR classification batch(es) failed; keywords from that batch were replaced by heuristics.")
    return issues


def _is_quota_or_billing_error(message: str) -> bool:
    lowered = message.casefold()
    return any(token in lowered for token in ("exceeded your current quota", "insufficient_quota", "billing", "check your plan", "rate limit", "too many requests"))


def _string(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None
