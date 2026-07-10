# Schema.org Product Markup v1

## 1. Purpose

Use schema.org JSON-LD to help machines identify PDP entities and cite grounded facts.

## 2. Official Source Scope

- Official sources checked on 2026-06-24: https://schema.org/Product, https://schema.org/FAQPage, https://schema.org/HowTo, https://schema.org/BreadcrumbList, https://schema.org/WebPage.
- Treat schema.org as the canonical source for type/property compatibility. This local document is a versioned operating guide, not a frozen replacement for the official docs.

## 3. Graph Composition

- Generate an `@graph` with `WebPage`, `Product`, `FAQPage`, `HowTo`, and `BreadcrumbList` when source data supports them.

## 4. WebPage and Product Descriptions

- Keep `WebPage.description` and `Product.description` distinct and detailed. Use `WebPage.description` for page-level coverage of benefits, ingredients, high-level usage/comparison/review context, reported results, and target-customer decision context. Use `Product.description` for the product entity itself in the order target customer, product identity, key ingredients or technologies, product-specific benefits or supported metrics, then high-level usage/comparison/review context.
- `WebPage.description` should describe the PDP as the content source connected to the product through `mainEntity` or `about`; mention FAQ, HowTo, offers, variants, or reported results only when the final visible page actually contains them.
- `Product.description` should describe the product item itself; it should answer who the product is for, what product type it is, what ingredients or technologies matter, what benefits/effects or supported metrics apply, and only then add high-level routine, comparison, or representative review context.
- `Product.name` should use the GEO-recommended product name, not an overstuffed keyword phrase.
- `Product.description` should be concise, factual, aligned with visible PDP content, and written as complete product-entity sentences. Do not include mid-sentence ellipses or page-level phrases such as "product page" in Product descriptions.

## 5. Product Properties

- Use `additionalProperty` for objective product characteristics such as key ingredients, skin type, size, texture, usage timing, target concern, technology, and review-derived recommendation context when repeated positive/neutral reviews support the customer situation. `PropertyValue.name` must be a stable property label such as `Target concern`, `Customer review context`, `Review-derived recommendation context`, `Indirect customer question`, or `Direct product question`; do not put a full customer situation phrase or full question in `name`. Put the customer situation, question wording, or answer-ready evidence in `value` or route true Q/A pairs to `FAQPage.mainEntity`. Each `PropertyValue.value` should be an atomic single-line fact, not a multiline quick-facts block; avoid escaped newline markers such as `\n` in JSON-LD values.
- When OCR sentences provide ingredient, benefit, usage, review, or full-ingredient evidence, blend the classified sentence meaning with product facts, selected RAG chunks, mapped fields, and review language for schema fields such as `Product.description`, `WebPage.description`, `additionalProperty`, `positiveNotes`, and `HowTo.step`. Do not create OCR-only FAQ or benefit content when broader product/RAG evidence exists, and do not expose OCR diagnostic labels or raw image URLs in public schema values.
- When OCR data is absent, keep schema content varied by blending existing product facts, selected RAG chunks, source text, ingredient data, usage instructions, and customer review language.
- Use `positiveNotes` for product highlights, benefit statements, and review-backed positive points.

## 6. FAQPage, HowTo, and BreadcrumbList

- Use `FAQPage.mainEntity` only for final question-and-answer pairs that are also visible and directly supported by product evidence. There is no minimum item count; omit the node when no item passes.
- Use `HowTo.step` only for an explicit ordered sequence with at least two distinct source-backed actions and a concrete goal. If usage is a single note or unordered, keep it in `additionalProperty` and visible HTML content and omit HowTo.
- Use `BreadcrumbList` when URL, brand, category, or product hierarchy exists.

## 7. Public Safety

- Keep JSON-LD aligned with content visible in the generated HTML. Do not mark up hidden, irrelevant, or misleading facts.
- Do not expose internal diagnostic labels such as "evidence signal", "review signals", "technology signals", "GEO", "RAG", or "schema optimization" in JSON-LD values.
- Avoid fake reviews, unsupported ratings, and medical treatment language.
