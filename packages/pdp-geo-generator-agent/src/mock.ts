import { generatePdpGeo } from "./agent";
import type { PdpGeoGenerationRun } from "./types";

/** Deterministic sample run for apps, tests, and static demos. */
export async function runMockPdpGeoGeneration(): Promise<PdpGeoGenerationRun> {
  return generatePdpGeo({
    product: {
      name: "Hydra Barrier Cream",
      description: "Daily hydration cream for moisture barrier care.",
      brand: "Agentic Beauty",
      category: "Cream",
      price: "32000",
      currency: "KRW",
      benefits: ["보습 장벽 케어", "피부결 케어"],
      ingredients: ["Niacinamide", "Ceramide", "Panax Ginseng Root Extract"],
      usage: ["Apply morning and night after serum."],
      reviews: {
        rating: 4.8,
        reviewCount: 418,
        keywords: ["촉촉", "흡수감", "피부결"],
        items: [
          {
            body: "촉촉하고 흡수가 빨라서 재구매하고 싶어요.",
            rating: 5
          }
        ]
      }
    },
    source: {
      type: "manual-json",
      url: "https://example.com/products/hydra-barrier-cream"
    },
    hints: {
      locale: "ko-KR",
      market: "KR",
      brand: "Agentic Beauty",
      category: "Cream"
    }
  });
}
