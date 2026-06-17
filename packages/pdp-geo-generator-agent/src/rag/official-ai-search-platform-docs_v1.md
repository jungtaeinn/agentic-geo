# Official AI and Search Platform Docs v1

Use this document as a versioned connector map to official provider docs for retrieval, embeddings, grounding, structured data eligibility, and citation diagnostics.

- Official sources checked on 2026-06-17: OpenAI retrieval, OpenAI file search, OpenAI embeddings, Google Search Central Product structured data, Gemini embeddings, Gemini grounding with Google Search, and Perplexity Search API docs.
- Prefer official provider docs over blog posts or third-party summaries when deciding adapter behavior or generation constraints.
- Keep generated PDP claims grounded in product/source facts. Provider docs can guide retrieval and citation strategy, but they must not create new product benefits.

## OpenAI Retrieval and Embeddings

- Official links: https://developers.openai.com/api/docs/guides/retrieval, https://developers.openai.com/api/docs/guides/tools-file-search, https://platform.openai.com/docs/guides/embeddings.
- Use OpenAI managed vector stores when the deployment wants provider-managed file ingestion, chunk indexing, retrieval, and query rewriting.
- Use local-versioned RAG when the deployment needs provider-neutral operation, editable local policy files, or the option to swap OpenAI for another embedding/search stack.
- Embeddings represent semantic relatedness and are appropriate for retrieval over official docs, product facts, reviews, locale terminology, and best-practice files.
- When OpenAI vector store mode is selected, make sure these managed RAG documents are also uploaded or synchronized to the vector store used by the app.

## Google Search Central Structured Data

- Official link: https://developers.google.com/search/docs/appearance/structured-data/product.
- Use Google Product structured data guidance as an eligibility and quality layer on top of schema.org compatibility.
- Product snippets and merchant listing experiences can require different property depth; add supported properties only when source data is available.
- Variant, offer, review, rating, and organization policy markup should be generated only when the input contains reliable evidence.

## Gemini Embeddings and Grounding

- Official links: https://ai.google.dev/gemini-api/docs/embeddings, https://ai.google.dev/gemini-api/docs/google-search.
- Gemini embeddings can be used as a managed or custom embedding adapter for provider-neutral RAG implementations.
- Embedding model upgrades can create incompatible embedding spaces, so re-embed stored documents when moving between incompatible Gemini embedding versions.
- For live grounding, current Gemini docs use Google Search grounding with the `google_search` tool for supported models.

## Perplexity Search API

- Official link: https://docs.perplexity.ai/docs/search/quickstart.
- Use Perplexity Search API as a search/grounding source when the app needs real-time ranked web results with domain, language, or region filters.
- Prefer Search API for raw ranked result evidence and Sonar-style answer APIs only when the product explicitly needs generated prose with citations.
- Store retrieved URLs, snippets, checked dates, and provider names in diagnostics so GEO recommendations remain auditable.
