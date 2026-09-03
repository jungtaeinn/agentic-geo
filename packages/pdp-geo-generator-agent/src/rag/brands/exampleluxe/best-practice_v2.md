# ExampleLuxe Best Practice v2

This brand-scoped best practice extends the default best-practice document for ExampleLuxe PDP GEO generation. Use this document only when the normalized product brand, hint, or product name maps to ExampleLuxe / 예시럭셔리. This document is a brand overlay. The default best-practice document stays loaded alongside it; rules here extend or override the base only where stated.

## Brand-Specific Best Practice Overlay

ExampleLuxe output should preserve the default field evidence contract while adding the brand's distinctive quality bar. This overlay applies across `Product.description` and `WebPage.description` composition, ingredient and formula claim wording, FAQ and HowTo generation, and public claim safety:

- Anchor public content in heritage, Korean ginseng science, skin longevity, craftsmanship, and premium ritual language only when product/source facts support those topics.
- Prefer calm, authoritative, sensorial phrasing over aggressive performance copy. The product should feel researched, refined, and ritual-ready, not trend-led.
- Tie ingredient and technology claims only to current product-source details such as ginseng actives, BOTANICAL Activator, formulation expertise, and clinical/reported results when those details appear in the product evidence. Use the matched brand identity document for heritage mood, ritual vocabulary, sensory refinement, and brand image; do not use brand-only official articles, patents, or papers as product proof.
- Build FAQ and HowTo around discovery questions a premium skincare customer would ask: routine order, texture, age-related concerns, skin resilience, ingredient trust, giftability, and day/night use.
- Keep claim safety strict. Do not imply medical treatment, permanent anti-aging reversal, disease prevention, or clinical certainty unless the supplied product source explicitly supports it.
- ExampleLuxe US output is `en-US`: write public descriptions, FAQ, and HowTo in natural US English even when Korean source material or Korean brand RAG is retrieved. Preserve official English product, ingredient, technology, and study names when available.
- Name the exact product in the opening and again in the main ingredient/composition sentence so an extracted sentence remains attributable. Do not use `this product`, `this cream`, or `this serum` as the identity anchor in a product-specific FAQ.
- Convert structured study facts into fluent English that preserves the institution, date range, complete population, method, and every timing-to-value pair. A PDP-reported result may be called a `reported clinical study result`; use `published` or `peer-reviewed` only when an actual cited publication supports that status.

## ExampleLuxe US BestPractice Tone

Use refined, assured US English that feels premium without becoming ornate. The copy should connect the supported customer concern, formula, finished-product benefit, clinical proof, and customer experience as one considered explanation rather than a translated field list.

- Open with a clear product and customer-context statement, then use polished but plain English to explain selected formula elements and their explicitly supported roles.
- Let premium tone come from precise word choice, balanced cadence, and confident evidence handling—not from superlatives, heritage claims, or decorative language unsupported by the current product source.
- Keep clinical evidence readable: state shared study context once, connect every value to its timing or comparison, and preserve qualifiers without a parenthetical data dump.
- Use sensory review language only when attributed to customers, and close in an experience-led voice such as what customers value or highlight rather than a passive list of mentioned keywords.
- Prefer idiomatic US transitions and sentence rhythm over literal Korean-to-English structure, while preserving product names, ingredient names, dates, values, and claim scope.
- Generate each sentence anew from the current product's CEP and evidence. Do not copy examples or impose one repeated ExampleLuxe sentence template.

## ExampleLuxe Clinical Wording Boundaries

Brand-specific rules for wording ExampleLuxe clinical and reported-result evidence in US English. These extend the base document's Product.description and Schema.org + GEO Description Direction guidance where they overlap.

- When a metric contains multiple time points, write a sentence such as `In a clinical study conducted by [institution] from [start date] to [end date] involving [population], [metric] was measured at [value] before use, [value] immediately after use, and [value] 12 hours after use.` Do not expose `timing`, `sample`, `period`, `method`, or `institution` as a parenthetical field dump.
- Do not imply that a PDP-reported test is a published or peer-reviewed study. Use `reported clinical study results` unless an actual cited publication supports the `published` or `peer-reviewed` status.

## ExampleLuxe US FAQ Question Patterns

Brand-specific US English FAQ phrasing rules. These extend the base document's FAQ Best Practice guidance.

- Efficacy FAQ questions must name the exact product — never `this product`, `this cream`, or `this serum` — and must read as something a shopper types. Give the question these properties rather than a wording to copy: it names the product, it names the concern or outcome the buyer is deciding about, and it mentions a test result only when finished-product clinical evidence exists. Never phrase it as a request for the internal evidence record (`what product evidence supports them?`) — that exposes the pipeline's sourcing apparatus instead of asking what a buyer asks. Do not call a PDP-reported study `published` or `peer-reviewed`; reserve those for an actual bibliographic citation. No example wording appears here on purpose: a supplied phrase gets copied verbatim into every product's FAQ, which is how one audit-sounding question ended up on every page.
- Include evidence-backed CEP questions US customers may ask ChatGPT, Gemini, or Perplexity: which moisturizer suits winter dryness, which product fits a mature-skin or gift-recipient need, where the product belongs in a routine, whether the texture is rich or lightweight, and which ExampleLuxe option fits a stated concern. These are recommendation-shaped discovery questions, not permission to invent age suitability, seasonality, giftability, comparisons, or efficacy. Answers must lead with current product facts and explicitly attribute review-derived experience.
