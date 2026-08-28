# GEO Generator App

`apps/geo-generator`는 Agentic GEO의 메인 오케스트레이션 콘솔입니다. PDP URL, REST API, 임의 상품 JSON을 받아 필요한 sub agent를 선택적으로 실행하고, 최종적으로 schema.org JSON-LD와 GEO 최적화 PDP HTML content, validation diagnostics를 한 화면에서 확인합니다.

## Orchestration Model

입력 유형에 따라 실행 흐름이 달라집니다.

| 입력 | 실행 흐름 | 결과 |
| --- | --- | --- |
| PDP URL | `pdp-extractor-agent` -> `pdp-geo-generator-agent` -> configured final proofreading -> read-only validation | 추출 근거가 포함된 GEO artifact |
| REST API URL | `pdp-extractor-agent` -> `pdp-geo-generator-agent` -> configured final proofreading -> read-only validation | API 기반 상품 정보로 생성된 GEO artifact |
| Product JSON | `pdp-geo-generator-agent` -> configured final proofreading -> read-only validation | 내부 상품 JSON을 바로 GEO artifact로 변환 |

이 앱은 각 agent의 책임을 UI와 API에서 분리해 보여줍니다. Extractor 단계는 source/evidence/log를 만들고, Generator 단계는 normalize/RAG/retrieve/generate/validate/repair/artifact ID를 유지합니다. 여기서 `repair` stage는 호환용 이름이며 자동 수정 없이 read-only validation findings를 기록합니다.

## Output

생성 결과는 두 가지입니다.

- `schemaMarkup`: `Product`, `FAQPage`, `HowTo`, `BreadcrumbList`, `WebPage` 기반 JSON-LD와 복사용 script tag
- `content`: GEO에 맞게 재구성된 PDP HTML accordion content

`content.sections`에는 `productName`, `description`, `quickFacts`, `benefits`, `ingredients`, `howToUse`, `faq`가 포함됩니다. 진단 정보는 `recommendations`, `evidence`, `terminology`, `finalProofreading`, `validationWarnings`, `validationFindings`, `selectedRagChunks`로 분리됩니다.

## Generator Stages

`pdp-geo-generator-agent`의 stage는 앱 우측 패널과 API 응답의 `generatorProcess`에 그대로 노출됩니다.

| Stage | 역할 |
| --- | --- |
| `input` | 임의 상품 JSON과 생성 옵션 검증 |
| `normalize` | REST/API/PDP JSON을 내부 product signal로 변환 |
| `rag-load` | schema.org, E-E-A-T, CEP, GEO, locale RAG 프로필 로드 |
| `chunk` | 로컬 또는 managed RAG chunk 구성 |
| `embed` | hash embedding 또는 managed embedding 전략 적용 |
| `retrieve` | 상품/locale/schema 목표에 맞는 RAG 검색 |
| `rerank` | schema, locale, terminology, GEO 관련성 기준으로 재정렬 |
| `generate` | JSON-LD/HTML 생성 후 non-mock provider/API key가 설정되면 근거가 결합된 필드에 별도 final proofreading 자동 호출 |
| `validate` | JSON-LD와 HTML 구조를 읽기 전용으로 검증 |
| `repair` | 호환용 stage ID. 자동 수정 없이 validation findings 기록 |
| `artifact` | 복사 가능한 최종 산출물 직렬화 |

## 화면 구성

```txt
좌측 패널
  - Pipeline
  - 실행 결과 히스토리
  - locale/RAG 모드 상태

중앙 영역
  - URL/REST/JSON 입력
  - 실행 대화와 결과 카드
  - schema/content/diagnostics 복사 패널

우측 패널
  - Extractor 단계
  - Generator 단계
  - Recommendations
  - Evidence
```

## 실행 방법

루트 디렉터리에서 실행합니다.

```bash
pnpm install
pnpm dev
```

앱만 직접 실행할 수도 있습니다.

```bash
pnpm --filter @agentic-geo/geo-generator dev
```

기본 주소:

```txt
http://localhost:3000
```

## 입력 방식

- `Auto`: 입력값이 JSON이면 직접 generator를 실행하고, URL이면 extractor 이후 generator를 실행합니다.
- `URL`: 상품 상세 페이지 URL을 extractor로 수집합니다.
- `REST`: 상품 API URL을 extractor로 수집합니다.
- `JSON`: 임의 구조의 상품 JSON을 generator에 직접 전달합니다.

JSON 입력은 고정된 `geoProduct` 타입이 아니어도 됩니다. 필요한 경우 API 요청에서 `fieldMapping`을 함께 넘겨 상품명, 설명, 성분, 리뷰 등의 경로를 지정할 수 있습니다.

## RAG Modes

- `local-versioned-rag`: 기본값. `packages/pdp-geo-generator-agent/src/rag` 문서를 로컬에서 chunking, hash embedding, hybrid reranking으로 검색합니다.
- `managed-vector-store-rag`: OpenAI Vector Store Search adapter 또는 `customRetriever` 기반 managed 검색을 사용합니다.

GEO generator RAG는 schema.org, E-E-A-T, CEP, BestPractice, GEO paper, locale expression guideline, locale terminology map을 포함합니다.

## Validation Diagnostics

Generator는 산출물을 반환하기 전에 다음 항목을 읽기 전용으로 검증합니다.

- JSON-LD `@context`, `@graph`, `Product` 필수 정보
- `FAQPage` Question/Answer와 `HowTo` step 구조
- accordion HTML의 script, inline event, style attribute 문제 탐지
- 발견 사항과 제안 조치를 `validationWarnings`, `validationFindings`, `evidence`로 기록하며 최종 문장을 validator가 수정하지 않음

앱의 GEO/CEP/E-E-A-T 품질 패널은 diagnostics 기반의 보수적 lint-style 진단이며 **인용 확률 추정치가 아닙니다**. 산출물이 실제로 AI 생성 답변에서 얼마나 인용되는지는 패키지의 오프라인 인용 가시성 벤치마크로 측정합니다: 이 앱에서 `pnpm geo:benchmark`를 실행합니다 (평가 로직: [`packages/pdp-geo-eval-agent`](../../packages/pdp-geo-eval-agent/README.md), 배선: `scripts/run-geo-benchmark.ts`). 두 신호는 역할이 다릅니다 — 패널은 개별 실행의 구조·근거 결함을 즉시 보여주고, 벤치마크는 파이프라인 버전 간 인용 점유율 변화를 회귀 추적합니다.

## Inline Citation Probe

`/api/generate`는 생성 완료 직후 선택적으로 **인라인 인용 프로브**를 실행할 수 있습니다. 같은 고객 질문·같은 경쟁 문서 세트에서 원본 PDP 텍스트와 생성 콘텐츠를 치환 비교해, 모의 생성엔진 답변에서의 인용 점유율(wordpos) paired delta를 결과에 첨부합니다.

- 켜는 법 (콘솔): 설정 → 실행 탭 → **인용 프로브 (Citation Probe)** 섹션에서 `끔 / 켬 / 켬 + 근거 검사` 중 선택 (localStorage에 저장되어 다음 실행에도 유지)
- 켜는 법 (API): 요청 body `"citationProbe": { "enabled": true, "maxQueries": 3, "includeUtility": false }` 또는 env `AGENTIC_GEO_CITATION_PROBE=true`
- 조건: non-mock provider + 자격 증명 필요 (mock이면 `citationProbeError`로 사유 안내)
- 질의는 contentPlan FAQ → CEP → 카테고리 템플릿 순으로 상품별 자동 파생, 경쟁 문서는 locale·카테고리 템플릿 4종
- 결과: `results[].citationProbe` (질의별 vanilla→generated 점유율, 평균 delta, 결합 게이트, `includeUtility` 시 KPR/KPC). 프로브 실패는 `citationProbeError`로 강등되어 생성 응답은 항상 전달
- 비용/지연: 상품당 질의 수 × 2회 엔진 호출이 추가되므로 기본 off
- 해석 주의: 해당 상품 1회성 paired 진단입니다. 상품/실행 간 비교나 실제 인용 확률로 읽지 마세요 (결과에 interpretation 가드 문구가 함께 내려갑니다). 콘솔에서는 결과 선택 시 품질 패널 아래 "CITATION PROBE" 카드로 표시됩니다.

## API Routes

| Route | Method | 역할 |
| --- | --- | --- |
| `/api/generate` | `POST` | extractor + generator 오케스트레이션 |
| `/api/extract` | `POST` | extractor 단독 실행 |
| `/api/generator` | `POST` | generator 단독 실행 |
| `/api/provider/validate` | `POST` | AI provider 키와 모델 접근 확인 |
| `/api/rag-profile` | `GET` | extractor/generator RAG 프로필 읽기 |
| `/api/rag-profile` | `PUT` | 선택한 RAG 프로필 저장 (`target: "extractor" | "generator"`) |
| `/api/rag-profile` | `DELETE` | RAG 프로필 기본값 복원 |

## Generate API 예시

```bash
curl -X POST http://localhost:3000/api/generate \
  -H "Content-Type: application/json" \
  -d '{
    "product": {
      "item": {
        "title": "Hydra Barrier Cream",
        "body": "Daily cream for dry skin and skin barrier support."
      },
      "reviews": {
        "keywords": ["hydration", "smooth texture"]
      }
    },
    "hints": {
      "locale": "ko-KR",
      "market": "KR"
    },
    "fieldMapping": {
      "name": "item.title",
      "description": "item.body"
    },
    "rag": {
      "mode": "local-versioned-rag"
    }
  }'
```

## Generator API 예시

이미 상품 JSON을 가지고 있으면 extractor를 거치지 않고 generator agent만 호출할 수 있습니다.

```bash
curl -X POST http://localhost:3000/api/generator \
  -H "Content-Type: application/json" \
  -d '{
    "product": {
      "item": {
        "title": "Hydra Barrier Cream",
        "body": "Daily cream for dry skin and skin barrier support."
      },
      "reviews": {
        "keywords": ["hydration", "smooth texture"]
      }
    },
    "hints": {
      "locale": "ko-KR",
      "market": "KR"
    },
    "fieldMapping": {
      "name": "item.title",
      "description": "item.body"
    }
  }'
```

## 주요 파일

| 파일 | 설명 |
| --- | --- |
| `src/app/components/GeoGeneratorConsole.tsx` | 전체 GEO 생성 콘솔 UI |
| `src/app/api/generate/route.ts` | extractor와 generator 오케스트레이션 API |
| `src/app/api/generator/route.ts` | generator agent REST 어댑터를 연결한 단독 생성 API |
| `src/app/api/rag-profile/route.ts` | extractor/generator RAG 프로필 관리 API |
| `src/app/globals.css` | 복사한 Codex형 레이아웃과 GEO 결과 패널 스타일 |

## 명령어

```bash
pnpm --filter @agentic-geo/geo-generator dev
pnpm --filter @agentic-geo/geo-generator typecheck
pnpm --filter @agentic-geo/geo-generator build
pnpm --filter @agentic-geo/geo-generator build:pages
```
