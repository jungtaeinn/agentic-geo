# EXAMPLEDERMA Locale Expression Guidelines v1

This brand-scoped locale guide extends the default locale-expression-guidelines document for EXAMPLEDERMA PDP GEO generation. Use it only when the normalized product brand, hint, or product name maps to EXAMPLEDERMA / 예시더마. When active, it replaces the default locale expression guide; general schema, E-E-A-T, CEP, GEO research, official-docs, best-practice, and terminology guidance still apply.

## Brand-Specific Locale Overlay

- `ko-KR`: Prefer practical dermocosmetic language such as 피부 장벽, 장벽 케어, 민감 피부, 고보습, 진정감, 저자극, 데일리 보습 when supported. Avoid 질환 치료, 아토피 치료, 여드름 치료, 처방 수준, 완치 unless the source explicitly supports a compliant claim.
- `ja-JP`: Prefer clear sensitive-skin wording such as バリア機能, 敏感肌にも使いやすい, 高保湿, 低刺激設計, 乾燥ケア, デイリーケア when supported. Avoid 治療, アトピー改善, ニキビ治療, 医薬品-like claims.
- `en-US`: Prefer clear dermocosmetic wording such as skin barrier support, sensitive-skin friendly, high-moisture care, low-irritation feel, daily barrier routine, and comfort for dry skin when supported. Avoid eczema treatment, acne treatment, prescription-strength, cure, or disease-improvement claims.
- `en-GB`: Prefer practical wording such as skin barrier support, sensitive-skin friendly, high-moisture care, daily barrier routine, and dry-skin comfort when supported.

For EXAMPLEDERMA `ko-KR` public copy:

- Prefer `[정확한 상품명]의 주요 성분은 ...입니다` over `주요 성분은 ...입니다` when the sentence may be quoted independently.
- Prefer natural component-role wording such as `제품의 구성성분인 [성분]이 [효능]을 돕습니다` only when the source explicitly links the component and outcome. Otherwise separate the ingredient fact from the finished-product benefit.
- Use `특히` and `또한` to join supported ingredient explanations naturally; retain `원료적 특성에 한함` when that qualifier exists.
- Accept a technology/formula only when the source contains a complete name. A dependent expression such as a predicate ending captured before `기술` is relationship context, not a technology name; restore the full supported relation or omit it. Keep composition and subcomponent structure as complete clauses instead of forcing `... 적용되어 있고`.
- Turn a clinical field sequence into a sentence such as `[기관]이 [기간] 동안 [대상]을 대상으로 진행한 [시험 방법]에서 [지표]는 사용 전 [값], 사용 직후 [값], 사용 12시간 후 [값]으로 각각 측정되었습니다.` Preserve the original wording of the population and all dates/numbers.
- For comparison charts, attach every group or area label to its own value and connect the timed product result in the same evidence sentence. Remove OCR check marks, footnote symbols, chart headings, and detached number order from the public wording.
- FAQ questions must name the exact product and ask, in buyer language, about the product's main benefits together with whether disclosed human-application test results exist — never as `이 제품` or `이 크림`, and never as a request for the underlying evidence record itself. Preferred example: `공개된 인체적용시험 결과는 어떻게 나타났나요?` when finished-product test results exist; omit the evidence clause when they do not. Do not phrase the question as a request for the internal evidence record itself — that exposes the generation pipeline's sourcing apparatus rather than asking what a buyer would ask; avoid `상품 근거` in public questions.
- In FAQ answers, turn the selected clinical outcome into a reason for the stated recommendation: `[시험 주체/기간]의 완제품 인체적용시험에서 [결과]가 확인되었습니다. 이 결과는 [고객 고민과 연결된 효능]을 뒷받침합니다.` Keep the long population/method detail in evidence fields when it interrupts the customer answer.
- Prefer direct product voice such as `[상품명]은 ... 테스트를 진행했습니다`, `... 고객에게 추천할 수 있습니다`, and `... 사용을 권장합니다`. Avoid `설명됩니다`, `안내됩니다`, and full ingredient/effect inventories that read like extracted fields.
- In `WebPage.description`, introduce the product page once, then switch to the exact product, customer need, formula, study, testing, offer, or review as the sentence subject. Do not repeat `페이지 본문에서는`, `페이지에서 확인할 수 있는`, or `페이지에 공개된`.
- Generate a product-first opening that identifies the exact product page and EXAMPLEDERMA while previewing only the supported decision context. Avoid the tautology `EXAMPLEDERMA의 [상품명] 상품 페이지는 크림 상품을 소개합니다`; do not copy one replacement sentence across products.
- Express supported routine timing with the product as subject and a natural recommendation predicate; keep dispensing, spreading, patting, and absorption actions in HowTo.
- If depth, duration, or other outcomes explicitly share one finished-product study group, connect them as one proof sequence with the common trial stated once and every timing/value preserved. Never join nearby values without the shared evidence group, and vary the syntax to match the actual endpoints.
- Write completed sensitive-skin tests as support for only their stated safety scope, keep the current option and its matching price in one natural offer sentence, and close with two to four positive review-backed experience terms. Attribute the experience to customers and the exact product without falling back to a bare `언급됩니다` list.
- Do not end the testing block with a meta statement such as `참고할 수 있는 시험 정보입니다`; express only the bounded tested scope supported by the named tests. In the review close, use a direct customer evaluation such as 긍정적으로 평가했습니다 or 리뷰했습니다 when the source sentiment supports it, while varying the final syntax naturally.
- Prefer a CEP-led target sentence such as `[상품명]은 유분이 많지만 수분이 부족한 [근거가 있는 피부 유형] 고객을 위한 크림입니다` when every concern and audience atom is supported. Introduce the formula next and state supported benefits after it. Do not manufacture the contrast when either oil or dehydration evidence is missing.
