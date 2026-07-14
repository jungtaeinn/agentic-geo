import type { PdpGeoGenerationInput } from "../../src/types";

export const ineligibleHowToCases: Array<{
  label: string;
  input: PdpGeoGenerationInput;
}> = [
  {
    label: "unordered usage notes that do not form a procedure",
    input: {
      product: {
        name: "Hydra Serum",
        category: "Serum",
        description: "A hydrating serum for dry-feeling skin.",
        usage: ["Suitable for daily use.", "For external use only."]
      },
      hints: { locale: "en-US" }
    }
  },
  {
    label: "a high-level routine note without ordered actions",
    input: {
      product: {
        name: "Hydra Serum",
        category: "Serum",
        description: "A hydrating serum for dry-feeling skin.",
        usage: ["Suitable for daily post-cleansing routines."]
      },
      hints: { locale: "en-US" }
    }
  },
  {
    label: "two concrete but unordered body-area actions",
    input: {
      product: {
        name: "Hydra Serum",
        category: "Serum",
        description: "A hydrating serum for dry-feeling skin.",
        usage: ["Apply to the face.", "Massage the neck."]
      },
      hints: { locale: "en-US" }
    }
  }
];

export const sparseFaqInput: PdpGeoGenerationInput = {
  product: {
    name: "Hydra Serum",
    category: "Serum",
    description: "A daily hydrating serum.",
    benefits: ["hydration"],
    reviews: {
      keywords: ["hydration"],
      items: [
        { body: "Daily use feels hydrating and comfortable on dry skin." }
      ]
    }
  },
  hints: { locale: "en-US" }
};

export const japaneseLocalePurityInput: PdpGeoGenerationInput = {
  product: {
    name: "テスト美容液",
    category: "美容液",
    description: "乾燥肌向けの保湿美容液です。",
    benefits: ["保湿"],
    ingredients: ["セラミド"],
    reviews: {
      keywords: ["hydration", "smooth texture"],
      items: [
        { body: "Daily use leaves skin smooth and hydrated." }
      ]
    }
  },
  hints: { locale: "ja-JP" }
};

export const sensibleDescriptionInput: PdpGeoGenerationInput = {
  product: {
    name: "하이드라 배리어 세럼",
    brand: "테스트랩",
    category: "세럼",
    description: "건조한 피부를 위한 보습 세럼입니다.",
    benefits: ["보습", "피부 장벽 케어"],
    ingredients: ["세라마이드", "판테놀"],
    usage: ["세안 후 세럼 단계에서 사용합니다."]
  },
  hints: { locale: "ko-KR" }
};
