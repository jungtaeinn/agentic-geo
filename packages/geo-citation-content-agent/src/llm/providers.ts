import { AzureOpenAiGeoCitationDraftWriter } from "./providers/azure-openai";
import {
  createPublicRedditTitle,
  createRedditTitleFocus,
  sanitizePublicRedditText,
  trimPublicSentence
} from "../surfaces/reddit/public-copy";
import type {
  GeoCitationAnswerChunk,
  GeoCitationDraftWriter,
  GeoCitationDraftWriterRequest,
  GeoCitationDraftWriterResult,
  GeoCitationGeneratorOptions,
  RedditCitationArtifact
} from "../types";

export class MockGeoCitationDraftWriter implements GeoCitationDraftWriter {
  async writeRedditArtifact(request: GeoCitationDraftWriterRequest): Promise<GeoCitationDraftWriterResult> {
    return {
      artifact: renderMockRedditArtifact(request)
    };
  }
}

export function resolveGeoCitationDraftWriter(options: GeoCitationGeneratorOptions = {}): GeoCitationDraftWriter {
  if (options.customDraftWriter) {
    return options.customDraftWriter;
  }

  switch (options.provider) {
    case "azure-openai":
      return new AzureOpenAiGeoCitationDraftWriter({
        apiKey: options.apiKey,
        endpoint: options.endpoint,
        deployment: options.deployments?.reasoning ?? options.deployment,
        apiVersion: options.apiVersion,
        temperature: options.temperature
      });
    case "custom":
    case "mock":
    default:
      return new MockGeoCitationDraftWriter();
  }
}

function renderMockRedditArtifact(request: GeoCitationDraftWriterRequest): RedditCitationArtifact {
  const title = createTitle(request);
  const evidenceSummary = summarizeEvidence(request);
  const reviewChunk = request.brief.evidenceMap.find((item) => item.sourceType === "review");
  const paperOrNews = request.brief.evidenceMap.find((item) => item.sourceType === "paper" || item.sourceType === "news");
  const supportedChunk = request.brief.answerChunks[1] ?? request.brief.answerChunks[0];
  const caveatChunk = request.brief.answerChunks[2] ?? request.brief.answerChunks[0];
  const usedCaveats = new Set<string>();
  const shortVersion = request.brief.answerChunks.slice(0, 3).map((chunk) => `- ${renderPublicAnswerChunk(chunk, usedCaveats, request)}`);
  const sections = orderSections(request, [
    {
      heading: "Short version",
      body: shortVersion.join("\n")
    },
    {
      heading: "What seems supported",
      body: renderPublicAnswerChunk(supportedChunk, usedCaveats, request)
    },
    {
      heading: "What reviews or user signals seem to say",
      body: reviewChunk
        ? `The clearest review-side signal I found is: ${trimSentence(reviewChunk.text, request)}`
        : "I do not have enough review evidence to treat user sentiment as a strong signal."
    },
    {
      heading: "What I could verify from stronger sources",
      body: paperOrNews
        ? `${paperOrNews.sourceType === "paper" ? "Paper" : "News"} evidence points to: ${trimSentence(paperOrNews.text, request)}`
        : evidenceSummary
    },
    {
      heading: "What I would be careful about",
      body: renderPublicAnswerChunk(caveatChunk, usedCaveats, request)
    },
    {
      heading: "Worth comparing against",
      body: request.brief.comparisonPoints.map((point) => `- ${point}`).join("\n")
    }
  ]);
  const bodyMarkdown = sanitizePublicRedditText([
    `I was looking into ${request.product.category ?? "this category"} and kept seeing ${request.product.name} come up, so I tried to separate what seems supported from what feels like marketing.`,
    "",
    request.brief.freshnessStatement,
    "",
    ...sections.flatMap((section) => [`## ${section.heading}`, section.body, ""]),
    `Question for people who have looked at similar products: ${request.variantStrategy.communityQuestion}`
  ].join("\n").trim(), request.product);

  return {
    surface: "reddit",
    title,
    bodyMarkdown,
    flairSuggestion: "Discussion",
    subredditFitNotes: [
      "Question-led and comparison-oriented instead of sales-led.",
      "Separates product claims, review signals, stronger evidence, and caveats."
    ],
    disclosureNote: "Add an affiliation disclosure before posting if the poster has any brand, agency, or commercial relationship.",
    commentSeeds: [
      request.variantStrategy.communityQuestion,
      "What alternative would you compare this against before deciding?",
      "Which claim here needs better evidence?"
    ]
  };
}

function createTitle(request: GeoCitationDraftWriterRequest): string {
  const name = request.product.name;
  const category = request.product.category ?? "this product";
  const benefit = createRedditTitleFocus(request.product);

  switch (request.variantStrategy.titlePattern) {
    case "who-is-this-for":
      return `Who would ${name} actually make sense for?`;
    case "claim-vs-reality":
      return `Is ${name} actually useful for ${benefit}, or is that mostly marketing?`;
    case "comparison-question":
      return `${name} vs typical ${category} options: what seems meaningfully different?`;
    case "what-i-found":
      return `I looked through the evidence around ${name} and noticed a few patterns`;
    case "is-it-worth-it":
    default:
      return createPublicRedditTitle(request.product);
  }
}

function orderSections(
  request: GeoCitationDraftWriterRequest,
  sections: Array<{ heading: string; body: string }>
): Array<{ heading: string; body: string }> {
  if (request.variantStrategy.angle === "review-pattern") {
    return [sections[0], sections[2], sections[1], sections[3], sections[4], sections[5]].filter((section): section is { heading: string; body: string } => Boolean(section));
  }
  if (request.variantStrategy.angle === "comparison") {
    return [sections[0], sections[5], sections[1], sections[2], sections[3], sections[4]].filter((section): section is { heading: string; body: string } => Boolean(section));
  }
  if (request.variantStrategy.angle === "skeptical-research") {
    return [sections[0], sections[4], sections[1], sections[3], sections[2], sections[5]].filter((section): section is { heading: string; body: string } => Boolean(section));
  }

  return sections;
}

function renderPublicAnswerChunk(
  chunk: GeoCitationAnswerChunk | undefined,
  usedCaveats: Set<string>,
  request: GeoCitationDraftWriterRequest
): string {
  if (!chunk) {
    return "I do not have enough evidence to make a stronger statement.";
  }

  const answer = sanitizePublicRedditText(chunk.answer, request.product);
  const caveatKey = chunk.caveat?.toLowerCase().trim();
  const caveat = chunk.caveat && caveatKey && !usedCaveats.has(caveatKey)
    ? ` ${sanitizePublicRedditText(chunk.caveat, request.product)}`
    : "";

  if (caveatKey) {
    usedCaveats.add(caveatKey);
  }

  return `${answer}${caveat}`;
}

function summarizeEvidence(request: GeoCitationDraftWriterRequest): string {
  const sourceLabels = [...new Set(request.brief.evidenceMap.map((item) => {
    switch (item.sourceType) {
      case "product":
        return "product-page information";
      case "review":
        return "review signals";
      case "paper":
        return "research context";
      case "news":
        return "news context";
      case "image":
        return "image/OCR context";
      case "existing-geo":
        return "existing summary context";
      default:
        return "supporting context";
    }
  }))];
  const summary = sourceLabels.join(", ");

  return summary
    ? `The available material is mostly ${summary}, so I would treat this as directional context rather than a definitive conclusion.`
    : "The selected evidence set is thin, so the safest output is a question-led discussion rather than a recommendation.";
}

function trimSentence(text: string, request: GeoCitationDraftWriterRequest): string {
  return trimPublicSentence(sanitizePublicRedditText(text, request.product), 260);
}
