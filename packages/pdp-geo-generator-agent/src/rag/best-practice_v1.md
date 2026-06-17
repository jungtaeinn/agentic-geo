# Best Practice v1

This document is project-local guidance for generating GEO-ready PDP schema markup and PDP content. Treat examples as structural patterns, not phrases to copy.

If the source example is written in Korean but the requested output locale is English, Japanese, or another locale, preserve the information architecture and evidence hierarchy while rewriting the actual text in the target locale. The generator should adapt brand terms, customer expressions, category names, ingredient names, and benefit wording to the locale-specific terminology guide.

## Core Principle

GEO output should help generative engines quote and verify the product from structured, evidence-rich facts.

- Prefer product-specific facts over generic SEO claims.
- Compose descriptions from: target customer + core benefit + ingredient or technology + use context + evidence or review signal.
- Never expose internal wording such as "GEO-ready", "PDP name", "schema optimization", or "for generative engines" inside public schema/content.
- Do not use analysis labels such as "usage", "review", "benefit", or "keyword" as product category values.
- Do not create FAQ, review, or HowTo content from isolated tokens. Use complete questions, answers, review summaries, and actionable usage steps.

## Recommended JSON-LD Graph Shape

Use a graph with connected entities when the product page has enough evidence.

- `WebSite`: canonical site identity, brand/site name, alternate English name when available, publisher organization.
- `WebPage`: locale-specific page entity with URL, name, concise product-page description, `inLanguage`, `isPartOf`, and `mainEntity`.
- `Product`: the canonical product entity with `name`, `alternateName`, `description`, `brand`, `manufacturer`, `category`, `audience`, `offers`, `award`, and `additionalProperty`.
- `FAQPage`: high-intent questions grounded in product facts, customer concerns, product comparisons, claims, usage, and purchase decisions.
- `HowTo`: concise usage routine with complete step names and instructions. Include `totalTime` only when supported or safely inferable from usage evidence.
- `BreadcrumbList`: include when category path or navigation hierarchy is available.

For multilingual PDPs, represent each locale as a separate `WebPage` node when URLs differ. Keep one canonical `Product` node when the product identity is shared, using `alternateName` for cross-locale product naming.

## Product Entity Best Practice

The `Product` node should be dense but verifiable.

Recommended fields:

- `name`: local market product name.
- `alternateName`: global or English product name when available.
- `description`: product-specific description containing benefits, core technology or ingredients, target use case, and evidence. Avoid generic marketing filler.
- `brand`: `Brand` with local and alternate names.
- `manufacturer`: organization when known.
- `category`: hierarchical commerce category, for example `Skincare > Cream > Anti-aging Cream`. Do not use content section names.
- `audience`: use when the product clearly targets a demographic or need state. Keep it evidence-based.
- `offers`: list variants as separate offers when volume, SKU, price, currency, and availability differ.
- `award`: include only clear awards, rankings, certifications, or sales claims with period and source context.
- `additionalProperty`: use `PropertyValue` entries to preserve facts that generative engines can quote.

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
- Treatment or routine synergy when supported.
- Product variant comparison.
- Renewal, discontinuation, or replacement guidance.
- Gift suitability or purchase-context cue when relevant.

## Description Pattern

Descriptions should be rewritten for citation, not copied mechanically.

Good structure:

`[Product name] is a [product type] for [target customer or concern] that helps [core benefits] with [ingredient/technology]. [Evidence signal or review/customer signal] supports [specific outcome/use context].`

Korean example structure:

`60년 인삼 연구로 완성된 [제품명]은 [대상 고민]을 위한 [제품 유형]으로, [핵심 성분/기술]을 통해 [효능]을 돕습니다. [임상/만족도/리뷰 신호]를 근거로 [사용 맥락]에서 인용하기 좋은 설명을 구성합니다.`

English example structure:

`[Product name] is a [product type] for [target concern] that supports [benefits] with [ingredient/technology]. Clinical or review-backed signals highlight [specific outcome] in [usage context].`

The language may change, but the structure must remain fact-first.

## FAQ Best Practice

Generate FAQ from customer intent and product evidence. Mix factual questions with shopping-decision questions.

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

Answers should contain concise, quotable facts. Include metrics only when they exist in the input evidence. Do not invent study populations, durations, rankings, or regulatory claims.

## HowTo Best Practice

HowTo steps must be complete actions, not keyword fragments.

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
5. Customer review phrases and repeated customer benefit language.
6. Locale terminology and market-specific expression mapping.

If evidence is weak, make the claim softer and attach diagnostics recommendations rather than forcing it into schema.

## Reference Pattern From Amoremall/Sulwhasoo Example

The reference example models a premium anti-aging cream PDP with the following structure:

- Site identity: `아모레몰` / `AMOREMALL`, publisher `아모레퍼시픽` / `Amorepacific`.
- Locale pages: Korean and English `WebPage` nodes point to the same product entity and use locale-specific names and descriptions.
- Product identity: local name `설화수 자음생크림`, alternate name `Sulwhasoo Concentrated Ginseng Rejuvenating Cream`, brand `설화수` / `Sulwhasoo`.
- Category path: skincare cream category, specifically anti-aging cream.
- Audience: anti-aging care audience around 30-60+ when supported by evidence.
- Offers: separate 50ml and 30ml offers with SKU, price, KRW currency, availability, condition, and price validity.
- Award: 10-year No.1 anti-aging cream claim with date range and source context.
- Additional properties: functional certification, efficacy list, skin type, texture, scent, key ingredients, ginseng science, clinical result summary, satisfaction results, dermatology-care synergy, cross-product synergy, variant comparison, renewal notice, and gift recommendation.
- FAQ: includes efficacy, ingredients, variant differences, sensitive skin, effect duration, product pairings, discontinued versions, product comparisons, professional-care use, award verification, gift suitability, and customer-intent questions.
- HowTo: three clear massage steps with complete instructions.

Use this as a model for depth and structure. Do not copy Sulwhasoo-specific claims into unrelated products.
