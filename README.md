# Agentic GEO

> Turn evidence from a product page into reviewable, AI-ready content and structured data.

<p align="center">
  <img src="docs/images/agentic-geo-ai-ready-data-v2.svg" alt="Agentic GEO transforms product evidence into AI-ready data for ChatGPT and Gemini" width="100%" />
</p>

Agentic GEO is an evidence-first workspace for improving the clarity and structure of product detail pages (PDPs). It takes source-backed product facts, usage instructions, visible customer questions, and page context; then produces reviewable page content and JSON-LD that keep the page, product, FAQ, and HowTo roles distinct.

The goal is not to promise a ranking, citation, traffic, or revenue outcome. The goal is to make a page's identity, facts, and customer guidance easier for people and AI answer engines to interpret when the product is relevant.

## What it does

- Extracts or accepts product facts with provenance.
- Separates a page-level description from a product-level description.
- Builds visible, source-supported FAQ and HowTo content when the source qualifies.
- Produces a connected JSON-LD graph for `WebPage`, `Product`, `FAQPage`, `HowTo`, and related nodes when supported by the page.
- Provides review consoles, diagnostics, validation, and quality checks before content is published.

## The flow

1. **Product evidence** — Start with the PDP, product data, direct instructions, source-backed attributes, and visible Q&A.
2. **Agentic GEO** — Normalize the evidence, preserve its source role, and turn it into a coherent content plan.
3. **AI-ready data** — Create human-readable content and a connected structured-data graph with clear entity boundaries.
4. **Answer-engine readiness** — Give systems such as ChatGPT and Gemini a clearer, attributable representation of the page when they need to reason about it.

## From a product page to AI-ready data

The same source page contains several kinds of information, but they should not all be written into one large description. Agentic GEO assigns each fact to the role where it is useful and defensible.

### 1. Start with the source record

The following fictional example is intentionally small. In a real run, every public statement must be traceable to the product's authorized source material.

```text
Page title: Example Daily Hydration Serum
Product type: Facial serum
Source-backed audience: The page identifies dry-feeling skin as its intended concern.
Source-backed product fact: The page describes a lightweight serum texture.
Source-backed use: Apply to clean skin, then follow the page's stated routine.
Visible question: “When should I apply it?”
Visible answer: “Apply to clean skin as part of the stated routine.”
```

The agent does not treat a model's general knowledge, a review anecdote, or a related product as evidence for a claim. It keeps source facts, review context, and diagnostic information separate.

### 2. Give each schema field one job

| Field | What it describes | What goes into it | Simple example |
| --- | --- | --- | --- |
| `WebPage.description` | The **page as a resource** | The purpose and visible scope of the PDP: product context, visible guidance, FAQs, offers, or variants only when they appear on the page | “This product page presents Example Daily Hydration Serum, its stated lightweight texture, routine guidance, and visible customer questions.” |
| `Product.description` | The **product entity** | A concise, factual product narrative: what it is, the supported concern or audience, source-stated composition or technology, and supported benefits | “Example Daily Hydration Serum is a facial serum described by its source as a lightweight option for a stated hydration routine.” |
| `FAQPage.mainEntity` | **Visible customer Q&A** | Only source-supported questions and answers that are also rendered visibly on the final page | **Q:** “When should I apply it?”<br>**A:** “Apply it to clean skin as stated in the product instructions.” |
| `HowTo.step` | **Direct instructions** | Concrete source instructions with their original order and count | 1. “Apply to clean skin.”<br>2. “Continue with the stated routine.” |

The distinction matters. `WebPage.description` should say what a reader can find on the page; `Product.description` should say what the product is. Reusing one paragraph for both weakens entity clarity and can create contradictory markup.

### 3. Produce a connected graph, not disconnected snippets

The resulting JSON-LD connects the page to its main product and adds optional FAQ/HowTo nodes only when the source supports them:

```json
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": ["WebPage", "ItemPage"],
      "@id": "https://shop.example/products/example-daily-serum#page",
      "name": "Example Daily Hydration Serum",
      "description": "This product page presents Example Daily Hydration Serum, its stated routine guidance, and visible customer questions.",
      "mainEntity": { "@id": "https://shop.example/products/example-daily-serum#product" },
      "hasPart": [
        { "@id": "https://shop.example/products/example-daily-serum#faq" },
        { "@id": "https://shop.example/products/example-daily-serum#howto" }
      ]
    },
    {
      "@type": "Product",
      "@id": "https://shop.example/products/example-daily-serum#product",
      "name": "Example Daily Hydration Serum",
      "description": "Example Daily Hydration Serum is a facial serum described by its source as a lightweight option for a stated hydration routine.",
      "mainEntityOfPage": { "@id": "https://shop.example/products/example-daily-serum#page" }
    },
    {
      "@type": "FAQPage",
      "@id": "https://shop.example/products/example-daily-serum#faq",
      "isPartOf": { "@id": "https://shop.example/products/example-daily-serum#page" },
      "about": { "@id": "https://shop.example/products/example-daily-serum#product" },
      "mainEntity": [
        {
          "@type": "Question",
          "name": "When should I apply it?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Apply it to clean skin as stated in the product instructions."
          }
        }
      ]
    },
    {
      "@type": "HowTo",
      "@id": "https://shop.example/products/example-daily-serum#howto",
      "isPartOf": { "@id": "https://shop.example/products/example-daily-serum#page" },
      "about": { "@id": "https://shop.example/products/example-daily-serum#product" },
      "step": [
        { "@type": "HowToStep", "text": "Apply to clean skin." },
        { "@type": "HowToStep", "text": "Continue with the stated routine." }
      ]
    }
  ]
}
```

This is illustrative data, not a claim about a real product. In production, the graph must match the visible page and its authoritative source evidence.

### 4. Keep the boundaries honest

- A `FAQPage` is emitted only when the final page visibly contains qualifying question-and-answer pairs.
- A `HowTo` is emitted only for direct, ordered source instructions. Reviews, warnings, test conditions, and vague frequency notes are not transformed into steps.
- Product claims, ingredients, measurements, and customer suitability remain limited to the product's own evidence.
- Internal pipeline labels, prompts, credentials, and diagnostics do not belong in public page content or schema values.

## Why this can help the business

When product information is specific, attributable, and consistently represented, it can be easier to review internally and easier for an answer engine to understand when the page is relevant. That can support:

- **Discoverability** — clearer product and page identity.
- **Trust** — source-grounded language with explicit boundaries.
- **Decision support** — customer questions and direct use guidance placed in their proper roles.

These are design goals, not performance guarantees. External answer engines independently decide what to retrieve, summarize, or cite.

## Quick start

### Prerequisites

- CPython 3.14 (see [`.python-version`](.python-version))
- [uv](https://docs.astral.sh/uv/)
- pnpm 11.24.0
- A reachable PostgreSQL database for the API

Install both workspaces from the repository root:

```bash
uv sync --all-packages --group dev
pnpm install --frozen-lockfile
```

Use [`.env.example`](.env.example) and [`apps/agent-api/.env.example`](apps/agent-api/.env.example) as safe variable references. Set real values in your process environment or deployment secret manager; the templates intentionally contain no credentials.

For a local mock-provider run, set a database URL and start the API:

```bash
export DATABASE_URL='postgresql+psycopg://USER:PASSWORD@localhost:5432/agentic_geo'
export AGENTIC_GEO_PROVIDER=mock

uv run --package neo-agent-api uvicorn neo_agent_api.main:app --host 127.0.0.1 --port 3000
curl --fail http://127.0.0.1:3000/health
```

In another terminal, start a review console:

```bash
AGENTIC_GEO_API_URL=http://127.0.0.1:3000 pnpm --filter @agentic-geo/geo-generator dev --port 3001

# Or run the extractor-focused console:
AGENTIC_GEO_API_URL=http://127.0.0.1:3000 pnpm --filter @agentic-geo/pdp-extractor dev --port 3002
```

For live model-backed operation, choose a supported provider and configure only that provider's credentials in a local or managed secret store. Never put provider keys in `NEXT_PUBLIC_*` variables, tracked files, or schema data.

## Repository map

| Area | Responsibility |
| --- | --- |
| [`apps/agent-api`](apps/agent-api) | FastAPI composition layer, orchestration, validation, persistence seams, and API contracts. |
| [`apps/geo-generator`](apps/geo-generator) | Next.js review console for generation, diagnostics, and structured output. |
| [`apps/pdp-extractor`](apps/pdp-extractor) | Next.js review console focused on source extraction and refinement. |
| [`packages/pdp-extractor-agent`](packages/pdp-extractor-agent) | Source extraction, OCR, reviews, and source-grounded product data. |
| [`packages/pdp-geo-generator-agent`](packages/pdp-geo-generator-agent) | Evidence-aware content, JSON-LD, provenance, validation, and quality gates. |
| [`packages/pdp-geo-eval-agent`](packages/pdp-geo-eval-agent) | Quality evaluation and constrained diagnostics. |

## Verify

```bash
uv run --group dev pytest apps/agent-api/tests -q
uv run --group dev --package pdp-extractor-agent pytest packages/pdp-extractor-agent/tests -q
uv run --group dev --package pdp-geo-generator-agent pytest packages/pdp-geo-generator-agent/tests -q
uv run --group dev --package pdp-geo-eval-agent pytest packages/pdp-geo-eval-agent/tests -q
pnpm test
```

## Security and content policy

- Treat product sources as evidence, not as permission to add unsupported claims.
- Use only product data and source material you are authorized to process.
- Keep API keys, database passwords, tracing credentials, and signed URLs outside the repository.
- Expose only genuinely public URLs through `NEXT_PUBLIC_*` variables.

## License

This repository retains its existing [license](LICENSE).

ChatGPT and Gemini are referenced solely as examples of AI answer engines. Their names and marks belong to their respective owners; this project is not affiliated with or endorsed by them.
