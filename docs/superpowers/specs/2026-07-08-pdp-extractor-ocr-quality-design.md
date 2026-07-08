# PDP Extractor OCR 품질 극대화 설계 (2026-07-08)

## 배경

`packages/pdp-extractor-agent`는 PDP 이미지에서 vision LLM으로 텍스트를 전사(OCR)하고, 그 텍스트를 다시 LLM으로 분류해 benefits/effects/ingredients/usage/semanticFacts를 만든다. 2025–2026 최신 OCR 리서치(Vision-LLM 기반 문서 추출 SOTA, Structured Outputs, 2-pass 전사→구조화 분리, evidence grounding)와 코드 분석을 기반으로 AI 추론 품질과 OCR 이후 데이터 조합 단계를 최적화한다.

## 발견한 품질 저하 요인

1. OCR/분류 호출 모두 구조화 출력 미사용 — 정규식 JSON 추출 실패 시 결과 전량 유실
2. OpenAI Responses 경로에 `detail: "high"` 미지정 — 세로형 한국어 PDP 이미지의 작은 글씨 판독률 저하
3. 이미지 10장 동시 배치 — 이미지↔텍스트 매핑을 URL 에코/인덱스 추측에 의존, 텍스트 섞임 위험
4. Gemini provider vision OCR 미구현
5. confidence 하드코딩(0.72/0.54)
6. OCR 후보 중복 제거가 앞 220자 지문만 비교 — 부분 겹침 텍스트 오병합/유실
7. 분류가 최대 80개 후보를 단일 호출로 처리 — 긴 입력에서 후보 누락
8. 키워드 back-매칭이 단순 소문자 substring — 한국어 띄어쓰기 변형에 취약

## 설계 결정

### 1. 구조화 출력 전면 적용 (`src/llm/schemas.ts`)
- OpenAI Responses `text.format(json_schema, strict)` / Azure·AIStudio `response_format(json_schema)` / Gemini `responseMimeType + responseSchema`
- 스키마 미지원 모델은 에러 메시지 감지 후 스키마 없이 1회 재시도 (`isUnsupportedStructuredOutputError`)
- 파싱은 직접 parse → 코드펜스 제거 → 정규식 순의 다단 fallback (`extractJsonObjectText`)

### 2. Vision OCR 충실도
- 공유 전사 프롬프트(`createImageOcrPrompt`): 전사 전용(분류 금지), 잘린 텍스트 완성 금지, 읽기순서 유지, 표 행 유지, 언어 유지, 이미지별 confidence(0–1) 보고
- 배치 10→4, 1-based index 앵커링(`parseImageOcrPayloadText`: index → URL 에코 → 위치 순 매핑)
- OpenAI `detail: "high"` (Responses API sibling 필드), temperature 전달(+미지원 재시도)

### 3. Gemini vision OCR
- `extractImageTexts` 구현: 이미지 다운로드 → inline base64 → generateContent, responseSchema 강제

### 4. OCR 이후 데이터 조합 최적화 (`agent.ts`)
- `mergeOcrCandidates`: 전체 지문 포함관계 중복 제거 + 경계 라인 오버랩 병합(`joinOverlappingOcrTexts`, 정규화 20자 이상 겹침 시 병합) — 슬라이스/변형 이미지 경계 문장 보존
- `classifyOcrCandidates`: 14,000자 예산 기반 배치 분할, keywords/sentenceInsights/semanticFacts 병합(`mergeSemanticFacts` 재사용), 부분 실패는 `OCR_PROVIDER_PARTIAL` 경고로 기록
- confidence 전파: OCR 이미지별 confidence를 extractedTexts에 우선 사용, 없을 때만 분류 confidence
- `includesKeyword`: normalizeFingerprint 기반 매칭 추가 (한국어 띄어쓰기/조사 변형 대응)

## 범위 제외 (후속 과제)

- ~~세로 초장(예: 20,000px) 이미지의 물리적 슬라이싱~~ → 구현 완료 (2026-07-08 후속 작업): `sharp` optional dependency + 헤더 프로브 + 세로 1,400px·15% 오버랩 슬라이싱, `src/llm/providers/image-slicing.ts`
- Upstage Document OCR / CLOVA OCR 그라운딩 레이어 병행
- 골든셋(30–50개 PDP) 기반 필드 단위 정확도 회귀 평가 하네스

## 검증

- `pnpm --filter @agentic-geo/pdp-extractor-agent test` 50/50 통과
- typecheck / lint / build 통과
