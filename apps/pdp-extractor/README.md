# PDP Extractor Console

This retained Next.js app is a focused review surface for the Python PDP extractor. In a normal Next deployment it calls the Agent API through a server-side BFF; a static Pages build calls the API directly. It helps a reviewer inspect what was collected before generation, but does not publish GEO copy or turn OCR/RAG material into a verified product claim by itself.

## What it changes

| Input or action | Extractor effect | Result for review |
| --- | --- | --- |
| PDP URL or product API URL | Collects source material and extracts product signals. | GEO-ready product JSON with evidence, provenance, source type, and warnings. |
| OCR/review processing | Examines image and review candidates within the source workflow. | Candidate facts retain their context; relationships need explicit source support. |
| RAG profile/context | Retrieves guidance for extraction policy and structure. | Guidance usage is reported separately from product evidence. |
| Refinement | Applies the supported refinement contract to an existing result. | A revised result with diagnostics, not an unreviewed public artifact. |

Directly stated facts can remain source-backed. A causal ingredient-to-outcome relationship requires an explicit relationship in the source; adjacent OCR fragments or guidance are not enough.

The console accepts URLs, not a pasted raw HTML document. In the wider workflow, its result becomes the evidence/provenance input to generator content, JSON-LD, validation, and quality review; raw HTML extraction is a package-level capability rather than this console's input surface.

## Progress and diagnostics

`POST /extract` returns a final JSON process snapshot; it does not stream confirmed extractor stages. The right-side Progress view can show that work is in flight, but its interim stage display is an activity indicator, not evidence that each stage has finished. Use the returned `diagnostics.process` and metrics as the authoritative status.

Static labels are localized by the console, and optional structured metrics add locale-appropriate facts without parsing backend prose:

| Stage | Metric when present | Meaning |
| --- | --- | --- |
| OCR | `ocrImageCandidateCount` | Image candidates inspected by OCR. |
| Review | `reviewItemCount` | Review items available to the extractor. |
| RAG | `ragChunkCount` | Retrieved guidance chunks; not product evidence. |

Older returned process metadata without metrics still displays static descriptions. Diagnostics expose process state, evidence, OCR/review/RAG usage, runtime details, and warnings so a reviewer can tell an unavailable source from an unsupported claim.

This console does not run a GEO quality gate or make publish decisions. Those later safeguards belong to the generator/evaluator, and their findings do not retroactively change extractor evidence.

## Run locally

Start the Agent API on port 3000 with a ready PostgreSQL database first. For a normal Next deployment, use the BFF's non-secret runtime API base and run the console:

```bash
pnpm install --frozen-lockfile
AGENTIC_GEO_API_URL=http://127.0.0.1:3000 pnpm --filter @agentic-geo/pdp-extractor dev --port 3002
```

For static Pages, `build:pages` selects direct browser requests. Supply `NEXT_PUBLIC_AGENTIC_GEO_API_URL` at build time; it is a public API base, never a credential. Configure the API's `AGENTIC_GEO_CORS_ALLOWED_ORIGINS` with the actual Pages `scheme://host[:port]` origin only—no path or trailing slash. CORS is not authentication; see the [Agent API CORS guidance](../agent-api/README.md#direct-browser-cors-for-static-pages).

Keep credentials, tokens, and provider configuration out of browser-visible variables, tracked files, fixtures, and documentation.

## Timing

Extraction model stages use a 900-second minimum timeout and can only be extended by a caller. Page collection has a distinct short 30-second timeout; image retrieval is separately bounded. A quiet model stage can remain in progress for several minutes; its completion is represented in the final extraction snapshot rather than by the console's interim animation.

## Verify

```bash
pnpm --filter @agentic-geo/pdp-extractor test
pnpm --filter @agentic-geo/pdp-extractor typecheck
pnpm --filter @agentic-geo/pdp-extractor build
```
