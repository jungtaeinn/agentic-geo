# PDP GEO Generator Analysis Prompt v1

## 1. Generation Goal

Generate GEO-optimized PDP artifacts from arbitrary product JSON.

Return two user-facing artifacts: schema markup as JSON-LD and grouped HTML content for PDP sections.

## 2. RAG Orchestration

- Use the typed RAG index first to route document-level and content-unit guidance before selecting schema, E-E-A-T, CEP, GEO research, official docs, locale, or best-practice chunks.
- Normalize source product JSON into product facts before generation; do not require a fixed extractor schema.
- When a product normalization agent is configured, use the deterministic normalized product only as a bootstrap and let the agent infer source-backed field routing from raw JSON, fieldMapping, hints, and policy documents before review keyword normalization.
- Prioritize RAG chunks that improve OCR sentence diagnostics, customer-review FAQ intent, WebPage.description versus Product.description separation, structured claim support, HowTo reconstruction, benefit/effect phrasing, and public wording.
- Use official AI/search platform docs RAG to choose retrieval, embedding, grounding, structured data, and answer eligibility constraints.

## 3. Source-Backed Rewriting

- Rewrite product name, description, quick facts, benefits, ingredients, usage, and FAQ into answer-ready PDP content with diverse product keywords, visible benefits, key actives, texture or comfort details, review phrasing, and grounded claim wording.
- Citation readiness must come from varied, natural product expressions and complete source-backed facts. Do not add public "quote", "citation", "citation phrase", or repeated stock claim wording to schema/content.
- Description structure: target customer + core benefit/effect + ingredient/technology + usage context + repeated positive review keywords + source-supported or review-backed detail.
- Use only source product data and selected RAG guidance. Do not invent clinical, medical, or regulatory claims.

## 3.1 Field Evidence Contract

- Treat field routing as a reasoning task before copywriting. First decide whether each source sentence is primarily product identity, benefit/effect, ingredient/technology, usage direction, review/customer expression, metric/evidence, FAQ, commerce, or page chrome.
- `HowTo.step` and `howToUse` may use only actionable usage directions: operation, order, amount, body area, timing, routine position, warning, or compatibility. Do not place benefit claims, clinical metrics, ingredient explanations, review summaries, or product-result sentences in HowTo even when they mention the current product.
- `ingredients` may use only ingredient names, formula technologies, INCI/full-ingredient lists, and source-backed ingredient-role explanations. Do not place customer review language, routine context, search-intent phrases, benefit summaries, or clinical result text in the ingredient section.
- `benefits` and `positiveNotes` may use benefits, effects, representative review-backed positives, and concise evidence topics. Do not copy full clinical sentences into benefit bullets; route full metrics to `Reported details` or evidence FAQ.
- `Product.description` can synthesize product identity, target customer, key benefits, ingredients/technology, representative customer review language, and concise reported evidence. It must not reuse HowTo sentences as if they were benefits or use internal labels such as "usage context", "customer review language", or "source-backed product evidence".
- `WebPage.description` should describe page coverage and evidence availability, not repeat the Product description verbatim.
- If a sentence could support multiple fields, keep the source fact in diagnostics and use field-specific paraphrases in public content. Blending evidence is allowed; blending field values is not.
- Do not solve routing errors with product-specific sentence blocklists. Classify each source sentence by evidence role, keep only current-product evidence, and regenerate field-specific public copy from that role.

## 4. Entity Separation

- Separate schema descriptions by entity role without making either description superficial: WebPage.description should explain that the page contains detailed benefit, ingredient, usage, customer-review, and reported-result information for the target customer, while Product.description should describe the product entity with target customers, specific benefits, key ingredients or technologies, representative customer review language, how the product can be used, and source-supported results.
- FAQPage mainEntity questions must be reconstructed from GEO question intent, repeated customer review language, product facts, and selected RAG guidance; do not expose page FAQ questions or answers verbatim.
- Benefit/effect and HowToUse sections must also be rewritten from product facts plus GEO RAG guidance, not copied from visible PDP labels or source section text.

## 5. OCR and Missing Evidence

- When OCR text is present, preserve semantic sentences or paragraph-level claims instead of reducing OCR to isolated keywords. Classify each OCR sentence by intent, such as ingredient/technology, benefit/effect, usage/routine, or customer/customer review language, and expose that analysis in diagnostics rather than public schema text.
- Use classified OCR sentences as source-backed evidence that is blended with product facts, selected RAG chunks, mapped fields, and customer review language for Product.description, WebPage.description, Key ingredients, Ingredient/effect detail, benefit sections, FAQ answers, HowTo steps, and full ingredient details. Do not create separate OCR-only benefit, ingredient, or FAQ content when broader product/RAG evidence is available. Rewrite the meaning into natural English for English output while keeping claims grounded in the OCR/source facts.
- When OCR data is absent, keep the same blended generation strategy using existing product facts, selected RAG chunks, source text, ingredient data, usage instructions, and customer review language.

## 6. Public Wording and Validation

- Do not expose internal labels such as evidence signal, review signals, technology signals, GEO, RAG, schema optimization, or citation optimization inside public JSON-LD or PDP content.
- Keep Product.additionalProperty values atomic and single-line. Do not place a multiline Quick facts block in Product schema, and do not expose escaped newline markers such as \n as visible content.
- Apply locale and market terminology rules before finalizing text.
- Validate JSON-LD syntax, schema.org type/property usage, and safe HTML before returning artifacts.
