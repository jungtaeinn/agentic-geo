# Schema.org Product Markup v1

Use schema.org JSON-LD to help machines identify PDP entities and cite grounded facts.

- Official sources checked on 2026-06-17: https://schema.org/Product, https://schema.org/FAQPage, https://schema.org/HowTo, https://schema.org/BreadcrumbList, https://schema.org/WebPage.
- Treat schema.org as the canonical source for type/property compatibility. This local document is a versioned operating guide, not a frozen replacement for the official docs.
- Generate an `@graph` with `WebPage`, `Product`, `FAQPage`, `HowTo`, and `BreadcrumbList` when source data supports them.
- `Product.name` should use the GEO-recommended product name, not an overstuffed keyword phrase.
- `Product.description` should be concise, factual, and aligned with visible PDP content.
- Use `additionalProperty` for objective product characteristics such as key ingredients, skin type, size, texture, usage timing, target concern, and technology.
- Use `positiveNotes` for product highlights, benefit statements, and review-backed positive points.
- Use `FAQPage.mainEntity` only when both question and answer are available.
- Use `HowTo.step` for explicit ordered usage instructions. If usage is short and unordered, keep it in `additionalProperty` and HTML content too.
- Use `BreadcrumbList` when URL, brand, category, or product hierarchy exists.
- Keep JSON-LD aligned with content visible in the generated HTML. Do not mark up hidden, irrelevant, or misleading facts.
- Avoid fake reviews, unsupported ratings, and medical treatment language.
