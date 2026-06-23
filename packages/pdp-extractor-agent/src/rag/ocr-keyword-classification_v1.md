# OCR Keyword Classification v1

Classify text found inside PDP images and long-scroll PDP sections.

Before classification, ignore obstructive page chrome such as account drawers, cart panels, search overlays, newsletter popups, cookie banners, and modal dialogs. The goal is to preserve product-detail evidence, not global navigation or promotional overlays.

Apply the same OCR policy to Korean and English PDP locales. Product-detail, technical-description, ingredient, benefit, efficacy, and usage images should be scanned whether they appear as DOM images, lazy-loaded attributes, `picture/source` sets, or product-detail image HTML embedded inside page scripts.

When OCR returns readable product copy, retain sentence-level insights in addition to keywords. A complete visual sentence such as an ingredient technology explanation can improve downstream schema descriptions, benefit/effect copy, ingredient sections, and RAG evidence more reliably than isolated terms.

Before creating sentence insights, reconstruct wrapped OCR lines into semantic sentences or paragraphs. Join adjacent lines when the next line continues the same clause, noun phrase, ingredient explanation, clinical-result row, or usage instruction. Do not split only because OCR introduced a line break, omitted a period, or wrapped visual text across columns.

For long pages, treat section text as OCR-like evidence when it contains concrete product signals:

- Hero summary, product headline, price, option, or size copy.
- Benefits, clinical results, efficacy claims, or survey/result wording.
- Ingredients, formula technology, skin type, target concern, and usage ritual.
- Hidden accordion or tab content whose headings are similar to Benefits, Ingredients, How to Use, Directions, Clinical Results, or FAQ.
- FAQ answers and review/survey snippets.
- Explicit OCR text attributes and visible product copy in PDP images. Ignore image alt/caption/nearby text when it only describes a visual scene, model, layout, or image placement instead of a product fact.

- Ignore purchase-layer, cart, coupon, loyalty point, delivery, exchange, refund, return, escrow, and legal notice text even when the page labels it as "benefit" or "혜택".

- `benefit`: customer-facing product value such as hydration, soothing, brightening, skin barrier support, elasticity, 자생력, 고밀도 피부, 영양감.
- `effect`: observable or claimed outcome such as wrinkle improvement, firming effect, moisture barrier improvement, 피부결 개선, 탄력 개선.
- `ingredient`: formula terms such as niacinamide, peptide, retinol, hyaluronic acid, ginseng, 진세노믹스, 인삼 펩타이드, 전성분.
- `usage`: how to use, dosage, timing, caution, target user, 사용법, 사용 방법.
- Sentence insights should preserve the source sentence or a compact source-backed clause. If one sentence links an ingredient/technology to outcomes, classify it by the strongest downstream field and keep related keywords together, for example ingredient keywords plus firmness/elasticity effect terms. Do not retain scene-description phrases; keep only citation-ready product facts, metrics, ingredients, benefits, effects, usage, FAQ, or review evidence.
- Use section headings as hints only. If a site uses custom labels, classify by the actual body text and keep source wording intact.
- `faq`: question-like copy or answer content.
- `review`: quoted customer expressions, rating snippets, survey copy.
- If the text is decorative or purely promotional, classify as `unknown` unless it supports a concrete field.
- Do not invent claims. Keep keywords close to the source wording so downstream schema/content agents can audit them.
