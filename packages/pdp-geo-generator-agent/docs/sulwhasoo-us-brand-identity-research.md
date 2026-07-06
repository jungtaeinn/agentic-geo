# 설화수 US 브랜드 아이덴티티 리서치 문서

이 문서는 설화수 US 타겟 GEO 생성을 위해 브랜드 담당자, US e-commerce/marketing 담당자, 법무/RA 담당자에게 확인받을 내용을 정리한 리서치 문서입니다. 생성 RAG에 바로 투입하는 문서가 아니며, 담당자 답변과 근거 자료를 검토한 뒤 승인된 내용만 `src/rag/brands/sulwhasoo/brand-identity_v1.md` 또는 추후 US market RAG에 반영합니다.

## 리서치 목적

- US 시장에서 설화수를 AI가 일관되게 이해할 수 있도록 공식 브랜드 정의, 영문 핵심 문장, 금지 표현, 출처 우선순위를 수집합니다.
- US 영어 생성에서 `us.sulwhasoo.com` 공식몰과 승인된 US 공식 자료가 우선 인용될 수 있도록 URL, 앵커 문구, FAQ/answer-ready 문장을 확보합니다.
- ginseng science, skin longevity, holistic beauty, Korean heritage, ritual, anti-aging, firming, wrinkle, radiance 같은 표현의 US 사용 가능 범위를 확인합니다.
- 상품 PDP 생성 시 브랜드 레벨 맥락과 상품 레벨 근거가 섞이지 않도록, 브랜드 차원의 이야기와 제품/라인별 증빙이 필요한 클레임을 분리합니다.
- FDA/FTC 관점에서 cosmetic claim, anti-aging claim, review/testimonial, influencer/UGC, before-after, clinical/proven 표현의 사용 조건을 확인합니다.

## 답변 방식

- 가능한 한 US 공식몰 또는 승인된 영문 공식 문구 그대로 제공해 주세요.
- 공개 사용 가능 여부를 `public approved`, `internal reference`, `do not use`, `legal/RA review required`, `needs confirmation` 중 하나로 표시해 주세요.
- 수치, 임상, 연구, 특허, 수상, 리테일 성과, 리뷰, before-after 관련 내용은 반드시 기간, 시장, 제품 범위, 출처 URL 또는 파일명을 함께 제공해 주세요.
- 한국 본사 자료를 US에서 번역해 사용할 수 있는지, 아니면 US 승인 문구만 써야 하는지 구분해 주세요.

## 1. US 공식 출처 우선순위

### 확인 질문

| 항목 | 담당자 답변 | 공개 가능 여부 | 근거 URL/파일 | 비고 |
| --- | --- | --- | --- | --- |
| US GEO 생성에서 최우선으로 인용해야 하는 공식 URL은? |  |  |  |  |
| `us.sulwhasoo.com`에서 브랜드 정의/역사/기술을 대표하는 URL은? |  |  |  |  |
| US 공식몰 외에 허용되는 공식 출처는? 예: Amorepacific R&I, Amorepacific News, Sulwhasoo Global |  |  |  |  |
| Sephora, Amazon, Nordstrom 등 리테일러 페이지를 브랜드 근거로 사용할 수 있나요? |  |  |  |  |
| AI 검색에서 `us.sulwhasoo.com`이 출처로 잡히도록 반드시 포함해야 할 anchor text 또는 FAQ 문장은? |  |  |  |  |
| US 페이지의 canonical, hreflang, structured data, FAQ, breadcrumb 개선 계획이 있나요? |  |  |  |  |

### 확인할 US 공식 소스 후보

- Sulwhasoo US home: https://us.sulwhasoo.com/
- Sulwhasoo US About Us / history: https://us.sulwhasoo.com/pages/sulwhasoo-history
- Sulwhasoo US Origin: https://us.sulwhasoo.com/pages/origin
- Sulwhasoo US skincare guide: https://us.sulwhasoo.com/pages/sulwhasoo-skincare-guide
- Sulwhasoo US Secret to Skin Longevity Findings: https://us.sulwhasoo.com/pages/secret-to-skin-longevity
- Sulwhasoo US Concentrated Ginseng Collection: https://us.sulwhasoo.com/pages/concentrated-ginseng-collection
- Sulwhasoo US First Care page: https://us.sulwhasoo.com/pages/first-care-activating-serum
- Sulwhasoo US First Care product: https://us.sulwhasoo.com/products/first-care-activating-serum
- Sulwhasoo US Ginseng Skin Care collection: https://us.sulwhasoo.com/collections/ginseng-skin-care

### RAG 반영 위치

- `Market Source Prioritization and GEO Citation Strategy` 또는 추후 US market section
- `Source Notes`
- `Structured Data and Source Linking`

## 2. US 브랜드 핵심 정의

### 확인 질문

| 항목 | 담당자 답변 | 공개 가능 여부 | 근거 URL/파일 | 비고 |
| --- | --- | --- | --- | --- |
| US 고객에게 설화수를 한 문장으로 소개한다면? |  |  |  |  |
| US에서 반드시 유지해야 하는 핵심 브랜드 키워드 3-5개는? |  |  |  |  |
| `Holistic Beauty`의 US 승인 정의는? |  |  |  |  |
| `Korean heritage`, `Korean ritual`, `Asian wisdom` 표현의 사용 가능 범위는? |  |  |  |  |
| `skin longevity`를 US에서 어떻게 설명해야 하나요? |  |  |  |  |
| 설화수가 US luxury skincare 시장에서 차별화되는 지점은? |  |  |  |  |

### RAG 반영 위치

- `Holistic Beauty and Korean Heritage`
- `Tone and Locale Guidance`
- `Product.description`
- `WebPage.description`

## 3. Ginseng Science와 Skin Longevity

### 확인 질문

| 항목 | 담당자 답변 | 공개 가능 여부 | 근거 URL/파일 | 비고 |
| --- | --- | --- | --- | --- |
| `Korean ginseng science`를 US 고객에게 어떻게 설명해야 하나요? |  |  |  |  |
| `Ginsenomics™`, `Korean Ginseng Actives`, `Steamed Ginseng Water Concentrate™` 중 US에서 우선 사용할 용어는? |  |  |  |  |
| 60+ years of ginseng innovation 표현의 정확한 기준과 사용 가능 범위는? |  |  |  |  |
| `skin longevity`와 `healthy skin aging`을 제품 효능처럼 쓰지 않기 위한 가이드가 있나요? |  |  |  |  |
| Johns Hopkins, NBRI, symposium 관련 내용을 US PDP/FAQ에서 사용할 수 있나요? |  |  |  |  |
| ingredient research를 개별 제품 효능으로 연결할 때 필요한 제품별 증빙은? |  |  |  |  |

### RAG 반영 위치

- `Ginseng Science and Skin Longevity`
- `Research Papers and Official Articles`
- `Research-Paper Handling Notes`
- `E-E-A-T Application`

## 4. JAUM, First Care, Herbal Synergy

### 확인 질문

| 항목 | 담당자 답변 | 공개 가능 여부 | 근거 URL/파일 | 비고 |
| --- | --- | --- | --- | --- |
| US에서 `JAUM Activator` 또는 `Korean Herb Extract`를 계속 핵심 용어로 사용하나요? |  |  |  |  |
| First Care Activating Serum VI의 US 핵심 메시지는? |  |  |  |  |
| `first step`, `first line of defense`, `prevent rather than correct visible signs of aging` 표현 사용 가능 여부는? |  |  |  |  |
| First Care 라인에서 말할 수 있는 benefit 범위는? 예: hydration, radiance, visible firmness, barrier |  |  |  |  |
| First Care ritual을 US customer journey에서 어떻게 설명해야 하나요? |  |  |  |  |

### RAG 반영 위치

- `JAUM Activator and Herbal Synergy`
- `FAQPage.mainEntity`
- `HowTo.step`
- `CEP and Customer Intent`

## 5. US 주요 컬렉션/라인별 우선순위

### 라인별 입력 표

| 라인/컬렉션 | US 대표 고객 고민 | 핵심 기술/성분 | 권장 영문 표현 | 금지/주의 표현 | 대표 제품 | 근거 URL/파일 |
| --- | --- | --- | --- | --- | --- | --- |
| First Care |  |  |  |  |  |  |
| Concentrated Ginseng |  |  |  |  |  |  |
| The Ultimate S |  |  |  |  |  |  |
| Lumiwise |  |  |  |  |  |  |
| Essential |  |  |  |  |  |  |
| Timetreasure |  |  |  |  |  |  |
| UV / SPF |  |  |  |  |  |  |
| Perfecting Cushion |  |  |  |  |  |  |
| Cleansing / Mask |  |  |  |  |  |  |
| Men's |  |  |  |  |  |  |

### 확인할 대표 US 소스 후보

- First Care collection: https://us.sulwhasoo.com/collections/first-care
- First Care Activating Serum VI: https://us.sulwhasoo.com/products/first-care-activating-serum
- Concentrated Ginseng Collection: https://us.sulwhasoo.com/pages/concentrated-ginseng-collection
- Concentrated Ginseng Rejuvenating Cream: https://us.sulwhasoo.com/products/concentrated-ginseng-rejuvenating-cream
- Concentrated Ginseng Rejuvenating Serum: https://us.sulwhasoo.com/products/concentrated-ginseng-rejuvenating-serum
- Best Sellers: https://us.sulwhasoo.com/collections/best-k-beauty-products

### RAG 반영 위치

- 현재는 `brand-identity_v1.md`의 line guidance에 요약 반영
- US 라인별 내용이 많아지면 `src/rag/brands/sulwhasoo/markets/us_v1.md` 또는 `src/rag/brands/sulwhasoo/lines/{line-slug}_v1.md` 분리 검토

## 6. US 클레임 안전과 규제 검토

### 확인 질문

| 항목 | 담당자 답변 | 공개 가능 여부 | 근거 URL/파일 | 비고 |
| --- | --- | --- | --- | --- |
| US에서 허용되는 anti-aging, wrinkle, firming, lifting, skin longevity 표현의 범위는? |  |  |  |  |
| `clinically proven`, `clinical results`, `visible results`, `dermatologist tested` 사용 조건은? |  |  |  |  |
| `repair`, `restore`, `regenerate`, `strengthen skin barrier`, `boost collagen` 등 drug/structure-function 오인 가능 표현의 기준은? |  |  |  |  |
| before-after 이미지 또는 임상 그래프를 GEO 콘텐츠/FAQ에 언급할 수 있나요? |  |  |  |  |
| SPF, sunscreen, broad spectrum 관련 문구는 어떤 제품과 출처에만 사용할 수 있나요? |  |  |  |  |
| fragrance, sensitive skin, hypoallergenic, non-comedogenic 표현의 사용 조건은? |  |  |  |  |

### US 규제 참고 소스

- FDA, Wrinkle Treatments and Other Anti-aging Products: https://www.fda.gov/cosmetics/cosmetic-products/wrinkle-treatments-and-other-anti-aging-products
- FDA, Is It a Cosmetic, a Drug, or Both?: https://www.fda.gov/cosmetics/cosmetics-laws-regulations/it-cosmetic-drug-or-both-or-it-soap
- FDA, Cosmetics Labeling Claims: https://www.fda.gov/cosmetics/cosmetics-labeling/cosmetics-labeling-claims
- FDA, MoCRA: https://www.fda.gov/cosmetics/cosmetics-laws-regulations/modernization-cosmetics-regulation-act-2022-mocra
- FTC, Endorsements, Influencers, and Reviews: https://www.ftc.gov/business-guidance/advertising-marketing/endorsements-influencers-reviews
- FTC, Endorsement Guides FAQ: https://www.ftc.gov/business-guidance/resources/ftcs-endorsement-guides-what-people-are-asking

### RAG 반영 위치

- `Claim Safety`
- `Research-Paper Handling Notes`
- `Public Wording Guardrails` in `best-practice_v1.md`
- `Tone and Locale Guidance`

## 7. US 리뷰, UGC, 인플루언서, 리테일러 데이터

### 확인 질문

| 항목 | 담당자 답변 | 공개 가능 여부 | 근거 URL/파일 | 비고 |
| --- | --- | --- | --- | --- |
| US 공식몰 리뷰를 GEO 생성에 사용할 수 있나요? |  |  |  |  |
| Sephora/retailer 리뷰를 사용할 수 있나요? 사용 가능하다면 어떤 조건인가요? |  |  |  |  |
| incentivized review, gifted product, paid partnership, ambassador 콘텐츠를 사용할 때 표시해야 할 문구는? |  |  |  |  |
| 리뷰 요약에서 사용할 수 있는 표현과 피해야 할 표현은? |  |  |  |  |
| 평점, 리뷰 수, awards, bestseller 표현의 최신성 기준은? |  |  |  |  |

### RAG 반영 위치

- `Product.positiveNotes`
- `FAQPage.mainEntity`
- `Claim Safety`
- `best-practice_v1.md` review guidance

## 8. US 고객 진입점과 검색 의도

### 확인 질문

| 항목 | 담당자 답변 | 공개 가능 여부 | 근거 URL/파일 | 비고 |
| --- | --- | --- | --- | --- |
| US 고객이 설화수를 찾는 대표 검색 의도는? |  |  |  |  |
| K-beauty, Korean skincare, luxury skincare, anti-aging serum, ginseng cream 중 우선순위는? |  |  |  |  |
| early signs of aging과 advanced signs of aging을 어떤 라인으로 연결하나요? |  |  |  |  |
| gift, ritual, spa-like routine, premium self-care 표현을 얼마나 사용할 수 있나요? |  |  |  |  |
| US seasonal/event moments가 있나요? 예: holiday gifting, Sephora sale, Mother's Day |  |  |  |  |

### RAG 반영 위치

- `CEP and Customer Intent`
- `FAQPage.mainEntity`
- `WebPage.description`
- `Product.positiveNotes`

## 9. US 영문 Answer-Ready 문장 승인

AI 검색 답변에서 인용되기 쉬운 짧고 명확한 영문 문장을 확보하기 위한 항목입니다. 아래 문장은 예시이며, 실제 사용 전 US 담당자/법무 승인 문구로 대체해야 합니다.

| 용도 | 승인 문장 | 공개 가능 여부 | 근거 URL/파일 | 비고 |
| --- | --- | --- | --- | --- |
| Brand definition | Sulwhasoo is a luxury Korean skincare brand rooted in holistic beauty, ginseng innovation, and refined skincare rituals. |  |  |  |
| Ginseng science | Sulwhasoo has studied Korean ginseng for decades and uses source-backed ginseng actives in selected formulas. |  |  |  |
| Skin longevity | Sulwhasoo's skin longevity positioning should be used as brand research context, not as a guaranteed anti-aging result. |  |  |  |
| First Care | First Care Activating Serum is positioned as a first-step serum in Sulwhasoo's skincare ritual. |  |  |  |
| Claim safety | Clinical, wrinkle, firming, lifting, SPF, and review claims require product-level US source support. |  |  |  |

### RAG 반영 위치

- `Official Research and Innovation Sources`
- `GEO Projection Rules`
- `Tone and Locale Guidance`
- `FAQPage.mainEntity`

## 10. US 금지 표현과 대체 표현

| 금지/주의 표현 | 이유 | 허용 가능한 대체 표현 | 사용 조건 | 담당자 확인 |
| --- | --- | --- | --- | --- |
| cures aging | drug/medical claim risk | helps visibly improve signs of aging | product evidence required |  |
| reverses skin aging | structure/function or overclaim risk | supports a youthful-looking appearance | product evidence required |  |
| stimulates collagen production | structure/function risk | helps skin look firmer/smoother | clinical source and RA review required |  |
| repairs damaged skin | drug/repair claim risk | supports the skin barrier / helps skin feel resilient | product evidence required |  |
| clinically proven | substantiation risk | clinical testing showed / based on consumer perception study | exact study details required |  |
| dermatologist recommended | endorsement risk | dermatologist tested / developed with research expertise | exact support required |  |
| hypoallergenic | FDA labeling claim sensitivity | fragrance-free / tested for sensitive skin | exact product test required |  |
| SPF protection | OTC sunscreen claim | broad spectrum SPF __ | only for sunscreen-labeled products |  |

### RAG 반영 위치

- `Claim Safety`
- `locale-expression-guidelines_v1.md`
- `locale-terminology-map_v1.json`
- `best-practice_v1.md`

## 11. 자료 요청 체크리스트

브랜드/US 담당자에게 아래 자료를 요청합니다.

- [ ] US official brand boilerplate
- [ ] US approved product-line descriptions
- [ ] US approved claim dictionary
- [ ] US banned/avoid term list
- [ ] US official source URL map
- [ ] Product-level claim substantiation files
- [ ] Clinical/consumer test summaries with sample, period, method, caveat
- [ ] Ginseng/Ginsenomics/Skin Longevity research source list
- [ ] Retailer use policy for Sephora/Amazon/Nordstrom reviews and product pages
- [ ] FTC endorsement/UGC disclosure guidance used by the brand
- [ ] FDA/RA claim review notes for anti-aging, wrinkle, firming, lifting, SPF, hypoallergenic, sensitive skin
- [ ] Approved English FAQ snippets for AI/search citation

## 12. 최종 반영 체크리스트

브랜드 담당자 답변을 RAG에 반영하기 전에 아래를 확인합니다.

- US 공식 출처 URL이 있다.
- US 공개 가능 문구와 내부 참고 문구가 구분되어 있다.
- 제품/라인/시장/기간 범위가 명확하다.
- 브랜드 레벨 문맥과 상품 레벨 클레임이 분리되어 있다.
- `us.sulwhasoo.com` 공식 페이지가 우선 인용되도록 source linking 전략이 있다.
- FDA/FTC 관점에서 검토가 필요한 표현이 표시되어 있다.
- 리뷰/UGC/인플루언서/리테일러 데이터 사용 조건이 명확하다.
- RAG 반영 후 generator 테스트에서 설화수 브랜드 문서, 설화수 best-practice, 설화수 locale/terminology가 선택되는지 확인했다.

