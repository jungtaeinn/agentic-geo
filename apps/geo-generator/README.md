# GEO Generator Console

This retained Next.js app is the reviewer-facing console for the Python workflow. In a normal Next deployment it calls the Agent API through its server-side BFF; a static Pages build calls the API directly. It renders returned artifacts and diagnostics, but does not generate facts in the browser or make an unsupported product statement valid.

## Quick start

Three steps. The console renders what the Agent API returns; it generates nothing on its own.

```bash
# 1. Agent API (needs a ready PostgreSQL), port 3000
uv run --package neo-agent-api uvicorn neo_agent_api.main:app --host 127.0.0.1 --port 3000
curl --fail http://127.0.0.1:3000/health

# 2. Console, port 3001
pnpm install --frozen-lockfile
AGENTIC_GEO_API_URL=http://127.0.0.1:3000 pnpm --filter @agentic-geo/geo-generator dev --port 3001

# 3. Open http://127.0.0.1:3001
```

Then choose one input and submit:

| Input | What runs | Use it when |
| --- | --- | --- |
| PDP URL or product API URL | Extraction, then generation. Images are read by OCR as part of extraction. | You want the page itself to be the source of record. |
| Product JSON | Generation only. Whatever OCR the payload already carries is used as-is; image URLs alone are not fetched here. | You already hold a normalized product record and want to see what it publishes. |

Pick the locale and market before submitting: they follow the source site, so a Korean PDP is generated as `ko-KR` and a US site as `en-US`. Results appear as content sections, JSON-LD, and a Diagnostics panel — read Diagnostics to see why a sentence was published or omitted. A real model run takes minutes; progress events stream while it works.

## What the console changes

| User choice or surface | Backend effect | Reviewer outcome |
| --- | --- | --- |
| PDP URL or product API URL | Requests extraction before generation. | A source-bounded product record, evidence, OCR/review context, warnings, and extraction diagnostics. |
| Supplied product JSON | Requests generation from the caller's structured product data. | Normalized content sections and JSON-LD for the chosen locale/market. |
| Locale and market selection | Is retained as caller intent through normalization. | The schema/content contract is not silently switched to the source language. |
| Artifact and diagnostics panels | Render returned content, structured data, provenance, validation, and quality signals. | A reviewer can inspect why a claim is present or flagged before publishing it. |

The two paths stay distinct: source input follows `URL/API → extractor → evidence/provenance → generator`; manual product JSON skips extraction and follows `product JSON → normalization/input provenance → generator`. Both then produce an evidence ledger and content plan, `content.sections`, `schemaMarkup.jsonLd`, deterministic `schemaMarkup.scriptTag`, and validation/quality diagnostics. `content.html` is intentionally empty, so the host UI must render the sections itself. Manual JSON is not independently source-verified; reviewers remain responsible for its truthfulness.

## Progress and diagnostics

For `POST /generate`, the console consumes NDJSON events from the Agent API, including a 15-second heartbeat during quiet work. Direct `/extract` returns only a final JSON snapshot. While direct extraction is running, the console's extractor display is an activity indicator rather than proof that every displayed stage has completed. Treat returned `diagnostics.process` and its metrics as the authoritative record.

Every submitted run carries a unique `x-request-id`. The console records it in the saved Diagnostics only if the Agent API echoes the identical ID, so repeating the same URL still creates a separately traceable execution. To verify a real non-mock run, inspect that ID together with extractor OCR `provider`/`inputsSent`/target states and generator runtime usage (including provider, deployment, `called`, returned token usage when available, and warnings). `called: true` means an attempt; a provider-reported token count is stronger evidence of a returned model response.

Extractor labels are localized static descriptions; optional structured metrics add factual detail in the active UI locale:

| Stage | Structured metric | Interpretation |
| --- | --- | --- |
| OCR | `ocrImageCandidateCount` | Number of image candidates inspected by OCR, not verified claims. |
| Review | `reviewItemCount` | Number of review items available to extraction. |
| RAG | `ragChunkCount` | Number of retrieved guidance chunks, not product-fact evidence. |

Older backend events without `metrics` remain readable through the static description. The console deliberately does not translate or parse arbitrary backend prose to fabricate a count. Generator diagnostics include the evidence ledger, content plan, RAG usage, final-copy provenance, warnings, validation findings, and quality-gate result.

GEO, E-E-A-T, and CEP panels are audit aids: they encourage entity clarity, attribution, source-appropriate claims, and contextual answers. They do not predict rankings, external citations, conversion, or a Google score. RAG guidance informs structure and policy; only product evidence can support a product fact.

## Run locally

Start the Agent API on port 3000 with a ready PostgreSQL database first. For a normal Next deployment, provide the BFF's non-secret runtime API base and run this console:

```bash
pnpm install --frozen-lockfile
AGENTIC_GEO_API_URL=http://127.0.0.1:3000 pnpm --filter @agentic-geo/geo-generator dev --port 3001
```

For static Pages, `build:pages` selects the direct-browser target. Supply `NEXT_PUBLIC_AGENTIC_GEO_API_URL` at build time; it is a public API base, never a credential. The Agent API must allow the actual Pages origin through `AGENTIC_GEO_CORS_ALLOWED_ORIGINS` as an exact `scheme://host[:port]` without a path or trailing slash. CORS is a browser policy, not authentication; see the [Agent API CORS guidance](../agent-api/README.md#direct-browser-cors-for-static-pages).

Never place provider credentials or tokens in browser-visible settings, tracked configuration, or fixtures.

## Timing

Progress may pause during real model work. Extractor and generator model stages have a 900-second minimum timeout; callers may extend but not reduce it. The Next BFF routes declare the same 900-second execution budget; configure the hosting platform to allow it as well. This is independent of source collection, where the extractor page fetch uses a 30-second timeout and image retrieval is separately bounded. A `/generate` heartbeat is liveness, not a stage completion; a direct `/extract` result is reported only after its final snapshot is available.

## Verify

```bash
pnpm --filter @agentic-geo/geo-generator test
pnpm --filter @agentic-geo/geo-generator typecheck
pnpm --filter @agentic-geo/geo-generator build
```
