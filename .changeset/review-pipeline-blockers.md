---
"@agentic-geo/pdp-geo-generator-agent": patch
---

fix: 교정 패스를 무력화하던 finding 동일성과, 사본이 만든 발행·검증 불일치

**① 열거가 있는 상품에서 최종 교정 패스가 구조적으로 무력화됐다**

이 브랜치가 추가한 열거 finding은 `before`에 **필드 전문**을 담았다. 교정 전후의 검증 결과를 그 키로 대조하므로, 패스가 그 필드를 조금이라도 고치면 같은 finding이 다른 키가 되어 "새로 생긴 이슈"로 세어진다. 그러면 모든 필드의 편집이 되돌려지고 사유가 이렇게 보고된다.

```
before: …클렌저로, 피부 장벽, 세정력, 저자극 저자극 세안을 돕습니다.
after : …클렌저로, 피부 장벽, 세정력, 저자극 세안을 돕습니다.

status  rejected
reason  "All proposed edits were reverted because read-only validation
         found new issues: … listed three or more items under one predicate…"
```

사유가 사실이 아니다 — 그 열거는 편집 **전에도** 있었다. 중복 낱말은 그대로 발행된다. 열거 finding이 붙는 필드(`.description`, `acceptedAnswer.text`)는 하필 교정 패스가 편집하는 필드와 정확히 같아, 열거가 있는 상품에서는 교정이 언제나 되돌려졌다.

finding이 자기 동일성을 밝히게 했다. 특정 텍스트에 대한 finding은 그 텍스트가 동일성의 일부이지만(다른 중복 낱말은 다른 finding이다), **필드 산문의 형태**를 말하는 finding은 그 산문이 어떻게 쓰였든 같은 finding이다. `content.html` 예외가 홀로 처리하던 것을 `identity` 필드로 일반화했고, 열거 finding이 그것을 선언한다. 새 열거가 실제로 생기면 필드+이슈가 새 키이므로 여전히 잡힌다.

finding이 담는 `before`도 필드 전문에서 **위반 문장**으로 좁혔다 — 읽는 사람에게 필요한 것은 어느 문장이 열거하는지다.

**② 안전성 진술 판정이 세 벌이고, 검증기 사본에는 영문 절이 없었다**

`patch test`·`dermatologist-tested`·`hypoallergenic` 같은 영문 절이 생성기·정규화기 사본에는 있고 검증기 사본에는 **아예 없었다**. 그래서 영문 안전성 문장은 나갈 때는 안전성 진술로 분류되고 돌아올 때는 사용 단계로 판정됐다 — 렌더러는 발행하고 검증기는 거부하는 구조적 오류이고, 사용법 계약 모듈이 존재하는 이유로 든 바로 그 실패다. `isSafetyOrTestClaimUsage` 하나로 모았다.

**③ 정제 대상에서 두 속성 이름이 빠져 이전 수정이 되돌려졌다**

`Reported assessment summary`와 `Clinical result summary`가 근거 주석과 함께 삭제됐는데, 둘 다 여전히 살아있는 속성 이름이다 — `validate.ts`가 그 라벨의 오용을 감사하고 `isStablePropertyValueName`에도 들어 있다. 대체 장치가 없어, 삭제된 주석이 서술한 상태("원문 덩어리가 형제 근거 필드용 모델 패스를 우회한다")로 되돌아갔다. 복원했다.

**④ 프로비넌스 보상 게이트에 시험이 없었다**

"한 문장이라도 원장 원자와 맞지 않으면 필드 프로비넌스 전체를 버린다"는 규칙을 없애고 문장 단위 보호로 옮겼는데, 그 보호를 실행하는 시험이 하나도 없었다 — 게이트 루프를 통째로 지워도 전체 시험이 통과했다. 근거 없는 문장을 재작성하는 편집이 거부되는지 확인하는 시험을 넣고, 같은 뮤테이션으로 그 시험이 실제로 깨지는지 확인했다.
