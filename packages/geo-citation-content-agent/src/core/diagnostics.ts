import type {
  GeoCitationGenerationStageId,
  GeoCitationGenerationStep
} from "../types";

const pipelineSteps: Array<Pick<GeoCitationGenerationStep, "id" | "title" | "description">> = [
  { id: "input", title: "입력 검증", description: "상품, target surface, 전략 옵션을 검증" },
  { id: "normalize", title: "상품 신호 정규화", description: "상품 정보를 citation content용 signal로 정리" },
  { id: "mandatory-rag-load", title: "Mandatory RAG 로드", description: "공통 citation contract, EEAT, CEP, claim safety 로드" },
  { id: "surface-rag-load", title: "Surface RAG 로드", description: "Reddit surface guideline과 post pattern 로드" },
  { id: "evidence-normalize", title: "Evidence 정규화", description: "리뷰, 이미지, 뉴스, 논문, 기존 GEO 결과를 근거로 정리" },
  { id: "chunk", title: "Evidence chunk 구성", description: "근거를 검색 가능한 chunk로 분할" },
  { id: "retrieve", title: "Evidence RAG 검색", description: "상품/전략 query와 관련 있는 근거 선택" },
  { id: "rerank", title: "Evidence 리랭킹", description: "근거 유형, fresh signal, lexical overlap으로 정렬" },
  { id: "brief", title: "Content brief 생성", description: "AI answer chunk와 Reddit 토론 흐름의 중간 산출물 생성" },
  { id: "generate", title: "Reddit artifact 생성", description: "GenAI writer 또는 mock writer로 제목과 본문 생성" },
  { id: "validate", title: "Claim/channel 검증", description: "unsupported claim, 홍보 톤, Reddit channel risk 검사" },
  { id: "repair", title: "방어 보정", description: "CTA와 과장 표현을 안전하게 보정" },
  { id: "artifact", title: "최종 artifact 생성", description: "게시물과 diagnostics를 최종 반환" }
];

export function createGeoCitationPipelineTracker(onProgress?: (step: GeoCitationGenerationStep) => void) {
  const steps: GeoCitationGenerationStep[] = pipelineSteps.map((step) => ({
    ...step,
    status: "pending" as const
  }));

  function update(id: GeoCitationGenerationStageId, status: GeoCitationGenerationStep["status"], message?: string) {
    const step = steps.find((item) => item.id === id);
    if (!step) {
      return;
    }

    const timestamp = new Date().toISOString();
    step.status = status;
    step.message = message;
    if (status === "running") {
      step.startedAt = step.startedAt ?? timestamp;
    }
    if (status === "done" || status === "error") {
      step.completedAt = timestamp;
    }
    onProgress?.({ ...step });
  }

  return {
    steps,
    start(id: GeoCitationGenerationStageId, message?: string) {
      update(id, "running", message);
    },
    done(id: GeoCitationGenerationStageId, message?: string) {
      update(id, "done", message);
    },
    error(id: GeoCitationGenerationStageId, message?: string) {
      update(id, "error", message);
    }
  };
}
