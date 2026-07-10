# Best Practice v1

This document is project-local guidance for generating GEO-ready PDP schema markup and PDP content. Treat examples as structural patterns, not phrases to copy.

If the source example is written in Korean but the requested output locale is English, Japanese, or another locale, preserve the information architecture and evidence hierarchy while rewriting the actual text in the target locale. The generator should adapt brand terms, customer expressions, category names, ingredient names, and benefit wording to the locale-specific terminology guide.

## RAG Corpus Orchestration

Use the typed RAG index as the first-pass map for deciding which content unit should be retrieved. This document should be selected when the generator needs overlap resolution, public wording rules, benchmark depth, OCR/source blending, FAQ intent breadth, HowTo reconstruction, or product/entity description separation.

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

GEO output should help generative engines cite and verify the product from structured, evidence-rich facts. Citation readiness means varied, natural product expressions and complete facts, not public citation labels, quote phrases, or repeated stock claim sentences.

- Prefer product-specific facts over generic SEO claims.
- Treat ChatGPT Search, Gemini grounding, and Google AI Search as retrieval-and-citation environments: they reward crawlable, visible, source-backed content units, not hidden AI-only instructions or artificial markup tricks.
- Compose descriptions from: target customer + product identity + ingredient or technology + benefit/effect or citation-ready metric + high-level usage/comparison/review context.
- Never expose internal wording such as "GEO-ready", "PDP name", "schema optimization", or "for generative engines" inside public schema/content.
- Do not use analysis labels such as "usage", "review", "benefit", or "keyword" as product category values.
- Do not create FAQ, review, or HowTo content from isolated tokens. Use complete questions, answers, review summaries, and actionable usage steps.

## Public Wording Guardrails

Public JSON-LD values and PDP content should read like customer-facing product information, not internal optimization notes.

- Do not expose internal labels such as "evidence signal", "review signals", "main benefit signal", "ingredient signal", "technology signals", "GEO", "RAG", "schema optimization", or "citation optimization".
- Make the public sentence subject the product, ingredient/technology, benefit, usage action, review pattern, option, or customer concern. Do not make "evidence", "source material", "product page", "product details", "usage guidance", "context", "information", or the generation process the subject unless the user-facing question is explicitly about a document/source.
- Prefer direct public wording such as "the formula includes", "key ingredients and technologies include", "customer reviews mention", "the product is suitable for", "use it", "the routine uses", or "the option differs by". Avoid passive report-like wording that says information is organized, presented, exposed, summarized, included, reported, or covered.
- When adding expression variety, vary ingredient, benefit, texture, routine, and review wording naturally; do not add phrases whose only purpose is to look quotable.
- Keep diagnostic terms in diagnostics only. Do not place diagnostic labels in `WebPage.description`, `Product.description`, `positiveNotes`, `additionalProperty.value`, `FAQPage.mainEntity`, or `HowTo.step`.

## Recommended JSON-LD Graph Shape

Use a graph with connected entities when the product page has enough evidence.

- `WebSite`: canonical site identity, brand/site name, alternate English name when available, publisher organization.
- `WebPage`: locale-specific page entity with URL, name, concise product-page description, `inLanguage`, `isPartOf`, and `mainEntity`.
- `Product`: the canonical product entity with `name`, `alternateName`, `description`, `brand`, `manufacturer`, `category`, `audience`, `offers`, `award`, and `additionalProperty`.
- `FAQPage`: high-intent questions grounded in product facts, customer concerns, product comparisons, claims, usage, and purchase decisions.
- `HowTo`: concise usage routine with complete step names and instructions. Include `totalTime` only when supported or safely inferable from usage evidence.
- `BreadcrumbList`: include when category path or navigation hierarchy is available.

For multilingual PDPs, represent each locale as a separate `WebPage` node when URLs differ. Keep one canonical `Product` node when the product identity is shared, using `alternateName` for cross-locale product naming.

## Schema.org + GEO Description Direction

Schema.org treats `description` as the description of the item being marked up. Therefore, `WebPage.description` should describe the PDP as a page or content resource, while `Product.description` should describe the product entity itself. GEO adds another constraint: each description should be easy for a generative engine to cite, verify, and connect to the correct entity without collapsing page context and product facts into the same sentence.

### WebPage.description

Role: describe the product page as the source that organizes information about the product.

Recommended composition:

`[Product name] product page helps [target customer/search intent] evaluate [product type/category] by covering [benefit areas], [key ingredients/technologies], [usage or routine guidance], [customer review language], and [reported results/claim support when available].`

Use `WebPage.description` to expose:

- Page scope: product detail page, product comparison page, routine guide, variant page, or purchase page.
- Target customer or search intent: who would use the page to decide, compare, or verify the product.
- Main page coverage: benefits/effects, ingredients or technologies, usage guidance, FAQ, HowTo, reviews, ratings, offers, variants, and reported results.
- Entity linkage: wording should make it clear that the page is about the `Product` connected through `mainEntity` or `about`.

Avoid:

- Reusing `Product.description` verbatim.
- Saying only that the page "organises information" without naming the actual benefit, ingredient, review, or result topics.
- Making the page itself sound like it has ingredients or effects. The product has those properties; the page covers or explains them.

### Product.description

Role: describe the product as the commercial entity being sold or evaluated.

Recommended composition:

`[Product name] is a [product type] for [target customer/concern]. It supports [specific benefits/effects] with [key ingredients/technologies]. It can be used [usage/routine context]. Representative customer reviews mention [texture, comfort, or satisfaction phrasing]. A supporting sentence can connect reported results with key actives, visible benefits, texture, comfort, and routine use.`

Use `Product.description` to expose:

- Product identity: exact product name, type/category, and brand context when useful.
- Target customer: concern, skin type, routine need, purchase intent, or use occasion.
- Benefits/effects: concrete supported terms such as fine lines, firmness, hydration, elasticity, barrier support, texture, or brightening.
- Ingredients/technologies: key formula elements and their product-specific role when supported.
- Usage context: when and how it can be used in a routine, not just "how to use" labels.
- Representative reviews: prefer real review phrases or concise review-language summaries over isolated keyword lists.
- Source-supported results: metrics, duration, population, award, satisfaction, or rating only when available in source facts.

Avoid:

- Generic SEO copy, overstuffed keyword lists, or claims not visible in source data.
- Raw source fragments such as incomplete clinical sample text, isolated durations, or section labels.
- Mid-sentence truncation or ellipsis in Product descriptions. Summarize usage and evidence into complete sentences instead of cutting raw source text.
- Page-level wording such as "product page" inside `Product.description`; reserve page/resource language for `WebPage.description`.
- Internal labels such as "evidence signal", "review signals", "GEO", "RAG", or "schema optimization".

## Product Entity Best Practice

The `Product` node should be dense but verifiable.
Do not reuse the same description for `WebPage.description` and `Product.description`. The WebPage description should explain what the page covers at a higher level while still naming the key benefit areas, ingredients or technologies, customer review language, reported results, and target-customer decision context. Product.description should be a product-specific, answer-ready entity description ordered as target customer, product identity, ingredients/technology, benefit/effect or citation-ready metric, then high-level usage/comparison/review context.

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
Avoid shallow descriptions that only say the page "organises information" or that the product is simply a "hydration serum". A strong Product description should expose the target customer, product identity, key ingredients or technologies, major benefit keywords and any supported clinical, satisfaction, or reported-result detail before adding high-level usage, comparison, or representative customer review language.

Good structure:

`[Product name] is a [product type] for [target customer or concern]. [Ingredient/technology] supports [core benefits] and [source-supported metric when available]. [High-level routine/comparison/review context] follows as the final context sentence.`

Korean example structure:

`[제품명]은 [대상 고객/고민]을 위한 [제품 유형]입니다. [핵심 성분/기술]이 [효능/효과]를 돕고, [임상/만족도 수치]가 있으면 같은 문맥에서 자연스럽게 연결합니다. 마지막에는 [사용 루틴], [비교 기준], [고객 리뷰에서 반복되는 표현]을 고수준 맥락으로 덧붙입니다.`

English example structure:

`[Product name] is a [product type] for [target concern]. [Ingredient/technology] supports [benefits], with clinical or reported details when available. High-level routine, comparison, or repeated customer review language can close the description.`

The language may change, but the structure must remain fact-first.

## FAQ Best Practice

Generate FAQ from customer intent and product evidence. Mix factual questions with shopping-decision questions.
Treat visible PDP FAQ as the strongest question-and-answer evidence. Preserve it when it is already direct and natural; rewrite it only when the meaning and evidence remain unchanged. New FAQ may be proposed from product benefit/effect facts, ingredient or technology facts, usage context, and repeated positive or neutral review use-feel language, but every final item must be visible, distinct, and answerable from cited product evidence. Do not create FAQ items from raw customer reviews, negative reviewer sentiment, ratings, reviewer metadata, or scent complaints.

FAQ has no target or minimum count. Zero questions is valid when the source does not support a useful, direct answer. Select only the distinct customer intents that materially help a buying or usage decision; schema presence and question volume are not citation guarantees.

Recommended FAQ types:

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

FAQ answers should start with the direct answer, then add one short cited evidence or comparison detail. Choose items by evidence sufficiency, intent value, and non-overlap rather than a fixed count. Avoid observer phrasing such as "the product page says" unless the question is explicitly about page coverage. The answer unit should still make sense when quoted outside the original page.

- Never publish a FAQ answer that opens with a non-answer such as "동일 여부는 확인하기 어렵습니다", "알 수 없습니다", "미공개입니다", "cannot be confirmed", or "is unclear". Answer engines cite standalone answer sentences, and a cannot-confirm lead makes the whole Q/A uncitable. When evidence cannot answer the asked comparison, answer the underlying intent with this product's supported fact; when no supported fact exists, drop the question entirely.
- Do not let the same measured value, metric clause, or list item appear twice in one answer, description sentence, or property value. Duplicated clauses read as generation noise and lower citation trust.
- When intent overlap suppresses FAQ candidates, keep the strongest direct answer for that intent and omit the rest. Never re-admit weak candidates to meet a quota.

## HowTo Best Practice

Create HowTo only when the source describes an ordered multi-action procedure for achieving a concrete result. A frequency note, warning, amount, routine position, or single application sentence remains visible usage guidance but is not HowTo. Every HowTo requires at least two distinct source-backed actions. Remove source section labels such as "How to use" and deduplicate repeated instructions; do not add benefits, ingredients, or texture claims to a procedural step.

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
- `HowTo`: usage actions only, such as amount, order, application area, frequency, wait time, rinsing, layering, or caution steps.

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
