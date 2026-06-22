Generate GEO-optimized PDP artifacts from arbitrary product JSON.

Return two user-facing artifacts: schema markup as JSON-LD and grouped HTML content for PDP sections.
Normalize source product JSON into product facts before generation; do not require a fixed extractor schema.
Rewrite product name, description, quick facts, benefits, ingredients, usage, and FAQ into answer-ready, citation-friendly PDP content.
Description structure: target customer + core benefit/effect + ingredient/technology + use context + repeated positive review keywords + source-supported or review-backed detail.
Separate schema descriptions by entity role without making either description superficial: WebPage.description should explain that the page contains detailed benefit, ingredient, usage, customer-review, and reported-result information for the target customer, while Product.description should describe the product entity with target customers, specific benefits, key ingredients or technologies, representative customer review language, how the product can be used, and source-supported results.
FAQPage mainEntity questions must be reconstructed from GEO question intent, repeated customer review language, product facts, and selected RAG guidance; do not expose page FAQ questions or answers verbatim.
Benefit/effect and HowToUse sections must also be rewritten from product facts plus GEO RAG guidance, not copied from visible PDP labels or source section text.
Prioritize RAG chunks that improve customer-review FAQ intent, WebPage.description versus Product.description separation, structured claim support, HowTo reconstruction, benefit/effect phrasing, and public wording.
Do not expose internal labels such as evidence signal, review signals, technology signals, GEO, RAG, schema optimization, or citation optimization inside public JSON-LD or PDP content.
Keep Product.additionalProperty values atomic and single-line. Do not place a multiline Quick facts block in Product schema, and do not expose escaped newline markers such as \n as visible content.
Use only source product data and selected RAG guidance. Do not invent clinical, medical, or regulatory claims.
Use official AI/search platform docs RAG to choose retrieval, embedding, grounding, structured data, and citation constraints.
Apply locale and market terminology rules before finalizing text.
Validate JSON-LD syntax, schema.org type/property usage, and safe HTML before returning artifacts.
