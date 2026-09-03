# agent-api

`apps/agent-api`는 Agentic GEO GEO 파이프라인에서 **실제 GEO(schema.org JSON-LD) 생성을 수행하는 비동기 Node/NestJS 서비스**입니다. dispatcher dispatch Job으로부터 생성 요청을 HTTP로 접수(즉시 202 ACK)하고, 내부 인프로세스 큐에서 최대 8분간 GEO를 생성한 뒤, 공유 Aurora PostgreSQL의 `agentic_geo.geo_result`에 산출물을 기록하고 `agentic_geo.geo_generation` 상태를 가드 전이(`PROCESSING → GENERATED`/`FAILED`)합니다.

요청·응답 계약과 실행 설정은 이 문서 및 `src/geo/dto`의 타입 정의를 참고하세요.

## 실행

```bash
# 저장소 루트에서
pnpm install

# 개발 서버 (watch)
pnpm --filter @agentic-geo/agent-api dev

# 프로덕션 빌드 + 실행
pnpm --filter @agentic-geo/agent-api build
pnpm --filter @agentic-geo/agent-api start

# 타입체크 / 린트 / 테스트
pnpm --filter @agentic-geo/agent-api typecheck
pnpm --filter @agentic-geo/agent-api lint
pnpm --filter @agentic-geo/agent-api test        # 단위 + e2e (Docker 불필요)
pnpm --filter @agentic-geo/agent-api test:int    # 통합 (Docker 필요)
```

로컬 기본 포트는 `3000`이며, dispatcher의 기본 `AGENT_API_BASE_URL=http://localhost:3000`과 정렬됩니다.

통합 테스트(`*.int-spec.ts`)는 Testcontainers로 실제 PostgreSQL 컨테이너를 기동하므로 Docker 데몬이 필요합니다.
그래서 기본 `pnpm test`에서 분리해 `pnpm test:int`로 따로 돌립니다 — Docker가 없는 환경에서 커밋 경로가 통째로
막히지 않게 하기 위함입니다.

**colima / Lima 사용자는 환경변수 하나가 필요합니다.**

```bash
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
```

이유: Testcontainers는 컨테이너를 정리하는 Ryuk 컨테이너에 호스트의 docker 소켓을 마운트하는데, 마운트할 경로를
`docker info`의 OS 이름으로 판별합니다(`remote-container-runtime-socket-path.js`). Docker Desktop이면
`/var/run/docker.sock`을 쓰지만, colima는 OS를 `Ubuntu ...`로 보고하므로 `docker.host` URI를 그대로 씁니다 —
즉 **macOS 호스트 경로**(`/home/developer/.colima/default/docker.sock`)를 VM 안 컨테이너에 마운트합니다. 그 경로는
VM 안에 없으니 Ryuk이 `Cannot connect to the Docker daemon`으로 즉시 죽고, 모든 int-spec이 다음 에러로 실패합니다.

```
Log stream ended and message ... was not received
```

이 에러는 postgres가 아니라 **Ryuk**의 대기 전략에서 납니다(postgres는 healthcheck + 포트 대기를 씁니다).
`TESTCONTAINERS_RYUK_DISABLED=true`로도 넘어가지만 그러면 컨테이너 정리를 포기하게 되므로, 위 소켓 오버라이드가
정식 해법입니다.

### Docker

```bash
docker build -f apps/agent-api/Dockerfile -t agent-api .
docker run -p 3000:3000 --env-file apps/agent-api/.env agent-api
```

## 엔드포인트

| Method | Path | 설명 | 인증 |
| --- | --- | --- | --- |
| `GET` | `/health` | 헬스체크(k8s/ALB probe). 정적 `{ "status": "ok" }` 200 | 불필요(전역 Guard 예외) |
| `POST` | `/internal/v1/geo/generations` | GEO 생성 접수. body: `{ geoGenerationId: uuid, locale: string, product: object, brandSameAs?: string[] }` | 필요(`x-api-key`) |
| `POST` | `/internal/v1/geo/test-generations` | **로컬 전용** 동기 생성(큐·DB 우회, 결과 즉시 반환 + Langfuse 트레이싱). body: `{ locale, product, includeDiagnostics?, brandSameAs? }`. `GEO_TEST_SYNC_ENDPOINT=true`가 아니면 404 | 필요(`x-api-key`) |

`includeDiagnostics: true`를 실으면 응답에 생성기 `diagnostics` 전체와 내부 `contentSections`가 함께 실립니다(기본은 미포함). 품질 루브릭(`evaluateGeoQuality`)과 개선 프롬프트가 요구하는 입력이며, 로컬 회귀(`test/regression`)가 이 경로를 씁니다. 응답이 크게 늘어나므로 필요할 때만 켜세요.

`POST /internal/v1/geo/generations` 응답 규약:

| 상황 | 응답 |
| --- | --- |
| 접수 성공(큐 등록/중복 no-op) | `202 { accepted: true, geoGenerationId }` |
| body 검증 실패 | `400` |
| `x-api-key` 누락/불일치 | `401` |
| 큐 포화(`GEO_QUEUE_MAX_WAITING` 초과) | `429` |
| DB 접속 실패 | `503` |

인증은 전역 `ApiKeyGuard`(`APP_GUARD`)가 모든 라우트에 `x-api-key` 헤더 상수시간 비교로 적용하며, `/health`만 예외입니다. `AGENT_API_KEY`가 비어 있으면(로컬/개발) 무인증으로 통과합니다.

**브랜드 엔티티 URL(`brandSameAs`).** 브랜드 공식 사이트·Wikidata·검증된 소셜 프로필 URL을 넘기면 생성기가 `Brand.sameAs`로 발행해 상품 엔티티를 엔진이 이미 아는 개체에 연결합니다. 검색 연구는 에이전트 검색 정확도 향상을 마크업 양이 아니라 엔티티 상호링크와 역참조 가능한 식별자에 귀속시키는데, 생성기에는 이 URL의 다른 출처가 없어 호출자가 넘기지 않으면 상품 엔티티가 아무데도 연결되지 않은 채 발행됩니다. 절대 http(s) URL만 허용하며(최대 10개) 형식이 어긋나면 400으로 거절합니다 — 확인되지 않은 값이 그래프 안쪽에서 조용히 버려지지 않게 경계에서 실패시킵니다. 값은 사이트의 모든 PDP에서 동일해야 하므로 상품별 데이터가 아니라 호출자 측 설정으로 두는 것이 맞습니다. 생성기 정책상 **식별자 URL을 추측해 만들어내는 것은 금지**입니다.

멱등성: 큐는 `geoGenerationId` 기준으로 dedup되어 동일 id가 대기·실행·재시도 대기 중이면 추가 등록을 무시하고, 접수 시 `geo_generation.status`가 `PROCESSING`이 아니면 no-op으로 응답합니다.

## 환경변수

`.env.example` 참고. 주요 항목:

| 변수 | 설명 |
| --- | --- |
| `PORT` | HTTP 리슨 포트(기본 3000) |
| `LOG_LEVEL` | 로그 임계값(`trace`~`fatal`, 기본 `info`). 출력은 항상 JSON 한 줄 |
| `AGENT_API_KEY` | 기대하는 `x-api-key` 값(단일 공유 시크릿). 비어있으면 무인증 허용 |
| `GEO_WORKER_CONCURRENCY` | 인프로세스 큐 동시 처리 수(기본 4) |
| `GEO_QUEUE_MAX_WAITING` | 큐 대기 상한(초과 시 접수 429, 기본 100). 대기 job은 Redis가 아니라 Node 힙에 상주하므로 429 임계값이자 메모리 상한이기도 함(아래 참고) |
| `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USERNAME`/`DB_PASSWORD`/`DB_SCHEMA` | 사용자 PostgreSQL(`agentic_geo` 스키마) 접속 정보 |
| `AGENTIC_GEO_PROVIDER` | GEO 생성 provider(`mock`/`openai`/`gemini`/`azure-openai`/`aistudio`, 기본 `mock`) |
| `AGENTIC_GEO_PRODUCT_NORMALIZATION` | 상품 신호 정규화(semanticFacts 원자화) LLM 호출. non-mock provider + API 키면 **기본 활성**이며 `false`로만 끔. 끄면 산문/메타필드 소스에서 성분·사용법·임상 지표 원자가 비어 FAQ/HowTo 품질이 낮아짐(토큰 비용 절감용 스위치) |
| `AGENTIC_GEO_OCR_IMAGE_ALLOWED_HOSTS` | OCR 대상 이미지(`ocrImages`) 호스트 허용목록(콤마 구분 호스트 접미, 예: `cdn.example.com`). **미설정**: http(s) 프로토콜 강제 및 사설/루프백/링크로컬 주소 차단만 적용, 그 외 호스트는 통과. **값 있음**: 그 접미와 일치하는 호스트만 통과, 나머지는 제외. **빈 값(콤마·공백만)**: fail-closed로 전량 거부 |
| `OPENAI_*`/`AZURE_OPENAI_*` | 선택한 provider별 API 키/엔드포인트/모델/배포명(형제 앱과 동일 규칙 재사용) |
| `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY`/`LANGFUSE_BASE_URL` | **로컬 전용** Langfuse 트레이싱 키/주소. 미설정 시 트레이싱 완전 no-op(배포 환경 기본) |
| `GEO_TEST_SYNC_ENDPOINT` | `true`일 때만 동기 테스트 엔드포인트 활성화(기본 비활성 → 404) |

> **`GEO_QUEUE_MAX_WAITING`에 관한 참고**: 큐가 인프로세스가 되면서 대기 job의 payload는 Redis가 아니라 Node 힙에 그대로 쌓입니다. 즉 `GEO_QUEUE_MAX_WAITING`은 더 이상 429 임계값만이 아니라 메모리 상한이기도 합니다 — 최악의 경우 대략 `GEO_QUEUE_MAX_WAITING` × `main.ts`의 JSON body 상한(2mb)만큼 힙을 점유할 수 있습니다. 이는 감수하기로 한 트레이드오프이며, 기본값(100)이나 Node 힙 크기(`--max-old-space-size` 등)를 바꾸지 않고 문서화만 해 둡니다.

## 로깅 (GEO-222)

모든 로그는 **JSON 한 줄**로 stdout에 나갑니다 — Nest 프레임워크의 부팅 로그까지 포함합니다. 컨테이너 stdout을 수집하는 배포 환경을 전제로 하며, 파일 로테이션이나 별도 transport는 쓰지 않습니다.

고정 필드는 로거가 붙입니다.

| 필드 | 의미 |
| --- | --- |
| `level` | `info`/`warn`/`error`/`fatal`/`debug`/`trace` — 호출한 메서드가 결정. 호출자가 넘겨도 무시됨 |
| `time` | ISO-8601 |
| `context` | `new Logger(X.name)`의 이름 (예: `GeoQueue`) |
| `req` | `{ id, method, url }`로 축소. `id`는 `x-request-id` 헤더가 있으면 그 값, 없으면 생성(응답 헤더로도 반환) |
| `err` | `logger.error({ err })`로 넘긴 Error의 `message`/`stack` |

도메인 로그는 자유 필드를 쓰되 **`event`를 안정적 식별자로 필수**로 둡니다. 대시보드·알람은 문구가 아니라 이 값에 걸어야 합니다.

```
geo.accepted  geo.noop  geo.rejected.saturated  geo.accept.db_unavailable
job.started   job.completed  job.retrying  job.failed
geo.persist_skipped  geo.transition_failed  queue.discarded_on_shutdown
http.request  app.listening  langfuse.enabled
```

**작업 상관관계(MDC).** 백그라운드 작업은 202 응답 이후에 돌아 HTTP 요청 스코프를 벗어나므로, `AsyncLocalStorage` 기반 작업 컨텍스트(`src/observability/job-context.ts`)가 `geoGenerationId`와 `attempt`를 작업 전 구간의 모든 로그 줄에 자동으로 붙입니다. 호출부가 손으로 넘기지 않습니다. Java의 MDC/ThreadContext와 같은 역할입니다.

**큐 깊이.** `geo.accepted`·`job.started`·`job.completed`가 `waiting`/`active`를 함께 실어, 429가 왜 났는지 로그만으로 판단할 수 있습니다.

**보안.** `x-api-key`·`authorization`·`cookie`는 로그에 남지 않습니다(요청 serializer가 헤더를 떨어내고, `redact`가 2차 방어선).

**로컬에서 읽기.** JSON은 사람이 읽기 불편하므로 파이프로 넘깁니다.

```bash
pnpm --filter @agentic-geo/agent-api dev | npx pino-pretty
```

## 로컬 관측 — Langfuse

로컬에서 GEO 생성 파이프라인의 LLM 호출(모델·토큰·비용)을 트레이스로 관측하기 위한 **로컬 전용** 구성입니다. 배포 환경(dev/qa/prd)에는 Langfuse 키를 주입하지 않으므로 트레이싱 코드는 완전 no-op으로 동작합니다.

### 1. Langfuse 스택 기동

```bash
cd apps/agent-api
docker compose -f docker-compose.langfuse.yml up -d     # 기동
docker compose -f docker-compose.langfuse.yml down      # 종료(트레이스 데이터 유지)
docker compose -f docker-compose.langfuse.yml down -v   # 초기화(데이터 전체 삭제)
```

- UI: **http://localhost:3100** — 이메일은 compose의 `LANGFUSE_INIT_USER_EMAIL`, 비밀번호는 비공개 `.env`의 `LANGFUSE_INIT_USER_PASSWORD`를 사용합니다.
- 첫 부팅 시 `LANGFUSE_INIT_*`로 조직/프로젝트/API 키가 자동 생성되므로 가입 절차가 없습니다.
- 포트 배치: web `:3100`(agent-api가 `:3000`), minio `:9090`. 내부 캐시/DB/분석 스토어는 호스트에 포트를 노출하지 않습니다.

### 2. .env 설정

`.env.example`을 비공개 `.env`로 복사하고 compose가 요구하는 `LANGFUSE_*` 비밀값을 직접 설정하세요. 아래 두 키는 각각 `LANGFUSE_INIT_PROJECT_PUBLIC_KEY`, `LANGFUSE_INIT_PROJECT_SECRET_KEY`와 같아야 합니다. 저장소에는 실제 키가 포함되어 있지 않습니다.

```bash
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
LANGFUSE_BASE_URL=http://localhost:3100
GEO_TEST_SYNC_ENDPOINT=true
```

### 3. 동기 테스트 호출

`pnpm --filter @agentic-geo/agent-api dev`로 앱을 띄운 뒤:

```bash
curl -X POST http://localhost:3000/internal/v1/geo/test-generations \
  -H "content-type: application/json" \
  --max-time 600 \
  -d '{
    "locale": "ko-KR",
    "product": {
      "title": "그린티 씨드 히알루론산 세럼",
      "brand": "예시그린",
      "body": "제주 그린티 추출물과 히알루론산이 피부 속 수분을 채워주는 데일리 보습 세럼.",
      "canonicalUrl": "https://shop.example.com/kr/ko/products/green-tea-seed-serum",
      "price": 28000,
      "currency": "KRW"
    }
  }'
```

- 응답: `geoGenerationId`, `jsonLd`, `scriptTag`, `schemaTypes`, `validationWarnings`, `runtimeUsage`(스텝별 모델·토큰). 대용량 `diagnostics` 전체는 응답에 싣지 않습니다.
- 큐·DB를 우회하므로 `geo_generation`/`geo_result`에 흔적을 남기지 않습니다.
- `AGENTIC_GEO_PROVIDER=azure-openai`면 실제 LLM 호출이라 수십 초~수 분 걸립니다. 배선만 확인하려면 `mock`으로 바꾸면 몇 초에 끝납니다.

### 4. 트레이스 확인

UI(http://localhost:3100)에서 `geo-test-generation` 트레이스를 열면 입력 product/locale, 출력 요약, 그리고 자식 generation 관측으로 스텝별 모델·토큰이 보입니다. 응답의 `geoGenerationId`가 트레이스의 sessionId이므로 그걸로 검색하면 됩니다.

### 동작 방식·한계

- 계측 코드: `src/observability/langfuse.ts`(키 있을 때만 OTel 등록) + `src/geo/geo-test.controller.ts`(요청당 트레이스, 응답 직후 forceFlush).
- 생성기(`pdp-geo-generator-agent`)가 결과에 보고하는 `runtimeUsage.steps`를 **사후 매핑**하므로, 스텝별 프롬프트 원문과 실제 소요 시간은 아직 트레이스에 없습니다(필요 시 패키지에 관측 훅 추가가 다음 단계).
- Langfuse 서버 v4는 events_only 모드라 구 `/api/public/traces` 조회 API 대신 `/api/public/v2/observations`를 사용합니다(UI는 영향 없음).

## 아키텍처 요약

- **프레임워크**: NestJS(상시 기동 Node 서버). 8분짜리 백그라운드 생성 + Postgres write가 있어 서버리스형이 아닌 상시 컨테이너로 배포합니다.
- **큐**: 인프로세스 큐(단일 인스턴스). 접수(`POST`)는 큐에 등록만 하고 즉시 202를 반환합니다(`geoGenerationId` 기준 dedup으로 동일 ID 재등록은 무시). 워커(`GeoProcessor`, `GEO_WORKER_CONCURRENCY` 동시성)가 실제 생성을 수행합니다. 파드 재시작 시 진행 중이던 작업은 유실될 수 있으며, `geo_generation.status='PROCESSING'`으로 남은 행은 dispatcher stale sweep(15분)이 회수합니다.
- **가드(guard) 전이**: `geo_generation` 상태는 `PROCESSING → GENERATED`(성공) 또는 `PROCESSING → FAILED`(영구 오류, `error_phase=GENERATION`)로만 전이하며, 모든 UPDATE는 `WHERE status='PROCESSING'` 가드 조건과 `version+1` 낙관적 락으로 원자적·멱등하게 수행됩니다(`GeoGenerationRepository.transitionToGenerated/transitionToFailed`).
- **생성**: `@agentic-geo/pdp-geo-generator-agent`의 `generatePdpGeo`를 그대로 재사용합니다(다른 sub-agent 패키지는 사용하지 않음). 결과는 `deriveSchemaTypes`/`computeResultHash`로 가공해 `agentic_geo.geo_result`(json_ld/script_tag/schema_types/result_status/result_hash/rag_profile/diagnostics)에 기록합니다.
- **DB**: TypeORM, `synchronize:false`/`migrationsRun:false` — 스키마 소유권은 upstream-api(Flyway)에 있으며 agent-api는 마이그레이션을 절대 실행하지 않습니다.
- **무상태(stateless)**: 워커는 `job.data`와 DB에서만 필요한 정보를 읽으며 파드-로컬 메모리 상태에 의존하지 않습니다. 큐가 인프로세스가 된 뒤에도 이 원칙은 유지합니다 — 이후 멀티 인스턴스 큐로 되돌릴 때 처리 로직을 손대지 않기 위해서입니다.
- **재시도**: 큐 자체의 attempts는 최소로 설정하고(일시 오류만 소폭 backoff 재시도), 소진 시 무한 재시도 없이 즉시 `FAILED` 처리합니다. 프로세스 재시작으로 인한 유실은 dispatcher stale sweep(15분)이 단일 계층으로 회수합니다.

## 테스트 구성

- `*.spec.ts`: 순수 단위 테스트(상태 전이 판정, `deriveSchemaTypes`, 스키마 유틸 등, 인프라 불필요).
- `*.e2e-spec.ts`: NestJS 테스트 모듈 기반 HTTP 계약 테스트(가드/컨트롤러, DI mock 사용, 인프라 불필요).
- `test/regression/*.reg-spec.ts`: **GEO 생성 회귀**(케이스 YAML 기반 생성+평가). 기본 `pnpm test`에는 포함되지 않으며 `pnpm test:regression`으로 따로 돌립니다 — LLM 비용·시간이 들기 때문입니다. 실행법과 평가 기준은 [`test/regression/README.md`](./test/regression/README.md) 참고.
- `*.int-spec.ts`: Testcontainers(PostgreSQL 16)로 실제 인프라를 띄우는 통합 테스트. 기본 `pnpm test`에 포함되지 않으며 `pnpm test:int`로 따로 돌립니다(Docker 필요). 스키마는 엔티티 자동생성이 아니라 `test/fixtures/geo-schema.sql`로 만드는데, 이 파일은 upstream-api의 `V1__create_geo.sql`을 그대로 미러링하므로 엔티티와 운영 스키마가 어긋나면 여기서 깨집니다 — 이 스위트의 존재 이유입니다. `test/app-boot.int-spec.ts`는 `AppModule` 전체를 실제 DB 연결로 부팅해 `GET /health`가 200을 반환하는지 검증합니다(TypeOrmModule.forRoot의 readiness를 앱 부팅 수준에서 증명).
