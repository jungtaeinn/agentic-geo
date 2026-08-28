import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";

let processor: LangfuseSpanProcessor | undefined;

/**
 * LANGFUSE_PUBLIC_KEY/SECRET_KEY가 있을 때만 OTel 파이프라인을 등록한다.
 * 키가 없는 환경(dev/qa/prd)에서는 no-op — @langfuse/tracing 호출이 남아 있어도 아무것도 전송하지 않는다.
 */
export function initLangfuse(env: NodeJS.ProcessEnv = process.env): boolean {
  if (processor) return true;
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) return false;
  processor = new LangfuseSpanProcessor();
  new NodeSDK({ spanProcessors: [processor] }).start();
  return true;
}

/** 배치 전송을 기다리지 않고 즉시 밀어낸다. 로컬 테스트 API처럼 호출량이 적은 경로에서만 사용. */
export async function flushLangfuse(): Promise<void> {
  await processor?.forceFlush();
}
