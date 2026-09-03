---
"@agentic-geo/pdp-geo-generator-agent": patch
---

fix: 파생 산출물과 라벨 블록이 근거로 쓰이던 세 경로를 막는다

1027 최종 실행(실제 OCR)에서 `Product.description`이 이랬다.

> … 피부 장벽 성분입니다. **Ceramide 1000 ppm Moisturizing & strengthening for dry & sensitive skin 세라마이드는 피부 장벽을 강화하고 … 성분입니다.** 이처럼 …

패키지 라벨 블록이 문장 사이에 끼고, 그 뒤 문장이 앞과 중복됐다. 그리고 라벨 안의 `1000 ppm`은 제품컷(신뢰도 0.72)의 오독이다 — 상세 이미지들(0.90·0.96)은 `10,000 ppm`이라고 옮겼다.

**영문 라벨 블록이 성분명이 됐다**

`Key ingredients`에 `Ceramide 1000 ppm Moisturizing & strengthening for dry & sensitive skin`이 실렸다. 절 판정의 영문 기능어 목록에 전치사가 빠져 이 문장이 명사구로 통과했다. 구를 잇는 전치사가 있으면 이름이 아니라 구성이다. `of`는 화학명에 흔히 쓰이므로(`Sodium Salt of Hyaluronic Acid`) 넣지 않는다.

**파생 청크가 근거 수집에 들어왔다**

RAG 청크와 키워드 묶음은 상품 필드에서 **만들어진** 것이므로 그 자체가 근거가 될 수 없다. 이 원칙은 이미 세워져 있었으나(`isDerivedKeywordOrChunkKey`) 섹션 수집에만 적용되고 문자열 수집 경로에는 빠져 있었다.

**독립 문장 목록을 한 덩어리로 이어붙였다**

한 전사의 줄 목록(`lines`/`textBlocks`)을 잇는 것은 맞다 — 줄바꿈은 시각적 줄바꿈일 뿐이다. 그러나 `evidenceSentences`는 서로 다른 이미지에서 온 독립 문장의 목록인데, 키 이름이 `sentences`에 걸린다는 이유로 함께 이어붙었다. 그래서 없는 인접이 생기고, 뒤이은 문장 조립이 라벨과 성분 설명을 한 문장으로 만들었다. 문장의 목록은 각 문장을 그대로 후보로 둔다.

결과: 라벨 블록·중복 문장·오독 수치가 모두 발행물에서 사라졌다. 남은 것은 `WebPage.description`이 이 상품에서 비는 문제로, 별건이다.
