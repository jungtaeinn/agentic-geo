# Best Practice v1

This document is project-local guidance for generating GEO-ready PDP schema markup and PDP content. Treat examples as structural patterns, not phrases to copy.

If the source example is written in Korean but the requested output locale is English, Japanese, or another locale, preserve the information architecture and evidence hierarchy while rewriting the actual text in the target locale. The generator should adapt brand terms, customer expressions, category names, ingredient names, and benefit wording to the locale-specific terminology guide.

## Core Principle

GEO output should help generative engines cite and verify the product from structured, evidence-rich facts. Citation readiness means varied, natural product expressions and complete facts, not public citation labels, quote phrases, or repeated stock claim sentences.

- Prefer product-specific facts over generic SEO claims.
- Compose descriptions from: target customer + core benefit + ingredient or technology + routine fit + source-supported or review-backed detail.
- Never expose internal wording such as "GEO-ready", "PDP name", "schema optimization", or "for generative engines" inside public schema/content.
- Do not use analysis labels such as "usage", "review", "benefit", or "keyword" as product category values.
- Do not create FAQ, review, or HowTo content from isolated tokens. Use complete questions, answers, review summaries, and actionable usage steps.

## Public Wording Guardrails

Public JSON-LD values and PDP content should read like customer-facing product information, not internal optimization notes.

- Do not expose internal labels such as "evidence signal", "review signals", "main benefit signal", "ingredient signal", "technology signals", "GEO", "RAG", "schema optimization", or "citation optimization".
- Prefer natural public wording such as "customer reviews mention", "available product information includes", "the formula includes", "key ingredients and technologies include", or "reported product details include".
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

`[Product name] is a [product type] for [target customer/concern]. It supports [specific benefits/effects] with [key ingredients/technologies]. It can be used [usage/routine context]. Representative customer reviews mention [texture, comfort, or satisfaction phrasing]. Product details should connect supported results or evidence with key actives, visible benefits, texture, comfort, and routine fit.`

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
Do not reuse the same description for `WebPage.description` and `Product.description`. The WebPage description should explain what the page covers at a higher level while still naming the key benefit areas, ingredients or technologies, review language, reported results, and target-customer decision context. Product.description should be a product-specific, answer-ready entity description that explains who the product is for, what benefits and major ingredients it has, what representative customer reviews say, how the product can be used, and which supported result details are available.

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
- Keep each `additionalProperty.value` atomic and single-line. Do not place a multiline Quick facts paragraph in Product schema; split it into target customer, key benefit, key ingredients, customer reviews, and reported details instead. Put actual usage instructions in HowTo or the generated usage section, not as a separate use-context property.

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

## OCR Sentence Diagnostics and English RAG Use

OCR output should be treated as source text evidence, not as a keyword bag. When the source contains OCR `lines`, `blocks`, `paragraphs`, `text`, or `sentenceInsights`, reconstruct semantically complete sentences by joining headings with their related body copy and keeping ingredient, benefit, usage, and review claims intact.

Classify each OCR sentence by intent before generation:

- Ingredient or technology: ingredient names, active complexes, formula systems, full ingredient lists, patented technology, or brand science.
- Benefit or effect: hydration, barrier support, sebum control, firming, elasticity, soothing, texture, resilience, visible results, or other source-backed efficacy language.
- Usage or routine: application timing, order, amount, routine pairing, or step-by-step directions.
- Customer or review language: repeated customer phrases, texture reactions, satisfaction, comfort, absorption, or skin-feel comments.

Store this analysis in diagnostics as sentence-level metadata such as `ocrSentences[].text`, `ocrSentences[].intents`, `ocrSentences[].schemaFields`, and `ocrSentences[].geoUse`. These diagnostics guide generation and review, but the labels themselves must not appear in public JSON-LD or HTML.

Use classified OCR sentences as supporting source evidence that blends with other RAG chunks, product facts, review language, and mapped fields. Do not create separate OCR-only benefit, ingredient, or FAQ content when broader product/RAG evidence is available.

When OCR data is absent, keep the same blended generation strategy using mapped product facts, selected RAG chunks, source text, full ingredient data, usage instructions, and customer review language.

Blend classified OCR sentence meaning into:

- `Product.description` and `WebPage.description` with answer-ready product, benefit, ingredient, texture, and comparison context.
- `Product.additionalProperty` values such as Key ingredients, Ingredient/effect detail, Full ingredients, skin type, texture, and technology. Usage instructions should live in HowTo or usage content, not as a separate use-context fact.
- Benefit sections and FAQ answers with varied topic, benefit, ingredient, texture, and comparison language.
- `HowTo.step` only when the OCR sentence describes a real usage action.

For English output, rewrite Korean or multilingual OCR meaning into natural English commerce language. Preserve the claim, ingredient, usage, and evidence hierarchy; do not translate word-for-word if it creates stiff or broken sentences. Full ingredients detected from OCR should be represented as complete ingredient information when available. Image URLs, file names, broken URL fragments, OCR artifacts, and diagnostic labels should be excluded from public schema/content.

## Description Pattern

Descriptions should be rewritten into diverse, answer-ready product content, not copied mechanically.
Avoid shallow descriptions that only say the page "organises information" or that the product is simply a "hydration serum". A strong Product description should expose the target customer, major benefit keywords, key ingredients or technologies, routine fit when it improves the product story, representative customer review language, and any supported clinical, satisfaction, or reported-result detail.

Good structure:

`[Product name] is a [product type] for [target customer or concern] that helps [core benefits] with [ingredient/technology]. [Source-supported or review-backed detail] explains [specific outcome or routine fit].`

Korean example structure:

`60년 인삼 연구로 완성된 [제품명]은 [대상 고민]을 위한 [제품 유형]으로, [핵심 성분/기술]을 통해 [효능]을 돕습니다. [임상/만족도/고객 리뷰에서 반복되는 표현]을 바탕으로 [사용 루틴], [사용감], [비교 기준]을 구체적으로 설명합니다.`

English example structure:

`[Product name] is a [product type] for [target concern] that supports [benefits] with [ingredient/technology]. Clinical details or repeated customer review language highlight [specific outcome] in [usage context].`

The language may change, but the structure must remain fact-first.

## FAQ Best Practice

Generate FAQ from customer intent and product evidence. Mix factual questions with shopping-decision questions.
Do not copy visible PDP FAQ questions and answers into `FAQPage.mainEntity` as-is. Treat page FAQ as one evidence source, then reconstruct the final question set from GEO intent patterns, repeated customer review language, product benefit/effect facts, ingredient or technology facts, usage context, and selected RAG guidance.

Recommended FAQ types:

- Effectiveness: "What skin concerns does this product address?"
- Ingredient/technology: "What are the key ingredients?"
- Customer review intent: "What do customer reviews highlight about texture, absorption, hydration, or other repeated details?"
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

Answers should contain concise, reusable product facts with varied benefit, ingredient, review, and use-context wording. Include metrics only when they exist in the input evidence. Do not invent study populations, durations, rankings, or regulatory claims.

## HowTo Best Practice

HowTo steps must be complete actions, not keyword fragments.
Rewrite source usage text into answer-ready steps. Remove source section labels such as "How to use", deduplicate repeated instructions, and add benefit, key active, texture, or routine details only when they improve search/answer usefulness without making every step repetitive.

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

## Korean Reference Artifact Usage

The artifact below is kept as a verbatim quality benchmark for a Korean premium skincare PDP. Use it to understand graph depth, sentence specificity, evidence density, FAQ intent breadth, and HowTo completeness.

When generating English output from this Korean best-practice reference:

- Preserve the information architecture: `WebSite`, locale-aware `WebPage`, canonical `Product`, rich `additionalProperty`, high-intent `FAQPage`, and complete `HowTo`.
- Preserve the sentence quality pattern: product identity first, research or ingredient basis second, benefit or use case third, and source-supported detail last.
- Rewrite Korean expressions into natural English commerce language. Do not translate word-for-word when it makes the sentence stiff.
- Keep the current project rule that `WebPage.description` and `Product.description` should be distinct. If a reference artifact uses product-heavy WebPage copy, adapt it into broader page-level coverage in new outputs.
- Treat Korean clinical, award, renewal, and comparison claims as structure examples only. Do not reuse those claims unless the target product source contains the same evidence.
- Use customer-intent FAQ style from the reference: efficacy, ingredients, variant comparison, suitability, duration, pairing, discontinued product guidance, comparison with adjacent products, professional-care context, award verification, gift suitability, and natural-language customer concern questions.

## Reference Output From Amoremall/Sulwhasoo Example (Verbatim)

```json
{"@context":"https://schema.org","@graph":[{"@type":"WebSite","@id":"https://www.amoremall.com/#website","url":"https://www.amoremall.com","name":"아모레몰","alternateName":"AMOREMALL","publisher":{"@type":"Organization","name":"아모레퍼시픽","alternateName":"Amorepacific"}},{"@type":"WebPage","@id":"https://www.amoremall.com/kr/ko/product/detail?onlineProdSn=62167#webpage-ko","url":"https://www.amoremall.com/kr/ko/product/detail?onlineProdSn=62167","name":"설화수 자음생크림","description":"60년 인삼 연구로 완성된 설화수 자음생크림은 피부 자생력을 채워 탄력, 밀도, 리프팅을 한 번에 케어하는 럭셔리 안티에이징 크림입니다.","inLanguage":"ko-KR","isPartOf":{"@id":"https://www.amoremall.com/#website"},"mainEntity":{"@id":"#Sulwhasoo-Concentrated-Ginseng-Rejuvenating-Cream"}},{"@type":"WebPage","@id":"https://www.amoremall.com/kr/en/product/detail?onlineProdSn=62167#webpage-en","url":"https://www.amoremall.com/kr/en/product/detail?onlineProdSn=62167","name":"Sulwhasoo Concentrated Ginseng Rejuvenating Cream","description":"Completed through 60 years of ginseng research, Sulwhasoo Concentrated Ginseng Rejuvenating Cream is a luxury anti-aging cream that replenishes skin's self-regenerating power for firmness, density, and lifting in one step.","inLanguage":"en-US","isPartOf":{"@id":"https://www.amoremall.com/#website"},"mainEntity":{"@id":"#Sulwhasoo-Concentrated-Ginseng-Rejuvenating-Cream"}},{"@type":"Product","@id":"#Sulwhasoo-Concentrated-Ginseng-Rejuvenating-Cream","name":"설화수 자음생크림","alternateName":"Sulwhasoo Concentrated Ginseng Rejuvenating Cream","description":"60년 인삼 연구로 완성된 설화수 자음생크림은 피부 자생력을 채워 탄력, 밀도, 리프팅을 한 번에 케어하는 럭셔리 안티에이징 크림입니다. 희귀 인삼 사포닌을 6,000배 농축한 진세노믹스™는 피부 콜라겐을 회복-재건-유지하여 자생력을 채워주고 진생펩타이드™는 피부의 탄력 인자를 강화하여 고밀도 피부를 선사합니다.","brand":{"@type":"Brand","name":"설화수","alternateName":"Sulwhasoo"},"manufacturer":{"@type":"Organization","name":"아모레퍼시픽","alternateName":"Amorepacific"},"category":"스킨케어 > 크림 > 안티에이징 크림","audience":{"@type":"PeopleAudience","suggestedMinAge":30,"audienceType":"안티에이징 케어가 필요한 30-60대 이상 연령대","suggestedGender":"female"},"offers":[{"@type":"Offer","name":"자음생크림 50ml","sku":"111174672","price":"270000","priceCurrency":"KRW","availability":"https://schema.org/InStock","itemCondition":"https://schema.org/NewCondition","priceValidUntil":"2026-12-31"},{"@type":"Offer","name":"자음생크림 30ml","sku":"111174671","price":"168000","priceCurrency":"KRW","availability":"https://schema.org/InStock","itemCondition":"https://schema.org/NewCondition","priceValidUntil":"2026-12-31"}],"award":"10년 연속 No.1 안티에이징 크림 (2015-2024년 Beauté Research SAS 한국 프레스티지 마켓 매출 기준)","additionalProperty":[{"@type":"PropertyValue","name":"기능성 인증","value":"식품의약품안전처 인증 주름개선 기능성 화장품"},{"@type":"PropertyValue","name":"효능","value":"피부 탄력 강화, 주름 개선, 보습, 피부 자생력 강화, 피부 밀도, 리프팅, 장벽 리페어, 안티에이징, 영양, 윤기 케어, 항산화"},{"@type":"PropertyValue","name":"추천 피부 타입","value":"모든 피부 타입 (민감 피부 사용 적합 테스트 완료)"},{"@type":"PropertyValue","name":"텍스처","value":"부드럽고 산뜻한 고밀도 텍스처, 맑고 소프트하게 마무리되어 데일리 사용 적합"},{"@type":"PropertyValue","name":"향","value":"인삼 한 그루의 에너지가 담긴 인삼 꽃향. 인삼 밭의 신선함과 인삼 꽃의 맑고 싱그러운 활력에서 영감을 받은 향"},{"@type":"PropertyValue","name":"주요 성분","value":"진세노믹스™ (6,000배 농축 희귀 인삼 사포닌: 피부 콜라겐 회복-재건-유지), 진생펩타이드™ (인삼 추출 펩타이드 + 5가지 펩타이드: 탄력 인자 33% 강화), 비타민C 유도체 (피부 항산화력 집중 강화, 자음생크림 타입 전용)"},{"@type":"PropertyValue","name":"설화수 인삼 과학","value":"60년 인삼 연구로 완성한 젊음의 솔루션. 1,000g 중 1g만 존재하는 희귀 인삼 사포닌에 첨단 과학 기술을 접목하여 피부의 장수(Skin Longevity)를 추구합니다."},{"@type":"PropertyValue","name":"임상 결과 요약","value":"피부 노화지수 -25% 개선 (25~55세 여성 31명, 4주), 이마 주름 -36.6% 개선 (25~55세 여성 33명, 8주), 탄력 +59.2% / 리프팅 +103.5% (4주 자가 평가), 콜라겐 발현율 38% 복구 (48시간, In vitro), 사용 중단 1주 후에도 탄력 및 팔자주름 개선 지속 (35~55세 여성 33명)"},{"@type":"PropertyValue","name":"4주 사용 만족도","value":"피부 장벽 강화 100%, 탄력·생기 개선 100%, 깊은 주름 완화 100% (소비자 만족도 결과)"},{"@type":"PropertyValue","name":"피부과 관리 시너지","value":"관리 전 외부 자극 방어력 197.6% 개선 (4주 자가 평가), 관리 후 장벽 리페어 1.3배·탄력 시너지 2.1배 (크림 2주 + 피부과 관리 + 크림 2주, 30~60세 여성 30명, 대조군 대비)"},{"@type":"PropertyValue","name":"시너지 효과","value":"윤조에센스 병행: 피부 방어력·컨디션 개선 100% 만족. 자음생캡슐세럼 병행: 영양 96.0%, 힘 93.5%, 탄력 90.5% 만족. 자음생크림 & 리치 집중 케어 8주: 노화 지수 -80.0%, 수분 볼륨 +52.1%, 주름 -53.4% (29~55세 여성 31명)"},{"@type":"PropertyValue","name":"자음생크림 vs 자음생크림 리치","value":"공통: 진세노믹스™ & 진생펩타이드™, 탄력/밀도/리프팅 개선. 자음생크림: 산뜻한 고밀도 텍스처, 비타민C 유도체 함유, 항산화 특화. 자음생크림 리치: 영양감 풍부한 리치 텍스처, 진생레티놀™ 함유, 방어력 특화."},{"@type":"PropertyValue","name":"리뉴얼 안내 (2024년 9월)","value":"클래식→자음생크림 리치, 소프트→자음생크림으로 리뉴얼. 기존 클래식/소프트 단종."},{"@type":"PropertyValue","name":"선물 추천","value":"생일, 어버이날, 명절, 기념일 등 특별한 날 선물용. 설화수 시그니처 포장 서비스 '지함보' 이용 가능 (매장별 상이)"}]},{"@type":"FAQPage","@id":"https://www.amoremall.com/kr/ko/product/detail?onlineProdSn=62167#faq","mainEntity":[{"@type":"Question","name":"자음생크림은 어떤 피부 고민에 효과가 있나요?","acceptedAnswer":{"@type":"Answer","text":"탄력 저하, 주름, 피부 밀도 감소 등 노화 징후에 효과적입니다. 피부 노화지수 -25%, 이마 주름 -36.6%, 리프팅 +103.5%의 임상 결과를 기록했으며, 눈가·팔자·이마·미간·목 부위 주름 완화에 도움을 줍니다."}},{"@type":"Question","name":"자음생크림의 핵심 성분은 무엇인가요?","acceptedAnswer":{"@type":"Answer","text":"세 가지 핵심 성분으로 구성됩니다. 진세노믹스™는 희귀 인삼 사포닌을 6,000배 농축하여 콜라겐을 회복-재건-유지합니다. 진생펩타이드™는 인삼 추출 펩타이드와 5가지 펩타이드로 탄력 인자를 33% 강화합니다. 비타민C 유도체는 자음생크림 타입 전용으로 항산화력을 강화합니다."}},{"@type":"Question","name":"자음생크림과 자음생크림 리치의 차이점은 무엇인가요?","acceptedAnswer":{"@type":"Answer","text":"두 제품 모두 진세노믹스™와 진생펩타이드™를 함유하지만 텍스처와 특화 성분이 다릅니다. 자음생크림은 산뜻한 고밀도 텍스처에 비타민C 유도체를 함유해 항산화·데일리 사용에 적합합니다. 자음생크림 리치는 영양감 풍부한 리치 텍스처에 진생레티놀™을 함유해 방어력 강화에 특화되어 있습니다."}},{"@type":"Question","name":"자음생크림은 민감한 피부도 사용할 수 있나요?","acceptedAnswer":{"@type":"Answer","text":"네, 민감 피부 사용 적합 테스트를 완료하여 민감성 피부도 안심하고 사용 가능합니다. 밀도·탄력·리프팅 고효능을 유지하면서 피부 자극을 최소화했습니다."}},{"@type":"Question","name":"자음생크림의 효과는 얼마나 지속되나요?","acceptedAnswer":{"@type":"Answer","text":"사용 중단 1주 후에도 탄력 및 팔자주름 개선 효과가 지속됩니다 (35~55세 여성 33명 인체 적용 시험). 48시간 만에 콜라겐 발현율 38% 복구(In vitro)와 함께 장기적인 피부 자생력 강화를 제공합니다."}},{"@type":"Question","name":"자음생크림을 다른 제품과 함께 사용하면 효과가 더 좋아지나요?","acceptedAnswer":{"@type":"Answer","text":"네, 시너지 효과가 있습니다. 윤조에센스 병행 시 방어력·컨디션 개선 100% 만족, 자음생캡슐세럼 병행 시 영양 96.0%·탄력 90.5% 만족, 자음생크림 & 리치 집중 케어 8주 시 노화 지수 -80.0%·주름 -53.4% 개선 효과를 보였습니다."}},{"@type":"Question","name":"자음생크림 클래식과 소프트는 어디서 구매할 수 있나요?","acceptedAnswer":{"@type":"Answer","text":"2024년 9월 리뉴얼로 단종되었습니다. 기존 클래식 사용자는 '자음생크림 리치'를, 소프트 사용자는 '자음생크림'을 구매하시면 됩니다."}},{"@type":"Question","name":"자음생크림과 탄력크림 EX 중 어떤 것을 선택해야 하나요?","acceptedAnswer":{"@type":"Answer","text":"자음생크림은 60년 인삼 과학 기반의 프리미엄 안티에이징으로 탄력·밀도·리프팅·깊은 주름을 집중 케어합니다. 탄력크림 EX는 28년 스테디셀러 웰에이징 제품으로 건조함과 푸석함으로 인한 탄력 저하에 보습·진정·장벽 리페어를 케어합니다. 노화 징후가 신경 쓰이기 시작한 분은 자음생크림, 탄력 기본기를 채우고 싶은 분은 탄력크림 EX를 추천합니다."}},{"@type":"Question","name":"피부과 관리 전후에 자음생크림을 사용해도 되나요?","acceptedAnswer":{"@type":"Answer","text":"네, 관리 전 사용 시 외부 자극 방어력 197.6% 개선, 관리 후 장벽 리페어 1.3배·탄력 시너지 2.1배 효과를 보였습니다 (30~60세 여성 30명, 대조군 대비). 단, 피부 상태에 따라 전문의와 상담 후 사용을 권장합니다."}},{"@type":"Question","name":"자음생크림이 10년 연속 1위라는 것은 사실인가요?","acceptedAnswer":{"@type":"Answer","text":"네, 2015년부터 2024년까지 10년 연속 No.1 안티에이징 크림으로 선정되었습니다 (Beauté Research SAS 한국 프레스티지 마켓 매출 기준, 자음생크림 컬렉션 전체 대상)."}},{"@type":"Question","name":"자음생크림은 선물용으로 적합한가요?","acceptedAnswer":{"@type":"Answer","text":"네, 생일·어버이날·명절·기념일 등 특별한 날 럭셔리 안티에이징 선물로 적합합니다. 설화수 시그니처 포장 서비스 '지함보'를 이용하면 선물의 품격을 높일 수 있습니다 (매장별 상이)."}},{"@type":"Question","name":"나이 들면서 피부 탄력과 주름이 신경 쓰이기 시작했어요","acceptedAnswer":{"@type":"Answer","text":"자음생크림은 60년 인삼 과학의 진세노믹스™와 진생펩타이드™가 피부의 근본적인 자생력을 채워주고, 무너진 피부 구조를 케어해 탄력과 밀도를 개선합니다. 콜라겐 회복·유지를 도와 주름을 완화하며, 탄력·밀도·리프팅을 한 번에 관리합니다."}},{"@type":"Question","name":"산뜻한 텍스처의 안티에이징 크림을 찾고 있어요","acceptedAnswer":{"@type":"Answer","text":"자음생크림은 부드럽고 산뜻한 고밀도 텍스처로 맑고 소프트하게 마무리되어 데일리 사용에 적합합니다. 비타민C 유도체가 항산화력을 강화하며, 더 리치한 텍스처를 원하시면 자음생크림 리치를 추천합니다."}},{"@type":"Question","name":"한방·인삼 기반의 럭셔리 스킨케어 크림을 찾고 있어요","acceptedAnswer":{"@type":"Answer","text":"자음생크림은 60년 인삼 연구 기반의 인삼 과학으로 피부의 표면적 노화를 넘어 근본적인 힘과 자생력을 케어합니다. 희귀 인삼 사포닌 6,000배 농축 진세노믹스™로 피부 콜라겐을 회복·재건·유지합니다."}}]},{"@type":"HowTo","@id":"https://www.amoremall.com/kr/ko/product/detail?onlineProdSn=62167#howto","name":"설화수 자음생크림 올바른 사용법","description":"자음생크림의 효과를 극대화하는 3단계 마사지 사용법","totalTime":"PT3M","step":[{"@type":"HowToStep","position":1,"name":"꼬집기 마사지","text":"적당량을 덜어 얼굴 전체에 펴 바른 후, 엄지와 검지를 구부려 턱부터 볼까지 가볍게 꼬집듯이 당겨줍니다."},{"@type":"HowToStep","position":2,"name":"리프팅 마사지","text":"반 주먹을 쥐고 관자 부위부터 이마 가운데까지 끌어올려 줍니다."},{"@type":"HowToStep","position":3,"name":"마무리 프레스","text":"한 손은 이마, 다른 손은 턱을 감싸주듯 지그시 누른 후 마무리합니다."}]}]}
```

## Cross-Product Benchmarking Guidance

Adding more best-practice artifacts from other products can improve retrieval quality, but only when they are source-backed examples rather than invented templates.

Recommended additional reference types:

- Ingredient-led serum: strong for ingredient mechanism, clinical metric, texture, layering, and review-language FAQ patterns.
- Hydration or barrier cream: strong for sensitive-skin suitability, usage routine, skin-type matching, and soft claim wording.
- Sunscreen or tone-up base: strong for regulatory claims, finish/texture, reapplication HowTo, and shade or use-case comparison.
- Hair or scalp product: strong for routine order, target concern segmentation, before/after evidence, and usage frequency.
- Fragrance or body product: strong for sensory description, occasion-based CEP, gifting, and variant comparison.

Each future artifact should include the full JSON-LD reference plus a short English adaptation note explaining which structural and writing-quality patterns should transfer to other products.
