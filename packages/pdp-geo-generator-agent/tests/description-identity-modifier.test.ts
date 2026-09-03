import { describe, expect, it } from "vitest";
import { descriptionIdentityUnitIsSupported } from "../src/content-planner";
import type { PdpGeoAtomicEvidence, PdpProductSignal } from "../src/types";

// 실측 결함(예시더마 모이베리어365 클렌징폼, 1145 KR 런, 2026-09-01): 모델이 쓴
// 정상 도입부 "예시더마 모이베리어365 클렌징폼은 EXAMPLEDERMA의 약산성
// 클렌저입니다."가 통째로 삭제되어 Product.description이 상품명 없는 종속절
// ("건조 피부 또는 민감 피부를 대상으로, ...")로 시작했다. 원인: 정체성 예외
// (descriptionIdentityUnitIsSupported)가 문장의 모든 실질 토큰이 identity
// 필드(상품명/원어명/브랜드/카테고리)에만 있기를 요구했는데, "약산성"은
// identity 필드가 아니라 인용된 근거 원자(ev-description-1fgomsr 등)에만
// 있었다. "약산성"만으로 every()가 실패해 정체성 예외가 발동하지 못했고,
// 문장은 의미 감사로 떨어져 삭제됐다.
function identityAtom(text: string): PdpGeoAtomicEvidence {
  return {
    id: "ev-identity-name",
    role: "identity",
    text,
    sourcePath: "product.name",
    locale: "ko-KR",
    productScope: "product",
    confidence: 1
  };
}

function evidenceAtom(id: string, text: string): PdpGeoAtomicEvidence {
  return {
    id,
    role: "description",
    text,
    sourcePath: "product.semanticFacts.evidenceSentences[0]",
    locale: "ko-KR",
    productScope: "product",
    confidence: 0.9
  };
}

const product = {
  name: "예시더마 모이베리어365 클렌징폼",
  originalName: "예시더마 모이베리어365 클렌징폼",
  brand: "EXAMPLEDERMA",
  category: "클렌저"
} as unknown as PdpProductSignal;

// "약산성"은 identity 필드 어디에도 없고, 인용된 설명 근거에만 실재한다 —
// 실측 결함과 동일한 형태다.
const citedWithModifierEvidence = [
  identityAtom(product.name),
  evidenceAtom("ev-description-1fgomsr", "약산성 포뮬라로 노폐물과 자극 없이 세정을 돕습니다.")
];

describe("descriptionIdentityUnitIsSupported", () => {
  it("keeps a copula identity sentence whose modifier is only in cited evidence, not the identity fields (실측 재현)", () => {
    const unit = "예시더마 모이베리어365 클렌징폼은 EXAMPLEDERMA의 약산성 클렌저입니다.";
    expect(descriptionIdentityUnitIsSupported(unit, citedWithModifierEvidence, product)).toBe(true);
  });

  it("does not let an action/effect predicate ride through on the widened token pool (과통과 방지)", () => {
    // Same identity + evidence tokens as the case above, but the sentence
    // ends in an action predicate ("세정합니다") instead of a copula. Widening
    // the token pool to cited evidence (fix #3) would, by itself, let this
    // sentence pass too, since every token it uses is now backed. The copula
    // check (fix #2) is what keeps an action/effect claim out of this
    // exception, so it must fall through to the ordinary semantic audit.
    const unit = "예시더마 모이베리어365 클렌징폼은 EXAMPLEDERMA의 약산성 클렌저로 노폐물을 세정합니다.";
    expect(descriptionIdentityUnitIsSupported(unit, citedWithModifierEvidence, product)).toBe(false);
  });

  it("still drops a copula sentence whose modifier is not in the identity fields or the cited evidence", () => {
    // "피부과 테스트를 완료한" (completed a dermatology test) is a genuine
    // unsupported claim: it appears in neither the identity fields nor the
    // cited evidence, so the exception must not launder it through just
    // because the sentence is otherwise a copula identity statement.
    const unit = "예시더마 모이베리어365 클렌징폼은 피부과 테스트를 완료한 클렌저입니다.";
    expect(descriptionIdentityUnitIsSupported(unit, citedWithModifierEvidence, product)).toBe(false);
  });

  it("keeps a copula sentence built only from identity fields (기존 회귀)", () => {
    const unit = "예시더마 모이베리어365 클렌징폼은 EXAMPLEDERMA의 클렌저입니다.";
    expect(descriptionIdentityUnitIsSupported(unit, [identityAtom(product.name)], product)).toBe(true);
  });

  it("keeps a copula identity sentence written in 해요체 (final-proofreader.ts의 copula-polite 어미와 동기화)", () => {
    // final-proofreader.ts는 "이에요"/"예요"를 이미 계사 어미로 취급한다
    // (koreanParticleGroups의 copula-polite 그룹). 이 게이트가 습니다체만
    // 인식하면 같은 규칙의 두 구현이 갈라져, 정당한 해요체 정체성 문장이
    // 삭제된다.
    const unit = "예시더마 모이베리어365 클렌징폼은 EXAMPLEDERMA의 약산성 클렌저예요.";
    expect(descriptionIdentityUnitIsSupported(unit, citedWithModifierEvidence, product)).toBe(true);
  });
});
