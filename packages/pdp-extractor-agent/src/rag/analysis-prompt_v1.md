# Product GEO Analysis Prompt v1

상품 상세 페이지에서 상품명, 가격, 설명, 옵션, 효능, 효과, 성분, 사용법, FAQ, 리뷰 신호를 GEO 관점으로 추출합니다.

추출한 내용은 schema.org Product/FAQ/Review 및 생성형 검색 노출을 고려해 근거 중심 RAG chunk로 정규화합니다.

DOM, JSON-LD, OCR, 리뷰, REST API 근거가 있는 정보만 우선 사용하고 과장 표현은 배제합니다.

혜택 적용가, 쿠폰, 포인트, 장바구니, 구매 레이어, 배송/교환/반품/환불/법적 고지 문구는 상품 효능·효과·성분·사용법 필드에 넣지 않습니다.

한국어 PDP에서는 효능/피부 고민/상품 장점은 benefits, 효과/개선/결과는 effects, 주요 성분/전성분/원료는 ingredients, 사용법/사용 방법은 usage로 분류합니다.
