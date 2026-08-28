# PDP GEO Eval Agent

`packages/pdp-geo-eval-agent`는 schema.org PDP 산출물을 **평가만** 하는 독립 에이전트입니다. 추출(`pdp-extractor-agent`)·생성(`pdp-geo-generator-agent`)과 패키지 의존성이 전혀 없으며, 입력은 구조적 타입 계약(`src/types.ts`)으로 받습니다 — 앱이 세 에이전트를 연결합니다.

무의존 설계의 실익: 생성기를 거치지 않은 마크업(수작업 JSON-LD, CMS 산출물, 경쟁사 PDP 그래프)도 같은 기준으로 평가할 수 있습니다.

## 구성

| 모듈 | 내용 |
| --- | --- |
| `src/quality/` | 결정적 GEO/CEP/E-E-A-T 품질 루브릭 (`evaluateGeoQuality`), 이중 감점 제거·스케일 정규화·SIGIR 2026 게이트키퍼(가격/신선도) 가점·클레임 왜곡 lint 반영 |
| `src/citation/` | AutoGEO 이식 인용 점유율 지표, 모의 엔진 하네스, GEU 판정(KPR/KPC), 인라인 인용 프로브(+섹션 기여도) |
| `src/benchmark/` | 동결 goldens/distractors/fixtures + **주입형** 러너 `runGeoBenchmark({ artifacts })` |
| `src/prompts/` | Claude Code 등 LLM에 붙여넣는 개선 프롬프트 빌더 |
| `src/rest.ts` | 평가 전용 REST handler |

## 사용

```ts
import { evaluateGeoQuality, runCitationProbe } from "@agentic-geo/pdp-geo-eval-agent";

// 품질 루브릭 — 어떤 JSON-LD든 평가 가능
const evaluation = evaluateGeoQuality({
  jsonLd: generatorRun.result.schemaMarkup.jsonLd,   // 구조적 타이핑으로 그대로 전달
  diagnostics: generatorRun.diagnostics
}, "ko");
```

REST로 노출:

```ts
import { createPdpGeoEvalRestHandler } from "@agentic-geo/pdp-geo-eval-agent/rest";
export const POST = createPdpGeoEvalRestHandler();
```

## 벤치마크 (앱에서 배선)

이 패키지는 생성기를 호출하지 않으므로, 벤치마크는 앱 스크립트가 산출물을 만들어 주입합니다:

```bash
cd apps/geo-generator
pnpm geo:benchmark -- --provider azure-openai          # paired 리포트 (opt-in, LLM 사용)
pnpm geo:benchmark -- --provider azure-openai --write  # geo-benchmark-baseline.json 갱신
pnpm geo:extract-rules -- --provider azure-openai --results <geo-benchmark-json>
```

goldens/distractors/fixtures는 동결 자산입니다 — 점수를 올리기 위한 수정 금지, 커버리지 추가 시 같은 커밋에서 베이스라인 재생성.

## 평가 철학

- 루브릭은 **인용 확률 예측이 아니라** 결정적 위생 진단입니다. 인용 경쟁력은 프로브/벤치마크(paired 비교)가 측정합니다.
- E-E-A-T 점수는 Google의 E-E-A-T 평가가 아니라 근거·스코핑 위생의 프록시입니다.
- CEP는 정성 마케팅 프레임 기반으로 근거 등급이 낮아, 큐 감지를 콘텐츠 플랜과 교차 확인하고 가중치를 보수적으로 둡니다.
- 검증 경고는 GEO(스키마 위생) 차원에서만 감점됩니다.
- 각 차원의 정확한 가점/감점 표는 [`docs/quality-scoring.md`](./docs/quality-scoring.md) 참고.

## 명령어

```bash
pnpm --filter @agentic-geo/pdp-geo-eval-agent test
pnpm --filter @agentic-geo/pdp-geo-eval-agent typecheck
```
