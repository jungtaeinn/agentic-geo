# E-E-A-T Guidance v1

## 1. Purpose

Use E-E-A-T as a trust-first quality lens for generated PDP schema and HTML content. The goal is not to publicly mention E-E-A-T, but to make every generated claim easier for people and generative engines to verify from the product source, customer-review evidence, and supported structured data.

## 2. Source Scope

### 2.1 Official Search Guidance

- Sources checked on 2026-06-24:
  - Google Search Central: https://developers.google.com/search/docs/fundamentals/creating-helpful-content
  - Google Search Central generative AI guidance: https://developers.google.com/search/docs/fundamentals/ai-optimization-guide
  - Google Product structured data: https://developers.google.com/search/docs/appearance/structured-data/product
- Google frames helpful content around people-first usefulness, clear sourcing, original value, and E-E-A-T signals. Trust is the primary lens; experience, expertise, and authoritativeness support trust.
- E-E-A-T is used here as a content quality and risk-control framework. It must not be treated as a direct ranking switch or as permission to fabricate credentials, reviews, citations, awards, clinical claims, or expert endorsements.

### 2.2 PDP GEO Interpretation

- PDP GEO should convert source-backed product facts into answer-ready content that can be retrieved, summarized, and cited by generative engines.
- The generated copy should show why the product is relevant, what evidence supports each claim, and which customer situations it serves.
- Schema markup and visible PDP sections must stay aligned. Do not mark up hidden or unsupported content only because it looks useful for search.

## 3. Evidence Hierarchy

### 3.1 Product-Fact Priority

1. Use brand-owned product facts, official PDP fields, structured product feeds, package/OCR text, and source product JSON as the strongest product evidence.
2. Use structured data fields and source IDs to preserve entity consistency, variant identity, offer data, size, ingredient, review, and usage evidence.
3. Use visible PDP sections, OCR sentences, image text, and long-scroll content as supporting evidence when the content is readable and semantically complete.
4. Use customer reviews and repeated review keywords as experience evidence, not as universal proof of product effects.
5. Use RAG policy documents as generation guidance only. They do not create product facts.

### 3.2 Conflict Handling

- When sources disagree, prefer the most product-specific and recently supplied source.
- If a benefit appears only in review language, phrase it as customer-reported experience instead of an objective product effect.
- If a metric, award, dermatologist test, clinical result, or certification has weak support, omit it from public schema/content and report the omission in diagnostics.
- If a keyword replacement would make the claim stronger than the source, keep the original safer wording.

## 4. Experience

### 4.1 Customer-Use Evidence

- Preserve concrete customer-use context when present: routine step, timing, texture, fragrance/scent impression, absorption, finish, comfort, skin/hair type, repeat purchase intent, gifting, and comparison language.
- Rewrite review language into representative summaries. Do not invent first-person reviews, named customers, star ratings, or review counts.
- Use positive or neutral reviews to shape PDP benefit phrasing, review summaries, review-derived recommendation context, and reusable review-intent FAQ when repeated review keywords support the intent; exclude negative review complaints, ratings, and raw reviewer snippets.

### 4.2 PDP Field Mapping

- `FAQPage.mainEntity`: prioritize questions that connect product facts with real customer concerns, such as benefits, ingredients, usage, suitability, comparisons, and supported metrics.
- `HowTo.step`: preserve actual routine order, amount, timing, and warnings when the source provides them.
- `Product.positiveNotes`: use review-backed positive points only when they do not imply unsupported guaranteed outcomes.
- `WebPage.description`: mention review coverage and decision context at page level without claiming all users get the same result.

## 5. Expertise

### 5.1 Ingredient and Technology Specificity

- State ingredient names, technology names, INCI names, functional categories, usage directions, and compatibility details when source-backed.
- Explain ingredient roles in product-specific language, such as "niacinamide for tone-care messaging" or "ceramide-focused barrier-care positioning", only when supported.
- Avoid medical, disease-treatment, permanent, guaranteed, or regulatory claims unless the source explicitly supports them and the market allows them.

### 5.2 Metrics and Tests

- Use clinical, survey, safety, efficacy, award, patent, or certification claims only when the source includes the metric, scope, test condition, date, or certifying body.
- If a metric lacks context, downgrade it to a diagnostic note or a softer public phrase.
- Do not transfer benchmark claims from another product, brand, or category.

## 6. Authoritativeness

### 6.1 Entity Consistency

- Keep brand, product name, product line, variant, category, size, SKU, offer, breadcrumb, and canonical URL consistent across `WebPage`, `Product`, `BreadcrumbList`, `FAQPage`, and `HowTo`.
- Prefer schema.org-compatible structure and Google Product structured data eligibility rules when choosing public markup.
- Use `sameAs`, brand, manufacturer, image, offer, aggregateRating, review, and merchant policy fields only when reliable source data exists.

### 6.2 Brand and Category Authority

- Brand identity can support tone, mood, vocabulary, and positioning, but it cannot create product claims.
- If brand identity says "heritage", "science", "luxury", or "clean", use it as brand-image context only when the target product source supports the same category or positioning. Do not turn brand-only patents, official papers, research counts, or heritage stories into product-level efficacy, ingredient, technology, certification, or clinical claims.
- Use authoritative phrasing by being precise and well-sourced, not by sounding exaggerated.

## 7. Trust

### 7.1 Trust-First Claim Safety

- Trust is the primary E-E-A-T lens for this agent. Every public claim should be traceable to product data, review evidence, visible PDP content, or approved policy guidance.
- Avoid unsupported superlatives such as "best", "number one", "clinically proven", "dermatologist guaranteed", "instant cure", "permanent", "safe for everyone", or "works for all skin types".
- Price, availability, ratings, review counts, return policies, and shipping details are trust-sensitive. Generate them only from reliable source fields.

### 7.2 Diagnostics

- Diagnostics should separate source-backed facts, review-backed signals, inferred CEP/customer context, omitted weak claims, and conflicts.
- Diagnostics should retain inferred direct/indirect query candidates with query kind, question, core keywords, answer basis, and product/brand mention status. Direct queries mention the product or brand; indirect queries do not.
- Public schema/content must not expose internal labels such as E-E-A-T, RAG, GEO, citation optimization, evidence signal, or review signal.

## 8. GEO Application

### 8.1 Answer-Ready Structure

- Use entity-rich sentences that include product name, brand, category, target customer, key benefit, ingredient/technology, usage context, and review-backed preference when supported.
- Keep sentences concise enough to be summarized by generative engines but complete enough to stand alone.
- Align generated HTML sections with JSON-LD so AI systems and search crawlers see the same facts.

### 8.2 Partial Update Query Planning

- For `faq` updates, retrieve E-E-A-T chunks about customer experience, claim safety, and evidence hierarchy.
- For `howToUse` updates, retrieve usage-direction, warning, and customer-use context chunks.
- For `description` updates, retrieve trust-first claim safety, entity consistency, and source-fact priority chunks.
- For `schema` updates, retrieve entity consistency, structured data compatibility, and trust-sensitive field rules.

## 9. Operator Checklist

- Is every generated claim supported by source product data, visible PDP text, review evidence, or approved policy guidance?
- Did review-backed wording stay representative instead of becoming a guaranteed product effect?
- Are `WebPage.description` and `Product.description` distinct but aligned?
- Are FAQ and HowTo generated from real product/customer context rather than copied labels?
- Are weak, conflicting, or high-risk claims reported in diagnostics instead of public output?
