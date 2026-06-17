# @agentic-geo/pdp-extractor-agent

## 0.1.0

### Minor Changes

- feat: provide a reusable PDP extraction sub agent for URL, REST API, and collected HTML inputs.
- feat: normalize product facts, images, options, FAQ candidates, review signals, OCR keyword evidence, and GEO RAG chunks into GEO RAW JSON.
- feat: expose standalone function APIs, a Web API REST handler, progress diagnostics, evidence/warning logs, provider adapters, and result refinement helpers.
- docs: refresh README and package metadata for downstream orchestration by service-specific GEO apps.

## 0.0.1

### Patch Changes

- chore: prepare the 0.0.1 release with README documentation, package metadata, author information, manifest icons, profile branding, and workspace setup guidance.
- fix: improve extraction reliability and UX by preserving duplicate URL runs as separate history rows, persisting session history across refreshes, stabilizing attachment handling, and clarifying responsive progress/result states.
- feat: initialize the Agentic GEO product extraction workflow with URL/REST API ingestion, AI provider settings, OCR/review signal processing, RAG chunk generation, and copyable GEO RAW JSON output.
