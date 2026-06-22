# Schema.org Product Markup v1

Use schema.org JSON-LD to help machines identify PDP entities and cite grounded facts.

- Official sources checked on 2026-06-17: https://schema.org/Product, https://schema.org/FAQPage, https://schema.org/HowTo, https://schema.org/BreadcrumbList, https://schema.org/WebPage.
- Treat schema.org as the canonical source for type/property compatibility. This local document is a versioned operating guide, not a frozen replacement for the official docs.
- Generate an `@graph` with `WebPage`, `Product`, `FAQPage`, `HowTo`, and `BreadcrumbList` when source data supports them.
- Keep `WebPage.description` and `Product.description` distinct and detailed. Use `WebPage.description` for page-level coverage of benefits, ingredients, usage, customer reviews, reported results, and target-customer decision context. Use `Product.description` for the product entity itself: target customers, product-specific benefits, key ingredients or technologies, representative customer review language, how the product can be used, and source-supported results.
- `WebPage.description` should describe the PDP as the content source connected to the product through `mainEntity` or `about`; it may say that the page covers benefits, ingredients, usage, reviews, FAQ, HowTo, offers, variants, and reported results.
- `Product.description` should describe the product item itself; it should answer who the product is for, what benefits/effects it supports, what ingredients or technologies matter, how customers can use it, what representative reviews say, and what results are supported by source facts.
- `Product.name` should use the GEO-recommended product name, not an overstuffed keyword phrase.
- `Product.description` should be concise, factual, aligned with visible PDP content, and written as complete product-entity sentences. Do not include mid-sentence ellipses or page-level phrases such as "product page" in Product descriptions.
- Use `additionalProperty` for objective product characteristics such as key ingredients, skin type, size, texture, usage timing, target concern, and technology. Each `PropertyValue.value` should be an atomic single-line fact, not a multiline quick-facts block; avoid escaped newline markers such as `\n` in JSON-LD values.
- Use `positiveNotes` for product highlights, benefit statements, and review-backed positive points.
- Use `FAQPage.mainEntity` only when both question and answer are available.
- Use `HowTo.step` for explicit ordered usage instructions. If usage is short and unordered, keep it in `additionalProperty` and HTML content too.
- Use `BreadcrumbList` when URL, brand, category, or product hierarchy exists.
- Keep JSON-LD aligned with content visible in the generated HTML. Do not mark up hidden, irrelevant, or misleading facts.
- Do not expose internal diagnostic labels such as "evidence signal", "review signals", "technology signals", "GEO", "RAG", or "schema optimization" in JSON-LD values.
- Avoid fake reviews, unsupported ratings, and medical treatment language.
