---
"@agentic-geo/pdp-geo-generator-agent": patch
---

fix: 리뷰가 짚은 사본·문자 체계 편향·잘못된 순서를 고친다

머지 전 최종 코드 품질 리뷰(Opus)가 확인한 것들이다.

**① 성분명 조각 판정이 낱말 안의 음절을 조사로 읽었다**

한글은 조사를 띄어 쓰지 않으므로 형태만으로는 `알로에`와 `알로`+`에`를 가를 수 없다. 격조사 판정을 성분 어휘 앵커보다 앞에 두었더니 `알로에 베라 추출물`이 절의 조각으로 판정되어 발행물에서 **사라졌다**.

앵커를 절 판정보다 먼저 본다. 앵커가 그 구분을 대신해 준다 — `알로에 베라 추출물`은 `추출`로 이름임이 드러나고, `피부에 닿`은 드러낼 것이 없다. 마침표 검사만 앵커 앞에 남긴다(이름은 문장부호로 끝나지 않으므로, 앵커를 품은 전사 조각 `Barrier-Protective Formula cleansing.`이 그 검사에서 걸려야 한다).

**② 시험 귀속 판정이 세 벌 복사되어 이미 어긋나 있었다**

시험 방법 정규식이 `generate.ts`에 문자 단위로 동일한 사본 세 벌이었고, 그 옆의 표본 정규식은 이미 갈라져 있었다 — 한쪽은 맨몸 `participants`를 알고 다른 쪽은 몰라, 표본을 `subjects: 30 adults`로 적은 문장이 한 페이지 안에서 "귀속됨"과 "미귀속"을 동시에 받았다. `contracts/metric-statement-contract.ts`의 `statesStudyMethod`·`statesStudyPopulation`으로 올렸다.

같은 종류의 어긋남을 생성기와 검증기 사이에서도 찾았다. 근거 정황 판정이 양쪽에 복사되어 있었고, 생성기만 분 단위 기간(`10분 후`, `after 30 minutes`)을 인정했다 — 생성기가 발행한 문장을 검증기가 근거 없다고 판정하는 상태였다. `statesEvidenceContext`로 합쳤다. 이 계약 모듈이 존재하는 이유가 그것이다.

**③ 미귀속 수치 차단이 한국어 결과어만 알았다**

`isUnstructuredQuantifiedOutcomeClaim`은 한국어 결과어 목록으로만 발동하는데, 유일한 소비자는 로케일 구분 없이 돈다. `Ceramide level improved 84.3% after 4 weeks`는 게이트에 닿지도 못해 방법·표본 없이 `Reported result`로 발행됐다. 이미 같은 파일이 쓰고 있던 양쪽 문자 체계 패턴(`METRIC_DIRECTION_PATTERN`)으로 바꿨다.

**④ 영문 절 판정이 서술 동사를 열거했다**

주석은 "절을 만드는 기능어와 경동사 — 어느 상품이 와도 같은 닫힌 부류"라고 적었지만 `reinforces|guards|reduces|improves`는 닫힌 부류가 아니다. `Ceramide Complex soothes dryness`가 명사구로 통과해 마케팅 절이 성분명 자리를 차지했다.

동사는 어휘가 아니라 굴절로 잡는다 — 영어 3인칭 단수 현재형은 `-s`로 끝나고, 소문자이며(이름은 대문자로 쓴다), 뒤에 목적어가 온다. `Amino Acids Complex`의 `Acids`는 대문자여서 걸리지 않는다. 줄 첫머리의 대문자 동사(`Contains Ceramide`)만은 굴절로 가릴 수 없어(`Probiotics Ferment Filtrate`와 형태가 같다) 기존 목록에 남기고, 주석이 그 경계를 밝힌다.

**⑤ 디버그 덤프가 시험 파일로 커밋되어 있었다**

`tests/tmp-1027-usage.test.ts`가 절대 경로의 스크래치패드 파일을 읽고 `expect(true).toBe(true)`만 했다. 다른 기계에서는 깨진다. 지웠다.
