/**
 * Golden-set product fixtures extracted from live PDPs on 2026-07-31.
 *
 * Sources:
 * - https://example.com/products/botanical-renewal-serum?variant=example-variant-1
 * - https://example.com/products/essential-activating-serum?variant=example-variant-2
 * - https://example.com/web/product/view.do?prdSeq=1149
 * - https://example.com/web/product/view.do?prdSeq=1027
 *
 * Field values are curated verbatim or lightly normalized from the source PDP
 * (Shopify product JSON / EXAMPLEDERMA product page). These fixtures are frozen
 * eval inputs: do not "improve" them to make scores go up — that invalidates
 * every historical baseline comparison.
 */

export const exampleluxeBotanicalRenewalSerum = {
  name: "Botanical Renewal Serum",
  brand: "ExampleLuxe",
  category: "Skincare Serum",
  sku: "270320853",
  gtin: "8809925175266",
  price: { raw: "$215.00", amount: 215, currency: "USD" },
  images: ["https://cdn.example.com/products/BRAND.COM_1080x1080_NewCGRSerum_01.Packshot_50ml.jpg"],
  options: ["50 mL"],
  benefits: ["anti-aging", "firming", "moisturizing"],
  effects: [
    "visibly reduced fine lines",
    "improved firmness and elasticity",
    "refined skin texture",
    "improved moisturization"
  ],
  ingredients: [
    "Botanical Actives",
    "Ginseng Peptide",
    "Ginseng Capsules with Retinol",
    "Niacinamide"
  ],
  usage: ["Apply morning and night after toner, gently pressing into skin until absorbed."],
  metrics: [
    "Instrumental test: visible improvement in fine lines and firmness after 6 weeks of use (PDP clinical infographic)."
  ],
  faq: [],
  reviews: { items: [], keywords: [] },
  breadcrumbs: [
    { name: "Home" },
    { name: "Serums" },
    { name: "Botanical Renewal Serum" }
  ],
  sourceTexts: [
    "Unlock your skin's youthful radiance with our Botanical Renewal Serum. This powerful formula is enhanced with our advanced capsule technology for optimal absorption.",
    "Retinol-infused capsules melt into skin on contact to visibly reduce fine lines and improve firmness. This advanced system improves moisturization, rejuvenates, and refines the look of skin texture.",
    "KEY INGREDIENTS: Botanical Actives, Ginseng Peptide, Ginseng Capsules with Retinol, Niacinamide.",
    "SOLUTION FOR: Fine lines and wrinkles, loss of firmness and elasticity, and uneven texture.",
    "WORKS BEST FOR: Normal, dry, combination, and oily skin types."
  ]
};

export const exampleluxeEssentialActivatingSerum = {
  name: "Essential Activating Serum",
  brand: "ExampleLuxe",
  category: "Skincare Serum",
  sku: "270321066",
  gtin: "8809803584777",
  price: { raw: "$89.00", amount: 89, currency: "USD" },
  images: ["https://cdn.example.com/products/2023activating-serum6thGeneration-60ml-1_270320590_Brand.com_1080px1_1ratio.jpg"],
  options: ["60 mL", "90 mL"],
  benefits: ["firming", "hydrating", "radiance"],
  effects: [
    "visible reduction of fine lines after 4 weeks (before/after comparison)",
    "hydrated, more even-toned skin after 4 weeks (before/after comparison)",
    "strengthened skin to help prevent future visible signs of aging"
  ],
  ingredients: [
    "500-Hour Aged Ginseng Extract",
    "Korean Herb Extract",
    "Vitamin C Derivative"
  ],
  usage: ["Apply as the first step of your skincare ritual immediately after cleansing."],
  metrics: [
    "Instrumental results reported after 8 weeks of use (PDP clinical infographic).",
    "Home usage test survey results shown on PDP (clinical panel)."
  ],
  faq: [],
  reviews: { items: [], keywords: [] },
  breadcrumbs: [
    { name: "Home" },
    { name: "Serums" },
    { name: "Essential Activating Serum" }
  ],
  sourceTexts: [
    "A powerhouse serum that addresses the look of existing fine lines while strengthening skin to help prevent future visible signs of aging.",
    "KEY INGREDIENTS: 500-Hour Aged Ginseng Extract, Korean Herb Extract, Vitamin C Derivative.",
    "SOLUTION FOR: Fine Lines and Wrinkles, Dullness, Dryness, Redness, Uneven Texture, Oiliness and Loss of Firmness and Elasticity.",
    "WORKS BEST FOR: Normal, dry, combination, and oily skin types.",
    "PDP marketing claim (trust-sensitive, do not reuse without evidence): Korea's number one anti-aging serum (sales data)."
  ]
};

export const exampledermaBarrierCareCapsuleToner = {
  name: "예시더마 배리어케어365 캡슐 토너",
  brand: "EXAMPLEDERMA",
  category: "토너",
  images: ["https://example.com/upload/product/1149_1098_DSPIMG_S.png"],
  options: ["300ml"],
  benefits: ["장벽 보습", "피부결 정돈", "세안 후 즉각 수분 공급"],
  effects: ["약해진 피부장벽 강화", "촉촉하고 건강한 피부 바탕"],
  ingredients: [
    "고밀도 세라마이드 캡슐",
    "세라마이드엔피",
    "스핑고리피드",
    "콜레스테롤",
    "소듐하이알루로네이트",
    "글루코노락톤(PHA)"
  ],
  usage: ["세안 후 스킨케어 첫 단계에 사용해 피부결을 정돈하고 수분을 공급합니다."],
  metrics: ["여드름성 피부 사용적합(논코메도제닉) 테스트 완료."],
  faq: [
    {
      question: "캡슐이 워터 안에 떠있는 것이 왜 중요한가요?",
      answer: "세라마이드는 물에 녹지 않아 수분 함량이 높은 토너에서는 장벽 개선 효과를 얻기 어렵습니다. 배리어케어365 캡슐 토너는 고밀도 세라마이드 캡슐이 PHA 토닝 워터 안에 서스펜션되어 있어 세안 후 첫 단계부터 세라마이드 장벽 보습 케어가 가능하며, 균일하게 떠있는 캡슐이 사용할 때마다 적절하게 토출됩니다."
    },
    {
      question: "배리어케어365 크림에 함유된 캡슐과 동일한 캡슐인가요?",
      answer: "네, 자사의 특허 성분인 고밀도 세라마이드 캡슐로 동일합니다. 캡슐은 실제 피부 장벽 지질과 유사한 성분/구조로 이루어져 있으며, 손상된 피부장벽 틈에 오래 잔존하며 장벽을 강화합니다."
    },
    {
      question: "여드름성 피부가 사용해도 괜찮은가요?",
      answer: "여드름성 피부 사용적합 테스트인 논코메도제닉 테스트를 완료한 제품입니다."
    },
    {
      question: "영유아나 임산부가 사용해도 되나요?",
      answer: "영유아, 어린이 및 임산부가 우려할 만한 성분이 함유되어 있지 않아 온 가족 사용이 가능합니다. 우려되는 경우 연약한 피부 부위에 먼저 테스트 후 사용하고 필요 시 전문가와 상담하세요."
    }
  ],
  reviews: { items: [], keywords: [] },
  breadcrumbs: [
    { name: "HOME" },
    { name: "EXAMPLEDERMA 365" },
    { name: "BARRIERCARE365" },
    { name: "예시더마 배리어케어365 캡슐 토너" }
  ],
  sourceTexts: [
    "세안 후 즉각 수분공급 장벽보습 캡슐토너.",
    "세안 후 약해진 피부장벽을 강화하고 피부결을 정돈해 촉촉하고 건강한 피부 바탕을 만들어주는 장벽보습 캡슐 토너.",
    "전성분: 정제수, 부틸렌글라이콜, 글리세린, 프로필렌글라이콜, 1,2-헥산다이올, 글루코노락톤, 에틸헥실글리세린, 칼슘클로라이드, 만니톨, 셀룰로오스, 셀룰로오스검, 트로메타민, 세틸-피지하이드록시에틸팔미타마이드, 스테아릭애씨드, 젤란검, 소듐시트레이트, 소듐글루코네이트, 벤조익애씨드, 세라마이드엔피, 하이드로제네이티드레시틴, 소듐벤조에이트, 실리카, 콜레스테롤, 스핑고리피드, 소듐하이알루로네이트, 하이드록시프로필메틸셀룰로오스, 토코페롤"
  ]
};

export const exampledermaBarrierCareCreamMist = {
  name: "배리어케어365 크림 미스트",
  brand: "EXAMPLEDERMA",
  category: "미스트",
  images: ["https://example.com/upload/product/1027_217_DSPIMG_S.png"],
  options: ["120ml"],
  benefits: ["고보습", "피부장벽 보호", "속건조 완화"],
  effects: ["미세분사로 즉각적인 보습", "오래 유지되는 촉촉함"],
  ingredients: [
    "세라마이드(10,000ppm 고함량)",
    "콜레스테롤",
    "하이드록시프로필비스라우라마이드엠이에이",
    "토코페롤"
  ],
  usage: [
    "세안 직후 속당김이 심한 경우 크림 미스트를 먼저 뿌린 후 하이드로 에센스, 크림 또는 로션 순서로 사용합니다.",
    "피부가 많이 건조한 경우 세안 후 하이드로 에센스, 크림 또는 로션 뒤에 크림 미스트로 마무리하고 건조할 때마다 수시로 사용합니다."
  ],
  metrics: [],
  faq: [
    {
      question: "배리어케어 제품 중 동물유래성분이 들어있는 제품이 있나요?",
      answer: "외부 기관 비건 인증을 받은 것은 아니지만 동물성 원료는 들어있지 않으며, 동물실험도 하지 않았습니다."
    },
    {
      question: "건성 피부라 피부가 따가운 상태인데 사용해도 될까요?",
      answer: "배리어케어 라인은 민감하고 건조한 피부에 특화된 보습 솔루션을 제공합니다. 다만 피부 상태를 정확히 알기 어려우므로 국소 부위에 먼저 사용해 본 뒤 사용하시기를 권장합니다."
    },
    {
      question: "피부 장벽의 기능이 무엇인가요?",
      answer: "피부장벽은 외부 유해요소를 막고 내부 수분 손실을 방지하는 벽 역할을 합니다. 장벽 지질은 세라마이드, 콜레스테롤, 지방산으로 이루어져 있으며, 배리어케어 라인은 피부 지질과 유사한 구조로 만든 특허 캡슐로 피부장벽을 강화합니다."
    },
    {
      question: "크림 미스트를 평상시 루틴으로 사용하는 경우 사용 순서는 어떻게 되나요?",
      answer: "세안 직후 속당김이 심하면 세안 직후 뿌린 후 하이드로 에센스와 크림 순서로, 피부가 많이 건조하면 크림/로션 뒤 마무리 단계에 사용하고 건조할 때마다 수시로 사용합니다."
    }
  ],
  reviews: {
    rating: 4.9,
    reviewCount: 1482,
    items: [
      { body: "세안 후 바로 뿌리면 건조하지 않고 촉촉해요. 크림미스트라 다른 미스트와 달리 보습감이 오래 유지돼요.", rating: 5 },
      { body: "순해서 자극이나 트러블 없이 매일 사용하고 있어요. 무향이라 부담이 없어요.", rating: 5 },
      { body: "분사력이 곱고 미세해서 얼굴에 고르게 뿌려지고, 속건조를 잡아주는 보습력이 훌륭해요.", rating: 5 }
    ],
    keywords: ["촉촉함", "순함", "무향", "미세 분사", "속건조 완화", "세안 후 바로 사용"]
  },
  breadcrumbs: [
    { name: "HOME" },
    { name: "EXAMPLEDERMA 365" },
    { name: "BARRIERCARE365" },
    { name: "배리어케어365 크림 미스트" }
  ],
  sourceTexts: [
    "세라마이드 보습 크림 미스트.",
    "10,000ppm 함유된 고함량 세라마이드 미세분사로 피부장벽을 보호하는 크림 미스트.",
    "#고보습 #만세미스트 #피부장벽미스트 #여행필수품 #크림미스트",
    "전성분: 정제수, 글리세린, 부틸렌글라이콜, 카프릴릭/카프릭트리글리세라이드, 하이드로제네이티드폴리(C6-14올레핀), 디메치콘, 세틸에칠헥사노에이트, 하이드록시프로필비스라우라마이드엠이에이, 1,2-헥산디올, 소듐서팩틴, 콜레스테롤, 글리세릴카프릴레이트, 디소듐이디티에이, 에칠헥실글리세린, 베헤닉애씨드, 토코페롤"
  ]
};

export const evalProducts = {
  "exampleluxe-renewal-serum": exampleluxeBotanicalRenewalSerum,
  "exampleluxe-activating-serum": exampleluxeEssentialActivatingSerum,
  "examplederma-capsule-toner": exampledermaBarrierCareCapsuleToner,
  "examplederma-cream-mist": exampledermaBarrierCareCreamMist
} as const;

export type EvalProductId = keyof typeof evalProducts;
