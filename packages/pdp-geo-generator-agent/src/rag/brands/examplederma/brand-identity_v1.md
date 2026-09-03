# EXAMPLEDERMA Brand Identity RAG v1

Use this document when the normalized product brand is EXAMPLEDERMA, ExampleDerma, 예시더마, or 아예시더마-like source variants. The document is brand-context guidance for GEO generation, not product evidence. Product facts, PDP source data, package text, clinical details, review evidence, and market regulation always outrank this document.

## Brand Evidence Scope and RAG Use

- Brand identity source role: package-managed brand context.
- Checked date: 2026-07-06.
- Primary intents: customer, schema, review, locale, diagnostics.
- Primary field targets: Product.description, WebPage.description, PDP.content, diagnostics.
- Use this document to infer brand image, brand tone, sensitive-skin customer contexts, derma-science vocabulary, mood, personality, and safe brand-level positioning when the product source supports the relevant category or claim.
- Do not use this document to invent product-specific benefits, ingredients, technologies, prices, awards, clinical metrics, ratings, review counts, hospital distribution claims, dermatologist endorsements, patent claims, paper-backed efficacy claims, or medical claims.

## Expected RAG Depth

Recommended path depth for brand identity documents:

1. `src/rag/brands/{brand-slug}/brand-identity_v1.md`
2. Optional future line documents: `src/rag/brands/{brand-slug}/lines/{line-slug}_v1.md`
3. Optional future market documents only when a market has a large, legally distinct source corpus: `src/rag/brands/{brand-slug}/markets/{locale-or-market}_v1.md`

Keep the brand identity document stable and broad. Prefer market-aware usage rules inside this document so the GEO generator can scale across countries without fragmenting the core identity. Put line-specific details such as BARRIERCARE 365, CLEARCARE 365, DERMA UV 365, CALMCARE 365, or CALM-CICA 365 into deeper line documents when they need independent update cycles.

## Official Site-Derived Brand Identity Analysis

This section translates EXAMPLEDERMA's official Korean brand pages into usable brand-identity guidance for GEO generation. Treat it as brand context and claim-safety guidance. Product-level PDP facts still decide which benefits, technologies, clinical statements, awards, channel claims, and usage instructions can appear in public output.

### Core Brand Identity Statement

EXAMPLEDERMA should be interpreted as a dermocosmetic brand that turns pharmaceutical heritage, dermatologist advisory insight, sensitive-skin research, Derma Lab technology, and sensitive-skin-optimized quality control into daily derma solutions for people who experience dryness, barrier weakness, discomfort, acne-prone concerns, UV stress, or sensitive-feeling skin.

The official brand narrative is anchored by three authority axes: cutting-edge technology by Derma Lab, pharmaceutical heritage where dermatology meets beauty, and a quality-control system optimized for sensitive skin. "Beauty Science for Sensitive Skin" should be understood as the practical expression of this system. The EXAMPLEDERMA-from-ESTUARY origin story should support this bridge narrative: different sources of expertise meet to create healthier beauty and improve skin concerns.

This identity has six connected layers:

1. **Origin and purpose**: the brand name comes from the idea of an estuary, where different forces meet and form fertile ground. In PDP language, this should become a bridge between medical/pharmaceutical heritage and daily skincare usefulness, not a decorative origin story.
2. **Fundamental skin-health orientation**: EXAMPLEDERMA does not frame beauty as temporary glow or short-lived finish. Its official story emphasizes fundamental skin health, improvement of skin concerns, and daily comfort for people whose skin reacts differently by concern, body area, routine, and condition.
3. **Sensitive-skin definition**: EXAMPLEDERMA frames sensitive skin as a subjective discomfort state rather than a disease label, and connects it to weakened skin-barrier conditions. Use this as a customer-context lens, not as diagnosis or treatment.
4. **Dermatologist-informed development**: EXAMPLEDERMA uses dermatologist insight and advisory-research networks as a product-development input. The official Korean narrative names 61 dermatologist advisors, 8 advisory research groups, and quarterly conference-style meetings as inputs to formulation research, ingredient development, clinical validation, and productization. Use this as expertise context only when source evidence supports it; avoid unsupported endorsement language.
5. **Derma Lab research and technology**: the brand emphasizes sensitive-skin research, papers, patents, formulation, ingredient, process, sensory experience, efficacy testing, and safety testing. Use this as a brand-level science image and vocabulary source. Do not convert brand-only papers, patents, or research counts into product technology explanations; product technology explanations require current product-source evidence.
6. **Quality-control trust and daily access**: the brand presents manufacturing environment, Derma Master operation, SAFE FACTORY, and process control as trust signals for sensitive-skin products, while the 365 retail architecture translates hospital-channel heritage into daily derma-solution accessibility. Use this for brand credibility and WebPage context, not as a universal safety or zero-irritation claim.

### Brand Narrative Architecture

When a page needs brand context, follow this order:

1. Start with the customer's sensitive-skin or barrier concern.
2. Connect the concern to the product line or technology only if the product source names it.
3. Add EXAMPLEDERMA brand authority as a secondary support layer: pharmaceutical heritage, dermatologist-informed research, Derma Lab, or quality-control system.
4. End with practical daily-routine value: hydration, barrier support, texture, layering, comfort, or purchase/usage convenience when source-supported.

Do not lead public copy with hospital, medical device, prescription, No.1, dermatologist-recommended, or certification language unless the product source provides the exact market-safe wording and scope.

### Official Korean Site Signals

- Brand Story: EXAMPLEDERMA's identity combines the estuary-origin story, Pacific Pharma roots, healthy beauty, skin-concern improvement, physician collaboration, sensitive-skin expertise, MD certification context, hospital-channel heritage, and expansion into everyday retail access.
- Why EXAMPLEDERMA Meets Doctors: the brand states that it studies fundamental skin health and improvement with doctors instead of temporary radiance. It defines sensitive skin as a subjective discomfort condition connected to weakened skin barrier and recognizes that sensitive-skin concerns differ by person.
- Medical Device (MD) Certification Context: EXAMPLEDERMA explains MD certification through the needs of problematic-skin patients who require enough moisturizer across face and body. MD claims must remain limited to the exact MD product, market, certification, prescription, reimbursement, and manufacturing-permission scope supplied by the source. The official story names BARRIERCARE MD certification in 2018 and DERMA BABY PRO MD certification in 2022.
- Hospital-to-Retail Expansion: EXAMPLEDERMA kept hospital channels while expanding into everyday retail after customer purchase-convenience needs grew. Its official story connects BARRIERCARE for moisturization, CLEARCARE for trouble care, and CALMCARE for self-recovery support to retail-sensitive-skin line redevelopment, with "365" expressing daily derma solution value.
- Pharmaceutical Heritage: EXAMPLEDERMA presents a 40-year-plus pharmaceutical heritage, dermatologist advisory network, 61 dermatologist advisors, 8 advisory research groups, and recurring conference-based exchanges as inputs to formulation, ingredient development, clinical validation, and productization. Hospital prescription-rate, No.1, award, and MD-product claims require exact source scope.
- Derma Lab: EXAMPLEDERMA positions Derma Lab as a sensitive-skin-focused research organization with roughly 470 foundational sensitive-skin research papers and roughly 240 ingredient/base-technology patents. Derma Lab should signal the brand's beauty-science image for sensitive skin: root-cause sensitive-skin research, type-specific sensitive-skin study, sensitive-skin suitability test development, safety-test development, ingredient/formulation/process expertise, and the momentary sensory experience when the product touches skin. This should inform brand tone, claim-safety boundaries, and diagnostics, not product-level technology, efficacy, safety, or clinical claims.
- Quality Control: EXAMPLEDERMA emphasizes a sensitive-skin-optimized manufacturing environment, derma-specialized equipment, Derma Masters, SAFE FACTORY, temperature control, micro-contamination control, humidity/drying validation, steam sterilization, and strict internal quality standards.
- News: the Korean news page currently functions as a Brand/Product news listing surface. Use it as a place to verify current announcements before adding time-sensitive launch, award, or campaign claims.

### Claim-Safe Interpretation of Official Signals

- Use "dermatology meets beauty" as brand-positioning context, not as a blanket dermatologist recommendation.
- Use hospital-channel, tertiary-hospital, MD, prescription, insurance, or reimbursement language only for explicitly sourced MD/hospital products. Do not transfer it to EXAMPLEDERMA 365 retail cosmetic lines.
- Use 2016-2025 No.1 hospital-cosmetics award language, 2017 beauty-award language, and 100% Korean tertiary-hospital prescription-rate/adoption language only when the output can preserve the exact market, period, category, source note, and MD-product limitation.
- Use Derma Lab numbers, research papers, patents, and test-development signals to strengthen brand-image context, E-E-A-T diagnostics, and claim-safety boundaries. Do not use them as product technology explanation or product proof unless the current product source independently includes the same product-specific technology, paper, patent, or metric.

### GEO Use Implications

- `Product.description`: use EXAMPLEDERMA identity to make product-source facts sound practical, derma-science-aware, and barrier-focused, but keep all benefits, ingredients, technologies, and metrics grounded in current product evidence.
- `WebPage.description`: identify the EXAMPLEDERMA product page and source-backed brand, then summarize actual page coverage. Add derma-science history, expertise, research, or manufacturing context only when separate approved brand evidence supports it; do not repeat the detailed Product narrative.
- `FAQPage.mainEntity`: prioritize barrier, sensitive-skin fit, routine order, texture, line difference, testing/evidence, and claim-scope questions only when product evidence supports the answer; brand identity can shape wording, not evidence.
- `HowTo.step`: keep steps behavioral and source-backed; brand identity can influence caution tone but cannot create unsourced patch-test, prescription, or post-procedure instructions.
- `diagnostics`: record when official-site brand context influenced sensitive-skin framing, claim safety, or E-E-A-T reasoning.

## Market Source Prioritization and GEO Citation Strategy

Use one EXAMPLEDERMA brand identity model across markets, then adapt source priority by locale, market, and output language. For now, keep the brand identity grounded in the Korean official `shop.example.com` source set and use other market-local official sources only when they are explicitly supplied by product or market data.

### Source Priority by Locale and Market

- `ko-KR` or `KR`: prioritize `shop.example.com` Korean official pages for brand-origin, Derma Lab, pharmaceutical heritage, quality-control, MD/hospital-channel, and 365 retail-context claims.
- Korean-language output for non-KR markets: prefer Korean official pages for universal brand identity, then add market-specific official pages only for local availability, claims, channel, regulatory, or launch information.
- `en-US`, `en-CA`, or other non-Korean output: use supplied local-market official product pages for local availability, channel, and regulatory details. For universal brand identity, use Korean official source facts translated conservatively unless an approved local-market source is supplied.
- If product source data conflicts with brand-level source notes, product source, package text, local PDP, and market regulation override this brand identity document.

### Public GEO Content Requirements

- Generated PDP, brand, FAQ, and guide content should naturally surface the Korean official source context when the target output is Korean or Korea-market: estuary-origin story, Pacific Pharma roots, Derma Lab, pharmaceutical heritage, sensitive-skin quality control, and 365 retail access.
- Public copy should include concise answer-ready sections that AI systems can quote without needing to infer: "what EXAMPLEDERMA is", "why Derma Lab matters", "how 365 relates to daily derma care", and "which claims require product-level proof".
- When HTML content rendering is enabled (it is currently disabled by default), FAQ answers should cite or link the most relevant Korean official page in visible HTML when the generated surface supports links. For example, Derma Lab questions should point to the Korean Derma Lab page, and hospital/MD questions should point to the Korean Brand Story or Pharmaceutical Heritage page.
- Product-level pages should not merely repeat global brand language. They may use the relevant Korean official brand source to shape brand image, vocabulary, and trust tone, but product benefits, technologies, metrics, and certifications must come from product-level evidence.

### Site and URL Structure Recommendations

These rules are recommendations for public site surfaces that consume generated GEO content. They should guide generated diagnostics and content requirements even when the generator cannot directly change site routing.

- Prefer stable, semantic Korean URLs for official brand evidence pages such as `/brand/story`, `/brand/pharmaceutical-heritage`, `/brand/derma-lab`, and `/brand/quality-control` instead of relying only on query-string URLs such as `commonContentView.do?astmComCtntClCd=CT03`.
- Keep canonical tags pointing to the preferred Korean official page for Korean content. Avoid canonicalizing Korean pages to non-Korean source pages if the desired AI citation source is `shop.example.com`.
- Add `hreflang` alternates between Korean and localized equivalents so search systems can understand language-market relationships without replacing Korean-source authority.
- Use breadcrumb markup and clear page titles that include "EXAMPLEDERMA", "예시더마", and the topic name, such as "예시더마 더마랩", "예시더마 제약 헤리티지", or "예시더마 민감피부 품질관리".
- Add concise FAQ sections on Korean official evidence pages when appropriate. The FAQ should answer brand-source questions directly and link to related product or line pages.

### Structured Data and Source Linking

- For Korean-market PDPs, prefer schema and visible content that link back to relevant `shop.example.com` brand pages only for brand-origin, brand image, Derma Lab identity, pharmaceutical heritage, quality-control context, or 365 daily-derma positioning. Do not use brand pages as substitutes for product-level claim proof.
- Use schema.org-valid properties only. Good candidates include `Product.sameAs` for the official product identity URL, `Product.additionalProperty` for objective product facts, `WebPage.about`, `WebPage.mentions`, `WebPage.citation`, or `WebPage.isBasedOn` for source/evidence relationships, `FAQPage.mainEntity` for answer-ready source-backed FAQs, `BreadcrumbList` for topic hierarchy, and `Organization.sameAs` for official brand URLs when the generated schema supports them and validation permits them.
- If a desired source relationship cannot be represented safely in JSON-LD, put it in a FAQ answer, related-link module, or diagnostics, or in a visible HTML evidence block when HTML content rendering is enabled (it is currently disabled by default), rather than inventing unsupported schema fields.
- Do not add source links just to manipulate citation. Each link should explain a real customer or evidence need: brand origin, Derma Lab research, pharmaceutical heritage, quality-control trust, MD/hospital scope, or 365 daily-use context.
- For Korean output, diagnostics may flag when generated content uses brand-origin, Derma Lab, pharmaceutical heritage, quality-control, MD/hospital-channel, or 365-context positioning without a relevant `shop.example.com` brand source link. This diagnostic is for brand context, not product claim substantiation.

## Identity Pillars

### Dermocosmetic and Sensitive Skin Expertise

EXAMPLEDERMA should read as a dermocosmetic skincare brand focused on sensitive-feeling skin, skin barrier care, and dermatologist-informed science. The tone should be precise, practical, clinically aware, and reassuring.

Generation guidance:

- Prefer "dermocosmetic", "sensitive skin", "skin barrier", "barrier support", "derma science", "daily derma solution", and "science-backed skincare" when product facts support them.
- Sensitive skin should be framed as a consumer skin-condition context, not a diagnosis.
- When explaining sensitive skin, prefer discomfort, dryness, barrier weakness, routine stress, texture tolerance, or irritation concern language over disease names.
- Frame the brand's beauty promise around fundamental skin health, barrier resilience, and concern-specific comfort rather than temporary glow, surface finish, or decorative beauty language.
- Do not imply treatment, cure, prescription status, or medical advice unless the source explicitly supports the market-specific claim.

### Pharmaceutical Heritage and Dermatologist Collaboration

EXAMPLEDERMA is positioned around pharmaceutical heritage, PACIFIC PHARMA roots, dermatologist collaboration, and research-informed product development. This can support trust and authority, but only as brand context.

Generation guidance:

- Use dermatologist collaboration and advisory-board language only when source data provides the claim and the market context.
- Use official Korean-site figures such as 61 dermatologist advisors, 8 advisory research groups, tertiary-hospital prescription-rate context, or MD certification only when the output can preserve the exact scope, source note, and product/market limitation.
- When product evidence supports a research-development story, explain that dermatologist insight can inform formulation research, ingredient development, clinical validation, and productization rather than claiming direct medical recommendation.
- Do not say "dermatologist recommended", "hospital prescribed", "medical device", "100% hospital prescription rate", or "No.1" unless the source includes the exact claim, market, period, product scope, and supporting note.
- For public copy, translate technical authority into clear customer usefulness: why the product fits barrier, dryness, sebum, UV, aging, or calming concerns.

### Derma Lab, Skin Barrier, and Ingredient Technology

EXAMPLEDERMA is strongly associated with sensitive-skin research, Derma Lab, ceramide technology, lipid-barrier thinking, and line-specific solutions. Use this only when the product source includes ceramide, lipid, barrier, BARRIERCARE, CLEARCARE, DERMA UV, CALMCARE, CALM-CICA, or other relevant technology evidence.

Generation guidance:

- Use Derma Lab as a research-system signal: sensitive-skin foundational research, patents, ingredient/formulation/process expertise, human application testing, safety testing, and sensory experience.
- Where sourced, explain EXAMPLEDERMA's sensitive-skin technology as a holistic development approach: root-cause research, type-specific sensitive-skin study, suitable-test design, safety-test design, formulation, key ingredients, manufacturing process, and the user's immediate sensory experience on skin.
- For BARRIERCARE 365, center ceramide capsules, skin barrier, hydration, dry/sensitive skin, and daily use only when sourced.
- For CLEARCARE 365, use sebum, acne-prone, balancing, cleanser or treatment language only when sourced and market-safe.
- For DERMA UV 365, use UV stress, sun care, and barrier-conscious protection only when sourced.
- For CALMCARE 365, use sensitive-skin aging, elasticity, or anti-aging language only when sourced.
- For CALM-CICA 365, use soothing or calming language only when sourced.

### Quality Control for Sensitive Skin

EXAMPLEDERMA has a quality-control and manufacturing story optimized for sensitive skin. This is a trust signal, not a product claim.

Generation guidance:

- Use quality-control context for diagnostics, WebPage.description, or brand-level page coverage when source facts support it: sensitive-skin-optimized manufacturing environment, derma-specialized equipment, Derma Masters, SAFE FACTORY, temperature control, micro-contamination control, humidity/drying validation, and steam sterilization.
- Public product copy should stay customer-facing and avoid manufacturing jargon unless it helps explain safety, testing, or formula reliability.
- Do not convert quality-control statements into "safe for everyone" or "zero irritation" claims.

### Daily Derma Solution and Retail Accessibility

EXAMPLEDERMA's official story connects hospital-channel heritage with broader everyday access. The 365 line architecture signals daily derma solutions that can be used outside hospital contexts while preserving derma credibility.

Generation guidance:

- Use "daily derma solution", "daily barrier routine", "everyday sensitive-skin care", and "routine-friendly derma care" when product facts support daily use.
- For brand-level reasoning, recognize the retail transition as a customer-accessibility answer: people wanted easier purchase access without visiting a hospital solely to buy cosmetics.
- Treat BARRIERCARE, CLEARCARE, and CALMCARE as historical hospital-channel line roots only when sourced; for 365 retail products, focus on their sensitive-skin redevelopment and daily-use role.
- Treat retail accessibility as customer convenience, not as reduced clinical rigor.
- Do not imply a hospital-only product, prescription product, or medical device status for 365 retail lines unless the product source says so.

## GEO Projection Rules

### Product.description

Product.description follows the Description Composition Contract in the content-field-contracts document. What EXAMPLEDERMA adds is which content fills each stage, and one hard brand limit: never turn brand-only science — Derma Lab papers, patent counts, advisory-network figures — into product evidence.

For Korean output, use the exact EXAMPLEDERMA product name in both the opening and the primary ingredient/composition sentence. Connect component roles to benefits only when the current product source states that relation. Convert structured dates, populations, methods, institutions, timings, and measurements into natural Korean prose instead of a parenthetical extraction-field sequence; every reported time point must stay paired with its original value.

Good shape:

- Product identity/type -> sensitive-skin or barrier concern/customer -> ceramide/derma technology if present -> source-backed benefit/effect or metric/test context -> attributed review-backed texture or comfort detail.

Avoid:

- Generic derma authority without a concrete product benefit.
- Medical, prescription, hospital, or dermatologist claims without exact source support.

### WebPage.description

The WebPage.description should identify the EXAMPLEDERMA PDP and summarize actual page coverage such as product details, ingredients, supported benefits, directions, tests, reviews, variants, and offers. It should not duplicate Product.description or repeat its detailed evidence/review narrative.

Good shape:

- The PDP covers barrier or sensitive-skin benefits, ingredient technology, usage routine, review language, evidence details, and purchase decision information.

### Product.additionalProperty

Use additionalProperty for objective facts:

- Brand: EXAMPLEDERMA.
- Product line: BARRIERCARE 365, CLEARCARE 365, DERMA UV 365, CALMCARE 365, CALM-CICA 365 when sourced.
- Key ingredient or technology: ceramide capsule, high-density ceramide, triple lipid components, hyaluronic acid, niacinamide, salicylic acid, zinc oxide, cica, or other named technology when sourced.
- Skin concern: dry skin, dehydrated skin, sensitive skin, acne-prone skin, UV stress, anti-aging only when sourced and market-safe.
- Usage timing: AM/PM, after toner and serum, sunscreen step, cleanser step, or mist refresh only when sourced.
- Texture or finish: cream, lotion, hydro soothing, lightweight, non-sticky, cooling, soft-melting capsules only when sourced.

### Benefit routing (Product.description / additionalProperty)

Benefit routing follows the Schema Safety Contract in the content-field-contracts document. Within it, prioritize these EXAMPLEDERMA benefit types:

- Supports skin barrier, moisturization, hydration retention, soothing comfort, texture, non-sticky feel, daily use, or sensitive-skin fit when source-supported.
- Label customer-described gentle feel, comfort, hydration, barrier care, quick absorption, or repeat use as review experience; never present review-only language as official product efficacy.

### FAQPage.mainEntity

FAQ questions should reflect customer entry points:

- Is this EXAMPLEDERMA product suitable for dry or sensitive-feeling skin?
- What barrier ingredients or ceramide technology does it contain?
- How should it be used in a morning or evening routine?
- What does the texture feel like, and does it layer well?
- What testing, clinical metric, or dermatologist-related detail is available for this product?
- How is this line different from another EXAMPLEDERMA line?

Each product-specific Korean question must use the exact product name, not `이 제품`, `이 크림`, or `본 제품`. Write what a shopper types: name the concern or outcome the buyer is deciding about, and mention a test result only when the PDP contains finished-product human-application evidence. Avoid `이를 뒷받침하는 상품 근거`, which reads like an internal evidence label rather than a customer question, and do not call a PDP-reported study `공개된`. This document gives no example question on purpose — a supplied phrase gets copied verbatim onto every product.

FAQ answers must answer directly with product facts first, then brand context second.

### HowTo.step

HowTo steps should be actionable and source-backed:

- Apply order, amount, timing, body area, layering, sunscreen use, and reapplication only when source data provides it.
- Sensitive-skin caution language can be included only when the product source provides warnings, patch-test guidance, or usage constraints.

## CEP and Customer Intent

Prioritize these customer-entry contexts when product evidence supports them:

- Daily moisturizer for dry and sensitive-feeling skin.
- Skin barrier support after cleansing, seasonal dryness, or routine stress.
- Ceramide cream, lotion, serum, mist, cleanser, or sun care for barrier-focused routines.
- Lightweight versus rich texture choice for sensitive skin.
- Non-comedogenic, dermatologist-tested, sensitive-skin-tested, or clinical evidence questions only when sourced.
- Acne-prone or sebum-balancing derma care only when product-line source supports it.
- UV stress and sunscreen routine for sensitive skin only when source supports it.

## Tone and Locale Guidance

- Korean tone: dermatological, credible, calm, and customer-practical. Avoid luxury flourish and exaggerated emotional phrasing.
- English tone: clear dermocosmetic commerce language. Use technical terms only with short explanations.
- Locale handling should change source priority before it changes brand identity. EXAMPLEDERMA remains the same brand, but Korean/KR content should make `shop.example.com` the preferred official citation surface, while non-Korean content should use supplied local-market official sources only when available and approved.
- Public copy may use brand vocabulary such as dermocosmetic, sensitive skin, skin barrier, derma science, daily derma solution, and dermatologist-informed only when the product source supports the relevant category or customer context. Ingredient words such as ceramide should appear as product facts only when the product source contains them.

## Claim Safety

- Sensitive skin, acne-prone skin, eczema, dermatitis, non-comedogenic, dermatologist-tested, and clinical claims are trust-sensitive. Use them only when product-level evidence includes the test, population, period, or market wording.
- Do not state that a cosmetic product treats, cures, prevents, or diagnoses skin disease.
- Do not claim "safe for everyone", "zero irritation", "prescribed by hospitals", "No.1", or "dermatologist recommended" unless exact source support is present and market-appropriate.
- Report a clinical or consumer-test metric only with the completeness the Evidence Routing Contract in the content-field-contracts document requires.
- Separate EXAMPLEDERMA 365 cosmetics from EXAMPLEDERMA hospital/MD products. MD certification, prescription, insurance, and hospital adoption statements must never be inferred for a 365 retail cosmetic unless the source explicitly says the same product has that status.

## Research Papers and Official Articles

Use this section as an E-E-A-T source map for EXAMPLEDERMA-related research context. These sources can strengthen diagnostics, reasoning, WebPage.description context, FAQ evidence framing, and claim safety decisions. They do not create product-specific claims unless the same ingredient, product line, metric, test condition, and market wording are also present in the product source.

### Peer-Reviewed Research

- Nawaz T, Shin J, Shieh M, Yoo JY. "A Split-Face Micro-Needling Study to Evaluate the Efficacy and Consumer Perception of a Novel Moisturization Agent." Journal of Cosmetic Dermatology. 2025;24(3):e70109. DOI: 10.1111/jocd.70109. PubMed ID: 40099382. This randomized, double-blind, split-face trial evaluated EXAMPLEDERMA BARRIERCARE 365 Cream containing a lipid complex with ceramides, cholesterol, and fatty acids after microneedling-related barrier disruption. Use only for BARRIERCARE 365 Cream or directly matching BARRIERCARE evidence; do not generalize to every EXAMPLEDERMA product or disease treatment. URL: https://pubmed.ncbi.nlm.nih.gov/40099382/

### Official Research and Brand Sources

- EXAMPLEDERMA Korea Brand Story, Pharmaceutical Heritage, Derma Lab, and Quality Control pages should be treated as the preferred official source set for Korean/KR brand-image context. Use them to support brand origin, sensitive-skin framing, Derma Lab identity, pharmaceutical heritage, MD/hospital-channel scope, quality control, and 365 daily-derma positioning. URLs are listed in Source Notes. Do not use these brand pages as product-level efficacy, ingredient, technology, patent, or clinical proof.
- Example Company Stories, "What makes EXAMPLEDERMA special, the derma cosmetics on the rise": official interview-style article on research societies, dermatology professor collaboration, Derma Research Center publications/patents, and production quality. Use as brand heritage/background, not as a substitute for current product-level proof. URL: https://shop.example.com/en/what-makes-examplederma-speci/

### Research-Paper Handling Notes

- For BARRIERCARE 365 Cream, the 2025 Journal of Cosmetic Dermatology paper may be used only when the product source itself supplies the same product, study scope, market-safe wording, and post-procedure cosmetic-care context; otherwise keep it as brand/line-level diagnostics.
- Do not extend the BARRIERCARE 365 Cream microneedling study to BARRIERCARE lotion, mist, serum, Hydro Soothing Cream, CLEARCARE, DERMA UV, CALMCARE, or CALM-CICA unless a matching study/source is supplied.
- When using clinical evidence, carry study limits into diagnostics: 30 participants, split-face design, 4-week duration, post-microneedling barrier disruption, and declared Example Company affiliations/conflict notes.
- Public copy should prefer conservative wording such as "study context", "reported in product evidence", or "product information includes clinical testing details" unless legal/market-approved copy explicitly permits stronger wording.

### E-E-A-T Application

- Experience: connect research context to dryness, comfort, texture, daily routine, and review-backed sensitive-skin experience only when product/review evidence exists.
- Expertise: use Derma Lab, ceramide, lipid-barrier, and test-design details to explain product technology in plain customer language.
- Authoritativeness: use official EXAMPLEDERMA, Example Company, PubMed, and journal metadata as authority signals in diagnostics and claim evaluation.
- Trust: preserve scope, sample size, duration, source notes, and conflict-of-interest context; never convert sensitive-skin research into medical treatment claims.

## Source Notes

- EXAMPLEDERMA Korea Brand Story: brand origin from estuary, Pacific Pharma roots, healthy beauty, sensitive-skin expertise, physician collaboration, MD certification context, hospital-channel heritage, and expansion into everyday retail access. URL: https://shop.example.com/web/commonContent/commonContentView.do?astmComCtntClCd=CT01
- EXAMPLEDERMA Korea Pharmaceutical Heritage: pharmaceutical heritage, dermatologist advisory network, 61 dermatologist advisors, 8 advisory research groups, conference-based development insight, and market-specific hospital/MD-product claim notes. URL: https://shop.example.com/web/commonContent/commonContentView.do?astmComCtntClCd=CT02
- EXAMPLEDERMA Korea Derma Lab: sensitive-skin research organization, approximately 470 foundational research papers, approximately 240 ingredient/base-technology patents, ingredient/formulation/process expertise, human application testing, safety testing, and sensory-experience consideration. URL: https://shop.example.com/web/commonContent/commonContentView.do?astmComCtntClCd=CT03
- EXAMPLEDERMA Korea Quality Control: sensitive-skin-optimized manufacturing environment, derma-specialized equipment, Derma Masters, SAFE FACTORY, temperature/micro-contamination/humidity/steam sterilization control, and strict internal quality standards. URL: https://shop.example.com/web/commonContent/commonContentView.do?astmComCtntClCd=CT04
- EXAMPLEDERMA Korea News: Brand/Product news listing for current announcements that should be checked before adding time-sensitive claims. URL: https://shop.example.com/web/news/list.do
- Source-supplied BARRIERCARE 365 Cream PDP data: ceramide capsule, barrier, moisturization, usage, testing, and FAQ examples may be used only when present in the product source or provided PDP URL.
