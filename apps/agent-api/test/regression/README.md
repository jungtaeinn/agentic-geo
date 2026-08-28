# GEO 생성 회귀 (regression)

같은 입력에 대해 GEO 스키마 마크업을 **만들고 평가**하는 로컬 회귀 하네스입니다. 웹 콘솔(`apps/geo-generator`)에서 눈으로 확인하던 GEO/CEP/E-E-A-T 점수와 수정 프롬프트를, 케이스 파일 단위로 반복 실행하고 HTML 리포트로 남깁니다.

구조는 `data-highway-agent`의 `tests/stage_regression/golden_answer_coverage/`를 따랐습니다 — one-file-per-case YAML, 실행별 격리 디렉터리, 케이스당 JSON + run당 HTML 한 장.

## 실행

```bash
# 로컬 모드 — 서버를 띄우지 않고 GenerationService를 직접 호출
pnpm --filter @agentic-geo/agent-api test:regression

# 케이스 선택 (쉼표 구분)
CASES=GEO-001,GEO-003 pnpm --filter @agentic-geo/agent-api test:regression

# HTTP 모드 — 이미 떠 있는 agent-api를 호출
GEO_REGRESSION_MODE=http pnpm --filter @agentic-geo/agent-api test:regression

# 환경(URL)을 바꿔서 실행
GEO_REGRESSION_MODE=http GEO_REGRESSION_BASE_URL=http://localhost:3000 \
  pnpm --filter @agentic-geo/agent-api test:regression

# LLM 심사(3층)까지 켜기
GEO_REGRESSION_LLM_JUDGE=true pnpm --filter @agentic-geo/agent-api test:regression

# 배선만 빠르게 확인 (몇 초)
AGENTIC_GEO_PROVIDER=mock pnpm --filter @agentic-geo/agent-api test:regression

# 리포트 자동 오픈 끄기 / 실패했을 때만 열기
GEO_REGRESSION_OPEN=never pnpm --filter @agentic-geo/agent-api test:regression
GEO_REGRESSION_OPEN=on-failure pnpm --filter @agentic-geo/agent-api test:regression
```

`pnpm test`(단위+e2e)에도 `pnpm test:int`(통합)에도 섞이지 않습니다. 앞의 두 config는 각각 `spec|e2e-spec`과 `int-spec`만 잡고 회귀는 `.reg-spec.ts`라서, LLM 비용이 드는 실행이 CI·turbo 파이프라인에 딸려 들어가지 않습니다.

## 실행 모드

| 모드 | 동작 | 쓰는 상황 |
| --- | --- | --- |
| `local` (기본) | NestJS 앱을 띄우지 않고 `GenerationService.generate()`를 직접 호출 | 서버 없이 빠르게. DB·큐 불필요 |
| `http` | 떠 있는 agent-api의 `POST /internal/v1/geo/test-generations` 호출 | 배포본 검증, 환경별 비교 |

`http` 모드는 요청에 `includeDiagnostics: true`를 반드시 실어 보냅니다. 이게 없으면 응답에 `diagnostics`가 빠져 품질 루브릭을 산출할 수 없고, `local` 모드와 점수가 어긋납니다. 대상 서버에는 `GEO_TEST_SYNC_ENDPOINT=true`가 설정돼 있어야 합니다(아니면 404).

## 환경 변수

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `GEO_REGRESSION_MODE` | `local` | `local` \| `http` |
| `GEO_REGRESSION_ENV` | `local` | 환경 별칭 → URL 매핑 (`src/runner.ts`의 `ENV_BASE_URLS`) |
| `GEO_REGRESSION_BASE_URL` | - | 지정하면 별칭보다 우선 |
| `GEO_REGRESSION_API_KEY` | `AGENT_API_KEY` | http 모드의 `x-api-key` |
| `GEO_REGRESSION_TIMEOUT_MS` | `600000` | 케이스당 타임아웃 |
| `CASES` | - | 실행할 케이스 ID(쉼표 구분) |
| `GEO_REGRESSION_LLM_JUDGE` | `false` | 3층 LLM 심사 on/off |
| `GEO_REGRESSION_JUDGE_PROVIDER` | `AGENTIC_GEO_PROVIDER` | 심사 전용 provider |
| `GEO_REGRESSION_JUDGE_DEPLOYMENT` / `_MODEL` | 생성기와 동일 | 심사 전용 모델 |
| `GEO_REGRESSION_OPEN` | TTY면 `always`, 아니면 `never` | 리포트 자동 오픈: `always` \| `on-failure` \| `never` (`true`/`false`도 받음). `CI`가 설정돼 있으면 항상 `never` |
| `GEO_REGRESSION_PROBE` | - | (v1 미구현) 인용 프로브 자리 |

생성 파이프라인 자체는 `apps/agent-api/.env`를 그대로 읽습니다 — 회귀는 실제 서버와 같은 설정으로 돌아야 하기 때문입니다.

## 케이스 파일

`cases/` 아래 한 파일이 한 케이스입니다. 입력은 **agent-api 요청 본문 그대로**입니다.

`request`는 **JSON을 그대로 씁니다.** YAML은 JSON의 상위집합이라 API에 보내는 본문을 손대지 않고 붙여넣을 수 있습니다 — curl 본문이나 실제 요청 로그와 1:1로 대조되고, 큰 `product`를 YAML 매핑으로 펼치면서 생기는 변환 실수가 없습니다.

```yaml
id: GEO-001                      # 필수, 고유
name: 예시럭셔리 보태니컬 리뉴얼 세럼           # 선택, 리포트 가독성용
tags: [exampleluxe, en-US]         # 선택, 필터·그룹핑용
skip: false                      # 선택, 일시 제외
timeoutMs: 900000                # 선택

# 필수 — POST /internal/v1/geo/test-generations 본문을 JSON 그대로
request: {
    "locale": "en-US",
    "product": {
      "canonicalUrl": "https://...",
      "geoProduct": { "name": "...", "brand": "..." }
    }
  }

expect:                          # 전부 선택 — 없으면 루브릭 점수만 기록하고 통과
  resultStatus: SUCCEEDED
  schemaTypes: [Product, WebPage, FAQPage]
  forbiddenSchemaTypes: [Review]
  maxValidationWarnings: 0
  contains: ["보태니컬 리뉴얼"]
  notContains: ["최고", "1위"]
  jsonPath:
    - { path: "@graph.brand.name", equals: ExampleLuxe }
    - { path: "@graph.offers.price", exists: true }
  minScore: { overall: 85, geo: 80, cep: 90, eeat: 80 }
  goldenAnswer: |
    이 PDP의 스키마는 ... 이어야 한다
```

`jsonPath`는 점 표기입니다. 배열은 `[]`로 전체 순회하거나 `[0]`처럼 인덱스를 씁니다. 배열 원소에서 같은 키를 찾을 때는 `@graph.brand.name`처럼 `[]` 없이 이어 쓸 수도 있습니다.

### `minScore` 기준선을 잡는 법

씨앗 케이스에는 **의도적으로 `minScore`를 넣지 않았습니다.** 추측으로 하한을 박으면 첫 실행부터 헛 실패가 나기 때문입니다. 순서는 이렇습니다.

1. 실제 provider로 한 번 돌립니다 (`AGENTIC_GEO_PROVIDER=azure-openai` 등).
2. 리포트의 케이스별 총점·차원 점수를 확인합니다.
3. 관측값보다 **몇 점 낮게** 하한을 잡아 YAML에 넣습니다. LLM 생성은 실행마다 흔들리므로 관측값을 그대로 박으면 안 됩니다.

참고로 `mock` provider 기준 관측값은 GEO-001/002 총점 96, GEO-003 87, GEO-004 93입니다. mock은 결정적이라 흔들리지 않지만 실제 모델과 점수가 다르므로 **기준선 근거로 쓰지 마세요.**

## 평가 계층

| 층 | 내용 | LLM | 실패 판정 |
| --- | --- | --- | --- |
| 1 | 계약 검증 — `resultStatus`/`schemaTypes`/`maxValidationWarnings`/`contains`/`jsonPath` | ✗ | fail |
| 2 | 결정적 루브릭 — `evaluateGeoQuality` → GEO/CEP/E-E-A-T + 총점 | ✗ | `minScore` 미달 시 fail |
| 2b | 점수 일치 검증 — 재계산 점수 vs 생성기가 기록한 quality gate 점수 | ✗ | 불일치 시 warning |
| 3 | LLM 심사 — 1~10점 → pass(7+)/warning(4-6)/fail(3-) | opt-in | fail |
| 4 | 인용 프로브 | — | v1 미구현 |

2층은 웹 콘솔이 화면에 그리는 것과 **같은 함수**입니다(`@agentic-geo/pdp-geo-eval-agent`의 `evaluateGeoQuality`). 생성기의 quality gate도 내부적으로 이 루브릭을 쓰므로, 2b는 "생성기 자기채점의 재현 검증"입니다 — 자세한 기준은 [`TEST_RULES.md`](./TEST_RULES.md) 참고.

warning은 테스트를 실패시키지 않고 리포트에만 남깁니다. 경고까지 빨간불로 만들면 아무도 안 보게 되고, 그러면 진짜 실패도 같이 묻힙니다.

## 산출물

```
results/run_<KST timestamp>/
├── _run.json                # 실행 메타 (모드·환경·provider·파이프라인 설정)
├── GEO-001.json             # 케이스당 하나 — 예외가 나도 반드시 남는다
└── report_<timestamp>.html  # run당 한 장, 외부 자산 없는 단일 파일
```

`results/`는 gitignore 대상입니다.

실행이 끝나면 **리포트가 자동으로 열립니다**(대화형 터미널일 때). 손으로 돌릴 때는 바로 보는 편이 낫고,
CI·스크립트·파이프 실행에서는 브라우저를 띄우면 프로세스가 붙잡히거나 헤드리스 환경에서 에러가 나므로
TTY 여부로 가릅니다. `GEO_REGRESSION_OPEN`으로 강제할 수 있습니다.

HTML 리포트에는 케이스별로 점수·근거·개선점, 생성기 품질 게이트 진단, 검증 경고, **수정 프롬프트**(복사 버튼), 입력 product, 생성 JSON-LD, Langfuse sessionId가 담깁니다. 실패한 케이스를 열어 수정 프롬프트를 복사해 LLM에 붙여넣으면 개선 → 재생성 → 재평가 루프가 돕니다.

리포트 헤더의 **파이프라인 설정**(상품 정규화 / 최종 교정 on·off, provider, 배포명)을 먼저 보세요. 같은 입력인데 웹 콘솔과 점수가 다르면 대부분 이 줄에서 이유가 드러납니다.

## 알려진 차이 — 웹 콘솔 대비

회귀는 **agent-api의 실제 동작**을 측정합니다. 콘솔(`apps/geo-generator`)과 다음이 다릅니다.

- **상품 정규화(LLM)**: agent-api는 꺼진 채로 돕니다. `apps/agent-api/.env`에 `PRODUCT_NORMALIZATION_ENABLED`가 있지만 이를 읽는 코드가 없어(`generator-options.factory.ts`가 `productNormalization`을 넘기지 않음) 생성기 기본값인 '꺼짐'이 적용됩니다. 콘솔은 비-mock provider + 키가 있으면 자동으로 켭니다.
- **concept judge**: 콘솔은 `qualityGate.conceptJudge` 설정이 가능하지만 agent-api는 미설정이라 항상 off입니다.
- **`source.url`**: 반대 방향입니다. agent-api는 `canonicalUrl`을 생성기 `source.url`로 넘겨 JSON-LD `@id`가 실제 URL 앵커가 됩니다. 콘솔의 manual-json 경로는 넘기지 않습니다.
- **extractor 단계 없음**: agent-api는 항상 `manual-json`입니다. URL에서 추출하는 경로는 콘솔에만 있습니다.

RAG 문서·브랜드 스코핑·content planning·quality gate 임계는 **차이가 없습니다**(생성기가 내부에서 직접 로드/판정).
