# GEO/CEP/E-E-A-T 품질 점수 산식

> **유지보수 규칙**: 이 문서는 `src/pdp_geo_eval_agent/quality/evaluate.py`·`src/pdp_geo_eval_agent/quality/internal.py`의 산식과 항상 동기화되어야 한다.
> 두 파일의 가점/감점/조건을 바꾸면 이 문서도 같은 커밋에서 갱신한다. 라인 번호 대신 함수/조건 이름으로 참조한다.

세 차원 모두 `clamp_quality_score`로 `[0, 100]`에 고정(clamp)한다. **종합점수 = 세 차원의 단순 평균**(`js_round(mean(geo, cep, eeat))`, `evaluate_geo_quality` 반환부).

## GEO (base 90)

| 델타 | 트리거 조건 | cap | 근거 함수/조건 |
| --- | --- | --- | --- |
| +5 | `hasOfferPrice` — Offer에 숫자/문자열 price 존재 | - | `hasExplicitOfferPrice` |
| +5 | `hasFreshnessSignal` — 그래프/WebPage에 dateModified\|datePublished\|dateCreated 존재 | - | `hasFreshnessTimestamp` |
| −18 | `!hasProductIdentity` — Product `@id`+`name` 미충족 | - | `hasProductIdentity` |
| −14 | `!hasWebPageIdentity` — WebPage `@id`+`name` 미충족 | - | `hasWebPageIdentity` |
| −10 | `!hasProductDescription` — Product `description` 비어있음 | - | `hasProductDescription` |
| −8×n | `danglingLocalReferences` — 로컬 `#` 참조 중 그래프에 없는 대상 개수 | 16 | `countDanglingLocalSchemaReferences` |
| −8 | `!faqStructureValid` — FAQPage 존재하는데 mainEntity 항목이 전부 유효하지 않음/0개 | - | `faqStructureValid` |
| −8 | `!howToStructureValid` — HowTo 존재하는데 name 없음/유효 스텝 0개/스텝 유효성 불일치(유효 스텝 ≥1이면 통과 — 생성기 계약: 원문 지시 1개 = 스텝 1개) | - | `howToStructureValid` |
| −10 | `!faqPlanConsistent` — 모델 콘텐츠 플랜의 FAQ 포함 개수 ≠ 스키마 FAQ 개수 | - | `faqPlanConsistent` |
| −10 | `!howToPlanConsistent` — 플랜의 HowTo eligible 여부/스텝 수 ≠ 스키마 상태 | - | `howToPlanConsistent` |
| −8×n | `artifactHits` — 노출 텍스트에 소스 헤딩명·OCR 노이즈·내부 라벨(fallbackDescription 등) 유출 | 16 | `collectPublicArtifactHits` |
| −3×n | `validationWarnings` — repair로 해소되지 않은 잔여 경고 수(HTML 콘텐츠 스코프 제외) | 15 | `partitionValidationWarnings` |
| −2×n | `validationRepairs` — 적용된 자동 교정 수(HTML 콘텐츠 스코프 제외) | 10 | `scoredValidationRepairs` |

## CEP (base 85)

| 델타 | 트리거 조건 | cap | 근거 함수/조건 |
| --- | --- | --- | --- |
| +8 | 성분·효능 문장이 모두 있고(`ingredientBenefitBridgeApplicable`) 그 둘을 연결하는 문장 존재 | - | `hasIngredientBenefitChoiceBridge` |
| +4 | RAG 사용 로그 중 "target customer context" 원칙 또는 `kind: "cep"` 참조가 1건 이상 | - | `cepRagUsage` |
| +3 | 콘텐츠 플랜의 CEP 항목이 모두 evidenceIds를 가짐(`groundedCepPlan`) | - | `groundedCepPlan` |
| −12 | 고객 상황 신호 부재(정규식 미검출 **and** 플랜에 CEP 0건) | - | `customerCueSatisfied` |
| −10 | 선택 기준 신호 부재(정규식 미검출 **and** 플랜에 CEP 0건) | - | `selectionCueSatisfied` |
| −12 | 성분·효능이 모두 있는데 연결 문장이 없음 | - | `hasIngredientBenefitChoiceBridge` |
| −12 | 성분·효능이 둘 다 0건 | - | `ingredientCount`, `benefitCount` |
| −8×n | 콘텐츠 플랜 CEP 항목 중 evidenceIds가 비어있는 항목 수 | 16 | `contentPlan.cep` |
| −6×n | `artifactHits`(GEO와 동일 소스, 재사용) | 12 | `collectPublicArtifactHits` |

## E-E-A-T (base 90)

| 델타 | 트리거 조건 | cap | 근거 함수/조건 |
| --- | --- | --- | --- |
| +5 | 원자 단위 근거(evidenceLedger)가 있고, 플랜에 계획된 모든 콘텐츠 유닛이 evidenceLedger ID로 전부 커버됨 | - | `hasAtomicEvidenceCoverage`, `atomicallyCoveredPlanUnits` |
| +3 | RAG 사용 로그에 "evidence-backed claims" 원칙이 enabled | - | `evidenceBackedUsage` |
| +2 | `%` 수치 클레임이 있고 `hasReportedDetails`(측정 방식·참여자 언급)도 있음 | - | `hasClaimMetrics && hasReportedDetails` |
| −30 | evidenceLedger·근거 소스(input/fieldMapping/rag/terminology)가 전부 0건 | - | `evidenceLedger`, `sourceEvidence` |
| −8×n | 계획된 콘텐츠 유닛 중 evidenceLedger로 완전히 커버되지 않은 유닛 수 | 24 | `plannedEvidenceUnits - atomicallyCoveredPlanUnits` |
| −5×n | 계획에서 참조하지만 evidenceLedger에 없는 evidence ID 수 | 20 | `invalidPlannedEvidenceRefs` |
| −12 | `%` 클레임은 있는데 표본/대상 범위 미기재(`hasSampleScope`=false) | - | `hasStudySample \|\| hasReportedSampleScopeDisclosure` |
| −10 | `%` 클레임은 있는데 사용/시험 기간 미기재(`hasTimeScope`=false) | - | `hasTimeScope` (아래 상세) |
| −8 | `%` 클레임은 있는데 측정 방식/참여자 언급 미기재(`hasReportedDetails`=false) | - | `hasReportedDetails` |
| −12×n | 클레임 왜곡 lint 적중 수(단위 중복·동사 중복·과장 폭·모달리티 혼동·구문 결함) | 24 | `collectMetricIntegrityIssues` |
| −4×n | `artifactHits`(GEO와 동일 소스, 재사용) | 12 | `collectPublicArtifactHits` |

### `hasSampleScope` / `hasTimeScope` (한국어 인식 규칙, 최종 상태)

`hasStudySample`는 "숫자 + 표본 명사(명/인/참여자/대상/사용자/응답자/여성/남성 또는 영어 women/men/participants 등)" 구조를 인식하며, 한국어 조사(을/를/이/가 등)가 뒤에 붙어도 매칭한다(숫자가 직접 이어지는 경우만 제외). `hasSampleScope`는 이 값 또는 "표본 범위가 원문에 없다고 명시"(`hasReportedSampleScopeDisclosure`)일 때 true.

`hasTimeScope`는 다음 중 하나라도 매칭되면 true:
- 영어: `N day(s)/week(s)/hour(s)` (옵션: 앞에 `after`)
- 한국어 접속 표현: `N시간/일/주` + `후|동안|뒤`
- 임상 첩포 시험: `N시간` + `패치|첩포` (예: "48시간 패치")
- 기간 접미: `N일간/N주간/N개월간`, `N개월 동안`
- 사용 시점: `사용|도포|세정` + `직후|전|N시간/일/주 후`
- "기간" 라벨 + 4자리 연도 날짜 범위(`YYYY.MM.DD~YYYY.MM.DD` 등)
- "기간" 라벨 없는 한국어 날짜 범위: `YYYY년 M월 D일부터 (M월 )?D일까지`
- 2자리 연도 숫자 날짜 범위: `YY.MM.DD-YY.MM.DD`

주의: 위 규칙은 "임상/시험 문맥"으로 좁게 설계됐다 — "24시간 보습 지속" 같은 광고성 지속 효과 문구는 의도적으로 매칭 대상에서 제외한다(마케팅 문구를 시험 기간으로 오인하지 않도록).

## 개념 반영도 심사 (점수 외 옵트인, `src/pdp_geo_eval_agent/quality/concept_judge.py`)

**위 표의 결정적 점수와는 완전히 분리된 별도 평가**다. `evaluate_geo_quality`의 산식·점수는 이 심사로 변경되지 않는다. 모델 설정(`GeoEvalEngineConfig`)이 주어졌을 때만 `judge_concept_embodiment`를 통해 옵트인으로 실행되는 LLM 판정이며, "스키마가 안전하게 작성됐는가"가 아니라 "GEO/CEP/E-E-A-T 개념이 콘텐츠에 실제로 녹아들었는가"를 심사한다.

| 개념 | 심사 기능(무엇을 확인하는가) |
| --- | --- |
| GEO | 생성엔진이 이 콘텐츠만으로 "무엇/누구를 위한 것/사용법/핵심 성분·기술/실사용 반응"에 자립적·인용 가능한 문장으로 답할 수 있는가 |
| CEP | 고객 진입 상황→니즈→제품 구성→결과→적합성으로 이어지는 인과 경로가 나열이 아니라 연결로 구현됐는가 |
| E-E-A-T | Experience(귀속된 실사용), Expertise(성분의 기능 설명), Authoritativeness(브랜드/용어 일관성), Trust(수치 클레임의 표본·기간·방식 스코핑) 네 요소가 각각 나타나는가 |

공정성 규칙: `diagnostics.normalizedProduct`의 소스 신호(리뷰·성분·사용법·효능 존재 여부/개수)를 프롬프트에 함께 제공하고, 소스에 없는 신호의 부재는 감점하지 말 것과 소스에 없는 내용을 추가하라는 개선 지시를 만들지 말 것을 시스템 프롬프트에 명시한다.

반환값 `ConceptEmbodimentAssessment.overallScore`는 모델이 준 총점을 신뢰하지 않고, 파서가 `geo`/`cep`/`eeat` 세 점수의 평균을 반올림해 직접 계산한다.
