/**
 * @fileoverview 성분 표면 어휘의 단일 출처.
 *
 * 성분 어휘는 함수가 아니라 사전이다. 문장의 기능으로 규정할 수 있는 것(측정
 * 진술인가, 함유 진술인가)과 규정할 수 없는 것(무엇이 성분명인가)은 다르다.
 * 사전을 함수로 바꾸려는 시도는 실패하지만, **사본은 없앨 수 있다.**
 *
 * 같은 표(패턴 → 표준 표면)가 두 곳에 복사되어 있었고, 이미 어긋나 있었다.
 * 검출 쪽은 `panthenol`과 `hyaluronic`을 알고 정규화 쪽은 `판테놀`과
 * `hyaluronic acid`만 알아서, 영문 원문의 `Contains Panthenol to soothe`가
 * 표준 표면으로 접히지 못하고 문장째로 성분 목록에 발행됐다.
 *
 * 순서가 의미를 갖는다. 위쪽 항목이 아래쪽보다 좁은 표면을 가리키므로(브랜드
 * 성분이 일반 성분보다 앞), 먼저 맞은 것이 답이다.
 */

/** 원문에 나타나는 표기 하나와, 그것이 가리키는 표준 표면. */
export interface IngredientSurfaceRule {
  pattern: RegExp;
  surface: string;
  /**
   * 같은 물질을 가리키는 표면들이 공유하는 식별자.
   *
   * `Ceramide`와 `세라마이드`는 한 물질의 두 표기다. 그 사실을 어디에도 적어
   * 두지 않아, 한국어 페이지의 `Key ingredients`에 둘이 나란히 실렸다 — 읽는
   * 사람에게는 두 가지 성분처럼 보인다. 어느 표기를 쓸지는 문자 체계로 고르면
   * 되므로(한국어 페이지엔 한글 표면), 세 번째 매핑 표를 만들지 않고 같은
   * 물질이라는 사실만 남긴다.
   */
  substance?: string;
}

/**
 * 브랜드·라인 고유 성분. 일반 성분보다 먼저 읽어야 한다 — `진생펩타이드`를
 * `펩타이드`로 접으면 그 상품의 고유 성분이라는 사실을 잃는다.
 */
export const brandIngredientSurfaceRules: readonly IngredientSurfaceRule[] = [
  { pattern: /500[-\s]?hour(?:\s+aged)?\s+ginseng/iu, surface: "500-hour aged ginseng" },
  { pattern: /korean herb extract/iu, surface: "Korean herb extract" },
  { pattern: /botanicalcomplex|보태니컴플렉스/iu, surface: "Korean Ginseng Actives (BotanicalComplex)", substance: "botanicalcomplex" },
  { pattern: /korean ginseng actives/iu, surface: "Korean Ginseng Actives", substance: "botanicalcomplex" },
  // 같은 성분의 한글 표면. 원문이 한국어로 쓴 상품에서는 이 표기가 공개 문안에
  // 실려야 하므로, 영문 별칭과 함께 어휘에 남는다 — 검출은 맞은 항목을 모두
  // 내고, 정규화는 먼저 맞은 하나를 낸다.
  // 한글 표면도 같은 물질이다. `-ko` 접미사로 갈라 두었더니 물질 기준 묶기가
  // 원리적으로 불가능해져, 소비처에 표면 하드코딩 우회 분기가 남았다 —
  // "표면이 아니라 물질로 묶는다"는 주석 바로 위에 표면 목록이 있었다.
  { pattern: /보태니컴플렉스|botanicalcomplex/iu, surface: "보태니컴플렉스", substance: "botanicalcomplex" },
  { pattern: /진생\s*펩타이드|진생펩타이드|ginseng peptide/iu, surface: "진생펩타이드", substance: "ginseng-peptide" },
  { pattern: /진생\s*레티놀|진생레티놀|ginseng retinol/iu, surface: "진생레티놀", substance: "ginseng-retinol" }
];

/**
 * 일반 성분. 영문·한글 표기를 한 항목에 함께 둔다 — 표기별로 항목을 나누면
 * 한쪽만 갱신되고, 그렇게 갈라진 사본이 문장을 성분명으로 발행했다.
 */
export const genericIngredientSurfaceRules: readonly IngredientSurfaceRule[] = [
  { pattern: /ginseng peptide/iu, surface: "Ginseng Peptide", substance: "ginseng-peptide" },
  { pattern: /retinol/iu, surface: "Retinol", substance: "retinol" },
  { pattern: /niacinamide/iu, surface: "Niacinamide", substance: "niacinamide" },
  { pattern: /hyaluronic(?:\s+acid)?|sodium hyaluronate/iu, surface: "Hyaluronic Acid", substance: "hyaluronic-acid" },
  { pattern: /\bzinc\b/iu, surface: "Zinc", substance: "zinc" },
  { pattern: /ceramide/iu, surface: "Ceramide", substance: "ceramide" },
  { pattern: /panthenol/iu, surface: "Panthenol", substance: "panthenol" },
  { pattern: /betaine/iu, surface: "Betaine", substance: "betaine" },
  { pattern: /probiotics?/iu, surface: "Probiotics", substance: "probiotics" },
  { pattern: /징크/u, surface: "징크", substance: "zinc" },
  { pattern: /히알루론산|하이알루론산/u, surface: "히알루론산", substance: "hyaluronic-acid" },
  { pattern: /나이아신아마이드/u, surface: "나이아신아마이드", substance: "niacinamide" },
  { pattern: /판테놀/u, surface: "판테놀", substance: "panthenol" },
  { pattern: /베타인/u, surface: "베타인", substance: "betaine" },
  { pattern: /프로바이오틱스/u, surface: "프로바이오틱스", substance: "probiotics" },
  { pattern: /세라마이드/u, surface: "세라마이드", substance: "ceramide" }
];

/** 브랜드 성분과 일반 성분을 읽는 순서 그대로 이은 전체 어휘. */
export const ingredientSurfaceRules: readonly IngredientSurfaceRule[] = [
  ...brandIngredientSurfaceRules,
  ...genericIngredientSurfaceRules
];

/**
 * 이 텍스트가 가리키는 표준 성분 표면. 먼저 맞은 항목이 답이다.
 *
 * 텍스트가 문장이어도 그 안의 성분명을 표준 표면으로 접는다 — 접지 못하면
 * 호출자가 원문을 그대로 성분명으로 쓰게 되고, 그러면 성분 목록에 서술문이
 * 실린다.
 */
export function canonicalIngredientSurface(
  text: string,
  rules: readonly IngredientSurfaceRule[] = ingredientSurfaceRules
): string | undefined {
  return rules.find((rule) => rule.pattern.test(text))?.surface;
}

/** 이 원문 뭉치에 나타난 표준 성분 표면 전부(어휘 순서대로). */
export function ingredientSurfacesPresentIn(haystack: string): string[] {
  return ingredientSurfaceRules
    .filter((rule) => rule.pattern.test(haystack))
    .map((rule) => rule.surface);
}

/**
 * 이 텍스트가 **그 물질 자체를 가리키는 표기**일 때의 물질 식별자.
 *
 * 같은 물질의 다른 표기는 같은 값을 내야 한다(`Ceramide`·`세라마이드`). 그러나
 * 그 물질을 수식어로 품은 복합 성분명은 다른 성분이다 — `고밀도 세라마이드
 * 캡슐`을 `세라마이드`와 한 묶음으로 세면 그 상품의 고유 성분이 사라진다.
 * 그래서 수치·단위·괄호를 걷어낸 뒤 표면과 **같을 때만** 물질로 읽는다.
 */
export function ingredientSubstanceKey(text: string): string | undefined {
  const bare = bareSubstanceText(text);
  return bare
    ? ingredientSurfaceRules.find((rule) => rule.substance !== undefined && bare === bareSubstanceText(rule.surface))?.substance
    : undefined;
}

/** 수치·단위·괄호를 걷어낸 비교용 표기. */
function bareSubstanceText(text: string): string {
  return text
    .replace(/\([^)]*\)/gu, " ")
    .replace(/\d[\d,.]*\s*(?:%|％|ppm|mg|g|ml|mL|oz)?/giu, " ")
    .replace(/[^\p{L}]+/gu, "")
    .toLowerCase();
}
