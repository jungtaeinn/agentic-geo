import { describe, expect, it } from "vitest";
import {
  canonicalIngredientSurface,
  ingredientSurfaceRules,
  ingredientSurfacesPresentIn
} from "../src/contracts/ingredient-vocabulary";

/**
 * 성분 어휘는 함수가 아니라 사전이다. 사전을 함수로 바꿀 수는 없지만 사본은
 * 없앨 수 있고, 없애야 한다 — 검출용 표와 정규화용 표가 두 벌로 갈라져 있었고
 * 이미 어긋나 있었다(검출은 `panthenol`을 알고 정규화는 몰랐다).
 *
 * 이 시험이 지키는 것은 어휘의 내용이 아니라 **두 쓰임이 같은 표를 본다**는
 * 사실이다. 한쪽만 고치면 여기서 걸린다.
 */
describe("성분 어휘 단일 출처", () => {
  it("canonicalizes every surface the detector can find", () => {
    for (const rule of ingredientSurfaceRules) {
      expect(canonicalIngredientSurface(rule.surface)).toBeDefined();
    }
  });

  it("finds every surface it can canonicalize", () => {
    for (const rule of ingredientSurfaceRules) {
      expect(ingredientSurfacesPresentIn(rule.surface).length).toBeGreaterThan(0);
    }
  });

  it("reads both spellings of one ingredient as the same vocabulary", () => {
    // 표기별로 항목을 나누면 한쪽만 갱신된다. 한 항목이 두 표기를 함께 받아야 한다.
    expect(canonicalIngredientSurface("Contains Panthenol to soothe")).toBe("Panthenol");
    expect(canonicalIngredientSurface("판테놀 함유")).toBe("판테놀");
    expect(canonicalIngredientSurface("compressed hyaluronic")).toBe("Hyaluronic Acid");
    expect(canonicalIngredientSurface("hyaluronic acid")).toBe("Hyaluronic Acid");
  });

  it("reads a brand ingredient before the generic one it contains", () => {
    // `진생펩타이드`를 `Ginseng Peptide`로 접으면 그 상품의 고유 성분이라는
    // 사실을 잃는다. 어휘 순서가 그 관계를 담는다.
    expect(canonicalIngredientSurface("진생 펩타이드")).toBe("진생펩타이드");
    expect(canonicalIngredientSurface("500-hour aged ginseng")).toBe("500-hour aged ginseng");
  });

  it("returns nothing for text that names no ingredient", () => {
    expect(canonicalIngredientSurface("피부 각질층 내 함량 분석")).toBeUndefined();
    expect(ingredientSurfacesPresentIn("Dry or sensitive skin")).toEqual([]);
  });
});
