import type { GeoCitationDraftWriterRequest } from "../types";

export function buildRedditDraftPrompt(request: Omit<GeoCitationDraftWriterRequest, "prompt">): string {
  const mandatoryNames = request.mandatoryRagDocuments.map((document) => document.name).join(", ");
  const surfaceNames = request.surfaceRagDocuments.map((document) => document.name).join(", ");
  const ragContent = [
    ...request.mandatoryRagDocuments,
    ...request.surfaceRagDocuments
  ].map((document) => [
    `## ${document.name}`,
    document.content.slice(0, 6000)
  ].join("\n")).join("\n\n");
  const answerChunks = request.brief.answerChunks
    .map((chunk) => `Q: ${chunk.question}\nA: ${chunk.answer}\nEvidence: ${chunk.evidenceRefs.join(", ") || "none"}\nCaveat: ${chunk.caveat ?? "none"}`)
    .join("\n\n");
  const evidenceMap = request.brief.evidenceMap
    .map((evidence) => [
      `- id: ${evidence.id}`,
      `  type: ${evidence.sourceType}`,
      evidence.title ? `  title: ${evidence.title}` : undefined,
      evidence.publishedAt ? `  publishedAt: ${evidence.publishedAt}` : undefined,
      evidence.observedAt ? `  observedAt: ${evidence.observedAt}` : undefined,
      `  text: ${evidence.text.slice(0, 900)}`
    ].filter(Boolean).join("\n"))
    .join("\n");

  return [
    "Generate a Reddit discussion artifact, not an advertisement.",
    `Surface: ${request.target.surface}`,
    `Locale: ${request.target.locale}`,
    `Mandatory RAG: ${mandatoryNames}`,
    `Surface RAG: ${surfaceNames}`,
    `Variant angle: ${request.variantStrategy.angle}`,
    `Tone: ${request.variantStrategy.toneProfile}`,
    `Product: ${request.product.name}`,
    `Freshness: ${request.brief.freshnessStatement}`,
    "Use answer chunks internally, but render title/bodyMarkdown as public Reddit copy that can be pasted directly into Reddit.",
    "Do not include diagnostics, internal evidence IDs, RAG IDs, source counts, or labels like \"Evidence refs\" in bodyMarkdown.",
    "Do not expose the target audience setting as text; rewrite it as natural product-fit context.",
    "Do not dump raw INCI/ingredient lists. Mention at most 2-3 key actives if useful.",
    "Keep the title under 120 characters and avoid turning product descriptions into title text.",
    "Do not invent personal usage experience. Do not add sales CTAs.",
    "Return strict JSON only with this shape:",
    "{\"title\":\"\",\"bodyMarkdown\":\"\",\"flairSuggestion\":\"Discussion\",\"subredditFitNotes\":[\"\"],\"disclosureNote\":\"\",\"commentSeeds\":[\"\"]}",
    "",
    "Mandatory and surface RAG content:",
    ragContent,
    "",
    "Answer chunks:",
    answerChunks,
    "",
    "Evidence map:",
    evidenceMap
  ].join("\n");
}
