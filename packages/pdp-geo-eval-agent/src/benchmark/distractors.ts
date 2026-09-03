import type { EvalProductId } from "./fixtures";

/**
 * Fixed competitor/context documents for the citation-visibility benchmark.
 *
 * Each golden builds a 5-source set: 4 distractors below + the target slot
 * (vanilla PDP text or generated PDP text). The distractors are FROZEN eval
 * inputs, same rule as `fixtures/products.ts`: do not edit them to make
 * scores move — that invalidates every historical baseline comparison.
 *
 * Style coverage per product (mirrors real retrieval competition):
 *   [0] generic category blog post (broad advice, no specific product)
 *   [1] fictional competitor product page (brand names are invented on
 *       purpose — never replace them with real competitor brands)
 *   [2] marketplace listing (terse specs + shipping noise)
 *   [3] community forum thread (unstructured opinions)
 *
 * Language matches each product's locale so the engine competes fairly.
 */

export const geoEvalDistractors: Record<EvalProductId, string[]> = {
  "exampleluxe-cgr-serum": [
    // [0] generic category blog
    "How to build an anti-aging routine in your 40s. Fine lines and loss of firmness come from slower cell turnover and reduced collagen production. Dermatologists usually recommend introducing a retinoid gradually, starting two nights a week, and always pairing it with a moisturizer to reduce irritation. Look for supporting ingredients like peptides and niacinamide, which help with elasticity and tone. Whatever serum you choose, consistency for at least eight weeks matters more than price. Always finish your morning routine with sunscreen, since retinoids increase sun sensitivity.",
    // [1] fictional competitor product page
    "DermaVale Age-Reverse Peptide Serum. A concentrated night serum formulated with 3% multi-peptide complex, bakuchiol, and squalane. Clinically tested for 4 weeks: 92% of participants reported smoother-feeling skin. Suitable for dry and normal skin types. Apply 2-3 drops in the evening after toner. Fragrance-free, vegan formula. 30 mL, $128. DermaVale Labs — skin science since 2011.",
    // [2] marketplace listing
    "Anti-Aging Facial Serum 50ml — In stock. Ships in 2-3 business days. Free returns within 30 days. Key specs: volume 50 ml, texture lightweight emulsion, for face and neck. Bestseller in Skin Care Serums. Customers also bought: eye cream, collagen mask sheet 10-pack, facial roller. Note: packaging may vary. Imported product; check ingredient label for allergies before use.",
    // [3] community forum thread
    "Forum thread: Best serum for fine lines? — I've tried maybe six serums this year and honestly most did nothing. The only thing that changed my skin was being consistent with retinol at night and drinking more water. Reply 1: Same, but capsule-type retinol products irritated me less than the plain ones. Reply 2: Whatever you pick, patch test first. My cheeks got red for a week from a strong one. Reply 3: Korean serums with ginseng are trendy now, anyone tried them long-term?"
  ],
  "exampleluxe-fcas-vi": [
    "What is an essence-serum and where does it fit in a Korean skincare routine? A first-step treatment goes on right after cleansing, before toner and moisturizer, when skin absorbs actives best. The idea is to prime skin so that the rest of your routine works harder. Common actives include fermented extracts, herbal complexes, and vitamin C derivatives for tone. If your skin is dull or rough, a booster like this is an easy first upgrade before buying more products.",
    "LumeCell First Essence Booster. A watery first-step essence with 80% fermented galactomyces, panthenol, and a vitamin C derivative for radiance. Dispense a coin-sized amount into palms and press into skin immediately after cleansing. Suitable for all skin types including combination skin. Dermatologist tested. 150 mL, $54. LumeCell — clean beauty, cruelty free.",
    "Essential Care Essence Serum 60ml — Limited stock. Ships from overseas warehouse, 5-9 business days. Specs: 60 ml / 90 ml options, use morning and evening, first step after cleansing. Frequently bought together: cotton pads, toner 200ml, travel pouch. Return policy: unopened items only. Authenticity guaranteed by the marketplace seller program.",
    "Forum thread: Do first-step serums actually do anything? — Skeptic here, isn't it just watery toner? Reply 1: For me the difference was texture over about a month, my base routine absorbed noticeably faster. Reply 2: They're glorified hydrators, save your money and buy sunscreen. Reply 3: Depends on the formula — the herbal fermented ones made my skin calmer, the fragrance-heavy ones broke me out. Reply 4: Four weeks in on a ginseng one and my tone looks more even, could be placebo though."
  ],
  "examplederma-capsule-toner": [
    "건성 피부 토너 고르는 법. 세안 직후에는 피부 수분이 빠르게 증발하기 때문에 3분 안에 첫 보습 단계를 올리는 것이 좋습니다. 건성이라면 알코올이 든 수렴 토너보다 보습 성분 중심의 토너를 고르세요. 세라마이드, 히알루론산, 판테놀이 대표적인 장벽 보습 성분입니다. 각질이 고민이라면 PHA처럼 자극이 덜한 각질 성분이 든 제품이 무난합니다. 어떤 토너든 손바닥으로 눌러 흡수시키는 편이 닦아내는 것보다 자극이 적습니다.",
    "루미더마 배리어 세라 토너. 세라마이드 5,000ppm과 판테놀, 마데카소사이드를 담은 약산성 보습 토너입니다. 피부과 테스트 완료, 민감성 피부 사용 가능. 세안 후 첫 단계에 화장솜 없이 손으로 흡수시켜 주세요. 무향, 무색소, 300ml, 28,000원. 루미더마 — 민감 피부를 위한 더마 코스메틱.",
    "장벽 보습 토너 300ml — 재고 있음. 오늘 주문 시 내일 도착. 상품 정보: 용량 300ml, 피부 타입 건성/민감성, 사용 부위 얼굴. 함께 많이 구매한 상품: 화장솜 200매, 수분 크림, 선크림. 리뷰 이벤트: 포토 리뷰 작성 시 적립금 지급. 교환/반품은 미개봉 상품에 한해 7일 이내 가능합니다.",
    "커뮤니티 글: 세안만 하면 얼굴이 쩍쩍 갈라지는데 토너 추천 좀. — 저는 그냥 물 많이 마시고 가습기 켰더니 나아졌어요. 댓글 1: 토너보다 세안제부터 순한 걸로 바꾸세요, 그게 반은 먹고 들어감. 댓글 2: 세라마이드 들어간 걸로 쓰는데 확실히 당김은 덜해요. 캡슐처럼 생긴 게 떠 있는 제품도 있던데 신기하더라고요. 댓글 3: 저자극이라고 다 순한 건 아니니까 전성분 보고 사세요."
  ],
  "examplederma-cream-mist": [
    "사무실 속건조 관리법. 냉난방이 계속 도는 실내에서는 피부 표면 수분이 빠르게 날아가 오후만 되면 당김과 들뜸이 생기기 쉽습니다. 수분 크림을 아침에 충분히 바르고, 낮에는 미스트로 수시로 보충하는 것이 기본입니다. 다만 수분만 있는 미스트는 증발하면서 오히려 더 건조해질 수 있어, 보습막을 만들어 주는 오일이나 지질 성분이 함께 든 제품이 유리합니다. 메이크업 위에 쓸 거라면 분사 입자가 고운지도 확인하세요.",
    "하이드로벨 워터풀 미스트. 제주 용암해수와 히알루론산 8종을 담은 수분 미스트입니다. 언제 어디서나 메이크업 위에도 산뜻하게. 흔들지 않고 20cm 거리에서 분사하세요. 전 피부 타입 사용 가능, 100ml, 15,000원. 하이드로벨 — 수분 과학의 기준.",
    "보습 미스트 120ml — 로켓배송. 상품 정보: 용량 120ml, 유형 미스트/스프레이, 얼굴·바디 겸용. 함께 보면 좋은 상품: 립밤, 핸드크림, 여행용 파우치. 판매자 공지: 겨울철 배송 중 어는 경우가 있으나 품질에는 이상이 없습니다. 미개봉 상품에 한해 교환/반품 가능.",
    "커뮤니티 글: 미스트 뿌리면 더 건조해지는 느낌인데 저만 그런가요? — 수분만 든 미스트는 원래 그래요, 증발하면서 피부 수분까지 데려감. 댓글 1: 크림 타입 미스트로 바꾸고 나서는 그런 느낌 없어졌어요. 댓글 2: 뿌리고 나서 손으로 살짝 눌러주면 훨씬 오래가요. 댓글 3: 향 있는 미스트는 사무실에서 눈치 보이니까 무향 추천. 댓글 4: 세라마이드 들어간 미스트도 있어요? 있으면 겨울에 딱일 듯."
  ]
};
