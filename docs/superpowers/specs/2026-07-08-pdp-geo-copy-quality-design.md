# PDP GEO 생성 카피 품질 보강 설계 (LLM 추론 기반)

- 날짜: 2026-07-08
- 대상 패키지: `packages/pdp-geo-generator-agent`
- 관련 파일: `src/copy-refiner.ts`, `src/generate.ts`(참조), `tests/`

## 1. 배경과 문제

에스트라 아토베리어365 캡슐 토너 실행 결과에서 다음 품질 문제가 확인되었다.

1. **WebPage.description 용량 파편**: 마지막 문장이 "…사용감 중심의 리뷰 맥락, 10.14 fl. oz. / 300 mL 용량을 함께 살펴볼 수 있습니다."처럼 이질적 사실의 콤마 나열로 끝나며 용량 문자열이 문장 흐름을 깨뜨림. 원인: (a) extractor가 용량 문자열을 review body로 잘못 추출한 오염, (b) 용량/규격 문자열을 description 나열에서 배제하는 프롬프트 규칙·게이트 부재.
2. **WebPage.description CEP 흐름 부재**: 페이지 소개 후 대상 고객 → 성분/기술 → 효능 → 리뷰 맥락이 자연스럽게 이어지지 않고 사실 나열로 구성됨.
3. **Product.description 분석 라벨 노출**: "사용 직후 시점 기준 평가 지표: 사용 직후는 93% 회복되었습니다." 원인: LLM 정제 결과가 품질 게이트(noun-stack)에서 **거절**되어 `generate.ts`의 결정론적 템플릿(`${context} 기준 평가 지표: ${metrics}`) 원문이 그대로 노출됨. LLM 실패가 아니라 **거절 시 폴백 경로**의 문제.
4. **Product.description CEP 흐름 부재**: 2와 동일한 요구가 Product.description에도 적용됨.
5. **FAQ 품질**:
   - 동일 여부 질문("아토베리어365 크림에 함유된 캡슐과 동일한 캡슐인가요?")에 네/아니요 없이 우회 답변.
   - 첫 FAQ가 추천 대상 질문이 아님.
   - FAQ 질문 리스트가 GenAI(ChatGPT/Gemini 등) 사용자의 실제 질문 의도와 정렬되어 있지 않아 인용 가능성이 낮음.
   - 현행 프롬프트는 "keep the same question intent and order"로 재정렬·재작성을 금지하고 있고, 적용 코드(`writeFaqAnswer`)는 인덱스 기반 답변 교체만 지원.

**제약**: 하드코딩(문자열 치환·고정 템플릿)으로 해결하지 않는다. 검출은 결정론적일 수 있으나 수정은 LLM 재추론으로 수행한다.

## 2. 설계 결정 (사용자 확정)

| 결정 | 선택 |
| --- | --- |
| 거절 필드 처리 | 거절 사유를 피드백으로 넣은 **2차 재정제 패스** 추가 |
| FAQ 재구성 범위 | **GenAI 질문 의도 기반 질문 재작성 + 재정렬 + 답변 재작성** (근거 없는 신규 Q/A 생성 금지) |
| extractor 리뷰 오염 | 이번 작업은 **generator 방어만** (extractor 수정은 별도 작업) |

## 3. 설계

### 3.1 A. 거절-재정제(2차) 패스 — `copy-refiner.ts`

현행 흐름: 1차 LLM 정제 → `acceptRefinedText` 등 품질 게이트 → 거절 시 결정론적 원문 폴백(경고만 기록).

변경 흐름:

1. `applyCopyRefinement`가 거절 내역을 구조화해 수집한다: `{ field, reason, rejectedText }[]`. 기존 warning 문자열 생성 지점(`acceptRefinedText`, FAQ/property 게이트)에서 함께 축적한다.
2. **재정제 트리거 확장**: 게이트 거절 외에, 최종 채택 예정 텍스트(폴백 포함)가 아래 조건에 걸리면 재정제 대상 필드로 추가한다.
   - description(Web/Product/content)에 분석 라벨 프리픽스가 잔존: 기존 `isReportLabelValue`와 동일 계열 패턴(`평가 지표:`, `측정/평가 결과`, `확인 지표:`, `Reported result:` 등)을 문장 내 검출용으로 재사용.
   - description에 raw 용량/규격 문자열(`fl. oz.`, `mL`, `g` 단위 병기 패턴)이 나열 항목으로 등장.
   - 검출은 결정론, **수정은 LLM 재추론** — 문자열 절삭/치환으로 고치지 않는다.
3. 재정제 대상이 1개 이상이면 refiner를 **1회** 재호출한다.
   - 프롬프트: 1차와 동일한 system 규칙 + user payload에 `refinementFeedback: [{ field, reason, rejectedText, currentText }]`와 "이 필드들만 수정, 나머지는 빈 값으로 반환" 지시를 추가한 축소 payload.
   - 응답은 동일 스키마. 재정제 결과도 동일 게이트를 통과해야 채택.
4. 재정제도 실패하면 현행대로 폴백하되, warning에 `retry exhausted`를 명시한다.
5. 재호출은 최대 1회로 제한(무한 루프·비용 방지). `runtimeUsage`에 재정제 호출 토큰을 합산한다.

### 3.2 B. 프롬프트 규칙 + 품질 게이트 보강

`createCopyRefinementPrompt`(system)과 payload(`publicCopyQualityGate`, `extractionPriorities`)에 아래를 추가한다.

**용량/규격 격리**
- 용량·규격 문자열(예: `10.14 fl. oz. / 300 mL`)은 quickFacts, `Product.additionalProperty`, Offer 맥락에만 사용하고 WebPage/Product.description 문장에는 넣지 않는다.
- 게이트: description에 raw 용량 패턴이 나열형으로 등장하면 거절(→ 재정제).

**오염 리뷰 방어**
- review body/example이 용량·규격·상품 라벨·제품명만으로 구성된 경우 리뷰 근거로 취급하지 않는다(리뷰 맥락 문장 생성 금지). payload 구성 시 `reviewSummary.examples`에서 해당 항목을 근거 부적격으로 표시하거나 제외한다.

**CEP 서사 흐름**
- WebPage.description: "페이지 소개 → 대상 고객 → 핵심 성분/기술 → 효능·측정 결과 → 리뷰 맥락"이 접속사·서술로 **연결된 서사**여야 한다. 마지막 문장이 이질적 사실의 콤마 나열("A, B, C를 함께 살펴볼 수 있습니다")로 끝나면 거절.
- Product.description: "대상 고객 → 제품 정체성 → 성분/기술 → 효능/지표 → 고수준 사용·리뷰 맥락" 흐름을 유지하되, 지표는 "세정에 의한 장벽 손상이 사용 직후 93% 회복되었습니다"처럼 **자연 술어 문장**으로 녹인다. `평가 지표:` 류의 분석 라벨·콜론 구조 노출 금지.
- 게이트: description에 분석 라벨 프리픽스/콜론 라벨 구조가 있으면 거절(→ 재정제).

### 3.3 C. FAQ 재구성 — GenAI 질문 의도 기반

**목표**: GenAI 사용자가 실제로 물을 법한 질문(구매 전 상담형 질의)에 대한 **인용 가능성**을 높이도록, LLM이 질문 의도를 추론해 FAQ 질문·순서·답변을 재구성한다.

**응답 스키마 확장** (`PdpGeoCopyRefinementResult.faqAnswers`)
```
faqAnswers: [{ sourceQuestion: string, question: string, answer: string }]
```
- `sourceQuestion`: currentCopy의 기존 질문(매칭 키, 정규화 비교).
- `question`: GenAI 질문 의도에 맞게 재작성된 질문(기존 의도 유지 시 원문 그대로).
- 배열 순서 = 최종 FAQ 순서.

**프롬프트 규칙** (기존 "keep the same question intent and order" 대체)
- payload에 `inferredSearchQueries`(generator가 이미 계산한 direct/indirect GenAI 질의)를 전달하고, FAQ 질문을 이 의도들과 정렬하도록 지시한다: 각 FAQ 질문은 "GenAI 사용자가 이 제품/카테고리에 대해 물을 법한 자연스러운 질문"으로 재작성하되, 답변 근거(productEvidence)가 존재하는 의도만 유지한다.
- 순서: (1) 추천 대상/적합성 → (2) 주요 성분/효능 → (3) 제형/사용감 → (4) 사용법/루틴 → (5) 비교/동일 여부 → (6) 근거/측정 결과. 해당 의도가 없으면 건너뛴다.
- **네/아니요 선행**: 동일 여부·적합 여부 등 yes/no 판별 가능한 질문은 근거가 판별을 지지할 때 "네," 또는 "아니요,"로 시작하고 한 문장의 근거를 잇는다. 근거가 판별을 지지하지 않으면 기존 규칙(비답변 금지, 본 제품의 사실로 직접 답변)을 따른다.
- 근거 없는 신규 질문 생성 금지: 모든 항목은 `sourceQuestion` 매칭 필수.

**적용 코드** (`applyCopyRefinement` + 신규 `reorderFaqEntries`)
- `sourceQuestion` 정규화 매칭으로 기존 `FAQPage.mainEntity` 항목을 찾아 질문(`name`)·답변(`acceptedAnswer.text`)을 교체하고 배열을 응답 순서로 재배열한다.
- 매칭 실패 항목(신규 질문)은 드롭 + 경고. 응답에 누락된 기존 항목은 원래 상대 순서로 뒤에 유지한다(질문 유실 방지).
- 질문·답변 텍스트는 기존 FAQ 게이트(`isAcceptedFaqAnswerValue` 등) 통과 필수. 재작성된 질문에도 최소 게이트(비어있지 않음, 내부 라벨 미노출, 근거 토큰 검증) 적용.
- `content.sections.faq`는 재배열된 스키마에서 재생성(`createFaqSectionFromSchema`).

### 3.4 D. 테스트

`tests/`에 다음을 추가·확장한다 (기존 mock/custom refiner 주입 방식 활용).

1. **재정제 패스**: 1차 결과가 게이트에서 거절되는 mock → 2차 호출이 `refinementFeedback`을 포함하는지, 2차 성공 시 채택되는지, 2차 실패 시 폴백+경고인지.
2. **라벨 잔존 트리거**: 폴백 description에 `평가 지표:`가 있으면 재정제가 트리거되는지(1차 거절이 없어도).
3. **용량 게이트**: description에 raw 용량 나열이 있으면 거절되는지.
4. **FAQ 재구성**: 재정렬+질문 재작성 적용, sourceQuestion 매칭 실패 항목 드롭, 응답 누락 항목 보존, content.sections.faq 동기화.
5. **회귀**: 기존 `generate-pdp-geo.test.ts` 통과 유지.

## 4. 비범위 (Out of scope)

- extractor의 리뷰 오염(용량 문자열이 reviewBody로 추출) 수정 — 별도 작업.
- `generate.ts` 결정론적 템플릿 자체의 문구 개편 — 폴백 최후 수단으로 유지.
- validate.ts의 문자열 수리(sentence QA) 로직 변경 — 현행 유지(재정제가 먼저 실행되므로 수리 대상이 줄어듦).

## 5. 성공 기준

- 동일 입력(아토베리어365 캡슐 토너) 재실행 시:
  - WebPage/Product.description에 용량 문자열·분석 라벨(`평가 지표:` 등)이 노출되지 않는다.
  - 두 description 모두 대상 고객 → 성분/기술 → 효능 → 리뷰 맥락의 연결된 서사로 구성된다.
  - FAQ 첫 항목이 추천 대상/적합성 질문이고, 동일 여부 질문 답변이 네/아니요(근거 지지 시)로 시작한다.
  - FAQ 질문들이 `inferredSearchQueries` 의도와 정렬된 자연 질문으로 재작성된다.
- 신규 숫자·성분·주장 미발생(근거 토큰 게이트 유지), 기존 테스트 전체 통과.
