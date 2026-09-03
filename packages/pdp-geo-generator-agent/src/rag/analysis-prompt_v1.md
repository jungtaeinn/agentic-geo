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
- Use only source product data and selected RAG guidance. Do not invent clinical, medical, or regulatory claims.

## 3.1 Field Evidence Contract

Every field rule in this prompt is subordinate to the content-field-contracts document, which carries the authoritative wording for each field contract. This section is the orchestration view of those contracts: which evidence role feeds which field, and in what order the generator decides.

- Treat field routing as a reasoning task before copywriting. First decide whether each source sentence is primarily product identity, benefit/effect, ingredient/technology, usage direction, review/customer expression, metric/evidence, FAQ, commerce, or page chrome.
- After field routing, construct only evidence-backed relations between target concern, ingredient/technology, benefit/effect, measured evidence, and review preference. A co-occurrence on the same page is not enough to claim that an ingredient causes an effect.
- Use those relations to infer distinct suitability, concern/effect, ingredient-role, evidence, routine, and review query intents. General semantic expansions may be retained as diagnostic query hypotheses, but they cannot become public product facts unless source or review evidence supports the added occasion or concern.
- `HowTo.step` carries actions only. Do not place benefit claims, clinical metrics, ingredient explanations, review summaries, or product-result sentences in HowTo, and do not route a frequency, amount, routine position, warning, test, or compatibility note there in place of an action.
- `ingredients` may use only ingredient names, formula technologies, INCI/full-ingredient lists, and source-backed ingredient-role explanations. Do not place customer review language, routine context, search-intent phrases, benefit summaries, or clinical result text in the ingredient section.
- `benefits` may use only source-backed finished-product outcomes, effects, and concise evidence topics. Review experience may surface in benefit context only when the wording remains explicitly review-attributed (route it to `additionalProperty` review context, never to `positiveNotes`). Do not copy full clinical sentences into benefit bullets; route full metrics to `Reported details` or evidence FAQ.
- `FAQPage.mainEntity` may use product-detail evidence such as benefits, ingredients/technology, usage, suitability, comparisons, metrics, and repeated positive or neutral review use-feel language. Do not create FAQ questions or answers from negative reviews, fragrance complaints, ratings, reviewer metadata, or raw review snippets.
- A benefits FAQ question asks, in buyer language, what the product helps with, and mentions a test result only when finished-product clinical evidence exists. State the properties, never a phrase to copy: name the product, name the concern or outcome the buyer is deciding about, and keep the internal evidence record out of the question — asking for it exposes the generation pipeline's sourcing apparatus rather than asking what a buyer would ask; avoid `what product evidence supports them?`. Reserve `published` or `peer-reviewed` for an actual bibliographic citation.
- Within `Product.description`, educational category facts must not become product composition, and one evidence group may be spent only once.
- Claims sharing an `evidenceGroup` and outcome family should share one institution/period/population/method context and retain every timing-to-value pair.
- `WebPage.description` must not claim brand history or expertise without separate current-source brand evidence. In Korean, page-scope language belongs in the opening only; later sentences should name the product or make the concern, formula, study, testing, offer, or review the subject instead of repeating `페이지 본문에서는`, `페이지에서 확인할 수 있는`, or `페이지에 공개된`.
- If a sentence could support multiple fields, keep the source fact in diagnostics and use field-specific paraphrases in public content. Blending evidence is allowed; blending field values is not.
- Do not solve routing errors with product-specific sentence blocklists; keep only current-product evidence and regenerate field-specific public copy from the evidence role decided above.

## 4. Entity Separation

Separate the schema descriptions by entity role under the Description Separation Contract in the content-field-contracts document, which also fixes the shared evidence order both descriptions follow. The rules below cover the other entity-level separations this pipeline has to make.

- Treat complete visible PDP FAQ as primary Q/A evidence: preserve direct, natural source items, and rewrite only when the intent and cited evidence remain unchanged. New FAQ must be distinct and directly answerable; never expose raw reviews, reviewer metadata, negative reviews, or review-only answers as FAQ.
- Direct and indirect query candidates must be inferred from customer situation, category, brand/product entity, benefits, and ingredients. Indirect queries omit product and brand names; direct queries include the product or brand. Preserve the query kind, keywords, and answer basis in diagnostics.
- Benefit/effect and visible usage sections should preserve source meaning and may retain already-natural source sentences; remove section labels and artifacts without inventing extra claims or actions.

## 5. OCR and Missing Evidence

- When OCR text is present, preserve semantic sentences or paragraph-level claims instead of reducing OCR to isolated keywords. Classify each OCR sentence by intent and expose that classification in diagnostics rather than in public schema text.
- When OCR collapses several measurements, captions, before/after labels, and a study footnote into one run-on block, first infer atomic evidence records. Separate delivery/depth or formulation results, duration claims, customer skin outcomes, and study context; capture endpoint, value/unit, direction, timing, baseline/comparator, institution, period, sample, method, and caveat only where the source supports them. Share study context only across outcomes explicitly grouped by the same footnote or study statement. Preserve the raw block as provenance, never as finished public copy.
- Use classified OCR sentences as source-backed evidence that is blended with product facts, selected RAG chunks, mapped fields, and customer review language for Product.description, WebPage.description, Key ingredients, Ingredient/effect detail, benefit sections, HowTo steps, and full ingredient details. Do not create separate OCR-only benefit, ingredient, or FAQ content when broader product/RAG evidence is available. Rewrite the meaning into natural English for English output while keeping claims grounded in the OCR/source facts.
- When OCR data is absent, keep the same blended generation strategy using existing product facts, selected RAG chunks, source text, ingredient data, usage instructions, and customer review language.

## 6. Public Wording and Validation

Internal wording is governed by the Public Wording Contract in the content-field-contracts document. The steps below are the pipeline's finishing pass.

- Keep Product.additionalProperty values atomic and single-line. Do not place a multiline Quick facts block in Product schema, and do not expose escaped newline markers such as \n as visible content.
- Apply locale and market terminology rules before finalizing text.
- Validate JSON-LD syntax, schema.org type/property usage, graph integrity, and public schema copy before returning the artifact.
