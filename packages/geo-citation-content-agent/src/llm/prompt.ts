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

  const quotableEvidence = request.brief.quotableEvidence
    .map((quote) => `- ${quote.attribution} (${quote.evidenceId}): "${quote.quote}"`)
    .join("\n");
  const statisticsHighlights = request.brief.statisticsHighlights
    .map((highlight) => `- ${highlight}`)
    .join("\n");

  return [
    "Generate a Reddit discussion artifact, not an advertisement.",
    `Surface: ${request.target.surface}`,
    `Locale: ${request.target.locale}`,
    `Mandatory RAG: ${mandatoryNames}`,
    `Surface RAG: ${surfaceNames}`,
    `Variant angle: ${request.variantStrategy.angle}`,
    `Tone: ${request.variantStrategy.toneProfile}`,
    `Suggested flair: ${request.variantStrategy.flairSuggestion}`,
    `Product: ${request.product.name}`,
    `Freshness: ${request.brief.freshnessStatement}`,
    "Use answer chunks internally, but render title/bodyMarkdown as public Reddit copy that can be pasted directly into Reddit.",
    "Put a `## TL;DR` section with 2-4 bullet answer chunks near the very top of bodyMarkdown, right after at most one short context sentence. Reddit readers and AI answer engines both extract from the top.",
    "When quotable evidence is supplied below, include 1-2 of the quotes verbatim as markdown blockquotes (`> \"...\"`) with a natural attribution frame such as \"one review put it as\" or \"the paper describes it as\". Never paraphrase inside quotation marks and never fabricate a quote.",
    "When statistics highlights are supplied below, work 1-2 of them into the body as concrete numbers. Never invent numbers, percentages, or counts that are not in the supplied evidence.",
    "Match claim strength to evidence confidence: use \"may help\" or \"might\" for low-confidence claims, \"appears to\" or \"seems supported\" for medium, and \"multiple sources support\" only when several independent evidence items agree.",
    "Reddit markdown conventions: use `**bold**` on at most 2-3 key claim phrases, use `---` as a divider before the final community question, and keep paragraphs short (1-3 sentences).",
    "Do not include diagnostics, internal evidence IDs, RAG IDs, source counts, or labels like \"Evidence refs\" in bodyMarkdown.",
    "Do not expose the target audience setting as text; rewrite it as natural product-fit context.",
    "Do not dump raw INCI/ingredient lists. Mention at most 2-3 key actives if useful.",
    "Aim for a title of 60-100 characters (hard max 120) and avoid turning product descriptions into title text.",
    "Set flairSuggestion to the suggested flair above unless the subreddit hint clearly demands another; note in subredditFitNotes that the poster must map it to the target subreddit's real flair list.",
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
    quotableEvidence ? `Quotable evidence (verbatim only):\n${quotableEvidence}\n` : "",
    statisticsHighlights ? `Statistics highlights (source-backed only):\n${statisticsHighlights}\n` : "",
    "Evidence map:",
    evidenceMap
  ].filter((line) => line !== "").join("\n");
}
