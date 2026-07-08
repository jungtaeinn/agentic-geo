---
"@agentic-geo/pdp-extractor-agent": minor
---

feat: PDP 이미지 OCR 추론 품질 및 OCR 이후 데이터 조합 최적화

- 모든 provider의 OCR/분류 호출에 구조화 출력(JSON Schema) 강제: OpenAI Responses `text.format`, Azure/AIStudio `response_format`, Gemini `responseSchema` (+미지원 모델 자동 fallback 재시도)
- OpenAI vision OCR에 `detail: "high"` 적용, OCR 이미지 배치 10→4 축소, 1-based index 앵커링으로 이미지↔텍스트 오귀속 방지
- Gemini provider에 inline base64 vision OCR(`extractImageTexts`) 구현
- OCR 전사 프롬프트에 anti-hallucination 규칙 강화(잘린 텍스트 완성 금지, 읽기순서 유지, 표 행 유지, 이미지별 confidence 보고)
- OCR 후보 병합을 오버랩 인지 방식으로 개선: 전체 지문 기반 포함관계 중복 제거 + 슬라이스/변형 이미지의 경계 라인 오버랩 병합
- OCR 분류 입력을 문자 예산 기반 배치로 분할하고 keywords/sentenceInsights/semanticFacts를 병합, 부분 실패 허용
- 키워드 back-매칭을 정규화 지문 기반으로 교체(한국어 띄어쓰기 변형 대응), 모델 보고 confidence를 하드코딩 값 대신 전파
- fix: OCR 텍스트 비교에 무공백·비절단 정규화(`normalizeOcrComparisonText`) 도입 — 260자 절단 지문으로 인한 긴 텍스트 오병합과 띄어쓰기 변형 키워드 매칭 실패 해소
- fix: 커머스 노이즈 필터의 `레이어` 패턴을 `레이어 열기/닫기`로 정밀화해 화장품 용어 "레이어링" 오탐으로 상세 카피가 유실되던 문제 수정, OCR 후보 필터를 병합 이전 단계로 이동
- feat: 세로형 초장 상세 이미지(비율 3:1 초과·세로 2,048px 초과) 슬라이싱 OCR — 이미지 헤더 프로브(PNG/JPEG/GIF/WebP)로 크기 확인 후 세로 1,400px·15% 오버랩 조각으로 분할 전송, 조각 전사는 오버랩 병합으로 재결합. `sharp`는 optional dependency로 추가되어 미설치 환경은 통짜 전송으로 폴백(`IMAGE_SLICING_UNAVAILABLE` 경고)
- feat: `diagnostics.ocr` OCR 품질 추적 블록 — 이미지별 추출 상태/confidence/슬라이싱, 병합·드롭 통계, 분류 배치 상태, 공개 결과 활용도(미활용 텍스트 사유 포함), 리뷰 포인트(`issues`)를 기록해 사후 QA와 재개선 루프에 사용
