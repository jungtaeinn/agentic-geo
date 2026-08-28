import type { GeoEvalEngineConfig, GeoEvalProvider } from "./engine";

/**
 * Shared CLI helpers for the geo-eval scripts (`apps/geo-generator/scripts/
 * run-geo-benchmark.ts` and `extract-engine-rules.ts`): flag parsing and
 * environment-based provider configuration. Kept in the eval tier so runtime
 * code never depends on it.
 */

export function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index === args.length - 1) {
    return undefined;
  }
  return args[index + 1];
}

export function resolveEngineConfigFromEnv(
  provider: GeoEvalProvider,
  args: string[],
  defaultTemperature = 0.5
): GeoEvalEngineConfig {
  const temperatureArg = argValue(args, "--temperature");
  const temperature = temperatureArg !== undefined ? Number.parseFloat(temperatureArg) : defaultTemperature;

  switch (provider) {
    case "openai":
      return {
        provider,
        apiKey: requiredEnv("OPENAI_API_KEY"),
        model: argValue(args, "--model") ?? requiredEnv("OPENAI_MODEL"),
        temperature
      };
    case "gemini":
      return {
        provider,
        apiKey: requiredEnv("GEMINI_API_KEY"),
        model: argValue(args, "--model") ?? requiredEnv("GEMINI_MODEL"),
        temperature
      };
    case "azure-openai":
      return {
        provider,
        apiKey: requiredEnv("AZURE_OPENAI_API_KEY"),
        endpoint: argValue(args, "--endpoint") ?? requiredEnv("AZURE_OPENAI_ENDPOINT"),
        deployment: argValue(args, "--deployment") ?? requiredEnv("AZURE_OPENAI_DEPLOYMENT"),
        apiVersion: argValue(args, "--api-version") ?? process.env.AZURE_OPENAI_API_VERSION,
        temperature
      };
    case "aistudio":
      return {
        provider,
        apiKey: requiredEnv("AISTUDIO_API_KEY"),
        endpoint: argValue(args, "--endpoint") ?? requiredEnv("AISTUDIO_ENDPOINT"),
        deployment: argValue(args, "--deployment") ?? requiredEnv("AISTUDIO_DEPLOYMENT"),
        apiVersion: argValue(args, "--api-version") ?? process.env.AISTUDIO_API_VERSION,
        temperature
      };
    default:
      throw new Error(`Unsupported geo-eval provider: ${String(provider)}`);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}
