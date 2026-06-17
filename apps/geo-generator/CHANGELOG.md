# @agentic-geo/geo-generator

## 0.1.0

### Minor Changes

- feat: position the app as the main Agentic GEO orchestration console for extractor, generator, validation, and diagnostics sub-agent stages.
- feat: support URL, REST API, and manual JSON inputs with field mapping, locale/market hints, runtime RAG mode selection, and provider settings.
- feat: expose schema.org JSON-LD, copyable script tags, GEO HTML content sections, recommendations, evidence, terminology decisions, validation warnings, and selected RAG chunks in the result UI.
- docs: refresh README and package metadata for the GEO orchestration workflow.
- Updated dependencies:
  - @agentic-geo/pdp-extractor-agent@0.1.0
  - @agentic-geo/pdp-geo-generator-agent@0.1.0

## 0.0.1

### Patch Changes

- chore: prepare the 0.0.1 release with README documentation, package metadata, author information, manifest icons, profile branding, and workspace setup guidance.
- fix: improve extraction reliability and UX by preserving duplicate URL runs as separate history rows, persisting session history across refreshes, stabilizing attachment handling, and clarifying responsive progress/result states.
- feat: initialize the Agentic GEO product extraction workflow with URL/REST API ingestion, AI provider settings, OCR/review signal processing, RAG chunk generation, and copyable GEO RAW JSON output.
- Updated dependencies:
  - @agentic-geo/pdp-extractor-agent@0.0.1
