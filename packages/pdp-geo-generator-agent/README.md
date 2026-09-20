# PDP GEO Generator Agent

`pdp-geo-generator-agent` turns a grounded product record or arbitrary product JSON into reviewable GEO artifacts. It is Python-native and produces public content sections, JSON-LD, provenance, validation findings, RAG usage, and quality-gate diagnostics without requiring a Node runtime.

## How generation changes a result

| Pipeline area | Work | Output effect |
| --- | --- | --- |
| Normalize | Applies product shape, field mapping, source, locale, and market controls. | Caller-selected locale/market remains the output contract even when source-language signals are detected. |
| Evidence and planning | Builds an evidence ledger and a content plan, then retrieves and reranks relevant policy guidance. | A planned public claim must fit the appropriate product evidence and context. |
| Render | Produces `content.sections`, JSON-LD, and deterministic script-tag serialization. | Hosts render sections themselves; `content.html` is intentionally empty. |
| Validate and repair | Checks graph/public-copy structure and applies only deterministic safe repairs. | Findings remain in diagnostics; repair is not permission to invent claims or restructure arbitrarily. |
| Quality gate | Evaluates the artifact and may make one constrained corrective attempt when configured/runtime-supported. | A correction is adopted only under strict non-regression rules. |

The public entry point is `generate_pdp_geo` (with `generatePdpGeo` as a compatibility alias). Related public helpers support normalization, evidence-led planning, RAG profile/snapshot management, validation, and the REST handler.

## Evidence, schema, and quality boundaries

Product evidence supports product claims. RAG documents guide policy, structure, terminology, and retrieval—not claims about the individual product. The evidence ledger, content plan, final-public-copy provenance, RAG usage, validation warnings, and repairs are all returned in `diagnostics` for review.

The graph keeps a source-grounded `WebPage` context separate from deeper product-specific `Product` content, linked rather than copied into one vague description. FAQ is product-specific and evidence-backed. A `HowTo` is emitted only for an eligible source-supported procedure and preserves canonical source order.

When a description or buyer FAQ has enough source material to be multi-sentence, the public renderer keeps the resolved brand and product name at useful citation anchors: the opening, a composition/technology sentence, and the buyer question/answer pair. It does not inject the identity into every verbatim metric, review, or HowTo sentence. A sentence may say what the product, holding these ingredients, does: containing them and having the outcome are both recorded of the product, so stating them together asserts no relation the source does not already hold. Attributing an outcome to one ingredient is different — there the outcome is predicated of that ingredient — and it is admitted only when the source explicitly records that pair. The phrase naming which product holds the ingredient is read as the owner rather than as a claim, whether it repeats the name or points back at it, so the same sentence binds the same way in either market. A figure is the one thing no paraphrase can license: the digits inside the product's own name are part of what it is called, and every other number has to be carried by the record the sentence rests on.

A rejected FAQ row names the gate it failed rather than a shared bucket: the admission predicate is the first requirement the row did not meet, and `admissionDiagnostics.faqRejectedRows` keeps that row's question, answer, and CEP so the omission can be read back. Those fields are diagnostics only and reach no published surface.

One rejected sentence or field does not discard an otherwise valid artifact. The generator omits that unsupported public copy, records the reason in diagnostics/provenance or validation findings, and returns the remaining source-grounded schema and content. A whole run fails only for an actual pipeline or contract failure, not because one optional public sentence cannot be admitted.

Default quality-gate thresholds are GEO 90, CEP 95, and E-E-A-T 90. These are internal safeguards, not claims of ranking, external citation, conversion, or a Google score. The gate can report shortfalls and reject a worse correction; it cannot prove an external outcome or create missing evidence.

## Progress and timing

The generator emits real pipeline events for input, normalization, RAG loading/chunking/embedding/retrieval/reranking, generation, validation, repair reporting, quality-gating, and artifact assembly. Use those events and diagnostics to distinguish actual work from a transport delay.

Model-backed stages have a 900-second minimum timeout; a caller may extend but not reduce it. PDP page acquisition belongs to the extractor and uses its separate 30-second page-fetch timeout. When the generator resolves allowed remote RAG documents itself, that resolver uses its own short configurable timeout (5 seconds by default), so neither source/RAG retrieval timeout is a replacement for the model-stage limit.

## Configuration and test

Keep provider credentials, access tokens, external service locations, and profile state out of committed configuration, browser code, fixtures, and documentation. Use local/deployment secret management. Local RAG/profile tools and benchmarks may require additional runtime configuration; do not treat them as default test commands or add live values to this README.

```bash
uv run --package pdp-geo-generator-agent pytest packages/pdp-geo-generator-agent/tests -q
uv run ruff check packages/pdp-geo-generator-agent
```

The package's CLI entry points support RAG maintenance and benchmarking, while the test suite is the safe default verification path.
