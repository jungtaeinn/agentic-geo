# @agentic-geo/pdp-geo-generator-agent

## 0.1.0

### Minor Changes

- feat: provide a reusable PDP GEO generation sub agent for arbitrary product JSON and extracted GEO RAW JSON inputs.
- feat: normalize product signals with optional field mapping, load versioned RAG guidance, retrieve/rerank chunks, and generate schema.org JSON-LD plus GEO PDP HTML sections.
- feat: add validation and repair diagnostics for JSON-LD graph structure, required Product fields, FAQ/HowTo nodes, and safe accordion HTML.
- feat: expose locale terminology decisions, recommendations, evidence, selected RAG chunks, runtime RAG mode metadata, and a Web API REST handler.
- docs: refresh README and package metadata for generator orchestration and validation workflows.

## 0.0.1

- Added initial PDP GEO generator package.
- Added arbitrary product JSON normalization with optional field mapping.
- Added local versioned RAG and managed vector store RAG provider interface.
- Added schema.org JSON-LD generation for WebPage, Product, FAQPage, HowTo, and BreadcrumbList.
- Added GEO HTML accordion content generation, locale terminology mapping, diagnostics, validation, and repair.
