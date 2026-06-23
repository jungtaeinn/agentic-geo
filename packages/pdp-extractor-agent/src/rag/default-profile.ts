import { productExtractorRagManifest } from "./manifest";

/** A document that can be attached to the product extractor RAG profile. */
export interface ProductExtractorRagDocument {
  name: string;
  version: string;
  content: string;
}

/** Default prompt and reference documents shared by the UI, REST adapter, and LLM prompt builder. */
export interface ProductExtractorRagProfile {
  profile: string;
  analysisPrompt: string;
  documents: ProductExtractorRagDocument[];
}

export const defaultProductExtractorAnalysisPrompt = [
  "상품 상세 페이지에서 상품명, 가격, 설명, 옵션, 효능, 효과, 성분, 사용법, FAQ, 리뷰 신호를 GEO 관점으로 추출합니다.",
  "추출한 내용은 schema.org Product/FAQ/Review 및 생성형 검색 노출을 고려해 근거 중심 RAG chunk로 정규화합니다.",
  "DOM, JSON-LD, OCR, 리뷰, REST API 근거가 있는 정보만 우선 사용하고 과장 표현은 배제합니다.",
  "혜택 적용가, 쿠폰, 포인트, 장바구니, 구매 레이어, 배송/교환/반품/환불/법적 고지 문구는 상품 효능·효과·성분·사용법 필드에 넣지 않습니다.",
  "한국어 PDP에서는 효능/피부 고민/상품 장점은 benefits, 효과/개선/결과는 effects, 주요 성분/전성분/원료는 ingredients, 사용법/사용 방법은 usage로 분류합니다."
].join("\n");

export const defaultProductExtractorRagProfile: ProductExtractorRagProfile = {
  profile: productExtractorRagManifest.profile,
  analysisPrompt: defaultProductExtractorAnalysisPrompt,
  documents: [
    {
      name: productExtractorRagManifest.documents.productNormalization,
      version: "v1",
      content: [
        "# Product Normalization v1",
        "",
        "Normalize product data into a stable JSON shape.",
        "",
        "- Prefer JSON-LD Product data when available.",
        "- Use meta title and Open Graph description as fallback evidence.",
        "- Keep price as the source string unless currency and numeric value are explicit.",
        "- Split benefits and effects into short customer-readable phrases.",
        "- Preserve product-detail accordion/tab body text when it is present in HTML, especially Benefits, Ingredients, How to Use, Directions, Clinical Results, and FAQ sections.",
        "- For Korean PDPs, keep `효능`, `피부 고민`, and product value copy in benefits; keep `효과`, `개선`, and result copy in effects; keep `주요 성분`, `전성분`, and formula copy in ingredients; keep `사용법` and `사용 방법` in usage.",
        "- Exclude purchase UI, cart layers, coupon/point benefits, delivery, exchange, return, refund, escrow, and seller/legal notices from product fields. These are diagnostics or page chrome, not GEO product raw data.",
        "- Store ingredient and usage sections as product information, not diagnostics, so downstream GEO schema/content agents can reuse the exact source wording.",
        "- Preserve normalized HTML content analysis in `geoProduct.contentAnalysis.sections` with category, title, body text, and concise bullets.",
        "- Return the public artifact as a product-centered `geoProduct` JSON object for GEO raw data.",
        "- Keep OCR text, review phrases, ingredients, benefits, effects, usage, FAQ, price, and quantitative metrics inside `geoProduct`.",
        "- Do not expose model certainty scores, crawl source, image audit URL, or chunk metadata in the public `geoProduct` object.",
        "- Do not invent claims that are not present in DOM, OCR, review, or API evidence."
      ].join("\n")
    },
    {
      name: productExtractorRagManifest.documents.ocrKeywordClassification,
      version: "v1",
      content: [
        "# OCR Keyword Classification v1",
        "",
        "Classify text found inside PDP images and long-scroll PDP sections.",
        "",
        "Before classification, ignore obstructive page chrome such as account drawers, cart panels, search overlays, newsletter popups, cookie banners, and modal dialogs. The goal is to preserve product-detail evidence, not global navigation or promotional overlays.",
        "",
        "Apply the same OCR policy to Korean and English PDP locales. Product-detail, technical-description, ingredient, benefit, efficacy, and usage images should be scanned whether they appear as DOM images, lazy-loaded attributes, `picture/source` sets, or product-detail image HTML embedded inside page scripts.",
        "",
        "When OCR returns readable product copy, retain sentence-level insights in addition to keywords. A complete visual sentence such as an ingredient technology explanation can improve downstream schema descriptions, benefit/effect copy, ingredient sections, and RAG evidence more reliably than isolated terms.",
        "",
        "Before creating sentence insights, reconstruct wrapped OCR lines into semantic sentences or paragraphs. Join adjacent lines when the next line continues the same clause, noun phrase, ingredient explanation, clinical-result row, or usage instruction. Do not split only because OCR introduced a line break, omitted a period, or wrapped visual text across columns.",
        "",
        "For long pages, treat section text as OCR-like evidence when it contains concrete product signals:",
        "",
        "- Hero summary, product headline, price, option, or size copy.",
        "- Benefits, clinical results, efficacy claims, or survey/result wording.",
        "- Ingredients, formula technology, skin type, target concern, and usage ritual.",
        "- Hidden accordion or tab content whose headings are similar to Benefits, Ingredients, How to Use, Directions, Clinical Results, or FAQ.",
        "- FAQ answers and review/survey snippets.",
        "- Explicit OCR text attributes and visible product copy in PDP images. Ignore image alt/caption/nearby text when it only describes a visual scene, model, layout, or image placement instead of a product fact.",
        "- Ignore purchase-layer, cart, coupon, loyalty point, delivery, exchange, refund, return, escrow, and legal notice text even when the page labels it as \"benefit\" or \"혜택\".",
        "",
        "- `benefit`: customer-facing product value such as hydration, soothing, brightening, skin barrier support, elasticity, 자생력, 고밀도 피부, 영양감.",
        "- `effect`: observable or claimed outcome such as wrinkle improvement, firming effect, moisture barrier improvement, 피부결 개선, 탄력 개선.",
        "- `ingredient`: formula terms such as niacinamide, peptide, retinol, hyaluronic acid, ginseng, 진세노믹스, 인삼 펩타이드, 전성분.",
        "- `usage`: how to use, dosage, timing, caution, target user, 사용법, 사용 방법.",
        "- Sentence insights should preserve the source sentence or a compact source-backed clause. If one sentence links an ingredient/technology to outcomes, classify it by the strongest downstream field and keep related keywords together, for example ingredient keywords plus firmness/elasticity effect terms. Do not retain scene-description phrases; keep only citation-ready product facts, metrics, ingredients, benefits, effects, usage, FAQ, or review evidence.",
        "- Use section headings as hints only. If a site uses custom labels, classify by the actual body text and keep source wording intact.",
        "- `faq`: question-like copy or answer content.",
        "- `review`: quoted customer expressions, rating snippets, survey copy.",
        "- If the text is decorative or purely promotional, classify as `unknown` unless it supports a concrete field.",
        "- Do not invent claims. Keep keywords close to the source wording so downstream schema/content agents can audit them."
      ].join("\n")
    },
    {
      name: productExtractorRagManifest.documents.reviewKeywordExtraction,
      version: "v1",
      content: [
        "# Review Keyword Extraction v1",
        "",
        "Extract representative review keywords for GEO and schema downstream agents.",
        "",
        "- Prefer repeated concrete nouns and benefit phrases over generic sentiment.",
        "- Keep rating and review count separate from qualitative review keywords.",
        "- If JSON-LD Review/AggregateRating is missing, read DOM review cards, `itemprop` fields, `aria-label` star ratings, review-count labels, and visible rating summaries.",
        "- Keep individual review body, author, rating, and date when present in the HTML.",
        "- Classify texture, usability, delivery, scent, skin feel, durability, and satisfaction as review signals.",
        "- Mark uncertain review-derived terms with lower certainty."
      ].join("\n")
    },
    {
      name: productExtractorRagManifest.documents.faqExtraction,
      version: "v1",
      content: [
        "# FAQ Extraction v1",
        "",
        "Extract FAQ content only when both question and answer are available.",
        "",
        "- Accept explicit FAQPage JSON-LD first.",
        "- Accept DOM sections with question-style headings and nearby answer text.",
        "- Avoid turning marketing slogans into FAQs.",
        "- Keep each answer short and factual."
      ].join("\n")
    }
  ]
};
