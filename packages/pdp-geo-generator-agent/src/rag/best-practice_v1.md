# Best Practice v1

This document is project-local guidance for generating GEO-ready PDP schema markup and PDP content. Treat examples as structural patterns, not phrases to copy.

If the source example is written in Korean but the requested output locale is English, Japanese, or another locale, preserve the information architecture and evidence hierarchy while rewriting the actual text in the target locale. The generator should adapt brand terms, customer expressions, category names, ingredient names, and benefit wording to the locale-specific terminology guide.

## RAG Corpus Orchestration

Use the typed RAG index as the first-pass map for deciding which content unit should be retrieved. This document should be selected when the generator needs overlap resolution, public wording rules, benchmark depth, OCR/source blending, FAQ intent breadth, source-faithful HowTo eligibility, or product/entity description separation.

Content-unit priority:

1. Use Schema.org Product Markup for strict JSON-LD type and property compatibility.
2. Use E-E-A-T Guidance for trust, source hierarchy, and overclaim filtering.
3. Use CEP Guidance for customer discovery phrasing only when source facts support the customer context.
4. Use GEO Research Guidance for answer-ready structure, citation readiness, and domain-specific evaluation.
5. Use Official AI and Search Platform Docs for retrieval, grounding, and Google AI Search constraints.
6. Use Locale Expression Guidelines and the terminology map before final public wording.
7. Use this Best Practice file to reconcile conflicts and translate the combined guidance into product-page output.

When policies overlap, choose the stricter source-backed rule and keep the decision visible in diagnostics. Never let a benchmark artifact override current product data.

## Core Principle

GEO output should make the product easier to retrieve, understand, verify, and reuse from visible, evidence-rich facts. It cannot guarantee selection or citation. Citation readiness means varied, natural product expressions and complete facts, not public citation labels, quote phrases, or repeated stock claim sentences.

- Prefer product-specific facts over generic SEO claims.
- Treat ChatGPT Search, Gemini grounding, and Google AI Search as retrieval-and-citation environments: they reward crawlable, visible, source-backed content units, not hidden AI-only instructions or artificial markup tricks.
- Compose `Product.description` as a six-part buyer-answer narrative: product introduction/type + target customer and concern/CEP + ingredient or technology composition + supported finished-product benefit/effect + source-stated research or related-article citation + attributed positive or neutral review keywords last. Parse source-stated dates, publisher/title, findings, and numbers into natural prose without changing values or inventing missing metadata.
- Never expose internal wording such as "GEO-ready", "PDP name", "schema optimization", or "for generative engines" inside public schema/content.
- Do not use analysis labels such as "usage", "review", "benefit", or "keyword" as product category values.
- Do not create FAQ, review, or HowTo content from isolated tokens. Use complete questions, answers, review summaries, and actionable usage steps.

## Public Wording Guardrails

Public JSON-LD values and PDP content should read like customer-facing product information, not internal optimization notes.

- Do not expose internal labels such as "evidence signal", "review signals", "main benefit signal", "ingredient signal", "technology signals", "GEO", "RAG", "schema optimization", or "citation optimization".
- Make the public sentence subject the product, ingredient/technology, benefit, usage action, review pattern, option, or customer concern. Do not make "evidence", "source material", "product page", "product details", "usage guidance", "context", "information", or the generation process the subject unless the user-facing question is explicitly about a document/source.
- Prefer direct public wording such as "the formula includes", "customer reviews highlight", "customers describe", "the product is suitable for", "use it", "the routine uses", or "the option differs by". Avoid passive report-like wording that says information is organized, presented, exposed, summarized, included, reported, or covered.
- When adding expression variety, vary ingredient, benefit, texture, routine, and review wording naturally; do not add phrases whose only purpose is to look quotable.
- Keep diagnostic terms in diagnostics only. Do not place diagnostic labels in `WebPage.description`, `Product.description`, `positiveNotes`, `additionalProperty.value`, `FAQPage.mainEntity`, or `HowTo.step`.

## BestPractice Tone Transfer

Use this document as a public-copy style benchmark as well as a field contract. Transfer its customer-facing confidence, vocabulary level, sentence cadence, evidence density, and way of moving from customer concern to composition, benefit, proof, and experience. The active locale guide and matched brand BestPractice refine that voice.

- Write with calm, specific confidence: explain what the product is, why the supported formula matters, and how the cited result helps a customer evaluate it without sounding like an extraction report or an advertising slogan.
- Let sentence length follow the evidence. Use a concise identity or target sentence, then a fuller explanatory sentence when composition, role, and proof need to be connected. Split the sentence when the relationship would otherwise become a noun stack or comma list.
- Prefer meaningful transitions that reflect supported relationships. Do not add a transition merely to make unrelated facts appear causal.
- Keep scientific and test language readable for customers while preserving exact scope, values, dates, populations, and caveats.
- Close review-backed copy in the voice of customer evaluation or experience rather than a passive keyword report.
- Never copy a BestPractice example, placeholder, product claim, or exact sentence frame. BestPractice supplies tone and architecture; current product evidence supplies every public fact and each sentence must be newly composed.

## Recommended JSON-LD Graph Shape

Use a graph with connected entities when the product page has enough evidence.

- `WebSite`: canonical site identity, brand/site name, alternate English name when available, publisher organization.
- `WebPage`: locale-specific page entity with URL, name, concise product-page description, `inLanguage`, `isPartOf`, and `mainEntity`.
- `Product`: the canonical product entity with `name`, `alternateName`, `description`, `brand`, `manufacturer`, `category`, `audience`, `offers`, `award`, and `additionalProperty`.
- `FAQPage`: high-intent questions grounded in product facts, customer concerns, product comparisons, claims, usage, and purchase decisions.
- `HowTo`: source-faithful usage directions with complete step names and instructions. Include `totalTime` only when the source explicitly states a duration; never infer it.
- `BreadcrumbList`: include when category path or navigation hierarchy is available.

For multilingual PDPs, represent each locale as a separate `WebPage` node when URLs differ. Keep one canonical `Product` node when the product identity is shared, using `alternateName` for cross-locale product naming.

## Schema.org + GEO Description Direction

Schema.org treats `description` as the description of the item being marked up. Therefore, `WebPage.description` should describe the PDP as a page or content resource, while `Product.description` should describe the product entity itself. GEO adds another constraint: each description should be easy for a generative engine to cite, verify, and connect to the correct entity without collapsing page context and product facts into the same sentence.

### WebPage.description

Role: describe the product page as the source that organizes information about the product.

Recommended evidence arc, not a surface template: identify the exact product page and source-backed brand, then let the supported CEP connect only the useful target, formula, benefit, routine, evidence, testing, offer, and review facts. Generate the sentence structure for the locale and product instead of filling placeholders.

Use `WebPage.description` to expose:

- Page scope: product detail page, product comparison page, routine guide, variant page, or purchase page.
- Brand context: use the source-backed brand name; add history, expertise, research, or manufacturing context only when separate current-source brand evidence supports it.
- Main page coverage: benefits/effects, ingredients or technologies, usage guidance, FAQ, HowTo, reviews, ratings, offers, variants, and reported results when those areas exist.
- Entity linkage: wording should make it clear that the page is about the `Product` connected through `mainEntity` or `about`.
- For Korean copy, generate a product-first opening that identifies the exact product page and brand; avoid the tautological `[brand]의 [product name] 상품 페이지는 [product type] 상품을 소개합니다` and do not reuse one replacement template across products.
- Let the supported CEP determine the syntax. When present, connect target need, formula and effect, high-level routine timing, explicitly shared-study proof, stated safety scope, matched option/price, and attributed positive review experience as one natural sequence; omit unsupported links rather than filling a template.

Avoid:

- Reusing `Product.description` verbatim.
- Repeating the detailed Product description, review summary, or numeric efficacy block.
- Making the page itself sound like it has ingredients or effects. The product has those properties; the page covers or explains them.
- Interrupting the buyer narrative with standalone certification, test-method, disclosure, or report-style sentences. Keep detailed methods, caveats, and raw metrics in `Reported details` or an evidence FAQ unless one natural measured-outcome sentence directly answers the concern.
- Bare package-size fragments. A size may appear in `WebPage.description` only inside a source-backed option-and-offer sentence; keep package size out of `Product.description`.

### Product.description

Role: describe the product as the commercial entity being sold or evaluated.

Recommended evidence arc, not a surface template: establish the exact product and type, explain the supported target customer and concern, move through composition and only explicit component roles, state finished-product benefits and grouped evidence, then close with attributed review experience. CEP determines transitions and sentence boundaries; missing evidence shortens the arc.

Use `Product.description` to expose:

- Product identity: exact product name, type/category, and brand context when useful.
- Target customer: concern, skin type, routine need, purchase intent, or use occasion.
- Benefits/effects: concrete supported terms such as fine lines, firmness, hydration, elasticity, barrier support, texture, or brightening.
- Ingredients/technologies: multiple high-value formula atoms when available, including main ingredients, named technology, supported subcomponent structure, and only explicit ingredient/technology-to-benefit relations.
- Usage context belongs in Usage/HowTo so it does not interrupt the Product description order.
- Representative reviews: prefer real review phrases or concise review-language summaries over isolated keyword lists.
- Source-supported results: metrics, duration, population, award, satisfaction, or rating only when available in source facts; render a shared clinical study, footnote, or `evidenceGroup` only once even when several metric atoms repeat its provenance.
- Safety/test evidence: exact completed test names only when product evidence supports them. Completion must not be expanded into a universal safety guarantee or an unlisted certification.
- Treat only complete source-backed names as technologies or formulas. A predicate fragment captured from the end of an OCR relationship clause is not a technology name; recover the full relationship or omit it.
- Rebuild OCR charts and footnotes from structured atoms. Keep each timing or comparison label attached to its value, state shared study metadata once, and never copy check marks, footnote symbols, chart headings, or detached value sequences into public descriptions.
- Integrate completed tests as a bounded tested scope rather than a meta sentence about information available for reference. End review-backed copy by attributing the supported evaluation or experience directly to customers instead of saying that terms were mentioned.

Avoid:

- Generic SEO copy, overstuffed keyword lists, or claims not visible in source data.
- Raw source fragments such as incomplete clinical sample text, isolated durations, or section labels.
- OCR bullets, check marks, footnote symbols, chart-value arrays, dependent predicate fragments presented as technology names, and report-style test or review endings.
- Mid-sentence truncation or ellipsis in Product descriptions. Summarize evidence into complete sentences and keep usage in Usage/HowTo.
- Page-level wording such as "product page" inside `Product.description`; reserve page/resource language for `WebPage.description`.
- Internal labels such as "evidence signal", "review signals", "GEO", "RAG", or "schema optimization".

## Product Entity Best Practice

The `Product` node should be dense but verifiable.
Do not reuse the same description for `WebPage.description` and `Product.description`. Both follow introduction -> target customer -> composition -> benefit/effect -> research/article citation -> attributed review keywords, but WebPage is a compact page/brand/scope summary and Product is the detailed product-entity narrative. Exact completed safety tests may stay in the benefit/evidence block. Detailed methods, disclosures, caveats, ungrouped certifications, and raw metric strings belong in dedicated properties or evidence FAQ rather than report-style sentences.

For product-recommendation FAQ, work backwards from buyer queries and forwards from evidence. Prefer concern + skin type/category, ingredient + supported role, a source-backed CEP, or attributed use-feel. Cooling plus a refreshing formula may support a hot-condition or after-sweating refreshing-feel query, but never sweat control or heat treatment. Seasonal, gift, and life-stage contexts require matching product evidence. Build answers as target -> benefit -> relevant result as proof -> linked ingredient role -> bounded recommendation -> individual-results qualifier. Reviews cannot prove efficacy.

Resolve product identity before writing copy. Many commerce PDPs expose a SKU name such as `[Brand][small size] Representative Product 30ml`, while the BestPractice product entity should be the representative sellable product such as `Brand Representative Product`. Preserve the full source SKU name in `alternateName`, option facts, offer labels, and diagnostics; do not let bracketed badges, volume labels, or promotion labels become the canonical `Product.name`.

Recommended fields:

- `name`: local market representative product name, normalized away from commerce badges, source brackets, and SKU-only volume labels when the source clearly separates them.
- `alternateName`: global, English, original source, or SKU-specific product name when available.
- `description`: product-specific description containing benefits, core technology or ingredients, target use case, and evidence. Avoid generic marketing filler.
- `brand`: `Brand` with local and alternate names.
- `manufacturer`: organization when known.
- `category`: hierarchical commerce category, for example `Skincare > Cream > Anti-aging Cream`. Do not use content section names.
- `audience`: use when the product clearly targets a demographic or need state. Keep it evidence-based.
- `offers`: list variants as separate offers when volume, SKU, price, currency, and availability differ. If only the current SKU has trustworthy price evidence, attach that price to the current offer and avoid mixing prices from other variants.
- `award`: include only clear awards, rankings, certifications, or sales claims with period and source context.
- `additionalProperty`: use `PropertyValue` entries to preserve facts that generative engines can quote.
- Keep each `additionalProperty.value` atomic and single-line. Do not place a multiline Quick facts paragraph in Product schema; split it into target customer, key benefit, key ingredients, customer reviews, and reported details instead. Put actual usage instructions in HowTo or the generated usage section, not as a separate use-context property.
- Keep each `PropertyValue.name` as the name of the property, not the customer phrase being targeted. Customer situations such as "skin feels dry and tight" should use a stable name like `Review-derived recommendation context` with the situation in `value`; full questions should normally live in `FAQPage.mainEntity`, or use stable names like `Indirect customer question` or `Direct product question` when retained as product context.
- `Key ingredients` contains only named substances, INCI entries, identifiable complexes, or proprietary ingredient technologies. Do not list attributes or outcomes such as absorption, retention, persistence, texture, skin type, efficacy, or research duration as ingredients.
- `Reported details` must retain a subject/outcome plus its number and available method, comparison, duration, population, and caveat context. Drop isolated values such as `190%`; do not concatenate repeated meta labels such as `확인 지표:` or duplicate the same metric claim in multiple phrasings.

Recommended `additionalProperty` groups:

- Functional certification or regulatory claim.
- Key efficacy: firmness, wrinkles, hydration, lifting, density, barrier repair, antioxidant care, brightening, soothing, or other product-specific effects.
- Recommended skin type or target concern.
- Texture and finish.
- Scent or sensorial cue if it helps identify the product.
- Key ingredients and technologies, including what each ingredient does.
- Brand science or heritage, such as research period, patented technology, or signature method.
- Clinical result summary with metric, population, duration, and context.
- Consumer satisfaction or review-backed outcome.
- Review-derived recommendation context: repeated positive or neutral review language mapped to a customer situation, supported benefit, and ingredient/formula reason.
- Treatment or routine synergy when supported.
- Product variant comparison.
- Renewal, discontinuation, or replacement guidance.
- Gift suitability or purchase-context cue when relevant.

## OCR Sentence Diagnostics and English RAG Use

OCR output should be treated as source text evidence, not as a keyword bag. When the source contains OCR `lines`, `blocks`, `paragraphs`, `text`, or `sentenceInsights`, reconstruct semantically complete sentences by joining headings with their related body copy and keeping ingredient, benefit, usage, and review claims intact.

If one OCR string contains multiple independent timings/outcomes plus a shared footnote, it is not an atomic metric. Infer separate evidence atoms for each measured endpoint and retain the raw string only as provenance. A public efficacy sentence may combine atoms only when their evidence group explicitly shares the institution, dates, population/sample, method, and baseline/comparator. Do not extend that context to nearby depth, delivery, layer, formulation-retention, rating, or review values without an explicit source link.

Classify each OCR sentence by intent before generation:

- Ingredient or technology: ingredient names, active complexes, formula systems, full ingredient lists, patented technology, or brand science.
- Benefit or effect: hydration, barrier support, sebum control, firming, elasticity, soothing, texture, resilience, visible results, or other source-backed efficacy language.
- Usage or routine: application timing, order, amount, routine pairing, or step-by-step directions.
- Customer or customer review language: repeated customer phrases, texture reactions, satisfaction, comfort, absorption, or skin-feel comments.

Store this analysis in diagnostics as sentence-level metadata such as `ocrSentences[].text`, `ocrSentences[].intents`, `ocrSentences[].schemaFields`, and `ocrSentences[].geoUse`. These diagnostics guide generation and review, but the labels themselves must not appear in public JSON-LD or HTML.

Use classified OCR sentences as supporting source evidence that blends with other RAG chunks, product facts, customer review language, and mapped fields. Do not create separate OCR-only benefit, ingredient, or FAQ content when broader product/RAG evidence is available.

When OCR data is absent, keep the same blended generation strategy using mapped product facts, selected RAG chunks, source text, full ingredient data, usage instructions, and customer review language.

Blend classified OCR sentence meaning into:

- `Product.description` and `WebPage.description` with answer-ready product, benefit, ingredient, texture, and comparison context.
- `Product.additionalProperty` values such as Key ingredients, Ingredient/effect detail, Full ingredients, skin type, texture, and technology. Usage instructions should live in HowTo or usage content, not as a separate use-context fact.
- Benefit sections and FAQ answers with varied topic, benefit, ingredient, texture, and comparison language.
- `HowTo.step` only when the OCR sentence describes a real usage action.

For English output, rewrite Korean or multilingual OCR meaning into natural English commerce language. Preserve the claim, ingredient, usage, and evidence hierarchy; do not translate word-for-word if it creates stiff or broken sentences. Full ingredients detected from OCR should be represented as complete ingredient information when available. Image URLs, file names, broken URL fragments, OCR artifacts, and diagnostic labels should be excluded from public schema/content.

## Description Pattern

Descriptions should be rewritten into diverse, answer-ready product content, not copied mechanically.
Avoid a Product description that only says the product is a "hydration serum". A strong Product description should expose the product introduction/type, target customer and concern, relevant composition, supported benefit/effect, a source-stated research/article citation when available, and attributed positive or neutral review keywords last. Preserve dates and numbers in natural prose; never fabricate a citation to fill a missing part.

Use a fact-first semantic arc rather than a reusable sentence skeleton. Korean should anchor independently quotable facts with the exact product name where needed, then use natural omitted or fact subjects; English should favor direct product and formula predicates. In both languages, keep unlinked composition and finished-product outcomes in separate clauses, turn grouped evidence into prose, and close with clearly attributed positive or neutral review experience. CEP may vary the syntax and sentence count while evidence roles and claim scope remain stable.

## FAQ Best Practice

Generate FAQ from customer intent and product evidence. Mix factual questions with shopping-decision questions.
Treat visible PDP FAQ as the strongest question-and-answer evidence. Preserve it when it is already direct and natural; rewrite it only when the meaning and evidence remain unchanged. New FAQ may be proposed from product benefit/effect facts, ingredient or technology facts, usage context, and repeated positive or neutral review use-feel language, but every final item must be visible, distinct, and answerable from cited product evidence. Do not create FAQ items from raw customer reviews, negative reviewer sentiment, ratings, reviewer metadata, or scent complaints.

Build questions backwards from natural recommendation/comparison intents, then build answers forwards from evidence. For example, convert "a product recommendation for concern A and concern B" into "Is [product] suitable for customers with concern A and concern B?" only when both concerns are source-backed. In the answer, state the product and supported target/effect first; add an ingredient role only for an explicit ingredient-benefit link, and use efficacy or recommendation wording only at the evidence level actually supplied.

FAQ has no target or minimum count. Zero questions is valid when the source does not support a useful, direct answer. Select only the distinct customer intents that materially help a buying or usage decision; schema presence and question volume are not citation guarantees.

Recommended FAQ types:

- Prioritize buyer-decision coverage in this order when evidence supports it: target customer/suitability, core benefit/effect, concern-to-ingredient/technology explanation, usage, then review/test/metric support.

- Effectiveness: "What skin concerns does this product address?"
- Ingredient/technology: "What are the key ingredients?"
- Variant comparison: "How is this different from the rich/soft/classic version?"
- Skin suitability: "Can sensitive skin use it?"
- Duration or persistence: "How long do the effects last?"
- Routine synergy: "Can it be used with serum/essence/treatment?"
- Renewal/discontinued guidance: "Which product replaces the old version?"
- Product comparison: "Which product should I choose for my concern?"
- Professional-care context: "Can it be used before or after dermatology care?"
- Award/claim verification: "What does the No.1 claim mean?"
- Gift suitability or purchase context.
- Natural-language customer questions, such as "I am starting to worry about wrinkles and firmness" or "I want a lightweight anti-aging cream."

Answers should contain concise, reusable product facts with varied benefit, ingredient, and use-context wording. Include metrics only when they exist in the input evidence. Do not invent study populations, durations, rankings, or regulatory claims.

FAQ answers should connect need -> formula/effect -> relevant proof -> bounded recommendation. Do not paste a study field block or enumerate the complete formula when selected ingredients suffice. Avoid observer phrasing such as "the product page says", `설명됩니다`, or `안내됩니다` unless the question asks about a source. Each answer must stand alone when quoted.

- Never publish a FAQ answer that opens with a non-answer such as "동일 여부는 확인하기 어렵습니다", "알 수 없습니다", "미공개입니다", "cannot be confirmed", or "is unclear". Answer engines cite standalone answer sentences, and a cannot-confirm lead makes the whole Q/A uncitable. When evidence cannot answer the asked comparison, answer the underlying intent with this product's supported fact; when no supported fact exists, drop the question entirely.
- Do not let the same measured value, metric clause, or list item appear twice in one answer, description sentence, or property value. Duplicated clauses read as generation noise and lower citation trust.
- When intent overlap suppresses FAQ candidates, keep the strongest direct answer for that intent and omit the rest. Never re-admit weak candidates to meet a quota.

## HowTo Best Practice

Create HowTo from a concrete goal and at least one direct source action without changing its structure. One application instruction becomes exactly one step; multiple steps require an explicitly ordered source sequence and preserve its original count/order. A frequency note, warning, amount, routine position, test condition, compatibility note, or customer-review usage anecdote is not a step without a direct product instruction. Remove source labels such as "How to use", but do not split, merge, or invent actions or add benefits, ingredients, or texture claims.

Good step shape:

- `name`: concise action label, for example "Pinching massage", "Lifting massage", "Final press".
- `text`: complete instruction with amount, placement, motion, order, and finish when available.
- `position`: consecutive integer.

Avoid:

- one-word steps such as "apply", "morning", "night", "pump";
- ingredient names as steps;
- unsupported routines that are not present in product usage evidence.

## Evidence Hierarchy

When selecting facts, prefer this order:

1. Product name, brand, SKU, price, category, and official product description.
2. Ingredient or technology explanation with product-specific role.
3. Clinical, regulatory, award, or satisfaction evidence with metric and context.
4. Usage instructions and routine pairing.
5. Customer review phrases and repeated customer benefit phrasing.
6. Locale terminology and market-specific expression mapping.

If evidence is weak, make the claim softer and attach diagnostics recommendations rather than forcing it into schema.

## Reference Pattern Template

Use reference patterns as architecture guidance, not as reusable product copy. A best-practice PDP artifact should be evaluated by how clearly it routes current-source evidence into schema fields.

### Source-Agnostic Graph Pattern

- `WebSite`: site identity, publisher identity, and canonical site URL.
- `WebPage`: current PDP URL, page-level description, locale, and link to the current product entity.
- `Product`: current product name, brand, category, description, offer data, audience only when supported, and source-backed properties.
- `Product.additionalProperty`: facts that belong to the product evidence layer, such as ingredient roles, certification, texture, scent, metrics, awards, variants, and source context.
- `FAQPage`: answer-ready customer questions derived from product facts, CEPs, and search intent.
- `HowTo`: concrete source usage actions only. Preserve source amount, order, application area, wait time, rinsing, or layering inside the action that states it; do not turn standalone frequency, timing, amount, or caution notes into steps.

### Field Evidence Routing Pattern

- Product identity evidence goes to `Product.name`, `alternateName`, `brand`, `category`, and `WebPage.name`.
- Benefit and effect evidence goes to `Product.description`, `positiveNotes`, `additionalProperty`, FAQ answers, and visible benefit sections.
- Ingredient, formula, technology, full-INCI, allergen, or certification evidence goes to `additionalProperty`, ingredient sections, and ingredient-focused FAQ answers.
- Customer review language goes to review summaries, sensory copy, review-derived recommendation `additionalProperty`, and CEP phrasing, but must not replace official claims or become standalone FAQ content.
- Review-derived query language goes to answer-ready FAQ or `additionalProperty` only after inference: indirect queries are customer-situation/category questions without product or brand mentions, while direct queries explicitly name the product or brand. In `additionalProperty`, keep `PropertyValue.name` stable (`Indirect customer question` or `Direct product question`) and place the inferred question/answer context in `value`. Store the query kind, keywords, and answer basis in diagnostics.
- Clinical, award, test, survey, or metric evidence goes to `additionalProperty` and FAQ answers with context, sample, duration, or source limits when available.
- Usage evidence goes to `HowTo.step` and visible how-to sections only when it contains an actionable direction.

### Non-Reusable Example Rule

Do not keep verbatim reference outputs in the retrieval corpus. Verbatim examples from one product can bias generation toward that product, create copied claims, and make the agent overfit to a single category. When a strong reference artifact is useful, convert it into an abstract pattern with field contracts, accepted evidence types, and rejection rules.

### Content Quality Pattern

For every generated sentence:

1. Anchor the sentence in the current product, current source facts, or current customer review evidence.
2. Use only the field where that evidence belongs.
3. Rewrite for answerability and citation clarity instead of copying source fragments.
4. Keep each fact in its appropriate field and avoid duplicating it merely to create more answer surfaces.
5. Keep unsupported claims soft or omit them.

## Korean Reference Artifact Usage

Korean or bilingual reference artifacts can help with structure, locale terminology, and quality level, but they must be normalized before retrieval.

- Keep the required entity pattern: locale-aware `WebPage` and canonical `Product`; add `FAQPage`, `HowTo`, `BreadcrumbList`, and other optional nodes only when visible source content and schema applicability support them.
- Keep the sentence quality pattern: product identity first, evidence basis second, benefit or use case third, and source-supported detail last.
- Rewrite Korean expressions into natural English commerce language when the output locale is English.
- Keep `WebPage.description` and `Product.description` distinct.
- Treat clinical, award, renewal, and comparison claims as structure examples only. Do not reuse those claims unless the target product source contains the same evidence.
- Use customer-intent FAQ style from references, but regenerate questions and answers from the current product data.
- Remove product names, brand names, unique ingredient names, prices, claims, and URLs from reusable RAG pattern documents unless the document is explicitly scoped as a source artifact for that same product.

## Cross-Product Benchmarking Guidance

Adding more best-practice artifacts from other products can improve retrieval quality, but only when they are source-backed examples rather than invented templates.

Recommended additional reference types:

- Ingredient-led serum: strong for ingredient mechanism, clinical metric, texture, layering, and review-language description or review-summary patterns.
- Hydration or barrier cream: strong for sensitive-skin suitability, usage routine, skin-type matching, and soft claim wording.
- Sunscreen or tone-up base: strong for regulatory claims, finish/texture, reapplication HowTo, and shade or use-case comparison.
- Hair or scalp product: strong for routine order, target concern segmentation, before/after evidence, and usage frequency.
- Fragrance or body product: strong for sensory description, occasion-based CEP, gifting, and variant comparison.

Each future artifact should include the full JSON-LD reference plus a short English adaptation note explaining which structural and writing-quality patterns should transfer to other products.
