import { buildRedditDraftPrompt } from "../../llm/prompt";
import type {
  GeoCitationContentBrief,
  GeoCitationDraftWriter,
  GeoCitationNormalizedProduct,
  GeoCitationRagDocument,
  GeoCitationTargetSettings,
  RedditCitationArtifact,
  RedditContentVariantStrategy
} from "../../types";

export async function generateRedditCitationArtifact(input: {
  product: GeoCitationNormalizedProduct;
  target: Required<GeoCitationTargetSettings>;
  brief: GeoCitationContentBrief;
  variantStrategy: RedditContentVariantStrategy;
  mandatoryRagDocuments: GeoCitationRagDocument[];
  surfaceRagDocuments: GeoCitationRagDocument[];
  writer: GeoCitationDraftWriter;
}): Promise<RedditCitationArtifact> {
  const promptInput = {
    product: input.product,
    target: input.target,
    brief: input.brief,
    variantStrategy: input.variantStrategy,
    mandatoryRagDocuments: input.mandatoryRagDocuments,
    surfaceRagDocuments: input.surfaceRagDocuments
  };
  const prompt = buildRedditDraftPrompt(promptInput);
  const result = await input.writer.writeRedditArtifact({
    ...promptInput,
    prompt
  });

  return result.artifact;
}
