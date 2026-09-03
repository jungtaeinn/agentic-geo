import { buildExtractorOptions } from "../src/config/extractor-options.factory";

describe("buildExtractorOptions", () => {
  it("maps aistudio env to extractor options with the model as ocr/reasoning deployment", () => {
    const options = buildExtractorOptions({
      AGENTIC_GEO_PROVIDER: "aistudio",
      AISTUDIO_API_KEY: "key",
      AISTUDIO_ENDPOINT: "https://aistudio.example.com",
      AISTUDIO_MODEL: "gpt-test",
    } as NodeJS.ProcessEnv);

    expect(options.provider).toBe("aistudio");
    expect(options.apiKey).toBe("key");
    expect(options.endpoint).toBe("https://aistudio.example.com");
    expect(options.deployments?.ocr).toBe("gpt-test");
    expect(options.deployments?.reasoning).toBe("gpt-test");
  });

  it("defaults to mock when no provider env is set", () => {
    expect(buildExtractorOptions({} as NodeJS.ProcessEnv).provider).toBe("mock");
  });

  it("maps azure-openai ocr deployment slot", () => {
    const options = buildExtractorOptions({
      AGENTIC_GEO_PROVIDER: "azure-openai",
      AZURE_OPENAI_API_KEY: "key",
      AZURE_OPENAI_ENDPOINT: "https://azure.example.com",
      AZURE_OPENAI_DEPLOYMENT: "gpt-base",
      AZURE_OPENAI_OCR_DEPLOYMENT: "gpt-ocr",
      AZURE_OPENAI_API_VERSION: "2025-04-01-preview",
    } as NodeJS.ProcessEnv);

    expect(options.deployments?.ocr).toBe("gpt-ocr");
    expect(options.apiVersion).toBe("2025-04-01-preview");
  });

  it("does not leak the generator-only proofreading deployment slot", () => {
    const options = buildExtractorOptions({
      AGENTIC_GEO_PROVIDER: "aistudio",
      AISTUDIO_API_KEY: "key",
      AISTUDIO_ENDPOINT: "https://aistudio.example.com",
      AISTUDIO_MODEL: "gpt-test",
    } as NodeJS.ProcessEnv);

    expect(options.deployments).not.toHaveProperty("proofreading");
  });
});
