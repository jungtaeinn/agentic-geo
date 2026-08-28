# @agentic-geo/pdp-geo-eval-agent

## 0.1.0

### Minor Changes

- feat: initial release of the standalone PDP GEO evaluation agent. Zero package dependencies by design — inputs are structural contracts (`src/types.ts`), so apps wire extractor -> generator -> evaluator, and any schema.org PDP markup (generator output, hand-written JSON-LD, competitor pages) can be scored.
- feat: deterministic GEO/CEP/E-E-A-T quality rubric (`evaluateGeoQuality`), extracted from the console and research-recalibrated: validation warnings/repairs now penalize GEO (schema hygiene) only instead of being triple-counted across dimensions; all three dimensions can reach 100 (E-E-A-T moved from a base-60 additive scale to the same base-90 subtractive scale); GEO rewards the two deterministically checkable on-page citation gatekeepers confirmed by What Gets Cited (SIGIR 2026) — explicit offer price and a freshness timestamp; CEP cue regexes are cross-checked against the evidence-bound content plan with softened weights (single missed detection can no longer swing the score by 24 points); criteria copy now states each dimension's evidence grade honestly (E-E-A-T is an evidence-hygiene proxy, not Google's rating; CEP is a qualitative marketing framework).
- feat: claim-distortion lints derived from live defects — duplicated units ("100%%"), stuttered verbs ("supports supports"), and implausible change magnitudes ("decreased by 100%") are flagged as metric-integrity issues with marketing-friendly guidance.
- feat: citation-visibility tier migrated from the generator package — AutoGEO-ported wordpos/word/pos share metrics, simulated-engine harness, GEU utility judges (KPR/KPC with the omission-tolerant PDP-copy gate), the inline citation probe with per-section attribution, and the injectable benchmark runner (`runGeoBenchmark({ artifacts })`) whose PDP artifacts are supplied by the app wiring script.
- feat: LLM improvement prompts (`formatQualityLlmPrompt`, `formatProbeLlmPrompt`) and evaluation-suite presentation helpers (bilingual copy, easy-summary builder, probe narrative/safety helpers) for UIs.
- feat: `createPdpGeoEvalRestHandler` (`./rest`) — standalone quality-evaluation endpoint accepting `{ jsonLd, diagnostics?, contentSections?, language? }` and returning the evaluation, a text report, and an optional LLM improvement prompt.
