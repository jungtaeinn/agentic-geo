import { describe, expect, it } from "vitest";
import { assembleImageOcrEvidence } from "../src/agent";
import { metricClaimsFromOcrLayout } from "../src/ocr-layout-metrics";
import type { OcrExtraction } from "../src/types";
import { chartProbeGroups, clinicalPanelProbeGroups } from "./fixtures/ocr-layout-probe";

const PRODUCT = "예시더마 모이베리어365 클렌징폼";

/**
 * 차트의 수치는 값 하나로는 아무 것도 말하지 않는다. 무엇을 재었는지(차트
 * 제목), 언제인지(눈금), 무엇과 견주었는지(계열), 어떤 시험인지(각주)가 함께
 * 있어야 인용할 수 있는 주장이 된다. 그 네 가지는 레이아웃만 알고 있다.
 *
 * `GeoSemanticMetricClaim`에는 그 슬롯이 이미 있고 생성기가 이미 소비한다.
 * 여기서 하는 일은 비어 있던 슬롯을 채우는 것뿐이다.
 */
describe("metricClaimsFromOcrLayout", () => {
  it("carries the chart title, timepoint, series, and footnote into the claim", () => {
    const claims = metricClaimsFromOcrLayout(chartProbeGroups, PRODUCT);

    expect(claims).toEqual([
      {
        value: "+63.6",
        unit: "%",
        metric: "피부 각질층 내 세라마이드 함량 분석",
        timing: "사용 후",
        subject: "예시더마 클렌징폼",
        comparator: "자사 일반제품",
        caveat: "※In vitro 시험 결과"
      },
      {
        value: "+84.3",
        unit: "%",
        metric: "피부 각질층 내 세라마이드 함량 분석",
        timing: "사용 2주 후",
        subject: "예시더마 클렌징폼",
        comparator: "자사 일반제품",
        caveat: "※In vitro 시험 결과"
      }
    ]);
  });

  it("does not publish a value the layout did not pair with a label", () => {
    expect(metricClaimsFromOcrLayout([{
      id: "g1",
      title: "피부 각질층 내 세라마이드 함량 분석",
      lines: [{ text: "+63.6%", role: "value" }]
    }], PRODUCT)).toEqual([]);
  });

  it("does not publish a value whose group states no measured outcome", () => {
    expect(metricClaimsFromOcrLayout([{
      id: "g1",
      lines: [{ text: "+63.6%", role: "value", pairedLabel: "사용 후" }]
    }], PRODUCT)).toEqual([]);
  });

  it("leaves the series out when the chart names more than two", () => {
    // 계열이 셋이면 이 값이 누구의 값인지 레이아웃만으로 정해지지 않는다.
    expect(metricClaimsFromOcrLayout([{
      id: "g1",
      title: "함량 분석",
      lines: [
        { text: "+63.6%", role: "value", pairedLabel: "사용 후" },
        { text: "자사 A", role: "label" },
        { text: "자사 B", role: "label" },
        { text: "예시더마 클렌징폼", role: "label" }
      ]
    }], PRODUCT)).toEqual([]);
  });

  it("splits an unmistakable sample and period out of the footnote", () => {
    const claims = metricClaimsFromOcrLayout([
      {
        id: "g1",
        title: "색조 메이크업 세정력",
        lines: [{ text: "97.1%", role: "value", pairedLabel: "색조 메이크업" }]
      },
      {
        id: "g2",
        annotates: "g1",
        lines: [{
          text: "만 20~39세의 성인 여성 30명 대상 / 시험기간 2025.07.21-2025.08.22 / 개인차 있음",
          role: "footnote"
        }]
      }
    ], PRODUCT);

    expect(claims).toHaveLength(1);
    expect(claims[0]?.sample).toBe("만 20~39세의 성인 여성 30명 대상");
    expect(claims[0]?.period).toBe("시험기간 2025.07.21-2025.08.22");
    expect(claims[0]?.caveat).toBe("개인차 있음");
  });

  it("leaves a value embedded in prose to the existing sentence path", () => {
    // 패널의 주장("색조 메이크업 97.1% 세정")은 이미 완결된 문장이고, 기존
    // 수치 인사이트 경로가 그 문장을 그대로 발행한다. 여기서 다시 값을 뜯어내면
    // 같은 수치를 두 벌로 만들고, 수치 추출 구현도 두 벌이 된다.
    expect(metricClaimsFromOcrLayout(clinicalPanelProbeGroups, PRODUCT)).toEqual([]);
  });

  it("splits a value's unit off the number", () => {
    const claims = metricClaimsFromOcrLayout([{
      id: "g1",
      title: "보습력 개선",
      lines: [{ text: "105%", role: "value", pairedLabel: "사용 4주 후" }]
    }], PRODUCT);

    expect(claims[0]?.value).toBe("105");
    expect(claims[0]?.unit).toBe("%");
  });

  it("reads a footnote attached to the parent chart group", () => {
    const claims = metricClaimsFromOcrLayout([
      { id: "g1", title: "함량 분석", lines: [] },
      { id: "g2", parentId: "g1", lines: [{ text: "+84.3%", role: "value", pairedLabel: "사용 4주 후" }] },
      { id: "g3", annotates: "g1", lines: [{ text: "※In vitro 시험 결과", role: "footnote" }] }
    ], PRODUCT);

    expect(claims[0]?.caveat).toBe("※In vitro 시험 결과");
    expect(claims[0]?.metric).toBe("함량 분석");
  });
});

/**
 * 조립 경로(agent-api가 쓰는 `extractImageOcrEvidence`가 지나는 곳)에서
 * 레이아웃 수치 주장이 나오는지 본다. 관계가 그 경로까지 이어지지 않으면
 * agent-api로 들어온 이미지에서는 차트 수치가 계속 사라진다.
 */
describe("assembleImageOcrEvidence — layout metric claims", () => {
  const IMAGE = "https://cdn.example.com/upload/product/1145_1056.png";
  const TEXT = [
    "피부 각질층 내 세라마이드 함량 분석",
    "+63.6%",
    "+84.3%",
    "자사 일반제품",
    "예시더마 클렌징폼",
    "사용 후",
    "사용 2주 후",
    "※In vitro 시험 결과"
  ].join("\n");

  it("publishes the chart value with its timepoint, series, and test note", () => {
    const ocr: OcrExtraction = {
      imagesScanned: 1,
      extractedTexts: [{
        imageUrl: IMAGE,
        imageUrls: [IMAGE],
        text: TEXT,
        confidence: 0.98,
        keywords: [],
        sentenceInsights: [],
        groups: chartProbeGroups
      }]
    };

    const assembled = assembleImageOcrEvidence(ocr, undefined, [], PRODUCT);
    const claims = assembled.ocr.semanticFacts?.metricClaims ?? [];

    expect(claims).toEqual(expect.arrayContaining([
      expect.objectContaining({
        value: "+84.3",
        unit: "%",
        timing: "사용 2주 후",
        subject: "예시더마 클렌징폼",
        comparator: "자사 일반제품",
        metric: "피부 각질층 내 세라마이드 함량 분석",
        caveat: "※In vitro 시험 결과"
      })
    ]));
  });

  it("drops the claim when the transcription does not back the chart structure", () => {
    const ocr: OcrExtraction = {
      imagesScanned: 1,
      extractedTexts: [{
        imageUrl: IMAGE,
        imageUrls: [IMAGE],
        text: "전혀 다른 전사입니다",
        confidence: 0.98,
        keywords: [],
        sentenceInsights: [],
        groups: chartProbeGroups
      }]
    };

    const assembled = assembleImageOcrEvidence(ocr, undefined, [], PRODUCT);

    expect(assembled.ocr.semanticFacts?.metricClaims ?? []).toEqual([]);
  });
});

/**
 * 미국 대상 페이지의 각주도 같은 조건을 담는다 — 몇 명을 대상으로, 얼마 동안,
 * 어떤 시험인지. 한글 단위만 읽으면 그 조건이 통째로 caveat에 뭉쳐, 인용문이
 * 시험 규모와 기간을 잃는다.
 */
describe("metricClaimsFromOcrLayout — 영문 각주", () => {
  it("splits an English sample and period out of the footnote", () => {
    const claims = metricClaimsFromOcrLayout([
      {
        id: "g1",
        title: "Ceramide content in the stratum corneum",
        lines: [{ text: "+84.3%", role: "value", pairedLabel: "After 2 weeks" }]
      },
      {
        id: "g2",
        annotates: "g1",
        lines: [{
          text: "30 women aged 20 to 39 / for 4 weeks / individual results may vary",
          role: "footnote"
        }]
      }
    ], "EXAMPLEDERMA BarrierCare365 Cleansing Foam");

    expect(claims[0]?.sample).toBe("30 women aged 20 to 39");
    expect(claims[0]?.period).toBe("for 4 weeks");
    expect(claims[0]?.caveat).toBe("individual results may vary");
  });

  it("attributes an English chart series to the product and its comparator", () => {
    const claims = metricClaimsFromOcrLayout([
      {
        id: "g1",
        title: "Ceramide content in the stratum corneum",
        lines: [
          { text: "+84.3%", role: "value", pairedLabel: "After 2 weeks" },
          { text: "Our alkaline foam", role: "label" },
          { text: "EXAMPLEDERMA cleansing foam", role: "label" }
        ]
      }
    ], "EXAMPLEDERMA BarrierCare365 Cleansing Foam");

    expect(claims[0]?.subject).toBe("EXAMPLEDERMA cleansing foam");
    expect(claims[0]?.comparator).toBe("Our alkaline foam");
  });
});

/**
 * 계열 귀속은 상품명의 **구별되는** 부분으로 판정해야 한다.
 *
 * 낱말 겹침만 보면 비교군 라벨이 카테고리 낱말을 공유하는 순간 상품으로
 * 귀속되고, 차트에서 먼저 인쇄되면 실제 상품 계열이 `comparator`로 밀린다 —
 * 수치가 반대 주체로 발행된다.
 */
describe("계열 귀속", () => {
  it("does not attribute a comparator series that only shares the category word", () => {
    const claims = metricClaimsFromOcrLayout([
      {
        id: "g1",
        title: "세정력 비교",
        lines: [
          { text: "세정력 비교", role: "title" as const },
          { text: "자사 일반 클렌징폼", role: "label" as const },
          { text: "예시더마 모이베리어365", role: "label" as const },
          { text: "97.9", role: "value" as const, pairedLabel: "세정 직후" }
        ]
      }
    ], "예시더마 모이베리어365 클렌징폼");

    expect(claims).toHaveLength(1);
    expect(claims[0]?.subject).toBe("예시더마 모이베리어365");
    expect(claims[0]?.comparator).toBe("자사 일반 클렌징폼");
  });
});

/**
 * 각주는 구분자가 있을 때만 슬롯으로 갈라졌다. 같은 내용이 `/`가 있느냐 없느냐로
 * 다르게 분류되면, 인용 문구가 시험 규모와 기간을 잃는다.
 */
describe("각주 슬롯", () => {
  function claimsWithFootnote(footnote: string) {
    return metricClaimsFromOcrLayout([
      {
        id: "g1",
        title: "각질층 수분",
        lines: [
          { text: "각질층 수분", role: "title" as const },
          { text: "97.6", role: "value" as const, pairedLabel: "4주 후" }
        ]
      },
      { id: "g2", annotates: "g1", lines: [{ text: footnote, role: "footnote" as const }] }
    ], "예시더마 모이베리어365 크림");
  }

  it("reads the sample and period from a footnote written as one segment", () => {
    const claim = claimsWithFootnote("성인 여성 30명 대상 4주 사용 시험")[0];

    expect(claim?.sample).toContain("30명");
    expect(claim?.period).toContain("4주");
  });

  it("does not split a slash-written date into fragments", () => {
    const claim = claimsWithFootnote("성인 여성 30명 / 시험기간 2025/07/21-2025/08/22")[0];

    expect(claim?.period).toContain("2025/07/21");
  });
});
