# GEO 회귀 평가 기준

케이스 하나는 네 관점으로 평가되며, 앞의 세 층이 실제로 판정에 쓰입니다.

## 1. 계약 검증 (결정적)

케이스 YAML의 `expect`를 산출물에 그대로 대조합니다. LLM을 쓰지 않으므로 같은 산출물이면 항상 같은 결과가 나옵니다.

| 항목 | 검사 내용 |
| --- | --- |
| `resultStatus` | `SUCCEEDED` / `SUCCEEDED_WITH_WARNINGS` 일치 |
| `schemaTypes` | 지정한 schema.org 타입이 그래프에 모두 존재 |
| `forbiddenSchemaTypes` | 지정한 타입이 발행되지 **않음** |
| `maxValidationWarnings` | 미해결 검증 경고 수가 상한 이하 |
| `contains` / `notContains` | JSON-LD의 모든 문자열 값을 이어붙인 공개 텍스트 기준 |
| `jsonPath` | 경로별 `equals` / `contains` / `exists` |

한 건이라도 어긋나면 **fail**입니다. 여기서 걸리는 건 해석의 여지가 없는 확정적 위반입니다.

## 2. 결정적 품질 루브릭

`@agentic-geo/pdp-geo-eval-agent`의 `evaluateGeoQuality`를 호출합니다. **웹 콘솔이 화면에 그리는 것과 같은 함수**이며, 기대값이 없어도 항상 실행해 기록합니다.

| 차원 | 의미 |
| --- | --- |
| **GEO** | schema.org 스키마 위생 — 그래프 무결성, 필수 노드, 게이트키퍼 신호(가격·수정일), 검증 경고 |
| **CEP** | 고객 진입점 맥락 — 대상 고객 단서, 선택 기준, 성분–효능 연결 |
| **E-E-A-T** | 근거·스코핑 위생 프록시 — 근거 출처, 클레임 모달리티, 측정 범위 명시 |

각 차원은 0~100점이며 `score` / `criteria` / `summary` / `evidence[]` / `improvements[]`를 함께 냅니다. `overallScore`는 세 차원의 종합입니다.

이 루브릭은 **인용 확률 예측이 아니라 결정적 위생 진단**입니다. E-E-A-T 점수도 Google의 E-E-A-T 평가가 아니라 근거·스코핑 위생의 프록시입니다. 가점·감점 표는 `packages/pdp-geo-eval-agent/docs/quality-scoring.md`에 있습니다.

`expect.minScore`를 지정한 차원만 하한을 검사하며, 미달 시 **fail**입니다.

## 2b. 점수 일치 검증

생성기(`pdp-geo-generator-agent`)는 **같은 루브릭으로 자기 출력을 측정**합니다. 임계(기본 GEO 90 / CEP 95 / E-E-A-T 90) 미달 차원이 있으면 그 부족분만 겨냥해 교정 리파인을 1회 돌리고, 교정본이 측정상 개선됐을 때만 채택합니다(better-or-rollback). 그 내역이 `diagnostics.qualityGate`에 남습니다.

회귀는 자기가 재계산한 점수를 이 기록과 대조합니다.

- 게이트가 교정본을 채택했으면 `correctedScores`와, 아니면 `initialScores`와 같아야 합니다.
- 어긋난다면 루브릭이 바뀌었거나 생성기가 게이트 이후 아티팩트를 손댔다는 뜻이므로, **그 자체가 회귀 신호**입니다.

불일치는 **warning**으로 다룹니다 — 산출물이 틀렸다는 뜻은 아니고, 파이프라인 전제가 흔들렸다는 신호이기 때문입니다.

> 임계값(90/95/90)을 그대로 `minScore`에 옮기지 마세요. 게이트는 미달이어도 개선에 실패하면 롤백해 그대로 내보냅니다. 임계 미달 산출물이 정상적으로 나오는 구조입니다.

## 3. LLM 심사 (opt-in)

`GEO_REGRESSION_LLM_JUDGE=true`일 때만 실행합니다. `data-highway-agent`의 `evaluator.py` 판정 체계를 그대로 옮겼습니다.

### 입력

- 입력 product (agent-api 요청 본문)
- 생성된 콘텐츠 섹션 + JSON-LD
- `expect.goldenAnswer` (선택)

### 판정 원칙

1. 입력 product가 담은 사실이 산출물에 충분히 반영됐는지 먼저 봅니다.
2. 표현이나 문장 순서가 달라도 의미가 같으면 반영된 것으로 봅니다.
3. 입력에 없는 효능·수치·성분·인증·리뷰가 새로 만들어졌다면 강하게 감점합니다.
4. 정보가 추가로 더 있다는 이유만으로는 감점하지 않습니다.
5. 모범답변은 **사실 검증용 참고 자료**입니다. 표현·구조가 다르다는 이유로 감점하지 않고, 사실이 모순되거나 핵심이 빠졌을 때만 감점합니다. 모범답변이 없으면 입력 product의 사실 범위만을 기준으로 판단합니다.

### 점수 → 판정

| 점수 | 판정 |
| --- | --- |
| 7~10 | `pass` |
| 4~6 | `warning` |
| 1~3 | `fail` |

출력은 `score` / `reasoning` / `coveredPoints` / `missingPoints`이며, 심사 프롬프트 원문도 결과에 함께 저장됩니다.

## 4. 인용 프로브 — v1 미구현

`runCitationProbe`는 모의 AI 검색엔진에 우리 PDP를 경쟁 문서 4개와 함께 넣고, 생성 전/후 텍스트의 인용 점유율 차이를 재는 진단입니다.

v1에서 제외한 이유는 두 가지입니다.

1. **비결정적입니다.** 엔진 답변이 매번 달라져 delta가 흔들리므로, 임계 pass/fail 게이트로 쓰면 헛 실패가 납니다.
2. **agent-api 경로에서는 대조군의 성격이 다릅니다.** 프로브의 vanilla는 원래 "추출된 원본 PDP 텍스트"인데, agent-api는 extractor가 없고 `product` JSON을 받으므로 vanilla가 입력 JSON을 펼친 덤프가 됩니다.

나중에 켜더라도 fail 게이트가 아니라 리포트의 관찰 지표로 두는 편이 맞습니다.

## 케이스 통과 조건

| 상태 | 조건 |
| --- | --- |
| `failed` | 계약 위반 있음 / `minScore` 미달 / LLM 심사 `fail` |
| `warning` | 점수 일치 검증 불일치 / LLM 심사 `warning` |
| `passed` | 위 어느 것에도 해당하지 않음 |
| `error` | 생성 호출 자체가 예외로 끝남 |
| `skipped` | 케이스에 `skip: true` |

**`failed`만 테스트를 실패시킵니다.** warning은 리포트에 남기고 통과시킵니다 — 경고까지 빨간불로 만들면 아무도 리포트를 안 보게 되고, 그러면 진짜 실패도 같이 묻히기 때문입니다.

상태와 무관하게 케이스 결과 JSON은 **항상** 저장됩니다. 실패 케이스일수록 산출물이 필요합니다.
