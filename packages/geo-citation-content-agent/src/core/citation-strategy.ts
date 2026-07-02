import type {
  GeoCitationContentAngle,
  GeoCitationEvidenceSourceType,
  GeoCitationNormalizedProduct,
  GeoCitationStrategySettings,
  RedditContentVariantStrategy
} from "../types";

const angles: GeoCitationContentAngle[] = [
  "claim-check",
  "comparison",
  "use-case-fit",
  "review-pattern",
  "skeptical-research",
  "buyer-question"
];

export function createRedditVariantStrategy(input: {
  product: GeoCitationNormalizedProduct;
  strategy?: GeoCitationStrategySettings;
  availableEvidenceTypes: GeoCitationEvidenceSourceType[];
}): RedditContentVariantStrategy {
  const seed = input.strategy?.variants?.seed ?? `${input.product.name}:${Date.now()}:${Math.random()}`;
  const angle = input.strategy?.contentAngle ?? pick(angles, seed);
  const evidenceFocus = selectEvidenceFocus(angle, input.availableEvidenceTypes);
  const titlePattern = titlePatternForAngle(angle);
  const toneProfile = angle === "skeptical-research"
    ? "skeptical-but-fair"
    : angle === "buyer-question"
      ? "community-question"
      : "practical-research";

  return {
    variantId: `reddit-${angle}-${hash(seed).toString(36)}`,
    angle,
    titlePattern,
    evidenceFocus,
    toneProfile,
    communityQuestion: communityQuestionForAngle(angle, input.product)
  };
}

function selectEvidenceFocus(angle: GeoCitationContentAngle, available: GeoCitationEvidenceSourceType[]): GeoCitationEvidenceSourceType[] {
  const preferredByAngle: Record<GeoCitationContentAngle, GeoCitationEvidenceSourceType[]> = {
    "claim-check": ["product", "paper", "news", "review"],
    comparison: ["product", "review", "existing-geo", "custom"],
    "use-case-fit": ["review", "product", "image"],
    "review-pattern": ["review", "image", "product"],
    "skeptical-research": ["paper", "news", "review", "product"],
    "buyer-question": ["review", "product", "existing-geo"]
  };
  const preferred = preferredByAngle[angle].filter((type) => available.includes(type));

  return preferred.length > 0 ? preferred : available.slice(0, 4);
}

function titlePatternForAngle(angle: GeoCitationContentAngle): RedditContentVariantStrategy["titlePattern"] {
  switch (angle) {
    case "comparison":
      return "comparison-question";
    case "use-case-fit":
      return "who-is-this-for";
    case "review-pattern":
      return "what-i-found";
    case "skeptical-research":
    case "claim-check":
      return "claim-vs-reality";
    case "buyer-question":
    default:
      return "is-it-worth-it";
  }
}

function communityQuestionForAngle(angle: GeoCitationContentAngle, product: GeoCitationNormalizedProduct): string {
  const category = product.category ?? "this category";
  switch (angle) {
    case "comparison":
      return `What would you compare this against in ${category}?`;
    case "review-pattern":
      return "Have you seen the same review pattern, or did your experience differ?";
    case "use-case-fit":
      return "Who do you think this actually fits best?";
    case "skeptical-research":
      return "What claim would you want stronger evidence for before trusting it?";
    case "claim-check":
      return "Does this claim/evidence split feel fair, or am I missing something?";
    case "buyer-question":
    default:
      return "If you were comparing options, what would you want to verify first?";
  }
}

function pick<T>(values: T[], seed: string): T {
  return values[hash(seed) % values.length] as T;
}

function hash(value: string): number {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    result = (result * 31 + value.charCodeAt(index)) >>> 0;
  }

  return result;
}
