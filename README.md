# Agentic GEO

> Turn product-page evidence into citation-ready, AI-ready content and structured data.

<p align="center">
  <img src="docs/images/agentic-geo-citation-opportunity-workflow-v4.png" alt="Agentic GEO turns authorized product PDP evidence into citation-ready AI data, source-supported schema and content, and citation opportunities for ChatGPT and Gemini" width="100%" />
</p>

Agentic GEO converts authorized PDP evidence into reviewable, AI-ready content and connected JSON-LD. It is designed to make a relevant product page easier for AI answer engines—including ChatGPT and Gemini—to understand, retrieve, summarize, and cite when those systems independently select it. It keeps the page, product, FAQ, HowTo, and atomic product facts in distinct, source-backed roles.

This is **citation readiness**, not a citation guarantee. Agentic GEO does not submit pages to those services or control ranking, retrieval, answer selection, citation, traffic, or revenue. Results depend on crawlability, relevance, source selection, model behavior, and platform policies; its job is to make the best available PDP evidence clear, attributable, internally consistent, and easy to verify if an engine evaluates that page.

## What it does

- Extracts or accepts product facts with provenance.
- Builds a citation-ready buyer-answer arc: **product introduction → target customer and CEP → key ingredient or technology → supported benefit/effect → qualified proof such as a source-stated metric or citation → attributed positive or neutral customer-review context**.
- Separates a compact page-level description from a detailed product-level description, while preserving concise atomic anchors in `Product.additionalProperty`.
- Builds visible, source-supported FAQ and HowTo content when the source qualifies.
- Produces a connected JSON-LD graph for `WebPage`, `Product`, `FAQPage`, `HowTo`, `PropertyValue`, and related nodes when supported by the page.
- Provides review consoles, diagnostics, validation, and quality checks before content is published.

## The flow

1. **Product evidence** — Start with the PDP, product data, direct instructions, source-backed attributes, visible Q&A, qualified metrics, and attributable review context.
2. **Agentic GEO** — Normalize and route each fact through GEO, CEP, and E-E-A-T-informed claim-safety rules.
3. **Citation-ready content** — Form a coherent buyer-answer narrative and independent answer units an LLM can evaluate without guessing at missing evidence.
4. **AI-ready data** — Publish aligned human-readable content and a connected structured-data graph with clear entity boundaries.
5. **LLM citation readiness** — Give systems such as ChatGPT and Gemini a clearer, attributable representation to select, quote, or cite when the PDP is relevant.

## Citation-ready content architecture

The same source page contains several kinds of information, but they should not all be written into one large description or scattered as isolated keywords. Agentic GEO turns only supported evidence into an answer path:

```text
Product introduction
  → target customer / Category Entry Point (CEP)
  → key ingredients or technology
  → supported benefit or effect
  → qualified metric, research, or source record
  → attributed customer-review context
```

Each stage answers the buyer's next natural question: *What is this? Is it for me? What is in it? What does it do? Why should I believe it? What do customers with similar needs report?* Missing evidence is omitted, never filled with generic category knowledge.

| Framework | How Agentic GEO uses it |
| --- | --- |
| **GEO — Generative Engine Optimization** | Shapes answer-ready entity clarity and visible-content alignment so generative engines can evaluate the PDP as a useful answer source. |
| **CEP — Category Entry Point** | Maps an evidence-backed customer situation, need, constraint, or preference to natural buyer language. CEP helps connect a product to a relevant question; it never creates a product claim. |
| **E-E-A-T-informed trust lens** | Applies an evidence hierarchy, entity consistency, qualified metrics, and trust-first claim safety. Review experience stays attributed rather than becoming a universal effect. |

GEO, CEP, and E-E-A-T are internal generation and quality frameworks. They guide the work, but those labels never appear in customer-facing PDP copy or schema values.

### 1. Start with the source record

The following fictional example is intentionally small. In a real run, every public statement must be traceable to authorized product material, visible PDP content, or clearly attributed customer-review evidence.

```text
Page title: Example Daily Hydration Serum
Product introduction: A lightweight facial serum.
Target customer / CEP: The page identifies dry-feeling skin as the supported concern.
Key ingredient or technology: The page names a moisture-binding complex.
Supported benefit/effect: The page states hydration support for that concern.
Qualified metric: The source records the method, period, and result of a four-week assessment.
Customer-review context: Multiple visible reviews describe a lightweight feel.
Source-backed use: Apply to clean skin, then follow the page's stated routine.
Visible question: “When should I apply it?”
Visible answer: “Apply to clean skin as part of the stated routine.”
```

The agent does not treat a model's general knowledge, a single review anecdote, a related product, or a loose category association as evidence for a claim. It keeps source facts, review context, metrics, and diagnostics separate; review language can express customer experience, but cannot be upgraded into a guaranteed product effect.

### 2. Give each schema field one job

| Field | What it describes | What goes into it | Simple example |
| --- | --- | --- | --- |
| `WebPage.description` | The **page as a resource** | A compact, page-level representation of the same supported decision context: page identity, product/brand scope, customer context, and visible decision content. It does not duplicate raw metrics or individual steps. | “This product page presents Example Daily Hydration Serum for its stated dry-feeling-skin concern, source-backed formula and hydration information, and visible customer decision guidance.” |
| `Product.description` | The **product entity** | The detailed buyer-answer narrative—not a short summary: product introduction → target customer/CEP → ingredient or technology → supported effect → qualified proof → attributed review context. | “Example Daily Hydration Serum is a lightweight facial serum for a source-stated dry-feeling-skin concern. Its moisture-binding complex and hydration support are described by the source; a four-week assessment supplies qualified evidence, while visible customer feedback describes a lightweight feel.” |
| `Product.additionalProperty` | **Atomic product anchors** | Concise keyword or short-list `PropertyValue` records such as **Target customer**, **Key ingredients**, **Key benefit**, and **Key efficacy**. They support entity clarity without duplicating prose, usage, metrics, or review passages. | **Target customer:** “Dry-feeling skin”<br>**Key ingredients:** “Moisture-binding complex”<br>**Key efficacy:** “Four-week source-reported assessment” |
| `FAQPage.mainEntity` | **Visible customer Q&A** | Source-supported, CEP-led questions that name the product and answer a real buying or usage decision. The first answer sentence is direct enough to stand alone if quoted; a recommendation appears only when the source supports suitability. | **Q:** “Is Example Daily Hydration Serum a suitable lightweight serum for dry-feeling skin?”<br>**A:** “Example Daily Hydration Serum is a suitable lightweight facial serum for customers seeking hydration support for dry-feeling skin when that concern is identified by its product source.” |
| `HowTo.step` | **Direct instructions** | Concrete source instructions with their original order and count | 1. “Apply to clean skin.”<br>2. “Continue with the stated routine.” |

The six-part arc spans the generated content and schema graph; it is not copied wholesale into every field. `WebPage.description` stays compact and page-scoped; `Product.description` carries the detailed reasoning arc; `additionalProperty` retains concise atomic anchors; FAQ answers resolve source-supported customer questions; and HowTo preserves direct actions. This separation gives people and LLMs a clearer, less contradictory basis for a citation decision.

### 3. See the Product.description and FAQ arc in action

The fictional source record above can become a detailed, AI-ready product explanation without adding facts that were not supplied:

**Product.description**

> Example Daily Hydration Serum is a lightweight facial serum. For customers navigating dry-feeling skin—the source-backed CEP—the serum's moisture-binding complex is described as supporting hydration. A source-reported four-week assessment provides qualified evidence within its stated method, period, and result; where positive or neutral reviews support it, customers describe a lightweight feel. Individual results may vary.

| Buyer-answer stage | What the example does |
| --- | --- |
| **Product introduction** | Names the exact product and product type. |
| **Target customer / CEP** | Connects the source-backed dry-feeling-skin concern to the customer situation. |
| **Key ingredient or technology** | Names the moisture-binding complex without inventing a mechanism. |
| **Benefit/effect** | States hydration support only within the source-backed concern. |
| **Qualified proof** | Keeps the four-week assessment tied to its stated conditions instead of presenting an unqualified number. |
| **Customer-review context** | Attributes the lightweight-feel signal to eligible positive or neutral customer reviews, not to every user. |

**CEP-led FAQPage question**

> **Q:** Is Example Daily Hydration Serum a suitable lightweight serum for customers seeking hydration support for dry-feeling skin?

**Citation-ready FAQPage answer**

> **A:** Example Daily Hydration Serum is a suitable lightweight facial serum for customers seeking hydration support for dry-feeling skin when that concern is explicitly identified by its product source. The source names a moisture-binding complex and reports a four-week assessment under its stated conditions; eligible visible customer reviews describe a lightweight feel. Individual results may vary.

The question names the product and the CEP rather than asking a generic category question. The answer begins with a bounded recommendation, then connects its E-E-A-T-informed support in order: source-backed product identity and suitability, named ingredient/technology, qualified proof, and attributed customer experience. Agentic GEO emits this type of recommendation only when the source actually supports the target customer or suitability claim; otherwise it answers with the strongest supported product fact or omits the FAQ.

### 4. Produce a connected graph, not disconnected snippets

The resulting JSON-LD connects the page to its main product, preserves publishable atomic evidence as `PropertyValue` records, and adds optional FAQ/HowTo nodes only when the source supports them:

```json
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": ["WebPage", "ItemPage"],
      "@id": "https://shop.example/products/example-daily-serum#page",
      "name": "Example Daily Hydration Serum",
      "description": "This product page presents Example Daily Hydration Serum for its stated dry-feeling-skin concern, source-backed formula and hydration information, and visible customer decision guidance.",
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
      "description": "Example Daily Hydration Serum is a lightweight facial serum. For customers navigating a source-stated dry-feeling-skin concern, its moisture-binding complex is described as supporting hydration. A source-reported four-week assessment provides qualified evidence within its stated conditions, while eligible visible customer reviews describe a lightweight feel. Individual results may vary.",
      "additionalProperty": [
        {
          "@type": "PropertyValue",
          "name": "Target customer",
          "value": "Dry-feeling skin"
        },
        {
          "@type": "PropertyValue",
          "name": "Key ingredients",
          "value": "Moisture-binding complex"
        },
        {
          "@type": "PropertyValue",
          "name": "Key benefit",
          "value": "Hydration support"
        },
        {
          "@type": "PropertyValue",
          "name": "Key efficacy",
          "value": "Four-week source-reported assessment"
        }
      ],
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
          "name": "Is Example Daily Hydration Serum a suitable lightweight serum for customers seeking hydration support for dry-feeling skin?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Example Daily Hydration Serum is a suitable lightweight facial serum for customers seeking hydration support for dry-feeling skin when that concern is explicitly identified by its product source. The source names a moisture-binding complex and reports a four-week assessment under its stated conditions; eligible visible customer reviews describe a lightweight feel. Individual results may vary."
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

### 5. Build citation readiness without manufacturing claims

LLM citation is most defensible when an answer engine can resolve the entity, find a complete answer unit, and trace the supporting claim. Agentic GEO supports those checks without treating structured data as a citation trigger:

| An LLM needs to evaluate | Agentic GEO provides |
| --- | --- |
| **What page and product is this?** | A connected `WebPage` ↔ `Product` graph with distinct page and product descriptions. |
| **Who is it for and why is it relevant?** | CEP-led target-customer and concern language, but only when the source supports it. |
| **What makes the claim credible?** | E-E-A-T-informed evidence routing: named ingredients/technology, qualified proof, scope-preserving claims, and attributed review context. |
| **Can a customer question be answered directly?** | Visible, source-backed FAQ answers whose opening sentence can stand on its own. |
| **Can a procedure be quoted accurately?** | Ordered HowTo steps that preserve direct source actions without mixing in benefits or reviews. |

### 6. Keep the boundaries honest

- A `FAQPage` is emitted only when the final page visibly contains qualifying question-and-answer pairs.
- A `HowTo` is emitted only for direct, ordered source instructions. Reviews, warnings, test conditions, and vague frequency notes are not transformed into steps.
- Product claims, ingredients, measurements, and customer suitability remain limited to the product's own evidence. A metric keeps its stated method, period, population, and caveat; a review stays attributed to customer experience.
- Internal pipeline labels, prompts, credentials, and diagnostics do not belong in public page content or schema values.

## Why citation readiness can help the business

When product information is specific, attributable, and consistently represented, it is easier for internal reviewers and answer engines to determine whether the page can support a customer answer. That can support:

- **Citation opportunity** — clearer entity identity and self-contained, source-backed answer units for systems such as ChatGPT and Gemini to evaluate.
- **Trust** — E-E-A-T-informed claim boundaries, qualified metrics, and representative review attribution.
- **Decision support** — CEP-led customer context, direct FAQ answers, and accurate HowTo guidance in their proper roles.

These are design goals, not performance guarantees. External answer engines independently decide what to retrieve, summarize, quote, or cite.

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
