# Review Keyword Extraction v1

## 1. Purpose

Extract representative review keywords for GEO and schema downstream agents.

## 2. Source Coverage

1. Prefer JSON-LD Review/AggregateRating when present and aligned with visible page data.
2. If JSON-LD Review/AggregateRating is missing, read DOM review cards, `itemprop` fields, `aria-label` star ratings, review-count labels, and visible rating summaries.
3. Keep individual review body, author, rating, and date when present in the HTML.

## 3. Keyword Selection

- Prefer repeated concrete nouns and benefit phrases over generic sentiment.
- Classify texture, usability, delivery, scent, skin feel, durability, and satisfaction as review signals.
- Keep rating and review count separate from qualitative review keywords.
- Mark uncertain review-derived terms with lower certainty.

## 4. Diagnostics

- If review text is absent but rating/count exists, keep rating and count while adding a missing-review-language diagnostic.
- If delivery or purchase-service language appears in reviews, keep it as a review signal only and do not copy it into product benefit/effect fields.
