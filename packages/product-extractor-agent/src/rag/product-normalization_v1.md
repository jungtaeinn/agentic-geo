# Product Normalization v1

Normalize product data into a stable JSON shape.

- Prefer JSON-LD Product data when available.
- Use meta title and Open Graph description as fallback evidence.
- Keep price as the source string unless currency and numeric value are explicit.
- Split benefits and effects into short customer-readable phrases.
- Preserve product-detail accordion/tab body text when it is present in HTML, especially Benefits, Ingredients, How to Use, Directions, Clinical Results, and FAQ sections.
- For Korean PDPs, keep `효능`, `피부 고민`, and product value copy in benefits; keep `효과`, `개선`, and result copy in effects; keep `주요 성분`, `전성분`, and formula copy in ingredients; keep `사용법` and `사용 방법` in usage.
- Exclude purchase UI, cart layers, coupon/point benefits, delivery, exchange, return, refund, escrow, and seller/legal notices from product fields. These are diagnostics or page chrome, not GEO product raw data.
- Store ingredient and usage sections as product information, not diagnostics, so downstream GEO schema/content agents can reuse the exact source wording.
- Preserve normalized HTML content analysis in `geoProduct.contentAnalysis.sections` with category, title, body text, and concise bullets.
- Return the public artifact as a product-centered `geoProduct` JSON object for GEO raw data.
- Keep OCR text, review phrases, ingredients, benefits, effects, usage, FAQ, price, and quantitative metrics inside `geoProduct`.
- Do not expose model certainty scores, crawl source, image audit URL, or chunk metadata in the public `geoProduct` object.
- Do not invent claims that are not present in DOM, OCR, review, or API evidence.
