# Category Entry Point Guidance v1

## 1. Purpose

Category Entry Points, or CEPs, describe buying, discovery, usage, or memory situations where a customer may enter a category and recall a brand or product. For PDP GEO, CEP guidance helps the agent map product facts and reviews to natural customer-intent language, while brand identity may tune vocabulary, mood, and brand personality in schema descriptions, FAQ, HowTo, benefits, and PDP sections.

## 2. Source Scope

### 2.1 Research and Operating Definition

- Sources checked on 2026-07-11:
  - Ehrenberg-Bass Institute Research Services: https://marketingscience.info/learn-with-us/commercial-research
  - Ehrenberg-Bass Institute homepage: https://marketingscience.info/
  - Ehrenberg-Bass CEP research service overview: https://www.marketingscience.info/wp-content/uploads/2022/01/Identifying-and-Prioritising-CEPs.pdf
- Ehrenberg-Bass describes CEPs as building blocks of mental availability and as a research service for identifying and prioritising category entry points.
- This local document adapts CEPs for PDP generation. It is an operating guide for product-content reasoning, not an official search engine requirement.

### 2.2 Relationship to GEO

- CEPs help generative engines connect a product to the kind of customer questions and shopping situations that appear in fan-out queries and AI answers.
- CEPs must be grounded in product facts, customer-review language, or source category information. Brand identity can refine tone, vocabulary, sensory style, and positioning, but brand-only patents, papers, heritage stories, or authority claims cannot create product-level CEPs.
- CEPs are not a license to keyword-stuff product names, add unrelated category language, or create unsupported benefit claims.

## 3. CEP Dimensions

### 3.1 Customer Need or Problem

- Map source-backed benefits and review language to customer needs such as dry skin, skin barrier support, dullness, visible firmness, scalp comfort, frizz control, makeup longevity, or fragrance gifting.
- Use customer-need CEPs in Product descriptions, FAQ questions, benefit headings, and short PDP summaries. WebPage descriptions remain page/brand summaries.

### 3.2 Situation, Occasion, or Routine Moment

- Map usage instructions and review context to moments such as morning routine, night routine, after toner, before makeup, post-cleansing, travel, office touch-up, seasonal dryness, or daily body care.
- Use routine CEPs in HowTo steps and FAQ answers when source usage supports the occasion.

### 3.3 User, Skin, Hair, or Preference Context

- Map source fields to target users or preferences such as sensitive-feeling skin, oily skin, dehydrated skin, fine hair, dry scalp, lightweight texture preference, rich cream preference, fragrance intensity preference, or non-sticky finish.
- Keep user-context CEPs careful. Do not claim universal suitability unless the source explicitly says so.

### 3.4 Ingredient, Technology, or Format Need

- Map ingredient and formula facts to category-entry phrases such as niacinamide serum, ceramide barrier cream, ginseng skincare, retinol night routine, peptide eye care, mineral sunscreen, cushion foundation, or scalp ampoule.
- Use ingredient CEPs in `Product.additionalProperty`, ingredient detail sections, FAQ questions, and Product descriptions.

### 3.5 Outcome, Comparison, or Choice Context

- Map supported product differences to selection language such as lightweight versus rich, serum versus cream step, matte versus dewy finish, refill option, fragrance family, set/gift option, or value-size option.
- Avoid unsupported superiority claims. Comparison CEPs should help shoppers choose, not rank products without evidence.

### 3.6 Channel and Query Intent

- Map PDP fields to search/AI answer intents such as "how to use", "is it good for", "what ingredients are in", "what does it feel like", "what do reviews mention", "which routine step", or "what size/variant".
- Do not create separate content for every possible query variation. Use the strongest supported CEPs in natural, reusable sections.

## 4. CEP Identification and Prioritization

### 4.1 Extraction Workflow

1. Extract product facts: name, brand, category, benefits, effects, ingredients, usage, size, texture, format, variants, metrics, offer data, and constraints.
2. Extract customer signals: observed review keywords and phrases, rating context, complaints, questions, and routine mentions. Track repetition only when multiple reviews or a source aggregate supports it.
3. Extract brand identity signals: brand vocabulary, mood, personality, category authority, sensory style, and target audience. Treat hero ingredients, patents, papers, or research systems as product CEP inputs only when the current product source independently contains the same product-level fact.
4. Classify every atomic source unit before combining it. Keep named substances/formula technologies, benefits, measured effects, target audiences or concerns, usage moments, reviews, and evidence conditions in separate roles. An attribute such as absorption, persistence, texture, timing, or a percentage is not an ingredient.
5. Treat a compressed OCR measurement block as a set of evidence atoms, not as a ready-made CEP sentence. Build the customer choice path only from supported links: target concern -> product/formula composition -> customer-facing effect -> measured outcome -> suitability. Keep delivery/depth and formulation metrics separate from customer effects unless the source explicitly links them, and attach shared study conditions only to outcomes in the same evidence group.
6. Build evidence-backed causal paths only where the source supports each edge: `target customer or concern -> desired outcome`, `ingredient or technology -> supported benefit/effect`, `effect -> measurement/study context`, and `review pattern -> customer preference`. Do not connect an ingredient to a benefit merely because both occur somewhere on the same page.
7. Generate CEP candidates and natural query/expression variants from the strongest causal paths. Preserve the same meaning while varying customer wording, concern wording, ingredient/formula wording, and benefit wording; avoid repeating the product name in every sentence.
8. Separate two inference layers. Source-backed situations and relations may appear in public descriptions, FAQ, and schema. Broader semantic associations—such as mapping generic dryness to winter—are query hypotheses only unless the product source, usage, or reviews independently support that occasion; they must not become product facts or efficacy claims.
9. Filter candidates that are unsupported, too generic, medically risky, duplicated, semantically redundant, or unrelated to the category.
10. Prioritize candidates by source support, causal completeness, specificity, strength of review support, commerce usefulness, locale fit, and schema field usefulness.

### 4.2 Causal Path Completeness

- Prefer a compact path that can answer a buyer question end to end: product identity/type -> target customer and concrete concern -> relevant ingredient/technology -> supported benefit/effect -> official measurement when available -> positive or neutral review pattern when available.
- A path can omit a missing node, but it must never fill the gap with general category knowledge. If no explicit ingredient-to-outcome relation exists, state formula composition and product benefit as separate supported facts instead of inventing causality.
- Produce multiple search expressions only when they represent distinct intent surfaces, such as suitability, concern/effect, ingredient role, measured result, routine, or review experience. Synonymous questions that would receive the same answer count as one intent.
- Keep description prose cohesive: introduce the product once, use a short product reference or an omitted subject in following clauses, and connect ingredient composition to benefit/effect instead of restarting every sentence with the full product name.

### 4.3 Scoring Guidance

- Strong CEP: supported by product facts and relevant customer language; multiple independent reviews may strengthen it but are not required for a factual product intent.
- Medium CEP: supported by product facts but limited customer-experience evidence; useful for description or product-context copy if not overused.
- Weak CEP: generic category phrase, unsupported trend term, or only inferred from brand identity; keep out of public output unless diagnostics requests it.
- Blocked CEP: medical, disease-treatment, guaranteed, competitive, or unrelated claim without explicit support.

## 5. PDP Field Mapping

### 5.1 Schema Fields

- `WebPage.description`: identify the product page and source-backed brand, then summarize actual page coverage without repeating the product-detail CEP narrative.
- `Product.description`: use product-specific CEPs in order: product introduction/type, target concern/customer, ingredient composition, supported benefit/effect/evidence, then attributed representative review preference.
- `Product.additionalProperty`: use objective CEP attributes such as skin type, concern, texture, ingredient, usage timing, size, technology, format, or review-derived recommendation context when repeated positive/neutral reviews support the customer situation.
- Review-derived query units: infer indirect queries from customer situation plus category without product or brand mentions, and infer direct queries with the product or brand explicitly named. Combine the inferred query with product facts, core CEP keywords, and a short answer-ready evidence sentence; keep the query kind and keyword reasoning in diagnostics.
- `Product.positiveNotes`: use source-backed benefit and review-backed positive points.
- `FAQPage.mainEntity`: phrase questions around the customer's likely category-entry problem, ingredient concern, review question, or routine moment.
- `HowTo.step`: require a concrete goal and at least two explicitly ordered source actions, preserving their count and order. Keep a single action as visible usage guidance without HowTo structured data. A general usage moment without an action is not HowTo.

### 5.2 HTML Content

- Benefits: connect the customer need to the specific product evidence.
- Ingredients: connect ingredient CEPs to supported ingredient roles.
- Review summary: preserve observed customer language without inventing outcomes; say repeated only when the review evidence proves repetition.
- HowToUse: make routine CEPs actionable and ordered.
- FAQ: cover the highest-priority customer questions that can be answered from source facts.

## 6. Partial Update Query Planning

### 6.1 FAQ Updates

- Retrieve CEP chunks for customer need, ingredient concern, review question, and query intent.
- Regenerate only the FAQ intent candidates and FAQ answers when the source update affects questions or customer concerns.
- Keep unchanged HowTo, Product description, and schema properties stable unless the updated fact conflicts with them.

### 6.2 HowToUse Updates

- Retrieve CEP chunks for situation, occasion, routine moment, and usage timing.
- Regenerate HowTo steps when source usage, amount, order, warning, or routine position changes.
- Reflect the update in FAQ only when customer questions depend on the changed routine.

### 6.3 Description and Schema Updates

- Retrieve high-priority CEPs for target customer, concern, ingredient need, and review preference.
- Update `WebPage.description`, `Product.description`, `additionalProperty`, and `positiveNotes` only for fields touched by the new source evidence.

## 7. Skincare and Beauty Examples

### 7.1 Concern-Led CEPs

- "dry skin comfort", "skin barrier care", "sensitive-feeling skin routine", "visible firmness care", "tone-care serum", "dullness care", "pores and texture care", "scalp comfort", "frizz control", "long-wear base makeup".

### 7.2 Routine-Led CEPs

- "after toner serum step", "morning sunscreen step", "night retinol routine", "before makeup moisturizer", "post-cleansing scalp care", "daily body lotion", "travel-size routine".

### 7.3 Ingredient-Led CEPs

- "niacinamide serum", "ceramide cream", "ginseng skincare", "peptide eye cream", "vitamin C brightening care", "mineral sunscreen", "panthenol soothing care".

### 7.4 Sensory and Preference CEPs

- "lightweight texture", "non-sticky finish", "rich cream feel", "fast absorption", "dewy finish", "matte finish", "soft floral fragrance", "refillable option".

## 8. Locale Rules

- Localize CEP wording through the locale terminology map before final output.
- Keep US English, Korean, Japanese, or other market wording natural for that market instead of directly translating internal category labels.
- Do not replace brand-owned names or regulated ingredient names unless the locale terminology map says to.

## 9. Anti-Patterns

- Do not use CEPs as hidden keyword lists.
- Do not expose the label "CEP" in public schema values. Express the customer situation directly, then connect it to supported product benefits, ingredients, and positive review use-feel.
- Do not add "best", "top", "recommended by dermatologists", "for acne", "cures eczema", or similar high-risk claims without source support.
- Do not let CEPs override the real product category or product name.
- Do not generate separate pages or sections for every fan-out query. Prefer a compact set of well-supported, reusable PDP sections.
