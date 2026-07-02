import { MockGeoCitationDraftWriter } from "./llm/providers";
import type { GeoCitationContentInput } from "./types";

export { MockGeoCitationDraftWriter };

export function createMockGeoCitationContentInput(): GeoCitationContentInput {
  return {
    product: {
      name: "Hydra Barrier Cream",
      description: "Daily cream for dry skin, hydration, and skin barrier support.",
      brand: "Agentic Beauty",
      category: "moisturizer",
      benefits: ["hydration", "skin barrier support"],
      ingredients: ["Ceramide", "Hyaluronic Acid"],
      usage: ["Apply after serum in the morning or evening."],
      reviews: {
        keywords: ["absorbs quickly", "less tightness", "works under makeup"]
      }
    },
    source: {
      type: "manual-json",
      url: "https://example.com/products/hydra-barrier-cream",
      observedAt: "2026-07-01"
    },
    evidence: {
      reviews: [
        {
          id: "review:1",
          text: "Several reviewers mention that the cream absorbs quickly and feels comfortable under makeup.",
          rating: 5,
          observedAt: "2026-07-01"
        }
      ],
      researchPapers: [
        {
          id: "paper:1",
          title: "Ceramide-containing moisturizers and barrier care",
          text: "Ceramide-containing moisturizers are often discussed as supportive for skin barrier care in cosmetic routines.",
          publishedAt: "2025-11-15"
        }
      ]
    },
    target: {
      surface: "reddit",
      locale: "en-US",
      market: "US",
      communityOrChannelHint: "r/SkincareAddiction"
    },
    strategy: {
      contentAngle: "claim-check",
      variants: {
        seed: "mock"
      }
    }
  };
}
