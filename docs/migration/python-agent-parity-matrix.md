# Python agent migration parity matrix

This inventory distinguishes the retained Next.js consoles from the Python
agent implementations. Frozen historical fixture metadata is data, not
executable Node code. The commands below are reproducible checks, rather than
an archived test-count snapshot: the suite evolves as contract coverage grows.

| Retired Node surface | Retained replacement | Executed proof |
| --- | --- | --- |
| Nest agent server, controllers, and agent orchestration | `apps/agent-api/src/neo_agent_api/main.py` FastAPI application; locally reached through the retained Next BFFs | `PYTHONDONTWRITEBYTECODE=1 uv run --locked pytest apps/agent-api/tests -q -p no:cacheprovider`; the same tests exercise the FastAPI route contracts. |
| Extractor TypeScript runtime, exports, REST handler, and provider/RAG/OCR fixtures | `packages/pdp-extractor-agent/src/pdp_extractor_agent/`; FastAPI `/extract`, `/mock`, `/refine`, and `/rag-profile` | `PYTHONDONTWRITEBYTECODE=1 uv run --locked pytest packages/pdp-extractor-agent/tests -q -p no:cacheprovider`. |
| Generator TypeScript runtime, exports, REST handler, and RAG/provider fixtures | `packages/pdp-geo-generator-agent/src/pdp_geo_generator_agent/`; FastAPI `/generate`, `/generator`, and `/rag-profile` | `PYTHONDONTWRITEBYTECODE=1 uv run --locked pytest packages/pdp-geo-generator-agent/tests -q -p no:cacheprovider`; this includes the renamed generator RAG profile test. |
| Evaluator TypeScript root/`types`/`benchmark`/`rest` exports and provider transports | `packages/pdp-geo-eval-agent/src/pdp_geo_eval_agent/`; FastAPI `/evaluation`; `pdp-geo-eval-benchmark` | `PYTHONDONTWRITEBYTECODE=1 uv run --locked --package pdp-geo-eval-agent pytest packages/pdp-geo-eval-agent/tests -q -p no:cacheprovider`. |
| Shared JavaScript runtime semantics used by all migrated agents | `packages/neo-js-compat/src/neo_js_compat/` compatibility primitives | `PYTHONDONTWRITEBYTECODE=1 uv run --locked --package neo-js-compat pytest packages/neo-js-compat/tests -q -p no:cacheprovider`. |
| Extractor console BFF endpoints: `/api/extract`, `/api/mock`, `/api/refine`, `/api/provider/validate`, and `/api/rag-profile` | `apps/pdp-extractor` raw Python proxy/browser DTO adapters; the profile route retains its extractor selector | `pnpm --filter @agentic-geo/pdp-extractor test`; this runs route/browser/Pages tests, Next type generation, and `tsc --noEmit`. |
| GEO console BFF endpoints: `/api/extract`, `/api/generator`, `/api/generate`, `/api/evaluation`, `/api/provider/validate`, and `/api/rag-profile` | `apps/geo-generator` raw Python proxy/browser DTO adapters; `/api/generate` retains NDJSON streaming | `pnpm --filter @agentic-geo/geo-generator test`; this runs route/browser/Pages tests, Next type generation, and `tsc --noEmit`. |
| Frozen TypeScript-era contract fixtures and provenance metadata | Checked-in Python test fixtures and contract tests in the API and all agent packages; no live TypeScript oracle | `PYTHONDONTWRITEBYTECODE=1 uv run --locked pytest -q -p no:cacheprovider`; the suite includes fixture integrity and no-live-oracle audits. |
| Node package operational scripts | Python `uv run --package …` package commands; evaluator benchmark entry point is `pdp-geo-eval-benchmark`, and generator RAG/benchmark entry points are declared in its Python `pyproject.toml` | The evaluator and generator package suites cover their CLI/RAG command contracts. |
| Deleted Node-agent workspace links (`packages/*` pnpm workspaces and `@agentic-geo/*-agent` runtime links) | The uv workspace owns Agent API and Python packages; pnpm retains only `apps/geo-generator` and `apps/pdp-extractor` | `git show origin/main:pnpm-workspace.yaml` shows the retired `packages/*` member; current `pnpm-workspace.yaml` contains only `apps/*`, and the live-manifest source audit has no deleted agent workspace link. |

## Normal Next versus GitHub Pages

Normal Next deployments retain dynamic `/api/*` BFF routes. Those server-side
routes use the private `AGENTIC_GEO_API_URL` to reach FastAPI, while local
browser calls continue to use the BFF paths.

GitHub Pages is deliberately different: with
`NEXT_PUBLIC_DEPLOY_TARGET=github-pages`, both Next configurations set
`pageExtensions: ["tsx"]`. This excludes server route and manifest `.ts`
files from the Pages route graph, so the Pages output is static-only and has
**no BFF routes**. Browser requests in that mode require
`NEXT_PUBLIC_AGENTIC_GEO_API_URL` and connect directly to the external FastAPI
deployment. This is not a Pages build failure and does not change the dynamic
BFF behavior of ordinary Next deployments.

Executed deployment proofs:

- `pnpm --filter @agentic-geo/geo-generator build` and
  `pnpm --filter @agentic-geo/pdp-extractor build` both passed and their route
  tables retain dynamic `/api/*` BFF routes.
- `NEXT_PUBLIC_AGENTIC_GEO_API_URL=http://python-agent.test pnpm --filter
  @agentic-geo/geo-generator build:pages` and the corresponding extractor
  command both passed. Each Pages route table contains only `/` and
  `/_not-found`, proving the static-only graph.

## Inventory review checklist

- [x] Agent API replacement and FastAPI proof
- [x] Extractor, Generator, Evaluator, and `neo-js-compat` package proofs
- [x] Retained Extractor and GEO BFF endpoint sets
- [x] Frozen fixture/no-live-oracle proof
- [x] Python CLI operational command coverage
- [x] Deleted Node workspace-link audit
- [x] Normal dynamic BFF versus static-only Pages behavior

## Root gate

The default configured collector previously could not load both generic
`test_rag_profile.py` modules. The Generator module is now uniquely named
`test_generator_rag_profile.py`; no pytest import mode, test helper, or
configuration changed.

```bash
PYTHONDONTWRITEBYTECODE=1 uv run --locked pytest --collect-only -q -p no:cacheprovider
PYTHONDONTWRITEBYTECODE=1 uv run --locked pytest -q -p no:cacheprovider
```

The PostgreSQL integration tests require a working Docker-compatible runtime.
On a Colima host that cannot mount its Docker socket into the Testcontainers
Ryuk sidecar, retain coverage by using the documented Testcontainers switch:

```bash
TESTCONTAINERS_RYUK_DISABLED=true PYTHONDONTWRITEBYTECODE=1 \
  uv run --locked pytest -q -p no:cacheprovider
```
