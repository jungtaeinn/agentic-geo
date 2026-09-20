"""Deterministic PDP extraction pipeline.

This module intentionally keeps the wire artifact as ordered dictionaries.  The
legacy agent exposes JSON rather than a class hierarchy, and retaining those
keys lets the FastAPI adapter later pass it through without a second
serialization policy.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import re
from collections.abc import Awaitable, Callable, Iterable, Mapping, Sequence
from datetime import UTC, datetime
from typing import Any, cast
from urllib.parse import quote, unquote, urljoin, urlparse, urlsplit, urlunsplit

import httpx
from bs4 import BeautifulSoup, Tag

from ._json_types import as_list, as_mapping
from .models import ProductExtractionInput, ProductExtractionRun
from .normalizer import normalize_extractor_product_profile_with_agent
from .ocr.blocks import section_heading_category
from .ocr.evidence import extract_image_ocr_evidence
from .ocr.pipeline import has_explicit_numbered_usage_marker, select_numbered_usage_sequence
from .rag.default_profile import default_profile
from .rag.retrieval import create_product_extractor_rag_query, retrieve_product_extractor_rag_documents_with_runtime

_STAGES: tuple[tuple[str, str, str], ...] = (
    ("input", "입력 정규화", "상품 URL과 REST API 주소를 표준 실행 입력으로 검증"),
    ("fetch", "소스 수집", "페이지 HTML, 메타정보, JSON-LD 또는 API 응답 수집"),
    ("extract", "상품정보 추출", "상품명, 가격, 설명, 옵션, FAQ 후보 정규화"),
    ("ocr", "OCR 문장/키워드 분석", "이미지/상세 영역의 효능, 효과, 성분 문장과 키워드 분류"),
    ("review", "리뷰 신호 추출", "JSON-LD와 리뷰 영역에서 고객 표현을 추출"),
    ("rag", "RAG chunk 생성", "상품, 리뷰, FAQ, OCR 근거를 RAG chunk로 구성"),
    ("json", "JSON 결과 생성", "복사 가능한 최종 JSON 아티팩트 생성"),
)
_RAG_PROFILE = "pdp-extractor-default"
_DEFAULT_ANALYSIS_PROMPT = (
    "상품 상세 페이지에서 상품명, 가격, 설명, 옵션, 효능, 효과, 성분, 사용법, FAQ, 리뷰 신호를 GEO 관점으로 추출합니다.\n"
    "typed RAG index를 기준으로 문서 단위와 내용 단위 라우팅을 확인합니다."
)
_DEFAULT_RAG_DOCUMENTS = [
    {"name": "product-normalization_v1.md", "version": "v1", "content": "# Product Normalization v1"},
    {"name": "ocr-keyword-classification_v1.md", "version": "v1", "content": "# OCR Keyword Classification v1"},
    {"name": "review-keyword-extraction_v1.md", "version": "v1", "content": "# Review Keyword Extraction v1"},
    {"name": "faq-extraction_v1.md", "version": "v1", "content": "# FAQ Extraction v1"},
]
_CATEGORY_KEYS: tuple[tuple[str, str], ...] = (
    ("ingredient", "ingredient"),
    ("성분", "ingredient"),
    ("전성분", "ingredient"),
    ("benefit", "benefit"),
    ("효능", "benefit"),
    ("피부 고민", "benefit"),
    ("effect", "effect"),
    ("효과", "effect"),
    ("clinical", "metric"),
    ("result", "metric"),
    ("사용", "usage"),
    ("how to", "usage"),
    ("direction", "usage"),
    ("faq", "faq"),
    ("question", "faq"),
    ("review", "review"),
)
_COMMERCE_NOISE = re.compile(
    r"(?:cart|checkout|coupon|point|shipping|delivery|exchange|return|refund|purchase|buy now|"
    r"장바구니|구매하기|혜택 적용가|배송비|교환|반품|환불|레이어)",
    re.IGNORECASE,
)
_OPTION_HARD_COMMERCE = re.compile(
    r"레이어\s*(?:열기|닫기)|장바구니|구매하기|바로구매|제품 수량|상품 수량|수량 감소|수량 증가|총 상품가|"
    r"혜택 적용가|네이버페이|뷰티포인트|적립 제외|사용 제외|재입고|알림 신청|레이어 닫기|판매자 정보|"
    r"상품정보제공 고시|배송/교환/반품|배송지역|배송기간|배송비|교환/반품|반품/교환|청약철회|고객센터|"
    r"택배기사|회수 상품|반송 주소|구매안전서비스|에스크로|KG이니시스|무료배송|첫 구매 혜택|혜택보기|"
    r"cart|checkout|shipping|returns?|refund|subscribe|newsletter",
    re.IGNORECASE,
)
_OPTION_POLICY_COMMERCE = re.compile(
    r"배송|교환|반품|환불|주문취소|청약철회|고객변심|택배|반송|회수|미성년자|법정대리인|이용약관|"
    r"도서지역|사서함|배송비|판매자|고시",
    re.IGNORECASE,
)
_OPTION_STRONG_PRODUCT_CARE = re.compile(
    r"피부|보습|수분|탄력|장벽|광채|주름|피부결|인삼|레티놀|나이아신아마이드|펩타이드|효능|"
    r"효과|사용법|도포|hydration|firming|wrinkle|ingredient|retinol|niacinamide|apply",
    re.IGNORECASE,
)
_OPTION_PLACEHOLDER = re.compile(
    r"^(?:총 상품가|혜택 적용가|장바구니|구매하기|상품을 선택해주세요|선택|옵션|[-+]?|\d+|[0-9,]+원)$",
    re.IGNORECASE,
)
_OPTION_PRODUCT_SIGNAL = re.compile(
    r"(?:\d+(?:\.\d+)?\s?(?:ml|mL|g|kg|oz|호|매|개입|입|세트)|단품|세트|리필|본품|기획|색상|컬러|"
    r"호수|shade|size|set|refill|크림|세럼|에센스|앰플|토너|로션)",
    re.IGNORECASE,
)
_POSITIVE_OCR_SECTION = re.compile(
    r"product[-_\s]*(?:detail|media|gallery|image|info)|pdp|detail|description|overview|summary|technical|technology|"
    r"ingredient|formula|clinical|result|efficacy|benefit|before|after|how[-_\s]*to[-_\s]*use|how\s*to\s*use|"
    r"routine|ritual|direction|usage|apply|상품\s*상세|상품\s*정보|제품\s*정보|기술|기술서|성분|효능|효과|임상|결과|사용법",
    re.IGNORECASE,
)
_NEGATIVE_OCR_SECTION = re.compile(
    r"recommend|related|you may also like|recently viewed|product[-_\s]*(?:tile|card|recommendation)|"
    r"routine[-_\s]*builder|quick\s*add|review|ugc|rating|reward|offer|promo|promotion|gift|sample|bundle|"
    r"set-item|cart|checkout|shipping|return|refund|footer|header|navigation|nav|menu|logo|icon|account|search|"
    r"wishlist|collection|blog|article|press|social|instagram|tiktok|youtube|추천|관련\s*상품|리뷰|후기|혜택|"
    r"오퍼|프로모션|장바구니|배송|반품|푸터|헤더|메뉴|검색|위시",
    re.IGNORECASE,
)
_COMMERCE_OCR_CONTEXT = re.compile(
    r"product[-_\s]*(?:tile|card|recommendation)|routine[-_\s]*builder|quick\s*add|"
    r"customers?\s+were\s+interested|you may also like|related[-_\s]*products?|"
    r"product[-_\s]*recommendations?|cross[-_\s]*sell|upsell|recently viewed|추천|관련\s*상품",
    re.IGNORECASE,
)
_GALLERY_OCR_CONTEXT = re.compile(
    r"gallery|media|carousel|slider|swiper|slick|thumbnail|thumb|product[-_\s]*image|product[-_\s]*media|"
    r"이미지|갤러리|썸네일",
    re.IGNORECASE,
)
_HIGH_VALUE_OCR_CONTEXT = re.compile(
    r"clinical|result|before|after|ingredient|formula|technology|efficacy|benefit|how[-_\s]*to[-_\s]*use|"
    r"how\s*to\s*use|routine|ritual|direction|usage|임상|결과|성분|기술|효능|효과|사용법",
    re.IGNORECASE,
)
_METRIC_RE = re.compile(
    r"(?:\b\d+(?:\.\d+)?\s?%|"
    r"\b\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?\s?(?:ml|mL|oz|fl\.?\s?oz|weeks?|days?|hours?|stars?|drops?|pumps?|times?)\b|"
    r"\b\d+(?:\.\d+)?\s?(?:점|개|명|회|주|일|시간|퍼센트)\b)",
    re.IGNORECASE,
)
_METRIC_AFTER_RE = re.compile(r"\b(?:after|in)\s+\d+(?:\.\d+)?\s?(?:weeks?|days?|hours?)\b", re.IGNORECASE)
_DOM_REVIEW_SELECTORS = (
    "[itemprop='review'], [typeof*='Review'], [data-review], [data-testid*='review'], "
    "[class*='review'], [id*='review']"
)
_DOM_REVIEW_BODY_SELECTORS = (
    "[itemprop='reviewBody'], [class*='reviewBody'], [class*='review-body'], "
    "[class*='content'], [class*='text'], [class*='comment'], p"
)
_DOM_REVIEW_AUTHOR_SELECTORS = "[itemprop='author'], [class*='author'], [data-author], [class*='user'], [class*='nickname']"
_DOM_REVIEW_CHROME = re.compile(r"write a review|sort by|filter|load more|see more reviews|리뷰 작성|정렬|필터", re.I)
_DOM_REVIEW_CARD = re.compile(r"review[-_\s]?(?:card|item|tile|entry)|testimonial", re.I)

FetchResult = tuple[int, str, str]
Fetcher = Callable[[str, Mapping[str, str]], Awaitable[FetchResult] | FetchResult]


class _ProcessTracker(list[dict[str, Any]]):
    """Live process snapshots with the TS callback timing contract."""

    def __init__(self, steps: Iterable[dict[str, Any]], callback: object = None) -> None:
        super().__init__(steps)
        self.callback = callback
        self.pending_callbacks: list[asyncio.Future[Any]] = []

    def publish(self, step: Mapping[str, Any]) -> None:
        if not callable(self.callback):
            return
        value = self.callback(dict(step))
        if inspect.isawaitable(value):
            # Callback hooks may return any Awaitable, while create_task only
            # accepts native coroutine objects.  ensure_future preserves the
            # live-event timing contract for both forms.
            self.pending_callbacks.append(asyncio.ensure_future(value))


async def extract_product(
    input_: ProductExtractionInput | Mapping[str, Any],
    options: Mapping[str, Any] | None = None,
) -> ProductExtractionRun:
    """Fetch a URL/API source and normalize it into the stable artifact."""

    parsed = input_ if isinstance(input_, ProductExtractionInput) else ProductExtractionInput.model_validate(input_)
    if not parsed.source.strip():
        raise ValueError("source must not be empty")
    runtime = _resolve_runtime_rag_options(options)
    process = _new_process(runtime)
    await _mark_and_emit(
        runtime,
        process,
        "input",
        "running",
        "REST API 입력을 정규화합니다." if parsed.source_type == "restApi" else "상품 URL 입력을 정규화합니다.",
    )
    await _mark_and_emit(
        runtime,
        process,
        "input",
        "done",
        "REST API 입력으로 정규화했습니다." if parsed.source_type == "restApi" else "상품 URL 입력으로 정규화했습니다.",
    )
    await _mark_and_emit(
        runtime,
        process,
        "fetch",
        "running",
        "REST API 응답을 수집합니다." if parsed.source_type == "restApi" else "상품 상세 페이지 HTML을 수집합니다.",
    )
    status, content_type, body = await _fetch_source(parsed.source, parsed.headers or {}, parsed.source_type, runtime)
    if not 200 <= status < 300:
        raise RuntimeError(f"Failed to fetch {parsed.source}: {status}{_response_error_suffix(body)}")
    await _mark_and_emit(
        runtime,
        process,
        "fetch",
        "done",
        "REST API JSON 응답을 수집했습니다."
        if parsed.source_type == "restApi"
        else "페이지 HTML과 메타정보 후보를 수집했습니다.",
    )
    if parsed.source_type == "restApi" or "json" in content_type.lower():
        try:
            payload = json.loads(body)
        except json.JSONDecodeError as error:
            raise RuntimeError("Source did not return valid JSON.") from error
        return await extract_product_from_api_payload(
            payload, parsed.source, runtime, process=process, source_type=parsed.source_type
        )
    return await extract_product_from_html(body, parsed.source, runtime, process=process)


async def extract_product_from_html(
    html: str,
    source: str,
    options: Mapping[str, Any] | None = None,
    *,
    process: list[dict[str, Any]] | None = None,
) -> ProductExtractionRun:
    """Parse a collected PDP HTML document without performing a network fetch."""

    runtime = _resolve_runtime_rag_options(options)
    tracker = process if process is not None else _new_process(runtime)
    payload = _parse_json_text(html)
    if payload is not None:
        return await extract_product_from_api_payload(payload, source, runtime, process=tracker, source_type="url")
    await _mark_and_emit(runtime, tracker, "extract", "running", "DOM, meta, JSON-LD에서 상품 필드를 추출합니다.")
    soup = BeautifulSoup(html, "html.parser")
    source_owned_dom_usage = _source_owned_dom_usage_sequences(soup)
    evidence: list[dict[str, str]] = [{"field": "runtime.provider", "source": "api", "value": _provider_name(runtime)}]
    warnings: list[dict[str, str]] = []
    # Scripts are source evidence, not page copy.  Read them before pruning
    # them from the DOM so JSON-LD/client state/date fields survive cleanup.
    json_nodes = _json_ld_nodes(soup)
    references = _references(json_nodes)
    product_node = _first_schema_type(json_nodes, "Product")
    faq_node = _first_schema_type(json_nodes, "FAQPage")
    client_records = _client_state_records(soup, source)
    scoped_client_records = _records_for_source(client_records, _handle(source))
    page_date_modified = _html_date_modified(soup)
    removed = _remove_noise(soup)
    if removed:
        evidence.append(
            {
                "field": "page.obstructionsRemoved",
                "source": "dom",
                "value": f"{removed} modal, overlay, drawer, or chrome nodes removed before extraction.",
            }
        )
    # The TypeScript extractor treats a PDP handle as a scope, rather than
    # selecting one arbitrary client-state object.  Keep name/description
    # within that scope, while the fields below deliberately get their own
    # all-record fallback when the scoped records omit them.
    name, name_source = _select_name(soup, product_node, scoped_client_records, source)
    evidence.append({"field": "product.name", "source": name_source, "value": name})
    brand = _select_brand(soup, product_node, scoped_client_records, client_records)
    if brand:
        evidence.append({"field": "product.brand", "source": "jsonLd" if product_node else "dom", "value": brand})
    description = _select_description(soup, product_node, scoped_client_records, _visible_text(soup), source)
    if description:
        evidence.append(
            {"field": "product.description", "source": "jsonLd" if product_node else "meta", "value": description}
        )
    offer = _resolve_reference(_mapping_value(product_node, "offers"), references)
    price = (
        _string(_mapping_value(offer, "price"))
        or _first_client_price(scoped_client_records)
        or _first_client_price(client_records)
        or _meta(soup, "product:price:amount")
        or _find_price(_visible_text(soup))
    )
    currency = (
        _string(_mapping_value(offer, "priceCurrency"))
        or _first_client_currency(scoped_client_records)
        or _first_client_currency(client_records)
        or _meta(soup, "product:price:currency")
    )
    if price:
        evidence.append({"field": "product.price", "source": "jsonLd" if offer else "dom", "value": price})
    trust = _commerce_trust(product_node, offer, references, source)
    for field in ("availability", "priceValidUntil", "itemCondition"):
        value = trust.get(field)
        if isinstance(value, str):
            evidence.append({"field": f"product.{field}", "source": "jsonLd", "value": value})
    # Fall back based on usable, source-resolved media, not a truthy raw
    # envelope such as ``images: [{}]``.  This matches the TS reader's
    # ``unique(readClientStateImages(...))`` before it decides scope fallback.
    client_images = _absolute_all(_client_images(scoped_client_records), source)
    if not client_images:
        client_images = _absolute_all(_client_images(client_records), source)
    images = _unique(
        [
            *(_absolute_all(_array(_mapping_value(product_node, "image")), source)),
            *(_absolute_all(_array(_mapping_value(product_node, "images")), source)),
            *client_images,
            *(_absolute_all([_meta(soup, "og:image")], source)),
            *(_absolute_all(_document_image_values(soup, html), source)),
        ]
    )
    sections = _unique_sections(
        [
            *_html_sections(soup),
            *[
                section
                for record in scoped_client_records
                for section in _mapping_sections(record)
            ],
        ]
    )
    if sections:
        evidence.append(
            {
                "field": "page.scrollSections",
                "source": "dom",
                "value": f"{len(sections)} long-scroll product text sections collected for HTML parsing and RAG.",
            }
        )
    embedded_section_count = sum(
        len(_mapping_sections(record)) for record in scoped_client_records if record.get("__embeddedTheme")
    )
    if embedded_section_count:
        evidence.append(
            {
                "field": "page.embeddedProductSections",
                "source": "dom",
                "value": f"{embedded_section_count} embedded product metadata sections collected from page scripts.",
            }
        )
    if client_records:
        evidence.append(
            {
                "field": "page.clientStateProductData",
                "source": "dom",
                "value": "Embedded client state JSON was collected.",
            }
        )
    faq = _faq_items(soup, faq_node)
    profile = _profile_from_sections(
        name=name,
        brand=brand,
        description=description,
        price=price,
        currency=currency,
        images=images,
        sections=sections,
        faq=faq,
        options=_options_from_html(soup, product_node, scoped_client_records, client_records),
    )
    profile.update(trust)
    profile, usage, normalization = await _apply_normalizer(
        profile, source, "url", {"htmlText": _visible_text(soup)}, runtime
    )
    evidence.extend(normalization["evidence"])
    warnings.extend(
        {"code": "PRODUCT_NORMALIZATION_WARNING", "message": warning} for warning in normalization["warnings"]
    )
    if usage is not None:
        evidence.append(
            {
                "field": "product.normalization",
                "source": "llm",
                "value": "A product normalization agent supplied source-backed fields.",
            }
        )
    await _mark_and_emit(runtime, tracker, "extract", "done", f"{profile['name']} 상품 기본정보를 정규화했습니다.")
    await _mark_and_emit(runtime, tracker, "ocr", "running", "이미지 OCR과 이미지 대체 텍스트 후보를 문장/키워드 근거로 분류합니다.")
    # OCR raw-markup candidates must be drawn from the serialized, pruned DOM
    # (Cheerio's ``$.html()`` in the retained implementation), never the
    # original script-bearing response body.
    ocr = await _html_ocr_with_runtime(
        soup,
        source,
        images,
        sections,
        _string(profile.get("name")) or "",
        runtime,
        str(soup),
        html,
    )
    _append_no_ocr_warning(warnings, ocr)
    await _mark_and_emit(
        runtime,
        tracker,
        "ocr",
        "done",
        f"{len(ocr['imageTexts'])}개 이미지 OCR/대체 텍스트 후보에서 OCR 문장과 키워드를 분류했습니다.",
        metrics={"ocrImageCandidateCount": len(ocr["imageTexts"])},
    )
    await _mark_and_emit(runtime, tracker, "review", "running", "JSON-LD와 리뷰 영역에서 고객 표현을 추출합니다.")
    reviews, review_evidence = _reviews_from_html(soup, product_node, client_records)
    evidence.extend(review_evidence)
    if ("rating" in reviews or "reviewCount" in reviews) and not reviews["items"]:
        warnings.append(
            {
                "code": "REVIEW_BODIES_UNAVAILABLE",
                "message": "An aggregate rating was found but no review bodies were readable in the fetched HTML. Review widgets are usually client-rendered, so review-language claims cannot be sourced from this run.",
            }
        )
    await _mark_and_emit(
        runtime,
        tracker,
        "review",
        "done",
        _review_message(reviews),
        metrics={"reviewItemCount": len(_array(reviews.get("items")))},
    )
    await _mark_and_emit(runtime, tracker, "rag", "running", "상품, 리뷰, FAQ, OCR 근거를 RAG chunk로 구성합니다.")
    date_modified = page_date_modified
    if date_modified:
        evidence.append({"field": "product.dateModified", "source": "meta", "value": date_modified})
    product = _build_geo_product(
        profile,
        reviews,
        ocr,
        sections,
        faq,
        date_modified=date_modified,
        source_owned_dom_usage=source_owned_dom_usage,
    )
    chunks = await _rag_chunks(source, product, runtime)
    product["rag"] = {"chunks": chunks}
    await _mark_and_emit(
        runtime,
        tracker,
        "rag",
        "done",
        f"{len(chunks)}개 RAG chunk를 생성했습니다.",
        metrics={"ragChunkCount": len(chunks)},
    )
    await _mark_and_emit(runtime, tracker, "json", "running", "최종 JSON 결과를 직렬화합니다.")
    await _mark_and_emit(runtime, tracker, "json", "done", "최종 JSON 결과를 생성했습니다.")
    await _emit_progress(runtime, tracker)
    return _run(
        source,
        "url",
        product,
        tracker,
        evidence,
        warnings,
        runtime_usage=usage,
        normalizer_called=bool(normalization.get("called")),
        ocr=ocr,
        runtime=runtime,
    )


async def extract_product_from_api_payload(
    payload: Any,
    source: str,
    options: Mapping[str, Any] | None = None,
    *,
    process: list[dict[str, Any]] | None = None,
    source_type: str = "restApi",
) -> ProductExtractionRun:
    """Normalize REST or URL-returned JSON using the same artifact contract."""

    runtime = _resolve_runtime_rag_options(options)
    tracker = process if process is not None else _new_process(runtime)
    await _mark_and_emit(runtime, tracker, "extract", "running", "REST API payload에서 상품 필드를 정규화합니다.")
    root = _as_mapping(payload)
    product_source = _as_mapping(root.get("product")) or root
    review_source = _as_mapping(root.get("reviews"))
    sections = _mapping_sections(product_source)
    description = _html_to_text(
        _string(product_source.get("description"))
        or _string(product_source.get("body_html"))
        or _string(product_source.get("bodyHtml"))
        or ""
    )
    name = (
        _string(product_source.get("name"))
        or _string(product_source.get("productName"))
        or _string(product_source.get("title"))
        or "Untitled product"
    )
    images = _unique(
        _absolute_all(
            [*_image_values(product_source.get("images")), *_image_values(product_source.get("image"))],
            source,
        )
    )
    variants: list[Mapping[str, Any]] = []
    for item in _array(product_source.get("variants")):
        variant = as_mapping(item)
        if variant is not None:
            variants.append(variant)
    first_variant: Mapping[str, Any] = variants[0] if variants else {}
    offers = _first_mapping(product_source.get("offers"))
    profile: dict[str, Any] = {
        "name": name,
        "brand": _brand(product_source.get("brand"))
        or _brand(product_source.get("vendor"))
        or _brand(product_source.get("manufacturer"))
        or _brand(product_source.get("maker")),
        "description": description or None,
        "price": _string(product_source.get("price"))
        or _string(first_variant.get("price"))
        or _string(offers.get("price")),
        "currency": _string(product_source.get("currency")) or _string(offers.get("priceCurrency")),
        "availability": _string(product_source.get("availability")) or _string(offers.get("availability")),
        "itemCondition": _string(product_source.get("itemCondition")) or _string(offers.get("itemCondition")),
        "priceValidUntil": _string(product_source.get("priceValidUntil")) or _string(offers.get("priceValidUntil")),
        "returnPolicy": _return_policy(
            _as_mapping(product_source.get("returnPolicy")) or _as_mapping(offers.get("hasMerchantReturnPolicy")),
            source,
        ),
        "images": images,
        "options": _api_options(product_source, variants),
        "benefits": _unique([*_values(product_source.get("benefits")), *_section_values(sections, "benefit")]),
        "effects": _unique([*_values(product_source.get("effects")), *_section_values(sections, "effect")]),
        "ingredients": _unique(
            [
                *_values(product_source.get("ingredients")),
                *_values(product_source.get("keyIngredients")),
                *_values(product_source.get("ingredientHighlights")),
                *_section_values(sections, "ingredient"),
            ]
        ),
        "usage": _unique(
            [
                *_values(product_source.get("usage")),
                *_values(product_source.get("howToUse")),
                *_values(product_source.get("how_to_use")),
                *_values(product_source.get("directions")),
                *_section_values(sections, "usage"),
            ]
        ),
        "metrics": _unique(
            [
                *_values(product_source.get("metrics")),
                *_metric_phrases(description),
                *[metric for section in sections for metric in _metric_phrases(section["text"])],
            ]
        )[:16],
        "faq": _api_faq(product_source.get("faq")),
        "sections": sections,
    }
    profile, usage, normalization = await _apply_normalizer(profile, source, source_type, {"payload": payload}, runtime)
    evidence: list[dict[str, str]] = [
        {"field": "runtime.provider", "source": "api", "value": _provider_name(runtime)},
        {
            "field": "url.jsonPayload" if source_type == "url" else "api.payload",
            "source": "api",
            "value": "REST API payload normalized.",
        },
    ]
    evidence.extend(normalization["evidence"])
    warnings: list[dict[str, str]] = [
        {"code": "PRODUCT_NORMALIZATION_WARNING", "message": warning} for warning in normalization["warnings"]
    ]
    if usage is not None:
        evidence.append(
            {
                "field": "product.normalization",
                "source": "llm",
                "value": "A product normalization agent supplied source-backed fields.",
            }
        )
    await _mark_and_emit(runtime, tracker, "extract", "done", f"{profile['name']} 상품 기본정보를 정규화했습니다.")
    await _mark_and_emit(runtime, tracker, "ocr", "running", "API 상세 텍스트를 OCR 문장/키워드 근거로 분류합니다.")
    api_text_candidates = _api_text_candidates(source, product_source, description, sections)
    # API-provided OCR is already attached to product media when one exists;
    # unlike product ``images`` it is safe to classify without sending vision
    # requests.  This is a distinct source from generated #api-text chunks.
    ocr_candidates = [
        {
            "imageUrl": images[index] if index < len(images) else f"{source}#image-{index + 1}",
            "text": text,
        }
        for index, text in enumerate(_values(product_source.get("ocrTexts")))
    ]
    ocr_candidates.extend(api_text_candidates)
    ocr = await _api_ocr_with_runtime(source, images, ocr_candidates, _string(profile.get("name")) or "", runtime)
    _append_no_ocr_warning(warnings, ocr)
    await _mark_and_emit(
        runtime,
        tracker,
        "ocr",
        "done",
        f"{len(ocr['imageTexts'])}개 OCR 근거 텍스트에서 문장과 키워드를 분류했습니다.",
        metrics={"ocrImageCandidateCount": len(ocr["imageTexts"])},
    )
    await _mark_and_emit(runtime, tracker, "review", "running", "REST API 리뷰 데이터를 키워드 근거로 정규화합니다.")
    reviews = _reviews_from_api(review_source or root)
    if ("rating" in reviews or "reviewCount" in reviews) and not reviews["items"]:
        warnings.append(
            {
                "code": "REVIEW_BODIES_UNAVAILABLE",
                "message": "An aggregate rating was provided but no review bodies were readable in the API payload.",
            }
        )
    for field, value in (("rating", reviews.get("rating")), ("reviewCount", reviews.get("reviewCount"))):
        if value is not None:
            evidence.append({"field": f"product.reviews.{field}", "source": "api", "value": str(value)})
    await _mark_and_emit(
        runtime,
        tracker,
        "review",
        "done",
        _review_message(reviews),
        metrics={"reviewItemCount": len(_array(reviews.get("items")))},
    )
    await _mark_and_emit(runtime, tracker, "rag", "running", "API 상품/리뷰/OCR 근거를 RAG chunk로 구성합니다.")
    date_modified = _payload_date_modified(payload)
    if date_modified:
        evidence.append({"field": "product.dateModified", "source": "api", "value": date_modified})
    product = _build_geo_product(profile, reviews, ocr, sections, profile["faq"], date_modified=date_modified)
    chunks = await _rag_chunks(source, product, runtime)
    product["rag"] = {"chunks": chunks}
    await _mark_and_emit(
        runtime,
        tracker,
        "rag",
        "done",
        f"{len(chunks)}개 RAG chunk를 생성했습니다.",
        metrics={"ragChunkCount": len(chunks)},
    )
    await _mark_and_emit(runtime, tracker, "json", "running", "최종 JSON 결과를 직렬화합니다.")
    await _mark_and_emit(runtime, tracker, "json", "done", "최종 JSON 결과를 생성했습니다.")
    await _emit_progress(runtime, tracker)
    return _run(
        source,
        source_type,
        product,
        tracker,
        evidence,
        warnings,
        runtime_usage=usage,
        normalizer_called=bool(normalization.get("called")),
        ocr=ocr,
        runtime=runtime,
    )


async def _fetch_source(
    source: str, provided_headers: Mapping[str, str], source_type: str, runtime: Mapping[str, Any]
) -> FetchResult:
    headers = {str(key): str(value) for key, value in provided_headers.items()}
    if source_type == "url":
        headers["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    else:
        headers.setdefault("Accept", "application/json")
    fetcher = runtime.get("fetcher")
    if callable(fetcher):
        fetched = fetcher(source, headers)
        result: object = await fetched if inspect.isawaitable(fetched) else fetched
        if isinstance(result, tuple):
            tuple_result = cast(tuple[object, ...], result)
            if len(tuple_result) == 3:
                return cast(FetchResult, tuple_result)
        if isinstance(result, httpx.Response):
            return result.status_code, result.headers.get("content-type", ""), result.text
        raise TypeError("fetcher must return (status, content_type, body) or httpx.Response")
    async with httpx.AsyncClient(follow_redirects=True, timeout=30.0) as client:
        response = await client.get(source, headers=headers)
        return response.status_code, response.headers.get("content-type", ""), response.text


def _new_process(runtime: Mapping[str, Any] | None = None) -> _ProcessTracker:
    callback = (runtime or {}).get("onProgress") or (runtime or {}).get("on_progress")
    return _ProcessTracker(
        [
        {"id": identifier, "title": title, "description": description, "status": "pending", "message": description}
        for identifier, title, description in _STAGES
        ],
        callback,
    )


def _mark(
    process: list[dict[str, Any]],
    identifier: str,
    status: str,
    message: str,
    *,
    metrics: Mapping[str, object] | None = None,
) -> None:
    for step in process:
        if step["id"] == identifier:
            timestamp = datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            if status == "running":
                step["startedAt"] = timestamp
            if status in {"done", "error"}:
                step.setdefault("startedAt", timestamp)
                step["completedAt"] = timestamp
            step["status"] = status
            step["message"] = message
            if metrics:
                step["metrics"] = {
                    key: value
                    for key, value in metrics.items()
                    if isinstance(value, int) and not isinstance(value, bool) and value >= 0
                }
            if isinstance(process, _ProcessTracker):
                process.publish(step)
            return


async def _mark_and_emit(
    runtime: Mapping[str, Any],
    process: list[dict[str, Any]],
    identifier: str,
    status: str,
    message: str,
    *,
    metrics: Mapping[str, object] | None = None,
) -> None:
    """Publish a real phase transition before the following phase can block."""

    _mark(process, identifier, status, message, metrics=metrics)
    await _emit_progress(runtime, process)


async def _emit_progress(runtime: Mapping[str, Any], process: Sequence[Mapping[str, Any]]) -> None:
    """Drain async live callbacks; snapshots were published by ``_mark``."""

    del runtime
    if isinstance(process, _ProcessTracker) and process.pending_callbacks:
        pending, process.pending_callbacks = process.pending_callbacks, []
        await asyncio.gather(*pending)


def _parse_json_text(value: str) -> Mapping[str, Any] | list[Any] | None:
    stripped = value.strip()
    if not stripped or stripped[0] not in "[{":
        return None
    try:
        parsed: object = json.loads(stripped)
    except json.JSONDecodeError:
        return None
    return as_mapping(parsed) or as_list(parsed)


def _json_ld_nodes(soup: BeautifulSoup) -> list[dict[str, Any]]:
    nodes: list[dict[str, Any]] = []
    for script in soup.select('script[type="application/ld+json"]'):
        raw = script.string or script.get_text()
        parsed = _parse_json_text(raw)
        nodes.extend(_flatten_json_ld(parsed))
    return nodes


def _flatten_json_ld(value: object) -> list[dict[str, Any]]:
    mapping = as_mapping(value)
    if mapping is not None:
        items = [dict(mapping)]
        graph = as_list(mapping.get("@graph"))
        if graph is not None:
            for item in graph:
                items.extend(_flatten_json_ld(item))
        return items
    items = as_list(value)
    if items is not None:
        return [item for child in items for item in _flatten_json_ld(child)]
    return []


def _references(nodes: Iterable[Mapping[str, Any]]) -> dict[str, dict[str, Any]]:
    """Index JSON-LD references without overwriting the first graph node.

    ``Array.find`` in the retained runtime resolves duplicate ``@id`` records
    to the first appearance.  A dict comprehension silently changed that to
    last-wins in the initial port.
    """

    references: dict[str, dict[str, Any]] = {}
    for node in nodes:
        identifier = _string(node.get("@id"))
        if identifier and identifier not in references:
            references[identifier] = dict(node)
    return references


def _resolve_reference(value: Any, references: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    """Resolve only reference-only JSON-LD records, preserving inline values."""

    record: dict[str, Any] = {}
    for item in _array(value):
        mapping = as_mapping(item)
        if mapping is not None:
            record = dict(mapping)
            break
    if not record:
        return {}
    identifier = _string(record.get("@id"))
    reference_only = bool(identifier) and all(key in {"@id", "@type"} for key in record)
    if identifier and reference_only:
        return dict(references.get(identifier, record))
    return record


def _first_schema_type(nodes: Iterable[Mapping[str, Any]], type_name: str) -> dict[str, Any]:
    for node in nodes:
        type_value = node.get("@type")
        if type_value == type_name or type_name in _array(type_value):
            return dict(node)
    return {}


def _mapping_value(value: Mapping[str, Any] | None, key: str) -> Any:
    return value.get(key) if value else None


def _as_mapping(value: object) -> dict[str, Any]:
    mapping = as_mapping(value)
    return dict(mapping) if mapping is not None else {}


def _first_mapping(value: object) -> dict[str, Any]:
    """Match TS ``firstObject`` for JSON-LD/API object-or-array fields."""

    mapping = as_mapping(value)
    if mapping is not None:
        return dict(mapping)
    for item in as_list(value) or []:
        mapping = as_mapping(item)
        if mapping is not None:
            return dict(mapping)
    return {}


def _array(value: object) -> list[Any]:
    items = as_list(value)
    return items if items is not None else [value] if value is not None else []


def _string(value: Any) -> str | None:
    if isinstance(value, str):
        compact = re.sub(r"\s+", " ", value).strip()
        return compact or None
    if isinstance(value, int | float) and not isinstance(value, bool):
        return str(value)
    return None


def _unique(values: Iterable[Any]) -> list[str]:
    output: list[str] = []
    seen: set[str] = set()
    for value in values:
        text = _string(value)
        if not text:
            continue
        key = re.sub(r"\s+", " ", text).casefold()
        if key not in seen:
            seen.add(key)
            output.append(text)
    return output


def _absolute_all(values: Iterable[Any], source: str) -> list[str]:
    output: list[str] = []
    for value in values:
        mapping = as_mapping(value)
        if mapping is not None:
            # ``readImageUrls`` keeps every usable alias on a media record;
            # a CMS can expose both its delivery URL and the original asset.
            for key in ("src", "url", "image", "imgUrl", "imageUrl", "thumbnailUrl", "originalSrc"):
                if (text := _string(mapping.get(key))) is not None:
                    output.append(_absolute_url(text, source))
            continue
        if (text := _string(value)) is not None:
            output.append(_absolute_url(text, source))
    return output


def _absolute_url(value: str, source: str) -> str:
    """Mirror ``new URL(value, source).toString()`` for public source URLs."""

    try:
        resolved = urljoin(source, value)
        parts = urlsplit(resolved)
        return urlunsplit(
            (
                parts.scheme,
                parts.netloc,
                quote(parts.path, safe="/%:@!$&'()*+,;=-._~"),
                quote(parts.query, safe="%/?:@!$&'()*+,;=-._~"),
                quote(parts.fragment, safe="%/?:@!$&'()*+,;=-._~"),
            )
        )
    except (TypeError, ValueError):
        return value


def _response_error_suffix(body: str) -> str:
    cleaned = re.sub(r"\s+", " ", body).strip()
    return f" - {_utf16_prefix(cleaned, 180)}" if cleaned else ""


def _utf16_prefix(value: str, code_units: int) -> str:
    """Use UTF-16 unit boundaries without emitting an invalid Python string."""

    # JavaScript can temporarily hold a half-surrogate after ``slice`` and
    # JSON.stringify escapes it.  Python's UTF-8 response serializers cannot;
    # replacement keeps the same boundary/length behavior while making the
    # public REST failure safely serializable.
    return value.encode("utf-16-le", "surrogatepass")[: code_units * 2].decode("utf-16-le", "replace")


def _meta(soup: BeautifulSoup, key: str) -> str | None:
    node = soup.find("meta", attrs={"property": key}) or soup.find("meta", attrs={"name": key})
    return _string(node.get("content")) if isinstance(node, Tag) else None


def _find_price(body_text: str) -> str | None:
    """Return the first page-visible currency amount, as retained TS does."""

    matched = re.search(r"(?:[$€£¥]\s?\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*(?:\.\d{1,2})?\s?(?:원|KRW|USD))", body_text, re.I)
    return matched.group(0).strip() if matched is not None else None


def _remove_noise(soup: BeautifulSoup) -> int:
    removed = 0
    # JSON-LD/client-state scripts are read before this call; ordinary JS and
    # page chrome must not become product copy.  This mirrors the retained
    # pageChromeSelector rather than relying on commerce words alone: brand
    # editorial/navigation prose can otherwise look like a valid description.
    for node in list(
        soup.select(
            "script, style, noscript, template, iframe, svg, header, nav, footer, "
            "[class*='header'], [class*='footer'], [class*='navigation'], [class*='breadcrumb'], [class*='menu']"
        )
    ):
        # Storefronts frequently use a ``*header`` class for a content-card
        # label as well as for page chrome.  A declared usage heading with
        # ordinal cards is source content, so preserve it for the normal DOM,
        # OCR-context, and section readers below.  The header has already
        # been captured as a canonical procedure before this cleanup pass.
        if _is_nested_declared_usage_header(node):
            continue
        node.decompose()
        removed += 1
    for node in list(soup.find_all(True)):
        if node.parent is None:
            continue
        classes = node.get("class")
        class_values = classes if isinstance(classes, list) else [classes] if isinstance(classes, str) else []
        marker = " ".join([str(node.get("id") or ""), *[str(value) for value in class_values]])
        if re.search(r"(?:modal|overlay|drawer|newsletter|cookie|account|cart|layer)", marker, re.IGNORECASE):
            node.decompose()
            removed += 1
    return removed


def _source_owned_dom_usage_sequences(soup: BeautifulSoup) -> list[str]:
    """Read a declared DOM card procedure before flattening or chrome cleanup.

    A visual card sequence carries source structure that text/OCR flattening
    cannot recover: its semantic heading, enclosing product-content region,
    accessible ordinal label, card body, and document order.  This function
    intentionally returns a source-shaped value for the existing sequence
    validator rather than publishing cards itself.
    """

    seen: set[tuple[int, tuple[tuple[int, str], ...]]] = set()
    groups: list[tuple[str, list[tuple[int, str]], list[str]]] = []
    for heading in _dom_usage_heading_nodes(soup):
        heading_text = _dom_usage_heading_text(heading)
        declared = _declared_usage_cards_for_heading(heading)
        if not heading_text or not declared:
            continue
        container, cards = declared
        identity = (
            id(container),
            tuple((ordinal, _usage_sequence_source_key(text)) for ordinal, text in cards),
        )
        if identity in seen:
            continue
        seen.add(identity)
        value = "\n".join([heading_text, *(f"Step {ordinal}: {text}" for ordinal, text in cards)])
        heading_key = _dom_usage_heading_key(heading_text)
        if groups and groups[-1][0] == heading_key and _extends_declared_usage_group(groups[-1][1], cards):
            groups[-1][1].extend(cards)
            groups[-1][2].append(value)
        else:
            groups.append((heading_key, list(cards), [value]))

    for _heading_key, _cards, values in groups:
        # A declared card procedure is stronger source structure than a
        # flattened OCR/string candidate.  Validate each source procedure in
        # document order, then retain the first complete one.  Adjacent source
        # cards carrying the same heading may contribute later ordinals to one
        # procedure, but a reset with different card text starts a new source
        # procedure rather than creating a conflicting hybrid.
        steps, _diagnostics = select_numbered_usage_sequence(values)
        if steps:
            return values
    return []


def _dom_usage_heading_key(value: str) -> str:
    return re.sub(r"[^\w가-힣ぁ-んァ-ン]+", " ", value.casefold()).strip()


def _extends_declared_usage_group(
    existing_cards: Sequence[tuple[int, str]], candidate_cards: Sequence[tuple[int, str]]
) -> bool:
    """Keep adjacent fragments together unless an ordinal resets to new text."""

    existing_by_ordinal = {ordinal: text for ordinal, text in existing_cards}
    return all(
        (existing := existing_by_ordinal.get(ordinal)) is None
        or _usage_sequence_source_key(existing) == _usage_sequence_source_key(text)
        for ordinal, text in candidate_cards
    )


def _is_nested_declared_usage_header(node: Tag) -> bool:
    """Keep a card-level usage label while rejecting ordinary page chrome."""

    if node.parent is None:
        return False
    for candidate in _dom_usage_heading_nodes(node):
        if _declared_usage_cards_for_heading(candidate) is not None:
            return True
    return False


def _dom_usage_heading_nodes(root: BeautifulSoup | Tag) -> list[Tag]:
    """Return semantic DOM usage labels, including styled content-card headers."""

    nodes: list[Tag] = [cast(Tag, root)]
    nodes.extend(root.find_all(True))
    return [node for node in nodes if _dom_usage_heading_text(node) is not None]


def _dom_usage_heading_text(node: Tag) -> str | None:
    if not _looks_like_dom_heading(node):
        return None
    text = _string(node.get_text(" ", strip=True))
    if not text or len(text) > 120 or has_explicit_numbered_usage_marker(text):
        return None
    return text if section_heading_category(text) == "usage" else None


def _looks_like_dom_heading(node: Tag) -> bool:
    if node.name in {"h2", "h3", "h4", "h5", "h6", "summary"}:
        return True
    if _node_attribute_text(node, "role") == "heading":
        return True
    marker = " ".join(
        value
        for attribute in ("class", "id", "data-section", "data-testid", "data-component")
        if (value := _node_attribute_text(node, attribute))
    )
    return bool(re.search(r"(?:^|[-_\s])(?:header|heading|title)(?:$|[-_\s])", marker, re.IGNORECASE))


def _declared_usage_cards_for_heading(heading: Tag) -> tuple[Tag, list[tuple[int, str]]] | None:
    """Find the nearest source container whose cards follow ``heading``."""

    current = heading.parent
    while isinstance(current, Tag):
        cards = _declared_usage_cards_in_container(current, heading)
        if cards:
            return current, cards
        if current.name in {"main", "body", "html", "[document]"}:
            break
        current = current.parent
    return None


def _declared_usage_cards_in_container(container: Tag, heading: Tag) -> list[tuple[int, str]]:
    """Keep the first source-owned card sequence in document order.

    Accessible labels and visible ordinal text can coexist in a card grid, so
    cards are read in one pass instead of treating either channel as an all-or-
    nothing source.  The scan also stops at a separate FAQ/usage boundary or a
    new ordinal sequence; otherwise a later FAQ card inside a broad ``main``
    container can corrupt the procedure that follows the original heading.
    """

    nodes = list(container.find_all(True))
    positions = {id(node): index for index, node in enumerate(nodes)}
    heading_position = positions.get(id(heading))
    if heading_position is None:
        return []

    cards: list[tuple[int, str]] = []
    card_nodes: list[Tag] = []
    for node in nodes[heading_position + 1 :]:
        if _is_separate_usage_sequence_boundary(node, heading):
            break
        if any(_dom_node_contains(card_node, node) for card_node in card_nodes):
            continue
        if (card := _declared_usage_card(node)) is None:
            continue
        ordinal, text = card
        existing = next((current for current in cards if current[0] == ordinal), None)
        if existing is not None:
            # Repeated markup for the same visible card is harmless; a
            # different body at the same ordinal begins a separate sequence
            # (commonly a later FAQ) and must not be merged into this one.
            if _usage_sequence_source_key(existing[1]) == _usage_sequence_source_key(text):
                continue
            break
        cards.append(card)
        card_nodes.append(node)
    return cards


def _declared_usage_card(node: Tag) -> tuple[int, str] | None:
    """Return one semantic card without promoting its wrapper as a card."""

    if card := _declared_usage_card_from_attributes(node):
        return card
    if _has_nested_declared_usage_card(node):
        return None
    return _declared_usage_card_from_text(node)


def _has_nested_declared_usage_card(node: Tag) -> bool:
    """A wrapper containing numbered descendants is not itself a step card."""

    return any(
        _declared_usage_card_from_attributes(descendant) is not None
        or _declared_usage_card_from_text(descendant) is not None
        for descendant in node.find_all(True)
    )


def _is_separate_usage_sequence_boundary(node: Tag, heading: Tag) -> bool:
    """Recognize source regions that cannot belong to ``heading``'s cards."""

    if _dom_node_contains(node, heading):
        return False
    if node.name == "details" or _is_faq_like_dom_region(node):
        return True
    return _dom_usage_heading_text(node) is not None


def _is_faq_like_dom_region(node: Tag) -> bool:
    marker = " ".join(
        value
        for attribute in ("class", "id", "data-section", "data-testid", "data-component", "role", "aria-label")
        if (value := _node_attribute_text(node, attribute))
    )
    return bool(re.search(r"(?:faq|frequently[-_\s]*asked|question(?:s)?|answer(?:s)?|accordion|질문|답변)", marker, re.I))


def _dom_node_contains(ancestor: Tag, node: Tag) -> bool:
    current: Tag | None = node
    while current is not None:
        if current is ancestor:
            return True
        parent = current.parent
        current = parent if isinstance(parent, Tag) else None
    return False


def _declared_usage_card_from_attributes(node: Tag) -> tuple[int, str] | None:
    for attribute in ("aria-label", "data-step", "data-step-number", "data-step-index", "data-index", "data-order"):
        if (label := _node_attribute_text(node, attribute)) is None:
            continue
        if (ordinal := _declared_usage_ordinal(label)) is None:
            continue
        body = _declared_usage_card_body(node, ordinal, fallback=label)
        if body:
            return ordinal, body
    return None


def _declared_usage_card_from_text(node: Tag) -> tuple[int, str] | None:
    text = _string(node.get_text(" ", strip=True))
    if not text or (ordinal := _declared_usage_ordinal(text)) is None:
        return None
    body = _declared_usage_card_body(node, ordinal, fallback=text)
    return (ordinal, body) if body else None


def _declared_usage_ordinal(value: str) -> int | None:
    match = re.match(r"^\s*(?:step\s*)?(\d+)\s*(?:단계|段階)?(?:[.):、-]|\s|$)", value, re.IGNORECASE)
    if match is None:
        return None
    ordinal = int(match.group(1))
    return ordinal if ordinal >= 1 else None


def _declared_usage_card_body(node: Tag, ordinal: int, *, fallback: str) -> str | None:
    text = _string(node.get_text(" ", strip=True)) or fallback
    body = re.sub(
        rf"^\s*(?:step\s*)?{ordinal}\s*(?:단계|段階)?\s*(?:[.):、-]\s*)?",
        "",
        text,
        flags=re.IGNORECASE,
    ).strip()
    return _string(body)


def _visible_text(soup: BeautifulSoup) -> str:
    return re.sub(r"\s+", " ", soup.get_text(" ", strip=True)).strip()


def _select_name(
    soup: BeautifulSoup, product: Mapping[str, Any], records: Sequence[Mapping[str, Any]], source: str
) -> tuple[str, str]:
    handle = _handle(source)
    heading = soup.find("h1")
    candidates = [
        (_string(product.get("name")), "jsonLd", 78),
        (
            _first_client_text(
                records,
                ("onlineProdName", "productName", "prodName", "name", "title"),
                _likely_product_name,
            ),
            "dom",
            82,
        ),
        (_meta(soup, "og:title"), "meta", 92),
        (_meta(soup, "twitter:title"), "meta", 90),
        (_string(heading.get_text(" ", strip=True)) if isinstance(heading, Tag) else None, "dom", 88),
        (_string(soup.title.get_text(" ", strip=True)) if soup.title else None, "dom", 84),
    ]
    selected: tuple[str, str] | None = None
    best_score = float("-inf")
    for raw_candidate, source_name, priority in candidates:
        candidate = _clean_product_name(raw_candidate)
        if not candidate or not _likely_product_name(candidate):
            continue
        score = priority + _score_name_against_handle(candidate, handle)
        if score > best_score:
            selected = candidate, source_name
            best_score = score
    if selected is not None:
        return selected
    return "Untitled product", "dom"


def _select_brand(
    soup: BeautifulSoup,
    product: Mapping[str, Any],
    records: Sequence[Mapping[str, Any]],
    fallback_records: Sequence[Mapping[str, Any]],
) -> str | None:
    return (
        _brand(product.get("brand"))
        or _first_client_brand(records)
        or _first_client_brand(fallback_records)
        or _meta(soup, "product:brand")
    )


def _brand(value: Any) -> str | None:
    if direct := _string(value):
        return direct
    values = as_list(value)
    if values is not None:
        return next((brand for item in values if (brand := _brand(item))), None)
    mapping = as_mapping(value)
    if mapping is None:
        return None
    return next(
        (brand for key in ("name", "brandName", "brandNm", "title", "label") if (brand := _string(mapping.get(key)))),
        None,
    )


def _first_client_text(
    records: Sequence[Mapping[str, Any]], keys: Sequence[str], predicate: Callable[[str], bool] | None = None
) -> str | None:
    """Return the first record-level value which passes the TS field predicate."""

    for record in records:
        for key in keys:
            # TS ``firstKnownValue`` consumes the first present alias, even
            # when that value normalizes to an empty string.  Do not fall
            # through to a lower-priority sibling in this same record.
            if key not in record:
                continue
            value = _string(record[key])
            if value:
                text = _html_to_text(value) if re.search(r"<[^>]+>", value) else value
                if not predicate or predicate(text):
                    return text
            # ``firstKnownValue`` consumes the first known alias in a record.
            # An empty or rejected value advances to the next record rather
            # than letting a lower-priority sibling mask record ordering.
            break
    return None


def _first_client_brand(records: Sequence[Mapping[str, Any]]) -> str | None:
    for record in records:
        for key in (
            "brand",
            "brandName",
            "brandNm",
            "brndName",
            "brndNm",
            "manufacturer",
            "manufacturerName",
            "maker",
            "vendor",
        ):
            if brand := _brand(record.get(key)):
                return brand
    return None


def _select_description(
    soup: BeautifulSoup,
    product: Mapping[str, Any],
    records: Sequence[Mapping[str, Any]],
    body_text: str,
    source: str,
) -> str | None:
    dom_description = next(
        (
            value
            for node in soup.select("[class*='description'], [class*='summary'], [data-product-description]")
            if (value := _string(node.get_text(" ", strip=True))) and len(value) >= 24 and not _COMMERCE_NOISE.search(value)
        ),
        None,
    )
    return (
        _string(product.get("description"))
        or _first_client_text(
            records,
            ("linePromoDesc", "description", "desc", "summary", "shortDescription"),
            _is_client_product_description,
        )
        or _meta(soup, "description")
        or _meta(soup, "og:description")
        or dom_description
        or _body_description(body_text)
    )


def _is_client_product_description(value: str) -> bool:
    """Accept grammatical prose from a scoped product record without a category word list."""

    words = re.findall(r"[A-Za-z]+(?:[-'][A-Za-z]+)*|[가-힣]+", value)
    review_noise = re.search(
        r"\b(?:review|rating|customer|stars?|verified\s+(?:buyer|customer)|repurchase)\b|리뷰|후기|평점|고객\s*후기|재구매",
        value,
        re.I,
    )
    return len(value) >= 20 and len(words) >= 4 and not _COMMERCE_NOISE.search(value) and not review_noise


def _body_description(body_text: str) -> str | None:
    """Use readable page copy only as the last description fallback."""

    cleaned = re.sub(r"\s+", " ", body_text).strip()
    if len(cleaned) < 24:
        return None
    # A concise first sentence/paragraph is safer than serializing the entire
    # product page as a description.  Currency-only and commerce copy has
    # already been pruned by the page-noise pass.
    sentence = re.split(r"(?<=[.!?。])\s+", cleaned, maxsplit=1)[0].strip()
    return sentence if len(sentence) >= 24 and not _COMMERCE_NOISE.search(sentence) else None


def _handle(source: str) -> str | None:
    try:
        parts = [part for part in urlparse(source).path.split("/") if part]
    except ValueError:
        return None
    product_index = next((index for index, part in enumerate(parts) if part.casefold() == "products"), -1)
    return unquote(parts[product_index + 1]) if 0 <= product_index < len(parts) - 1 else None


def _clean_product_name(value: str | None) -> str | None:
    if not value:
        return None
    compact = re.sub(r"\s+", " ", value).strip()
    compact = re.sub(r"\s+\|\s+.*$", "", compact)
    # Storefront chrome often appends an arbitrary brand before "Official
    # Store/Site". Strip that generic suffix instead of recognizing a
    # particular brand name; the remaining title is later checked against the
    # product URL handle by the normal name-selection logic.
    compact = re.sub(
        r"\s+[–—-]\s+(?:[^|–—-]{1,80}\s+)?official\s+(?:store|site)\b.*$",
        "",
        compact,
        flags=re.I,
    )
    return compact or None


def _likely_product_name(value: str) -> bool:
    return 2 <= len(value) <= 140 and not _COMMERCE_NOISE.search(value) and not re.search(
        r"(?:review|rating|customer|stars|리뷰|평점)", value, re.IGNORECASE
    )


def _score_name_against_handle(name: str, handle: str | None) -> int:
    terms = _handle_terms(handle)
    if not terms:
        return 0
    normalized_name = _fingerprint(name)
    normalized_handle = _fingerprint(" ".join(terms))
    if normalized_name == normalized_handle:
        return 180
    matched = [term for term in terms if term in normalized_name]
    if len(matched) == len(terms):
        return 160 + len(matched) * 4
    if len(matched) >= (len(terms) * 3 + 4) // 5:
        return 86 + len(matched) * 6
    return len(matched) * 6


def _handle_terms(handle: str | None) -> list[str]:
    return [term for term in _fingerprint(unquote(handle or "")).split() if len(term) >= 3 and not term.isdigit()]


def _fingerprint(value: str) -> str:
    return re.sub(r"[^\w]+", " ", re.sub(r"\s+", " ", value).casefold(), flags=re.UNICODE).strip()


_CLIENT_HANDLE_KEYS = ("handle", "productHandle", "prodHandle", "onlineProdHandle", "slug")
_CLIENT_URL_KEYS = ("url", "href", "productUrl", "product_url", "link", "canonicalUrl", "canonical_url")


def _record_matches_handle(record: Mapping[str, Any], handle: str) -> bool:
    """Apply the retained client-state direct/URL/name PDP matching order."""

    normalized_handle = _fingerprint(unquote(handle))
    if not normalized_handle:
        return False
    for key in _CLIENT_HANDLE_KEYS:
        candidate = _string(record.get(key))
        if candidate and _fingerprint(unquote(candidate)) == normalized_handle:
            return True
    for key in _CLIENT_URL_KEYS:
        candidate = _string(record.get(key))
        if not candidate:
            continue
        candidate_handle = _handle(candidate)
        if candidate_handle and _fingerprint(unquote(candidate_handle)) == normalized_handle:
            return True
        if normalized_handle in _fingerprint(candidate):
            return True
    name = (
        _string(record.get("onlineProdName"))
        or _string(record.get("productName"))
        or _string(record.get("prodName"))
        or _string(record.get("name"))
        or _string(record.get("title"))
        or ""
    )
    return _score_name_against_handle(name, handle) >= 120


def _records_for_source(records: Sequence[Mapping[str, Any]], handle: str | None) -> Sequence[Mapping[str, Any]]:
    if handle:
        matched = [record for record in records if _record_matches_handle(record, handle)]
        if matched:
            return matched
    return records


def _client_state_records(soup: BeautifulSoup, source: str) -> list[dict[str, Any]]:
    values: list[Any] = []
    for script in soup.find_all("script"):
        raw = script.string or script.get_text()
        parsed = _parse_json_text(raw)
        if parsed is not None:
            values.append(parsed)
        values.extend(_assigned_json_states(raw))
        values.extend(_theme_product_states(raw, source))
    records: list[dict[str, Any]] = []
    seen: set[int] = set()

    def visit(value: Any, depth: int = 0) -> None:
        if depth > 10 or id(value) in seen:
            return
        mapping = as_mapping(value)
        if mapping is not None:
            seen.add(id(mapping))
            record = dict(mapping)
            # Theme/Swym assignments are admitted only after the URL-handle
            # gate in ``_theme_product_states``.  Their public fields are often
            # just title/description/image rather than conventional
            # ``productInfo`` keys, so applying the generic heuristic again
            # would drop an otherwise verified PDP record.
            if record.get("__embeddedTheme") is True or _is_product_state_record(record) or _is_review_state_record(record):
                records.append(record)
            for child in record.values():
                if isinstance(child, str):
                    decoded = _parse_json_text(child)
                    if decoded is not None:
                        visit(decoded, depth + 1)
                else:
                    visit(child, depth + 1)
        elif (items := as_list(value)) is not None:
            seen.add(id(items))
            for child in items:
                visit(child, depth + 1)

    for value in values:
        visit(value)
    return records


_THEME_PRODUCT_ASSIGNMENT = re.compile(
    r"(?:theme\.products\.update\s*\(\s*\{|theme\.products\.list\s*\[[^\]]+\]\s*=\s*\{|window\.SwymProductInfo\.product\s*=\s*\{)",
    re.IGNORECASE,
)


def _theme_product_states(script: str, source: str) -> list[Mapping[str, Any]]:
    """Read handle-scoped Shopify/Swym product object assignments."""

    handle = _handle(source)
    values: list[Mapping[str, Any]] = []
    for match in _THEME_PRODUCT_ASSIGNMENT.finditer(script):
        start = script.find("{", match.start())
        literal = _balanced_object_literal(script, start)
        parsed = _parse_embedded_object_literal(literal) if literal else None
        mapping = as_mapping(parsed)
        if mapping is None:
            continue
        record = dict(mapping)
        record_handle = _string(record.get("handle"))
        name = _string(record.get("title")) or _string(record.get("name")) or ""
        matches_handle = bool(handle and record_handle and record_handle.casefold() == handle.casefold())
        matches_name = bool(handle and _score_name_against_handle(name, handle) >= 120)
        if matches_handle or matches_name:
            record["__embeddedTheme"] = True
            values.append(record)
    return values


def _is_product_state_record(record: Mapping[str, Any]) -> bool:
    keys = " ".join(_normalize_state_key(key) for key in record)
    product_fields = (
        "online prod name",
        "product name",
        "prod name",
        "line promo desc",
        "price info",
        "online images",
        "detail desc",
        "disclosures",
        "ingredients",
        "how to use",
        "benefits",
        "product info",
        "product detail",
    )
    has_noun = bool(re.search(r"(?:product|prod|goods|item|sku|상품|제품|online prod)", keys, re.I))
    has_data = bool(re.search(r"(?:name|title|price|image|ingredient|description|desc|summary|disclosure)", keys, re.I))
    return any(field in keys for field in product_fields) or has_noun and has_data


def _is_review_state_record(record: Mapping[str, Any]) -> bool:
    keys = " ".join(_normalize_state_key(key) for key in record)
    return bool(re.search(r"(?:review|rating|scope|star|평점|별점|리뷰|후기)", keys, re.I))


def _normalize_state_key(key: object) -> str:
    return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", str(key)).replace("_", " ").replace("-", " ").casefold()


_CLIENT_STATE_ASSIGNMENT = re.compile(
    r"(?:window\.)?(?:__INITIAL_STATE__|__PRELOADED_STATE__|__PRODUCT__|initialState|product(?:Detail|Info|Data|State)?)\s*=\s*\{",
    re.IGNORECASE,
)


def _assigned_json_states(script: str) -> list[Mapping[str, Any] | list[Any]]:
    values: list[Mapping[str, Any] | list[Any]] = []
    for match in _CLIENT_STATE_ASSIGNMENT.finditer(script):
        start = script.find("{", match.start())
        literal = _balanced_object_literal(script, start)
        parsed = _parse_embedded_object_literal(literal) if literal else None
        if parsed is not None:
            values.append(parsed)
    return values


def _balanced_object_literal(value: str, start: int) -> str | None:
    if start < 0 or start >= len(value) or value[start] != "{":
        return None
    depth = 0
    quote_character: str | None = None
    escaped = False
    for index in range(start, len(value)):
        character = value[index]
        if quote_character:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == quote_character:
                quote_character = None
            continue
        if character in {'"', "'", "`"}:
            quote_character = character
        elif character == "{":
            depth += 1
        elif character == "}":
            depth -= 1
            if depth == 0:
                return value[start : index + 1]
    return None


def _parse_embedded_object_literal(literal: str) -> Mapping[str, Any] | list[Any] | None:
    parsed = _parse_json_text(literal)
    if parsed is not None:
        return parsed
    json_like = re.sub(r"([{,]\s*)([A-Za-z_$][\w$]*)\s*:", r'\1"\2":', literal)
    json_like = re.sub(r",\s*([}\]])", r"\1", json_like)
    return _parse_json_text(json_like)


def _first_client_price(records: Sequence[Mapping[str, Any]]) -> str | None:
    for record in records:
        values: list[object] = [
            record.get("discountedPrice"),
            record.get("salePrice"),
            record.get("price"),
            record.get("amount"),
            record.get("beforeSalePrice"),
        ]
        for container_key in ("priceInfo", "onlinePriceInfo", "prodPriceInfo"):
            container = _as_mapping(record.get(container_key))
            nested = _as_mapping(container.get("priceInfo")) or container
            values.extend(
                [
                    nested.get("discountedPrice"),
                    nested.get("salePrice"),
                    nested.get("price"),
                    nested.get("amount"),
                    nested.get("beforeSalePrice"),
                ]
            )
        for value in values:
            if text := _string(value):
                return text
    return None


def _first_client_currency(records: Sequence[Mapping[str, Any]]) -> str | None:
    for record in records:
        for key in ("priceCurrency", "currency", "currencyCode"):
            if value := _string(record.get(key)):
                return value
        for container_key in ("currencyInfo", "onlinePriceInfo", "prodPriceInfo"):
            container = _as_mapping(record.get(container_key))
            currency = _as_mapping(container.get("currencyInfo")) or container
            if currency.get("isWon") is True:
                return "KRW"
    return None


def _client_images(records: Sequence[Mapping[str, Any]]) -> list[Any]:
    images: list[Any] = []
    for record in records:
        for key in ("image", "images", "onlineImages", "media"):
            images.extend(_array(record.get(key)))
        images.extend(record.get(key) for key in ("imgUrl", "imageUrl", "thumbnailUrl"))
        for key in ("detailDesc", "bodyHtml", "body_html"):
            html = _string(record.get(key))
            if html:
                images.extend(_html_image_values(html))
    return images


def _client_options(records: Sequence[Mapping[str, Any]]) -> list[str]:
    """Read the aliases exposed by distributed PDP client-state records."""

    values: list[Any] = []
    for record in records:
        values.extend(_values(record.get("optionName")))
        values.extend(_values(record.get("optionValue")))
        for product in _array(record.get("products")):
            mapping = as_mapping(product)
            if mapping is not None:
                values.extend(
                    mapping.get(key) for key in ("prodName", "productName", "name") if mapping.get(key) is not None
                )
        for variant in _array(record.get("variants")):
            mapping = as_mapping(variant)
            if mapping is not None:
                values.extend(mapping.get(key) for key in ("title", "name", "optionName") if mapping.get(key) is not None)
    return [value for value in _unique(values) if _is_product_option_text(value)]


def _is_product_option_text(value: str) -> bool:
    """Use the retained TS option gate before publishing client-state aliases."""

    text = _string(value)
    if not text or len(text) > 80 or _is_non_product_option_commerce(text):
        return False
    if _OPTION_PLACEHOLDER.fullmatch(text):
        return False
    return bool(_OPTION_PRODUCT_SIGNAL.search(text))


def _is_non_product_option_commerce(value: str) -> bool:
    if _OPTION_HARD_COMMERCE.search(value):
        return True
    return len(value) > 120 and bool(_OPTION_POLICY_COMMERCE.search(value)) and len(_OPTION_STRONG_PRODUCT_CARE.findall(value)) < 2


def _html_image_values(html: str) -> list[str]:
    fragment = BeautifulSoup(html, "html.parser")
    values = _node_image_values(fragment, html)
    return values


def _document_image_values(soup: BeautifulSoup, raw_html: str) -> list[str]:
    """Read markup and raw-script image URLs in retained DOM order."""

    return _node_image_values(soup, raw_html)


def _raw_script_ocr_contexts(raw_html: str, source: str) -> list[tuple[str, str, int]]:
    """Return raw image URLs only when their own script context supports OCR.

    Public source media intentionally retains broad script discovery, but TS
    treats raw URLs as contextual OCR candidates before falling back to those
    broad fields.  In particular, an adjacent client-state object with a
    different product handle must not become a vision request for this PDP.
    """

    source_handle = _handle(source)
    contexts: list[tuple[str, str, int]] = []
    for script_match in re.finditer(r"<script\b[^>]*>([\s\S]*?)</script\s*>", raw_html, re.I):
        script = script_match.group(1).replace("\\/", "/").replace("\\u002F", "/")
        for match in re.finditer(r"[\"']((?:https?:)?//[^\"']+|(?:\.{1,2}/|/)[^\"']+)[\"']", script):
            raw_image = match.group(1).replace("&amp;", "&")
            image = _absolute_url(raw_image, source)
            # This helper is used only after pruned DOM/raw-markup contextual
            # candidates are exhausted.  At that explicit fallback boundary
            # TS applies URL support, not contextual commerce markers, so a
            # supported script-only routine-builder PNG remains eligible.
            if not image or not _looks_like_image_url(raw_image):
                continue
            owner = _raw_image_owner_record(script, match.start(1))
            if (
                source_handle
                and owner is not None
                and _record_has_explicit_handle(owner)
                and not _record_matches_handle(owner, source_handle)
            ):
                continue
            radius = 900
            start, end = max(0, match.start(1) - radius), min(len(script), match.end(1) + radius)
            contexts.append((image, script[start:end], script_match.start(1) + match.start(1)))
    return contexts


def _raw_markup_ocr_contexts(markup: str, source: str) -> list[tuple[str, str, int]]:
    """Collect contextual URLs serialized in an already-pruned page DOM.

    The retained service combines ordinary DOM media with URLs embedded in
    retained attributes (for example a JSON ``data-image-payload``).  It does
    not reach back into the original response scripts after page chrome has
    been removed, so strip scripts defensively even when this helper is used
    directly in a unit-level call.
    """

    without_scripts = re.sub(r"<script\b[^>]*>[\s\S]*?</script\s*>", " ", markup, flags=re.IGNORECASE)
    contexts: list[tuple[str, str, int]] = []
    seen: set[tuple[str, int]] = set()
    # HTML attribute values may hold JSON escaped with ``&quot;``.  Stop at
    # either a physical or entity quote rather than accidentally treating the
    # rest of that attribute as URL path text.
    pattern = re.compile(r"(?:https?:)?//[^\s\"'<>]+|(?:\.{1,2}/|/)[^\s\"'<>]+", re.IGNORECASE)
    for match in pattern.finditer(without_scripts):
        raw_image = re.split(r"&(?!amp;)(?:quot|apos|lt|gt);", match.group(0), maxsplit=1, flags=re.IGNORECASE)[0]
        raw_image = raw_image.rstrip(".,;:)}]>")
        image = _absolute_url(raw_image.replace("&amp;", "&"), source)
        if not image or not _looks_like_image_url(raw_image) or _excluded_image_marker(raw_image):
            continue
        key = (image, match.start())
        if key in seen:
            continue
        seen.add(key)
        radius = 900
        start, end = max(0, match.start() - radius), min(len(without_scripts), match.end() + radius)
        contexts.append((image, without_scripts[start:end], match.start()))
    return contexts


def _raw_image_owner_record(script: str, image_position: int) -> Mapping[str, Any] | None:
    """Find the smallest enclosing client-state object which declares a handle."""

    best: tuple[int, Mapping[str, Any]] | None = None
    for match in re.finditer(r"\{", script):
        literal = _balanced_object_literal(script, match.start())
        if literal is None:
            continue
        end = match.start() + len(literal)
        if not match.start() <= image_position < end:
            continue
        record = as_mapping(_parse_embedded_object_literal(literal))
        if record is None or not _record_has_explicit_handle(record):
            continue
        if best is None or len(literal) < best[0]:
            best = (len(literal), record)
    return best[1] if best is not None else None


def _record_has_explicit_handle(record: Mapping[str, Any]) -> bool:
    return any(_string(record.get(key)) for key in _CLIENT_HANDLE_KEYS)


def _node_image_values(soup: BeautifulSoup, raw_html: str) -> list[str]:
    values: list[str] = []
    for node in soup.select("img, picture source, source"):
        marker = " ".join(
            [
                str(node.get("class") or ""),
                str(node.get("id") or ""),
                str(node.get("alt") or ""),
                str(node.get("data-testid") or ""),
            ]
        )
        if _excluded_image_marker(marker):
            continue
        for attribute in (
            "src",
            "data-src",
            "data-lazy-src",
            "data-original",
            "data-zoom-image",
            "data-zoom",
            "data-image",
            "data-url",
            "data-mobile-src",
            "data-pc-src",
            "data-desktop-src",
        ):
            value = _string(node.get(attribute))
            if value:
                values.append(value)
        srcset = _string(node.get("srcset")) or _string(node.get("data-srcset"))
        if srcset:
            values.extend(_srcset_values(srcset))
    # React/Shopify state often stores escaped image URLs in script strings.
    # Restrict to plausible image extensions / CDN image query values so normal
    # page hyperlinks do not become OCR targets.
    script_texts = [script.string or script.get_text() for script in soup.find_all("script")]
    # The service prunes scripts before image discovery, so retain raw document
    # script bodies as a parallel evidence source.
    script_texts.extend(re.findall(r"<script\b[^>]*>([\s\S]*?)</script\s*>", raw_html, re.I))
    for script_text in script_texts:
        raw_script = script_text.replace("\\/", "/").replace("\\u002F", "/")
        # Keep spaces in query/path values; WHATWG URL serialization encodes
        # them later.  Looking only inside quoted script literals avoids broad
        # page-text false positives while retaining escaped rich state.
        for raw in re.findall(r"[\"']((?:https?:)?//[^\"']+|(?:\.{1,2}/|/)[^\"']+)[\"']", raw_script):
            value = raw.replace("&amp;", "&")
            if _looks_like_image_url(value) and not _excluded_image_marker(value):
                values.append(value)
    return _unique(values)


def _srcset_values(value: str) -> list[str]:
    return [part.strip().split()[0] for part in value.split(",") if part.strip().split()]


def _looks_like_image_url(value: str) -> bool:
    return bool(re.search(r"(?:\.(?:avif|webp|png|jpe?g|gif)(?:[?#]|$)|(?:image|media|cdn|upload|detail)[^\"']*)", value, re.I))


def _is_supported_ocr_image_url(value: str) -> bool:
    """Match the TypeScript explicit OCR fallback's supported-image boundary."""

    try:
        parsed = urlsplit(value)
    except ValueError:
        return False
    if parsed.scheme not in {"http", "https"}:
        return False
    path = parsed.path
    lowered = value.casefold()
    if re.search(r"fileupload/reviews|/reviews?/", lowered):
        return False
    if re.search(r"\.(?:svg|gif)$", path, re.IGNORECASE) or path.endswith("."):
        return False
    return bool(
        re.search(r"\.(?:jpe?g|png|webp|avif)$", path, re.IGNORECASE)
        or re.search(r"/(?:upload/product|dspimg|detail|pdp|product|goods|contents)", lowered)
    )


def _excluded_image_marker(value: str) -> bool:
    return bool(
        re.search(
            r"recommend|related|recent|product[-_\s]*(?:tile|card)|routine[-_\s]*builder|quick\s*add|review|ugc|rating|"
            r"reward|offer|promo|promotion|gift|sample|bundle|cart|checkout|shipping|return|footer|header|"
            r"navigation|nav|menu|logo|icon|account|search|wishlist|collection|blog|article|social|instagram|tiktok|youtube|"
            r"추천|관련\s*상품|리뷰|후기|혜택|오퍼|프로모션|장바구니|배송|반품|푸터|헤더|메뉴|검색|위시",
            value,
            re.I,
        )
    )


def _html_sections(soup: BeautifulSoup) -> list[dict[str, Any]]:
    sections: list[dict[str, Any]] = []
    nodes = list(soup.find_all(["section", "details"]))
    for node in nodes:
        if _is_routed_non_product_section(node):
            continue
        title_node = node.find(["h2", "h3", "summary", "button"])
        title = _string(title_node.get_text(" ", strip=True)) if isinstance(title_node, Tag) else "Product details"
        text = _node_text_without_heading(node, title_node)
        section = _section(title or "Product details", text)
        if section:
            sections.append(section)
    for button in soup.select("button[aria-controls]"):
        target_id = _string(button.get("aria-controls"))
        target = soup.find(id=target_id) if target_id else None
        if (
            isinstance(target, Tag)
            and not _is_routed_non_product_section(button)
            and not _is_routed_non_product_section(target)
        ):
            section = _section(button.get_text(" ", strip=True), target.get_text(" ", strip=True))
            if section:
                sections.append(section)
    return _unique_sections(sections)


def _is_routed_non_product_section(node: Tag) -> bool:
    """Reject explicitly routed recommendation UI before it can impersonate usage.

    A PDP can visually contain a numbered routine made from product cards.  Its
    DOM role/identifier is stronger source structure than the superficial
    imperative wording inside those cards, so retain actual product sections
    and drop recommendation/cross-sell containers at ingestion.
    """

    context: list[str] = []
    current: Tag | None = node
    while current is not None:
        for key in ("id", "class", "data-section", "data-testid", "data-component", "aria-label"):
            value = current.get(key)
            if isinstance(value, list):
                context.extend(str(item) for item in value)
            elif isinstance(value, str):
                context.append(value)
        parent = current.parent
        current = parent if isinstance(parent, Tag) else None
    return bool(_COMMERCE_OCR_CONTEXT.search(" ".join(context)))


def _node_text_without_heading(node: Tag, heading: Tag | None) -> str:
    clone = BeautifulSoup(str(node), "html.parser")
    if heading and (copied_heading := clone.find(heading.name)):
        copied_heading.decompose()
    return re.sub(r"\s+", " ", clone.get_text(" ", strip=True)).strip()


def _section(title: str, text: str, keywords: Sequence[Mapping[str, Any]] = ()) -> dict[str, Any] | None:
    cleaned_title = _string(title)
    cleaned_text = _string(text)
    if not cleaned_title or not cleaned_text or _COMMERCE_NOISE.search(cleaned_text):
        return None
    category = _category(cleaned_title, cleaned_text, keywords)
    bullets = _bullets(cleaned_text)
    return {"title": cleaned_title, "category": category, "text": cleaned_text, "bullets": bullets}


def _category(title: str, text: str, keywords: Sequence[Mapping[str, Any]] = ()) -> str:
    # A source-declared ritual/routine/directions heading establishes usage
    # before incidental value language in its procedure text can claim it.
    if section_heading_category(title) == "usage":
        return "usage"
    lowered = f"{title} {text}".casefold()
    for needle, category in _CATEGORY_KEYS:
        if needle.casefold() in lowered:
            return category
    return _keyword_category(keywords)


def _keyword_category(keywords: Sequence[Mapping[str, Any]]) -> str:
    """Use the dominant attached OCR keyword role when copy/title is neutral."""

    eligible = {"benefit", "effect", "ingredient", "usage", "faq", "review", "metric"}
    ranked: dict[str, float] = {}
    for keyword in keywords:
        category = _string(keyword.get("category"))
        if category not in eligible:
            continue
        confidence = keyword.get("confidence")
        weight = float(confidence) if isinstance(confidence, int | float) and not isinstance(confidence, bool) else 0.0
        ranked[category] = ranked.get(category, 0.0) + weight
    return max(ranked, key=ranked.__getitem__) if ranked else "unknown"


def _keyword_mappings(value: object) -> list[Mapping[str, Any]]:
    return [mapping for raw in _array(value) if (mapping := as_mapping(raw)) is not None]


def _bullets(text: str) -> list[str]:
    return _unique(re.split(r"(?:\s*[•;]\s*|\.(?=\s+[A-Z가-힣]))", text))[:6]


def _unique_sections(sections: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for section in sections:
        # TS section identity is semantic category plus normalized body, not
        # the display heading.  Two source-backed interpretations with the
        # same title/text but distinct categories must both survive.
        category = _string(section.get("category")) or "unknown"
        text = _string(section.get("text")) or ""
        key = (category.casefold(), _fingerprint(text))
        if key not in seen:
            seen.add(key)
            output.append(section)
    # Section count is source structure: a late numbered ritual row can be a
    # required continuation rather than low-value page noise. Keep semantic
    # deduplication here, but leave any presentation limits to their consumer.
    return output


def _faq_items(soup: BeautifulSoup, faq_node: Mapping[str, Any]) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    for question in _array(faq_node.get("mainEntity")):
        q = _as_mapping(question)
        answer = _as_mapping(q.get("acceptedAnswer"))
        question_text, answer_text = _string(q.get("name")), _string(answer.get("text"))
        if question_text and answer_text:
            items.append({"question": question_text, "answer": answer_text})
    for detail in soup.find_all("details"):
        summary = detail.find("summary")
        question_text = summary.get_text(" ", strip=True) if isinstance(summary, Tag) else ""
        answer_text = _node_text_without_heading(detail, summary if isinstance(summary, Tag) else None)
        if question_text.endswith("?") and answer_text:
            items.append({"question": question_text, "answer": answer_text})
    for button in soup.select("button[aria-controls]"):
        question_text = button.get_text(" ", strip=True)
        target_id = _string(button.get("aria-controls"))
        target = soup.find(id=target_id) if target_id else None
        answer_text = target.get_text(" ", strip=True) if isinstance(target, Tag) else ""
        if (
            "?" in question_text or re.search(r"(?:should i|can i|how |when )", question_text, re.IGNORECASE)
        ) and answer_text:
            items.append({"question": question_text, "answer": answer_text})
    output: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for item in items:
        key = (item["question"].casefold(), item["answer"].casefold())
        if key not in seen:
            seen.add(key)
            output.append(item)
    return output[:12]


def _options_from_html(
    soup: BeautifulSoup,
    product: Mapping[str, Any],
    records: Sequence[Mapping[str, Any]],
    fallback_records: Sequence[Mapping[str, Any]] = (),
) -> list[str]:
    options = [option.get_text(" ", strip=True) for option in soup.select("select option")]
    options.extend(_array(product.get("additionalProperty")))
    options.extend(_client_options(records) or _client_options(fallback_records))
    return [option for option in _unique(options) if _is_product_option_text(option)][:12]


def _profile_from_sections(**kwargs: Any) -> dict[str, Any]:
    sections = cast(list[dict[str, Any]], kwargs.pop("sections"))
    profile = {**kwargs, "sections": sections}
    for key, category in (
        ("benefits", "benefit"),
        ("effects", "effect"),
        ("ingredients", "ingredient"),
        ("usage", "usage"),
    ):
        profile[key] = _section_values(sections, category)
    profile["metrics"] = _unique(metric for section in sections for metric in _metric_phrases(section["text"]))[:16]
    return profile


def _section_values(sections: Iterable[Mapping[str, Any]], category: str) -> list[str]:
    # Source-owned procedures have no arbitrary maximum.  The canonical
    # usage normalizer preserves explicit numbering and removes duplicates;
    # truncating here silently lost valid late steps before that stage.
    return _unique(section.get("text") for section in sections if section.get("category") == category)


def _commerce_trust(
    product: Mapping[str, Any], offer: Mapping[str, Any], references: Mapping[str, Mapping[str, Any]], source: str
) -> dict[str, Any]:
    policy = _resolve_reference(offer.get("hasMerchantReturnPolicy"), references)
    return_policy = _return_policy(policy, source)
    return _without_none(
        {
            "availability": _string(offer.get("availability")),
            "priceValidUntil": _string(offer.get("priceValidUntil")),
            "itemCondition": _string(product.get("itemCondition")),
            "returnPolicy": return_policy,
        }
    )


def _return_policy(policy: Mapping[str, Any], source: str) -> dict[str, Any] | None:
    if not policy:
        return None
    days_value = policy.get("merchantReturnDays")
    try:
        days = int(str(days_value)) if days_value is not None else None
    except ValueError:
        days = None
    result = _without_none(
        {
            "category": _string(policy.get("returnPolicyCategory")) or _string(policy.get("category")),
            "merchantReturnDays": days,
            "returnMethod": _string(policy.get("returnMethod")),
            "returnFees": _string(policy.get("returnFees")),
            "applicableCountry": _string(policy.get("applicableCountry")),
            "returnPolicyCountry": _string(policy.get("returnPolicyCountry")),
            "url": _absolute_url(
                _string(policy.get("merchantReturnLink")) or _string(policy.get("url")) or "", source
            )
            or None,
        }
    )
    return result or None


async def _apply_normalizer(
    profile: dict[str, Any], source: str, source_type: str, raw_source: Mapping[str, Any], runtime: Mapping[str, Any]
) -> tuple[dict[str, Any], dict[str, Any] | None, dict[str, Any]]:
    request = {
        "source": source,
        "sourceType": source_type,
        "rawSource": dict(raw_source),
        "bootstrapProduct": {key: value for key, value in profile.items() if key != "sections"},
        "analysisPrompt": runtime.get("analysisPrompt") or _DEFAULT_ANALYSIS_PROMPT,
        "ragDocuments": runtime.get("ragDocuments") or _DEFAULT_RAG_DOCUMENTS,
    }
    application = await normalize_extractor_product_profile_with_agent(request, runtime)
    product = application.get("product")
    product_mapping = as_mapping(product)
    merged = dict(product_mapping) if product_mapping is not None else profile
    usage = application.get("usage")
    usage_mapping = as_mapping(usage)
    return merged, (dict(usage_mapping) if usage_mapping is not None else None), application


def _html_ocr(
    soup: BeautifulSoup, source: str, images: Sequence[str], sections: Sequence[Mapping[str, Any]]
) -> dict[str, Any]:
    candidates: list[tuple[str, str]] = []
    for image in soup.select("img[data-ocr-text]"):
        # OCR line breaks encode section boundaries and chart relationships;
        # ordinary product-field cleanup intentionally collapses them, but the
        # shared OCR parser must receive the original reading-order lines.
        text = _ocr_text(image.get("data-ocr-text"))
        image_url = _string(image.get("src"))
        if text and image_url:
            candidates.append((_absolute_url(image_url, source), text))
    # DOM product-detail facts are useful fallback OCR evidence, except full ingredients lists.
    for section in sections:
        if section["category"] in {"benefit", "effect", "usage", "metric"}:
            candidates.append((f"{source}#section-{len(candidates) + 1}", section["text"]))
    return _ocr_from_pairs(candidates, images)


async def _html_ocr_with_runtime(
    soup: BeautifulSoup,
    source: str,
    images: Sequence[str],
    sections: Sequence[Mapping[str, Any]],
    product_name: str,
    runtime: Mapping[str, Any],
    pruned_markup: str,
    original_html: str,
) -> dict[str, Any]:
    """Use the shared vision/classification pipeline for every provider mode.

    DOM `data-ocr-text` and section candidates are source evidence, not a
    separate mock-only semantic implementation.  Passing them through the
    common core keeps layout/relation/semantic facts and diagnostics aligned
    with ordinary provider runs.
    """

    fallback = _html_ocr(soup, source, images, sections)
    result = await extract_image_ocr_evidence(
        {
            "source": source,
            "productName": product_name,
            "imageUrls": _select_ocr_targets(soup, images, product_name, pruned_markup, source, original_html),
            "extraCandidates": fallback["imageTexts"],
        },
        runtime,
    )
    return _runtime_ocr_result(result, fallback, images)


async def _api_ocr_with_runtime(
    source: str,
    images: Sequence[str],
    candidates: Sequence[Mapping[str, Any]],
    product_name: str,
    runtime: Mapping[str, Any],
) -> dict[str, Any]:
    fallback = _ocr_from_pairs(
        [
            (_string(candidate.get("imageUrl")) or f"{source}#api-text-{index}-1", _string(candidate.get("text")) or "")
            for index, candidate in enumerate(candidates, start=1)
        ],
        images,
    )
    # API payload images are product media, not vision-OCR targets.  Retained
    # TS behavior semantically classifies only text supplied by the API.
    result = await extract_image_ocr_evidence(
        {
            "source": source,
            "productName": product_name,
            "imageUrls": [],
            "extraCandidates": fallback["imageTexts"],
            # The retained API path sends supplied ``ocrTexts`` and generated
            # API text chunks straight to its merge/classification routine.
            # HTML vision ingress is the path with the pre-classifier product
            # evidence gate.
            "filterProductEvidence": False,
        },
        runtime,
    )
    return _runtime_ocr_result(result, fallback, images)


def _api_text_candidates(
    source: str, product: Mapping[str, Any], description: str, sections: Sequence[Mapping[str, Any]]
) -> list[dict[str, str]]:
    """Create API supplied semantic evidence; product images never enter vision OCR."""

    body_text = _html_to_text(_string(product.get("body_html")) or _string(product.get("bodyHtml")) or "")
    product_section_text = _unique(
        [
            *(_values(product.get("benefits"))),
            *(_values(product.get("effects"))),
            *(_values(product.get("ingredients"))),
            *(_values(product.get("keyIngredients"))),
            *(_values(product.get("ingredientHighlights"))),
            *(_values(product.get("usage"))),
            *(_values(product.get("howToUse"))),
            *(_values(product.get("how_to_use"))),
            *(_values(product.get("directions"))),
            *(_string(section.get("text")) or "" for section in sections),
        ]
    )
    values = _unique(
        [
            description,
            body_text,
            *(_values(product.get("summary"))),
            *(_values(product.get("highlights"))),
            *product_section_text,
        ]
    )
    output: list[dict[str, str]] = []
    for index, candidate in enumerate(values, start=1):
        # ``chunkText(text, 920).slice(0, 6)`` in TS preserves stable
        # field/chunk lineage for provider evidence-index attribution.
        for chunk_index, chunk in enumerate(_chunk_api_text(candidate, 920)[:6], start=1):
            if len(chunk) >= 24:
                output.append({"imageUrl": f"{source}#api-text-{index}-{chunk_index}", "text": chunk})
    return output


def _chunk_api_text(text: str, maximum: int) -> list[str]:
    """Port the sentence-first ``chunkText`` used by API text candidates."""

    sentences = [part.strip() for part in re.split(r"(?<=[.!?。！？])\s+", text) if part.strip()]
    chunks: list[str] = []
    current = ""
    for sentence in sentences or [text]:
        if len(f"{current} {sentence}".strip()) > maximum and current:
            chunks.append(current)
            current = sentence
        else:
            current = " ".join(part for part in (current, sentence) if part)
    if current:
        chunks.append(current[:maximum])
    return chunks


def _select_ocr_targets(
    soup: BeautifulSoup,
    images: Sequence[str],
    product_name: str,
    raw_html: str = "",
    source: str = "",
    original_html: str = "",
) -> list[str]:
    """Score detail media, retain canonical-largest responsive variants, and cap script-only input.

    ``images`` intentionally remains the broad public source-media list.  OCR
    selection is stricter: image context can prove that a raw client-state URL
    belongs to a different product, and a responsive ``srcset`` family should
    yield only its largest readable variant.
    """

    dom_contexts = _dom_ocr_contexts(soup, source)
    best: dict[str, tuple[str, int, int, int]] = {}

    def consider(image: str, context: str, source_order: int, *, contextual: bool = True) -> None:
        parsed = urlsplit(image)
        if parsed.scheme not in {"http", "https"}:
            return
        # DOM/raw-markup contextual candidates and broad explicit fallbacks
        # share the retained supported-image boundary.  Contextual relevance
        # alone cannot make a GIF/SVG a vision OCR target.
        if not _is_supported_ocr_image_url(image):
            return
        lowered = image.casefold()
        width = _image_variant_width(image)
        if 0 < width < 160:
            return
        if contextual:
            if _excluded_image_marker(lowered) or any(token in lowered for token in ("sprite", "icon", "logo", "avatar")):
                return
        score = _ocr_target_score(image, context, product_name)
        if contextual and not _should_use_contextual_ocr_target(image, context, score, product_name):
            return
        key = _canonical_ocr_image_key(image)
        current = best.get(key)
        candidate = (image, width, score, source_order)
        if (
            current is None
            or width > current[1]
            or (width == current[1] and score > current[2])
            or (width == current[1] and score == current[2] and source_order < current[3])
        ):
            best[key] = candidate

    # Page-local DOM media and URLs embedded in serialized, *pruned* markup
    # form one contextual candidate union.  This is intentionally separate
    # from the former original-script fallback: scripts were removed before
    # ``$.html()`` in TypeScript and must not be resurrected here.
    for image, (context, source_order) in dom_contexts.items():
        consider(image, context, source_order)
    for image, context, source_order in _raw_markup_ocr_contexts(raw_html, source):
        consider(image, context, 50_000 + source_order)
    used_dom_contextual_candidates = bool(best)
    if not best and original_html:
        # Retain the older script-only fallback only when the pruned DOM has
        # no contextual media at all.  This preserves target-scoped legacy
        # script assets without resurrecting scripts into a DOM/raw-markup
        # union (which would reintroduce rejected sibling-product URLs).
        for image, context, source_order in _raw_script_ocr_contexts(original_html, source):
            consider(image, context, 50_000 + source_order, contextual=False)

    if not best:
        # These are public/structured image fields, not contextual evidence:
        # match the TS fallback score with no adjacent raw-script text.
        for source_order, image in enumerate(images, start=100_000):
            consider(image, "", source_order, contextual=False)
    # TS ranks candidates by evidence score before enforcing the budget, then
    # restores document order for the request.  Cutting in source order first
    # loses a late clinical/detail visual behind an otherwise unbounded gallery.
    selected = sorted(best.values(), key=lambda item: (-item[2], item[3]))
    # TS limits broad/script fallback media to 12.  A rejected DOM gallery
    # does not make that fallback contextual, regardless of how many media
    # nodes were present in the original document.
    limit = 24 if used_dom_contextual_candidates else 12
    return [item[0] for item in sorted(selected[:limit], key=lambda item: item[3])]


def _dom_ocr_contexts(soup: BeautifulSoup, source: str) -> dict[str, tuple[str, int]]:
    """Build per-node evidence contexts instead of using a neighbouring raw tag.

    A raw radius is appropriate for client-state literals but can make an
    adjacent related-products rail contaminate a real detail image.  The TS
    implementation walks each DOM image's ancestors, so retain that locality
    for DOM-discovered URL values here.
    """

    contexts: dict[str, tuple[str, int]] = {}
    for source_order, node in enumerate(soup.select("img, picture source, source")):
        context = _dom_ocr_context(node)
        for value in _node_image_sources(node):
            absolute = _absolute_url(value, source)
            if absolute and absolute not in contexts:
                contexts[absolute] = (context, source_order)
    return contexts


def _dom_ocr_context(node: Tag) -> str:
    tokens: list[str] = []
    for attribute in ("class", "id", "data-testid", "alt", "title", "aria-label"):
        value = _node_attribute_text(node, attribute)
        if value:
            tokens.append(value)
    current = node
    for _depth in range(8):
        parent = current.parent
        if not isinstance(parent, Tag):
            break
        current = parent
        for attribute in ("class", "id", "data-testid", "aria-label"):
            value = _node_attribute_text(parent, attribute)
            if value:
                tokens.append(value)
        heading = parent.find(["h1", "h2", "h3", "h4", "h5", "h6", "summary"], recursive=False)
        if isinstance(heading, Tag):
            value = _string(heading.get_text(" ", strip=True))
            if value:
                tokens.append(value)
    return re.sub(r"\s+", " ", " ".join(tokens)).strip()[:900]


def _node_attribute_text(node: Tag, attribute: str) -> str | None:
    """BeautifulSoup represents ``class`` as a list; Cheerio returns text."""

    value: object = node.get(attribute)
    if isinstance(value, list):
        return _string(" ".join(str(item) for item in value))
    return _string(value)


def _node_image_sources(node: Tag) -> list[str]:
    values: list[str] = []
    for attribute in (
        "src",
        "data-src",
        "data-lazy-src",
        "data-original",
        "data-zoom-image",
        "data-zoom",
        "data-image",
        "data-url",
        "data-mobile-src",
        "data-pc-src",
        "data-desktop-src",
    ):
        value = _string(node.get(attribute))
        if value:
            values.append(value)
    srcset = _string(node.get("srcset")) or _string(node.get("data-srcset"))
    if srcset:
        values.extend(_srcset_values(srcset))
    return _unique(values)


def _canonical_ocr_image_key(image: str) -> str:
    try:
        parsed = urlsplit(image)
        path = re.sub(r"_(?:\d+x\d*|x\d+)(?=\.[a-z]{3,5}$)", "", parsed.path, flags=re.I)
        return f"{parsed.scheme}://{parsed.netloc}{path}".casefold()
    except ValueError:
        return re.split(r"[?#]", image, maxsplit=1)[0].casefold()


def _image_variant_width(image: str) -> int:
    try:
        parsed = urlsplit(image)
        query = dict(re.findall(r"(?:^|[?&])(width|w)=([^&]+)", f"?{parsed.query}", re.I))
        value = query.get("width") or query.get("w")
        if value and value.isdigit() and int(value) > 0:
            return int(value)
        path = parsed.path
    except ValueError:
        path = image
    matched = re.search(r"_(\d+)x(?:\d+)?(?=\.[a-z]{3,5}(?:$|[?#]))", path, re.I)
    return int(matched.group(1)) if matched is not None else 0


def _has_conflicting_product_type(context: str, product_name: str) -> bool:
    if not context or not product_name:
        return False
    type_terms = ("serum", "cream", "toner", "ampoule", "mist", "cleanser", "lotion", "essence", "mask")
    product_types = {term for term in type_terms if re.search(rf"\b{term}\b", product_name, re.I)}
    context_types = {term for term in type_terms if re.search(rf"\b{term}\b", context, re.I)}
    return bool(product_types and context_types and product_types.isdisjoint(context_types))


def _should_use_contextual_ocr_target(image: str, context: str, score: int, product_name: str) -> bool:
    """Port the TS DOM/raw evidence gate before scheduling costly vision OCR.

    Raw script URLs and DOM URLs share this rule because their surrounding
    document snippet is the Python equivalent of the TS image context.  It is
    deliberately stricter than public ``images`` collection: source media may
    include a related-product card, but that does not make it OCR evidence.
    """

    if _COMMERCE_OCR_CONTEXT.search(context):
        return False
    has_positive_context = bool(_POSITIVE_OCR_SECTION.search(context))
    has_negative_context = bool(_NEGATIVE_OCR_SECTION.search(context))
    if has_negative_context and not has_positive_context:
        return False
    label = f"{image} {context}"
    if _has_conflicting_product_type(label, product_name):
        return False
    if (
        _GALLERY_OCR_CONTEXT.search(context)
        and not _HIGH_VALUE_OCR_CONTEXT.search(context)
        and not _has_product_name_signal(label, product_name)
    ):
        return False
    if has_positive_context and score > 0:
        return True
    return score >= 8 and not _NEGATIVE_OCR_SECTION.search(image)


def _has_product_name_signal(value: str, product_name: str) -> bool:
    stop_words = {"with", "and", "the", "for", "skin", "care", "brand", "product"}
    terms = [term for term in _handle_terms(product_name) if len(term) >= 4 and term not in stop_words]
    lowered = value.casefold()
    return bool(terms) and any(term in lowered for term in terms)


def _ocr_target_score(image: str, context: str, product_name: str) -> int:
    value = f"{image} {context}".casefold()
    score = sum(
        8
        for pattern in (
            "detail",
            "product",
            "ingredient",
            "benefit",
            "efficacy",
            "how to use",
            "direction",
            "clinical",
            "result",
        )
        if pattern in value
    )
    score += 10 * sum(term in value for term in _handle_terms(product_name))
    return score


def _runtime_ocr_result(result: Mapping[str, Any], fallback: Mapping[str, Any], images: Sequence[str]) -> dict[str, Any]:
    ocr = as_mapping(result.get("ocr")) or {}
    image_texts = [dict(item) for raw in _array(ocr.get("imageTexts")) if (item := as_mapping(raw)) is not None]
    candidate_keywords = [
        [dict(keyword) for raw_keyword in _array(raw) if (keyword := as_mapping(raw_keyword)) is not None]
        for raw in _array(result.get("_candidateKeywords"))
    ]
    diagnostics = as_mapping(result.get("diagnostics")) or {}
    semantic_facts = as_mapping(ocr.get("semanticFacts")) or {}
    if not image_texts:
        output = dict(fallback)
        output["_diagnostics"] = dict(as_mapping(diagnostics.get("ocr")) or {})
        output["_runtimeUsage"] = dict(as_mapping(diagnostics.get("runtimeUsage")) or {})
        output["_warnings"] = [
            dict(item) for raw in _array(diagnostics.get("warnings")) if (item := as_mapping(raw)) is not None
        ]
        if semantic_facts:
            output["semanticFacts"] = dict(semantic_facts)
        return output
    output: dict[str, Any] = {
        "imageTexts": image_texts,
        "textBlocks": [str(item.get("text") or "") for item in image_texts if _string(item.get("text"))],
        "keywords": dict(as_mapping(result.get("keywords")) or _empty_keywords()),
        "sentenceInsights": [
            dict(item) for raw in _array(ocr.get("sentenceInsights")) if (item := as_mapping(raw)) is not None
        ],
        "imagesScanned": len(image_texts),
        "sourceImages": list(images),
        "_candidateKeywords": candidate_keywords,
        "_diagnostics": dict(as_mapping(diagnostics.get("ocr")) or {}),
        "_runtimeUsage": dict(as_mapping(diagnostics.get("runtimeUsage")) or {}),
        "_warnings": [
            dict(item) for raw in _array(diagnostics.get("warnings")) if (item := as_mapping(raw)) is not None
        ],
    }
    if semantic_facts:
        output["semanticFacts"] = dict(semantic_facts)
    return output


def _ocr_from_pairs(candidates: Iterable[tuple[str, str]], images: Sequence[str]) -> dict[str, Any]:
    image_texts: list[dict[str, Any]] = []
    all_keywords = _empty_keywords()
    insights: list[dict[str, Any]] = []
    for image_url, raw_text in candidates:
        text = _ocr_text(raw_text)
        if not text or _COMMERCE_NOISE.search(text):
            continue
        keyword_groups = _keywords_for_text(text)
        for category, values in keyword_groups.items():
            all_keywords[category] = _unique([*all_keywords[category], *values])
        category = _primary_category(keyword_groups)
        entry = {
            "imageUrl": image_url,
            "text": text,
            "imageUrls": [image_url],
            "keywords": _classified_keywords(keyword_groups, "ocr"),
        }
        image_texts.append(entry)
        if category != "unknown":
            insights.append(
                {
                    "imageUrl": image_url,
                    "text": text,
                    "category": category,
                    "keywords": keyword_groups[category],
                    "imageUrls": [image_url],
                }
            )
    text_blocks = list(dict.fromkeys(item["text"] for item in image_texts))
    return {
        "imageTexts": image_texts,
        "textBlocks": text_blocks,
        "keywords": all_keywords,
        "sentenceInsights": insights,
        "imagesScanned": len(image_texts),
        "sourceImages": list(images),
    }


def _ocr_text(value: object) -> str | None:
    """Compact OCR whitespace without erasing source line/section boundaries."""

    if not isinstance(value, str):
        return _string(value)
    lines = [re.sub(r"[^\S\r\n]+", " ", line).strip() for line in value.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    text = "\n".join(line for line in lines if line)
    return text or None


def _append_no_ocr_warning(warnings: list[dict[str, str]], ocr: Mapping[str, Any]) -> None:
    for raw in _array(ocr.get("_warnings")):
        warning = as_mapping(raw)
        if warning is None:
            continue
        code, message = _string(warning.get("code")), _string(warning.get("message"))
        if code and message and not any(item.get("code") == code and item.get("message") == message for item in warnings):
            warnings.append({"code": code, "message": message})
    if ocr.get("imagesScanned") or any(item.get("code") in {"OCR_NO_IMAGE_TEXT", "IMAGE_OCR_NO_TEXT_EXTRACTED"} for item in warnings):
        return
    warnings.append(
        {
            "code": "OCR_NO_IMAGE_TEXT",
            "message": "No image OCR text candidates were found. Add data-ocr-text fixtures or configure a vision provider for richer extraction.",
        }
    )


def _empty_keywords() -> dict[str, list[str]]:
    return {
        category: []
        for category in (
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
    }


def _keywords_for_text(text: str) -> dict[str, list[str]]:
    groups = _empty_keywords()
    lowered = text.casefold()
    lexicon = {
        "ingredient": (
            "niacinamide",
            "retinol",
            "peptide",
            "ginseng",
            "ceramide",
            "ingredient",
            "성분",
            "인삼",
            "세라마이드",
        ),
        "usage": ("apply", "use", "morning", "night", "spray", "rinse", "사용", "바르", "펴 발"),
        "metric": ("%", "week", "weeks", "after", "before", "주", "일", "개선"),
        "effect": ("improve", "firm", "elastic", "wrinkle", "improvement", "효과", "개선", "탄력"),
        "benefit": ("hydration", "barrier", "moisture", "radiant", "benefit", "보습", "장벽", "촉촉"),
    }
    tokens = re.findall(r"[\w가-힣%+-]+", text, re.UNICODE)
    for category, needles in lexicon.items():
        if any(needle in lowered for needle in needles):
            groups[category] = _unique(
                token for token in tokens if any(needle in token.casefold() for needle in needles)
            )[:8]
    if not any(groups.values()):
        groups["unknown"] = tokens[:6]
    return groups


def _primary_category(groups: Mapping[str, Sequence[str]]) -> str:
    for category in ("usage", "ingredient", "metric", "effect", "benefit"):
        if groups.get(category):
            return category
    return "unknown"


def _classified_keywords(groups: Mapping[str, Sequence[str]], source: str) -> list[dict[str, Any]]:
    return [
        {"keyword": keyword, "category": category, "confidence": 0.75, "source": source}
        for category, keywords in groups.items()
        for keyword in keywords
    ]


def _reviews_from_html(
    soup: BeautifulSoup, product: Mapping[str, Any], records: Sequence[Mapping[str, Any]]
) -> tuple[dict[str, Any], list[dict[str, str]]]:
    aggregate = _as_mapping(product.get("aggregateRating"))
    rating = _number(aggregate.get("ratingValue"))
    count = _number(aggregate.get("reviewCount"))
    evidence: list[dict[str, str]] = []
    if rating is not None:
        evidence.append({"field": "product.reviews.rating", "source": "jsonLd", "value": _number_text(rating)})
    if count is not None:
        evidence.append({"field": "product.reviews.reviewCount", "source": "jsonLd", "value": _number_text(count)})
    if rating is None:
        rating = _dom_rating(soup)
        if rating is not None:
            evidence.append({"field": "product.reviews.rating", "source": "dom", "value": _number_text(rating)})
    if count is None:
        count = _dom_review_count(soup)
        if count is None:
            page_text = _visible_text(soup)
            matched = re.search(r"(\d[\d,]*)\s+reviews?", page_text, re.IGNORECASE)
            count = _number(matched.group(1).replace(",", "")) if matched else None
        if count is not None:
            evidence.append({"field": "product.reviews.reviewCount", "source": "dom", "value": _number_text(count)})
    items = _reviews_from_json(_array(product.get("review")))
    dom_seen: set[str] = set()
    for node in soup.select(_DOM_REVIEW_SELECTORS):
        has_nested_review = any(candidate is not node for candidate in node.select(_DOM_REVIEW_SELECTORS))
        is_explicit = (
            _node_attribute_text(node, "itemprop") == "review"
            or "Review" in (_node_attribute_text(node, "typeof") or "")
            or node.has_attr("data-review")
        )
        attributes = " ".join(
            value for attribute in node.attrs if (value := _node_attribute_text(node, attribute))
        )
        if has_nested_review and not is_explicit and not _DOM_REVIEW_CARD.search(attributes):
            continue
        text_node = node.select_one(_DOM_REVIEW_BODY_SELECTORS)
        text = _string(text_node.get_text(" ", strip=True)) if isinstance(text_node, Tag) else _string(node.get_text(" ", strip=True))
        if text is None:
            continue
        fingerprint = text.casefold()
        if len(text) < 16 or fingerprint in dom_seen or (len(text) < 120 and _DOM_REVIEW_CHROME.search(text)):
            continue
        dom_seen.add(fingerprint)
        rating_value = _dom_rating(node)
        author_node = node.select_one(_DOM_REVIEW_AUTHOR_SELECTORS)
        date_node = node.select_one("time[datetime], [itemprop='datePublished']") or node.select_one("time, [class*='date']")
        items.append(
            _without_none(
                {
                    "body": text[:1200],
                    "rating": rating_value,
                    "author": _string(author_node.get_text(" ", strip=True)) if isinstance(author_node, Tag) else None,
                    "datePublished": (
                        _string(date_node.get("datetime")) or _string(date_node.get_text(" ", strip=True))
                        if isinstance(date_node, Tag)
                        else None
                    ),
                }
            )
        )
        if len(dom_seen) >= 12:
            break
    for record in records:
        review_records = _array(record.get("reviews"))
        items.extend(_reviews_from_json(review_records))
        for candidate in [record, *_array(record.get("reviewInfo"))]:
            review = _as_mapping(candidate)
            if rating is None:
                rating = _first_number(
                    review,
                    ("reviewScope", "reviewAverage", "scopeAvg", "rating", "ratingValue", "reviewScore", "scope"),
                )
            if count is None:
                count = _first_number(review, ("reviewCount", "reviewCnt", "totalCount", "totalCnt", "count"))
            for key in (
                "longSummary",
                "shortSummary",
                "reviewSummaryMessage",
                "reviewSummaryText",
                "reviewSummarySubTitle",
                "summary",
                "aiSummary",
            ):
                body = _string(review.get(key))
                if body and len(body) >= 12 and _looks_like_review_text(body):
                    items.append(_without_none({"body": _html_to_text(body), "rating": rating}))
    items = _unique_review_items(items)
    result: dict[str, Any] = {"items": items, "keywords": _review_keywords(items)}
    if rating is not None:
        result["rating"] = rating
    if count is not None:
        result["reviewCount"] = int(count) if count.is_integer() else count
    return result, evidence


def _first_number(record: Mapping[str, Any], keys: Sequence[str]) -> float | None:
    for key in keys:
        if (value := _number(record.get(key))) is not None:
            return value
    return None


def _looks_like_review_text(value: str) -> bool:
    return bool(
        re.search(
            r"review|rating|customer|stars?|repurchase|satisfied|smooth|absorption|리뷰|평점|고객|만족|흡수|촉촉|탄력|보습",
            value,
            re.I,
        )
    )


def _dom_rating(node: BeautifulSoup | Tag) -> float | None:
    values: list[object] = []
    if isinstance(node, BeautifulSoup):
        values.extend(meta.get("content") for meta in node.select("meta[itemprop='ratingValue'], meta[property*='rating'], meta[name*='rating']"))
        candidates = node.select("[itemprop='ratingValue'], [class*='rating'], [aria-label*='star'], [aria-label*='out of']")
    else:
        candidates = node.select("[itemprop='ratingValue'], [class*='rating'], [aria-label*='star'], [aria-label*='out of']")
        if any(node.get(attribute) for attribute in ("data-rating", "content", "aria-label")):
            candidates = [node, *candidates]
    for candidate in candidates:
        values.extend(
            [
                candidate.get("data-rating"),
                candidate.get("content"),
                candidate.get("aria-label"),
                candidate.get_text(" ", strip=True),
            ]
        )
    for value in values:
        text = _string(value)
        if not text:
            continue
        explicit = re.search(
            r"([1-5](?:\.\d+)?)\s*(?:out of|/)\s*5|([1-5](?:\.\d+)?)\s*(?:stars?|점|별점)",
            text,
            re.I,
        )
        compact = re.search(r"(?:rating|평점|별점)[^\d]{0,20}([1-5](?:\.\d+)?)", text, re.I)
        value = (explicit.group(1) or explicit.group(2)) if explicit is not None else compact.group(1) if compact else None
        if value is not None and (number := _number(value)) is not None:
            return number
    return None


def _dom_review_count(node: BeautifulSoup | Tag) -> float | None:
    """Port the DOM review-count attribute aliases used by the TS reader."""

    values: list[object] = []
    if isinstance(node, BeautifulSoup):
        values.extend(
            meta.get("content")
            for meta in node.select("meta[itemprop='reviewCount'], meta[property*='review_count'], meta[name*='review']")
        )
    candidates = node.select(
        "[itemprop='reviewCount'], [class*='review-count'], [class*='reviewCount'], "
        "[data-review-count], [aria-label*='review']"
    )
    if any(node.get(attribute) for attribute in ("data-review-count", "content", "aria-label")):
        candidates = [node, *candidates]
    for candidate in candidates:
        values.extend(
            [
                candidate.get("content"),
                candidate.get("data-review-count"),
                candidate.get("aria-label"),
                candidate.get_text(" ", strip=True),
            ]
        )
    for value in values:
        text = _string(value)
        if not text:
            continue
        # Match TS ``parseReviewCount`` exactly: a count precedes an explicit
        # review/rating label, or the source value itself is wholly numeric.
        # A rating aria label ("4.7 out of 5 stars") is never a count.
        matched = re.search(r"([\d,]+)\s*(?:reviews?|ratings?|개의 리뷰|리뷰|후기|평점)", text, re.IGNORECASE)
        raw_count = matched.group(1) if matched is not None else text if re.fullmatch(r"\d+", text) else None
        if raw_count is not None and (number := _number(raw_count.replace(",", ""))) is not None:
            return number
    return None


def _reviews_from_api(source: Mapping[str, Any]) -> dict[str, Any]:
    items = _reviews_from_json(_array(source.get("items") or source.get("reviewItems")))
    result: dict[str, Any] = {"items": items, "keywords": _review_keywords(items)}
    rating = _number(source.get("rating"))
    count = _number(source.get("reviewCount"))
    if rating is not None:
        result["rating"] = rating
    if count is not None:
        result["reviewCount"] = int(count) if count.is_integer() else count
    return result


def _reviews_from_json(values: Iterable[Any]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for value in values:
        record = _as_mapping(value)
        body = _string(record.get("reviewBody")) or _string(record.get("body")) or _string(record.get("text"))
        if not body:
            continue
        rating = _number(_as_mapping(record.get("reviewRating")).get("ratingValue")) or _number(record.get("rating"))
        item = _without_none(
            {
                "body": body,
                "author": _string(_as_mapping(record.get("author")).get("name")) or _string(record.get("author")),
                "rating": rating,
                "datePublished": _string(record.get("datePublished")),
            }
        )
        items.append(item)
    return items


def _unique_review_items(items: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in items:
        body = _string(item.get("body"))
        if body and body.casefold() not in seen:
            seen.add(body.casefold())
            output.append(dict(item))
    return output[:30]


def _review_keywords(items: Iterable[Mapping[str, Any]]) -> list[str]:
    words: list[str] = []
    banned = {"review", "reviews", "rating", "customer", "stars", "the", "and", "with", "this", "that", "enough"}
    for item in items:
        for word in re.findall(r"[A-Za-z가-힣]{4,}", _string(item.get("body")) or ""):
            normalized = word.casefold()
            if normalized not in banned:
                words.append(word)
    return _unique(words)[:12]


def _review_message(reviews: Mapping[str, Any]) -> str:
    rating = reviews.get("rating")
    review_count = reviews.get("reviewCount")
    has_aggregate = any(isinstance(value, int | float) and not isinstance(value, bool) for value in (rating, review_count))
    aggregate = (
        f"평점 {_number_text(float(rating)) if isinstance(rating, int | float) and not isinstance(rating, bool) else '-'}"
        f" / 리뷰수 {_number_text(float(review_count)) if isinstance(review_count, int | float) and not isinstance(review_count, bool) else '-'}"
        if has_aggregate
        else "집계 평점 없음"
    )
    return f"{aggregate}, 리뷰 본문 {len(_array(reviews.get('items')))}개와 리뷰 키워드 {len(_array(reviews.get('keywords')))}개를 정리했습니다."


def _number(value: Any) -> float | None:
    try:
        return float(value) if value is not None and str(value).strip() else None
    except TypeError, ValueError:
        return None


def _number_text(value: float) -> str:
    return str(int(value)) if value.is_integer() else str(value)


def _price_amount(value: Any) -> int | float | None:
    normalized = re.sub(r"[^\d.]", "", str(value or ""))
    amount = _number(normalized) if normalized else None
    return int(amount) if isinstance(amount, float) and amount.is_integer() else amount


def _metric_phrases(text: str) -> list[str]:
    return _unique([*(match.group(0) for match in _METRIC_RE.finditer(text)), *(match.group(0) for match in _METRIC_AFTER_RE.finditer(text))])


def _build_geo_product(
    profile: Mapping[str, Any],
    reviews: Mapping[str, Any],
    ocr: Mapping[str, Any],
    sections: Sequence[Mapping[str, Any]],
    faq: Sequence[Mapping[str, Any]],
    *,
    date_modified: str | None,
    source_owned_dom_usage: Sequence[str] = (),
) -> dict[str, Any]:
    price = (
        _without_none(
            {
                "raw": profile.get("price"),
                "amount": _price_amount(profile.get("price")),
                "currency": profile.get("currency"),
            }
        )
        if profile.get("price")
        else None
    )
    supplied_ocr_facts = as_mapping(ocr.get("semanticFacts")) or {}
    benefits = _unique(
        [
            *_values(profile.get("benefits")),
            *_values(supplied_ocr_facts.get("benefits")),
            *[insight["text"] for insight in ocr["sentenceInsights"] if insight["category"] == "benefit"],
        ]
    )
    effects = _unique(
        [
            *_values(profile.get("effects")),
            *_values(supplied_ocr_facts.get("effects")),
            *[insight["text"] for insight in ocr["sentenceInsights"] if insight["category"] in {"effect", "metric"}],
        ]
    )
    ingredients = _unique(
        [
            *_values(profile.get("ingredients")),
            *_values(supplied_ocr_facts.get("ingredients")),
            *_unlinked_ingredient_insight_texts(ocr),
        ]
    )
    declared_dom_usage, declared_dom_usage_diagnostics = _source_owned_numbered_usage_steps(source_owned_dom_usage)
    if declared_dom_usage:
        numbered_usage, usage_sequence_diagnostics = declared_dom_usage, declared_dom_usage_diagnostics
    else:
        usage_source_values = _usage_sequence_source_values(profile, ocr, sections, supplied_ocr_facts)
        numbered_usage, usage_sequence_diagnostics = _source_owned_numbered_usage_steps(usage_source_values)
    usage_candidates = [
        *_values(profile.get("usage")),
        *_values(supplied_ocr_facts.get("usageSteps")),
        *[insight["text"] for insight in ocr["sentenceInsights"] if insight["category"] == "usage"],
        *[item["answer"] for item in faq if re.search(r"(?:apply|use|사용|바르)", item["answer"], re.IGNORECASE)],
    ]
    usage = numbered_usage or _unique(_without_incomplete_numbered_usage(usage_candidates))
    metrics = _unique(
        [
            *_values(profile.get("metrics")),
            *[
                metric
                for insight in ocr["sentenceInsights"]
                if insight["category"] == "metric" or _metric_phrases(insight["text"])
                for text in [insight["text"]]
                for metric in _metric_phrases(text)
            ],
        ]
    )
    keyword_groups = dict(ocr["keywords"])
    semantic_facts = _semantic_facts_from_extraction(
        profile,
        ocr,
        benefits=benefits,
        effects=effects,
        usage=usage,
        metrics=metrics,
        source_numbered_usage=numbered_usage,
    )
    normalized_sections = [
        dict(section)
        for raw in _array(profile.get("contentSections"))
        if (section := as_mapping(raw)) is not None
    ]
    candidate_keywords = _array(ocr.get("_candidateKeywords"))
    ocr_sections: list[dict[str, Any]] = []
    for index, raw in enumerate(_array(ocr.get("imageTexts")), start=1):
        item = as_mapping(raw)
        if item is None:
            continue
        image_url, text = _string(item.get("imageUrl")), _string(item.get("text"))
        # API/body/section fallbacks are already represented by their source
        # content sections.  Only retained image-backed OCR blocks gain the
        # public ``OCR image N`` section, as in the HTML TS path.
        if not image_url or "#api-text-" in image_url or "#section-" in image_url or not text:
            continue
        keyword_source = candidate_keywords[index - 1] if index <= len(candidate_keywords) else item.get("keywords")
        keywords = _keyword_mappings(keyword_source)
        if section := _section(f"OCR image {index}", text, keywords):
            ocr_sections.append(section)
    content_sections = _unique_sections(
        [
            # Normalization augments source content; it is not an override.
            # The retained TS artifact keeps both arrays and de-duplicates by
            # section identity only after their union.
            *[dict(section) for section in sections],
            *normalized_sections,
            *ocr_sections,
            *[
                {
                    "title": f"Customer review {index}",
                    "category": "review",
                    "text": _string(item.get("body")) or "",
                    "bullets": _bullets(_string(item.get("body")) or ""),
                }
                for index, item in enumerate(_array(reviews.get("items")), start=1)
                if _string(_as_mapping(item).get("body"))
            ],
        ]
    )
    rating_summary = _rating_summary(reviews)
    if rating_summary:
        content_sections.append(
            {
                "title": "Customer rating",
                "category": "rating",
                "text": rating_summary,
                "bullets": [rating_summary],
            }
        )
    product = _without_none(
        {
            "name": profile.get("name"),
            "brand": profile.get("brand"),
            "description": profile.get("description"),
            "price": price,
            "availability": profile.get("availability"),
            "itemCondition": profile.get("itemCondition"),
            "priceValidUntil": profile.get("priceValidUntil"),
            "returnPolicy": profile.get("returnPolicy"),
            "dateModified": date_modified,
            "images": _unique(profile.get("images", [])),
            "options": _unique(profile.get("options", [])),
            "benefits": benefits,
            "effects": effects,
            "ingredients": ingredients,
            "usage": usage,
            "metrics": metrics,
            "faq": [dict(item) for item in faq],
            "reviews": dict(reviews),
            "sourceExtraction": {
                "html": {
                    "description": profile.get("description"),
                    "sections": [dict(section) for section in sections],
                    "faq": [dict(item) for item in faq],
                },
                "ocr": {
                    "imageTexts": list(ocr["imageTexts"]),
                    "textBlocks": list(ocr["textBlocks"]),
                    "sentenceInsights": list(ocr["sentenceInsights"]),
                    "semanticFacts": semantic_facts,
                },
            },
            "aiAnalysis": {
                "keywords": keyword_groups,
                "categorizedSections": content_sections,
                "semanticFacts": semantic_facts,
            },
            "semanticFacts": semantic_facts,
            "categorizedProductInfo": {
                "benefits": benefits,
                "effects": effects,
                "ingredients": ingredients,
                "usage": usage,
                "metrics": metrics,
                "faq": [dict(item) for item in faq],
            },
            "customerReviewAnalysis": {
                **dict(reviews),
                "reviewSignals": [item["body"] for item in reviews["items"]],
                "ratingSummary": rating_summary,
            },
            "contentAnalysis": {
                "sections": content_sections,
                "reviewSignals": [item["body"] for item in reviews["items"]],
                "ratingSummary": rating_summary,
            },
            "ocr": {
                "textBlocks": list(ocr["textBlocks"]),
                "keywords": keyword_groups,
                "sentenceInsights": list(ocr["sentenceInsights"]),
            },
        }
    )
    product["_usageSequenceDiagnostics"] = usage_sequence_diagnostics
    return product


def _semantic_facts_from_extraction(
    profile: Mapping[str, Any],
    ocr: Mapping[str, Any],
    *,
    benefits: Sequence[str],
    effects: Sequence[str],
    usage: Sequence[str],
    metrics: Sequence[str],
    source_numbered_usage: Sequence[str] = (),
) -> dict[str, Any]:
    """Merge model, sentence, and deterministic product facts into one wire contract."""

    supplied = as_mapping(ocr.get("semanticFacts")) or {}
    insights = [as_mapping(item) or {} for item in _array(ocr.get("sentenceInsights"))]

    def texts(field: str) -> list[str]:
        return _unique(_values(supplied.get(field)))

    def insight_texts(category: str) -> list[str]:
        return _unique(_string(item.get("text")) for item in insights if item.get("category") == category)

    numbered_usage = list(source_numbered_usage)
    metric_claims: list[dict[str, Any]] = [
        dict(item) for raw in _array(supplied.get("metricClaims")) if (item := as_mapping(raw)) is not None
    ]
    for metric in metrics:
        row = {"sentence": metric, "sourceText": metric}
        if row not in metric_claims:
            metric_claims.append(row)
    evidence_sentences = _unique(
        [*texts("evidenceSentences"), *[_string(item.get("text")) for item in insights]]
    )
    ingredient_links = [
        dict(item) for raw in _array(supplied.get("ingredientBenefitLinks")) if (item := as_mapping(raw)) is not None
    ]
    citations = [dict(item) for raw in _array(supplied.get("citations")) if (item := as_mapping(raw)) is not None]
    return {
        "ingredients": _unique(
            [*_values(profile.get("ingredients")), *texts("ingredients"), *_unlinked_ingredient_insight_texts(ocr)]
        ),
        "benefits": _unique([*benefits, *texts("benefits"), *insight_texts("benefit")]),
        "effects": _unique([*effects, *texts("effects"), *insight_texts("effect")]),
        "skinTypes": texts("skinTypes"),
        "usageSteps": numbered_usage
        or _unique(_without_incomplete_numbered_usage([*usage, *texts("usageSteps"), *insight_texts("usage")])),
        "safetyTests": texts("safetyTests"),
        "metricClaims": metric_claims,
        "evidenceSentences": evidence_sentences,
        "ingredientBenefitLinks": ingredient_links,
        "citations": citations,
    }


def _unlinked_ingredient_insight_texts(ocr: Mapping[str, Any]) -> list[str]:
    """Do not publish an entire relation sentence as a second ingredient."""

    supplied = as_mapping(ocr.get("semanticFacts")) or {}
    relation_sources = {
        re.sub(r"\s+", " ", source).casefold()
        for raw in _array(supplied.get("ingredientBenefitLinks"))
        if (link := as_mapping(raw)) is not None
        and _string(link.get("ingredient"))
        for source in (_string(link.get("sourceText")) or _string(link.get("sentence")),)
        if source
    }
    return [
        text
        for raw in _array(ocr.get("sentenceInsights"))
        if (insight := as_mapping(raw)) is not None
        and insight.get("category") == "ingredient"
        and (text := _string(insight.get("text"))) is not None
        and re.sub(r"\s+", " ", text).casefold() not in relation_sources
    ]


def _usage_sequence_source_values(
    profile: Mapping[str, Any],
    ocr: Mapping[str, Any],
    sections: Sequence[Mapping[str, Any]],
    supplied_ocr_facts: Mapping[str, Any],
) -> list[str]:
    """Attach source headings before sequence selection removes lexical guesswork."""

    values = [text for text in _array(ocr.get("textBlocks")) if isinstance(text, str)]
    section_values = [
        f"{_string(section.get('title')) or 'How to use'}\n{_string(section.get('text')) or ''}"
        for section in sections
        if section.get("category") == "usage" and _string(section.get("text"))
    ]
    values.extend(section_values)
    source_keys = {_usage_sequence_source_key(value) for value in values}

    def append_field_values(field_values: Iterable[str], *, declared_usage: bool) -> None:
        for value in field_values:
            if not has_explicit_numbered_usage_marker(value):
                continue
            key = _usage_sequence_source_key(value)
            # When a DOM/OCR source already carries this numbered text, its
            # own heading decides whether it is product usage. Rewrapping a
            # routed OCR routine as generic "How to use" would erase that
            # proof. A direct API ``usage`` field is already a semantic source
            # declaration, however, so retain that heading even when OCR has
            # echoed the same words without a heading.
            if not declared_usage and key and any(key in source_key for source_key in source_keys):
                continue
            values.append(f"How to use\n{value}")
            if key:
                source_keys.add(key)

    # A direct source field is itself a semantic usage declaration.  Preserve
    # that relationship when a REST payload has no separately rendered title.
    append_field_values(_values(profile.get("usage")), declared_usage=True)
    append_field_values(_values(supplied_ocr_facts.get("usageSteps")), declared_usage=False)
    return values


def _source_owned_numbered_usage_steps(values: Sequence[str]) -> tuple[list[str], dict[str, Any]]:
    """Recover one complete declared procedure and its accept/reject reasons."""

    return select_numbered_usage_sequence(values)


def _without_incomplete_numbered_usage(values: Iterable[str]) -> list[str]:
    """Do not turn a rejected ``Step 2`` into a newly numbered one-step plan."""

    return [value for value in values if not has_explicit_numbered_usage_marker(value)]


def _usage_sequence_source_key(value: str) -> str:
    return re.sub(r"[^\w]+", " ", value.casefold()).strip()


def _rating_summary(reviews: Mapping[str, Any]) -> str | None:
    if "rating" not in reviews:
        return None
    return f"Rating {_number_text(float(reviews['rating']))} · {reviews.get('reviewCount', 0)} reviews"


def _resolve_runtime_rag_options(options: Mapping[str, Any] | None) -> dict[str, Any]:
    """Apply the same managed RAG prompt/document defaults as the TS runtime."""

    runtime = dict(options or {})
    managed = default_profile()
    configured_prompt = runtime.get("analysisPrompt")
    runtime["analysisPrompt"] = (
        configured_prompt.strip() if isinstance(configured_prompt, str) and configured_prompt.strip() else managed["analysisPrompt"]
    )
    documents = runtime.get("ragDocuments")
    if not isinstance(documents, list) or not documents:
        runtime["ragDocuments"] = [
            {"name": document["name"], "content": document["content"]} for document in managed["documents"]
        ]
    # Retrieval is invoked once while classifying OCR evidence and again while
    # building public RAG chunks.  Keep a single internal trace and fan it out
    # to the caller's public callback without replacing that callback.
    runtime_steps: list[dict[str, Any]] = []
    external_callback = runtime.get("onRuntimeStep") or runtime.get("on_runtime_step")

    def record_runtime_step(step: object) -> object:
        mapping = as_mapping(step)
        if mapping is not None:
            runtime_steps.append(dict(mapping))
        if callable(external_callback):
            return external_callback(step)
        return None

    runtime["_runtimeSteps"] = runtime_steps
    runtime["_runtimeStepCallback"] = record_runtime_step
    return runtime


async def _rag_chunks(source: str, product: Mapping[str, Any], runtime: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Create product, evidence, and selected policy chunks in legacy order."""

    product_text = "\n".join(
        value
        for value in (
            _string(product.get("name")),
            _string(product.get("description")),
            "\n".join(_values(product.get("benefits"))),
            "\n".join(_values(product.get("effects"))),
            "\n".join(_values(product.get("ingredients"))),
            "\n".join(_values(product.get("usage"))),
            "\n".join(_values(product.get("metrics"))),
        )
        if value
    )
    chunks: list[dict[str, Any]] = [
        {"id": "product-1", "kind": "product", "text": product_text, "metadata": {"source": source}}
    ]
    for index, item in enumerate(_array(product.get("faq")), start=1):
        record = _as_mapping(item)
        chunks.append(
            {
                "id": f"faq-{index}",
                "kind": "faq",
                "text": f"Q: {_string(record.get('question')) or ''}\nA: {_string(record.get('answer')) or ''}",
                "metadata": {"source": source},
            }
        )
    sections = _as_mapping(product.get("contentAnalysis")).get("sections")
    for index, item in enumerate(_array(sections), start=1):
        record = _as_mapping(item)
        chunks.append(
            {
                "id": f"content-section-{index}",
                "kind": "source",
                "text": f"[{_string(record.get('category')) or ''}] {_string(record.get('title')) or ''}\n{_string(record.get('text')) or ''}",
                "metadata": {"source": source, "category": _string(record.get("category")) or ""},
            }
        )
    reviews = _as_mapping(product.get("reviews"))
    for index, item in enumerate(_array(reviews.get("items")), start=1):
        chunks.append(
            {
                "id": f"review-{index}",
                "kind": "review",
                "text": _string(_as_mapping(item).get("body")) or "",
                "metadata": {"source": source, "rating": _as_mapping(item).get("rating") or 0},
            }
        )

    source_ocr = _as_mapping(_as_mapping(product.get("sourceExtraction")).get("ocr"))
    image_texts = [
        {"imageUrl": _string(record.get("imageUrl")) or f"{source}#ocr-{index}", "text": _string(record.get("text")) or ""}
        for index, item in enumerate(_array(source_ocr.get("imageTexts")), start=1)
        if (record := _as_mapping(item))
    ]
    for index, item in enumerate(image_texts, start=1):
        chunks.append(
            {
                "id": f"ocr-{index}",
                "kind": "ocr",
                "text": item["text"],
                "metadata": {"source": source, "imageUrl": item["imageUrl"]},
            }
        )

    configured_prompt = runtime.get("analysisPrompt")
    analysis_prompt = configured_prompt.strip() if isinstance(configured_prompt, str) and configured_prompt.strip() else None
    if analysis_prompt:
        chunks.append(
            {
                "id": "rag-profile-analysis-prompt",
                "kind": "source",
                "text": analysis_prompt,
                "metadata": {"source": source, "profile": "analysis-prompt"},
            }
        )

    evidence_text = "\n".join(
        value
        for value in (
            _string(product.get("name")),
            _string(product.get("description")),
            "\n".join(_values(product.get("benefits"))),
            "\n".join(_values(product.get("effects"))),
            "\n".join(_values(product.get("ingredients"))),
            "\n".join(_values(product.get("usage"))),
            "\n".join(_values(reviews.get("keywords"))),
        )
        if value
    )
    rag_documents = runtime.get("ragDocuments")
    retrieved = await retrieve_product_extractor_rag_documents_with_runtime(
        {
            "query": create_product_extractor_rag_query(
                {
                    "source": source,
                    "productName": _string(product.get("name")),
                    "imageTexts": [*image_texts, {"imageUrl": f"{source}#product-evidence", "text": evidence_text}],
                }
            ),
            "documents": rag_documents if isinstance(rag_documents, list) else [],
            "settings": runtime.get("rag"),
            "embedding": runtime.get("embedding"),
            "reranker": runtime.get("reranker"),
            "onRuntimeStep": runtime.get("_runtimeStepCallback"),
        }
    )
    for index, document in enumerate(retrieved, start=1):
        document_mapping = as_mapping(document) or {}
        intents = _metadata_list(document_mapping.get("intents"))
        field_targets = _metadata_list(document_mapping.get("fieldTargets"))
        chunks.append(
            {
                "id": f"rag-profile-file-{index}",
                "kind": "source",
                "text": str(document_mapping.get("content") or ""),
                "metadata": {
                    "source": source,
                    "documentName": _string(document_mapping.get("sourceDocument")) or "",
                    "chunkId": _string(document_mapping.get("chunkId")) or "",
                    "score": document_mapping.get("score"),
                    "kind": _string(document_mapping.get("kind")) or "",
                    "intents": ",".join(intents),
                    "fieldTargets": ",".join(field_targets),
                },
            }
        )
    return [chunk for chunk in chunks if _string(chunk.get("text"))]


def _html_date_modified(soup: BeautifulSoup) -> str | None:
    for name in ("article:modified_time", "dateModified", "date-modified", "og:updated_time"):
        value = _meta(soup, name)
        if _valid_iso(value):
            return value
    for script in soup.find_all("script"):
        parsed = _parse_json_text(script.string or script.get_text())
        if value := _find_date_field(parsed):
            return value
    return None


def _payload_date_modified(payload: Any) -> str | None:
    return _find_date_field(payload)


def _find_date_field(value: object) -> str | None:
    mapping = as_mapping(value)
    if mapping is not None:
        for key in ("updated_at", "updatedAt", "dateModified", "date_modified"):
            candidate = _string(mapping.get(key))
            if _valid_iso(candidate):
                return candidate
        for child in mapping.values():
            if candidate := _find_date_field(child):
                return candidate
    elif (items := as_list(value)) is not None:
        for child in items:
            if candidate := _find_date_field(child):
                return candidate
    return None


def _valid_iso(value: str | None) -> bool:
    if not value or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})", value):
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def _mapping_sections(product: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Extract structured, keyed, and nested product-section shapes.

    Commerce clients use both ``sections: [{...}]`` and object maps such as
    ``{BENEFITS: ..., "HOW TO USE": ...}``; Korean client state additionally
    exposes regulatory ``disclosures``.  The TS extractor recursively walks
    these shapes, so one narrow list-only reader loses real products.
    """

    sections: list[dict[str, Any]] = []
    seen: set[int] = set()

    def add(title: str | None, text: object, category_hint: str | None = None) -> None:
        cleaned = _html_to_text(_string(text) or "")
        if not title or not cleaned or _COMMERCE_NOISE.search(f"{title} {cleaned}"):
            return
        category = category_hint or _category(title, cleaned)
        section = _section(title, cleaned) or {
            "title": title,
            "category": category,
            "text": cleaned,
            "bullets": _values(cleaned),
        }
        section["category"] = category
        sections.append(section)

    def visit(value: object, depth: int = 0) -> None:
        if depth > 6:
            return
        mapping = as_mapping(value)
        if mapping is not None:
            if id(mapping) in seen:
                return
            seen.add(id(mapping))
            title = (
                _string(mapping.get("title"))
                or _string(mapping.get("heading"))
                or _string(mapping.get("label"))
                or _string(mapping.get("name"))
                or _string(mapping.get("disclosureItemName"))
            )
            text = (
                _string(mapping.get("text"))
                or _string(mapping.get("body"))
                or _string(mapping.get("content"))
                or _string(mapping.get("prodDisclosureInfo"))
            )
            if title and text:
                add(title, text)
            for key, child in mapping.items():
                category = _category_from_key(key)
                if category:
                    values = _values(child)
                    if values:
                        add(_title_for_key(key), " ".join(values), category)
                if _should_traverse_section_key(key):
                    visit(child, depth + 1)
            return
        values = as_list(value)
        if values is not None:
            if id(values) in seen:
                return
            seen.add(id(values))
            for child in values:
                visit(child, depth + 1)

    visit(product)
    return _unique_sections(sections)


def _title_for_key(key: str) -> str:
    normalized = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", key).replace("_", " ").replace("-", " ").strip()
    known = {
        "keyingredients": "Key Ingredients",
        "ingredienthighlights": "Ingredient Highlights",
        "howtouse": "How To Use",
        "directions": "Directions",
        "benefits": "Benefits",
        "ingredients": "Ingredients",
    }
    return known.get(re.sub(r"\s+", "", normalized).casefold(), normalized.title())


def _category_from_key(key: object) -> str | None:
    normalized = re.sub(r"[^a-z0-9가-힣]+", " ", _normalize_state_key(key)).strip()
    if any(token in normalized for token in ("ingredient", "성분", "전성분", "원료")):
        return "ingredient"
    if any(token in normalized for token in ("benefit", "효능", "피부 고민")):
        return "benefit"
    if any(token in normalized for token in ("effect", "clinical", "result", "효과", "개선")):
        return "effect"
    if any(token in normalized for token in ("how to use", "howtouse", "usage", "direction", "application", "사용")):
        return "usage"
    if any(token in normalized for token in ("faq", "question", "answer", "질문", "답변")):
        return "faq"
    if any(token in normalized for token in ("review", "rating", "리뷰", "평점")):
        return "review"
    return None


def _should_traverse_section_key(key: object) -> bool:
    return not bool(
        re.fullmatch(
            r"(?:auth|account|cart|order|coupon|favorite|delivery|ship|seller|payment|popup|dialog|loading|form|header|footer|navigation|menu|category|event|banner|recommend|recent|cache)",
            _normalize_state_key(key),
            re.I,
        )
    )


def _values(value: object) -> list[str]:
    if isinstance(value, str):
        text = _html_to_text(value)
        return [text] if text else []
    mapping = as_mapping(value)
    if mapping is not None:
        return _values(mapping.get("value") or mapping.get("text") or mapping.get("name"))
    items = as_list(value)
    if items is not None:
        return _unique(item for child in items for item in _values(child))
    return []


def _html_to_text(value: str) -> str:
    return re.sub(r"\s+", " ", BeautifulSoup(value, "html.parser").get_text(" ", strip=True)).strip()


def _image_values(value: Any) -> list[Any]:
    return _array(value)


def _api_options(product: Mapping[str, Any], variants: Sequence[Mapping[str, Any]]) -> list[str]:
    values: list[Any] = []
    for option in _array(product.get("options")):
        option_mapping = as_mapping(option)
        if option_mapping is not None:
            values.extend(_array(option_mapping.get("values")))
        else:
            values.append(option)
    for variant in variants:
        values.extend(_array(variant.get("options")))
        if (title := _string(variant.get("title"))) and title.casefold() != "default title":
            values.append(title)
    return _unique(values)[:12]


def _api_faq(value: Any) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    for raw in _array(value):
        record = _as_mapping(raw)
        accepted_answer = _first_mapping(record.get("acceptedAnswer"))
        question = _string(record.get("name")) or _string(record.get("question"))
        answer = _string(accepted_answer.get("text")) or _string(record.get("answer"))
        if question and answer:
            items.append({"question": question, "answer": answer})
    return items[:12]


def _metadata_list(value: object) -> list[str]:
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    values = as_list(value)
    return [item.strip() for item in values if isinstance(item, str) and item.strip()] if values is not None else []


def _rag_usage(chunks: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Build the policy-facing RAG audit groups from retrieved chunk metadata."""

    references: list[dict[str, Any]] = []
    for chunk in chunks:
        metadata = as_mapping(chunk.get("metadata"))
        if metadata is None:
            continue
        source_document = _string(metadata.get("documentName"))
        if not source_document:
            continue
        intents = _metadata_list(metadata.get("intents"))
        field_targets = _metadata_list(metadata.get("fieldTargets"))
        score = metadata.get("score")
        reference: dict[str, Any] = {
            "sourceDocument": source_document,
            "intents": intents,
            "fieldTargets": field_targets,
            "usage": _rag_reference_usage(intents, field_targets),
            "excerpt": _utf16_prefix(re.sub(r"\s+", " ", str(chunk.get("text") or "")).strip(), 260),
        }
        chunk_id = _string(metadata.get("chunkId"))
        kind = _string(metadata.get("kind"))
        if chunk_id:
            reference["chunkId"] = chunk_id
        if kind:
            reference["kind"] = kind
        if isinstance(score, int | float) and not isinstance(score, bool):
            reference["score"] = score
        references.append(reference)

    group_specs: tuple[tuple[str, Callable[[Mapping[str, Any]], bool]], ...] = (
        (
            "policy orchestration and overlap control",
            lambda item: "orchestration" in _metadata_list(item.get("intents"))
            or "diagnostics" in _metadata_list(item.get("fieldTargets")),
        ),
        (
            "field classification and normalization",
            lambda item: any(
                intent in {"classification", "normalization", "schema-ready"}
                for intent in _metadata_list(item.get("intents"))
            ),
        ),
        (
            "evidence exclusions and missing-field safety",
            lambda item: "exclusion" in _metadata_list(item.get("intents"))
            or "evidence" in _metadata_list(item.get("intents")),
        ),
    )
    output: list[dict[str, Any]] = []
    for principle, selector in group_specs:
        selected = _unique_rag_references([item for item in references if selector(item)])
        if selected:
            output.append({"principle": principle, "references": selected})
    return output


def _rag_reference_usage(intents: Sequence[str], field_targets: Sequence[str]) -> str:
    if "orchestration" in intents:
        return "Coordinates policy coverage, conflict handling, and omitted-field review before extraction output is trusted."
    if "exclusion" in intents:
        return "Prevents commerce chrome, coupon, delivery, refund, and legal text from becoming product claims."
    if "ocr.sentenceInsights" in field_targets:
        return "Guides sentence-level OCR reconstruction and category assignment."
    if "reviews" in field_targets:
        return "Guides review keyword and representative customer-language extraction."
    if "faq" in field_targets:
        return "Guides FAQ extraction only when question and answer evidence are both present."
    return "Guides source-backed product normalization and schema-ready RAG chunk construction."


def _unique_rag_references(references: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    seen: set[str] = set()
    for reference in references:
        key = f"{reference.get('sourceDocument', '')}:{reference.get('chunkId', '')}:{str(reference.get('excerpt', ''))[:80]}"
        if key not in seen:
            seen.add(key)
            output.append(dict(reference))
    return output


def _extractor_runtime_usage(
    runtime: Mapping[str, Any], observed_steps: Sequence[Mapping[str, Any]] = ()
) -> dict[str, Any]:
    """Keep the complete baseline trace even for deterministic/mock runs."""

    provider = _provider_name(runtime)
    provider_label = {"azure-openai": "azure-api", "aistudio": "external-agent"}.get(provider, provider)
    deployment_based = provider in {"azure-openai", "aistudio"}
    deployments = as_mapping(runtime.get("deployments")) or {}
    deployment = runtime.get("deployment")
    embedding = as_mapping(runtime.get("embedding")) or {}
    reranker = as_mapping(runtime.get("reranker")) or {}

    def model_fields(role: str) -> dict[str, Any]:
        if deployment_based:
            # The TS implementation uses ``deployments?.[role] ?? deployment``.
            # In particular, a deliberately blank deployment is observable and
            # must not be truthiness-replaced by the fallback deployment.
            role_value = deployments.get(role)
            resolved = role_value if role_value is not None else deployment
            return {"deployment": resolved} if resolved is not None else {}
        model = runtime.get("model")
        return {"model": model} if model is not None else {}

    embedding_provider = embedding.get("provider")
    reranker_provider = reranker.get("provider")
    if reranker_provider == "azure-ai-search-semantic":
        reranker_service = "Azure AI Search semantic ranker"
        reranker_details = (
            f"Uses Azure AI Search index {reranker.get('indexName') or '(not set)'} with semantic configuration "
            f"{reranker.get('semanticConfiguration') or 'default'}."
        )
    elif reranker_provider == "aistudio-bedrock-cohere":
        reranker_service = "AI Studio Bedrock Cohere Rerank"
        reranker_details = "Uses AI Studio's Bedrock Cohere Rerank when endpoint/key are configured; otherwise falls back to local score ordering."
    elif reranker_provider == "cohere":
        reranker_service = "Cohere Rerank"
        reranker_details = "Uses Cohere Rerank when endpoint/key are configured; otherwise falls back to local score ordering."
    else:
        reranker_service = "local score ordering"
        reranker_details = "Uses deterministic local score ordering."

    observed = list(observed_steps)
    baseline: list[dict[str, Any]] = [
        {
            "stage": "ocr",
            "label": "OCR/structure extraction",
            "provider": provider_label,
            "service": {"azure-openai": "Azure API model deployment", "aistudio": "AI Studio model deployment"}.get(
                provider, provider
            ),
            **model_fields("ocr"),
            "called": any(step.get("stage") == "ocr" for step in observed),
            "details": "Reads visible text from PDP images when image OCR targets are available.",
        },
        {
            "stage": "final",
            "label": "Final OCR classification/reasoning",
            "provider": provider_label,
            "service": {"azure-openai": "Azure API model deployment", "aistudio": "AI Studio model deployment"}.get(
                provider, provider
            ),
            **model_fields("reasoning"),
            # Product-profile normalization is a separate stage.  Only the
            # OCR classifier's own final step may mark this OCR model call as
            # executed; otherwise diagnostics falsely reported an OCR model
            # invocation whenever a custom profile normalizer ran.
            "called": any(
                step.get("stage") == "final" and step.get("label") == "Semantic OCR classification/reasoning"
                for step in observed
            ),
            "details": "Classifies OCR/detail-page text into product, benefit, effect, ingredient, usage, FAQ, review, price, and metric signals.",
        },
        {
            "stage": "embedding",
            "label": "Embedding",
            "provider": "aistudio" if embedding_provider == "aistudio" else "azure-api" if embedding_provider == "azure-openai" else "local",
            "service": "AI Studio embedding deployment"
            if embedding_provider == "aistudio"
            else "Azure API embedding deployment"
            if embedding_provider == "azure-openai"
            else "local hash embedding",
            **({"model": embedding["model"]} if embedding.get("model") is not None else {}),
            **({"deployment": embedding["deployment"]} if embedding.get("deployment") is not None else {}),
            "called": any(step.get("stage") == "embedding" for step in observed)
            or embedding_provider not in {"azure-openai", "aistudio"},
            "details": "Embeds extractor RAG policy query and candidate chunks through the AI Studio embedding deployment when configured."
            if embedding_provider == "aistudio"
            else "Embeds extractor RAG policy query and candidate chunks when Azure embedding credentials are configured."
            if embedding_provider == "azure-openai"
            else "Uses deterministic local embedding for extractor RAG policy retrieval.",
        },
        {
            "stage": "retrieval",
            "label": "Retrieval",
            "provider": "local",
            "service": "section-aware local hybrid retrieval",
            "mode": "BM25-like lexical + deterministic vector scoring",
            "called": True,
            "details": "Retrieves extractor RAG policy chunks before OCR classification and RAG chunk generation.",
        },
        {
            "stage": "reranking",
            "label": "Reranking",
            "provider": reranker_provider or "local-hybrid",
            "service": reranker_service,
            **({"model": reranker["model"]} if reranker_provider in {"cohere", "aistudio-bedrock-cohere"} and reranker.get("model") is not None else {}),
            "called": any(step.get("stage") == "reranking" for step in observed)
            or not reranker
            or reranker_provider == "local-hybrid",
            "details": reranker_details,
        },
    ]
    steps = _merge_runtime_steps([*baseline, *observed])
    totals: dict[str, int | float] = {}
    for step in steps:
        token_usage = as_mapping(step.get("tokenUsage"))
        if token_usage is None:
            continue
        for key in ("inputTokens", "outputTokens", "totalTokens"):
            value = token_usage.get(key)
            if isinstance(value, int | float) and not isinstance(value, bool):
                totals[key] = totals.get(key, 0) + value
    return {
        "steps": steps,
        "tokenTotals": totals,
        "tokenNote": "Token counts are summed from provider usage metadata returned by model APIs."
        if totals
        else "Token counts were not returned or do not apply to deterministic/search-only stages.",
    }


def _merge_runtime_steps(steps: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    output: dict[str, dict[str, Any]] = {}
    for step in steps:
        label = _string(step.get("label")) or ""
        current = output.get(label)
        if current is None:
            output[label] = dict(step)
            continue
        merged = {**current, **step, "called": bool(current.get("called")) or bool(step.get("called"))}
        left, right = as_mapping(current.get("tokenUsage")), as_mapping(step.get("tokenUsage"))
        if left is not None or right is not None:
            merged["tokenUsage"] = {
                key: (left.get(key, 0) if left is not None else 0) + (right.get(key, 0) if right is not None else 0)
                for key in ("inputTokens", "outputTokens", "totalTokens")
                if (left is not None and key in left) or (right is not None and key in right)
            }
        # TS merges duplicate runtime labels by joining both descriptions,
        # including identical baseline/observed detail strings.
        current_details = _string(current.get("details"))
        next_details = _string(step.get("details"))
        if current_details or next_details:
            merged["details"] = " ".join(item for item in (current_details, next_details) if item)
        output[label] = merged
    return list(output.values())


def _run(
    source: str,
    source_type: str,
    product: dict[str, Any],
    process: list[dict[str, Any]],
    evidence: list[dict[str, str]],
    warnings: list[dict[str, str]],
    *,
    runtime_usage: Mapping[str, Any] | None,
    normalizer_called: bool,
    ocr: Mapping[str, Any],
    runtime: Mapping[str, Any],
) -> ProductExtractionRun:
    generated_at = datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    usage_sequence_diagnostics = as_mapping(product.pop("_usageSequenceDiagnostics", None))
    rag_chunks = [dict(item) for raw in _array(_as_mapping(product.get("rag")).get("chunks")) if (item := as_mapping(raw))]
    result = {
        "source": source,
        "sourceType": source_type,
        "geoProduct": product,
        "generatedAt": generated_at,
        "ragProfile": _RAG_PROFILE,
    }
    diagnostics: dict[str, Any] = {
        "source": source,
        "sourceType": source_type,
        "process": process,
        "evidence": evidence,
        "warnings": warnings,
        "ragUsage": _rag_usage(rag_chunks),
        "ocr": {
            "provider": _provider_name(runtime),
            "targetsConsidered": len(ocr.get("sourceImages", [])),
            "inputsSent": len(ocr["imageTexts"]),
            "targets": [
                {
                    "imageUrl": item["imageUrl"],
                    "sliced": False,
                    "status": "extracted",
                    "textLength": len(item["text"]),
                    "issues": [],
                }
                for item in ocr["imageTexts"]
            ],
            "combination": {
                "candidatesIn": len(ocr["imageTexts"]),
                "duplicatesAbsorbed": 0,
                "overlapJoins": 0,
                "droppedCandidates": [],
                "candidatesOut": len(ocr["imageTexts"]),
            },
            "classification": {
                "batches": 1 if ocr["imageTexts"] else 0,
                "failedBatches": 0,
                "providerKeywords": sum(len(values) for values in ocr["keywords"].values()),
                "sentenceInsights": len(ocr["sentenceInsights"]),
                "confidence": 0.75 if ocr["imageTexts"] else 0,
            },
            "utilization": {
                "textBlocksInResult": len(ocr["textBlocks"]),
                "keywordsAttached": sum(len(values) for values in ocr["keywords"].values()),
                "sentenceInsightsByCategory": {},
                "ragChunksFromOcr": sum(
                    1 for chunk in product.get("rag", {}).get("chunks", []) if chunk["kind"] == "ocr"
                ),
                "unusedTexts": [],
            },
            "issues": [],
        },
        "generatedAt": generated_at,
        "ragProfile": _RAG_PROFILE,
    }
    observed_steps: list[dict[str, Any]] = []
    ocr_runtime_usage = as_mapping(ocr.get("_runtimeUsage"))
    if ocr_runtime_usage is not None:
        observed_steps.extend(
            dict(step)
            for raw in _array(ocr_runtime_usage.get("steps"))
            if (step := as_mapping(raw)) is not None
        )
    if normalizer_called:
        custom_normalizer = runtime.get("customProductNormalizer") or runtime.get("custom_product_normalizer")
        normalizer_step: dict[str, Any] = {
            "stage": "product-normalization",
            "label": "Product profile normalization/reasoning",
            "provider": "custom" if custom_normalizer is not None else _provider_name(runtime),
            "called": True,
            "details": "A source-backed product profile normalizer was called.",
        }
        if runtime_usage is not None:
            normalizer_step["tokenUsage"] = dict(runtime_usage)
        observed_steps.append(normalizer_step)
    observed_steps.extend(
        dict(step)
        for raw in _array(runtime.get("_runtimeSteps"))
        if (step := as_mapping(raw)) is not None
    )
    actual_ocr_diagnostics = as_mapping(ocr.get("_diagnostics"))
    if actual_ocr_diagnostics is not None:
        actual = dict(actual_ocr_diagnostics)
        utilization = dict(as_mapping(actual.get("utilization")) or {})
        utilization["ragChunksFromOcr"] = sum(1 for chunk in rag_chunks if chunk.get("kind") == "ocr")
        actual["utilization"] = utilization
        diagnostics["ocr"] = actual
    if usage_sequence_diagnostics is not None:
        diagnostics["ocr"]["usageSequences"] = dict(usage_sequence_diagnostics)
    diagnostics["runtimeUsage"] = _extractor_runtime_usage(runtime, observed_steps)
    return ProductExtractionRun(result=result, diagnostics=diagnostics)


def _provider_name(runtime: Mapping[str, Any]) -> str:
    llm = _as_mapping(runtime.get("llm"))
    return _string(runtime.get("provider")) or _string(llm.get("provider")) or "mock"


def _without_none(values: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in values.items() if value is not None and value != {}}
