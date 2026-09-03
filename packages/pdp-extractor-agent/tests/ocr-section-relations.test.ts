import { describe, expect, it } from "vitest";
import { extractProductFromHtml } from "../src";

/**
 * OCR 블록의 절 관계(제목 → 항목)가 상품 필드 배치까지 이어지는지 본다.
 * 절 제목이 역할을 이미 선언했으므로, 본문 어휘로 역할을 다시 추측하지 않는다.
 */
function htmlWithImage(lines: string[]): string {
  return `<!doctype html><html><head><title>예시더마 모이베리어365 클렌징폼 200g</title>
  <meta name="description" content="아미노산 유래 세정 성분을 담은 약산성 포뮬라로 일상 속 노폐물을 세정" /></head>
  <body><main><h1>예시더마 모이베리어365 클렌징폼 200g</h1>
  <img src="https://cdn.example.com/upload/product/1145_1058.png" data-ocr-text="${lines.join("&#10;")}" /></main></body></html>`;
}

const USAGE_IMAGE_LINES = [
  "사용법",
  "1",
  "클렌징 단계에서 젖은 손에 적당량을 덜어",
  "충분히 거품을 내주세요.",
  "EXAMPLEDERMA",
  "BARRIERCARE 365",
  "CLEANSING FOAM",
  "2",
  "얼굴에 부드럽게 롤링하여",
  "노폐물을 녹여낸 후",
  "미온수로 깨끗이 씻어줍니다."
];

const SUMMARY_IMAGE_LINES = [
  "효능",
  "1",
  "약산성 아미노산 유래 세정 성분으로",
  "장벽 손상 방어",
  "2",
  "가벼운 메이크업 세정력",
  "핵심 성분",
  "Barrier Protective Formula",
  "(판테놀, 베타인, 보타온)",
  "추천 피부 타입",
  "건조 피부 또는 민감 피부"
];

describe("OCR 절 관계가 상품 필드로 이어진다", () => {
  it("publishes every numbered step of a 사용법 section, including a rinse-only step", async () => {
    const { result } = await extractProductFromHtml(
      htmlWithImage(USAGE_IMAGE_LINES),
      "https://shop.example.com/web/product/view.do?prdSeq=1145"
    );

    const usage = result.geoProduct.usage;
    expect(usage.some((text) => /^1[.)]\s*클렌징 단계에서 젖은 손에 적당량을 덜어 충분히 거품을 내주세요/.test(text))).toBe(true);
    expect(usage.some((text) => /^2[.)]\s*얼굴에 부드럽게 롤링하여 노폐물을 녹여낸 후 미온수로 깨끗이 씻어줍니다/.test(text))).toBe(true);
    // 패키지 라벨은 단계 본문이 아니다.
    expect(usage.some((text) => /EXAMPLEDERMA|CLEANSING FOAM/.test(text))).toBe(false);
  });

  it("routes a 핵심 성분 section to ingredients instead of benefits", async () => {
    const { result } = await extractProductFromHtml(
      htmlWithImage(SUMMARY_IMAGE_LINES),
      "https://shop.example.com/web/product/view.do?prdSeq=1145"
    );
    const { ingredients, benefits } = result.geoProduct;

    expect(ingredients.some((text) => text.includes("판테놀") && text.includes("베타인") && text.includes("보타온"))).toBe(true);
    expect(benefits.some((text) => text.includes("판테놀"))).toBe(false);
  });

  it("never lets a section heading leak into another section's value", async () => {
    const { result } = await extractProductFromHtml(
      htmlWithImage(SUMMARY_IMAGE_LINES),
      "https://shop.example.com/web/product/view.do?prdSeq=1145"
    );
    const values = [
      ...result.geoProduct.benefits,
      ...result.geoProduct.effects,
      ...result.geoProduct.ingredients,
      ...result.geoProduct.usage
    ];

    expect(values.some((text) => /추천 피부 타입/.test(text))).toBe(false);
    expect(values.some((text) => /핵심 성분/.test(text))).toBe(false);
  });

  it("keeps both 효능 items as separate claims", async () => {
    const { result } = await extractProductFromHtml(
      htmlWithImage(SUMMARY_IMAGE_LINES),
      "https://shop.example.com/web/product/view.do?prdSeq=1145"
    );
    const claims = [...result.geoProduct.benefits, ...result.geoProduct.effects];

    expect(claims.some((text) => text === "약산성 아미노산 유래 세정 성분으로 장벽 손상 방어")).toBe(true);
    expect(claims.some((text) => text === "가벼운 메이크업 세정력")).toBe(true);
  });

  it("never lets a before/after axis label declare a usage section", async () => {
    const { result } = await extractProductFromHtml(
      htmlWithImage([
        "집앞 나갈때 가볍게 하는",
        "색조 메이크업 97.1% 세정",
        "사용 전",
        "사용 후",
        "만 20~39세의 성인 여성 30명 대상 / 시험기간 2025.07.21-2025.08.22 / 개인차 있음",
        "피부 각질층 내 세라마이드 함량 분석",
        "+63.6%",
        "+84.3%",
        "※In vitro 시험 결과"
      ]),
      "https://shop.example.com/web/product/view.do?prdSeq=1145"
    );

    // "사용 전/사용 후"는 비교 축의 눈금 라벨이다. 사용법 절을 여는 제목이 아니다.
    expect(result.geoProduct.usage).toEqual([]);
  });

  it("does not publish a bare spec label as a measured claim", async () => {
    const { result } = await extractProductFromHtml(
      htmlWithImage([
        "EXAMPLEDERMA",
        "BARRIERCARE 365",
        "CLEANSING FOAM",
        "Barrier-Protective Formula",
        "For dry & sensitive skin",
        "7.05 oz. / 200 g"
      ]),
      "https://shop.example.com/web/product/view.do?prdSeq=1145"
    );

    // 용량 표기는 규격이다. 측정한 결과를 말하는 문장이 아니므로 수치 주장이 아니다.
    const claims = (result.geoProduct.semanticFacts?.metricClaims ?? [])
      .map((claim) => claim.sentence ?? "");
    expect(claims.some((sentence) => /7\.05 oz|200 g/.test(sentence))).toBe(false);
  });
});

/**
 * 미국 대상 페이지도 같은 관계를 갖는다.
 *
 * 실측(2026-09-03)에서 영문 사용법 이미지가 통째로 공개 출력에서 빠졌다. 제품
 * 근거 판정이 관리 어휘(피부·보습·skin·hydration…)를 요구하는데, 영문 사용법
 * 지시문에는 그런 낱말이 하나도 없다 — "Dispense an appropriate amount onto wet
 * hands and lather." 절 제목이 이미 역할을 선언했는데도 그 이미지가 버려졌다.
 */
function htmlWithEnglishImage(lines: string[]): string {
  return `<!doctype html><html><head><title>BarrierCare365 Cleansing Foam</title>
  <meta name="description" content="A mildly acidic cleansing foam with amino-acid derived cleansing agents." /></head>
  <body><main><h1>BarrierCare365 Cleansing Foam</h1>
  <img src="https://shop.example.com/upload/detail-usage.png" data-ocr-text="${lines.join("&#10;")}" /></main></body></html>`;
}

/**
 * 절 제목이 역할을 선언해도, 그 항목이 상품 주장이라는 뜻은 아니다.
 *
 * 선언 경로가 값 자격 검사를 통째로 면제해, 배지 눈금·규격·시험 고지가 효능
 * 주장으로 발행됐다. 역할을 정하는 것은 관계이고, 값이 될 수 있는지를 정하는
 * 것은 그 줄의 형태다 — 두 질문은 따로 물어야 한다.
 */
/**
 * 비교 축의 눈금은 제목이 아니다.
 *
 * 눈금을 제목으로 읽으면 그 뒤 문장 전체가 눈금의 역할을 뒤집어쓴다. 판정이
 * 형태 목록이던 때는 `제품 사용 후`·`도포 4주 후`·`After 4 weeks`가 모두 목록에
 * 없어 제목으로 읽혔다 — 이 함수가 막으려던 바로 그 시나리오다.
 */
describe("비교 축 눈금", () => {
  it("does not let a time tick declare a section role", async () => {
    const { result } = await extractProductFromHtml(
      htmlWithImage([
        "도포 4주 후",
        "각질층 수분량이 105% 개선되었습니다.",
        "사용법",
        "적당량을 손에 덜어 부드럽게 펴 바릅니다."
      ]),
      "https://shop.example.com/web/product/view.do?prdSeq=1145"
    );

    // 눈금이 절을 열지 않으므로, 임상 문장이 사용 단계로 발행되지 않는다.
    expect(result.geoProduct.usage.some((text) => text.includes("105%"))).toBe(false);
    expect(result.geoProduct.usage.some((text) => text.includes("펴 바릅니다"))).toBe(true);
  });
});

describe("피부 타입의 부정", () => {
  it("does not read a skin type the source rules out", async () => {
    // 원문이 배제한 타입을 표기로 읽으면, 그 제품이 권장하지 않는 대상이
    // `추천 피부 타입`으로 발행된다.
    const { result } = await extractProductFromHtml(
      htmlWithImage(["사용 시 주의사항", "지성 피부에는 권장하지 않습니다.", "민감 피부 테스트를 마쳤습니다."]),
      "https://shop.example.com/web/product/view.do?prdSeq=1145"
    );

    expect(result.geoProduct.semanticFacts?.skinTypes ?? []).not.toContain("지성 피부");
  });
});

describe("선언된 절의 값 자격", () => {
  it("does not publish a badge figure or a pack size as a claim", async () => {
    const { result } = await extractProductFromHtml(
      htmlWithImage(["효과", "+63.6%", "7.05 oz. / 200 g"]),
      "https://shop.example.com/web/product/view.do?prdSeq=1145"
    );

    const effects = result.geoProduct.effects;
    expect(effects.some((text) => text.includes("63.6"))).toBe(false);
    expect(effects.some((text) => text.includes("200 g"))).toBe(false);
  });

  it("does not publish a study footnote as a claim", async () => {
    const { result } = await extractProductFromHtml(
      htmlWithImage(["효과", "0", "10", "20", "※ 성인 여성 30명 대상 4주 사용 시험 결과"]),
      "https://shop.example.com/web/product/view.do?prdSeq=1145"
    );

    expect(result.geoProduct.effects.some((text) => text.includes("시험 결과"))).toBe(false);
  });

  it("still publishes a short declared value", async () => {
    const { result } = await extractProductFromHtml(
      htmlWithImage(["효능", "가벼운 메이크업 세정력"]),
      "https://shop.example.com/web/product/view.do?prdSeq=1145"
    );

    expect(result.geoProduct.benefits.concat(result.geoProduct.effects)
      .some((text) => text.includes("가벼운 메이크업 세정력"))).toBe(true);
  });
});

describe("OCR 절 관계 — 영문", () => {
  it("keeps an English usage image as product evidence", async () => {
    const { result } = await extractProductFromHtml(
      htmlWithEnglishImage([
        "HOW TO USE",
        "1",
        "Dispense an appropriate amount onto wet hands and lather.",
        "2",
        "Gently roll over the face, then rinse with lukewarm water."
      ]),
      "https://shop.example.com/products/barriercare365-cleansing-foam"
    );

    const usage = result.geoProduct.usage;
    expect(usage.some((text) => /^1[.)]\s*Dispense an appropriate amount/.test(text))).toBe(true);
    expect(usage.some((text) => /^2[.)]\s*Gently roll over the face/.test(text))).toBe(true);
  });

  it("keeps a short English direction that has no ordinal marker", async () => {
    // 제목 판정이 한국어에만 종결어미·조사 배제를 두어, 3어절 이하 영문 지시가
    // 제목으로 승격되고 항목에서 사라졌다. 같은 내용의 한국어는 전부 발행된다.
    const { result } = await extractProductFromHtml(
      htmlWithEnglishImage([
        "HOW TO USE",
        "Dispense an appropriate amount onto wet hands and lather.",
        "Rinse with water",
        "Use morning and evening for best results."
      ]),
      "https://shop.example.com/products/barriercare365-cleansing-foam"
    );

    expect(result.geoProduct.usage.some((text) => /Rinse with water/.test(text))).toBe(true);
  });

  it("does not read a skin type the source rules out", async () => {
    const { result } = await extractProductFromHtml(
      htmlWithEnglishImage([
        "CAUTION",
        "Not recommended for oily skin.",
        "Tested on sensitive skin."
      ]),
      "https://shop.example.com/products/barriercare365-cleansing-foam"
    );

    expect(result.geoProduct.semanticFacts?.skinTypes ?? []).not.toContain("oily skin");
  });

  it("reads an English recommended skin type", async () => {
    const { result } = await extractProductFromHtml(
      htmlWithEnglishImage([
        "KEY INGREDIENTS",
        "Barrier Protective Formula",
        "RECOMMENDED FOR",
        "Dry or sensitive skin"
      ]),
      "https://shop.example.com/products/barriercare365-cleansing-foam"
    );

    // 한국어는 머리 명사를 되풀이해("건조 피부 또는 민감 피부") 개별 타입이 그대로
    // 잡히지만, 영문은 머리 명사를 생략한다("Dry or sensitive skin"). 출력 형태는
    // 두 언어에서 같아야 한다 — 개별 피부 타입.
    const skinTypes = result.geoProduct.semanticFacts?.skinTypes ?? [];
    expect(skinTypes).toContain("dry skin");
    expect(skinTypes).toContain("sensitive skin");
  });
});
