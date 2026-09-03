import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPlanningPrompt } from "../src/prompts/content-planning";
import { exampleluxeNormalizedProduct } from "./fixtures/exampleluxe-normalized-product";
import { planningRequest } from "./support/planning";
import type { PdpProductSignal } from "../src/types";

/**
 * Task 7b/7d — 고객 질문 정합과 arc의 질문 연쇄.
 *
 * 이 규칙들은 결정적 게이트로 강제하지 않는다. 계획서 7e의 판단이며 근거가
 * 있다 — 질문 형태를 기계로 판정하면 정상 문장을 죽인다. 대신 계약서(정본)와
 * 그것을 비추는 플래닝 프롬프트가 규칙을 실제로 담고 있는지를 고정한다.
 * 배선 테스트이므로 산출물의 문구를 검사하지 않는다. 규칙에 예시 문구를 넣지
 * 않은 것도 의도다(Task 5에서 모델이 예시를 그대로 복사하는 것이 확인됐다).
 */

const product = exampleluxeNormalizedProduct as unknown as PdpProductSignal;
const contractDocument = readFileSync(
  join(__dirname, "..", "src", "rag", "content-field-contracts_v1.md"),
  "utf8"
);
const plannerSystemPrompt = createPlanningPrompt(planningRequest(product, "ko-KR"), 10, 5).system;

/** 각 규칙을 알아볼 수 있는 최소 표지. 문구 전체가 아니라 규정의 골자다. */
const rules: Array<{ name: string; contract: RegExp; prompt: RegExp }> = [
  {
    name: "arc는 앞 문장이 낳은 질문에 답하는 연쇄다",
    contract: /answers the question the sentence before it raises/i,
    prompt: /answer to the question the one before it raises/i
  },
  {
    name: "고민의 메커니즘이 원문에 있으면 증상 대신 그것으로 연다",
    contract: /why the concern arises.*stated mechanism/is,
    prompt: /why the concern arises.*mechanism instead of the symptom/is
  },
  {
    name: "원문이 그은 대조만 싣고, 경쟁 제품을 평하지 않는다",
    contract: /contrasts this product's form with the ordinary form.*never characterize a competing product/is,
    prompt: /contrasts this product's form with the ordinary form.*never characterize a competing product/is
  },
  {
    name: "가격은 WebPage.description 산문에 명시한다",
    contract: /purchasable option and its price, name both in the `WebPage\.description` prose/i,
    prompt: /option and its price must be named there in prose/i
  },
  {
    name: "질문은 고객이 쓰는 말로, 스펙 시트 어휘로 쓰지 않는다",
    contract: /words a buyer would use to ask it/i,
    prompt: /words a buyer would use/i
  },
  {
    name: "답변 첫 문장은 그 자체로 완결된 답이다",
    contract: /opening sentence of an answer must be a complete answer/i,
    prompt: /opening sentence of every answer a complete answer that stands alone/i
  },
  {
    name: "구체적인 것이 인용된다",
    contract: /Prefer the specific over the general/i,
    prompt: /Prefer the specific over the general/i
  }
];

describe("Task 7b/7d 규칙은 계약서와 플래닝 프롬프트 양쪽에 있다", () => {
  for (const rule of rules) {
    it(`계약서가 규정한다: ${rule.name}`, () => {
      expect(contractDocument).toMatch(rule.contract);
    });

    it(`프롬프트가 비춘다: ${rule.name}`, () => {
      expect(plannerSystemPrompt).toMatch(rule.prompt);
    });
  }

  it("규칙에 따라 쓸 예시 문구를 주지 않는다", () => {
    // Task 5에서 확인: 예시를 주면 모델이 문구를 복사한다. 새 규칙 어디에도
    // 따옴표로 감싼 한국어 예문이 없어야 한다.
    const newRuleBlock = contractDocument
      .split("\n")
      .filter((line) => rules.some((rule) => rule.contract.test(line)))
      .join("\n");

    expect(newRuleBlock).not.toMatch(/[`'"][^`'"]*[가-힣][^`'"]*[`'"]/u);
  });
});
