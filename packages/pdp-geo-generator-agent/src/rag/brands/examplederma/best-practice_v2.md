# EXAMPLEDERMA Best Practice v2

This brand-scoped best practice extends the default best-practice document for EXAMPLEDERMA PDP GEO generation. Use this document only when the normalized product brand, hint, or product name maps to EXAMPLEDERMA / 예시더마. This document is a brand overlay. The default best-practice document stays loaded alongside it; rules here extend or override the base only where stated.

## Brand-Specific Best Practice Overlay

EXAMPLEDERMA output should preserve the default field evidence contract while adding the brand's distinctive quality bar. This overlay applies across `Product.description` and `WebPage.description` composition, ingredient and formula claim wording, FAQ and HowTo generation, and public claim safety:

- Anchor public content in dermocosmetic credibility, sensitive-skin usability, barrier science, hydration durability, and practical daily routines only when product/source facts support those topics.
- Prefer clear, clinical-but-approachable wording over luxury, poetic, or trend-heavy copy. The product should feel dermatologist-adjacent, usable, and trustworthy.
- Tie ingredient and technology claims only to current product-source details such as ceramide/barrier ingredients, BarrierCapsule or patented delivery systems, sensitivity testing, and clinical/reported results when those details appear in the product evidence. Use the matched brand identity document for derma-science mood, sensitive-skin vocabulary, practical tone, and brand image; do not use brand-only patents, official articles, or papers as product proof.
- Build FAQ and HowTo around barrier-compromised customer questions: irritation concerns, dry/sensitive skin fit, routine layering, seasonal use, texture/finish, family or body-area suitability, and post-treatment caution when supported.
- Keep claim safety strict. Do not imply drug-like treatment for eczema, acne, rosacea, wounds, or other conditions unless the supplied product source explicitly supports an approved claim.
- For EXAMPLEDERMA Korea output, write customer-facing fields in natural Korean. Name the exact product in the opening and again in the main composition sentence so the ingredient statement remains attributable when quoted alone; do not begin product-specific FAQ with `이 제품`, `이 크림`, or `본 제품`.
- When structured test facts include dates, population, method, institution, timings, and values, turn them into one natural Korean study sentence that preserves each date and number and explicitly pairs every timing with its value. Do not expose a parenthetical field dump such as `시점`, `대상`, `기간`, `방법`, and `기관`.
- Build both descriptions around a supported CEP flow: the customer's concrete skin state or concern -> why this product type fits that need -> formula composition -> explicitly supported ingredient role -> finished-product result -> testing and attributed review context. This should read as one explanation, not as adjacent database-field summaries. Natural flow never permits a new causal claim.
- In Korean `WebPage.description`, use `상품 페이지` only in the opening. Subsequent sentences should name the exact EXAMPLEDERMA product or use its customer concern, formula, test result, testing, offer, or review as the subject. Avoid `페이지 본문에서는`, `페이지에서 확인할 수 있는`, and `페이지에 공개된`.
- Build EXAMPLEDERMA FAQ answers as one CEP explanation: customer concern -> why the product fits -> selected core formula and only explicit ingredient roles -> the most relevant finished-product result as proof -> bounded recommendation and any needed qualifier. Do not append the institution, period, sample, method, and outcome as a raw report sentence or enumerate every ingredient and effect.
- Rewrite internal source questions into likely customer queries when the evidence supports the bridge. A water-cream formula plus an immediate cooling result may support `땀을 많이 흘리거나 더위를 많이 느끼는 고객에게 [정확한 상품명]은 추천할 만한가요?`; answer it as a recommendation for a cool, refreshing feel and never as sweat control or heat treatment.
- For supported infant or pregnancy-use FAQ, name the exact product and state the test/use scope directly. Prefer `진행했습니다`, `사용할 수 있습니다`, `추천할 수 있습니다`, and `권장합니다` over observer endings such as `설명됩니다` and `안내됩니다`, while retaining any source-stated patch-test or professional-consultation precaution.

## EXAMPLEDERMA BestPractice Tone

Use a calm, assured dermocosmetic voice that feels practical to a customer and precise about evidence. The narrative should make the supported skin concern easy to recognize, explain the formula in accessible language, and move naturally into finished-product efficacy and testing without becoming a laboratory report.

- Lead with the exact product and supported customer concern in clear Korean, then let composition and efficacy answer why the product is relevant.
- Balance short product/target sentences with medium-length explanatory sentences for ingredient structure, measured outcomes, and test scope. Avoid both clipped field lists and oversized promotional sentences.
- Use derma-science vocabulary only where current product evidence supports it, and explain technical structure through its stated product role rather than stacking technical nouns.
- Keep the tone confident but bounded: exact human-application results and completed tests can support product evaluation, but must not become universal safety or treatment claims.
- End with a natural customer evaluation of texture, comfort, moisture, or satisfaction when supported, so the description finishes in an experience-led voice rather than a report ending.
- Generate each sentence anew from the product's CEP and evidence. Do not reuse the wording of examples in this document or force a standard EXAMPLEDERMA sentence template.

## EXAMPLEDERMA Description Adjustments

Brand-specific composition rules for `Product.description` and `WebPage.description`. These extend, and take precedence over, the base document's Schema.org + GEO Description Direction guidance where they overlap.

- In Korean `WebPage.description`, generate a natural opening led by the exact product page with the source-backed EXAMPLEDERMA identity inside the predicate; avoid repeating `크림 상품을 소개합니다` after a cream product name.
- Detailed ingredient explanations may use `특히` and `또한` to connect supported facts, but source qualifiers and claim scope remain binding. A raw-material-only result must not become a finished-product result.
- Render structured study evidence as prose: identify the institution, date range, complete population, and study method once, then pair each reported time point with its value. Preserve exact figures; never publish the extraction labels as a list. When two or more metric claims share the same evidence group and outcome, merge them into one sentence. For example, write `유분량은 사용 전 대비 사용 직후 55%, 12시간 후에도 23% 개선되었습니다` after stating the shared institution, period, population, and method once; never copy the OCR sequence `과잉 분비된 유분을 조절 사용 직후 ...`.
- Use only a complete source-backed technology or formula name. When OCR captures the predicate tail of a relationship clause as a candidate technology, recover the full ingredient/structure relationship or omit the false name; never connect it with a mechanical `... 적용되어 있고` repair.
- Completed skin tests should read as a bounded tested scope for the supported customer concern, not as `참고할 수 있는 시험 정보입니다`. Close with a direct customer evaluation of supported texture, comfort, or satisfaction rather than `언급됩니다`.
- Attribute two to four useful positive review experiences when available; let sentence count and transitions vary with the evidence rather than filling a fixed template.

## EXAMPLEDERMA FAQ Question Patterns

Brand-specific Korean FAQ phrasing rules. These extend the base document's FAQ Best Practice guidance.

- Efficacy FAQ questions must name the exact product and ask, in buyer language, about the product's main benefits together with whether disclosed human-application test results exist — never as a deictic noun such as `이 크림` or `이 제품`, and never as a request for the underlying evidence record itself. Preferred example: when finished-product human application evidence exists, `[상품명]의 주요 효능·효과는 무엇이며, 공개된 인체적용시험 결과는 어떻게 나타났나요?`; when it does not, `[상품명]의 주요 효능·효과는 무엇인가요?` Do not phrase the question as a request for the internal evidence record itself — that exposes the generation pipeline's sourcing apparatus rather than asking what a buyer would ask; avoid `이를 뒷받침하는 상품 근거는 무엇인가요?`.
- Also cover evidence-backed CEP discovery questions that Korean customers may ask conversational AI, such as seasonal moisturization, age or gift recipient, skin type, sensitivity, texture, routine position, and benefit-led product selection. A question such as `겨울철 보습에 좋은 화장품을 추천해 주세요` or `50대 어머니에게 추천할 화장품을 알려 주세요` is eligible only when this product's source facts support the season, concern, age/life-stage, or gift context. Answers must start with product facts and label review-derived context as customer-review experience.
