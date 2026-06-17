type ProviderId = "mock" | "openai" | "gemini" | "azure-openai";

interface ProviderValidationRequest {
  provider?: ProviderId;
  apiKey?: string;
  model?: string;
  endpoint?: string;
  deployment?: string;
  apiVersion?: string;
  listOnly?: boolean;
}

interface ProviderValidationResult {
  ok: boolean;
  provider: ProviderId;
  message: string;
  details?: string;
  models?: string[];
}

/** Validates UI-provided provider credentials before the extractor agent uses them. */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json() as ProviderValidationRequest;
    const provider = body.provider ?? "mock";
    const result = await validateProvider({ ...body, provider });

    return jsonResponse(result, result.ok ? 200 : 400);
  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        provider: "mock",
        message: error instanceof Error ? error.message : "Provider validation failed."
      },
      500
    );
  }
}

async function validateProvider(config: Required<Pick<ProviderValidationRequest, "provider">> & ProviderValidationRequest): Promise<ProviderValidationResult> {
  if (config.provider === "mock") {
    return {
      ok: true,
      provider: "mock",
      message: "Mock provider는 별도 API Key 없이 사용할 수 있습니다."
    };
  }

  if (config.provider === "openai") {
    return validateOpenAI(config);
  }

  if (config.provider === "gemini") {
    return validateGemini(config);
  }

  return validateAzureOpenAI(config);
}

async function validateOpenAI(config: ProviderValidationRequest): Promise<ProviderValidationResult> {
  const apiKey = normalizeSecretInput(config.apiKey);

  if (!apiKey) {
    return failed("openai", "OpenAI API Key가 필요합니다.");
  }

  const model = config.model?.trim();
  const response = await fetch("https://api.openai.com/v1/models", {
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    cache: "no-store"
  });

  if (!response.ok) {
    return failed("openai", `OpenAI 연결 확인 실패: ${response.status}`, await readProviderError(response));
  }

  const payload = await response.json() as { data?: Array<{ id?: string }> };
  const models = sortModelIds(payload.data?.map((item) => item.id).filter(isString) ?? []);

  if (model && !config.listOnly) {
    const hasModel = models.includes(model);

    if (!hasModel) {
      return failed(
        "openai",
        `OpenAI API Key는 유효하지만 '${model}' 모델 접근을 확인하지 못했습니다.`,
        "모델명을 비우거나 API Dashboard에서 사용 가능한 모델 ID를 입력해주세요."
      );
    }
  }

  return connected("openai", "OpenAI API Key와 모델 접근을 확인했습니다.", models);
}

async function validateGemini(config: ProviderValidationRequest): Promise<ProviderValidationResult> {
  const apiKey = normalizeSecretInput(config.apiKey);

  if (!apiKey) {
    return failed("gemini", "Gemini API Key가 필요합니다.");
  }

  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
    headers: {
      "x-goog-api-key": apiKey
    },
    cache: "no-store"
  });

  if (!response.ok) {
    return failed("gemini", `Gemini 연결 확인 실패: ${response.status}`, await readProviderError(response));
  }

  const payload = await response.json() as {
    models?: Array<{
      name?: string;
      supportedGenerationMethods?: string[];
    }>;
  };
  const models = sortModelIds(
    payload.models
      ?.filter((item) => !item.supportedGenerationMethods || item.supportedGenerationMethods.includes("generateContent"))
      .map((item) => item.name?.replace(/^models\//, ""))
      .filter(isString) ?? []
  );
  const model = config.model?.trim();

  if (model && !config.listOnly) {
    const hasModel = models.includes(model);

    if (!hasModel) {
      return failed(
        "gemini",
        `Gemini API Key는 유효하지만 '${model}' 모델 접근을 확인하지 못했습니다.`,
        "모델명을 비우거나 Google AI Studio에서 사용 가능한 모델 ID를 입력해주세요."
      );
    }
  }

  return connected("gemini", "Gemini API Key와 모델 접근을 확인했습니다.", models);
}

async function validateAzureOpenAI(config: ProviderValidationRequest): Promise<ProviderValidationResult> {
  const apiKey = normalizeSecretInput(config.apiKey);
  const endpoint = config.endpoint?.trim().replace(/\/$/, "");
  const apiVersion = config.apiVersion?.trim() || "2024-10-21";

  if (!apiKey || !endpoint) {
    return failed("azure-openai", "Azure API Key와 Endpoint가 필요합니다.");
  }

  const response = await fetch(`${endpoint}/openai/deployments?api-version=${encodeURIComponent(apiVersion)}`, {
    headers: {
      "api-key": apiKey
    },
    cache: "no-store"
  });

  if (!response.ok) {
    return failed("azure-openai", `Azure OpenAI 연결 확인 실패: ${response.status}`, await readProviderError(response));
  }

  const payload = await response.json() as { data?: Array<{ id?: string; model?: string }> };
  const deployments = sortModelIds(payload.data?.map((item) => item.id ?? item.model).filter(isString) ?? []);

  if (config.listOnly) {
    return connected("azure-openai", "Azure OpenAI 배포 목록을 불러왔습니다.", deployments);
  }

  if (!config.deployment?.trim()) {
    return failed("azure-openai", "Azure Deployment를 선택해주세요.", "모델 목록을 불러온 뒤 배포를 선택할 수 있습니다.");
  }

  if (!deployments.includes(config.deployment.trim())) {
    return failed(
      "azure-openai",
      `Azure OpenAI 연결은 되었지만 '${config.deployment.trim()}' 배포를 확인하지 못했습니다.`,
      "Azure OpenAI Studio에서 배포 이름을 확인하거나 모델 목록에서 선택해주세요."
    );
  }

  return connected("azure-openai", "Azure OpenAI 연결 설정이 유효합니다.", deployments);
}

function connected(provider: ProviderId, message: string, models: string[] = []): ProviderValidationResult {
  return { ok: true, provider, message, models };
}

function failed(provider: ProviderId, message: string, details?: string): ProviderValidationResult {
  return { ok: false, provider, message, details };
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function sortModelIds(models: string[]): string[] {
  return Array.from(new Set(models)).sort((a, b) => a.localeCompare(b));
}

function normalizeSecretInput(value?: string): string {
  const trimmed = value?.trim() ?? "";
  const withoutExport = trimmed.replace(/^export\s+/i, "");
  const assignment = withoutExport.match(/^[A-Z0-9_]+\s*=\s*(.+)$/i);
  const rawValue = assignment?.[1] ?? withoutExport;

  return rawValue.trim().replace(/^["']|["']$/g, "");
}

async function readProviderError(response: Response): Promise<string | undefined> {
  try {
    const payload = await response.json() as {
      error?: {
        message?: string;
        code?: string;
        status?: string;
      };
      error_description?: string;
      message?: string;
    };
    const message = formatProviderErrorDetail(payload.error?.message ?? payload.error_description ?? payload.message);
    const code = payload.error?.code ?? payload.error?.status;

    return [message, code ? `code: ${code}` : undefined].filter(Boolean).join("\n") || undefined;
  } catch {
    return undefined;
  }
}

function formatProviderErrorDetail(message?: string): string | undefined {
  if (!message) {
    return undefined;
  }

  const sanitized = message
    .replace(/sk-(?:proj|live|test|admin|svcacct)?-[A-Za-z0-9_*=-]{8,}/gi, "sk-...[숨김]")
    .replace(/AIza[A-Za-z0-9_-]{8,}/g, "AIza...[숨김]")
    .replace(/[A-Za-z0-9_-]*\*{12,}[A-Za-z0-9_*=.-]*/g, "[키 숨김]")
    .replace(/\*{12,}/g, "********")
    .replace(/\s+/g, " ")
    .trim();

  if (/incorrect api key/i.test(sanitized)) {
    return "API Key가 올바르지 않습니다.\n키를 다시 입력하거나 provider 콘솔에서 새 키를 발급해주세요.";
  }

  return sanitized
    .replace(/\s+(https?:\/\/\S+)/g, "\n$1")
    .replace(/\s+code:\s*/gi, "\ncode: ")
    .slice(0, 360)
    .trim();
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}
