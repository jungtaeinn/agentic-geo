# ExampleLuxe Brand Identity RAG v1

Use this document when the normalized product brand is ExampleLuxe, ExampleLuxe International, ExampleLuxe US, or 예시럭셔리. The document is brand-context guidance for GEO generation, not product evidence. Product facts, PDP source data, package text, clinical details, review evidence, and market regulation always outrank this document.

## Brand Evidence Scope and RAG Use

- Brand identity source role: package-managed brand context.
- Checked date: 2026-07-06.
- Primary intents: customer, schema, review, locale, diagnostics.
- Primary field targets: Product.description, WebPage.description, PDP.content, diagnostics.
- Use this document to infer brand image, brand tone, recurring customer-entry contexts, safe vocabulary, mood, personality, and brand-level narrative when the product source already supports the relevant category or claim.
- Do not use this document to invent product-specific benefits, ingredients, technologies, prices, awards, clinical metrics, ratings, review counts, official-paper-backed efficacy claims, or dermatologist/medical claims.

## Expected RAG Depth

Recommended path depth for brand identity documents:

1. `src/rag/brands/{brand-slug}/brand-identity_v1.md`
2. Optional future line documents: `src/rag/brands/{brand-slug}/lines/{line-slug}_v1.md`
3. Optional future market documents: `src/rag/brands/{brand-slug}/markets/{locale-or-market}_v1.md`

Keep the brand identity document stable and broad. Put product-line technology, campaign copy, or market-specific restrictions in deeper documents only when they are durable enough for reuse.

## Identity Pillars

### Holistic Beauty and Korean Heritage

ExampleLuxe should read as a luxury skincare brand rooted in Korean heritage, Asian wisdom, and holistic beauty. The content tone should connect skin care to ritual, balance, resilience, and long-term vitality without sounding mystical or unsupported.

Generation guidance:

- Prefer "holistic beauty", "Korean heritage", "ritual", "skin vitality", "radiance", "resilience", and "long-term skin care" when product facts support a prestige skincare context.
- When writing Korean copy, 예시럭셔리 should feel refined, calm, and ritual-oriented rather than loud, trend-driven, or discount-led.
- Use heritage as positioning, not as proof of efficacy.

### Ginseng Science and Skin Longevity

ExampleLuxe is strongly associated with Korean ginseng research, ginseng science, and skin longevity. This should influence content only when the product source includes ginseng, Botanical Complex, ginseng peptides, ginseng berry, Botanical Renewal, or related official product-line evidence.

Generation guidance:

- If the product source contains ginseng evidence, connect ginseng to visible firmness, resilience, density, radiance, or self-renewal language only at the level supported by the source.
- Do not add ginseng to non-ginseng products.
- Do not describe ginseng as a cure, treatment, medical active, or guaranteed anti-aging solution.

### BOTANICAL Activator and Herbal Synergy

ExampleLuxe also has a signature herbal-synergy pillar through Korean Herb Extract, BOTANICAL Activator, and five-botanical formulations. Use this only when the source includes BOTANICAL Activator, Korean Herb Extract, Essential Care, or the relevant botanical complex.

Generation guidance:

- Treat BOTANICAL/herbal language as ingredient or technology evidence.
- Explain the role in public copy as a source-backed formula story, first-step ritual, hydration, barrier, radiance, or visible firmness support when supported.
- Avoid generic "natural", "clean", or medicinal language unless source data uses it safely.

### Luxury Ritual and Sensory Refinement

ExampleLuxe content can be more ritual-led and sensory than derma brands. Texture, absorption, fragrance, layering order, spa-like routine, giftability, and premium usage moments are useful when source or reviews support them.

Generation guidance:

- Preserve concrete sensory evidence such as rich cream, silky serum, nourishing texture, herbal scent, quick absorption, or night ritual when present.
- For HowTo, write complete routine steps. Do not turn ritual language into vague commands.
- For reviews, summarize observed customer language rather than inventing first-person praise; describe it as repeated only when multiple reviews support that statement.

## GEO Projection Rules

### Product.description

Product.description follows the Description Composition Contract in the content-field-contracts document. What ExampleLuxe adds is which content fills each stage, and one hard brand limit: never turn brand-only science — ginseng research articles, R&I symposium material, heritage milestones — into product evidence.

For the US market, write in natural `en-US`. Use the exact ExampleLuxe product name in both the opening and the primary ingredient/composition sentence, then continue without keyword-heavy repetition. Link an ingredient to an outcome only when the current product source states the relation. Render structured institution, date, population, method, timing, and measurement fields as fluent English while preserving every timing-to-value pair. `Reported clinical study results` is appropriate for PDP-reported finished-product evidence; `published` or `peer-reviewed` requires a real cited publication.

Good shape:

- Product identity/type -> target skin concern or customer -> ginseng or herbal technology if present -> source-backed benefit/effect or metric/test context -> attributed review-backed texture or sensory detail.

Avoid:

- Product identity -> generic luxury heritage only.
- Ginseng, skin longevity, wrinkle, lifting, or firmness claims without product evidence.

### WebPage.description

The WebPage.description should identify the ExampleLuxe PDP and summarize actual page coverage such as product details, formula information, directions, reviews, variants, and offers. Separately supported brand heritage may be mentioned at page level, but the description must not duplicate Product.description.

Good shape:

- The PDP covers the product's benefits, Korean heritage or ginseng/herbal formula context when supported, usage ritual, ingredient or technology details, review language, and purchase decision information.

### Product.additionalProperty

Use additionalProperty for objective facts:

- Brand: ExampleLuxe.
- Product line: Essential Care, Botanical Renewal, Ultimate S, Lumiwise, cleansing, mask, sun, or cushion when sourced.
- Key ingredient or technology: Korean Ginseng, Botanical Complex, Ginseng Peptide, BOTANICAL Activator, Korean Herb Extract, or named botanical complex when sourced.
- Usage timing: first step, serum step, cream step, night mask, cleanser, cushion/sun step.
- Texture or finish: rich, lightweight, nourishing, silky, dewy, refined, herbal scent only when sourced.

### Benefit routing (Product.description / additionalProperty)

Benefit routing follows the Schema Safety Contract in the content-field-contracts document. Within it, prioritize these ExampleLuxe benefit types:

- Helps skin look firmer, more radiant, smoother, plumper, hydrated, resilient, or balanced when source-supported.
- Label customer-described texture, nourishing feel, absorption, ritual satisfaction, premium giftability, or repeat purchase as review experience; never present review-only language as official product efficacy.

### FAQPage.mainEntity

FAQ questions should reflect customer entry points:

- Is this ExampleLuxe product suitable for early or advanced visible signs of aging?
- What ginseng, herbal, or BOTANICAL technology is included in this formula?
- Where does it fit in a morning or evening skincare ritual?
- What texture or finish do customers mention?
- How does this product differ from another ExampleLuxe line or texture option?

Every product-specific US English question must name the exact product rather than `this product`, `this cream`, or `this serum`. If finished-product clinical evidence exists, ask `What are the main benefits of [Product name], and what do the reported clinical study results show?`; otherwise ask `What are the main benefits of [Product name]?`. Avoid `what product evidence supports them?` because it sounds like an internal evidence audit rather than a natural customer question.

FAQ answers must answer directly with product facts first, then brand context second.

### HowTo.step

HowTo steps should be actionable and source-backed:

- Apply order, amount, body area, timing, and pairing with toner/serum/cream/sunscreen only when source data provides it.
- Brand ritual language can soften the wording, but the step must remain a concrete instruction.

## CEP and Customer Intent

Prioritize these customer-entry contexts when product evidence supports them:

- Luxury Korean skincare routine.
- Ginseng skincare for visible firmness, resilience, plumpness, or radiance.
- First-step serum or ritual preparation before the rest of skincare.
- Rich cream or serum for visible signs of aging.
- Premium gift, self-care ritual, or high-touch skincare experience.
- Heritage ingredient story with modern skin science.
- Texture choice: rich versus lightweight, day versus night, serum versus cream.

## Tone and Locale Guidance

- Korean tone: refined, composed, precise, ritual-aware. Avoid exaggerated urgency, slang, and hard-sell wording.
- English tone: luxury skincare editorial with clear product facts. Avoid mystical overreach.
- Public copy may use brand vocabulary such as holistic beauty, ginseng science, skin longevity, heritage, ritual, radiance, resilience, and self-renewal only when grounded by the product source.

## Claim Safety

- Brand heritage can support authority, but not efficacy.
- Skin longevity, anti-aging, firming, wrinkle, plumping, lifting, and self-renewal language require product-level source support.
- Report a clinical or consumer-test metric only with the completeness the Evidence Routing Contract in the content-field-contracts document requires.
- Do not claim suitability for all skin types, sensitive skin, pregnancy, disease treatment, eczema, acne treatment, or medical outcomes unless the product source and market rules support it.

## Research Papers and Official Articles

Use this section as an E-E-A-T source map for ExampleLuxe-related brand image and research context. These sources can strengthen diagnostics, brand-level reasoning, WebPage.description tone, and claim safety decisions. They do not create product-specific claims, FAQ evidence, Product.additionalProperty facts, or ingredient/technology proof unless the same ingredient, product line, metric, and market wording are also present in the product source.

### Official Research and Innovation Sources

- Example Company R&I, "Botanical Complex": official research-innovation page describing Example Company's ginseng research, Compound K, bioconversion technology, and ExampleLuxe Heritage & Science Center. Use for brand-level authority around ginseng science and Botanical Complex only when product source includes Botanical Complex or Botanical Actives. URL: https://www.example.com/int/en/about-us/research-innovation/rni/beauty-research-innovation/beauty-research-innovation-02.html
- Example Company News, "Example Company NBRI hosted Skin Longevity Symposium" (2025-10-14): official R&D article on Botanical Complex, Lymphanax/Panax Ginseng Root Extract, Johns Hopkins University School of Medicine collaboration, and skin longevity research. Use for E-E-A-T background, not as standalone clinical substantiation for every ExampleLuxe product. URL: https://www.example.com/int/en/news/2025-10-14-1.html
- ExampleLuxe US, "Secret to Skin Longevity Findings": official brand page summarizing the NBRI symposium and ExampleLuxe-related skin longevity research framing. Use for brand page context and diagnostics when output discusses ExampleLuxe skin longevity positioning. URL: https://us.exampleluxe.com/pages/secret-to-skin-longevity
- Example Company Stories, "Chapter 2. Past, present and future of ginseng research": official story article on ginseng research history, ginseng parts, Botanical Complex, extraction technologies, and sustainable ginseng research. Use for heritage/research timeline context, not product efficacy claims. URL: https://stories.example-company.com/en/chapter-2-past-present/

### Official Product-Line Articles

- Example Company News, "ExampleLuxe Launches Renewed Botanical Renewal Anti-Aging Line" (2024-07-31): official brand article on the renewed Botanical Renewal line, 60 years of ginseng science, Botanical Complex, Ginseng Peptide, texture variants, and line launch context. Use only for Botanical Renewal products or when source product data independently names the same line and ingredients. URL: https://www.example.com/int/en/news/2024-07-31-1.html
- ExampleLuxe US, "Botanical Renewal Collection": official collection page for Botanical Actives, resilience, elasticity, wrinkles, and collection FAQ. Use for collection-level FAQ and WebPage.description context only when the product source belongs to the Botanical Renewal collection. URL: https://us.exampleluxe.com/pages/concentrated-ginseng-collection

### Research-Paper Handling Notes

- If a future ExampleLuxe product source includes a DOI, PubMed ID, conference abstract, clinical report, or controlled-test artifact, preserve the citation metadata in diagnostics and use the exact study design, sample, period, metric, and caveat before writing public claims.
- Do not convert official R&I or symposium article language into peer-reviewed paper claims unless a peer-reviewed publication is supplied.
- Public copy may use brand-image wording such as "ExampleLuxe's ginseng heritage" or "ginseng research-inspired brand context" when product context supports ginseng positioning, but should not say "clinically proven", "Johns Hopkins proven", "published research shows", or use an official article/paper as product proof unless the product source artifact directly supports that phrase.

### E-E-A-T Application

- Experience: connect research context to routine, texture, ritual, and review-backed customer experience only when product/review evidence exists.
- Expertise: use official R&I details as brand-level science image and vocabulary. Explain Botanical Complex, Botanical Actives, BOTANICAL, extraction, or skin longevity as product facts only when the product source itself names them.
- Authoritativeness: use Example Company/ExampleLuxe official articles as brand-owned authority signals in diagnostics and brand-level page context, not as direct product claim proof.
- Trust: keep exact metric/caveat boundaries and avoid moving ingredient research from one line to unrelated products.

## Source Notes

- ExampleLuxe US About Us: holistic beauty, Korean rituals, modern technology, ginseng innovation, skin longevity, Korean Herb Extract, and healthy skin aging.
- ExampleLuxe International Brand Story: holistic beauty, ginseng research, BOTANICAL Activator, self-rejuvenating power, and journey milestones.
- ExampleLuxe US Origin: Korean herbal medicine, ginseng legacy, Asian wisdom, and ExampleLuxe history.
