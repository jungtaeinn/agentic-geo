import type { GeoQualityEvaluation } from "@agentic-geo/pdp-geo-eval-agent";
import type { PdpGeoContentSections } from "@agentic-geo/pdp-geo-generator-agent/types";

/** 케이스 YAML 한 파일이 표현하는 회귀 케이스. */
export interface RegressionCase {
  id: string;
  name?: string;
  tags: string[];
  skip?: boolean;
  timeoutMs?: number;
  /** agent-api 요청 본문 그대로 — `POST /internal/v1/geo/test-generations` 계약. */
  request: { locale: string; product: Record<string, unknown> };
  expect: CaseExpectations;
  /** 진단·리포트에서 원본을 되짚기 위한 파일 경로. */
  caseFile: string;
}

/** 전부 선택 항목이다 — 아무것도 없으면 결정적 루브릭 점수만 기록하고 통과시킨다. */
export interface CaseExpectations {
  resultStatus?: "SUCCEEDED" | "SUCCEEDED_WITH_WARNINGS";
  /** 산출 그래프에 반드시 존재해야 하는 schema.org 타입. */
  schemaTypes?: string[];
  /** 산출 그래프에 존재하면 안 되는 schema.org 타입. */
  forbiddenSchemaTypes?: string[];
  maxValidationWarnings?: number;
  /** 공개 텍스트(JSON-LD 문자열 값 전체)에 포함되어야 하는 문구. */
  contains?: string[];
  /** 공개 텍스트에 나오면 안 되는 문구. */
  notContains?: string[];
  jsonPath?: JsonPathExpectation[];
  /** 결정적 루브릭 점수 하한. 미지정 차원은 검사하지 않는다. */
  minScore?: Partial<Record<"overall" | "geo" | "cep" | "eeat", number>>;
  /** LLM 심사용 모범답변. 없으면 3층은 질문 없이 산출물 타당성만 본다. */
  goldenAnswer?: string;
}

export interface JsonPathExpectation {
  /** 점 표기 경로. 배열은 인덱스 또는 `[]`(전체 순회)로 지정한다. */
  path: string;
  equals?: unknown;
  contains?: string;
  exists?: boolean;
}

export type CaseStatus = "passed" | "warning" | "failed" | "error" | "skipped";

/** 계약 검증(1층) 위반 한 건. */
export interface ContractViolation {
  rule: string;
  detail: string;
}

/** LLM 심사(3층) 결과. data-highway `evaluator.py`의 1~10점 체계를 그대로 따른다. */
export interface JudgeResult {
  score: number;
  verdict: "pass" | "warning" | "fail";
  reasoning: string;
  coveredPoints: string[];
  missingPoints: string[];
  prompt: string;
}

/** 생성기가 자기 산출물에 대해 기록한 품질 게이트 진단. */
export interface QualityGateSnapshot {
  enabled: boolean;
  thresholds?: { geo: number; cep: number; eeat: number };
  initialScores?: { overall: number; geo: number; cep: number; eeat: number };
  correctedScores?: { overall: number; geo: number; cep: number; eeat: number };
  shortfalls: string[];
  attempted: boolean;
  adopted: boolean;
  reason?: string;
}

/** 한 실행에서 케이스 하나가 남기는 산출물. run 디렉터리에 JSON 한 개로 저장된다. */
export interface CaseResult {
  id: string;
  name?: string;
  tags: string[];
  caseFile: string;
  status: CaseStatus;
  failureMode: string;
  mode: "local" | "http";
  baseUrl?: string;
  geoGenerationId?: string;
  locale: string;
  product: Record<string, unknown>;
  durationMs?: number;
  resultStatus?: string;
  schemaTypes?: string[];
  resultHash?: string;
  ragProfile?: string;
  jsonLd?: unknown;
  contentSections?: PdpGeoContentSections;
  validationWarnings: string[];
  /** 리그레션이 재계산한 결정적 루브릭. */
  evaluation?: GeoQualityEvaluation;
  /** 사람이 읽는 루브릭 리포트 텍스트. */
  evaluationReport?: string;
  /** 실패 케이스를 고치기 위해 LLM에 그대로 붙여넣는 프롬프트. */
  improvementPrompt?: string;
  easyImprovements: string[];
  qualityGate?: QualityGateSnapshot;
  /** 재계산 점수와 생성기 기록 점수의 대조 결과. */
  scoreParity?: {
    matched: boolean;
    comparedAgainst: "initialScores" | "correctedScores";
    detail: string;
  };
  contractViolations: ContractViolation[];
  minScoreViolations: ContractViolation[];
  judge?: JudgeResult;
  judgeSkippedReason?: string;
  errorMessage?: string;
  langfuseSessionId?: string;
}

/** 실행 전체의 메타데이터. 리포트 헤더에 그대로 실린다. */
export interface RunMeta {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  mode: "local" | "http";
  env?: string;
  baseUrl?: string;
  provider: string;
  /** 생성 파이프라인 단계별 on/off — 콘솔과 점수가 다른 이유를 이 줄에서 읽을 수 있다. */
  pipeline: {
    productNormalization: boolean;
    finalProofreading: boolean;
    reasoningDeployment?: string;
    embeddingDeployment?: string;
  };
  llmJudge: boolean;
  citationProbe: boolean;
  caseFilter?: string;
}
