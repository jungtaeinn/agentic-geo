# PDP GEO Generator Analysis Prompt v1

## 1. Generation Goal

Generate GEO-optimized PDP artifacts from arbitrary product JSON.

Return one user-facing artifact: schema markup as JSON-LD. HTML CONTENT is currently disabled; internal section copy may support planning and proofreading but must not be rendered or scored.

## 2. RAG Orchestration

- Use the typed RAG index first to route document-level and content-unit guidance before selecting schema, E-E-A-T, CEP, GEO research, official docs, locale, or best-practice chunks.
- Normalize source product JSON into product facts before generation; do not require a fixed extractor schema.
- When a product normalization agent is configured, use the deterministic normalized product only as a bootstrap and let the agent infer source-backed field routing from raw JSON, fieldMapping, hints, and policy documents before review keyword normalization.
- Prioritize RAG chunks with hybrid retrieval and coverage-aware reranking: combine exact lexical field matches, semantic similarity, reciprocal-rank fusion, field-target metadata, and document-kind diversity so one strategy document cannot crowd out schema, official docs, locale, or field-contract guidance.
- Prioritize RAG chunks that improve OCR sentence diagnostics, positive or neutral customer-review FAQ intent, WebPage.description versus Product.description separation, structured claim support, source-faithful HowTo eligibility, benefit/effect phrasing, and public wording.
- Use official AI/search platform docs RAG to choose retrieval, embedding, grounding, structured data, and answer eligibility constraints.

## 3. Source-Backed Rewriting

- Rewrite product name, description, quick facts, benefits, ingredients, usage, and FAQ into answer-ready PDP content with diverse product keywords, visible benefits, key actives, texture or comfort details, and grounded claim wording. Use positive or neutral review phrasing for review-intent FAQ and review-derived recommendation context only when it is reusable and source-backed.
- Citation readiness must come from varied, natural product expressions and complete source-backed facts. Do not add public "quote", "citation", "citation phrase", or repeated stock claim wording to schema/content.
- `Product.description` structure: product introduction/type -> target customer and concern/CEP -> ingredient/technology composition -> supported finished-product benefit/effect -> source-stated research/article citation -> attributed customer-review keywords last. Keep usage in Usage/HowTo.
- Use only source product data and selected RAG guidance. Do not invent clinical, medical, or regulatory claims.

## 3.1 Field Evidence Contract

- Treat field routing as a reasoning task before copywriting. First decide whether each source sentence is primarily product identity, benefit/effect, ingredient/technology, usage direction, review/customer expression, metric/evidence, FAQ, commerce, or page chrome.
- After field routing, construct only evidence-backed relations between target concern, ingredient/technology, benefit/effect, measured evidence, and review preference. A co-occurrence on the same page is not enough to claim that an ingredient causes an effect.
- Use those relations to infer distinct suitability, concern/effect, ingredient-role, evidence, routine, and review query intents. General semantic expansions may be retained as diagnostic query hypotheses, but they cannot become public product facts unless source or review evidence supports the added occasion or concern.
- `HowTo.step` requires a concrete goal and at least one direct source action. Preserve source cardinality: one application instruction becomes exactly one step; multiple steps require an explicitly ordered source sequence and retain its count/order. Frequency, amount, routine position, warning, test, compatibility text, and customer-review usage anecdotes without a direct product instruction are not HowTo. Do not place benefit claims, clinical metrics, ingredient explanations, review summaries, or product-result sentences in HowTo.
- `ingredients` may use only ingredient names, formula technologies, INCI/full-ingredient lists, and source-backed ingredient-role explanations. Do not place customer review language, routine context, search-intent phrases, benefit summaries, or clinical result text in the ingredient section.
- `benefits` may use only source-backed finished-product outcomes, effects, and concise evidence topics. `positiveNotes` may include review experience only when the wording remains explicitly review-attributed. Do not copy full clinical sentences into benefit bullets; route full metrics to `Reported details` or evidence FAQ.
- `FAQPage.mainEntity` may use product-detail evidence such as benefits, ingredients/technology, usage, suitability, comparisons, metrics, and repeated positive or neutral review use-feel language. Product-specific questions must name the exact product instead of using a deictic subject such as `이 제품`, `이 크림`, `this product`, or `this cream`. Do not create FAQ questions or answers from negative reviews, fragrance complaints, ratings, reviewer metadata, or raw review snippets.
- Benefits FAQ should use natural customer wording. Add `공개된 인체적용시험 결과는 어떻게 나타났나요?` or `what do the reported clinical study results show?` only when finished-product clinical evidence exists; otherwise ask only about the main benefits. Never use `what product evidence supports them?`, and reserve `published` or `peer-reviewed` for an actual bibliographic citation.
- `Product.description` can synthesize product identity/type, target customer and concern, detailed ingredients/technology, supported benefits/effects with exact completed safety tests inside that evidence block, one deduplicated study or related-article citation, and attributed review keywords in that order when evidence exists. Preserve the cited work's source-stated date, title/publisher, numbers, and finding in natural prose. It may be materially more detailed than `WebPage.description`, but educational category facts must not become product composition and the same evidence group must appear only once. It must not reuse HowTo sentences or internal analysis labels.
- Treat the Product.description evidence order as one CEP-led explanation, not a field list. Connect customer concern, product fit, formula, explicitly supported component role, finished-product effect, study context, and review language with natural transitions while preserving claim boundaries. Claims with the same evidenceGroup and outcome family should share one institution/period/population/method context and retain every timing-to-value pair.
- `WebPage.description` should introduce the product page and source-backed brand, then use the supported CEP to connect target customer, ingredient/technology, benefit/effect, high-level routine timing, research or a concise same-study result, completed testing, matched offer, and attributed review experience when available. It must not copy Product wording, exact HowTo actions, or raw report-like metrics. Brand history or expertise requires separate current-source brand evidence. In Korean, page-scope language belongs in the opening only; later sentences should name the product or make the concern, formula, study, testing, offer, or review the subject instead of repeating `페이지 본문에서는`, `페이지에서 확인할 수 있는`, or `페이지에 공개된`.
- If a sentence could support multiple fields, keep the source fact in diagnostics and use field-specific paraphrases in public content. Blending evidence is allowed; blending field values is not.
- Do not solve routing errors with product-specific sentence blocklists. Classify each source sentence by evidence role, keep only current-product evidence, and regenerate field-specific public copy from that role.

## 4. Entity Separation

- Separate schema descriptions by entity role but keep a shared evidence order: product/page introduction -> target customer/concern -> composition -> benefit/effect -> source-stated research or related-article citation -> attributed review keywords last. `WebPage.description` uses compact page-scope language; `Product.description` is the detailed product-entity narrative. Parse cited dates, publisher/title, findings, and numbers into natural prose without changing values or inventing metadata.
- Treat complete visible PDP FAQ as primary Q/A evidence: preserve direct, natural source items, and rewrite only when the intent and cited evidence remain unchanged. New FAQ must be distinct and directly answerable; never expose raw reviews, reviewer metadata, negative reviews, or review-only answers as FAQ.
- Direct and indirect query candidates must be inferred from customer situation, category, brand/product entity, benefits, and ingredients. Indirect queries omit product and brand names; direct queries include the product or brand. Preserve the query kind, keywords, and answer basis in diagnostics.
- Benefit/effect and visible usage sections should preserve source meaning and may retain already-natural source sentences; remove section labels and artifacts without inventing extra claims or actions.

## 5. OCR and Missing Evidence

- When OCR text is present, preserve semantic sentences or paragraph-level claims instead of reducing OCR to isolated keywords. Classify each OCR sentence by intent, such as ingredient/technology, benefit/effect, usage/routine, or customer/customer review language, and expose that analysis in diagnostics rather than public schema text.
- When OCR collapses several measurements, captions, before/after labels, and a study footnote into one run-on block, first infer atomic evidence records. Separate delivery/depth or formulation results, duration claims, customer skin outcomes, and study context; capture endpoint, value/unit, direction, timing, baseline/comparator, institution, period, sample, method, and caveat only where the source supports them. Share study context only across outcomes explicitly grouped by the same footnote or study statement. Preserve the raw block as provenance, never as finished public copy.
- Use classified OCR sentences as source-backed evidence that is blended with product facts, selected RAG chunks, mapped fields, and customer review language for Product.description, WebPage.description, Key ingredients, Ingredient/effect detail, benefit sections, HowTo steps, and full ingredient details. Do not create separate OCR-only benefit, ingredient, or FAQ content when broader product/RAG evidence is available. Rewrite the meaning into natural English for English output while keeping claims grounded in the OCR/source facts.
- When OCR data is absent, keep the same blended generation strategy using existing product facts, selected RAG chunks, source text, ingredient data, usage instructions, and customer review language.

## 6. Public Wording and Validation

- Do not expose internal labels such as evidence signal, review signals, technology signals, GEO, RAG, schema optimization, or citation optimization inside public JSON-LD or PDP content.
- Keep Product.additionalProperty values atomic and single-line. Do not place a multiline Quick facts block in Product schema, and do not expose escaped newline markers such as \n as visible content.
- Apply locale and market terminology rules before finalizing text.
- Validate JSON-LD syntax, schema.org type/property usage, graph integrity, and public schema copy before returning the artifact.
