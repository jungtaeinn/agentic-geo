# PDP Extractor Agent

`pdp-extractor-agent` is the Python source-to-product-intelligence agent. It accepts a product URL, API payload, HTML, or extraction input and returns a GEO-ready product record with evidence, provenance, warnings, OCR/review context, RAG usage, and process diagnostics. It replaces the previous runtime dependency with Python-native behavior rather than invoking Node.

## How extraction changes a result

| Stage | Work | Output effect |
| --- | --- | --- |
| Input and fetch | Validates the requested source and collects page, metadata, JSON-LD, or API material. | Retrieval failures stay visible as warnings instead of becoming missing facts. |
| Extract | Normalizes product name, description, options, FAQ candidates, and source signals. | Produces the product facts available for later planning. |
| OCR | Inspects qualified image/detail candidates and retains image-text provenance. | Direct statements can be evidence; adjacent fragments do not establish a causal relationship. |
| Review | Collects product-review signals. | Review language remains a signal with its own source role. |
| RAG | Builds/retrieves guidance chunks for extraction. | Guidance is recorded in diagnostics, never substituted for product evidence. |
| JSON | Emits the stable result envelope. | Consumers receive `geoProduct`, source information, diagnostics, and process steps. |

Use `extract_product`, `extract_product_from_html`, or `extract_product_from_api_payload` for the primary paths. `refine_geo_product_result` and the REST handler preserve the migration-facing contract. The package exposes snake_case APIs plus intentional camelCase compatibility aliases.

## Evidence rule

A source can support a directly stated ingredient, benefit, usage, safety, or qualified measurement. It cannot support a causal ingredient-to-outcome claim merely because OCR or nearby text contains both terms. That relationship must be explicit in the source. This distinction protects the downstream evidence ledger and quality gates from polished but ungrounded copy.

When OCR or a source exposes one contiguous numbered usage procedure, extraction keeps its original count, order, text, and image/source lineage. The generator can therefore render each source step as a separate `HowTo` step; unrelated numbered packaging, safety, or measurement copy is not promoted into a customer routine.

## Progress and diagnostics

Every real completed stage can emit a process event through the progress callback. The optional `metrics` object is structured and locale-neutral so callers can format it naturally without parsing backend prose:

| Completed stage | Metric | Meaning |
| --- | --- | --- |
| OCR | `ocrImageCandidateCount` | Image candidates inspected by OCR, not a verified-claim count. |
| Review | `reviewItemCount` | Review items available to the extractor. |
| RAG | `ragChunkCount` | Guidance chunks retrieved for extraction, not product facts. |

Older consumers can ignore `metrics`; older events without them remain valid. Diagnostics include the full process snapshot, evidence, OCR/review/RAG usage, warnings, and runtime information.

This package does not score the final GEO quality gate. The generator and evaluator consume its evidence/diagnostics later; neither a completed extraction stage nor a populated metric is proof that a downstream public claim is admissible.

## Configuration and timing

Keep provider settings, credentials, and service locations in deployment or local secret management only. Do not place them in source files, fixtures, READMEs, or browser-visible configuration.

Model-backed stages use a 900-second minimum request timeout. A supplied timeout can extend that limit but cannot make it shorter. It is separate from acquisition: a page fetch has a 30-second timeout, and image retrieval is independently bounded. A model taking several minutes is therefore not the same condition as a source fetch timing out.

## Test

From the repository root:

```bash
uv run --package pdp-extractor-agent pytest packages/pdp-extractor-agent/tests -q
uv run ruff check packages/pdp-extractor-agent
```

The test suite uses deterministic transports and fixtures; it does not require a live provider.
