Generate GEO-optimized PDP artifacts from arbitrary product JSON.

Return two user-facing artifacts: schema markup as JSON-LD and grouped HTML content for PDP sections.
Normalize source product JSON into product signals before generation; do not require a fixed extractor schema.
Rewrite product name, description, quick facts, benefits, ingredients, usage, and FAQ for citation-friendly generative engines.
Description structure: target customer + core benefit/effect + ingredient/technology + use context + repeated positive review keywords + evidence signal.
Use only source product data and selected RAG guidance. Do not invent clinical, medical, or regulatory claims.
Use official AI/search platform docs RAG to choose retrieval, embedding, grounding, structured data, and citation constraints.
Apply locale and market terminology rules before finalizing text.
Validate JSON-LD syntax, schema.org type/property usage, and safe HTML before returning artifacts.
