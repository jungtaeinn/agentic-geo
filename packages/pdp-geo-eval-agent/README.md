# PDP GEO Eval Agent

`pdp-geo-eval-agent` evaluates an existing GEO artifact. It scores structural GEO, CEP, and E-E-A-T signals, interprets diagnostics, supports utility gates, and can run a bounded paired citation probe. It does not generate or publish product content, and its scores do not make an unsupported claim grounded.

## How evaluation changes a result

| Capability | Input | Result for a reviewer or caller |
| --- | --- | --- |
| `evaluate_geo_quality` | JSON-LD plus optional normalized-product, evidence, RAG, plan, and validation diagnostics. | Dimension scores, explanations, and improvements based on structural/artifact signals. |
| `evaluate_utility_gate` | Citation/coverage judgments and thresholds. | A deterministic pass/fail-style utility decision and named shortcomings. |
| REST/ASGI adapter | A JSON-LD request with optional diagnostics and content sections. | Serialized evaluation/report and, when sections are supplied, an improvement prompt. |
| `run_citation_probe` | Generated and vanilla text under identical queries, distractors, and engine settings. | A paired diagnostic with deltas, attribution, and warnings. |

The evaluator deliberately accepts structural input instead of importing generator-only types, so sparse callers can be evaluated without silently coercing their artifacts. The evaluation report is feedback for the generator or reviewer; it does not edit the artifact.

## Evidence and quality limits

GEO evaluates entity/structured-artifact clarity. E-E-A-T evaluates attribution, source roles, caveats, and traceability. CEP evaluates contextual customer-answer framing. None is a search-engine score, certification, ranking promise, or citation guarantee.

The citation probe is a paired one-shot diagnostic for one product: generated and vanilla PDP text compete against the same questions and distractors. It is explicitly not a production citation-probability estimate and is not comparable across products or runs. Individual query failures become warnings; total probe failure is an error. Keep its result together with its input and engine context rather than turning it into a universal benchmark claim.

## Progress and diagnostics

The evaluator does not emit the extractor/generator pipeline progress stream. Its observable diagnostics are the evaluation dimensions, scores, explanations, improvement directions, utility-gate result, and—when invoked—the citation-probe query outcomes, attribution, deltas, and warnings. Callers should render those results as evaluation evidence, not as a completed-content or publish signal.

## Timing and configuration

Local structural evaluation does not fetch PDP pages or call a model. When the optional citation probe calls its configured model-backed engine, each provider request has the shared 900-second minimum timeout; `timeoutMs` may extend that limit but cannot shorten it. The probe retains its own retry behavior, so its end-to-end duration can exceed one provider request. Page-fetch timeouts belong to the upstream extractor (30 seconds for PDP page fetch) and are not controlled by this package.

Never document or commit provider credentials, service locations, access tokens, or engine configuration values. If a benchmark or probe needs a provider, supply its private settings through local/deployment secret management; do not use live-provider calls as a prerequisite for unit tests.

## Test

```bash
uv run --package pdp-geo-eval-agent pytest packages/pdp-geo-eval-agent/tests -q
uv run ruff check packages/pdp-geo-eval-agent
```

`pdp-geo-eval-benchmark` is an opt-in operational command, not the routine verification path.
