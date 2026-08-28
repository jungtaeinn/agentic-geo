# RAG Retrieval Benchmark (evals/)

> **평가 티어 안내**: 이 문서는 결정적 **retrieval 벤치마크**(CI 게이트)를 다룹니다. 생성물이 실제로 AI 답변에서 인용되는지를 측정하는 **인용 가시성 벤치마크**(opt-in, LLM 사용)는 독립 패키지 [`packages/pdp-geo-eval-agent`](../../pdp-geo-eval-agent/README.md)로 분리되었고 `apps/geo-generator`의 `pnpm geo:benchmark`로 실행합니다. 두 티어는 상호보완입니다: 여기는 "재료가 다 들어왔다"까지, geo 티어는 "그 결과물이 인용 경쟁에서 이긴다"까지 보증합니다.

## 무엇을 측정하나

**LLM에게 글을 쓰라고 시키기 직전에, 참고자료를 제대로 골라줬는가**를 채점합니다. 생성된 글의 품질이 아니라 그 앞단인 검색(retrieval)만 봅니다.

```
상품 정보 → [1] RAG 검색: 가이드 문서에서 청크 top-8 선별 → [2] LLM 생성 → 결과물
                  ↑ 채점 구간
```

예를 들어 예시럭셔리 세럼의 **FAQ**를 생성한다면, top-8에 `eeat_v1.md # Experience`(사용 경험 서술 규칙)와 `cep_v1.md # CEP Dimensions`(고객 질문 유형)가 반드시 들어와야 합니다. 대신 스키마 마크업 규칙만 8개 들어오면 LLM은 FAQ 작성 규칙을 모른 채 글을 쓰게 됩니다. 이 벤치마크는 goldens 24문항에 대해 그런 필수 문서가 실제로 top-8에 들어왔는지를 기계적으로 확인합니다.

LLM·네트워크·난수를 쓰지 않으므로 같은 코드면 항상 같은 점수 — CI 회귀 게이트로 씁니다.

## 채점 방식 (시험 비유)

| 구성 요소 | 비유 | 실체 |
|---|---|---|
| goldens 24문항 | 시험 문제 | "예시럭셔리 세럼의 FAQ를 쓸 때, top-8에 `eeat_v1.md # Experience`가 있어야 한다" 같은 정답 명세 |
| expectedChunks | 정답지 | 그 문항에서 **반드시** 검색됐어야 하는 문서/헤딩 목록 (= 앵커) |
| runner.ts | 시험 감독 | agent의 실제 검색 경로를 그대로 재현해 top-8을 뽑음 |
| metrics.ts | 채점기 | 뽑힌 top-8과 정답지를 대조해 점수 산출 |

한 문항의 채점 흐름:

1. fixture 상품 + 타깃(예: `faq`)으로 서브쿼리 생성
2. 코퍼스에서 후보 24개 검색 → 서브쿼리 정합 부스트 → kind-coverage 기반 최종 **top-8** 선택
3. top-8 안에 정답 앵커가 몇 개 들어왔는지 세서 점수화
4. 후보 24개를 평가 모집단, 최종 top-8 선택 여부를 예측값으로 삼아 TP/FP/FN/TN 분류 지표 계산

## 지표가 실제로 뜻하는 것

| 지표 | 질문 형태로 바꾸면 | 계산식 | 낮으면 생기는 문제 |
|---|---|---|---|
| `claimRecall` | "**꼭 필요한 근거를 빠뜨리지 않았나?**" | top-8에 들어온 정답 앵커 수 ÷ 그 문항의 전체 정답 앵커 수 | LLM이 핵심 규칙을 못 본 채 생성 → 잘못된/근거 없는 문장 |
| `contextPrecision` | "**쓸데없는 문서로 자리를 낭비하지 않았나?**" | top-8 중 타깃에 유효한 청크 수 ÷ 8 | 무관한 청크가 컨텍스트 창을 차지해 정작 필요한 근거가 밀려남 |
| `classification.precision` | "**선택한 청크 중 실제 관련 청크 비율은?**" | TP ÷ (TP + FP) | 컨텍스트 예산이 무관한 청크에 낭비됨 |
| `classification.recall` | "**후보군의 관련 청크를 얼마나 선택했나?**" | TP ÷ (TP + FN) | 관련 후보를 찾고도 최종 선택에서 놓침 |
| `classification.accuracy` | "**후보 24개의 선택/비선택을 전체적으로 얼마나 맞혔나?**" | (TP + TN) ÷ 전체 후보 | 최종 선택기가 관련/무관 후보를 전반적으로 잘 구분하지 못함 |
| `noiseChunkRate` | "**빈 껍데기 청크가 섞이지 않았나?**" | top-8 중 본문 60자 미만(헤딩만 있는) 청크 비율 ÷ 8 | 토큰만 먹고 정보량 0 — 청킹 로직 버그 신호 |

- 유효한 청크 판정 기준(precision): ① 정답 앵커와 일치하거나 ② 청크의 intent가 해당 타깃의 intent 집합에 포함되거나 ③ `kind: orchestration`(모든 타깃에 항상 필요한 정책 문서).
- `contextPrecision`과 `classification.precision`은 같은 관련성 판정을 사용합니다. 전자는 문항별 precision의 단순 평균, 후자는 전체 confusion count를 합산한 micro precision이므로 집계값은 조금 다를 수 있습니다.
- `claimRecall`은 정답 앵커 회수율이고 `classification.recall`은 top-24의 관련 후보 중 top-8 선택률입니다. 이름은 비슷하지만 평가 대상이 다르므로 서로 대체하지 않습니다.
- `claimRecall`, `contextPrecision`, `noiseChunkRate`는 문항별 점수의 **단순 평균**입니다. `classification` 지표는 TP/FP/FN/TN을 합산한 **micro 평균**이며 `byTarget`도 같은 방식입니다.
- accuracy는 TN이 많으면 높아질 수 있으므로 단독으로 판단하지 않고 precision·recall·claimRecall과 함께 봅니다.
- `claimRecall`이 1.0이어도 좋은 글이 나온다는 보장은 없습니다. 이 벤치마크는 **"재료가 다 들어왔다"까지만** 보증합니다.

분류 confusion matrix 정의:

| | 실제 관련 | 실제 무관 |
|---|---:|---:|
| top-8에 선택 | TP | FP |
| top-8에서 제외 | FN | TN |

## 측정 대상이 아닌 것

- LLM이 생성한 문장의 품질/문체/사실성 → CI에서 채점하지 않음 (아래 `faithfulness` 참고)
- 실서비스 응답 속도, 비용
- 임베딩 모델 자체의 성능 (CI는 해시 임베딩 사용 — §5.3 한계 참고)

`faithfulness`(생성물에 필수 문구가 있고 금지 문구가 없는지)는 `metrics.ts`의 `scoreFaithfulness(golden, generatedText)`로 별도 호출할 때만 채점됩니다. 검색 벤치마크 CI에는 포함되지 않습니다.

---

이 문서는 에이전트가 벤치마크를 실행하고 **요약 보고서를 아웃풋으로 작성**하는 표준 절차입니다.

## 빠른 시작 (에이전트 표준 실행 경로)

작업 디렉토리: `packages/pdp-geo-generator-agent/`

```bash
pnpm rag:eval -- --json    # 기계 판독용(권장): 점수 + 베이스라인 대비 delta + 문항별 상세
pnpm rag:eval              # 사람 판독용 리포트
pnpm rag:eval -- --write   # 베이스라인 갱신 (아래 "베이스라인 갱신 규칙" 필독)
npx vitest run tests/rag-eval.test.ts   # 회귀 게이트만 실행
```

`--json` 출력 구조:

```jsonc
{
  "status": "ok",                  // "error"면 unresolvableAnchors 확인 (goldens 오타)
  "aggregates": {
    "goldens": 24,
    "claimRecall": 0.722,
    "contextPrecision": 0.948,
    "classification": { "tp": 182, "fp": 10, "fn": 357, "tn": 27, "precision": 0.948, "recall": 0.338, "accuracy": 0.363 },
    "noiseChunkRate": 0,
    "byTarget": { ... }
  },
  "baseline": { ... },             // 커밋된 베이스라인 (evals/baseline.json)
  "deltaVsBaseline": { "claimRecall": 0, "byTarget": { ... } },
  "scores": [                      // 문항별 상세 — 보고서의 "실패 문항" 섹션 재료
    { "goldenId": "CGRS-PDESC", "target": "productDescription", "claimRecall": 0.5,
      "classification": { "tp": 8, "fp": 0, "fn": 15, "tn": 1, "precision": 1, "recall": 0.348, "accuracy": 0.375 },
      "missedAnchors": ["eeat_v1.md # Trust-First Claim Safety"], "matchedAnchors": [...], ... }
  ]
}
```

## 시험지 구성 (goldens 24문항)

- **상품 fixture 4종** — ExampleLuxe en-US 2종 + EXAMPLEDERMA ko-KR 2종 (2026-07-31 실 PDP 추출)
- **생성 타깃 5종** — `faq` / `howToUse` / `productDescription` / `webPageDescription` / `schema`
- **+ 프로브 문항** — claim-safety(금지 표현), locale(언어·시장별 표현), evidence(근거 카드) 라우팅 확인

정답 앵커는 임의로 정한 게 아니라, 코퍼스 문서(`eeat_v1.md`, `cep_v1.md`, `geo-research_v3.md`)가 자체적으로 선언한 "Partial Update Query Planning" 섹션을 따릅니다. 즉 **코퍼스가 스스로 약속한 라우팅 계약을 실제로 지키는지** 검증하는 구조입니다.

## 요약 보고서 아웃풋 템플릿

에이전트는 실행 후 아래 형식으로 보고서를 작성합니다. `--json` 출력의 필드를 그대로 매핑하면 됩니다.

```markdown
# RAG 벤치마크 요약 보고서 (YYYY-MM-DD)

## 판정
- 상태: PASS | REGRESSION (게이트: 전 지표가 베이스라인 -0.03 이내)
- 전체 claim recall: {aggregates.claimRecall} ({deltaVsBaseline.claimRecall} vs baseline {baseline.claimRecall})
- context precision: {aggregates.contextPrecision} ({delta...})
- classification precision: {aggregates.classification.precision} ({delta...})
- classification recall: {aggregates.classification.recall} ({delta...})
- classification accuracy: {aggregates.classification.accuracy} ({delta...})
- confusion matrix: TP={...}, FP={...}, FN={...}, TN={...}
- noise chunk rate: {aggregates.noiseChunkRate}

## 타깃별 점수
| 타깃 | claim recall | classification precision | classification recall | accuracy |
|---|---|---|---|---|
(byTarget 5행 — deltaVsBaseline.byTarget에서 Δ)

## 만점 미달 문항 (claimRecall < 1)
| 문항 | 타깃 | recall | 누락 앵커 |
|---|---|---|---|
(scores에서 claimRecall < 1인 항목의 goldenId / target / claimRecall / missedAnchors)

## 해석
- 하락 항목이 있으면: 어떤 변경(커밋/파일)이 원인 후보인지 1-2문장.
- 개선 항목이 있으면: 무엇을 바꿔서 올랐는지 1-2문장.
- 알려진 잔여 한계(문서 §5.3): 동일 문서 내 형제 섹션 의미 변별은 해시 임베딩 한계 —
  실임베딩 스냅샷(`pnpm rag:precompute-embeddings`) 전까지 productDescription 잔여 miss는 예상 범위.

## 조치
- REGRESSION: 원인 변경 되돌리기 또는 수정 후 재실행. 베이스라인을 낮춰서 통과시키지 말 것.
- 의도된 개선으로 점수 상승: `pnpm rag:eval -- --write`로 베이스라인 갱신 + 같은 커밋에 포함.
```

## 절대 규칙 (에이전트 필독)

1. **goldens는 시험지다 — 점수를 올리기 위해 수정 금지.** `goldens.ts`의 expectedChunks를 느슨하게 바꾸면 점수는 오르지만 아무것도 개선되지 않는다(Goodhart). goldens 수정이 정당한 유일한 경우: 신규 상품/타깃 커버리지 추가, 코퍼스에서 헤딩이 실제로 개명되어 앵커가 깨진 경우(무결성 테스트가 잡아줌).
2. **fixtures(`fixtures/products.ts`)는 동결.** "개선"하면 과거 베이스라인과의 비교가 전부 무효화된다.
3. **베이스라인 갱신 규칙**: 점수가 **의도적으로** 오른 변경(코퍼스 개선, 검색 로직 개선)이나 신규 지표의 최초 기준선 등록에서만 `--write` 실행하고, 반드시 해당 변경과 같은 커밋에 baseline.json 포함. 하락을 덮으려고 갱신하는 것은 금지.
4. **회귀 게이트**: `tests/rag-eval.test.ts`가 전체·타깃별 claim recall과 classification precision/recall/accuracy를 베이스라인 대비 ε=0.03으로 검사한다. CI에서 실패하면 원인 변경을 수정하는 것이 정답이지 게이트를 완화하는 것이 아니다.
5. 문서 코퍼스(`src/rag/*.md`)를 수정했다면 키워드 스터핑으로 점수를 올리지 말 것 — 섹션 리드 문장은 "이 규칙이 어느 필드에 적용되는가"를 사실대로 명시하는 자기완결화만 허용.

## 파일 구조

```
evals/
  README.md              이 문서
  baseline.json          커밋된 기준 점수 (회귀 게이트의 비교 대상)
  goldens.ts             시험지 24문항 (동결 — 규칙 1)
  fixtures/products.ts   실상품 fixture 4종 (동결 — 규칙 2)
  metrics.ts             지표 계산 (claim recall / classification precision·recall·accuracy / noise / faithfulness)
  runner.ts              agent 실경로를 재현하는 결정적 러너
scripts/run-rag-eval.ts  CLI (--json / --write)
tests/rag-eval.test.ts   CI 회귀 게이트 (ε=0.03)
```

## 이력·트러블슈팅

- 점수 이력과 각 개선의 근거: `docs/rag-inference-maximization-paper-analysis_2026-07-31.md` §5.1(최초 베이스라인 0.476) → §5.2(검색 코드 개선, 0.677) → §5.3(문서 자기완결화, 0.722).
- `status: "error"` / unresolvable anchors: goldens.ts의 앵커가 코퍼스 문서/헤딩과 불일치. 최근 코퍼스 헤딩 변경을 확인.
- faithfulness는 CI 대상이 아니다 (위 "측정 대상이 아닌 것" 참고).
- 실행이 느리면(>60s) 임베딩 캐시가 없는 첫 실행이다. 정상.
