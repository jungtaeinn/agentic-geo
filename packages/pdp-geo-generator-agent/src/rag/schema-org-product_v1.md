# Schema.org Product Markup v1

## 1. Purpose

Use schema.org JSON-LD to represent PDP entities and grounded facts consistently with visible content. Valid markup can improve machine understanding and search-feature eligibility, but it does not guarantee retrieval, citation, or display in a generative answer.

## 2. Official Source Scope

- Official sources checked on 2026-07-11: https://schema.org/Product, https://schema.org/FAQPage, https://schema.org/HowTo, https://schema.org/BreadcrumbList, https://schema.org/WebPage, https://developers.google.com/search/docs/appearance/ai-features, https://developers.google.com/search/docs/appearance/structured-data/sd-policies.
- Treat schema.org as the canonical source for type/property compatibility. This local document is a versioned operating guide, not a frozen replacement for the official docs.

## 3. Graph Composition

- Generate an `@graph` with `WebPage`, `Product`, `FAQPage`, `HowTo`, and `BreadcrumbList` when source data supports them.

## 4. WebPage and Product Descriptions

- Keep `WebPage.description` and `Product.description` distinct by entity role. Use `WebPage.description` for a compact but specific product-page introduction, source-backed brand identity, concrete supported information available on the page, and the remaining page scope. Use `Product.description` for the product entity itself in the order product introduction/type, target customer and concern, key ingredients or technologies, supported finished-product benefits/effects and compact evidence/test context, then an attributed customer-review summary.
- `WebPage.description` should describe the PDP as the content source connected to the product through `mainEntity` or `about`; mention FAQ, HowTo, offers, variants, or reported results only when the final visible page actually contains them.
- `Product.description` should describe the product item itself; it should answer what it is, who it is for, what ingredients or technologies compose it, what supported benefits/effects or evidence apply, and what customers report. Usage belongs in Usage/HowTo rather than interrupting that sequence.
- `Product.name` should use the GEO-recommended product name, not an overstuffed keyword phrase.
- `Product.description` should be concise, factual, aligned with visible PDP content, and written as complete product-entity sentences. Do not include mid-sentence ellipses or page-level phrases such as "product page" in Product descriptions.

## 5. Product Properties

- Use `additionalProperty` for objective product characteristics such as key ingredients, skin type, size, texture, usage timing, target concern, technology, and review-derived recommendation context when repeated positive/neutral reviews support the customer situation. `PropertyValue.name` must be a stable property label such as `Target concern`, `Customer review context`, `Review-derived recommendation context`, `Indirect customer question`, or `Direct product question`; do not put a full customer situation phrase or full question in `name`. Put the customer situation, question wording, or answer-ready evidence in `value` or route true Q/A pairs to `FAQPage.mainEntity`. Each `PropertyValue.value` should be an atomic single-line fact, not a multiline quick-facts block; avoid escaped newline markers such as `\n` in JSON-LD values.
- When OCR sentences provide ingredient, benefit, usage, review, or full-ingredient evidence, blend the classified sentence meaning with product facts, selected RAG chunks, mapped fields, and review language for schema fields such as `Product.description`, `WebPage.description`, `additionalProperty`, `positiveNotes`, and `HowTo.step`. Do not create OCR-only FAQ or benefit content when broader product/RAG evidence exists, and do not expose OCR diagnostic labels or raw image URLs in public schema values.
- When OCR data is absent, keep schema content varied by blending existing product facts, selected RAG chunks, source text, ingredient data, usage instructions, and customer review language.
- Use `positiveNotes` for product highlights, benefit statements, and review-backed positive points.

## 6. FAQPage, HowTo, and BreadcrumbList

- Use `FAQPage.mainEntity` only for final question-and-answer pairs that are also visible and directly supported by product evidence. There is no minimum item count; omit the node when no item passes.
- Google stopped showing FAQ rich results on 2026-05-07. Retain `FAQPage` here only as schema.org-valid, visible product Q/A semantics for downstream consumers; do not describe it as Google FAQ rich-result optimization or as a citation guarantee.
- Use `HowTo.step` only when the source supports a concrete goal and at least two explicitly ordered customer actions; preserve the original step count and order. Keep one application instruction as ordinary visible usage guidance without HowTo structured data. Omit HowTo for warnings, test conditions, vague frequency/compatibility notes, or other text without a concrete customer action.
- Use `BreadcrumbList` when URL, brand, category, or product hierarchy exists.

## 7. Public Safety

- Keep JSON-LD aligned with content visible in the generated HTML. Do not mark up hidden, irrelevant, or misleading facts.
- Do not expose internal diagnostic labels such as "evidence signal", "review signals", "technology signals", "GEO", "RAG", or "schema optimization" in JSON-LD values.
- Avoid fake reviews, unsupported ratings, and medical treatment language.
