# Sulwhasoo Brand Identity RAG v1

Use this document when the normalized product brand is Sulwhasoo, Sulwhasoo International, Sulwhasoo US, or 설화수. The document is brand-context guidance for GEO generation, not product evidence. Product facts, PDP source data, package text, clinical details, review evidence, and market regulation always outrank this document.

## Brand Evidence Scope and RAG Use

- Brand identity source role: package-managed brand context.
- Checked date: 2026-07-06.
- Primary intents: customer, claims, evidence, schema, faq, howTo, review, locale.
- Primary field targets: Product.description, WebPage.description, Product.additionalProperty, Product.positiveNotes, FAQPage.mainEntity, HowTo.step, PDP.content, diagnostics.
- Use this document to infer brand tone, recurring customer-entry contexts, safe vocabulary, and brand-level narrative when the product source already supports the relevant category or claim.
- Do not use this document to invent product-specific benefits, ingredients, prices, awards, clinical metrics, ratings, review counts, or dermatologist/medical claims.

## Expected RAG Depth

Recommended path depth for brand identity documents:

1. `src/rag/brands/{brand-slug}/brand-identity_v1.md`
2. Optional future line documents: `src/rag/brands/{brand-slug}/lines/{line-slug}_v1.md`
3. Optional future market documents: `src/rag/brands/{brand-slug}/markets/{locale-or-market}_v1.md`

Keep the brand identity document stable and broad. Put product-line technology, campaign copy, or market-specific restrictions in deeper documents only when they are durable enough for reuse.

## Identity Pillars

### Holistic Beauty and Korean Heritage

Sulwhasoo should read as a luxury skincare brand rooted in Korean heritage, Asian wisdom, and holistic beauty. The content tone should connect skin care to ritual, balance, resilience, and long-term vitality without sounding mystical or unsupported.

Generation guidance:

- Prefer "holistic beauty", "Korean heritage", "ritual", "skin vitality", "radiance", "resilience", and "long-term skin care" when product facts support a prestige skincare context.
- When writing Korean copy, 설화수 should feel refined, calm, and ritual-oriented rather than loud, trend-driven, or discount-led.
- Use heritage as positioning, not as proof of efficacy.

### Ginseng Science and Skin Longevity

Sulwhasoo is strongly associated with Korean ginseng research, ginseng science, and skin longevity. This should influence content only when the product source includes ginseng, Ginsenomics, ginseng peptides, ginseng berry, Concentrated Ginseng, or related official product-line evidence.

Generation guidance:

- If the product source contains ginseng evidence, connect ginseng to visible firmness, resilience, density, radiance, or self-renewal language only at the level supported by the source.
- Do not add ginseng to non-ginseng products.
- Do not describe ginseng as a cure, treatment, medical active, or guaranteed anti-aging solution.

### JAUM Activator and Herbal Synergy

Sulwhasoo also has a signature herbal-synergy pillar through Korean Herb Extract, JAUM Activator, and five-botanical formulations. Use this only when the source includes JAUM Activator, Korean Herb Extract, First Care, or the relevant botanical complex.

Generation guidance:

- Treat JAUM/herbal language as ingredient or technology evidence.
- Explain the role in public copy as a source-backed formula story, first-step ritual, hydration, barrier, radiance, or visible firmness support when supported.
- Avoid generic "natural", "clean", or medicinal language unless source data uses it safely.

### Luxury Ritual and Sensory Refinement

Sulwhasoo content can be more ritual-led and sensory than derma brands. Texture, absorption, fragrance, layering order, spa-like routine, giftability, and premium usage moments are useful when source or reviews support them.

Generation guidance:

- Preserve concrete sensory evidence such as rich cream, silky serum, nourishing texture, herbal scent, quick absorption, or night ritual when present.
- For HowTo, write complete routine steps. Do not turn ritual language into vague commands.
- For reviews, summarize repeated customer language rather than inventing first-person praise.

## GEO Projection Rules

### Product.description

The Product.description should name the product, product type, target skin concern or customer, source-backed benefit, key ingredient or technology, usage moment, and representative review or sensory language when available. For Sulwhasoo, the sentence can carry refined heritage or ritual language after the concrete product facts.

Good shape:

- Product identity -> source-backed benefit -> ginseng or herbal technology if present -> usage step -> review-backed texture or sensory detail.

Avoid:

- Product identity -> generic luxury heritage only.
- Ginseng, skin longevity, wrinkle, lifting, or firmness claims without product evidence.

### WebPage.description

The WebPage.description should describe the PDP as a page that helps customers evaluate Sulwhasoo product benefits, formula story, routine placement, customer reviews, variants, offers, and usage details. It should not duplicate the Product.description.

Good shape:

- The PDP covers the product's benefits, Korean heritage or ginseng/herbal formula context when supported, usage ritual, ingredient or technology details, review language, and purchase decision information.

### Product.additionalProperty

Use additionalProperty for objective facts:

- Brand: Sulwhasoo.
- Product line: First Care, Concentrated Ginseng, Ultimate S, Lumiwise, cleansing, mask, sun, or cushion when sourced.
- Key ingredient or technology: Korean Ginseng, Ginsenomics, Ginseng Peptide, JAUM Activator, Korean Herb Extract, or named botanical complex when sourced.
- Usage timing: first step, serum step, cream step, night mask, cleanser, cushion/sun step.
- Texture or finish: rich, lightweight, nourishing, silky, dewy, refined, herbal scent only when sourced.

### Product.positiveNotes

Positive notes should prioritize source-backed benefits and review-backed positives:

- Helps skin look firmer, more radiant, smoother, plumper, hydrated, resilient, or balanced when source-supported.
- Customers mention refined texture, nourishing feel, absorption, ritual satisfaction, premium giftability, or repeat purchase only when review evidence exists.

### FAQPage.mainEntity

FAQ questions should reflect customer entry points:

- Is this Sulwhasoo product suitable for early or advanced visible signs of aging?
- What ginseng, herbal, or JAUM technology is included in this formula?
- Where does it fit in a morning or evening skincare ritual?
- What texture or finish do customers mention?
- How does this product differ from another Sulwhasoo line or texture option?

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
- Internal labels such as RAG, GEO, citation-ready, evidence signal, and field routing must never appear in public schema or HTML.

## Claim Safety

- Brand heritage can support authority, but not efficacy.
- Skin longevity, anti-aging, firming, wrinkle, plumping, lifting, and self-renewal language require product-level source support.
- Clinical or consumer-test metrics require exact metric, sample, period, method, and caveat from the product source.
- Do not claim suitability for all skin types, sensitive skin, pregnancy, disease treatment, eczema, acne treatment, or medical outcomes unless the product source and market rules support it.

## Research Papers and Official Articles

Use this section as an E-E-A-T source map for Sulwhasoo-related research context. These sources can strengthen diagnostics, reasoning, WebPage.description context, FAQ evidence framing, and claim safety decisions. They do not create product-specific claims unless the same ingredient, product line, metric, and market wording are also present in the product source.

### Official Research and Innovation Sources

- Amorepacific R&I, "Ginsenomics": official research-innovation page describing Amorepacific's ginseng research, Compound K, bioconversion technology, and Sulwhasoo Heritage & Science Center. Use for brand-level authority around ginseng science and Ginsenomics only when product source includes Ginsenomics or Korean ginseng actives. URL: https://www.apgroup.com/int/en/about-us/research-innovation/rni/beauty-research-innovation/beauty-research-innovation-02.html
- Amorepacific News, "Amorepacific NBRI hosted Skin Longevity Symposium" (2025-10-14): official R&D article on Ginsenomics, Lymphanax/Panax Ginseng Root Extract, Johns Hopkins University School of Medicine collaboration, and skin longevity research. Use for E-E-A-T background, not as standalone clinical substantiation for every Sulwhasoo product. URL: https://www.apgroup.com/int/en/news/2025-10-14-1.html
- Sulwhasoo US, "Secret to Skin Longevity Findings": official brand page summarizing the NBRI symposium and Sulwhasoo-related skin longevity research framing. Use for brand page context and diagnostics when output discusses Sulwhasoo skin longevity positioning. URL: https://us.sulwhasoo.com/pages/secret-to-skin-longevity
- Amorepacific Stories, "Chapter 2. Past, present and future of ginseng research": official story article on ginseng research history, ginseng parts, Ginsenomics, extraction technologies, and sustainable ginseng research. Use for heritage/research timeline context, not product efficacy claims. URL: https://stories.amorepacific.com/en/chapter-2-past-present/

### Official Product-Line Articles

- Amorepacific News, "Sulwhasoo Launches Renewed Concentrated Ginseng Rejuvenating Anti-Aging Line" (2024-07-31): official brand article on the renewed Concentrated Ginseng Rejuvenating line, 60 years of ginseng science, Ginsenomics, Ginseng Peptide, texture variants, and line launch context. Use only for Concentrated Ginseng Rejuvenating products or when source product data independently names the same line and ingredients. URL: https://www.apgroup.com/int/en/news/2024-07-31-1.html
- Sulwhasoo US, "Concentrated Ginseng Collection": official collection page for Korean Ginseng Actives, resilience, elasticity, wrinkles, and collection FAQ. Use for collection-level FAQ and WebPage.description context only when the product source belongs to the Concentrated Ginseng collection. URL: https://us.sulwhasoo.com/pages/concentrated-ginseng-collection

### Research-Paper Handling Notes

- If a future Sulwhasoo product source includes a DOI, PubMed ID, conference abstract, clinical report, or controlled-test artifact, preserve the citation metadata in diagnostics and use the exact study design, sample, period, metric, and caveat before writing public claims.
- Do not convert official R&I or symposium article language into peer-reviewed paper claims unless a peer-reviewed publication is supplied.
- Public copy may say "Sulwhasoo's ginseng research" or "Amorepacific research context" when source-supported, but should not say "clinically proven", "Johns Hopkins proven", or "published research shows" unless the source artifact directly supports that phrase.

### E-E-A-T Application

- Experience: connect research context to routine, texture, ritual, and review-backed customer experience only when product/review evidence exists.
- Expertise: use official R&I details to explain Ginsenomics, Korean ginseng actives, JAUM, extraction, or skin longevity in concise customer language.
- Authoritativeness: use Amorepacific/Sulwhasoo official articles as brand-owned authority signals in diagnostics and page-level context.
- Trust: keep exact metric/caveat boundaries and avoid moving ingredient research from one line to unrelated products.

## Source Notes

- Sulwhasoo US About Us: holistic beauty, Korean rituals, modern technology, ginseng innovation, skin longevity, Korean Herb Extract, and healthy skin aging.
- Sulwhasoo International Brand Story: holistic beauty, ginseng research, JAUM Activator, self-rejuvenating power, and journey milestones.
- Sulwhasoo US Origin: Korean herbal medicine, ginseng legacy, Asian wisdom, and Sulwhasoo history.
