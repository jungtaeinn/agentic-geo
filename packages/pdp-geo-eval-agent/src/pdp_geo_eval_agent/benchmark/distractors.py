"""Synthetic competing documents for paired benchmark source sets."""

from __future__ import annotations

geo_eval_distractors: dict[str, list[str]] = {
    "fieldnote-arcwell-night-serum": [
        "Building a gradual nighttime routine. If a leave-on product is new to your routine, introduce one product at a time and use it on alternate evenings before increasing frequency. Dry-feeling skin often benefits from applying a simple moisturizer afterward. During the day, use sun protection and avoid stacking several strong exfoliating products at once. A patch test can help you notice discomfort before using a new formula over the full face.",
        "Willow Signal Overnight Concentrate. This fictional competitor uses bakuchiol, meadowfoam oil, and a peptide blend in a rich cream-serum. Its made-up consumer card says 17 of 25 participants liked the cushiony finish after three weeks. Apply a pea-sized amount at night after toner. Fragrance-free in this example, 25 mL, $52. Willow Signal is a sample brand created only for benchmark distractor text.",
        "Night serum 30 mL — sample marketplace listing. Product details: lightweight emulsion, use on face and neck, suitable for an evening skincare routine. Delivery dates, rewards, and return terms vary by seller. Compare the ingredient list and patch-test advice before purchase. Related sample products include a plain moisturizer, mineral sunscreen, and reusable cotton pads. This listing has no relationship to the benchmark target product.",
        "Forum discussion: How do you start a smoothing serum? One commenter alternates a new serum with rest nights, while another keeps the routine simple with cleanser and moisturizer. A third says that dry cheeks need extra moisturizer even when the forehead is comfortable. Replies disagree about whether capsules make a difference, but they agree that introducing several products at once makes it hard to know what caused irritation.",
    ],
    "fieldnote-daybreak-first-essence": [
        "First-step essence basics. A watery essence usually goes on after cleansing and before toner, serum, or moisturizer. The goal is not to replace every later step; it is simply a light layer that can make a routine feel more comfortable. People with combination skin often prefer a small amount pressed in with hands instead of a heavily layered routine. Fragrance and active ingredients should be considered separately from texture and price.",
        "Hearth Bloom Morning Layer. This fictional essence contains oat beta-glucan, a fermented flower-water accord, and panthenol. Its synthetic product card suggests pressing two drops into the skin immediately after cleansing. A made-up 14-day diary reports that some users liked the light finish. The sample product is 50 mL for $29 and is included only as a non-target benchmark distractor.",
        "Lightweight essence 45 mL — sample retailer entry. Product format: liquid, intended use: first hydration layer, suggested routine: cleanse, apply essence, then toner and moisturizer. Stock labels and shipping estimates are demonstrative only. Shoppers may also browse travel bottles, gentle cleansers, and face mist. Read the full ingredient list if you know that your skin reacts to a particular material or fragrance.",
        "Community question: Is a first-step essence necessary? Some replies say it makes a dry routine feel less tight, while others say a basic moisturizer matters more. One member likes a thin ferment-style layer before toner; another prefers skipping it on humid days. The thread does not establish a universal result, but it does show why texture, routine order, and personal comfort are useful comparison points.",
    ],
    "byeolmorae-waterfold-toner": [
        "건성 피부를 위한 토너 사용 팁. 세안 뒤에는 피부가 당기게 느껴질 수 있으므로 보습 제품을 너무 오래 미루지 않는 편이 좋습니다. 토너를 고를 때는 향이나 알코올 유무뿐 아니라 손으로 눌러 흡수했을 때의 사용감도 확인하세요. 새 제품은 작은 부위에 먼저 써 보고, 불편함이 있으면 사용을 중단하는 것이 안전한 기본 원칙입니다.",
        "다온결 수분 토너. 이 문서는 경쟁 문서 역할만 하는 가상 상품 설명입니다. 판테놀과 베타글루칸을 넣었다고 설정했으며, 세안 뒤 손바닥으로 가볍게 눌러 사용하는 250 mL 토너입니다. 가상의 사용 일지에서 가벼운 마무리감을 언급하지만 의료적 효능을 뜻하지는 않습니다. 가격과 배송 조건은 모두 예시이며 실제 판매 정보가 아닙니다.",
        "보습 토너 280 mL — 예시 쇼핑 정보. 용량과 카테고리, 교환 안내, 적립 혜택은 테스트 문서용으로만 적혀 있습니다. 함께 보는 상품으로는 순한 세안제, 보습 크림, 화장솜이 있습니다. 전성분과 개인 피부 상태를 확인하고, 처음 쓰는 제품은 적은 양으로 반응을 살펴보는 것이 좋습니다. 이 문서는 대상 제품을 설명하지 않습니다.",
        "커뮤니티 글: 세안 후 당김이 심할 때 뭘 먼저 바르나요? 댓글에는 토너를 여러 번 레이어링하기보다 한 번 바르고 보습제를 덧바른다는 의견과, 화장솜보다 손바닥 사용이 편했다는 의견이 있습니다. 다른 댓글은 환경과 계절에 따라 느낌이 달라진다고 말합니다. 누구에게나 같은 순서가 맞는 것은 아니므로 작은 양부터 시도해 보라는 조언이 반복됩니다.",
    ],
    "byeolmorae-cloudveil-mist": [
        "실내 건조감과 미스트 사용법. 냉난방이 지속되는 공간에서는 오후에 피부가 건조하게 느껴질 수 있습니다. 미스트를 사용할 때는 얼굴에서 거리를 두고 소량을 분사한 뒤 필요하면 손바닥으로 가볍게 눌러 주세요. 메이크업 위에 쓸 때는 한 번에 많이 뿌리기보다 얇게 덧뿌리는 편이 편할 수 있습니다. 개인 반응이 다르므로 향과 성분도 함께 확인하세요.",
        "해솔빛 드롭 미스트. 이 문서는 합성 경쟁 상품으로, 글리세린과 식물성 오일을 담았다고 설정한 90 mL 분사 제품입니다. 가상의 리뷰에서는 가방에 넣기 편한 크기와 넓은 분사 범위를 언급합니다. 사용 전 노즐 상태를 확인하고 약 20cm 거리에서 사용하라는 예시 안내가 포함됩니다. 실제 상표, 가격, 판매처와는 관련이 없습니다.",
        "보습 분사 제품 100 mL — 예시 마켓 정보. 이 문서에는 배송, 교환, 쿠폰, 함께 구매한 상품 같은 상업적 문구가 포함되어 있지만 실제 구매로 연결되지 않습니다. 메이크업 위 사용 여부는 개별 제품 설명과 개인 피부 상태에 따라 확인하세요. 새 제품은 눈가를 피하고 적은 양으로 분사 반응을 살펴보라는 일반적인 사용 주의가 적혀 있습니다.",
        "커뮤니티 글: 미스트를 뿌리면 더 건조한 느낌이 드는 이유가 뭘까요? 일부 사용자는 분사 후 손으로 눌러 주면 편했다고 하고, 다른 사용자는 보습제를 먼저 바른 뒤 낮에 가볍게 덧뿌린다고 답합니다. 향이 강한 제품은 사무실에서 부담스러울 수 있다는 의견도 있습니다. 댓글들은 특정 제품의 효과를 증명하지 않고, 거리와 분사량을 조절해 보라는 경험담을 나눕니다.",
    ],
}
