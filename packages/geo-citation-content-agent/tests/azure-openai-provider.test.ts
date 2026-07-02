import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMockGeoCitationContentInput,
  generateGeoCitationContent
} from "../src";

describe("Azure OpenAI draft writer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses deployment-scoped Azure chat completions for Reddit artifact generation", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              title: "Is Hydra Barrier Cream actually useful for hydration?",
              bodyMarkdown: [
                "I compared the product claims with the supplied review and paper evidence.",
                "",
                "Short version:",
                "- It appears most relevant for hydration-focused routines.",
                "- Caveat: this is directional evidence, not a guarantee.",
                "",
                "What would you compare this against?"
              ].join("\n"),
              flairSuggestion: "Discussion",
              subredditFitNotes: ["Question-led and evidence-backed."],
              disclosureNote: "Disclose affiliation if relevant.",
              commentSeeds: ["What would you compare this against?"]
            })
          }
        }
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 24,
        total_tokens: 36
      }
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    }));
    vi.stubGlobal("fetch", fetchMock);

    const run = await generateGeoCitationContent(createMockGeoCitationContentInput(), {
      provider: "azure-openai",
      apiKey: "test-key",
      endpoint: "https://agentic-geo.openai.azure.com/",
      deployments: {
        reasoning: "gpt-4.1-test"
      },
      apiVersion: "2025-04-01-preview",
      temperature: 0.4
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, any>;

    expect(url).toBe("https://agentic-geo.openai.azure.com/openai/deployments/gpt-4.1-test/chat/completions?api-version=2025-04-01-preview");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      "api-key": "test-key"
    });
    expect(body.messages).toHaveLength(2);
    expect(body.temperature).toBe(0.4);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[1].content).toContain("Mandatory and surface RAG content");
    expect(run.result.artifact.title).toContain("Hydra Barrier Cream");
    expect(run.result.artifact.bodyMarkdown).toContain("Short version");
    expect(run.result.diagnostics.channelWarnings).toEqual([]);
    expect(run.result.diagnostics.runtimeUsage.provider).toBe("azure-openai");
    expect(run.result.diagnostics.runtimeUsage.deployment).toBe("gpt-4.1-test");
    expect(run.result.diagnostics.runtimeUsage.called).toBe(true);
  });
});
