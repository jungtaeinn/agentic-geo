import type { ProductExtractorOptions } from "@agentic-geo/pdp-extractor-agent";
import { selectSharedLlmEnv } from "./llm-env-selection";

/** 생성기 옵션 팩토리와 같은 env 표면을 추출기 옵션으로 사상한다(OCR 배포 슬롯 포함). */
export function buildExtractorOptions(env: NodeJS.ProcessEnv = process.env): ProductExtractorOptions {
  const shared = selectSharedLlmEnv(env);

  // 추출기 타입(AzureRoleDeployments)에는 proofreading 슬롯이 없다 — 생성기 전용
  // 필드가 새지 않도록 필드 단위로 옮겨 담는다(리터럴 반환이라야 컴파일러의
  // excess-property 검사가 실제로 걸린다).
  return {
    provider: shared.provider,
    apiKey: shared.apiKey,
    model: shared.model,
    endpoint: shared.endpoint,
    deployment: shared.deployment,
    deployments: {
      ocr: shared.deployments.ocr,
      reasoning: shared.deployments.reasoning,
      embedding: shared.deployments.embedding,
    },
    apiVersion: shared.apiVersion,
  };
}
