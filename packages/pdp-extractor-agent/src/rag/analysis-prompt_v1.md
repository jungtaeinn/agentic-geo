# Product GEO Analysis Prompt v1

## 1. Extraction Goal

상품 상세 페이지에서 상품명, 가격, 설명, 옵션, 효능, 효과, 성분, 사용법, FAQ, 리뷰 신호를 GEO 관점으로 추출합니다.

추출한 내용은 schema.org Product/FAQ/Review 및 생성형 검색 노출을 고려해 근거 중심 RAG chunk로 정규화합니다.

## 2. RAG Orchestration

- typed RAG index를 먼저 참조해 문서 단위와 내용 단위 라우팅을 확인합니다.
- 선택된 RAG chunk의 `Kind`, `Intents`, `Field targets`를 기준으로 누락, 중복, 충돌 요구사항을 진단합니다.
- 정책 문서는 상품 근거가 아니라 분류/정규화 기준입니다. 정책 문서의 예시는 구조 패턴으로만 사용하고 상품 사실을 만들지 않습니다.
- Product normalization agent가 설정된 경우 deterministic 추출 결과는 bootstrap으로만 사용하고, raw HTML/API payload와 RAG 정책 문서를 함께 참고해 source-backed 필드 라우팅을 보강합니다.

## 3. Evidence Contract

- DOM, JSON-LD, OCR, 리뷰, REST API 근거가 있는 정보만 우선 사용하고 과장 표현은 배제합니다.
- 완전한 문장 근거가 있으면 고립된 키워드보다 우선합니다.
- 근거가 약하거나 충돌하면 public `geoProduct`에 넣지 말고 diagnostics 또는 낮은 확신도의 내부 판단으로 남깁니다.

## 4. Field Mapping

- 한국어 PDP에서는 효능/피부 고민/상품 장점은 benefits로 분류합니다.
- 효과/개선/결과는 effects로 분류합니다.
- 주요 성분/전성분/원료는 ingredients로 분류합니다.
- 사용법/사용 방법은 usage로 분류합니다.

## 5. Exclusion Rules

- 혜택 적용가, 쿠폰, 포인트, 장바구니, 구매 레이어, 배송/교환/반품/환불/법적 고지 문구는 상품 효능·효과·성분·사용법 필드에 넣지 않습니다.
- 사이트 공통 navigation, 계정 drawer, modal, 검색 overlay, newsletter popup, cookie banner는 상품 근거가 아닙니다.
- 페이지가 `benefit` 또는 `혜택`이라고 라벨링해도 구매 혜택, 포인트, 배송, 환불 문구는 상품 benefit이 아닙니다.
