# Review Keyword Extraction v1

Extract representative review keywords for GEO and schema downstream agents.

- Prefer repeated concrete nouns and benefit phrases over generic sentiment.
- Keep rating and review count separate from qualitative review keywords.
- If JSON-LD Review/AggregateRating is missing, read DOM review cards, `itemprop` fields, `aria-label` star ratings, review-count labels, and visible rating summaries.
- Keep individual review body, author, rating, and date when present in the HTML.
- Classify texture, usability, delivery, scent, skin feel, durability, and satisfaction as review signals.
- Mark uncertain review-derived terms with lower certainty.
