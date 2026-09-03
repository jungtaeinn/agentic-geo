import { describe, expect, it } from "vitest";
import { generatePdpGeo } from "../src";
import { isCitationReadyProse, isKoreanRefinedMetricStatement } from "../src/generate";
import { sanitizePdpSemanticFacts } from "../src/normalize";
import type { PdpProductSignal } from "../src/types";

/**
 * 2026-09-01 예시더마 1145(모이베리어365 클렌징폼) 라이브 재실측에서 나온 회귀 2건.
 *
 * 추출 단계가 이미지 OCR 블록을 문장으로 분절하지 못해, 지표·표본·기간·단서가
 * 한 줄로 이어진 원문 덩어리가 `benefits`/`effects`/`sourceTexts`/`metricClaims
 * .sentence`에 그대로 실려 왔다. 같은 추출 결과의 `evidenceSentences`에는 LLM이
 * 문장으로 정제한 지표 서술이 따로 들어 있다.
 *
 * R-A: 그 덩어리가 `측정/평가 결과는 …입니다` 껍데기에 담겨 Product의
 *      `Reported details`와 방법론 요약 필드에 **같은 값으로 두 번** 발행됐다.
 * R-B: 구조화 필드(label/value/unit/method/sample/period)가 전부 빈 채로 들어와
 *      구조화 지표 포매터가 공회전하면서, 인용 가능한 수치가 공개 카피에서 전부
 *      사라졌다.
 *
 * 픽스처 값은 실측 산출물 그대로다(수치·기간·표본 불변).
 */

/** 분절되지 않은 OCR 블록 — 종결부호 없이 이어지고, 이미지 레이아웃 조각까지 섞여 있다. */
const UNSEGMENTED_BLOB = "일상 속 노폐물부터 가벼운 메이크업까지 세정, 장벽보호 · 딥클렌징 집앞 나갈때 가볍게 하는 색조 메이크업 97.1% 세정 사용 전 사용 후 눈에 잘 띄어 늘 고민인 모공 속 노폐물 97.6% 세정 사용 전 사용 후 만 20~39세의 성인 여성 30명 대상 / 시험기간 2025.07.21~2025.08.22 / 개인차 있음 (피부 각질층 내 세라마이드 함량 분석) +63.6% +84.3% +84.3% 자사 알레르겐 폼 예시더마 클렌징폼 사용 후 사용 2주 후 사용 4주 후 *in vitro 시험 결과";
/** 같은 추출 결과에서 LLM이 문장으로 정제한 지표 서술 — 수치와 그 수치의 주체를 함께 담고 있다. */
const REFINED_METRIC_SENTENCE = "색조 메이크업 세정력은 97.1%, 모공 속 노폐물 세정력은 97.6%로 제시됩니다.";
/** 정제된 단서 문장 — 계획 7c에 따라 문단 맨 끝 독립 문장으로만 실려야 한다. */
const REFINED_CAVEAT_SENTENCE = "개인에 따라 결과가 다를 수 있습니다.";
/** 블롭에만 등장하는 레이아웃 조각 — 에코 여부를 판정하는 지문(fingerprint)이다. */
const BLOB_FINGERPRINTS = ["집앞", "자사 알레르겐 폼", "사용 전 사용 후", "딥클렌징"];

function cleansingFoamProduct(overrides: Partial<PdpProductSignal> = {}): PdpProductSignal {
  return {
    name: "예시더마 모이베리어365 클렌징폼 200g",
    brand: "EXAMPLEDERMA",
    description: "약산성 아미노산 유래 세정 성분으로 장벽 손상을 방어하는 클렌징 폼입니다.",
    images: [],
    options: [],
    benefits: [
      "세안 중 발생하는 장벽 손상을 줄이는",
      "추천 피부 타입은 건조 피부 또는 민감 피부입니다.",
      UNSEGMENTED_BLOB
    ],
    effects: ["피부과 테스트 완료", "개선", UNSEGMENTED_BLOB],
    ingredients: ["보타온", "판테놀", "베타인"],
    usage: ["젖은 손에 적당량을 덜어 충분히 거품을 냅니다."],
    metrics: ["97.1%", "97.6%", "63.6%", "84.3%"],
    faq: [],
    reviews: { items: [], keywords: ["촉촉한 사용감"] },
    breadcrumbs: [],
    sourceTexts: [
      "추천 피부 타입은 건조 피부 또는 민감 피부입니다.",
      "판테놀은 비타민 B5 유도체로 피부 장벽 개선에 도움을 주는 성분으로 소개됩니다.",
      UNSEGMENTED_BLOB
    ],
    semanticFacts: {
      ingredients: ["보타온", "판테놀", "베타인"],
      benefits: ["세안 중 발생하는 장벽 손상을 줄이는", UNSEGMENTED_BLOB],
      effects: ["개선", UNSEGMENTED_BLOB],
      skinTypes: ["건조 피부", "민감 피부"],
      usageSteps: [],
      // 구조화 필드가 전부 비어 있는 실측 형태 — sentence/sourceText만 채워져 온다.
      metricClaims: [
        { sentence: "5 star", sourceText: "5 star" },
        { sentence: UNSEGMENTED_BLOB, sourceText: UNSEGMENTED_BLOB },
        { sentence: REFINED_METRIC_SENTENCE, sourceText: REFINED_METRIC_SENTENCE }
      ],
      evidenceSentences: [
        UNSEGMENTED_BLOB,
        "추천 피부 타입은 건조 피부 또는 민감 피부입니다.",
        REFINED_METRIC_SENTENCE,
        REFINED_CAVEAT_SENTENCE
      ],
      ingredientBenefitLinks: []
    },
    ...overrides
  } as unknown as PdpProductSignal;
}

async function productNode(product: PdpProductSignal): Promise<Record<string, any>> {
  const run = await generatePdpGeo({ product, hints: { locale: "ko-KR" } });
  return (run.result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>)
    .find((node) => node["@type"] === "Product") as Record<string, any>;
}

async function additionalProperties(product: PdpProductSignal): Promise<Array<{ name: string; value: string }>> {
  return (((await productNode(product)).additionalProperty ?? []) as Array<Record<string, string>>)
    .map((entry) => ({ name: String(entry.name ?? ""), value: String(entry.value ?? "") }));
}

/** 근거 요약을 담는 속성 이름들 — 이 중 둘 이상이 같은 값으로 발행되던 것이 R-A의 세 번째 결함이었다. */
const EVIDENCE_FIELD_NAMES = /^(?:Reported details|Clinical result summary|Reported assessment summary)$/;

/**
 * 구조화 지표가 정상적으로 채워진 상품 — 근거 필드가 실제로 발행되는 대조 픽스처.
 * (수치·기간·표본은 기존 회귀 픽스처와 동일한 형태를 따른다.)
 */
function structuredStudyProduct(): PdpProductSignal {
  const studySentence = "인체적용시험 결과 사용 4주 후 피부 수분량이 33.7% 증가했습니다.";
  return {
    name: "배리어 리커버리 크림",
    brand: "EXAMPLEDERMA",
    description: "건조하고 민감한 피부의 장벽 케어를 돕는 크림입니다.",
    images: [],
    options: [],
    benefits: ["피부 장벽 강화", "보습 지속"],
    effects: [studySentence],
    ingredients: ["세라마이드", "판테놀"],
    usage: ["세안 후 적당량을 얼굴에 펴 바릅니다."],
    metrics: ["피부 수분량 33.7% 증가"],
    faq: [],
    reviews: { items: [], keywords: ["촉촉한 사용감"] },
    breadcrumbs: [],
    sourceTexts: [studySentence],
    semanticFacts: {
      ingredients: ["세라마이드", "판테놀"],
      benefits: ["피부 장벽 강화"],
      effects: [],
      skinTypes: ["건조 피부", "민감 피부"],
      usageSteps: [],
      metricClaims: [{
        label: "피부 수분량",
        subject: "피부 수분량",
        value: "33.7",
        unit: "%",
        metric: "피부 수분량",
        direction: "증가",
        timing: "사용 4주 후",
        baseline: "사용 전",
        period: "2025.03.04-2025.04.15",
        sample: "건조 고민이 있는 성인 32명",
        method: "인체적용시험",
        institution: "(주)엘리드",
        evidenceGroup: "엘리드 인체적용시험",
        sentence: studySentence,
        sourceText: studySentence
      }],
      evidenceSentences: [studySentence],
      ingredientBenefitLinks: []
    }
  } as unknown as PdpProductSignal;
}

function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?。！？])\s+/u).map((sentence) => sentence.trim()).filter(Boolean);
}

describe("R-A: 분절되지 않은 OCR 블록은 속성 필드에 실리지 않는다", () => {
  it("블록 자체가 인용 가능한 산문으로 판정되지 않는다", () => {
    expect(isCitationReadyProse(UNSEGMENTED_BLOB)).toBe(false);
    // 같은 지표를 담은 정제 문장은 계속 통과한다.
    expect(isCitationReadyProse(REFINED_METRIC_SENTENCE)).toBe(true);
  });

  it("포매터가 붙인 종결부호로는 블록을 통과시키지 못한다", () => {
    // 실측에서 블록이 살아남은 경로: 요약 라벨과 마침표를 덧붙인 형태.
    expect(isCitationReadyProse(`확인 지표: ${UNSEGMENTED_BLOB}.`)).toBe(false);
  });

  it("종결 서술로 닫히는 길고 수치가 많은 문장은 통과한다", () => {
    const denseButComplete = "(주)엘리드가 2025년 3월 4일부터 2025년 4월 15일까지 스스로 피부가 민감하다고 느끼고 건조 고민이 있는 성인 여성 32명을 "
      + "대상으로 진행한 인체적용시험에서 사용 2주 후 피부 수분량은 사용 전 대비 21.4% 증가했고, 사용 4주 후 피부 수분량은 사용 전 대비 33.7% 증가했으며, "
      + "같은 시험에서 사용 4주 후 피부 장벽 지표는 사용 전 대비 18.2% 개선된 것으로 측정되었습니다";

    expect(denseButComplete.length).toBeGreaterThan(220);
    expect(isCitationReadyProse(denseButComplete)).toBe(true);
  });

  it("한국어 종결 형태로 판정할 수 없는 문장에는 이 규칙을 적용하지 않는다", () => {
    const englishEvidence = "In a home usage test survey of 600 women with daily use, 92% of participants agreed that skin looks "
      + "clear and bright, 86% of participants agreed that fine lines look reduced, and 96% of participants agreed that skin texture felt smoother";

    expect(englishEvidence.length).toBeGreaterThan(220);
    expect(isCitationReadyProse(englishEvidence)).toBe(true);
  });

  it("라벨 덤프 껍데기도 블록 에코도 발행하지 않는다", async () => {
    const properties = await additionalProperties(cleansingFoamProduct());
    const serialized = properties.map((entry) => `[${entry.name}] ${entry.value}`).join("\n");

    expect(serialized).not.toContain("측정/평가 결과는");
    for (const fingerprint of BLOB_FINGERPRINTS) {
      expect(serialized).not.toContain(fingerprint);
    }
  });

  it("근거 필드를 두 이름으로 중복 발행하지 않는다", async () => {
    // 이 픽스처는 구조화 지표를 갖고 있어 근거 필드가 실제로 채워진다 — 중복
    // 발행 여부는 값이 있는 상태에서만 판정할 수 있다.
    const properties = await additionalProperties(structuredStudyProduct());
    const evidenceFields = properties.filter((entry) => EVIDENCE_FIELD_NAMES.test(entry.name));

    expect(evidenceFields).toHaveLength(1);
    expect(evidenceFields[0]?.name).toBe("Reported details");
    // 중복 해소가 "근거를 지웠다"는 뜻이 되면 안 된다.
    expect(evidenceFields[0]?.value).toContain("33.7");
  });

  it("정상적인 짧은 속성값은 그대로 살아 있다 (음성 대조군)", async () => {
    const properties = await additionalProperties(cleansingFoamProduct());

    expect(properties.find((entry) => entry.name === "Recommended skin type")?.value)
      .toBe("건조 피부 또는 민감 피부");
    expect(properties.find((entry) => entry.name === "Key ingredients and technologies")?.value)
      .toBeTruthy();
  });
});

describe("isKoreanRefinedMetricStatement: 정제 문장의 선별 규칙", () => {
  it("수치와 그 수치의 주체를 함께 담은 완결 문장을 선별한다", () => {
    expect(isKoreanRefinedMetricStatement(REFINED_METRIC_SENTENCE)).toBe(true);
  });

  it("스코프 없는 순수 수치는 선별하지 않는다", () => {
    expect(isKoreanRefinedMetricStatement("97.1%")).toBe(false);
    expect(isKoreanRefinedMetricStatement("97.1%, 97.6%입니다.")).toBe(false);
  });

  it("분절되지 않은 블록은 선별하지 않는다", () => {
    expect(isKoreanRefinedMetricStatement(UNSEGMENTED_BLOB)).toBe(false);
  });

  it("방법·표본 없는 정량 결과 주장은 여전히 선별하지 않는다 (게이트 완화 금지)", () => {
    expect(isKoreanRefinedMetricStatement("피부 수분량이 33.7% 증가했습니다.")).toBe(false);
  });
});

describe("R-B: 정제된 근거 문장에서 인용 가능한 수치를 복구한다", () => {
  it("Product.description에 수치가 자립 문장으로 실린다", async () => {
    const description = String((await productNode(cleansingFoamProduct())).description ?? "");
    const metricSentence = sentencesOf(description).find((sentence) => sentence.includes("97.1"));

    expect(metricSentence).toBeTruthy();
    // 자립: 그 문장만 잘라도 수치의 주체와 범위가 함께 있어야 한다.
    expect(metricSentence).toContain("세정력");
    expect(metricSentence).toContain("97.6");
    // 사실 불변: in vitro 세라마이드 함량 수치를 인체적용 세정력과 섞지 않는다.
    expect(description).not.toContain("84.3");
    expect(description).not.toContain("63.6");
  });

  it("단서는 문단 끝 독립 문장이고 그 뒤에 어떤 주장도 없다", async () => {
    const description = String((await productNode(cleansingFoamProduct())).description ?? "");
    const sentences = sentencesOf(description);
    const caveatIndex = sentences.findIndex((sentence) => /결과가\s*다를\s*수\s*있습니다/u.test(sentence));

    expect(caveatIndex).toBeGreaterThanOrEqual(0);
    expect(caveatIndex).toBe(sentences.length - 1);
    // 단서는 다른 주장에 붙지 않은 독립 문장이다.
    expect(sentences[caveatIndex]).toMatch(/^개인에\s*따라/u);
  });

  it("정제 문장이 없으면 수치를 공개하지 않는다 (보수적 실패)", async () => {
    const product = cleansingFoamProduct({
      semanticFacts: {
        ...(cleansingFoamProduct().semanticFacts as any),
        metricClaims: [{ sentence: UNSEGMENTED_BLOB, sourceText: UNSEGMENTED_BLOB }],
        evidenceSentences: [UNSEGMENTED_BLOB]
      } as any
    });
    const description = String((await productNode(product)).description ?? "");

    expect(description).not.toContain("97.1");
    expect(description).not.toContain("97.6");
  });
});

/**
 * 1027(크림 미스트) 실측 형태 — 정제된 지표 문장이 없는 상품.
 * `evidenceSentences`는 캐시된 추출 산출물(`examplederma-1027-run.json`) 그대로다.
 */
function creamMistProduct(): PdpProductSignal {
  const awardBanner = "2020 GLOWPICK AWARDS WINNER 94% 93% 93% EXAMPLEDERMA ATO BARRIER 365 CREAM MIST Ceramide 10,000 ppm Moisturizing & strengthening for dry & sensitive skin";
  const layoutDump = "흔들 필요 없는 특수 에멀젼 공법 일반 미스트 크림 미스트 크림층 수분층 VS 하얀색 유액 AES • 작게 쪼개진 세라마이드와 수분이 묶여있어 흔들 필요 없이 사용하는 터치리스 착붙보습 • 10,000ppm 세라마이드로 가득 채운 미세촘촘 안개미스트 • 부드럽게 뿌려져 피부 표면에 보습막을 형성";
  return {
    name: "모이베리어 365 크림 미스트",
    brand: "EXAMPLEDERMA",
    description: "수분을 충전하는 동시에 보습막을 형성하는 크림 미스트입니다.",
    images: [],
    options: [],
    benefits: ["보습", "수분", "장벽", "진정"],
    effects: ["케어", "효과"],
    ingredients: ["세라마이드"],
    usage: ["연약하고 건조해진 피부 부위에 미세 분사해 사용합니다."],
    metrics: ["120ml", "94%", "93%", "120 mL"],
    faq: [],
    reviews: { items: [], keywords: ["촉촉한 사용감"] },
    breadcrumbs: [],
    sourceTexts: [awardBanner, layoutDump],
    semanticFacts: {
      ingredients: ["세라마이드"],
      benefits: ["보습", "수분"],
      effects: ["케어"],
      skinTypes: ["건성 피부"],
      usageSteps: [],
      metricClaims: [
        { sentence: "120ml", sourceText: "120ml" },
        { sentence: awardBanner, sourceText: awardBanner }
      ],
      evidenceSentences: [
        awardBanner,
        "세라마이드는 피부 장벽을 강화하고 피부 내 수분을 유지하는 데 도움을 주는 피부 장벽 성분으로 소개됩니다.",
        "이 제품은 수분을 충전하는 동시에 보습막을 형성하는 효능을 표방하며, 건성 피부 및 모든 피부 타입에 추천됩니다.",
        "작게 쪼개진 세라마이드와 수분을 결합한 특수 에멀젼 공법으로, 흔들지 않고 사용할 수 있는 크림 미스트입니다.",
        layoutDump
      ],
      ingredientBenefitLinks: []
    }
  } as unknown as PdpProductSignal;
}

describe("평서체 종결 인식 (해라체 오탐 방지)", () => {
  const plainDeclarativeStudySentence = "(주)엘리드가 2025년 3월 4일부터 2025년 4월 15일까지 스스로 피부가 민감하다고 느끼고 건조 고민이 있는 성인 여성 32명을 "
    + "대상으로 진행한 인체적용시험에서 사용 2주 후 피부 수분량은 사용 전 대비 21.4% 증가했고, 사용 4주 후 피부 수분량은 사용 전 대비 33.7% 증가했으며, "
    + "같은 시험에서 사용 4주 후 피부 장벽 지표는 사용 전 대비 18.2% 개선된 것으로 최종 확인되어 나타났다";

  it("평서체로 끝나는 정상 장문 근거문을 블롭으로 오판하지 않는다", () => {
    expect(plainDeclarativeStudySentence.length).toBeGreaterThan(220);
    expect(isCitationReadyProse(plainDeclarativeStudySentence)).toBe(true);
  });

  it("평서체의 여러 활용형을 모두 종결로 인식한다", () => {
    const stem = plainDeclarativeStudySentence.replace(/나타났다$/u, "");
    const plainDeclarativeEndings = [
      // 과거(ㅆ)·현재(ㄴ다/는다)
      "나타났다", "확인했다", "증가한다", "개선된다", "먹는다",
      // 허벌 어간 형용사
      "수치가 높다", "이견이 없다",
      // 하-, 계사 이-
      "유의미하다", "개선 결과이다",
      // 모음 어간(르/으 불규칙)
      "두 값이 다르다", "차이가 크다", "회복이 빠르다", "쓰임이 다르다", "변화가 예쁘다",
      // -아/어지다 (스킨케어 카피에 흔한 형태)
      "피부가 부드러워지다", "피부가 촉촉해지다", "피부톤이 밝아지다"
    ];
    for (const ending of plainDeclarativeEndings) {
      expect(isCitationReadyProse(`${stem}${ending}`)).toBe(true);
    }
  });

  /**
   * 종결 판정 하나로는 `베이킹 소다`(명사)와 `크다`(형용사)를 가를 수 없다 —
   * 둘 다 [모음 종결 음절] + 다이고, 이를 형태론으로 분리하려던 시도가 두 번
   * 연속으로 정상 산문을 죽였다. 그래서 아래처럼 나눈다:
   *   - 조사(마다/보다)는 명사에 붙는 폐쇄 문법류라 형태론으로 떨어진다.
   *   - 명사 종결(소다)과 계사(결과다)는 **알면서 통과시킨다**. 특히 `결과다`는
   *     실제로 계사 문장이라 거절하는 편이 틀렸다.
   *   - 그 대가는 네 번째 조건(수치가 서술되지 않는다)이 치른다.
   */
  const denseRunWithoutBadgeStrip = UNSEGMENTED_BLOB
    .replace("+63.6% +84.3% +84.3% ", "")
    .replace(/\*in vitro 시험 결과$/u, "");

  it("명사에 붙는 조사로 끝나면 종결로 보지 않는다", () => {
    for (const tail of ["피부 타입마다", "사용 전보다"]) {
      expect(isCitationReadyProse(`${denseRunWithoutBadgeStrip}${tail}`)).toBe(false);
    }
  });

  it("명사 종결과 계사는 알면서 통과시킨다 (종결 판정만으로는 가를 수 없다)", () => {
    for (const tail of ["베이킹 소다", "시험 결과다"]) {
      expect(isCitationReadyProse(`${denseRunWithoutBadgeStrip}${tail}`)).toBe(true);
    }
  });

  it("서술되지 않은 수치 나열이 있으면 어미와 무관하게 블롭이다", () => {
    // 실측 블록에는 `+63.6% +84.3% +84.3%` 배지 런이 있다. 꼬리를 무엇으로
    // 바꾸든 — 위에서 통과시킨 명사 종결·계사를 포함해 — 이 조건이 잡는다.
    const blobStem = UNSEGMENTED_BLOB.replace(/\*in vitro 시험 결과$/u, "");
    expect(isCitationReadyProse(UNSEGMENTED_BLOB)).toBe(false);
    for (const tail of ["피부 타입마다", "사용 전보다", "베이킹 소다", "시험 결과다", "확인되었다"]) {
      expect(isCitationReadyProse(`${blobStem}${tail}`)).toBe(false);
    }
  });

  it("정상 근거 문장에는 서술되지 않은 수치 나열이 없다", () => {
    expect(isCitationReadyProse(plainDeclarativeStudySentence)).toBe(true);
  });
});

describe("압축 패널의 각주는 그것이 설명하는 수치에 붙는다", () => {
  /**
   * 추출기는 같은 측정을 두 번 준다 — 각주까지 담은 미분절 패널과, 각주가
   * 떨어져 나간 정제 문장. 정합성 게이트를 통과하는 것은 정제 문장뿐이라
   * 시험 조건이 패널과 함께 버려졌고, 수치가 표본 없이 발행됐다
   * (Evidence Routing Contract 위반, 실측 1145에서 E-E-A-T 감점의 유일한 원인).
   *
   * 각주와 수치의 대응은 배치 순서로 읽는다. 패널에 두 개의 시험이 들어 있어도
   * 각 각주는 자기 위에 인쇄된 수치만 설명한다.
   */
  const scopedPanel = [
    "색조 메이크업 97.1% 세정 사용 전 사용 후 모공 속 노폐물 97.6% 세정 사용 전 사용 후",
    "만 20~39세의 성인 여성 30명 대상 / 시험기간 2025.07.21~2025.08.22 / 개인차 있음",
    "(피부 각질층 내 세라마이드 함량 분석) +63.6% 증가 +84.3% 증가 사용 2주 후 사용 4주 후",
    "*in vitro 시험 결과"
  ].join(" ");

  it("정제 문장에 자기 패널의 표본·기간·단서를 되살린다", () => {
    const facts = sanitizePdpSemanticFacts({
      metricClaims: [
        { sentence: scopedPanel, sourceText: scopedPanel },
        { sentence: REFINED_METRIC_SENTENCE, sourceText: REFINED_METRIC_SENTENCE }
      ]
    } as never);

    expect(facts.metricClaims).toHaveLength(1);
    expect(facts.metricClaims[0]?.sample).toContain("30명");
    expect(facts.metricClaims[0]?.period).toContain("2025.07.21");
    expect(facts.metricClaims[0]?.caveat).toContain("개인차");
  });

  it("각주 뒤에 인쇄된 다른 시험의 수치에는 그 표본을 붙이지 않는다", () => {
    const ceramideClaim = "각질층 내 세라마이드 함량은 사용 4주 후 84.3% 증가했습니다.";
    const facts = sanitizePdpSemanticFacts({
      metricClaims: [
        { sentence: scopedPanel, sourceText: scopedPanel },
        { sentence: ceramideClaim, sourceText: ceramideClaim }
      ]
    } as never);

    const carried = facts.metricClaims.find((claim) => claim.sentence === ceramideClaim);
    expect(carried).toBeDefined();
    expect(carried?.sample).toBeUndefined();
  });

  it("추출기가 이미 채운 표본은 덮어쓰지 않는다", () => {
    const facts = sanitizePdpSemanticFacts({
      metricClaims: [
        { sentence: scopedPanel, sourceText: scopedPanel },
        { sentence: REFINED_METRIC_SENTENCE, sourceText: REFINED_METRIC_SENTENCE, sample: "여성 52명 대상", period: "시험기간 2026.01.02~2026.02.02" }
      ]
    } as never);

    const claim = facts.metricClaims.find((item) => item.sentence === REFINED_METRIC_SENTENCE);
    expect(claim?.sample).toBe("여성 52명 대상");
    expect(claim?.period).toBe("시험기간 2026.01.02~2026.02.02");
  });
});

describe("FAQ 단서는 근거 없는 시험을 주장하지 않는다", () => {
  async function faqAnswers(product: PdpProductSignal): Promise<string> {
    const run = await generatePdpGeo({ product, hints: { locale: "ko-KR" } });
    const faq = (run.result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>)
      .find((node) => node["@type"] === "FAQPage");
    return ((faq?.mainEntity ?? []) as Array<Record<string, any>>)
      .map((item) => String(item.acceptedAnswer?.text ?? ""))
      .join("\n");
  }

  it("정제 문장뿐인 상품의 FAQ는 시험을 언급하는 단서를 쓰지 않는다", async () => {
    // 이 어서션은 원래 `answers`에 97.1%가 있다는 전제로 단서를 검사했는데, 그
    // 전제 자체가 누수였다 — 지표 문장의 주인은 Product.description 하나이고,
    // FAQ가 같은 측정을 다른 말로 되풀이하던 것이 통과 조건이었다. 검사 대상은
    // 단서이므로 단서로 직접 확인하고, 사실이 유실되지 않았음은 수치를 싣는
    // 필드에서 확인한다.
    const product = cleansingFoamProduct();
    const answers = await faqAnswers(product);
    const description = String((await productNode(product)).description ?? "");

    expect(answers).not.toContain("시험 결과를 포함한");
    expect(description).toContain("97.1%");
  });

  it("구조화 지표에는 시험을 언급하는 단서를 그대로 쓴다", async () => {
    const answers = await faqAnswers(structuredStudyProduct());

    expect(answers).toContain("인체적용시험");
    expect(answers).toContain("시험 결과를 포함한");
  });
});

describe("정제 문장의 어체가 공개 카피와 어긋나면 싣지 않는다", () => {
  const plainStyleRefinement = "색조 메이크업 세정력은 97.1%, 모공 속 노폐물 세정력은 97.6%로 나타났다.";

  it("해라체 정제 문장은 선별하지 않는다", () => {
    expect(isKoreanRefinedMetricStatement(plainStyleRefinement)).toBe(false);
    // 같은 사실의 합니다체 표현은 그대로 선별된다.
    expect(isKoreanRefinedMetricStatement(REFINED_METRIC_SENTENCE)).toBe(true);
  });

  it("해라체 문장뿐이면 수치를 공개하지 않는다", async () => {
    const base = cleansingFoamProduct();
    const product = {
      ...base,
      semanticFacts: {
        ...(base.semanticFacts as any),
        metricClaims: [{ sentence: plainStyleRefinement, sourceText: plainStyleRefinement }],
        evidenceSentences: [UNSEGMENTED_BLOB, plainStyleRefinement]
      }
    } as unknown as PdpProductSignal;
    const description = String((await productNode(product)).description ?? "");

    expect(description).not.toContain("97.1");
    expect(description).not.toContain("나타났다");
  });
});

describe("1027(크림 미스트) 회귀 — 정제 지표 문장이 없는 상품", () => {
  it("없는 수치를 지어내지 않고, 배너의 94/93%도 공개 카피로 올리지 않는다", async () => {
    const node = await productNode(creamMistProduct());
    const published = `${String(node.description ?? "")}\n`
      + ((node.additionalProperty ?? []) as Array<Record<string, string>>)
        .map((entry) => `[${entry.name}] ${entry.value}`).join("\n");

    expect(published).not.toContain("94%");
    expect(published).not.toContain("93%");
    expect(published).not.toContain("GLOWPICK");
    // 단서만 떠 있는 상태도 만들지 않는다.
    expect(published).not.toMatch(/개인에\s*따라\s*결과가\s*다를\s*수\s*있습니다/u);
  });

  it("정상 문장은 계속 살아 있다", async () => {
    const node = await productNode(creamMistProduct());

    expect(String(node.description ?? "")).toContain("세라마이드");
  });
});
