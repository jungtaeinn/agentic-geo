Generate GEO-optimized PDP artifacts from arbitrary product JSON.

Return two user-facing artifacts: schema markup as JSON-LD and grouped HTML content for PDP sections.
Normalize source product JSON into product facts before generation; do not require a fixed extractor schema.
Rewrite product name, description, quick facts, benefits, ingredients, usage, and FAQ into answer-ready PDP content with diverse product keywords, visible benefits, key actives, texture or comfort details, review phrasing, and grounded claim wording.
Citation readiness must come from varied, natural product expressions and complete source-backed facts. Do not add public "quote", "citation", "citation phrase", or repeated stock claim wording to schema/content.
Description structure: target customer + core benefit/effect + ingredient/technology + routine fit + repeated positive review keywords + source-supported or review-backed detail.
Separate schema descriptions by entity role without making either description superficial: WebPage.description should explain that the page contains detailed benefit, ingredient, usage, customer-review, and reported-result information for the target customer, while Product.description should describe the product entity with target customers, specific benefits, key ingredients or technologies, representative customer review language, how the product can be used, and source-supported results.
When OCR text is present, preserve semantic sentences or paragraph-level claims instead of reducing OCR to isolated keywords. Classify each OCR sentence by intent, such as ingredient/technology, benefit/effect, usage/routine, or customer/review language, and expose that analysis in diagnostics rather than public schema text.
Use classified OCR sentences as source-backed evidence that is blended with product facts, selected RAG chunks, mapped fields, and review language for Product.description, WebPage.description, Key ingredients, Ingredient/effect detail, benefit sections, FAQ answers, HowTo steps, and full ingredient details. Do not create separate OCR-only benefit, ingredient, or FAQ content when broader product/RAG evidence is available. Rewrite the meaning into natural English for English output while keeping claims grounded in the OCR/source facts.
When OCR data is absent, keep the same blended generation strategy using existing product facts, selected RAG chunks, source text, ingredient data, usage instructions, and customer review language.
FAQPage mainEntity questions must be reconstructed from GEO question intent, repeated customer review language, product facts, and selected RAG guidance; do not expose page FAQ questions or answers verbatim.
Benefit/effect and HowToUse sections must also be rewritten from product facts plus GEO RAG guidance, not copied from visible PDP labels or source section text.
Prioritize RAG chunks that improve OCR sentence diagnostics, customer-review FAQ intent, WebPage.description versus Product.description separation, structured claim support, HowTo reconstruction, benefit/effect phrasing, and public wording.
Do not expose internal labels such as evidence signal, review signals, technology signals, GEO, RAG, schema optimization, or citation optimization inside public JSON-LD or PDP content.
Keep Product.additionalProperty values atomic and single-line. Do not place a multiline Quick facts block in Product schema, and do not expose escaped newline markers such as \n as visible content.
Use only source product data and selected RAG guidance. Do not invent clinical, medical, or regulatory claims.
Use official AI/search platform docs RAG to choose retrieval, embedding, grounding, structured data, and answer eligibility constraints.
Apply locale and market terminology rules before finalizing text.
Validate JSON-LD syntax, schema.org type/property usage, and safe HTML before returning artifacts.
