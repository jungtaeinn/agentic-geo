# Agentic GEO Agent API

The Agent API is the FastAPI composition layer for the Python extractor, GEO generator, and evaluator. It changes a console request into a typed orchestration result; it does not treat a reachable route, a configured model, or a successful transport as proof of a product claim.

## Responsibilities and artifact effects

| Responsibility | Why it exists | What a caller receives |
| --- | --- | --- |
| Console orchestration | Keeps the retained Next.js consoles on stable server contracts while agents moved to Python. | Extraction, generation, refinement, evaluation, provider-check, and profile responses. |
| Streaming | Preserves long-running `POST /generate` work without reserializing it through the BFF. | NDJSON progress events, a 15-second heartbeat during quiet work, then a result or error. |
| Internal generation boundary | Separates internal submission and optional test execution from console flows. | Internal job contracts; `x-api-key` enforcement is enabled only when `AGENT_API_KEY` is configured. |
| Artifact assembly | Carries agent output through without inventing public content. | `schemaMarkup`, `content.sections`, and `diagnostics`; `content.html` remains empty by design. |

The console-facing routes cover extraction, direct generation, extract-and-generate, refinement, mocks, evaluation, provider validation, and RAG profile operations. They intentionally have no `x-api-key` dependency. The internal job routes check `x-api-key` only if `AGENT_API_KEY` is nonempty; with that setting absent, the compatibility guard allows the request. Production deployments should set the key for internal routes and apply appropriate access control to direct public routes. FastAPI's interactive documentation and OpenAPI endpoints are intentionally disabled; checked-in tests are the supported contract reference.

## Which agents a request runs

Both agent packages are wired in, and which of them a request runs is decided by how the product reaches the API. Reading image text as a relational layout graph is part of extraction, so a request that skips extraction skips that too.

| Entry point | Extractor | Generator | Image OCR |
| --- | --- | --- | --- |
| `POST /generate` with `sources` and `sourceType: "url"` | Yes — `extract_product` collects the page and runs its OCR stage | Yes | Yes |
| `POST /generate` with `products` (`sourceType: "manual-json"`) | No | Yes | No — the payload's own `ocr` is used as supplied |
| `POST /internal/v1/geo/generations` and `/internal/v1/geo/test-generations` | OCR only — `extract_image_ocr_evidence` fills a missing `ocr` | Yes | Yes, when the conditions below hold |

The two OCR entries share one prompt contract, so the relational layout a caller receives does not depend on which one ran: groups with `parentId`, lines carrying a `role` and an optional `pairedLabel`, and `annotates` tying a footnote to what it qualifies.

On the internal routes the enrichment step is skipped, without failing the request, unless all of the following hold. The reason is recorded in `diagnostics.ocrEnrichment`.

- `product.ocrImages` or `product.geoProduct.ocrImages` holds an array of strings. A value of another shape is reported as a contract violation and no image is read.
- The product carries no `ocr` or `sourceExtraction.ocr` yet. Existing image text is never overwritten.
- Each URL is `http` or `https`, resolves to a public address, and — when `AGENTIC_GEO_OCR_IMAGE_ALLOWED_HOSTS` is configured — belongs to a listed host.

So a product record holding only `ocrImages` produces a relational OCR graph on the internal routes, and is generated without one on the console's manual-JSON path.

## Data and quality boundaries

`diagnostics` is where a caller finds process details, evidence/provenance, warnings, RAG usage, validation outcomes, and generator quality results. It explains why an artifact was accepted, repaired, or flagged; it never upgrades RAG guidance or a warning-free response into source evidence. The API echoes the console's `x-request-id` response header so the UI can tie a saved artifact to one API execution without placing provider credentials in a result payload.

For events streamed by `POST /generate`, `metrics` is optional and locale-neutral. When supplied, it reports OCR image candidates, review items, or RAG chunks. The UI owns localized wording and retains a static fallback for older events without metrics. API heartbeats keep a stream alive but do not represent a completed agent step. `POST /extract` is not an event stream: its returned `diagnostics.process` is the final authoritative extraction snapshot.

## Run locally

Install dependencies, then configure a reachable PostgreSQL instance before starting the ASGI app. Supply `DATABASE_URL`, or the `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USERNAME`, and `DB_PASSWORD` settings through your local environment or deployment configuration. Startup runs a database readiness check; a mock provider does not remove that database prerequisite.

```bash
uv sync --all-packages
uv run --package neo-agent-api uvicorn neo_agent_api.main:app --host 127.0.0.1 --port 3000
curl --fail http://127.0.0.1:3000/health
```

In a normal Next deployment, route handlers read `AGENTIC_GEO_API_URL` as the BFF's runtime API base. It is non-secret operational configuration, but keeping it server-side preserves the BFF architecture. Never put provider credentials or access tokens in browser code, committed configuration, or request fixtures.

RAG profile state is also non-secret operational storage: extractor profiles default to `.pdp-extractor-rag` (override with `PDP_EXTRACTOR_RAG_STATE_DIR`) and generator profiles default to `.pdp-geo-generator-rag` (override with `PDP_GEO_GENERATOR_RAG_STATE_DIR`). In deployment, point both at durable writable locations.

## Direct-browser CORS for static Pages

Normal Next.js deployments use the same-origin BFF and need no browser CORS configuration. The browser calls `/api`; the BFF calls the Agent API through its runtime `AGENTIC_GEO_API_URL`.

Static Pages has no BFF. Each console's `build:pages` script selects its static target; provide `NEXT_PUBLIC_AGENTIC_GEO_API_URL` at build time so browser requests can reach the Agent API directly. This build-time base is public by design and must never carry a credential.

For that mode, set the API deployment's `AGENTIC_GEO_CORS_ALLOWED_ORIGINS` to the real, comma-separated Pages browser origins. For example:

```bash
AGENTIC_GEO_CORS_ALLOWED_ORIGINS=https://pages.example
```

Each entry must be an exact `http` or `https` origin (`scheme://host` with an optional port), with no path or trailing slash. The default is empty, so cross-origin browsers receive no approval headers. Wildcards are rejected, credentials are disabled, and preflight permits the console's `GET`, `POST`, `PUT`, `DELETE`, and `OPTIONS` methods plus `Content-Type`, `Cache-Control`, and `X-Request-ID`.

CORS is not authentication or network access control: it does not stop curl, a server, or another non-browser client from calling an otherwise reachable endpoint. Use `AGENT_API_KEY` for the conditional internal-route guard and an authentication-aware gateway or application policy where direct console API access must be restricted. Do not invent or commit a production Pages origin; set the real allowlist in deployment configuration.

## Timing model

Provider-backed model stages in the extractor and generator use a 900-second minimum timeout. A request may extend that duration but cannot reduce it below the floor. The retained Next BFF routes declare a matching 900-second budget, while each deployment still needs a host-level limit at least that large. Source acquisition is independent: the extractor's page fetch uses a short 30-second timeout, while image retrieval has its own bounded timeout. A waiting model stage and a failed/slow page fetch are therefore different diagnostics.

## Verify

```bash
uv run pytest apps/agent-api/tests -q
uv run ruff check apps/agent-api
uv run pyright apps/agent-api/src
```

Run the tests without live provider credentials. Provider validation and smoke paths are opt-in operational checks, not required unit-test setup.
