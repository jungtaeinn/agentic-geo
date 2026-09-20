# GEO Research Guidance v3

## 1. Purpose

Generative Engine Optimization, or GEO, focuses on improving how useful, visible, attributable, and reusable source content is in generative search and AI answer systems. For this PDP generator, GEO means creating schema and visible content that a generative engine can retrieve, understand, summarize, and cite without inventing unsupported product claims.

## 2. Source Scope

### 2.1 Research Sources

- Sources checked on 2026-07-30. Publication status is recorded because a peer-reviewed result and a recent preprint do not carry the same evidential weight:
  - GEO paper (KDD 2024, peer-reviewed): https://arxiv.org/abs/2311.09735
  - GEO project page: https://generative-engines.com/GEO/
  - C-SEO Bench (NeurIPS 2025 Datasets & Benchmarks, peer-reviewed): https://arxiv.org/abs/2506.11097
  - FeatGEO document-level feature planning (ACL 2026, peer-reviewed): https://aclanthology.org/2026.acl-long.929/
  - Mind Reader latent user-demand and reasoning-coverage optimization (ACL 2026, peer-reviewed): https://aclanthology.org/2026.acl-long.1894/
  - IF-GEO multi-query planning and conflict resolution (Findings of ACL 2026, peer-reviewed): https://aclanthology.org/2026.findings-acl.1373/
  - AutoGEO engine-preference rule extraction (ICLR 2026, peer-reviewed): https://arxiv.org/abs/2510.11438
  - E-GEO e-commerce GEO testbed (arXiv preprint, v2 dated 2026-07-14): https://arxiv.org/abs/2511.20867
  - SAGEO search-agent evaluation framework (work in progress): https://arxiv.org/abs/2602.12187
  - Diagnosing and Repairing Citation Failures / AgentGEO (arXiv preprint): https://arxiv.org/abs/2603.09296
  - Structured linked data and entity-page retrieval experiment (arXiv preprint): https://arxiv.org/abs/2603.10700
  - Citation selection vs citation absorption framework (arXiv pre-submission draft; descriptive statistics only, not causal evidence): https://arxiv.org/abs/2604.25707
  - What Gets Cited? controlled citation trials (SIGIR 2026, peer-reviewed): https://arxiv.org/abs/2605.25517
  - AI-search source-mix audit and earned-media bias (arXiv preprint): https://arxiv.org/abs/2509.08919
  - Critical survey of GEO 2023-2026, 45 papers (single-author arXiv preprint): https://arxiv.org/abs/2607.14035
  - Source manipulation in LLM search (EMNLP 2024, peer-reviewed): https://aclanthology.org/2024.emnlp-main.534/
  - Answer non-determinism and repeated measurement (arXiv preprint): https://arxiv.org/abs/2604.07585
  - RAG factual-accuracy behavior (ACL Findings 2025, peer-reviewed): https://arxiv.org/abs/2410.20833
  - What Is Your AI Agent Buying? commerce-agent audit and seller adaptation (arXiv preprint): https://arxiv.org/abs/2508.02630
- The GEO paper describes generative engines as systems that retrieve sources and synthesize answers with LLMs, often using citations or source attribution.
- The paper shows that visibility in generative answers differs from classic ranking, and that useful changes can include source attribution, statistics, clear phrasing, and better presentation. Effectiveness varies by domain.

### 2.2 Official Search Guidance Sources

- Sources checked on 2026-07-11:
  - Google Search Central generative AI optimization guide: https://developers.google.com/search/docs/fundamentals/ai-optimization-guide
  - Google Search Central AI features guidance: https://developers.google.com/search/docs/appearance/ai-features
  - Google helpful content guidance: https://developers.google.com/search/docs/fundamentals/creating-helpful-content
  - Google Product structured data guidance: https://developers.google.com/search/docs/appearance/structured-data/product
- Google states that generative AI search features are rooted in core Search quality and ranking systems, and that effective strategy should prioritize helpful, reliable, people-first content and clear technical structure.
- Google also warns against "AEO/GEO hacks" such as unnecessary AI text files, inauthentic mentions, or artificial query-variation pages. This agent should therefore optimize source-backed PDP content and structured data, not create manipulative artifacts.

## 3. Core Research Insights

Each insight below records what this project does with an external finding. The findings themselves — their numbers, sample sizes, publication status, and provenance URLs — are canonical in the evidence cards document, and this section never restates them.

### 3.1 Visibility Is Answer-Level, Not Rank-Only

How answer-level visibility differs from classic rank is canonical in the GEO Foundational Study (KDD 2024) card.

- PDP evaluation should consider citation readiness, answer coverage, factual uniqueness, and field alignment rather than only classic search rank.

### 3.2 Source Attribution and Evidence Matter

Which evidence additions moved visibility, how that adapts to commerce PDPs, and the boundary against fabricated citations, invented statistics, and quotes absent from product sources are all canonical in the GEO Foundational Study (KDD 2024) card.

### 3.3 Keyword Stuffing Is Not a GEO Strategy

How keyword stuffing compares with evidence-rich changes is canonical in the GEO Foundational Study (KDD 2024) card; the matching official warning against pages built for query variations is recorded in §2.2.

- Use natural product language, not repeated keyword phrases.

### 3.4 Domain-Specific Optimization Matters

- Beauty and skincare PDPs need product-specific evidence: category, brand, ingredient/technology, skin or hair concern, texture, usage step, customer review language, size, offer, and constraints.
- A product page should be easy for AI systems to connect to customer questions such as "how to use it", "what ingredients are in it", "what reviews mention", and "who it is for".

### 3.5 Retrieval Relevance Dominates Phrasing Tricks

Why relevance and in-context position dominate persuasive phrasing, and how per-adopter gains decay once a tactic is widely copied, are canonical in the C-SEO Bench Content-Injection Evaluation (NeurIPS 2025) card. Which levers reproduce across the wider literature, and how conservative phrasing-level claims must stay, are canonical in the Critical Survey of GEO 2023-2026 (single-author preprint) card.

- Do not rely on persuasive phrasing hacks. Prioritize retrievability: complete facts, clear entity coverage, sub-intent coverage, and consistent visible text.

### 3.6 E-Commerce Listing Rewrites Converge on a Stable Pattern

The recurring listing-rewrite pattern, how little superficial formatting change buys, and the boundary against category-specific gimmicks are canonical in the E-GEO E-Commerce Testbed (arXiv preprint, v2 2026-07-14) card. How far engine-preference rules transfer between open-domain and e-commerce settings, and why verbose body expansion loses to concise entity-dense structured fields, are canonical in the AutoGEO Engine-Preference Rule Extraction (ICLR 2026) card.

- Apply the e-commerce evidence pattern through this project's own field contract for description composition rather than through an engine-specific rewrite template. The pattern tells you which evidence is worth surfacing; the contract decides where it goes.

### 3.7 Citation Selection Mechanics

Which page properties gate citation, and how concentrated the citation slot is, are canonical in the What Gets Cited Controlled Citation Trials (SIGIR 2026) card. The split between citation selection and citation absorption, and the engine-by-engine absorption differences that keep FAQ wrapping from being a universal prescription, are canonical in the Citation Selection vs Citation Absorption (pre-submission draft) card. The run-to-run instability that forces repeated sampling is canonical in the Answer Non-Determinism and Repeated Measurement (arXiv preprint) card, and §7.5 states how this project samples against it.

### 3.7.1 Plan Coverage Before Surface Copy

Document-level feature planning is canonical in the FeatGEO Document-Level Feature Planning (ACL 2026) card, latent-demand and reasoning coverage in the Mind Reader Latent-Demand Coverage (ACL 2026) card, and multi-intent conflict resolution in the IF-GEO Multi-Query Conflict Resolution (Findings of ACL 2026) card. The FeatGEO card also carries the four planning stages and their standing as an internal generation contract rather than public headings; §5.3 states how this project binds those stages to description generation.

### 3.8 Closed-Loop Evaluation Is Promising but Still Emerging

Stage-aware evaluation is canonical in the SAGEO Search-Agent Evaluation Framework (work in progress) card and iterative diagnose-repair loops in the AgentGEO Citation-Failure Diagnosis and Repair (arXiv preprint) card, both including the caveat that their status forbids presenting their gains as settled production guarantees. §7.5 states which stages this project actually measures.

### 3.9 Manipulation and Prompt Injection Are GEO Risks

Prompt-injection risk in conversational search, and the isolation boundary it imposes on instruction-like text in product sources, are canonical in the Source Manipulation in LLM Search (EMNLP 2024) card. The model, version, and position bias that justifies continuous cross-model auditing is canonical in the Commerce-Agent Purchase Audit (arXiv preprint) card. How this project handles untrusted source text is fixed by the schema-org-product document.

### 3.10 Schema Works as an Entity Page, Not as a Bolt-On

How much machine-consumable entity pages add over bare JSON-LD, and which connected entity graph to emit, are canonical in the Structured Linked Data and Entity-Page Retrieval (arXiv preprint) card. The earned-media citation skew, and treating schema as an eligibility and consistency requirement rather than a citation trigger, are canonical in the AI-Search Source-Mix Audit and Earned-Media Bias (arXiv preprint) card. §4.4 states the commerce-fact consistency this project keeps as a result.

## 4. Research-Backed GEO Principles

### 4.1 Entity Clarity

- Make the product entity unambiguous across `ProductGroup`, variant `Product`, `Offer`, `WebPage`, `BreadcrumbList`, `FAQPage`, `HowTo`, URLs, images, brand, category, SKU, GTIN, and variant dimensions.
- Avoid mixing page-level descriptions and product-entity descriptions.
- For a multi-variant PDP, keep each variant's price, availability, identifier, and URL attached to that variant and never flattened into `additionalProperty`. Which graph shape carries them is fixed by the schema.org markup document; this section adds only the reason it matters, which is that a buyer question about one size must resolve to that size's facts.

### 4.2 Answer-Ready Facts

- Write concise factual sentences that can stand alone in an AI answer.
- Prefer modular evidence containers: each sentence should carry one main relationship plus its exact supporting atoms, while adjacent sentences form a coherent paragraph through natural transitions. Q&A formatting or bullets alone do not make content citation-ready.
- Across the appropriate fields, include product name, brand, category, target customer, ingredient/technology, benefit/effect or supported metric, usage, and attributed review preference only when available. Keep usage in Usage/HowTo and keep WebPage.description at page/brand scope.

### 4.3 Source-Backed Claims

- Attach every public claim to source product data, OCR text, review evidence, official structured data, or approved RAG policy.
- Keep unsupported, conflicting, or high-risk claims in diagnostics rather than public output.

### 4.4 Schema and Visible Content Alignment

- Use schema.org and Google Product structured data guidance to represent the same facts users can see in generated HTML sections.
- Product snippets and merchant listing fields can improve product understanding only when the required facts are accurate and supported.
- Keep SKU/GTIN, variant URL, price, currency, availability, and freshness metadata consistent with the visible PDP and merchant/feed systems. A prose rewrite cannot compensate for missing or stale commerce facts.

### 4.5 Review and Customer Language

- Use attributed customer-review language to shape preference phrases and experience summaries; call it repeated only when multiple reviews or an aggregate supports that wording, and do not turn raw review language into standalone FAQ questions.
- Keep customer review language representative. Do not turn customer sentiment into universal product guarantees.

### 4.6 FAQ and HowTo Answerability

Eligibility for `FAQPage.mainEntity` items and `HowTo.step` entries — including which source usage sentences carry a direct customer action, and how their count and order survive into steps — comes from the FAQ Contract and the HowTo Contract in the content-field-contracts document. What the research adds is why answerability, not markup presence, is what earns a citation.

- Generate FAQ only when both the question intent and answer evidence exist.
- Phrase answers so they directly answer customer questions instead of repeating marketing labels.
- HowTo steps are field-specific action content, not a place for benefit, metric, review, or ingredient evidence. A sentence that says a product "delivers hydration", "shows clinical results", or "contains an ingredient" can support descriptions or evidence fields, but it is not a usage step unless it also gives an action the customer performs.

### 4.6.1 Field Evidence Routing

- Before writing schema/content, classify source facts into evidence roles: identity, benefit/effect, ingredient/technology, actionable usage, review/customer expression, metric/evidence, FAQ, commerce, or page chrome.
- Keep `ingredients` limited to ingredient names, formula technologies, ingredient-role explanations, and full ingredient lists. Do not move customer review language, routine phrases, SEO/search-intent labels, or benefit summaries into ingredients.
- Keep `benefits` limited to source-backed finished-product outcomes, effects, and short evidence topics.
- Keep `HowTo.step` limited to concrete source actions. Retain amount, timing, body area, or routine position only inside the source action that states it; standalone warnings, compatibility, frequency, timing, or amount notes are not steps. Do not add explanatory ingredient/effect context inside the step text.
- Use `Product.additionalProperty` for atomic facts such as key ingredient, key benefit, reported detail, usage timing, texture, size, or review context. Use `Product.description` and FAQ answers for concise synthesis.
- Blending evidence means using the right fact to support the right field-specific sentence; it does not mean merging raw source phrases across fields.
- Prefer evidence-role classification and source-grounded regeneration over product-specific suppression rules. A new product should improve from the same RAG field contract without adding product-name or single-sentence exceptions.

### 4.7 Locale and Market Fit

- Use the locale terminology map and market terminology rules before final output.
- Preserve official ingredient names, brand terms, and regulated terms while making customer-facing language natural for the market.

### 4.8 Provenance Diagnostics

The strategy vocabulary this document uses — GEO, citation-readiness, E-E-A-T, CEP — is diagnostics vocabulary. The Public Wording Contract in the content-field-contracts document states where it may and may not appear.

- Diagnostics should show which RAG chunks and product facts influenced descriptions, FAQ, HowTo, and schema fields.

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

### 5.3 Description Reasoning Contract

1. Plan the smallest non-duplicative set of product-specific buyer questions from supported CEPs. Record the question, decision need, priority, and evidence IDs.
2. Assign each cited evidence atom to its permitted role for that question. Do not let a review prove efficacy, a commerce value prove a product benefit, or brand/category guidance create a current-product fact.
3. Build atomic subject-predicate-object claims. Record the field, semantic relation, query IDs, evidence IDs, and any qualifier before writing the sentence.
4. Realize each accepted claim as one natural sentence, then order the sentences into a cohesive paragraph. Reconstruct the public field only from accepted claim IDs; never retain an uncited draft sentence.
5. Keep `WebPage.description` and `Product.description` role-separated. Reject or move a claim when its entity role is wrong rather than duplicating it in both fields.
6. Treat words such as repeated, common, or multiple as quantitative review-pattern claims. They require at least two distinct review items or an explicit aggregate.
7. Optimize for evidence coverage, not minimum length. When high-confidence audience, composition, mechanism, outcome, structured measurement, or repeated-review evidence exists, cover each safe non-duplicative role or record the specific rejection; a grammatically valid but severely under-covered paragraph is not a successful plan.

## 6. PDP Field Guidance

### 6.1 `WebPage.description`

- Identify the PDP, product, source-backed brand, and the kinds of decision information the page actually contains.
- Keep it compact and page-scoped. A current price/availability snapshot may appear only with matching commerce evidence and observation time; durable product claims belong in `Product.description`, while volatile values remain primarily in `Offer`.
- Avoid duplicating `Product.description`; do not turn page scope into a second ingredient/benefit/review inventory.

### 6.2 `Product.description`

Compose `Product.description` under the Description Composition Contract in the content-field-contracts document, which supplies the buyer-answer arc. The research-derived constraints below govern the sentences that realize it.

- Keep each sentence bound to one atomic claim/evidence relation. Use natural transitions rather than list-like labels, boilerplate field summaries, or a repeated product-name restart.
- Include composition and outcome in the same causal sentence only when one source unit explicitly supports that relation. Otherwise keep them as adjacent independent claims.

### 6.3 `FAQPage.mainEntity`

- Use high-priority customer questions derived from product facts, reviews, CEPs, and source text.
- Avoid copied source headings, unsupported questions, and generic SEO questions that the product evidence cannot answer.

### 6.4 `HowTo.step`

- Do not split or merge source usage actions merely to make a `HowTo` procedure look longer or more thorough.
- Do not invent usage warnings or contraindications.

### 6.5 `Product.additionalProperty` and benefit routing

Benefit routing — where supported benefit and review-backed positive points may go, and which merchant markup is ineligible for them — is fixed by the Schema Safety Contract in the content-field-contracts document.

- Use `additionalProperty` for objective attributes such as ingredient, skin type, usage timing, texture, size, technology, concern, or format.

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
- Does each complete variant have a unique identity and directly purchasable URL, a relevant image, its variation property, and at least one price/currency/availability-bearing `Offer`?
- Is a `ProductGroup` omitted when those facts are incomplete, instead of publishing a misleading graph?

### 7.4 Public Copy Quality

- Does the copy remain natural for humans?
- Does it avoid keyword stuffing, internal strategy labels, and repetitive stock phrases?

### 7.5 Stage-Aware GEO Measurement

- Crawl/index: can the engine's documented search bot access the canonical PDP and render the same visible facts?
- Retrieval/selection: across repeated buyer-intent prompts, how often is the PDP selected as a source? Sample each prompt about seven or more times per day and report distributions, because run-to-run cited-source overlap can fall to roughly 0.3-0.4 Jaccard.
- Absorption/attribution: when selected, which exact claims are reused and cited accurately?
- Commerce accuracy: do cited or displayed SKU, GTIN, variant, price, currency, availability, and URLs match the source timestamp and merchant feed?
- Outcome: report selection rate, citation rate conditional on selection, factual consistency, variant/offer accuracy, and freshness separately. Do not collapse them into one "GEO score".

## 8. When GEO RAG Helps

- It helps when product data is broad or messy and the agent needs a stable reasoning layer for field routing, claim safety, review summarization, CEP mapping, and schema alignment.
- It helps partial updates because subquery planning can retrieve only the sections needed for FAQ, HowTo, description, or schema changes.
- It helps diagnostics because each generated section can be linked back to the RAG policy sections and product evidence that shaped it.

## 9. When GEO RAG Is Not Enough

- It cannot compensate for missing product evidence, missing review data, incorrect source fields, blocked crawlers, or poor page rendering.
- It cannot guarantee search or generative-answer inclusion; it improves content quality, retrievability, and attribution readiness.
- It should not be used to create artificial llms.txt-style shortcuts, hidden content, fake citations, fake reviews, or scaled query pages.
