import { buildGeneratorOptions } from "../src/config/generator-options.factory";

describe("buildGeneratorOptions", () => {
  it("defaults to mock without provider-specific settings", () => {
    const options = buildGeneratorOptions({});

    expect(options.provider).toBe("mock");
    expect(options.apiKey).toBeUndefined();
    expect(options.deployment).toBeUndefined();
    expect(options.finalProofreading?.enabled).toBe(false);
    expect(options.productNormalization?.enabled).toBe(false);
  });

  it("enables product normalization by default for a non-mock provider with a key", () => {
    const options = buildGeneratorOptions({
      AGENTIC_GEO_PROVIDER: "azure-openai",
      AZURE_OPENAI_API_KEY: "azure-key",
    });

    expect(options.productNormalization?.enabled).toBe(true);
  });

  it("turns product normalization off via the env switch", () => {
    const options = buildGeneratorOptions({
      AGENTIC_GEO_PROVIDER: "azure-openai",
      AZURE_OPENAI_API_KEY: "azure-key",
      AGENTIC_GEO_PRODUCT_NORMALIZATION: "false",
    });

    expect(options.productNormalization?.enabled).toBe(false);
  });

  it("maps aistudio env to endpoint, deployment ids, and api version", () => {
    const options = buildGeneratorOptions({
      AGENTIC_GEO_PROVIDER: "aistudio",
      AISTUDIO_API_KEY: "studio-key",
      AISTUDIO_ENDPOINT: "https://dev-aistudio.example.com:8082/v1/agent/abc",
      AISTUDIO_MODEL: "gpt-5.5",
      AISTUDIO_API_VERSION: "",
    });

    expect(options.provider).toBe("aistudio");
    expect(options.apiKey).toBe("studio-key");
    expect(options.endpoint).toBe("https://dev-aistudio.example.com:8082/v1/agent/abc");
    expect(options.model).toBe("gpt-5.5");
    expect(options.deployment).toBe("gpt-5.5");
    expect(options.deployments?.reasoning).toBe("gpt-5.5");
    expect(options.deployments?.ocr).toBe("gpt-5.5");
    expect(options.deployments?.proofreading).toBe("gpt-5.5");
    expect(options.apiVersion).toBeUndefined();
    expect(options.finalProofreading?.enabled).toBe(true);
  });

  it("keeps azure-openai deployment mapping intact", () => {
    const options = buildGeneratorOptions({
      AGENTIC_GEO_PROVIDER: "azure-openai",
      AZURE_OPENAI_API_KEY: "azure-key",
      AZURE_OPENAI_ENDPOINT: "https://azure.example.com",
      AZURE_OPENAI_REASONING_DEPLOYMENT: "gpt-5.5",
      AZURE_OPENAI_EMBEDDING_DEPLOYMENT: "text-embedding-3-large",
      AZURE_OPENAI_API_VERSION: "2025-04-01-preview",
    });

    expect(options.provider).toBe("azure-openai");
    expect(options.endpoint).toBe("https://azure.example.com");
    expect(options.deployment).toBe("gpt-5.5");
    expect(options.deployments?.embedding).toBe("text-embedding-3-large");
    expect(options.apiVersion).toBe("2025-04-01-preview");
    expect(options.embedding).toBeUndefined();
  });

  it("maps a separate azure embedding resource when its endpoint is set", () => {
    const options = buildGeneratorOptions({
      AGENTIC_GEO_PROVIDER: "azure-openai",
      AZURE_OPENAI_API_KEY: "azure-key",
      AZURE_OPENAI_ENDPOINT: "https://reasoning.example.com/",
      AZURE_OPENAI_DEPLOYMENT: "gpt-5.2",
      AZURE_OPENAI_API_VERSION: "2025-04-01-preview",
      AZURE_OPENAI_EMBEDDING_ENDPOINT: "https://embedding.example.com/",
      AZURE_OPENAI_EMBEDDING_DEPLOYMENT: "text-embedding-3-large",
      AZURE_OPENAI_EMBEDDING_API_VERSION: "2023-05-15",
    });

    expect(options.deployment).toBe("gpt-5.2");
    expect(options.deployments?.ocr).toBe("gpt-5.2");
    expect(options.embedding).toEqual({
      provider: "azure-openai",
      apiKey: "azure-key",
      endpoint: "https://embedding.example.com/",
      deployment: "text-embedding-3-large",
      apiVersion: "2023-05-15",
    });
  });
});
