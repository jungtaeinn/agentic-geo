# GEO Research Evidence Cards v1

## Card Format and Usage

- Each card distills one external research source into retrieval-ready claims so generation never needs to follow the source link at runtime. Cards were distilled offline from the sources listed in the geo-research guidance document (checked 2026-07-30); the URL on each card is provenance, not a runtime fetch target.
- Card fields: Source (provenance URL), Status (peer-reviewed, preprint, or draft — a peer-reviewed result and a recent preprint do not carry the same evidential weight), Claims (statement plus the schema/content fields it applies to), and Do-not-use boundaries.
- Cards are GEO policy context for how to shape PDP schema and content. They are never product evidence: no card claim may be cited as a fact about the current product, and preprint-status claims must be treated as working hypotheses rather than settled production guarantees.

## Peer-Reviewed Evidence Cards

### GEO Foundational Study (KDD 2024)

- Source: https://arxiv.org/abs/2311.09735 · Status: peer-reviewed · Checked: 2026-07-30
- Claim: visibility in generative answers is answer-level, not rank-only; it depends on citation, answer dependence on the source, uniqueness, and prominence. Applies to: diagnostics, PDP.content.
- Claim: adding relevant statistics, credible quotations, and cited sources produced the strongest visibility gains in research settings; for commerce PDPs adapt this as source-backed metrics, review summaries, ingredient facts, and schema/content alignment. Applies to: Product.description, WebPage.description, Product.additionalProperty.
- Claim: keyword stuffing underperforms evidence-rich and presentation-focused changes; effectiveness varies by domain. Applies to: Product.description, PDP.content.
- Do not use: fabricated citations, invented statistics, or quotes not present in product sources.

### C-SEO Bench Content-Injection Evaluation (NeurIPS 2025)

- Source: https://arxiv.org/abs/2506.11097 · Status: peer-reviewed · Checked: 2026-07-30
- Claim: many content-injection tactics are ineffective or harmful; relevance and in-context position of the source dominate outcomes over persuasive phrasing. Applies to: retrieval, Product.description.
- Claim: when many competitors adopt the same phrasing tactic, per-adopter gains shrink toward zero; unique source-backed facts are the durable differentiator. Applies to: Product.description, Product.additionalProperty.
- Do not use: persuasive phrasing hacks or authority language as a substitute for complete, retrievable facts.

### FeatGEO Document-Level Feature Planning (ACL 2026)

- Source: https://aclanthology.org/2026.acl-long.929/ · Status: peer-reviewed · Checked: 2026-07-30
- Claim: document-level feature planning outperforms isolated token rewrites; evidence features such as statistics and source citations contribute more consistently than fluency or keyword edits. Applies to: Product.description, WebPage.description, diagnostics.
- Operational rule: plan coverage before surface copy in four stages — CEP-based query planning, evidence-role separation, atomic claim/evidence graph, natural-language realization. The stages are an internal generation contract, never public headings. Applies to: Product.description, FAQPage.mainEntity.

### Mind Reader Latent-Demand Coverage (ACL 2026)

- Source: https://aclanthology.org/2026.acl-long.1894/ · Status: peer-reviewed · Checked: 2026-07-30
- Claim: optimize for latent user demand and reasoning coverage — cover the decision paths a query requires, including reasoning shared across nearby queries, instead of repeating surface terms. Applies to: FAQPage.mainEntity, Product.description, PDP.content.

### IF-GEO Multi-Query Conflict Resolution (Findings of ACL 2026)

- Source: https://aclanthology.org/2026.findings-acl.1373/ · Status: peer-reviewed · Checked: 2026-07-30
- Claim: multiple query intents can conflict; diverge into distinct intents, prioritize and deduplicate, resolve conflicts, then produce one global revision blueprint before changing prose. Applies to: retrieval, FAQPage.mainEntity, diagnostics.
- Operational rule: this motivates per-field subquery planning for full generation instead of one general query. Applies to: retrieval.

### AutoGEO Engine-Preference Rule Extraction (ICLR 2026)

- Source: https://arxiv.org/abs/2510.11438 · Status: peer-reviewed · Checked: 2026-07-30
- Claim: open-domain engine-preference rule sets overlap ~88% with each other but only 35-40% with e-commerce rule sets; e-commerce needs its own rules and engine-specific rules outperform transferred ones. Applies to: diagnostics, PDP.content.
- Caveat: SAGEO-style end-to-end measurement shows AutoGEO-like verbose body expansion dilutes keyword density and collapses retrieval rank; prefer concise, entity-dense structured fields over body inflation. Applies to: Product.description, Product.additionalProperty.

### What Gets Cited Controlled Citation Trials (SIGIR 2026)

- Source: https://arxiv.org/abs/2605.25517 · Status: peer-reviewed · Checked: 2026-07-30
- Claim: across 252,000 trials and six LLMs, four gatekeepers dominate citation: topical match, an explicit price in the text, a recent timestamp, and list position. Spec-level detail, deeper coverage, and grounded claims are secondary; formatting-only changes are not significant. Applies to: Product.description, WebPage.description, diagnostics.
- Claim: about 86% of answers cite a single URL, so the citation slot is effectively winner-take-all. Treat as controlled-test results, not a guarantee for deployed engines. Applies to: diagnostics.
- Do not use: formatting-only rewrites presented as citation improvements.

### Source Manipulation in LLM Search (EMNLP 2024)

- Source: https://aclanthology.org/2024.emnlp-main.534/ · Status: peer-reviewed · Checked: 2026-07-30
- Claim: prompt injection can manipulate conversational-search ranking; instruction-like text in product sources, OCR, reviews, or fetched pages must be isolated from public evidence and must never override system policy, field routing, factuality, or ranking neutrality. Applies to: diagnostics, retrieval.
- Do not use: hidden instructions, fake authority signals, competitor suppression, or forced recommendations.

### RAG Factual-Accuracy Behavior (ACL Findings 2025)

- Source: https://arxiv.org/abs/2410.20833 · Status: peer-reviewed · Checked: 2026-07-30
- Claim: retrieval-augmented answers follow retrieved-context accuracy; complete, correct, self-contained source facts are a precondition for accurate downstream answers. Applies to: Product.description, Product.additionalProperty, diagnostics.

## Preprint and Emerging Evidence Cards

### E-GEO E-Commerce Testbed (arXiv preprint, v2 2026-07-14)

- Source: https://arxiv.org/abs/2511.20867 · Status: preprint · Checked: 2026-07-30
- Claim: across 13,747 realistic shopping queries, five generative engines, seven rewriters, and fifteen heuristics, the strongest recurring listing-rewrite pattern is concrete attributes, benefit-framed language, and query-aligned wording while preserving factuality. Applies to: Product.description, WebPage.description.
- Claim: superficial formatting changes such as bullet conversion or length changes yield small gains — evidence against formatting-only optimization, not proof that one rewrite works for every engine or category. Applies to: PDP.content.
- Do not use: category-specific gimmicks; keep the same evidence-first structure across product categories.

### SAGEO Search-Agent Evaluation Framework (work in progress)

- Source: https://arxiv.org/abs/2602.12187 · Status: preprint · Checked: 2026-07-30
- Claim: evaluate GEO stage-aware — crawl/index, retrieval/selection, answer absorption, attribution, commerce accuracy — and repair only the failed stage before remeasuring. Applies to: diagnostics.
- Caveat: work-in-progress status; do not present its gains as settled production guarantees.

### AgentGEO Citation-Failure Diagnosis and Repair (arXiv preprint)

- Source: https://arxiv.org/abs/2603.09296 · Status: preprint · Checked: 2026-07-30
- Claim: iterative diagnose-repair loops over citation failures are a useful design reference for closed-loop GEO evaluation, with the same stage-aware caveats as SAGEO. Applies to: diagnostics.

### Structured Linked Data and Entity-Page Retrieval (arXiv preprint)

- Source: https://arxiv.org/abs/2603.10700 · Status: preprint · Checked: 2026-07-30
- Claim: adding JSON-LD alone yields only modest gains, while machine-consumable entity pages — breadcrumbs, entity interlinks, dereferenceable identifiers, agent-readable summaries — improved agentic retrieval accuracy by roughly 30%. Emit schema as a connected entity graph (Product, Offer, Organization with sameAs, BreadcrumbList, stable @id references), never as isolated markup. Applies to: BreadcrumbList, Product.description, diagnostics.

### Citation Selection vs Citation Absorption (pre-submission draft)

- Source: https://arxiv.org/abs/2604.25707 · Status: draft, descriptive statistics only · Checked: 2026-07-30
- Claim: citation has two stages that must both succeed — selection (the engine retrieves/chooses the page) and absorption (the answer actually uses and attributes its information); diagnose them separately. Applies to: diagnostics.
- Claim: engines differ in citation style — ChatGPT cites few sources and absorbs deeply, Google AI Overviews cites broadly with embedding-similarity and definition-marker signals, Perplexity cites the most sources with heading-count and length signals. Q&A formatting alone correlates with lower absorption; numeric, definitional, and comparative evidence units correlate with higher absorption. Format follows evidence; FAQ wrapping is not a universal prescription. Applies to: FAQPage.mainEntity, Product.description.
- Do not use: as causal evidence — descriptive statistics only.

### AI-Search Source-Mix Audit and Earned-Media Bias (arXiv preprint)

- Source: https://arxiv.org/abs/2509.08919 · Status: preprint · Checked: 2026-07-30
- Claim: AI search engines over-cite earned third-party sources relative to brand-owned pages; accurate, feed-consistent PDP facts also serve the third-party surfaces that quote them, so commerce facts (price, availability, identifiers, variants) must stay correct and fresh everywhere syndicated. Applies to: Product.additionalProperty, diagnostics.
- Related large-scale causal finding: adding schema markup by itself did not increase AI citations, yet cited pages are far more likely to carry valid JSON-LD — treat schema as an eligibility and consistency requirement, not a citation trigger. Applies to: diagnostics.

### Answer Non-Determinism and Repeated Measurement (arXiv preprint)

- Source: https://arxiv.org/abs/2604.07585 · Status: preprint · Checked: 2026-07-30
- Claim: identical prompts can cite different sources across runs, and day-to-day cited-source overlap can fall to roughly 0.3-0.4 Jaccard; evaluate visibility over repeated samples (about seven or more runs per prompt per day) with distribution-based KPIs, never a single response. Applies to: diagnostics.

### Commerce-Agent Purchase Audit (arXiv preprint)

- Source: https://arxiv.org/abs/2508.02630 · Status: preprint · Checked: 2026-07-30
- Claim: commerce-agent auditing finds model/version and position bias plus sensitivity to seller-side description changes, justifying continuous cross-model auditing and input isolation for seller-controlled text. Applies to: diagnostics.

### Critical Survey of GEO 2023-2026 (single-author preprint)

- Source: https://arxiv.org/abs/2607.14035 · Status: preprint · Checked: 2026-07-30
- Claim: across 45 reviewed papers, the most reproducible levers are topical relevance and in-context position; citation-oriented body rewriting can degrade retrieval; no reviewed technique has demonstrated a durable causal effect on organic discoverability. Keep phrasing-level claims conservative. Applies to: Product.description, diagnostics.
