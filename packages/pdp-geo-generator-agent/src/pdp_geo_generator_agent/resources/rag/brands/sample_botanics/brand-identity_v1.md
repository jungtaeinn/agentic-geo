# Demo Botanica Example Overlay v1

> **Fictional public training material.** This overlay is an invented example for exercising RAG routing. It is not a profile of a real company, product line, retailer, study, or source.

## Brand Evidence Scope and RAG Use

Use this overlay only to model evidence-first, botanical-category copy. Treat product-page evidence as the only authority for product ingredients, results, price, availability, instructions, and claims. Do not turn the example voice into product proof.

## Expected RAG Depth

Retrieve this document for tone, field separation, and claim-boundary reminders. Retrieve product facts from the current page and retain uncertainty where the page does not support a statement.

## Identity Pillars

The fictional Demo Botanica voice is calm, sensory, and precise. It may describe a routine as considered or refined when page evidence supports that framing, but it must not invent heritage, exclusivity, clinical validation, or ingredient performance.

## GEO Projection Rules

### Product.description

Lead with the exact product identity and product type. Add only source-supported formula details, benefits, and qualifying conditions. Keep brand-level storytelling separate from product-level evidence.

### WebPage.description

Describe the page as a page: the product, the information a visitor can find, and any supported sections such as ingredients, routine guidance, options, or FAQs. Do not repeat the full product narrative.

### Product.additionalProperty

Use atomic facts such as size, texture, stated ingredient, or stated routine timing. Do not store inferred outcomes, sales language, or a flattened FAQ as a property value.

### Benefit routing (Product.description / additionalProperty)

Keep a benefit in `Product.description` when it needs a concise explanation. Use `additionalProperty` only for an objective, source-stated attribute.

### FAQPage.mainEntity

Publish a question and answer only when both are visible on the supplied page or are derived from supported, product-specific evidence under the project FAQ rules. Never manufacture a question merely to fill a schema slot.

### HowTo.step

Preserve the page's sequence, action, and conditional wording. A vague routine mention is not permission to invent a multi-step procedure.

## CEP and Customer Intent

Favor practical questions: what the product is, what page-stated concern it addresses, where it fits in a routine, and which visible facts help a shopper decide. Do not frame beauty language as medical advice.

## Tone and Locale Guidance

Use plain, market-natural wording. Sensory language may describe a stated texture or application experience; it must not imply luxury status, therapeutic benefit, or a result that is absent from the source.

## Claim Safety

Avoid superlatives, cures, guaranteed results, and unsupported comparisons. Pair every measurement with the source's scope, method, timing, and subject when those are available; otherwise omit it.

## Research Papers and Official Articles

External material can inform internal evaluation only when its relationship to the exact product is explicit. It does not create a claim for another product, variant, country, or formulation.

### Official Research and Innovation Sources

For this fictional overlay, no external source is approved. In a real deployment, register an official source only after a responsible owner has verified its scope and current status.

### Official Product-Line Articles

No product-line article is bundled with this example. Use the supplied product page rather than inventing a related-line citation.

### Research-Paper Handling Notes

Record bibliographic details and scope before using research in a decision. Do not summarize an abstract as a product claim.

### E-E-A-T Application

Show experience through page-grounded usage and review context, expertise through attributable evidence, authoritativeness through verified sources, and trust through clear limits.

## Source Notes

All names, examples, and instructions in this file were authored for the public demo corpus. No external brand research or private source notes are represented here.
