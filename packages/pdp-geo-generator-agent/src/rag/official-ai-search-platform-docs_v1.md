# Official AI and Search Platform Docs v1

## 1. Purpose

Use this document as a versioned connector map to official provider docs for retrieval, embeddings, grounding, structured data eligibility, and citation diagnostics.

- Official sources checked on 2026-06-24: OpenAI retrieval, OpenAI file search, OpenAI embeddings, Google Search Central Product structured data, Google Search generative AI optimization guidance, Gemini embeddings, Gemini grounding with Google Search, Perplexity Search API docs, Azure AI Search hybrid retrieval, and Azure agentic retrieval docs.
- Prefer official provider docs over blog posts or third-party summaries when deciding adapter behavior or generation constraints.
- Keep generated PDP claims grounded in product/source facts. Provider docs can guide retrieval and citation strategy, but they must not create new product benefits.

## 2. OpenAI Retrieval and Embeddings

- Official links: https://developers.openai.com/api/docs/guides/retrieval, https://developers.openai.com/api/docs/guides/tools-file-search, https://platform.openai.com/docs/guides/embeddings.
- Use OpenAI managed vector stores when the deployment wants provider-managed file ingestion, chunk indexing, retrieval, and query rewriting.
- Use local-versioned RAG when the deployment needs provider-neutral operation, editable local policy files, or the option to swap OpenAI for another embedding/search stack.
- Embeddings represent semantic relatedness and are appropriate for retrieval over official docs, product facts, reviews, locale terminology, and best-practice files.
- When OpenAI vector store mode is selected, make sure these managed RAG documents are also uploaded or synchronized to the vector store used by the app.
- Preserve source filenames, chunk titles, section intents, field targets, and selected excerpts in diagnostics so managed retrieval remains auditable.

## 3. Google Search Central Structured Data

- Official link: https://developers.google.com/search/docs/appearance/structured-data/product.
- Use Google Product structured data guidance as an eligibility and quality layer on top of schema.org compatibility.
- Product snippets and merchant listing experiences can require different property depth; add supported properties only when source data is available.
- Variant, offer, review, rating, and organization policy markup should be generated only when the input contains reliable evidence.

## 4. Google Generative AI Search Guidance

- Official link: https://developers.google.com/search/docs/fundamentals/ai-optimization-guide.
- Google describes its generative AI Search features as relying on Search ranking/quality systems, retrieval-augmented generation, and query fan-out over indexed, up-to-date pages.
- Build helpful, crawlable, well-structured, people-first PDP content with clear sections, source-backed product facts, and high-quality media.
- Do not treat artificial AI-only files, artificial chunking pages, or inauthentic mentions as Google AI Search hacks. In this project, typed RAG metadata, hybrid retrieval, reranking, and provenance diagnostics are the maintained orchestration mechanism.

## 5. Gemini Embeddings and Grounding

- Official links: https://ai.google.dev/gemini-api/docs/embeddings, https://ai.google.dev/gemini-api/docs/google-search.
- Gemini embeddings can be used as a managed or custom embedding adapter for provider-neutral RAG implementations.
- Embedding model upgrades can create incompatible embedding spaces, so re-embed stored documents when moving between incompatible Gemini embedding versions.
- For live grounding, current Gemini docs use Google Search grounding with the `google_search` tool for supported models.

## 6. Perplexity Search API

- Official link: https://docs.perplexity.ai/docs/search/quickstart.
- Use Perplexity Search API as a search/grounding source when the app needs real-time ranked web results with domain, language, or region filters.
- Prefer Search API for raw ranked result evidence and Sonar-style answer APIs only when the product explicitly needs generated prose with citations.
- Store retrieved URLs, snippets, checked dates, and provider names in diagnostics so GEO recommendations remain auditable.

## 7. Typed Metadata Index and Hybrid Retrieval

- Official links: https://learn.microsoft.com/en-us/azure/search/hybrid-search-overview, https://learn.microsoft.com/en-us/azure/search/semantic-search-overview, https://learn.microsoft.com/en-us/azure/search/agentic-retrieval-overview.
- Keep `rag-index.ts` as the source of truth for document metadata, section routing, source role, checked date, intent, field targets, and priority.
- Use hybrid retrieval and reranking when available: lexical matching catches exact schema/field terms, vector search catches semantic paraphrases, and semantic/reranker layers improve final ordering.
- Use agentic subquery planning for targeted partial updates such as FAQ, HowTo, Product.description, WebPage.description, or BreadcrumbList refreshes.
- Preserve selected source document, section title, intent, field target, score, query plan target, and excerpt in diagnostics.
