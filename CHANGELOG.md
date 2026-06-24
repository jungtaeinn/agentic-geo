# agentic-geo Changelog

All notable changes will be managed with Changesets.

## 0.2.0

- feat: upgrade the workspace to a multi AI agent architecture with agentic query planning, contextual chunking, hybrid retrieval, reranking, and strategic full document hydration.
- feat: replace product-specific RAG examples with source-agnostic field evidence contracts for FAQ, HowTo, ingredient, benefit, and claim routing.
- feat: add field-contract validation repairs so generated schema/content can detect misrouted usage, ingredient, benefit, metric, review, and internal-label text.
- docs: refresh README guidance and package metadata descriptions for the current RAG-grounded GEO generation pipeline.

## 0.1.0

- feat: formalize Agentic GEO as a multi-sub-agent workspace for PDP extraction, GEO schema/content generation, and validation/diagnostics orchestration.
- feat: document the service-oriented orchestration model where apps can run extractor, generator, and validation flows according to URL, REST API, or manual JSON inputs.
- feat: refresh package metadata, descriptions, and keywords around Generative Engine Optimization, schema.org JSON-LD, RAG, product content, and sub-agent composition.
- docs: expand README guidance for the root workspace, GEO Generator app, PDP Extractor app, and reusable agent packages.

## 0.0.1

- feat: initialize the Agentic GEO product extraction workflow with URL/REST API ingestion, AI provider settings, OCR/review signal processing, RAG chunk generation, and copyable GEO RAW JSON output.
- fix: improve extraction reliability and UX by preserving duplicate URL runs as separate history rows, persisting session history across refreshes, stabilizing attachment handling, and clarifying responsive progress/result states.
- chore: prepare the release with README documentation, package metadata, author information, manifest icons, profile branding, and workspace setup guidance.

## 0.0.0

- Initialized the product extractor workspace structure.
