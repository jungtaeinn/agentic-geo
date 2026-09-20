# Product Normalization v1

## 1. Purpose

Normalize product data into a stable JSON shape.

## 2. Source Priority

1. Prefer JSON-LD Product data when available.
2. Use DOM product sections, hidden accordions, tabs, and embedded detail HTML when they contain product facts.
3. Use meta title and Open Graph description as fallback evidence.
4. Use OCR, review, FAQ, and API evidence when they add field-specific facts that are missing from structured data.

## 3. Field Rules

- Keep price as the source string unless currency and numeric value are explicit.
- Treat deterministic DOM/API key matching as bootstrap evidence. When a product normalization agent is configured, let it infer field routing from raw source data and this RAG policy, then accept only values that are source-backed by the raw source or bootstrap product.
- Split benefits and effects into short customer-readable phrases.
- Preserve product-detail accordion/tab body text when it is present in HTML, especially Benefits, Ingredients, How to Use, Directions, Clinical Results, and FAQ sections.
- For Korean PDPs:
  - Keep `효능`, `피부 고민`, and product value copy in benefits.
  - Keep `효과`, `개선`, and result copy in effects.
  - Keep `주요 성분`, `전성분`, and formula copy in ingredients.
  - Keep `사용법` and `사용 방법` in usage.
- Store ingredient and usage sections as product information, not diagnostics, so downstream GEO schema/content agents can reuse the exact source wording.

## 4. Content Analysis Output

- Preserve normalized HTML content analysis in `geoProduct.contentAnalysis.sections` with category, title, body text, and concise bullets.
- Return the public artifact as a product-centered `geoProduct` JSON object for GEO raw data.
- Keep OCR text, review phrases, ingredients, benefits, effects, usage, FAQ, price, and quantitative metrics inside `geoProduct`.

## 5. Exclusions and Diagnostics

- Exclude purchase UI, cart layers, coupon/point benefits, delivery, exchange, return, refund, escrow, and seller/legal notices from product fields. These are diagnostics or page chrome, not GEO product raw data.
- Do not expose model certainty scores, crawl source, image audit URL, or chunk metadata in the public `geoProduct` object.
- Do not invent claims that are not present in DOM, OCR, review, or API evidence.
- If fields overlap, keep the source-backed product fact in the product field and put routing/conflict details in diagnostics.
- Record accepted model/custom-agent normalization in diagnostics evidence so operators can see which fields were inferred rather than directly matched by fixed selectors or key candidates.
