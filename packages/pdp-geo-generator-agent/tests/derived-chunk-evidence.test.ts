import { describe, expect, it } from "vitest";
import { generatePdpGeo } from "../src";

/**
 * RAG 청크는 파생 산출물이다 — 상품 필드에서 만들어진 것이므로 그 자체가
 * 근거가 될 수 없다. 이 원칙은 이미 세워져 있었으나(`isDerivedKeywordOrChunkKey`)
 * sourceTexts 수집 경로에는 적용되지 않았다.
 *
 * 1027 최종 실행에서 그 구멍이 발행물을 망쳤다. 청크는 서로 다른 사실을
 * 줄바꿈으로 묶어 두는데(상품명 / 효능 문장 / 키워드 목록 / 패키지 라벨 /
 * 성분 설명), 인접한 무관한 줄이 한 문장으로 이어붙어
 *
 *   "Ceramide 1000 ppm Moisturizing & strengthening for dry & sensitive skin
 *    세라마이드는 피부 장벽을 강화하고 … 성분입니다."
 *
 * 라는 문장이 만들어졌고, 그것이 `Product.description`에 그대로 실렸다. 앞
 * 절은 패키지 라벨이고 그 안의 `1000 ppm`은 제품컷(신뢰도 0.72)의 오독이다 —
 * 상세 이미지들은 `10,000 ppm`이라고 옮겼다.
 */
const RAG_CHUNK_TEXT = [
  "모이베리어 365 크림 미스트",
  "10,000ppm 함유된 고함량 세라마이드 미세분사로 피부장벽을 보호하는",
  "제품은 수분을 충전하는 동시에 피부 표면에 보습막을 형성하는 효능으로 안내됩니다.",
  "Moisturizing",
  "보습",
  "장벽",
  "Ceramide 1000 ppm Moisturizing & strengthening for dry & sensitive skin",
  "세라마이드는 피부 장벽을 강화하고 피부 내 수분을 유지하는 데 도움을 주는 피부 장벽 성분으로 설명됩니다."
].join("\n");

async function generateMist() {
  const { result } = await generatePdpGeo({
    product: {
      geoProduct: {
        name: "모이베리어 365 크림 미스트",
        description: "건조하고 민감한 피부를 위한 크림 미스트입니다.",
        brand: "EXAMPLEDERMA",
        category: "미스트",
        benefits: ["보습", "피부 장벽"],
        ingredients: ["세라마이드 10,000ppm"],
        usage: [],
        sourceExtraction: {
          ocr: {
            imageTexts: [{
              imageUrl: "https://cdn.example.com/upload/product/1027_885_DSPIMG_L.png",
              text: "세라마이드\n피부 장벽을 강화하고 피부 내 수분을 유지하는 데 도움을 주는 피부 장벽 성분",
              confidence: 0.9
            }],
            textBlocks: ["세라마이드\n피부 장벽을 강화하고 피부 내 수분을 유지하는 데 도움을 주는 피부 장벽 성분"]
          }
        },
        rag: { chunks: [{ id: "product-0", kind: "product", text: RAG_CHUNK_TEXT }] }
      }
    },
    source: { type: "pdp-extractor" as const, url: "https://shop.example.com/web/product/view.do?prdSeq=1027" },
    hints: { locale: "ko-KR" as const, market: "KR" as const }
  } as never);
  return result;
}

describe("파생 청크는 근거가 아니다", () => {
  it("does not paste a chunk's false adjacency into the product description", async () => {
    const result = await generateMist();
    const description = String(
      (result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, unknown>>)
        .find((node) => node["@type"] === "Product")?.description ?? ""
    );

    expect(description).not.toContain("Moisturizing & strengthening");
    expect(description).not.toContain("1000 ppm");
  });

  it("does not carry a chunk-only measurement into any published field", async () => {
    const result = await generateMist();
    const published = JSON.stringify(result.schemaMarkup.jsonLd) + JSON.stringify(result.content.sections);

    // 제품컷 오독. 상세 이미지가 옮긴 10,000ppm만 남아야 한다.
    expect(/1000\s*ppm/i.test(published.replace(/10,000\s*ppm/gi, ""))).toBe(false);
  });

  it("still publishes the facts the product fields state", async () => {
    const result = await generateMist();
    const published = JSON.stringify(result.schemaMarkup.jsonLd);

    expect(published).toContain("세라마이드");
    expect(published).toContain("피부 장벽");
  });
});

/**
 * 독립 문장 목록은 한 덩어리가 아니다.
 *
 * OCR 줄 목록(`lines`/`textBlocks`)을 한 텍스트로 잇는 것은 맞다 — 한 전사의
 * 줄들이기 때문이다. 그러나 `evidenceSentences`는 서로 다른 이미지에서 온
 * 독립 문장의 목록이다. 키 이름이 `sentences`에 걸린다는 이유로 함께 이어붙이면
 * 거짓 인접이 생기고, 뒤이은 문장 조립이 그 둘을 한 문장으로 만든다.
 *
 * 1027 실측: 패키지 라벨(`Ceramide 1000 ppm Moisturizing & strengthening for
 * dry & sensitive skin`)과 성분 설명 문장이 한 문장으로 붙어 `Product.description`에
 * 실렸다. 앞 절의 수치는 제품컷(신뢰도 0.72)의 오독이고, 상세 이미지들은
 * `10,000 ppm`이라고 옮겼다.
 */
describe("독립 문장 목록", () => {
  it("does not fuse two independent evidence sentences into one", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "모이베리어 365 크림 미스트",
          description: "건조하고 민감한 피부를 위한 크림 미스트입니다.",
          brand: "EXAMPLEDERMA",
          category: "미스트",
          benefits: ["보습", "피부 장벽"],
          ingredients: ["세라마이드 10,000ppm"],
          usage: [],
          sourceExtraction: {
            ocr: {
              semanticFacts: { evidenceSentences: ["Ceramide 1000 ppm Moisturizing & strengthening for dry & sensitive skin", "세라마이드는 피부 장벽을 강화하고 피부 내 수분을 유지하는 데 도움을 주는 피부 장벽 성분으로 설명됩니다.", "작게 쪼개진 세라마이드와 수분을 묶은 특수 에멀젼 공법으로, 흔들 필요 없이 사용할 수 있는 터치리스 보습 미스트라고 설명합니다.", "제품은 수분을 충전하는 동시에 피부 표면에 보습막을 형성하는 효능으로 안내됩니다.", "추천 피부 타입은 건조 피부 및 모든 피부입니다.", "연약하고 건조해진 피부 부위에 미세 분사합니다.", "피부에 건조함이 느껴질 때 수시로 뿌려 사용합니다.", "• 작게 쪼개진 세라마이드와 수분이 묶여있어 흔들 필요 없이 사용하는 터치리스 착붙보습 • 10,000ppm 세라마이드로 가득 채운 미세촘촘 안개미스트 • 부드럽게 뿌려져 피부 표면에 보습막을 형성"] }
            }
          }
        }
      },
      source: { type: "pdp-extractor" as const, url: "https://shop.example.com/web/product/view.do?prdSeq=1027" },
      hints: { locale: "ko-KR" as const, market: "KR" as const }
    } as never);

    const fused = (result.diagnostics.normalizedProduct.sourceTexts ?? [])
      .some((text) => text.includes("sensitive skin 세라마이드는"));
    expect(fused).toBe(false);
  });
});
