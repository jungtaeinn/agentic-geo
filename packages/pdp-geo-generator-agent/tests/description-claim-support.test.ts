import { describe, expect, it } from "vitest";
import { createPdpGeoEvidenceLedger, ModelBackedContentPlanner, planPdpGeoContent } from "../src/index";
import type { PdpGeoContentPlan, PdpProductSignal } from "../src/types";

/**
 * The ordered description contract asks one paragraph to state product
 * identity, target customer, composition, completed tests and attributed
 * review wording in sequence. These cases pin which of those sentences the
 * evidence gate keeps: a sentence whose every part is backed by the ledger
 * must survive, and a sentence asserting something the ledger never states
 * must still be dropped.
 */
const product = {
  name: "모이베리어 365 크림 미스트",
  originalName: "모이베리어 365 크림 미스트",
  description: "10,000ppm 함유된 고함량 세라마이드 미세분사로 피부장벽을 보호하는",
  brand: "EXAMPLEDERMA",
  images: [],
  options: ["120 mL / 4.05 fl. oz."],
  benefits: ["수분 충전과 동시에 보습막을 형성", "흔들 필요 없이 사용할 수 있는 특수 에멀젼 공법", "피부 장벽 보습 및 강화"],
  effects: ["피부 표면에 보습막을 형성"],
  ingredients: ["세라마이드 10,000ppm", "특수 에멀젼 공법"],
  usage: ["연약하고 건조해진 피부 부위에 미세 분사합니다.", "피부에 건조함이 느껴질 때 수시로 뿌려줍니다."],
  metrics: [],
  faq: [],
  breadcrumbs: [],
  sourceTexts: [
    "세라마이드는 피부 장벽을 강화하고 피부 내 수분을 유지하는 데 도움을 주는 피부 장벽 성분으로 소개됩니다.",
    "제품은 수분 충전과 동시에 보습막을 형성하는 효능을 내세우며, 건조 피부 및 모든 피부에 추천됩니다.",
    "철저히 검증한 피부 안전성 테스트 DERMATOLOGIST TESTED 피부과 테스트 일반인 피부에서 48시간 패치를 활용한 자극여부 확인 22.12.19-22.12.22, 32명 대상 ALLERGY TESTED 하이포알러제닉 테스트 완료 여러번 피부에 첨포하여 일어나는 화장품, 성분에 대한 과민 반응 (감작성)을 확인 2018.04.13-2018.06.01, 53명 대상, ㈜더마프로"
  ],
  reviews: {
    rating: 4.9,
    reviewCount: 1580,
    keywords: ["촉촉", "만족", "재구매", "가벼운", "산뜻"],
    items: [
      { body: "산뜻해요ㅡ가볍게 뿌리기좋고ㅡ자극없어서 더좋음" },
      { body: "건조할 때마다 칙칙 뿌려주는데, 진짜 미세하게 안개 분사돼서 메이크업 위에 뿌려도 뭉치거나 밀림이 전혀 없더라고요." }
    ]
  },
  semanticFacts: {
    ingredients: ["세라마이드 10,000ppm", "세라마이드"],
    benefits: ["수분 충전과 동시에 보습막을 형성", "피부 장벽 보습 및 강화"],
    effects: ["피부 표면에 보습막을 형성"],
    skinTypes: ["건조 피부"],
    usageSteps: ["연약하고 건조해진 피부 부위에 미세 분사합니다.", "피부에 건조함이 느껴질 때 수시로 뿌려줍니다."],
    safetyTests: ["피부과 테스트 (DERMATOLOGIST TESTED)"],
    metricClaims: [],
    evidenceSentences: [
      "세라마이드는 피부 장벽을 강화하고 피부 내 수분을 유지하는 데 도움을 주는 피부 장벽 성분으로 소개됩니다.",
      "DERMATOLOGIST TESTED 피부과 테스트 일반인 피부에서 48시간 패치를 활용한 자극여부 확인 22.12.19-22.12.22, 32명 대상",
      "ALLERGY TESTED 하이포알러제닉 테스트 완료 여러번 피부에 첨포하여 일어나는 화장품, 성분에 대한 과민 반응(감작성)을 확인 2018.04.13-2018.06.01, 53명 대상, ㈜더마프로"
    ],
    ingredientBenefitLinks: [{
      ingredient: "세라마이드",
      benefit: "피부 장벽 강화",
      sentence: "세라마이드는 피부 장벽을 강화하고 피부 내 수분을 유지하는 데 도움을 주는 피부 장벽 성분으로 소개됩니다.",
      sourceText: "세라마이드는 피부 장벽을 강화하고 피부 내 수분을 유지하는 데 도움을 주는 피부 장벽 성분으로 소개됩니다."
    }],
    citations: []
  }
} as unknown as PdpProductSignal;

const identitySentence = "EXAMPLEDERMA 모이베리어 365 크림 미스트는 건조 피부를 위한 크림 미스트로, 수분 충전과 동시에 피부 표면에 보습막을 형성합니다.";
const compositionSentence = "세라마이드를 함유하며, 세라마이드는 피부 장벽을 강화하고 피부 내 수분을 유지하는 데 도움을 주는 피부 장벽 성분으로 소개됩니다.";
const formulaSentence = "작게 쪼개진 세라마이드와 수분을 묶은 특수 에멀젼 공법을 적용해 흔들지 않고 사용할 수 있다고 안내합니다.";
const evidenceSentence = "피부과 테스트와 하이포알러제닉 테스트를 완료했으며, 고객들은 촉촉함, 산뜻함, 가벼운 사용감, 만족감을 언급합니다.";

async function planDescription(text: string): Promise<{ text: string; warnings: string[] }> {
  const evidenceLedger = createPdpGeoEvidenceLedger(product, "ko-KR");
  // The audited corrective pass is what the deployed model planner reaches, so
  // the gate is exercised through a ModelBackedContentPlanner subclass.
  const planner = new (class extends ModelBackedContentPlanner {
    override async planContent() {
      return {
        plan: {
          locale: "ko-KR",
          productDescription: {
            include: true,
            text,
            intent: "product-entity-summary",
            evidenceIds: evidenceLedger.map((item) => item.id),
            confidence: 0.9,
            omitReason: ""
          },
          webPageDescription: { include: false, text: "", intent: "", evidenceIds: [], confidence: 0, omitReason: "" },
          faq: [],
          howTo: { eligible: false, ordered: false, goal: "", steps: [], evidenceIds: [], confidence: 0, omitReason: "" },
          cep: [],
          warnings: []
        } as Omit<PdpGeoContentPlan, "mode">
      };
    }
  })({ provider: "custom" } as never);

  const result = await planPdpGeoContent(
    { product, locale: "ko-KR", evidenceLedger, ragChunks: [] },
    { customContentPlanner: planner }
  );
  return { text: result.plan.productDescription.text, warnings: result.plan.warnings };
}

describe("description claim support", () => {
  it("keeps every sentence of an ordered description whose parts the ledger backs", async () => {
    const { text } = await planDescription(
      [identitySentence, compositionSentence, formulaSentence, evidenceSentence].join(" ")
    );

    // Identity + audience + benefit in one sentence: the category noun is
    // established by the product's own name, the audience by skinTypes, the
    // benefit and effect by their own atoms.
    expect(text).toContain(identitySentence);
    expect(text).toContain(compositionSentence);
    expect(text).toContain(formulaSentence);
    // Completed tests plus attributed review terms; the review keywords are
    // stems (촉촉, 산뜻, 만족) of the inflected forms the sentence uses.
    expect(text).toContain(evidenceSentence);
  });

  it("still drops a sentence asserting an outcome the ledger never states", async () => {
    const invented = "임상시험에서 4주 사용 후 주름이 32% 개선되었습니다.";
    const { text, warnings } = await planDescription([compositionSentence, invented].join(" "));

    expect(text).not.toContain("주름");
    expect(text).toContain(compositionSentence);
    expect(warnings.join(" ")).toMatch(/removed unsupported claim unit|did not pass the evidence gate/u);
  });

  it("keeps the supported sentences when most of the paragraph is unsupported", async () => {
    // Dropping the unsupported majority used to drop the field with it, and the
    // renderer then republished the source description verbatim — one marketing
    // line, source typo included. A pruned paragraph the ledger backs is the
    // better publication, so the audit prunes and the surviving sentences stand
    // on the same per-unit judgement every retained sentence already passes.
    const invented = "임상시험에서 4주 사용 후 주름이 32% 개선되었습니다.";
    const guarantee = "피부과 전문의가 모든 피부 타입에 자극이 전혀 없다고 보증했습니다.";
    const { text, warnings } = await planDescription([compositionSentence, invented, guarantee].join(" "));

    expect(text).toContain(compositionSentence);
    expect(text).not.toContain("주름");
    expect(text).not.toContain("보증");
    expect(warnings.join(" ")).toContain("removed unsupported claim unit");
  });

  it("still drops a sentence that turns review wording into a product guarantee", async () => {
    const overclaim = "모든 피부 타입에서 자극이 전혀 없는 것으로 확인되었습니다.";
    const { text } = await planDescription([compositionSentence, overclaim].join(" "));

    expect(text).not.toContain("자극이 전혀 없");
  });
});
