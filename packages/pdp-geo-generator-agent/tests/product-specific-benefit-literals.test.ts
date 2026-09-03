import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { generatePdpGeo } from "../src";

/**
 * Task 8 — 클렌저 한 상품의 마케팅 라벨이 코드에 다섯 곳 박혀 있었다.
 *
 * 표는 느슨한 트리거를 좁은 라벨로 바꾸며 뜻을 덧붙였다(`자극` → `저자극 세안`,
 * `거품` → `마이크로 버블`). 그렇게 만들어진 라벨이 클렌저가 아닌 상품에 흘러
 * 들어가자, 두 개의 가드가 "이 라벨 목록에 걸리는데 상품 타입이 클렌저가
 * 아니면 버린다"로 사후 처리했다. 조작을 그 자리에서 없애고 가드를 지웠다.
 *
 * 가드 제거는 반대 방향으로도 옳다 — 상품 타입 열거는 메이크업을 지우는 클렌징
 * 밤의 정당한 `세정력`을 버렸을 것이다.
 */

describe("정본 라벨 표는 원문에 없는 뜻을 덧붙이지 않는다", () => {
  it("크림의 `자극`이 `저자극 세안`이 되지 않는다", async () => {
    const run = await generatePdpGeo({
      product: {
        name: "데일리 배리어 크림",
        description: "건조하고 민감한 피부의 장벽 보습을 위한 크림입니다.",
        category: "크림",
        benefits: ["자극 완화", "피부 장벽"],
        effects: ["보습"],
        ingredients: ["세라마이드"],
        usage: ["세안 후 적당량을 피부에 골고루 펴 바릅니다."],
        reviews: { keywords: ["촉촉한 사용감"], items: [] }
      } as never,
      hints: { locale: "ko-KR" }
    });

    const published = JSON.stringify(run.result.schemaMarkup.jsonLd) + JSON.stringify(run.result.content.sections);
    expect(published).not.toContain("저자극 세안");
    expect(published).not.toContain("세정력");
    expect(published).not.toContain("마이크로 버블");
  });

  it("클렌저는 원문이 쓴 표기를 그대로 싣는다", async () => {
    const run = await generatePdpGeo({
      product: {
        name: "예시더마 모이베리어365 클렌징폼",
        brand: "EXAMPLEDERMA",
        description: "약산성 아미노산 유래 세정 성분을 담은 클렌징 폼입니다.",
        category: "클렌저",
        benefits: ["색조 메이크업 세정력", "모공 속 노폐물 세정력"],
        effects: ["피부 장벽"],
        ingredients: ["보타온", "판테놀"],
        skinTypes: ["건조 피부", "민감 피부"],
        reviews: { keywords: ["촉촉한 사용감"], items: [] }
      } as never,
      hints: { locale: "ko-KR" }
    });

    const published = JSON.stringify(run.result.schemaMarkup.jsonLd);
    // 원문 표기가 살아 있어야 AI 답변이 그 문장을 이 상품에 귀속시킬 수 있다.
    expect(published).toMatch(/색조 메이크업 세정력|모공 속 노폐물 세정력/u);
  });

  it("클렌징 밤 크림의 세정 효능을 상품 타입만으로 버리지 않는다", async () => {
    const run = await generatePdpGeo({
      product: {
        name: "멜팅 클렌징 밤",
        description: "메이크업을 부드럽게 녹여내는 밤 타입 제품입니다.",
        category: "크림",
        benefits: ["메이크업 세정력", "보습"],
        ingredients: ["세라마이드"],
        reviews: { keywords: ["부드러운 사용감"], items: [] }
      } as never,
      hints: { locale: "ko-KR" }
    });

    expect(JSON.stringify(run.result.schemaMarkup.jsonLd)).toContain("메이크업 세정력");
  });
});

describe("클렌저 마케팅 라벨은 코드에 남지 않았다", () => {
  it("생성기 실행 코드에 상품 고유 라벨이 없다", () => {
    const sourceDir = join(__dirname, "..", "src");
    const readSources = (dir: string): Array<{ path: string; text: string }> =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return readSources(path);
        const isHandWritten = entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".generated.ts");
        return isHandWritten ? [{ path, text: readFileSync(path, "utf8") }] : [];
      });

    const productLabels = ["저자극 세안", "저자극\\s*세안", "초미세먼지", "마이크로 버블", "마이크로\\s*버블", "모공\\s*속\\s*노폐물"];
    const isComment = (line: string) => /^\s*(?:\*|\/\/)/.test(line);
    const offenders = readSources(sourceDir).flatMap(({ path, text }) => text.split("\n")
      .map((line, index) => ({ path: path.split("/src/")[1] ?? path, line: index + 1, text: line }))
      .filter((entry) => !isComment(entry.text) && productLabels.some((label) => entry.text.includes(label))));

    expect(offenders.map((item) => `${item.path}:${item.line} ${item.text.trim()}`)).toEqual([]);
  });
});
