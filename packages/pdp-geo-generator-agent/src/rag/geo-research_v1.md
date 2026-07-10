# GEO Research Guidance v1

## 1. Purpose

Generative Engine Optimization, or GEO, focuses on improving how useful, visible, attributable, and reusable source content is in generative search and AI answer systems. For this PDP generator, GEO means creating schema and visible content that a generative engine can retrieve, understand, summarize, and cite without inventing unsupported product claims.

## 2. Source Scope

### 2.1 Research Sources

- Sources checked on 2026-07-08:
  - GEO paper (KDD 2024): https://arxiv.org/abs/2311.09735
  - GEO project page: https://generative-engines.com/GEO/
  - C-SEO Bench (NeurIPS 2025 Datasets & Benchmarks): https://arxiv.org/abs/2506.11097
  - E-GEO e-commerce GEO testbed: https://arxiv.org/abs/2511.20867
  - Citation selection vs citation absorption framework: https://arxiv.org/abs/2604.25707
  - Answer non-determinism and repeated measurement: https://arxiv.org/abs/2604.07585
  - RAG citation behavior (factual accuracy drives citation): https://arxiv.org/abs/2410.20833
- The GEO paper describes generative engines as systems that retrieve sources and synthesize answers with LLMs, often using citations or source attribution.
- The paper shows that visibility in generative answers differs from classic ranking, and that useful changes can include source attribution, statistics, clear phrasing, and better presentation. Effectiveness varies by domain.

### 2.2 Official Search Guidance Sources

- Sources checked on 2026-06-24:
  - Google Search Central generative AI guidance: https://developers.google.com/search/docs/fundamentals/ai-optimization-guide
  - Google helpful content guidance: https://developers.google.com/search/docs/fundamentals/creating-helpful-content
  - Google Product structured data guidance: https://developers.google.com/search/docs/appearance/structured-data/product
- Google states that generative AI search features are rooted in core Search quality and ranking systems, and that effective strategy should prioritize helpful, reliable, people-first content and clear technical structure.
- Google also warns against "AEO/GEO hacks" such as unnecessary AI text files, inauthentic mentions, or artificial query-variation pages. This agent should therefore optimize source-backed PDP content and structured data, not create manipulative artifacts.

## 3. Core Research Insights

### 3.1 Visibility Is Answer-Level, Not Rank-Only

- Generative engines may synthesize multiple sources into one answer. Visibility can depend on whether the source is cited, how much of the answer depends on it, how unique the source material is, and how prominently it appears.
- PDP evaluation should therefore consider citation readiness, answer coverage, factual uniqueness, and field alignment rather than only classic search rank.

### 3.2 Source Attribution and Evidence Matter

- The GEO paper found strong results from adding relevant statistics, credible quotations, and cited sources in research settings.
- For commerce PDPs, this should be adapted as source-backed evidence, supported metrics, review summaries, ingredient facts, and schema/content alignment.
- Do not fabricate citations, quote customers who did not provide the quote, or add statistics without source data.

### 3.3 Keyword Stuffing Is Not a GEO Strategy

- The GEO paper reports weak performance for keyword stuffing compared with evidence-rich and presentation-focused changes.
- Google also warns against overproducing content for query variations. Use natural product language, not repeated keyword phrases.

### 3.4 Domain-Specific Optimization Matters

- Beauty and skincare PDPs need product-specific evidence: category, brand, ingredient/technology, skin or hair concern, texture, usage step, customer review language, size, offer, and constraints.
- A product page should be easy for AI systems to connect to customer questions such as "how to use it", "what ingredients are in it", "what reviews mention", and "who it is for".

### 3.5 Retrieval Relevance Dominates Phrasing Tricks

- C-SEO Bench (NeurIPS 2025) found many content-injection tactics are ineffective or harmful, while relevance and position of the source inside the model context dominate outcomes.
- Do not rely on persuasive phrasing hacks. Prioritize retrievability: complete facts, clear entity coverage, sub-intent coverage, and consistent visible text.
- When many competitors adopt the same phrasing tactic, per-adopter gains shrink toward zero; unique source-backed facts are the durable differentiator.

### 3.6 E-Commerce Listing Rewrites Converge on a Stable Pattern

- The E-GEO testbed (7,000+ realistic shopping queries) found effective listing rewrites converge on one domain-agnostic pattern: concrete attributes, benefit-framed language, and query-aligned wording.
- Apply this as the description order used in this project: target customer or concern, product identity, ingredient/technology, benefit or measured result, then usage/comparison/review context.
- Avoid category-specific gimmicks; keep the same evidence-first structure across product categories.

### 3.7 Citation Selection Mechanics

- RAG citation studies indicate the factual accuracy and self-containedness of a passage drive whether it is cited; there is no shortcut through authority claims alone.
- Two stages must both succeed: the engine must retrieve/choose the page, and the page's sentences must be absorbable into the answer. Write sentences that survive being lifted out of context.
- Generative answers are non-deterministic: identical prompts can cite different sources across runs. Visibility must be evaluated over repeated samples, not a single response.

## 4. Research-Backed GEO Principles

### 4.1 Entity Clarity

- Make the product entity unambiguous across `Product`, `WebPage`, `BreadcrumbList`, `FAQPage`, `HowTo`, URLs, images, brand, category, and variants.
- Avoid mixing page-level descriptions and product-entity descriptions.

### 4.2 Answer-Ready Facts

- Write concise factual sentences that can stand alone in an AI answer.
- Include product name, brand, category, target customer, ingredient/technology, benefit/effect or supported metric, and high-level usage/comparison/review preference only when available.

### 4.3 Source-Backed Claims

- Attach every public claim to source product data, OCR text, review evidence, official structured data, or approved RAG policy.
- Keep unsupported, conflicting, or high-risk claims in diagnostics rather than public output.

### 4.4 Schema and Visible Content Alignment

- Use schema.org and Google Product structured data guidance to represent the same facts users can see in generated HTML sections.
- Product snippets and merchant listing fields can improve product understanding only when the required facts are accurate and supported.

### 4.5 Review and Customer Language

- Use repeated customer review language to shape preference phrases and experience summaries; do not turn raw review language into standalone FAQ questions.
- Keep customer review language representative. Do not turn customer sentiment into universal product guarantees.

### 4.6 FAQ and HowTo Answerability

- Generate FAQ only when both the question intent and answer evidence exist.
- Generate HowTo only when source usage contains an explicit ordered sequence with at least two distinct actions and a concrete goal. Never infer a HowTo from one general usage note.
- Phrase answers so they directly answer customer questions instead of repeating marketing labels.
- HowTo steps are field-specific action content, not a place for benefit, metric, review, or ingredient evidence. A sentence that says a product "delivers hydration", "shows clinical results", or "contains an ingredient" can support descriptions or evidence fields, but it is not a usage step unless it also gives an action the customer performs.

### 4.6.1 Field Evidence Routing

- Before writing schema/content, classify source facts into evidence roles: identity, benefit/effect, ingredient/technology, actionable usage, review/customer expression, metric/evidence, FAQ, commerce, or page chrome.
- Keep `ingredients` limited to ingredient names, formula technologies, ingredient-role explanations, and full ingredient lists. Do not move customer review language, routine phrases, SEO/search-intent labels, or benefit summaries into ingredients.
- Keep `benefits` limited to customer-relevant outcomes, effects, review-backed positives, and short evidence topics. Do not copy full study text or diagnostic labels into benefit bullets.
- Keep `HowTo.step` limited to actions, order, amount, timing, body area, routine position, warnings, and compatibility. Do not add explanatory ingredient/effect context inside the step text.
- Use `Product.additionalProperty` for atomic facts such as key ingredient, key benefit, reported detail, usage timing, texture, size, or review context. Use `Product.description` and FAQ answers for concise synthesis.
- Blending evidence means using the right fact to support the right field-specific sentence; it does not mean merging raw source phrases across fields.
- Prefer evidence-role classification and source-grounded regeneration over product-specific suppression rules. A new product should improve from the same RAG field contract without adding product-name or single-sentence exceptions.

### 4.7 Locale and Market Fit

- Use the locale terminology map and market terminology rules before final output.
- Preserve official ingredient names, brand terms, and regulated terms while making customer-facing language natural for the market.

### 4.8 Provenance Diagnostics

- Diagnostics should show which RAG chunks and product facts influenced descriptions, FAQ, HowTo, and schema fields.
- The public output should not mention internal strategy labels such as GEO, RAG, citation-ready, E-E-A-T, CEP, or schema optimization.

## 5. Retrieval and Query Planning

### 5.1 RAG Corpus Management

- Prefer typed metadata over a single representative file: each RAG document should expose document kind, source role, checked date, intents, field targets, priority, and section headings.
- Retrieve at content-unit level when a document is long. A concise, relevant section is usually more useful than injecting an entire policy file into the model context.
- Use hybrid retrieval or reranking where available, but keep local deterministic fallback behavior for reproducibility.

### 5.2 Agentic Subquery Planning

- For full generation, retrieve schema, E-E-A-T, CEP, GEO research, official search docs, best-practice, locale, and terminology chunks.
- For partial FAQ updates, retrieve FAQ, customer, review, CEP, E-E-A-T, and schema chunks.
- For partial HowTo updates, retrieve usage, routine, CEP, claim-safety, and HowTo schema chunks.
- For partial description updates, retrieve entity separation, answer-ready facts, E-E-A-T claim safety, customer review language, and GEO research chunks.
- For partial schema updates, retrieve schema.org compatibility, Google Product structured data, entity consistency, and trust-sensitive field rules.

## 6. PDP Field Guidance

### 6.1 `WebPage.description`

- Describe the PDP as a page that helps a customer evaluate the product through benefits, ingredients, usage, reviews, FAQ, HowTo, offers, variants, and reported results when available.
- Use page-level discovery language and avoid duplicating `Product.description`.

### 6.2 `Product.description`

- Describe the product entity with target customer, product-specific benefits, key ingredients or technologies, texture/format, usage context, representative customer review language, and supported metrics.
- Keep the wording concise, factual, and source-backed.

### 6.3 `FAQPage.mainEntity`

- Use high-priority customer questions derived from product facts, reviews, CEPs, and source text.
- Avoid copied source headings, unsupported questions, and generic SEO questions that the product evidence cannot answer.

### 6.4 `HowTo.step`

- Convert source usage instructions into complete ordered actions only when at least two actions and their sequence are source-backed; otherwise retain them as ordinary visible usage guidance.
- Do not invent usage warnings or contraindications.

### 6.5 `Product.additionalProperty` and `Product.positiveNotes`

- Use `additionalProperty` for objective attributes such as ingredient, skin type, usage timing, texture, size, technology, concern, or format.
- Use `positiveNotes` for supported benefit and review-backed positive points.

## 7. Evaluation Checklist

### 7.1 Visibility and Answer Coverage

- Can a generative engine answer "what is it", "who is it for", "how do I use it", "what ingredients matter", and "what do reviews mention" from the generated output?
- Are product facts specific enough to differentiate this product from nearby products?
- When measuring citation visibility, sample the same buyer-intent prompts repeatedly per platform; single-shot checks are unreliable because generative answers are non-deterministic.

### 7.2 Evidence Coverage

- Are claims traceable to source fields, OCR text, review evidence, or approved RAG guidance?
- Are weak claims softened or omitted?

### 7.3 Schema Quality

- Are schema fields valid, visible-content aligned, and not duplicated across entity roles?
- Are offer, review, rating, availability, shipping, return, and variant facts generated only when reliable?

### 7.4 Public Copy Quality

- Does the copy remain natural for humans?
- Does it avoid keyword stuffing, internal strategy labels, and repetitive stock phrases?

## 8. When GEO RAG Helps

- It helps when product data is broad or messy and the agent needs a stable reasoning layer for field routing, claim safety, review summarization, CEP mapping, and schema alignment.
- It helps partial updates because subquery planning can retrieve only the sections needed for FAQ, HowTo, description, or schema changes.
- It helps diagnostics because each generated section can be linked back to the RAG policy sections and product evidence that shaped it.

## 9. When GEO RAG Is Not Enough

- It cannot compensate for missing product evidence, missing review data, incorrect source fields, blocked crawlers, or poor page rendering.
- It cannot guarantee search or generative-answer inclusion; it improves content quality, retrievability, and attribution readiness.
- It should not be used to create artificial llms.txt-style shortcuts, hidden content, fake citations, fake reviews, or scaled query pages.
