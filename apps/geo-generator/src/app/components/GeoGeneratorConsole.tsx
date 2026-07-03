"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Circle,
  Copy,
  Database,
  ExternalLink,
  FileCode2,
  FileText,
  Globe2,
  KeyRound,
  LayoutGrid,
  Loader2,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  PlugZap,
  Plus,
  Search,
  Send,
  Settings,
  MessageSquarePlus,
  Trash2,
  X
} from "lucide-react";
import Image from "next/image";
import type { ChangeEvent, DragEvent } from "react";
import type {
  GeoCitationDiagnostics,
  GeoCitationGenerationResult,
  GeoCitationGenerationStageId,
  GeoCitationGenerationStep
} from "@agentic-geo/geo-citation-content-agent/types";
import type { ProductExtractionDiagnostics, ProductExtractionResult, ProductExtractionStep } from "@agentic-geo/pdp-extractor-agent/types";
import type {
  PdpGeoDiagnostics,
  PdpGeoGenerationResult,
  PdpGeoGenerationStageId,
  PdpGeoGenerationStep,
  PdpGeoLocale,
  PdpGeoOcrSentenceDiagnostic,
  PdpGeoRagMode
} from "@agentic-geo/pdp-geo-generator-agent/types";
import { useEffect, useMemo, useRef, useState } from "react";

type SourceMode = "auto" | "url" | "restApi" | "manual-json";
type RunStatus = "idle" | "running" | "done" | "error";
type OutputView = "schema" | "content" | "diagnostics";
type MagazineOutputView = "reddit" | "readiness" | "diagnostics";
type SettingsTab = "run" | "ai" | "rag";
type UiLanguage = "ko" | "en";
type ProviderId = "mock" | "openai" | "gemini" | "azure-openai" | "aistudio";
type ConnectionStatus = "idle" | "checking" | "connected" | "error";
type ModelLoadStatus = "idle" | "loading" | "ready" | "error";
type RagProfileTarget = "extractor" | "generator";
type WorkspaceMode = "extractor" | "generator" | "magazine";
type ExtractorOutputView = "result" | "logs";
type ModalCopyTarget = "panel-detail" | "rag-reference";
type ArtifactCopySurface = "generator-floating" | "generator-panel" | "extractor-floating" | "extractor-panel" | "magazine-floating" | "magazine-panel";
type RunSettingsFeedback = "saved" | "reset" | null;
type AiSettingsFeedback = "tested" | "saved" | "reset" | null;
type AiSettingsAction = "test" | "save" | null;
type RagSettingsFeedback = "saved" | "reset" | null;
type RagSettingsAction = "save" | "reset" | null;

interface PanelRagReference {
  id: string;
  title: string;
  source: string;
  kind: string;
  text: string;
  score?: number;
  principle?: string;
  usage?: string;
  intents?: string[];
  fieldTargets?: string[];
  metadata?: Record<string, string | number | boolean>;
}

interface PanelDetail {
  label: string;
  title: string;
  subtitle?: string;
  text: string;
  metadata?: Record<string, string | number | boolean>;
}

type GeoQualityDimensionId = "geo" | "cep" | "eeat";
type MagazineQualityDimensionId = "citation" | "reddit" | "evidence";

interface GeoQualityDimension {
  id: GeoQualityDimensionId;
  label: string;
  score: number;
  criteria: string;
  summary: string;
  evidence: string[];
  improvements: string[];
}

interface GeoQualityEvaluation {
  overallScore: number;
  dimensions: GeoQualityDimension[];
  validationDetails: string[];
  validationImprovements: string[];
}

interface MagazineQualityDimension {
  id: MagazineQualityDimensionId;
  label: string;
  score: number;
  criteria: string;
  summary: string;
  evidence: string[];
  improvements: string[];
}

interface MagazineQualityEvaluation {
  overallScore: number;
  dimensions: MagazineQualityDimension[];
  validationDetails: string[];
  validationImprovements: string[];
}

interface GeoGeneratorResult {
  id: string;
  source: string;
  sourceType: "url" | "restApi" | "manual-json";
  extractor?: ProductExtractionResult;
  generator: PdpGeoGenerationResult;
  runDurationMs?: number;
}

type TimedProductExtractionResult = ProductExtractionResult & {
  runDurationMs?: number;
};

interface GeoGeneratorLog {
  source: string;
  extractor?: ProductExtractionDiagnostics;
  generator: PdpGeoDiagnostics;
  generatorProcess: PdpGeoGenerationStep[];
}

interface MagazineGeneratorResult {
  id: string;
  source: string;
  sourceType: "url" | "restApi" | "manual-json";
  extractor?: ProductExtractionResult;
  magazine: GeoCitationGenerationResult;
  runDurationMs?: number;
}

interface MagazineGeneratorLog {
  source: string;
  extractor?: ProductExtractionDiagnostics;
  magazine: GeoCitationDiagnostics;
  magazineProcess: GeoCitationGenerationStep[];
}

interface GeoGeneratorResponse {
  results: GeoGeneratorResult[];
  logs: GeoGeneratorLog[];
  failures: Array<{
    source: string;
    sourceType: SourceMode;
    error: string;
  }>;
  error?: string;
}

type GeoGeneratorStreamEvent =
  | {
    type: "progress";
    group: "extractor" | "generator";
    source: string;
    sourceType: "url" | "restApi" | "manual-json";
    sourceIndex: number;
    sourceCount: number;
    step: ProductExtractionStep | PdpGeoGenerationStep;
  }
  | { type: "result"; payload: GeoGeneratorResponse }
  | { type: "error"; error: string };

interface MagazineGeneratorResponse {
  results: MagazineGeneratorResult[];
  logs: MagazineGeneratorLog[];
  failures: Array<{
    source: string;
    sourceType: SourceMode;
    error: string;
  }>;
  error?: string;
}

type MagazineGeneratorStreamEvent =
  | {
    type: "progress";
    group: "extractor" | "magazine";
    source: string;
    sourceType: "url" | "restApi" | "manual-json";
    sourceIndex: number;
    sourceCount: number;
    step: ProductExtractionStep | GeoCitationGenerationStep;
  }
  | { type: "result"; payload: MagazineGeneratorResponse }
  | { type: "error"; error: string };

interface ProductExtractorResponse {
  results: TimedProductExtractionResult[];
  logs: ProductExtractionDiagnostics[];
  failures: Array<{
    source: string;
    sourceType: "url" | "restApi";
    error: string;
  }>;
  error?: string;
}

interface ChatMessage {
  id: string;
  role: "agent" | "user" | "tool";
  body: string;
  command?: string;
  results?: GeoGeneratorResult[] | MagazineGeneratorResult[];
}

interface ComposerAttachment {
  id: string;
  name: string;
  size: number;
  kind: "json" | "sources";
  content: string;
  productCount: number;
  sourceCount: number;
}

interface NormalizedComposerInput {
  displayValue: string;
  products: unknown[];
  sources: string[];
  sourceType: "url" | "restApi";
}

interface ProviderSettings {
  provider: ProviderId;
  openaiApiKey: string;
  openaiModel: string;
  geminiApiKey: string;
  geminiModel: string;
  azureApiKey: string;
  azureEndpoint: string;
  azureDeployment: string;
  azureOcrDeployment: string;
  azureReasoningDeployment: string;
  azureEmbeddingDeployment: string;
  azureApiVersion: string;
  azureRerankerProvider: "cohere" | "azure-ai-search-semantic";
  azureCohereRerankApiKey: string;
  azureCohereRerankEndpoint: string;
  azureCohereRerankModel: string;
  azureAiSearchApiKey: string;
  azureAiSearchEndpoint: string;
  azureAiSearchIndexName: string;
  azureAiSearchSemanticConfiguration: string;
  aistudioEndpoint: string;
  aistudioApiKey: string;
  aistudioModel: string;
  aistudioEmbeddingModel: string;
  aistudioRerankModel: string;
  aistudioApiVersion: string;
}

interface RuntimeLlmConfig {
  provider: ProviderId;
  apiKey?: string;
  model?: string;
  endpoint?: string;
  deployment?: string;
  deployments?: {
    ocr?: string;
    reasoning?: string;
    embedding?: string;
  };
  apiVersion?: string;
  embedding?: {
    provider?: "local" | "azure-openai" | "aistudio";
    apiKey?: string;
    endpoint?: string;
    deployment?: string;
    apiVersion?: string;
    model?: string;
  };
  reranker?: {
    provider?: "local-hybrid" | "cohere" | "azure-ai-search-semantic" | "aistudio-bedrock-cohere";
    apiKey?: string;
    endpoint?: string;
    model?: string;
    indexName?: string;
    semanticConfiguration?: string;
    queryLanguage?: string;
  };
}

interface RagAttachment {
  id: string;
  name: string;
  version: string;
  size: number;
  type: string;
  content: string;
  enabled?: boolean;
  managed?: boolean;
  path?: string;
  addedAt: string;
}

interface RagProfileSettings {
  profile?: string;
  analysisPrompt: string;
  files: RagAttachment[];
}

type RagProfiles = Record<RagProfileTarget, RagProfileSettings>;

interface RuntimeRagProfile {
  analysisPrompt?: string;
  documents?: Array<{
    name: string;
    content: string;
    version?: string;
  }>;
}

type ProcessStep = {
  id: string | PdpGeoGenerationStageId | GeoCitationGenerationStageId;
  title: string;
  description: string;
  status: "pending" | "running" | "done" | "error";
  message?: string;
};

interface GeoPipelineProcessState {
  status: RunStatus;
  currentGroup: "extractor" | "generator" | "magazine";
  currentStepId: string | PdpGeoGenerationStageId | GeoCitationGenerationStageId;
  sourceCount: number;
  completedSourceCount: number;
  activeSource?: string;
  skipExtractor?: boolean;
  errorMessage?: string;
  extractorSteps?: ProductExtractionStep[];
  generatorSteps?: PdpGeoGenerationStep[];
  magazineSteps?: GeoCitationGenerationStep[];
}

const ragModeLabels: Record<PdpGeoRagMode, string> = {
  "local-versioned-rag": "Local RAG",
  "managed-vector-store-rag": "Vector Store"
};

const SETTINGS_STORAGE_KEY = "agentic-geo.geo-generator.provider-settings.v2";
const LEGACY_SETTINGS_STORAGE_KEYS = ["agentic-geo.geo-generator.provider-settings.v1"];
const RUN_SETTINGS_STORAGE_KEY = "agentic-geo.geo-generator.run-settings.v1";
const RAG_SETTINGS_STORAGE_KEY = "agentic-geo.geo-generator.rag-profile-settings.v1";
const HISTORY_STORAGE_KEY = "agentic-geo.geo-generator.history.v1";
const EXTRACTOR_HISTORY_STORAGE_KEY = "agentic-geo.geo-generator.extractor-history.v1";
const MAGAZINE_HISTORY_STORAGE_KEY = "agentic-geo.geo-generator.magazine-history.v1";
const HISTORY_LIMIT = 30;

const defaultProviderSettings: ProviderSettings = {
  provider: "mock",
  openaiApiKey: "",
  openaiModel: "",
  geminiApiKey: "",
  geminiModel: "",
  azureApiKey: "",
  azureEndpoint: "",
  azureDeployment: "",
  azureOcrDeployment: "gpt-5.5",
  azureReasoningDeployment: "gpt-5.5",
  azureEmbeddingDeployment: "text-embedding-3-small",
  azureApiVersion: "2025-04-01-preview",
  azureRerankerProvider: "cohere",
  azureCohereRerankApiKey: "",
  azureCohereRerankEndpoint: "",
  azureCohereRerankModel: "",
  azureAiSearchApiKey: "",
  azureAiSearchEndpoint: "",
  azureAiSearchIndexName: "",
  azureAiSearchSemanticConfiguration: "default",
  aistudioEndpoint: "",
  aistudioApiKey: "",
  aistudioModel: "gpt-5.5",
  aistudioEmbeddingModel: "text-embedding-3-large",
  aistudioRerankModel: "cohere.rerank-v3-5:0",
  aistudioApiVersion: ""
};

const defaultRagProfileSettings: RagProfileSettings = {
  analysisPrompt: "",
  files: []
};

const defaultRagProfiles: RagProfiles = {
  extractor: defaultRagProfileSettings,
  generator: defaultRagProfileSettings
};

const uiCopy = {
  ko: {
    runStatus: {
      idle: "대기",
      running: "실행 중",
      done: (count: number) => `${count}개 완료`,
      error: "오류"
    },
    localeLabels: {
      "ko-KR": "한국",
      "ja-JP": "일본",
      "en-US": "미국",
      "en-GB": "영국"
    } satisfies Record<PdpGeoLocale, string>,
    sourceMode: {
      auto: { label: "Auto", description: "자동" },
      url: { label: "URL", description: "PDP" },
      restApi: { label: "REST", description: "API" },
      "manual-json": { label: "JSON", description: "직접 입력" }
    } satisfies Record<SourceMode, { label: string; description: string }>,
    sidebar: {
      toggle: "사이드바 토글",
      newChat: "새 채팅",
      search: "검색",
      searchPlaceholder: "히스토리 검색",
      history: "히스토리",
      emptyHistory: "아직 생성 히스토리가 없습니다",
      noSearchResults: "검색 결과가 없습니다",
      settings: "Settings"
    },
    modes: {
      label: "Mode",
      extractor: {
        label: "Extractor",
        description: "상품 RAW JSON 추출",
        newChat: "새 추출",
        history: "Extractor 히스토리",
        emptyHistory: "아직 추출 히스토리가 없습니다",
        searchPlaceholder: "추출 히스토리 검색"
      },
      generator: {
        label: "Schema Generator",
        description: "GEO schema/content 생성",
        newChat: "새 생성",
        history: "Schema Generator 히스토리",
        emptyHistory: "아직 생성 히스토리가 없습니다",
        searchPlaceholder: "생성 히스토리 검색"
      },
      magazine: {
        label: "Magazine Generator",
        description: "GEO magazine/content 생성",
        newChat: "새 매거진 생성",
        history: "Magazine Generator 히스토리",
        emptyHistory: "아직 매거진 생성 히스토리가 없습니다",
        searchPlaceholder: "매거진 히스토리 검색"
      }
    },
    header: {
      title: "agentic-geo PDP GEO 생성",
      viewOptions: "보기 옵션",
      gridToggle: "결과 폭 토글",
      leftPanelToggle: "왼쪽 패널 토글",
      rightPanelToggle: "오른쪽 패널 토글",
      language: "언어"
    },
    welcome: {
      title: "GEO 아티팩트를 생성할 PDP를 입력하세요",
      cards: [
        ["URL 입력", "상품 상세 페이지"],
        ["REST API", "상품 데이터 응답"],
        ["JSON 결과", "복사 가능한 출력"]
      ] as const
    },
    messages: {
      start: "상품 원천 정보를 정규화한 뒤 GEO schema/content 생성을 시작합니다.",
      partial: (results: number, failures: number) => `${results}개 결과와 ${failures}개 실패가 반환되었습니다.`,
      done: (results: number) => `${results}개 GEO 아티팩트가 생성되었습니다.`,
      runningTitle: "GEO pipeline 실행 중",
      runningBody: "Extractor 단계와 Generator 단계를 순서대로 처리하고 있습니다.",
      extractorStart: "pdp-extractor-agent로 상품 원천 정보를 추출합니다.",
      extractorPartial: (results: number, failures: number) => `${results}개 추출 결과와 ${failures}개 실패가 반환되었습니다.`,
      extractorDone: (results: number) => `${results}개 상품 RAW JSON 추출이 완료되었습니다.`,
      extractorRunningTitle: "Extractor 실행 중",
      extractorRunningBody: "상품 수집, OCR/리뷰 신호, RAG chunk 생성을 처리하고 있습니다.",
      extractorNoSource: "Extractor 모드는 상품 URL 또는 REST API 주소만 처리합니다.",
      magazineStart: "상품 원천 정보를 citation evidence로 정규화한 뒤 Reddit용 GEO magazine/content를 생성합니다.",
      magazinePartial: (results: number, failures: number) => `${results}개 Reddit 콘텐츠와 ${failures}개 실패가 반환되었습니다.`,
      magazineDone: (results: number) => `${results}개 Reddit magazine/content가 생성되었습니다.`,
      magazineRunningTitle: "Magazine pipeline 실행 중",
      magazineRunningBody: "Extractor 결과를 기반으로 GEO citation readiness와 Reddit 토론글을 생성하고 있습니다.",
      warning: "실행 경고"
    },
    panel: {
      progress: "진행 상황",
      nextResult: "다음 결과",
      extractor: "Extractor",
      generator: "Generator",
      magazine: "Magazine",
      output: "출력",
      analysisLog: "분석 로그",
      source: "출처",
      noSource: "입력된 URL 또는 REST API가 없습니다",
      ragReferences: "활용한 RAG",
      noRagReferences: "아직 활용한 RAG가 없습니다",
      ragModalTitle: "RAG 상세",
      closeRagModal: "RAG 상세 닫기",
      recommendations: "Recommendations",
      evidence: "Evidence",
      noRecommendations: "분석 대기",
      noEvidence: "근거 대기",
      noDiagnostics: "아직 분리된 분석 로그가 없습니다"
    },
    composer: {
      placeholder: "상품 URL이나 API 주소를 붙여넣고, JSON이 있다면 그대로 넣어주세요.",
      submit: "실행",
      attach: "파일 첨부",
      attachmentLabel: "첨부 파일",
      dropHint: "상품 URL/API 목록 또는 JSON 파일을 놓아주세요",
      filesAttached: (count: number) => `${count}개 파일이 첨부되어 있습니다.`,
      filesRejected: (count: number) => `${count}개 파일에서는 읽을 수 있는 URL/API 입력이나 상품 JSON을 찾지 못했어요.`,
      jsonSummary: (count: number) => `${count}개 상품 JSON`,
      sourceSummary: (count: number) => `${count}개 입력`,
      emptySummary: "입력 없음",
      removeAttachment: (name: string) => `${name} 첨부 제거`,
      invalidJson: "상품 JSON 형식이 올바르지 않습니다."
    },
    settings: {
      back: "앱으로 돌아가기",
      search: "설정 검색...",
      group: "GEO 생성",
      run: "입력 설정",
      ai: "AI 연동",
      rag: "RAG 프로필",
      close: "설정 닫기",
      runDescription: "입력 처리 방식, 지역/마켓, REST API 요청 헤더를 함께 관리합니다.",
      aiDescription: "OpenAI, Gemini, Azure API 키를 등록하고 연결 테스트 후 GEO 생성에 사용합니다.",
      ragDescription: "Extractor와 Generator가 참조하는 RAG 파일을 확인하고 편집합니다.",
      inputSection: "입력 처리 모드",
      localeSection: "Locale",
      headersSection: "REST API 요청 헤더",
      headersLabel: "Headers JSON",
      headersHelp: "REST API URL을 입력했을 때 함께 보낼 요청 헤더입니다.",
      ragModeSection: "RAG Mode",
      ragTargetSection: "RAG 프로필",
      ragPromptSection: "분석 프롬프트",
      ragFilesSection: "RAG 파일",
      ragContentSection: "RAG 파일 내용",
      aiProviderSection: "AI 선택",
      aiCredentialSection: "인증 정보",
      aiScopeSection: "적용 범위",
      loadModels: "목록 불러오기",
      loadingModels: "불러오는 중",
      testConnection: "연결 테스트",
      testingConnection: "테스트 중",
      saveAndApply: "저장 및 적용",
      checking: "확인 중",
      tested: "테스트 완료",
      saving: "저장 중",
      resetting: "초기화 중",
      saveRun: "저장",
      saved: "저장됨",
      saveRag: "저장",
      attachRag: "GEO/RAG 파일 첨부",
      edit: "편집",
      emptyRag: "첨부된 파일이 없습니다",
      emptyRagHelp: "Schema BestPractice, E-E-A-T, CEP, locale 용어집 같은 md/txt/json/csv 파일을 첨부할 수 있습니다.",
      reset: "초기화",
      resetDone: "초기화됨",
      apply: "적용"
    },
    artifact: {
      label: "GEO schema + content",
      copy: "복사",
      copyAria: "복사",
      skipped: "수동 JSON 입력으로 건너뜀"
    },
    time: {
      now: "방금",
      minutes: (value: number) => `${value}분`,
      hours: (value: number) => `${value}시간`,
      days: (value: number) => `${value}일`
    }
  },
  en: {
    runStatus: {
      idle: "Idle",
      running: "Running",
      done: (count: number) => `${count} complete`,
      error: "Error"
    },
    localeLabels: {
      "ko-KR": "Korea",
      "ja-JP": "Japan",
      "en-US": "United States",
      "en-GB": "United Kingdom"
    } satisfies Record<PdpGeoLocale, string>,
    sourceMode: {
      auto: { label: "Auto", description: "Detect" },
      url: { label: "URL", description: "PDP" },
      restApi: { label: "REST", description: "API" },
      "manual-json": { label: "JSON", description: "Manual input" }
    } satisfies Record<SourceMode, { label: string; description: string }>,
    sidebar: {
      toggle: "Toggle sidebar",
      newChat: "New chat",
      search: "Search",
      searchPlaceholder: "Search history",
      history: "History",
      emptyHistory: "No generation history yet",
      noSearchResults: "No results",
      settings: "Settings"
    },
    modes: {
      label: "Mode",
      extractor: {
        label: "Extractor",
        description: "Extract product RAW JSON",
        newChat: "New extraction",
        history: "Extractor history",
        emptyHistory: "No extraction history yet",
        searchPlaceholder: "Search extraction history"
      },
      generator: {
        label: "Schema Generator",
        description: "Generate GEO schema/content",
        newChat: "New generation",
        history: "Schema Generator history",
        emptyHistory: "No generation history yet",
        searchPlaceholder: "Search generation history"
      },
      magazine: {
        label: "Magazine Generator",
        description: "Generate GEO magazine/content",
        newChat: "New magazine",
        history: "Magazine Generator history",
        emptyHistory: "No magazine history yet",
        searchPlaceholder: "Search magazine history"
      }
    },
    header: {
      title: "agentic-geo PDP GEO Generator",
      viewOptions: "View options",
      gridToggle: "Toggle result width",
      leftPanelToggle: "Toggle left panel",
      rightPanelToggle: "Toggle right panel",
      language: "Language"
    },
    welcome: {
      title: "Enter a PDP to generate GEO artifacts",
      cards: [
        ["URL input", "Product detail page"],
        ["REST API", "Product data response"],
        ["JSON result", "Copy-ready output"]
      ] as const
    },
    messages: {
      start: "Normalizing product source data, then generating GEO schema/content.",
      partial: (results: number, failures: number) => `${results} results and ${failures} failures returned.`,
      done: (results: number) => `${results} GEO artifacts generated.`,
      runningTitle: "GEO pipeline running",
      runningBody: "Running Extractor and Generator stages in sequence.",
      extractorStart: "Running product source extraction with pdp-extractor-agent.",
      extractorPartial: (results: number, failures: number) => `${results} extraction results and ${failures} failures returned.`,
      extractorDone: (results: number) => `${results} product RAW JSON extraction${results === 1 ? "" : "s"} complete.`,
      extractorRunningTitle: "Extractor running",
      extractorRunningBody: "Collecting product source, OCR/review signals, and RAG chunks.",
      extractorNoSource: "Extractor mode only accepts product URLs or REST API endpoints.",
      magazineStart: "Normalizing product source data into citation evidence, then generating Reddit GEO magazine/content.",
      magazinePartial: (results: number, failures: number) => `${results} Reddit content result${results === 1 ? "" : "s"} and ${failures} failure${failures === 1 ? "" : "s"} returned.`,
      magazineDone: (results: number) => `${results} Reddit magazine/content artifact${results === 1 ? "" : "s"} generated.`,
      magazineRunningTitle: "Magazine pipeline running",
      magazineRunningBody: "Using Extractor output to create GEO citation readiness and a Reddit discussion post.",
      warning: "Run warning"
    },
    panel: {
      progress: "Progress",
      nextResult: "Next result",
      extractor: "Extractor",
      generator: "Generator",
      magazine: "Magazine",
      output: "Output",
      analysisLog: "Analysis log",
      source: "Sources",
      noSource: "No URL or REST API input yet",
      ragReferences: "Used RAG",
      noRagReferences: "No used RAG yet",
      ragModalTitle: "RAG detail",
      closeRagModal: "Close RAG detail",
      recommendations: "Recommendations",
      evidence: "Evidence",
      noRecommendations: "Waiting for analysis",
      noEvidence: "Waiting for evidence",
      noDiagnostics: "No diagnostic log yet"
    },
    composer: {
      placeholder: "Paste a product URL, API endpoint, or product JSON and I’ll prepare the GEO artifacts.",
      submit: "Run",
      attach: "Attach file",
      attachmentLabel: "Attached files",
      dropHint: "Drop a URL/API list or product JSON file",
      filesAttached: (count: number) => `${count} file${count === 1 ? "" : "s"} attached.`,
      filesRejected: (count: number) => `I couldn't find a readable URL/API input or product JSON in ${count} file${count === 1 ? "" : "s"}.`,
      jsonSummary: (count: number) => `${count} product JSON`,
      sourceSummary: (count: number) => `${count} input${count === 1 ? "" : "s"}`,
      emptySummary: "No input found",
      removeAttachment: (name: string) => `Remove ${name}`,
      invalidJson: "The product JSON is not valid."
    },
    settings: {
      back: "Back to app",
      search: "Search settings...",
      group: "GEO generation",
      run: "Input",
      ai: "AI",
      rag: "RAG profile",
      close: "Close settings",
      runDescription: "Manage input handling, locale/market, and REST API request headers together.",
      aiDescription: "Connect OpenAI, Gemini, or Azure API settings and use the tested settings for GEO generation.",
      ragDescription: "Review and edit the RAG files used by the Extractor and Generator agents.",
      inputSection: "Input handling mode",
      localeSection: "Locale",
      headersSection: "REST API request headers",
      headersLabel: "Headers JSON",
      headersHelp: "Headers sent when the input is a REST API URL.",
      ragModeSection: "RAG Mode",
      ragTargetSection: "RAG profiles",
      ragPromptSection: "Analysis prompt",
      ragFilesSection: "RAG files",
      ragContentSection: "RAG file content",
      aiProviderSection: "AI provider",
      aiCredentialSection: "Credentials",
      aiScopeSection: "Scope",
      loadModels: "Load models",
      loadingModels: "Loading",
      testConnection: "Test connection",
      testingConnection: "Testing",
      saveAndApply: "Save and apply",
      checking: "Checking",
      tested: "Tested",
      saving: "Saving",
      resetting: "Resetting",
      saveRun: "Save",
      saved: "Saved",
      saveRag: "Save",
      attachRag: "Attach GEO/RAG file",
      edit: "Edit",
      emptyRag: "No files attached",
      emptyRagHelp: "Attach md/txt/json/csv files such as Schema BestPractice, E-E-A-T, CEP, or locale terminology guides.",
      reset: "Reset",
      resetDone: "Reset",
      apply: "Apply"
    },
    artifact: {
      label: "GEO schema + content",
      copy: "Copy",
      copyAria: "Copy",
      skipped: "Skipped for manual JSON input"
    },
    time: {
      now: "Now",
      minutes: (value: number) => `${value}m`,
      hours: (value: number) => `${value}h`,
      days: (value: number) => `${value}d`
    }
  }
} as const;

const extractorStepCopy = {
  ko: [
    ["input", "입력 정규화", "URL/REST API 주소를 검증하고 실행 단위로 분리"],
    ["fetch", "소스 수집", "페이지 HTML, 메타정보, JSON-LD, API 응답 수집"],
    ["extract", "상품정보 추출", "상품명, 가격, 설명, 옵션, FAQ 후보 정규화"],
    ["ocr", "OCR 키워드 분류", "이미지/상세 영역의 효능, 효과, 성분 키워드 분류"],
    ["review", "리뷰 신호 추출", "평점, 리뷰본문, 대표 키워드, 고객 표현 정리"],
    ["rag", "RAG chunk 생성", "상품/리뷰/FAQ/OCR evidence를 RAG 데이터로 구성"],
    ["json", "JSON 결과 생성", "복사 가능한 상품 RAW JSON 생성"]
  ],
  en: [
    ["input", "Normalize input", "Validate URL/REST API sources and split run units"],
    ["fetch", "Collect source", "Collect page HTML, metadata, JSON-LD, and API responses"],
    ["extract", "Extract product data", "Normalize name, price, description, options, and FAQ candidates"],
    ["ocr", "Classify OCR keywords", "Classify benefit, effect, and ingredient keywords from images/detail areas"],
    ["review", "Extract review signals", "Summarize ratings, review text, keywords, and customer phrases"],
    ["rag", "Create RAG chunks", "Build RAG data from product, review, FAQ, and OCR evidence"],
    ["json", "Generate JSON result", "Create copy-ready product RAW JSON"]
  ]
} as const;

const generatorStepCopy = {
  ko: {
    input: ["입력 검증", "임의 상품 JSON과 옵션을 검증"],
    normalize: ["상품 신호 정규화", "REST/API/PDP JSON을 내부 ProductSignal로 변환"],
    "rag-load": ["RAG 프로필 로드", "schema.org, E-E-A-T, CEP, GEO, BestPractice, locale 용어집 로드"],
    chunk: ["RAG chunk 구성", "버전 문서와 상품 컨텍스트를 검색 가능한 chunk로 준비"],
    embed: ["임베딩 구성", "로컬 또는 managed vector store 임베딩 전략 적용"],
    retrieve: ["RAG 검색", "상품/locale/schema 목표에 맞는 관련 문서 검색"],
    rerank: ["리랭킹", "schema, locale, terminology, GEO 관련성을 기준으로 재정렬"],
    generate: ["GEO 산출물 생성", "JSON-LD schema markup과 HTML content 생성"],
    validate: ["문법 검증", "JSON-LD와 HTML 구조 검증"],
    repair: ["방어 보정", "누락된 필수 필드와 안전하지 않은 HTML 보정"],
    artifact: ["최종 아티팩트 생성", "복사 가능한 schemaMarkup과 content 결과 생성"]
  },
  en: {
    input: ["Validate input", "Validate arbitrary product JSON and generation options"],
    normalize: ["Normalize product signals", "Convert REST/API/PDP JSON into internal ProductSignal"],
    "rag-load": ["Load RAG profile", "Load schema.org, E-E-A-T, CEP, GEO, BestPractice, and locale terminology"],
    chunk: ["Build RAG chunks", "Prepare versioned documents and product context for retrieval"],
    embed: ["Build embeddings", "Apply local or managed vector store embedding strategy"],
    retrieve: ["Retrieve RAG", "Search relevant guidance for product, locale, and schema targets"],
    rerank: ["Rerank", "Sort by schema, locale, terminology, and GEO relevance"],
    generate: ["Generate GEO artifacts", "Create JSON-LD schema markup and HTML content"],
    validate: ["Validate syntax", "Validate JSON-LD and HTML structure"],
    repair: ["Repair defensively", "Repair missing required fields and unsafe HTML"],
    artifact: ["Create final artifact", "Create copy-ready schemaMarkup and content output"]
  }
} satisfies Record<UiLanguage, Record<PdpGeoGenerationStageId, readonly [string, string]>>;

const magazineStepCopy = {
  ko: {
    input: ["입력 검증", "상품 JSON과 Reddit target surface를 검증"],
    normalize: ["상품 신호 정규화", "상품정보를 citation content signal로 변환"],
    "mandatory-rag-load": ["Mandatory RAG 로드", "GEO, E-E-A-T, CEP, claim safety 문서를 로드"],
    "surface-rag-load": ["Reddit RAG 로드", "Reddit guideline과 post pattern 문서를 로드"],
    "evidence-normalize": ["Evidence 정규화", "상품/리뷰/이미지/뉴스/논문/기존 GEO 결과를 evidence로 분리"],
    chunk: ["Evidence chunk 구성", "claim grounding에 쓸 evidence chunk를 준비"],
    retrieve: ["Evidence RAG 검색", "검색 의도와 상품 맥락에 맞는 chunk를 선택"],
    rerank: ["Evidence 리랭킹", "source type, freshness, lexical overlap 기준으로 재정렬"],
    brief: ["Content brief 생성", "AI answer chunk와 Reddit 토론 흐름을 함께 구성"],
    generate: ["Reddit 콘텐츠 생성", "title과 bodyMarkdown 초안을 생성"],
    validate: ["Claim/channel 검증", "unsupported claim, 홍보 톤, Reddit channel risk를 점검"],
    repair: ["방어 보정", "검증 결과를 바탕으로 안전한 문장으로 보정"],
    artifact: ["최종 artifact 생성", "Reddit 업로드용 title/bodyMarkdown과 diagnostics 생성"]
  },
  en: {
    input: ["Validate input", "Validate product JSON and the Reddit target surface"],
    normalize: ["Normalize product signals", "Convert product data into citation content signals"],
    "mandatory-rag-load": ["Load mandatory RAG", "Load GEO, E-E-A-T, CEP, and claim-safety documents"],
    "surface-rag-load": ["Load Reddit RAG", "Load Reddit guideline and post-pattern documents"],
    "evidence-normalize": ["Normalize evidence", "Separate product, review, image, news, paper, and existing GEO evidence"],
    chunk: ["Build evidence chunks", "Prepare evidence chunks for claim grounding"],
    retrieve: ["Retrieve evidence RAG", "Select chunks that match search intent and product context"],
    rerank: ["Rerank evidence", "Sort by source type, freshness, and lexical overlap"],
    brief: ["Create content brief", "Blend AI answer chunks with Reddit discussion flow"],
    generate: ["Generate Reddit content", "Create the title and bodyMarkdown draft"],
    validate: ["Validate claims/channel", "Check unsupported claims, promotional tone, and Reddit channel risk"],
    repair: ["Repair defensively", "Repair the artifact into safer public copy"],
    artifact: ["Create final artifact", "Create Reddit-ready title/bodyMarkdown and diagnostics"]
  }
} satisfies Record<UiLanguage, Record<GeoCitationGenerationStageId, readonly [string, string]>>;

const extractorStepIds = extractorStepCopy.ko.map(([id]) => id);
const generatorStepIds = Object.keys(generatorStepCopy.ko) as PdpGeoGenerationStageId[];
const magazineStepIds = Object.keys(magazineStepCopy.ko) as GeoCitationGenerationStageId[];

export function GeoGeneratorConsole() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ragFileInputRef = useRef<HTMLInputElement>(null);
  const runSettingsFeedbackTimerRef = useRef<number | null>(null);
  const aiSettingsFeedbackTimerRef = useRef<number | null>(null);
  const ragSettingsFeedbackTimerRef = useRef<number | null>(null);
  const [draft, setDraft] = useState("");
  const [uiLanguage, setUiLanguage] = useState<UiLanguage>("ko");
  const [activeMode, setActiveMode] = useState<WorkspaceMode>("generator");
  const [sourceMode, setSourceMode] = useState<SourceMode>("auto");
  const [locale, setLocale] = useState<PdpGeoLocale>("ko-KR");
  const [ragMode, setRagMode] = useState<PdpGeoRagMode>("local-versioned-rag");
  const [headersJson, setHeadersJson] = useState("{}");
  const [runSettingsFeedback, setRunSettingsFeedback] = useState<RunSettingsFeedback>(null);
  const [aiSettingsFeedback, setAiSettingsFeedback] = useState<AiSettingsFeedback>(null);
  const [aiSettingsAction, setAiSettingsAction] = useState<AiSettingsAction>(null);
  const [ragSettingsFeedback, setRagSettingsFeedback] = useState<RagSettingsFeedback>(null);
  const [ragSettingsAction, setRagSettingsAction] = useState<RagSettingsAction>(null);
  const [providerSettings, setProviderSettings] = useState<ProviderSettings>(defaultProviderSettings);
  const [isProviderSettingsReady, setIsProviderSettingsReady] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("idle");
  const [connectionMessage, setConnectionMessage] = useState("");
  const [modelOptions, setModelOptions] = useState<Partial<Record<ProviderId, string[]>>>({});
  const [modelLoadStatus, setModelLoadStatus] = useState<ModelLoadStatus>("idle");
  const [modelMessage, setModelMessage] = useState("");
  const [ragProfiles, setRagProfiles] = useState<RagProfiles>(defaultRagProfiles);
  const [selectedRagTarget, setSelectedRagTarget] = useState<RagProfileTarget>("generator");
  const [selectedRagFileId, setSelectedRagFileId] = useState<string | null>(null);
  const [ragMessage, setRagMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [results, setResults] = useState<GeoGeneratorResult[]>([]);
  const [logs, setLogs] = useState<GeoGeneratorLog[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [extractorMessages, setExtractorMessages] = useState<ChatMessage[]>([]);
  const [extractorResults, setExtractorResults] = useState<TimedProductExtractionResult[]>([]);
  const [extractorLogs, setExtractorLogs] = useState<ProductExtractionDiagnostics[]>([]);
  const [selectedExtractorIndex, setSelectedExtractorIndex] = useState(0);
  const [magazineMessages, setMagazineMessages] = useState<ChatMessage[]>([]);
  const [magazineResults, setMagazineResults] = useState<MagazineGeneratorResult[]>([]);
  const [magazineLogs, setMagazineLogs] = useState<MagazineGeneratorLog[]>([]);
  const [selectedMagazineIndex, setSelectedMagazineIndex] = useState(0);
  const [isHistoryReady, setIsHistoryReady] = useState(false);
  const [runStatus, setRunStatus] = useState<RunStatus>("idle");
  const [extractorRunStatus, setExtractorRunStatus] = useState<RunStatus>("idle");
  const [magazineRunStatus, setMagazineRunStatus] = useState<RunStatus>("idle");
  const [pipelineProcess, setPipelineProcess] = useState<GeoPipelineProcessState>({
    status: "idle",
    currentGroup: "extractor",
    currentStepId: "input",
    sourceCount: 0,
    completedSourceCount: 0
  });
  const [extractorPipelineProcess, setExtractorPipelineProcess] = useState<GeoPipelineProcessState>({
    status: "idle",
    currentGroup: "extractor",
    currentStepId: "input",
    sourceCount: 0,
    completedSourceCount: 0
  });
  const [magazinePipelineProcess, setMagazinePipelineProcess] = useState<GeoPipelineProcessState>({
    status: "idle",
    currentGroup: "extractor",
    currentStepId: "input",
    sourceCount: 0,
    completedSourceCount: 0
  });
  const [errorMessage, setErrorMessage] = useState("");
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isStatusPanelOpen, setIsStatusPanelOpen] = useState(true);
  const [isArtifactGrid, setIsArtifactGrid] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("run");
  const [outputView, setOutputView] = useState<OutputView>("schema");
  const [extractorOutputView, setExtractorOutputView] = useState<ExtractorOutputView>("result");
  const [magazineOutputView, setMagazineOutputView] = useState<MagazineOutputView>("reddit");
  const [selectedRagReference, setSelectedRagReference] = useState<PanelRagReference | null>(null);
  const [selectedPanelDetail, setSelectedPanelDetail] = useState<PanelDetail | null>(null);
  const [copiedModalTarget, setCopiedModalTarget] = useState<ModalCopyTarget | null>(null);
  const [copiedArtifactTarget, setCopiedArtifactTarget] = useState<string | null>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  const [composerStatus, setComposerStatus] = useState("");
  const [composerAttachments, setComposerAttachments] = useState<ComposerAttachment[]>([]);
  const text = uiCopy[uiLanguage];
  const modalCopiedLabel = uiLanguage === "ko" ? "복사됨" : "Copied";
  const openPanelDetail = (detail: PanelDetail) => {
    setCopiedModalTarget(null);
    setSelectedPanelDetail(detail);
  };
  const copyModalText = async (value: string, target: ModalCopyTarget) => {
    await copyText(value);
    setCopiedModalTarget(target);
    window.setTimeout(() => {
      setCopiedModalTarget((current) => current === target ? null : current);
    }, 1600);
  };
  const copyArtifactText = async (value: string, target: string) => {
    await copyText(value);
    setCopiedArtifactTarget(target);
    window.setTimeout(() => {
      setCopiedArtifactTarget((current) => current === target ? null : current);
    }, 1600);
  };
  const closePanelDetail = () => {
    setCopiedModalTarget(null);
    setSelectedPanelDetail(null);
  };
  const closeRagReference = () => {
    setCopiedModalTarget(null);
    setSelectedRagReference(null);
  };

  const selectedResult = results[selectedIndex];
  const selectedLog = selectedResult ? logs.find((log) => log.source === selectedResult.source) : undefined;
  const selectedDiagnostics = selectedResult?.generator.diagnostics ?? selectedLog?.generator;
  const selectedExtractorResult = extractorResults[selectedExtractorIndex];
  const selectedExtractorLog = selectedExtractorResult ? extractorLogs.find((log) => log.source === selectedExtractorResult.source) : undefined;
  const selectedMagazineResult = magazineResults[selectedMagazineIndex];
  const selectedMagazineLog = selectedMagazineResult ? magazineLogs.find((log) => log.source === selectedMagazineResult.source) : undefined;
  const selectedMagazineDiagnostics = selectedMagazineResult?.magazine.diagnostics ?? selectedMagazineLog?.magazine;
  const activeGeneratorPipelineProcess = runStatus === "running" || (runStatus === "error" && !selectedResult) ? pipelineProcess : undefined;
  const activeExtractorPipelineProcess = extractorRunStatus === "running" || (extractorRunStatus === "error" && !selectedExtractorResult) ? extractorPipelineProcess : undefined;
  const activeMagazinePipelineProcess = magazineRunStatus === "running" || (magazineRunStatus === "error" && !selectedMagazineResult) ? magazinePipelineProcess : undefined;
  const activePipelineProcess = activeMode === "extractor"
    ? activeExtractorPipelineProcess
    : activeMode === "magazine"
      ? activeMagazinePipelineProcess
      : activeGeneratorPipelineProcess;
  const processProgressLabel = activePipelineProcess ? formatGeoProcessProgress(activePipelineProcess, uiLanguage) : "";
  const panelSources = activeMode === "extractor"
    ? selectedExtractorResult
      ? [selectedExtractorResult.source]
      : activePipelineProcess?.activeSource
        ? [activePipelineProcess.activeSource]
        : []
    : activeMode === "magazine"
      ? selectedMagazineResult
        ? [selectedMagazineResult.source]
        : activePipelineProcess?.activeSource
          ? [activePipelineProcess.activeSource]
          : []
    : selectedResult
      ? [selectedResult.source]
      : activePipelineProcess?.activeSource
        ? [activePipelineProcess.activeSource]
        : [];
  const generatorHasStarted = messages.length > 0 || runStatus !== "idle";
  const extractorHasStarted = extractorMessages.length > 0 || extractorRunStatus !== "idle";
  const magazineHasStarted = magazineMessages.length > 0 || magazineRunStatus !== "idle";
  const hasStarted = activeMode === "extractor" ? extractorHasStarted : activeMode === "magazine" ? magazineHasStarted : generatorHasStarted;
  const activeMessages = activeMode === "extractor" ? extractorMessages : activeMode === "magazine" ? magazineMessages : messages;
  const activeRunStatus = activeMode === "extractor" ? extractorRunStatus : activeMode === "magazine" ? magazineRunStatus : runStatus;
  const runElapsedLabel = useRunElapsedLabel(activeRunStatus === "running");
  const activeModeCopy = text.modes[activeMode];
  const schemaText = selectedResult ? JSON.stringify(selectedResult.generator.schemaMarkup.jsonLd, null, 2) : "";
  const diagnosticsText = selectedResult ? JSON.stringify({
    extractor: selectedLog?.extractor,
    generator: selectedResult.generator.diagnostics
  }, null, 2) : "";
  const extractorJsonText = selectedExtractorResult ? JSON.stringify(selectedExtractorResult, null, 2) : "";
  const extractorDiagnosticsText = selectedExtractorLog ? JSON.stringify(selectedExtractorLog, null, 2) : "";
  const magazinePostText = selectedMagazineResult ? `${selectedMagazineResult.magazine.artifact.title}\n\n${selectedMagazineResult.magazine.artifact.bodyMarkdown}` : "";
  const magazineReadinessText = selectedMagazineResult ? JSON.stringify(selectedMagazineResult.magazine.diagnostics.geoCitationReadiness, null, 2) : "";
  const magazineDiagnosticsText = selectedMagazineResult ? JSON.stringify({
    extractor: selectedMagazineLog?.extractor,
    magazine: selectedMagazineResult.magazine.diagnostics
  }, null, 2) : "";
  const generatorOutputText = outputView === "schema" ? schemaText : outputView === "content" ? selectedResult?.generator.content.html ?? "" : diagnosticsText;
  const extractorOutputText = extractorOutputView === "result" ? extractorJsonText : extractorDiagnosticsText;
  const magazineOutputText = magazineOutputView === "reddit" ? magazinePostText : magazineOutputView === "readiness" ? magazineReadinessText : magazineDiagnosticsText;
  const canSubmitComposer = activeMode === "extractor"
    ? draft.trim().length > 0 || composerAttachments.some((attachment) => attachment.sourceCount > 0)
    : draft.trim().length > 0 || composerAttachments.some((attachment) => attachment.productCount > 0 || attachment.sourceCount > 0);
  const activeProviderLabel = providerLabel(providerSettings.provider, uiLanguage);
  const activeModelOptions = modelOptions[providerSettings.provider] ?? [];
  const selectedRagProfile = ragProfiles[selectedRagTarget];
  const selectedRagFile = selectedRagProfile.files.find((file) => file.id === selectedRagFileId) ?? selectedRagProfile.files[0];
  const panelRagReferences = activeMode === "extractor"
    ? getExtractorPanelRagReferences(selectedExtractorResult)
    : activeMode === "magazine"
      ? getMagazinePanelRagReferences(selectedMagazineDiagnostics)
      : getGeneratorPanelRagReferences(selectedDiagnostics);
  const generatorFloatingCopyTarget = createArtifactCopyTarget("generator-floating", selectedResult?.id, outputView);
  const generatorPanelCopyTarget = createArtifactCopyTarget("generator-panel", selectedResult?.id, outputView);
  const extractorFloatingCopyTarget = createArtifactCopyTarget("extractor-floating", selectedExtractorResult?.source, extractorOutputView);
  const extractorPanelCopyTarget = createArtifactCopyTarget("extractor-panel", selectedExtractorResult?.source, extractorOutputView);
  const magazineFloatingCopyTarget = createArtifactCopyTarget("magazine-floating", selectedMagazineResult?.id, magazineOutputView);
  const magazinePanelCopyTarget = createArtifactCopyTarget("magazine-panel", selectedMagazineResult?.id, magazineOutputView);
  const isGeneratorFloatingCopied = copiedArtifactTarget === generatorFloatingCopyTarget;
  const isGeneratorPanelCopied = copiedArtifactTarget === generatorPanelCopyTarget;
  const isExtractorFloatingCopied = copiedArtifactTarget === extractorFloatingCopyTarget;
  const isExtractorPanelCopied = copiedArtifactTarget === extractorPanelCopyTarget;
  const isMagazineFloatingCopied = copiedArtifactTarget === magazineFloatingCopyTarget;
  const isMagazinePanelCopied = copiedArtifactTarget === magazinePanelCopyTarget;
  const extractorPanelSteps = activeGeneratorPipelineProcess
    ? activeGeneratorPipelineProcess.extractorSteps
    : selectedLog?.extractor?.process ?? (selectedResult?.extractor ? markProcessStepsDone(getExtractorSteps(uiLanguage)) : undefined);
  const generatorPanelSteps = activeGeneratorPipelineProcess
    ? activeGeneratorPipelineProcess.generatorSteps
    : selectedLog?.generatorProcess ?? (selectedResult ? markProcessStepsDone(getGeneratorSteps(uiLanguage)) : undefined);
  const extractorOnlyPanelSteps = activeExtractorPipelineProcess
    ? activeExtractorPipelineProcess.extractorSteps
    : selectedExtractorLog?.process ?? (selectedExtractorResult ? markProcessStepsDone(getExtractorSteps(uiLanguage)) : undefined);
  const magazineExtractorPanelSteps = activeMagazinePipelineProcess
    ? activeMagazinePipelineProcess.extractorSteps
    : selectedMagazineLog?.extractor?.process ?? (selectedMagazineResult?.extractor ? markProcessStepsDone(getExtractorSteps(uiLanguage)) : undefined);
  const magazinePanelSteps = activeMagazinePipelineProcess
    ? activeMagazinePipelineProcess.magazineSteps
    : selectedMagazineLog?.magazineProcess ?? (selectedMagazineResult ? markProcessStepsDone(getMagazineSteps(uiLanguage)) : undefined);
  const visibleGeneratorHistory = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return results
      .map((result, index) => ({ result, index }))
      .filter(({ result }) => {
        if (!query) {
          return true;
        }
        return [
          result.source,
          result.sourceType,
          result.generator.content.sections.productName
        ].join(" ").toLowerCase().includes(query);
      });
  }, [results, searchQuery]);
  const visibleExtractorHistory = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return extractorResults
      .map((result, index) => ({ result, index }))
      .filter(({ result }) => {
        if (!query) {
          return true;
        }
        return [
          result.source,
          result.sourceType,
          result.geoProduct.name
        ].join(" ").toLowerCase().includes(query);
      });
  }, [extractorResults, searchQuery]);
  const visibleMagazineHistory = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return magazineResults
      .map((result, index) => ({ result, index }))
      .filter(({ result }) => {
        if (!query) {
          return true;
        }
        return [
          result.source,
          result.sourceType,
          result.magazine.artifact.title,
          result.magazine.diagnostics.normalizedProduct.name
        ].join(" ").toLowerCase().includes(query);
      });
  }, [magazineResults, searchQuery]);
  const shellClassName = [
    "codexShell",
    isSidebarCollapsed ? "sidebarCollapsed" : "",
    isStatusPanelOpen ? "" : "statusPanelClosed",
    isArtifactGrid ? "artifactGridMode" : "",
    hasStarted ? "" : "chatWelcome"
  ].filter(Boolean).join(" ");

  const runSummary = useMemo(() => {
    const status = activeMode === "extractor" ? extractorRunStatus : activeMode === "magazine" ? magazineRunStatus : runStatus;
    const count = activeMode === "extractor" ? extractorResults.length : activeMode === "magazine" ? magazineResults.length : results.length;

    if (status === "running") {
      return text.runStatus.running;
    }
    if (status === "done") {
      return text.runStatus.done(count);
    }
    if (status === "error") {
      return text.runStatus.error;
    }
    return text.runStatus.idle;
  }, [activeMode, extractorResults.length, extractorRunStatus, magazineResults.length, magazineRunStatus, results.length, runStatus, text]);

  const settingsTitle = settingsTab === "run" ? text.settings.run : settingsTab === "ai" ? text.settings.ai : text.settings.rag;
  const settingsDescription = settingsTab === "run"
    ? text.settings.runDescription
    : settingsTab === "ai"
      ? text.settings.aiDescription
      : text.settings.ragDescription;
  const welcomeCards = workspaceWelcomeCards(activeMode, uiLanguage);

  useEffect(() => {
    const stored = window.localStorage.getItem("agentic-geo-ui-language");
    if (stored === "ko" || stored === "en") {
      setUiLanguage(stored);
    }

    const storedProviderSettings = readStoredProviderSettings();
    const storedRunSettings = readStoredRunSettings();
    const storedRagProfiles = readStoredRagProfiles();
    const storedHistory = readStoredGeoHistory();
    const storedExtractorHistory = readStoredExtractorHistory();
    const storedMagazineHistory = readStoredMagazineHistory();

    setProviderSettings(storedProviderSettings);
    setSourceMode(storedRunSettings.sourceMode);
    setLocale(storedRunSettings.locale);
    setHeadersJson(storedRunSettings.headersJson);
    setRagProfiles(storedRagProfiles);
    setResults(storedHistory.results);
    setLogs(storedHistory.logs);
    setSelectedIndex(storedHistory.results.length > 0 ? 0 : -1);
    setRunStatus(storedHistory.results.length > 0 ? "done" : "idle");
    setExtractorResults(storedExtractorHistory.results);
    setExtractorLogs(storedExtractorHistory.logs);
    setSelectedExtractorIndex(storedExtractorHistory.results.length > 0 ? 0 : -1);
    setExtractorRunStatus(storedExtractorHistory.results.length > 0 ? "done" : "idle");
    setMagazineResults(storedMagazineHistory.results);
    setMagazineLogs(storedMagazineHistory.logs);
    setSelectedMagazineIndex(storedMagazineHistory.results.length > 0 ? 0 : -1);
    setMagazineRunStatus(storedMagazineHistory.results.length > 0 ? "done" : "idle");
    setSelectedRagFileId(storedRagProfiles.generator.files[0]?.id ?? storedRagProfiles.extractor.files[0]?.id ?? null);
    setConnectionStatus(isAuthorizedAiSettings(storedProviderSettings) ? "connected" : "idle");
    setConnectionMessage(isAuthorizedAiSettings(storedProviderSettings)
      ? `${providerLabel(storedProviderSettings.provider, "ko")} 연결 테스트가 완료된 설정을 불러왔습니다.`
      : "OpenAI, Gemini, Azure API는 Extractor와 Schema Generator에 사용되고, Azure API는 Magazine Generator의 citation 콘텐츠 생성에도 사용됩니다.");
    setModelMessage("AI 키를 입력한 뒤 모델 목록을 불러올 수 있습니다.");
    setRagMessage("Extractor와 Generator RAG 프로필을 불러오고 있습니다.");
    setIsHistoryReady(true);
    setIsProviderSettingsReady(true);

    void requestRagProfiles()
      .then((profiles) => {
        const mergedProfiles = mergeRagProfileUiState(profiles, storedRagProfiles);
        setRagProfiles(mergedProfiles);
        setSelectedRagFileId(mergedProfiles.generator.files[0]?.id ?? mergedProfiles.extractor.files[0]?.id ?? null);
        window.localStorage.setItem(RAG_SETTINGS_STORAGE_KEY, JSON.stringify(mergedProfiles));
        setRagMessage("패키지 RAG 프로필을 불러왔습니다.");
      })
      .catch((error) => {
        setRagMessage(error instanceof Error ? error.message : "패키지 RAG 프로필을 불러오지 못해 브라우저 캐시 값을 사용합니다.");
      });
  }, []);

  useEffect(() => {
    window.localStorage.setItem("agentic-geo-ui-language", uiLanguage);
    document.documentElement.lang = uiLanguage;
  }, [uiLanguage]);

  useEffect(() => {
    if (!isHistoryReady) {
      return;
    }

    try {
      window.sessionStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify({
        results: results.slice(0, HISTORY_LIMIT),
        logs: logs.slice(0, HISTORY_LIMIT)
      }));
    } catch {
      // Session storage is best effort; keep the in-memory history available if quota is exceeded.
    }
  }, [isHistoryReady, logs, results]);

  useEffect(() => {
    if (!isHistoryReady) {
      return;
    }

    try {
      window.sessionStorage.setItem(EXTRACTOR_HISTORY_STORAGE_KEY, JSON.stringify({
        results: extractorResults.slice(0, HISTORY_LIMIT),
        logs: extractorLogs.slice(0, HISTORY_LIMIT)
      }));
    } catch {
      // Session storage is best effort; keep the in-memory history available if quota is exceeded.
    }
  }, [extractorLogs, extractorResults, isHistoryReady]);

  useEffect(() => {
    if (!isHistoryReady) {
      return;
    }

    try {
      window.sessionStorage.setItem(MAGAZINE_HISTORY_STORAGE_KEY, JSON.stringify({
        results: magazineResults.slice(0, HISTORY_LIMIT),
        logs: magazineLogs.slice(0, HISTORY_LIMIT)
      }));
    } catch {
      // Session storage is best effort; keep the in-memory history available if quota is exceeded.
    }
  }, [isHistoryReady, magazineLogs, magazineResults]);

  useEffect(() => {
    setSelectedRagReference(null);
  }, [activeMode, selectedExtractorIndex, selectedIndex, selectedMagazineIndex]);

  useEffect(() => {
    return () => {
      if (runSettingsFeedbackTimerRef.current !== null) {
        window.clearTimeout(runSettingsFeedbackTimerRef.current);
      }
      if (aiSettingsFeedbackTimerRef.current !== null) {
        window.clearTimeout(aiSettingsFeedbackTimerRef.current);
      }
      if (ragSettingsFeedbackTimerRef.current !== null) {
        window.clearTimeout(ragSettingsFeedbackTimerRef.current);
      }
    };
  }, []);

  function clearRunSettingsFeedback() {
    if (runSettingsFeedbackTimerRef.current !== null) {
      window.clearTimeout(runSettingsFeedbackTimerRef.current);
      runSettingsFeedbackTimerRef.current = null;
    }
    setRunSettingsFeedback(null);
  }

  function showRunSettingsFeedback(feedback: Exclude<RunSettingsFeedback, null>) {
    if (runSettingsFeedbackTimerRef.current !== null) {
      window.clearTimeout(runSettingsFeedbackTimerRef.current);
    }
    setRunSettingsFeedback(feedback);
    runSettingsFeedbackTimerRef.current = window.setTimeout(() => {
      setRunSettingsFeedback(null);
      runSettingsFeedbackTimerRef.current = null;
    }, 1600);
  }

  function clearAiSettingsFeedback() {
    if (aiSettingsFeedbackTimerRef.current !== null) {
      window.clearTimeout(aiSettingsFeedbackTimerRef.current);
      aiSettingsFeedbackTimerRef.current = null;
    }
    setAiSettingsFeedback(null);
  }

  function showAiSettingsFeedback(feedback: Exclude<AiSettingsFeedback, null>) {
    if (aiSettingsFeedbackTimerRef.current !== null) {
      window.clearTimeout(aiSettingsFeedbackTimerRef.current);
    }
    setAiSettingsFeedback(feedback);
    aiSettingsFeedbackTimerRef.current = window.setTimeout(() => {
      setAiSettingsFeedback(null);
      aiSettingsFeedbackTimerRef.current = null;
    }, 1600);
  }

  function clearRagSettingsFeedback() {
    if (ragSettingsFeedbackTimerRef.current !== null) {
      window.clearTimeout(ragSettingsFeedbackTimerRef.current);
      ragSettingsFeedbackTimerRef.current = null;
    }
    setRagSettingsFeedback(null);
  }

  function showRagSettingsFeedback(feedback: Exclude<RagSettingsFeedback, null>) {
    if (ragSettingsFeedbackTimerRef.current !== null) {
      window.clearTimeout(ragSettingsFeedbackTimerRef.current);
    }
    setRagSettingsFeedback(feedback);
    ragSettingsFeedbackTimerRef.current = window.setTimeout(() => {
      setRagSettingsFeedback(null);
      ragSettingsFeedbackTimerRef.current = null;
    }, 1600);
  }

  function selectWorkspaceMode(mode: WorkspaceMode) {
    setActiveMode(mode);
    setSearchQuery("");
    setErrorMessage("");
  }

  function startNewChat() {
    setDraft("");
    setComposerStatus("");
    setComposerAttachments([]);
    setIsDragActive(false);
    if (activeMode === "extractor") {
      setExtractorMessages([]);
      setSelectedExtractorIndex(-1);
      setExtractorRunStatus("idle");
      setExtractorPipelineProcess({
        status: "idle",
        currentGroup: "extractor",
        currentStepId: "input",
        sourceCount: 0,
        completedSourceCount: 0
      });
      setExtractorOutputView("result");
    } else if (activeMode === "magazine") {
      setMagazineMessages([]);
      setSelectedMagazineIndex(-1);
      setMagazineRunStatus("idle");
      setMagazinePipelineProcess({
        status: "idle",
        currentGroup: "extractor",
        currentStepId: "input",
        sourceCount: 0,
        completedSourceCount: 0
      });
      setMagazineOutputView("reddit");
    } else {
      setMessages([]);
      setSelectedIndex(-1);
      setRunStatus("idle");
      setPipelineProcess({
        status: "idle",
        currentGroup: "extractor",
        currentStepId: "input",
        sourceCount: 0,
        completedSourceCount: 0
      });
      setOutputView("schema");
    }
    setErrorMessage("");
  }

  async function submit() {
    if (activeMode === "extractor") {
      await submitExtractor();
      return;
    }
    if (activeMode === "magazine") {
      await submitMagazine();
      return;
    }

    await submitGenerator();
  }

  async function submitGenerator() {
    if (runStatus === "running") {
      return;
    }

    let input: NormalizedComposerInput;
    try {
      input = normalizeComposerInput(draft, composerAttachments, sourceMode, text);
    } catch (error) {
      setRunStatus("error");
      setErrorMessage(error instanceof Error ? error.message : text.composer.invalidJson);
      return;
    }

    if (input.products.length === 0 && input.sources.length === 0) {
      return;
    }

    const sourceCount = Math.max(input.products.length + input.sources.length, 1);
    const firstSource = input.sources[0] ?? (input.products.length > 0 ? text.composer.jsonSummary(input.products.length) : undefined);
    const runStartedAt = getRunClockMs();

    setRunStatus("running");
    setErrorMessage("");
    setSelectedIndex(-1);
    setPipelineProcess({
      status: "running",
      currentGroup: input.sources.length > 0 ? "extractor" : "generator",
      currentStepId: "input",
      sourceCount,
      completedSourceCount: 0,
      activeSource: firstSource,
      skipExtractor: input.sources.length === 0
    });
    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "user",
        command: sourceModeLabel(sourceMode, text),
        body: input.displayValue
      },
      {
        id: crypto.randomUUID(),
        role: "tool",
        command: "pdp-extractor-agent → pdp-geo-generator-agent",
        body: text.messages.start
      }
    ]);
    setDraft("");
    setComposerStatus("");
    setComposerAttachments([]);

    try {
      const body = createRequestBody(input);
      const { payload, ok } = await requestGeoGenerator(body, (event) => {
        applyGeneratorProgressEvent(
          event,
          setPipelineProcess,
          getExtractorSteps(uiLanguage) as ProductExtractionStep[],
          getGeneratorSteps(uiLanguage)
        );
      });

      if (!ok && !payload.results?.length) {
        throw new Error(payload.error ?? "GEO generation failed.");
      }

      const runDurationMs = getRunClockMs() - runStartedAt;
      const runDurationLabel = formatElapsedDuration(runDurationMs);
      const incomingResults = attachRunDurationToGeoResults(payload.results ?? [], runDurationMs);
      const nextResults = mergeGeoHistoryResults(incomingResults, results);
      const nextLogs = mergeGeoHistoryLogs(payload.logs ?? [], logs);
      setResults(nextResults);
      setLogs(nextLogs);
      setSelectedIndex(incomingResults.length ? 0 : -1);
      setRunStatus(payload.failures?.length ? "error" : "done");
      setPipelineProcess({
        status: payload.failures?.length ? "error" : "done",
        currentGroup: "generator",
        currentStepId: "artifact",
        sourceCount,
        completedSourceCount: incomingResults.length + (payload.failures?.length ?? 0),
        activeSource: incomingResults[0]?.source ?? payload.failures?.[0]?.source ?? firstSource,
        skipExtractor: input.sources.length === 0,
        errorMessage: payload.failures?.[0]?.error
      });
      setErrorMessage(payload.failures?.map((failure) => `${failure.source}: ${failure.error}`).join("\n") ?? "");
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: payload.failures?.length ? "agent" : "agent",
          body: appendRunDuration(
            payload.failures?.length
              ? text.messages.partial(incomingResults.length, payload.failures.length)
              : text.messages.done(incomingResults.length),
            runDurationLabel,
            uiLanguage
          )
        }
      ]);
    } catch (error) {
      const runDurationLabel = formatElapsedDuration(getRunClockMs() - runStartedAt);
      const message = error instanceof Error ? error.message : "GEO generation failed.";
      setRunStatus("error");
      setPipelineProcess((current) => ({
        ...current,
        status: "error",
        errorMessage: message
      }));
      setErrorMessage(message);
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "agent",
          body: appendRunDuration(message, runDurationLabel, uiLanguage)
        }
      ]);
    }
  }

  async function submitMagazine() {
    if (magazineRunStatus === "running") {
      return;
    }

    let input: NormalizedComposerInput;
    try {
      input = normalizeComposerInput(draft, composerAttachments, sourceMode, text);
    } catch (error) {
      setMagazineRunStatus("error");
      setErrorMessage(error instanceof Error ? error.message : text.composer.invalidJson);
      return;
    }

    if (input.products.length === 0 && input.sources.length === 0) {
      return;
    }

    const sourceCount = Math.max(input.products.length + input.sources.length, 1);
    const firstSource = input.sources[0] ?? (input.products.length > 0 ? text.composer.jsonSummary(input.products.length) : undefined);
    const runStartedAt = getRunClockMs();

    setMagazineRunStatus("running");
    setErrorMessage("");
    setSelectedMagazineIndex(-1);
    setMagazineOutputView("reddit");
    setMagazinePipelineProcess({
      status: "running",
      currentGroup: input.sources.length > 0 ? "extractor" : "magazine",
      currentStepId: "input",
      sourceCount,
      completedSourceCount: 0,
      activeSource: firstSource,
      skipExtractor: input.sources.length === 0
    });
    setMagazineMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "user",
        command: sourceModeLabel(sourceMode, text),
        body: input.displayValue
      },
      {
        id: crypto.randomUUID(),
        role: "tool",
        command: "pdp-extractor-agent → geo-citation-content-agent",
        body: text.messages.magazineStart
      }
    ]);
    setDraft("");
    setComposerStatus("");
    setComposerAttachments([]);

    try {
      const body = createMagazineRequestBody(input);
      const { payload, ok } = await requestMagazineGenerator(body, (event) => {
        applyMagazineProgressEvent(
          event,
          setMagazinePipelineProcess,
          getExtractorSteps(uiLanguage) as ProductExtractionStep[],
          getMagazineSteps(uiLanguage)
        );
      });

      if (!ok && !payload.results?.length) {
        throw new Error(payload.error ?? "GEO magazine/content generation failed.");
      }

      const runDurationMs = getRunClockMs() - runStartedAt;
      const runDurationLabel = formatElapsedDuration(runDurationMs);
      const incomingResults = attachRunDurationToMagazineResults(payload.results ?? [], runDurationMs);
      const nextResults = mergeMagazineHistoryResults(incomingResults, magazineResults);
      const nextLogs = mergeMagazineHistoryLogs(payload.logs ?? [], magazineLogs);
      setMagazineResults(nextResults);
      setMagazineLogs(nextLogs);
      setSelectedMagazineIndex(incomingResults.length ? 0 : -1);
      setMagazineRunStatus(payload.failures?.length ? "error" : "done");
      setMagazinePipelineProcess({
        status: payload.failures?.length ? "error" : "done",
        currentGroup: "magazine",
        currentStepId: "artifact",
        sourceCount,
        completedSourceCount: incomingResults.length + (payload.failures?.length ?? 0),
        activeSource: incomingResults[0]?.source ?? payload.failures?.[0]?.source ?? firstSource,
        skipExtractor: input.sources.length === 0,
        errorMessage: payload.failures?.[0]?.error
      });
      setErrorMessage(payload.failures?.map((failure) => `${failure.source}: ${failure.error}`).join("\n") ?? "");
      setMagazineMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "agent",
          body: appendRunDuration(
            payload.failures?.length
              ? text.messages.magazinePartial(incomingResults.length, payload.failures.length)
              : text.messages.magazineDone(incomingResults.length),
            runDurationLabel,
            uiLanguage
          )
        }
      ]);
    } catch (error) {
      const runDurationLabel = formatElapsedDuration(getRunClockMs() - runStartedAt);
      const message = error instanceof Error ? error.message : "GEO magazine/content generation failed.";
      setMagazineRunStatus("error");
      setMagazinePipelineProcess((current) => ({
        ...current,
        status: "error",
        errorMessage: message
      }));
      setErrorMessage(message);
      setMagazineMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "agent",
          body: appendRunDuration(message, runDurationLabel, uiLanguage)
        }
      ]);
    }
  }

  async function submitExtractor() {
    if (extractorRunStatus === "running") {
      return;
    }

    let input: NormalizedComposerInput;
    try {
      input = normalizeExtractorComposerInput(draft, composerAttachments, sourceMode);
    } catch (error) {
      setExtractorRunStatus("error");
      setErrorMessage(error instanceof Error ? error.message : text.composer.invalidJson);
      return;
    }

    if (input.sources.length === 0) {
      setExtractorRunStatus("error");
      setErrorMessage(text.messages.extractorNoSource);
      setExtractorMessages((current) => [
        ...current,
        ...(input.displayValue
          ? [{
              id: crypto.randomUUID(),
              role: "user" as const,
              command: sourceModeLabel(sourceMode, text),
              body: input.displayValue
            }]
          : []),
        {
          id: crypto.randomUUID(),
          role: "agent",
          body: text.messages.extractorNoSource
        }
      ]);
      return;
    }

    const sourceCount = input.sources.length;
    const firstSource = input.sources[0];
    let progressController: { cancelled: boolean } | undefined;
    const runStartedAt = getRunClockMs();

    setExtractorRunStatus("running");
    setErrorMessage("");
    setSelectedExtractorIndex(-1);
    setExtractorOutputView("result");
    setExtractorPipelineProcess({
      status: "running",
      currentGroup: "extractor",
      currentStepId: "input",
      sourceCount,
      completedSourceCount: 0,
      activeSource: firstSource
    });
    setExtractorMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "user",
        command: sourceModeLabel(input.sourceType === "restApi" ? "restApi" : "url", text),
        body: input.displayValue
      },
      {
        id: crypto.randomUUID(),
        role: "tool",
        command: "pdp-extractor-agent",
        body: text.messages.extractorStart
      }
    ]);
    setDraft("");
    setComposerStatus("");
    setComposerAttachments([]);

    try {
      const body = createExtractorRequestBody(input);
      progressController = { cancelled: false };
      const progress = playExtractorPipelineProgress(input, setExtractorPipelineProcess, progressController);
      const response = await fetch("/api/extract", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
      const payload = await response.json() as ProductExtractorResponse;
      await progress;

      if (!response.ok && !payload.results?.length) {
        throw new Error(payload.error ?? `Product extraction failed: ${response.status}`);
      }

      const runDurationMs = getRunClockMs() - runStartedAt;
      const runDurationLabel = formatElapsedDuration(runDurationMs);
      const incomingResults = attachRunDurationToExtractorResults(payload.results ?? [], runDurationMs);
      const nextResults = mergeExtractorHistoryResults(incomingResults, extractorResults);
      const nextLogs = mergeExtractorHistoryLogs(payload.logs ?? [], extractorLogs);
      setExtractorResults(nextResults);
      setExtractorLogs(nextLogs);
      setSelectedExtractorIndex(incomingResults.length ? 0 : -1);
      setExtractorRunStatus(payload.failures?.length ? "error" : "done");
      setExtractorPipelineProcess({
        status: payload.failures?.length ? "error" : "done",
        currentGroup: "extractor",
        currentStepId: "json",
        sourceCount,
        completedSourceCount: incomingResults.length + (payload.failures?.length ?? 0),
        activeSource: incomingResults[0]?.source ?? payload.failures?.[0]?.source ?? firstSource,
        errorMessage: payload.failures?.[0]?.error
      });
      setErrorMessage(payload.failures?.map((failure) => `${failure.source}: ${failure.error}`).join("\n") ?? "");
      setExtractorMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "agent",
          body: appendRunDuration(
            payload.failures?.length
              ? text.messages.extractorPartial(incomingResults.length, payload.failures.length)
              : text.messages.extractorDone(incomingResults.length),
            runDurationLabel,
            uiLanguage
          )
        }
      ]);
    } catch (error) {
      if (progressController) {
        progressController.cancelled = true;
      }
      const runDurationLabel = formatElapsedDuration(getRunClockMs() - runStartedAt);
      const message = error instanceof Error ? error.message : "Product extraction failed.";
      setExtractorRunStatus("error");
      setExtractorPipelineProcess((current) => ({
        ...current,
        status: "error",
        errorMessage: message
      }));
      setErrorMessage(message);
      setExtractorMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "agent",
          body: appendRunDuration(message, runDurationLabel, uiLanguage)
        }
      ]);
    }
  }

  async function importComposerFiles(files: File[]) {
    if (files.length === 0) {
      return;
    }

    const importedAttachments = await Promise.all(
      files.map(async (file): Promise<ComposerAttachment | undefined> => {
        const content = await file.text();
        return createComposerAttachment(file, content);
      })
    );
    const attachments = importedAttachments.filter((attachment): attachment is ComposerAttachment => Boolean(attachment));
    const rejectedCount = files.length - attachments.length;

    if (attachments.length > 0) {
      setComposerAttachments((current) => [
        ...current,
        ...attachments
      ]);
    }

    setComposerStatus([
      attachments.length > 0 ? text.composer.filesAttached(attachments.length) : "",
      rejectedCount > 0 ? text.composer.filesRejected(rejectedCount) : ""
    ].filter(Boolean).join(" "));
  }

  function removeComposerAttachment(id: string) {
    const nextAttachments = composerAttachments.filter((attachment) => attachment.id !== id);
    setComposerAttachments(nextAttachments);
    setComposerStatus(nextAttachments.length > 0 ? text.composer.filesAttached(nextAttachments.length) : "");
  }

  async function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);

    await importComposerFiles(files);
    input.value = "";
  }

  function handleComposerDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragActive(true);
  }

  function handleComposerDragLeave(event: DragEvent<HTMLDivElement>) {
    const nextTarget = event.relatedTarget;

    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }

    setIsDragActive(false);
  }

  async function handleComposerDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragActive(false);

    const files = Array.from(event.dataTransfer.files);
    const droppedText = (event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain")).trim();

    if (files.length > 0) {
      await importComposerFiles(files);
    }

    if (droppedText) {
      setDraft((current) => [current.trim(), droppedText].filter(Boolean).join("\n"));
      setComposerStatus("");
    }
  }

  function updateProviderSetting<Key extends keyof ProviderSettings>(key: Key, value: ProviderSettings[Key]) {
    clearAiSettingsFeedback();
    setProviderSettings((current) => ({
      ...current,
      [key]: value
    }));
    setConnectionStatus("idle");

    if (key === "provider") {
      setModelLoadStatus("idle");
      setModelMessage(modelIdleMessage(uiLanguage));
    }

    setConnectionMessage(value === "mock"
      ? mockProviderMessage(uiLanguage)
      : providerPendingMessage(uiLanguage));
  }

  async function checkProviderConnection(shouldSave: boolean) {
    const validationMessage = getProviderValidationMessage(providerSettings, uiLanguage);
    clearAiSettingsFeedback();

    if (validationMessage) {
      setConnectionStatus("error");
      setConnectionMessage(validationMessage);
      return;
    }

    setAiSettingsAction(shouldSave ? "save" : "test");
    setConnectionStatus("checking");
    setConnectionMessage(connectionCheckingMessage(activeProviderLabel, uiLanguage));

    try {
      const result = await validateProviderConnection(providerSettings);
      setModelOptions((current) => ({
        ...current,
        [providerSettings.provider]: result.models
      }));
      setModelMessage(result.models.length > 0 ? modelCountMessage(result.models.length, uiLanguage) : emptyModelMessage(uiLanguage));

      if (shouldSave) {
        window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(providerSettings));
      }

      setConnectionStatus("connected");
      setConnectionMessage(shouldSave
        ? providerSavedMessage(result.message, uiLanguage)
        : providerReadyMessage(result.message, uiLanguage));
      showAiSettingsFeedback(shouldSave ? "saved" : "tested");
    } catch (error) {
      setConnectionStatus("error");
      setConnectionMessage(error instanceof Error ? error.message : providerFailedMessage(activeProviderLabel, uiLanguage));
      clearAiSettingsFeedback();
    } finally {
      setAiSettingsAction(null);
    }
  }

  async function testProviderConnection() {
    await checkProviderConnection(false);
  }

  async function saveProviderSettings() {
    await checkProviderConnection(true);
  }

  async function loadProviderModels() {
    const validationMessage = getProviderCredentialValidationMessage(providerSettings, uiLanguage);

    if (validationMessage) {
      setModelLoadStatus("error");
      setModelMessage(validationMessage);
      setConnectionStatus("error");
      setConnectionMessage(validationMessage);
      return;
    }

    setModelLoadStatus("loading");
    setModelMessage(modelLoadingMessage(activeProviderLabel, uiLanguage));

    try {
      const result = await validateProviderConnection(providerSettings, { listOnly: true });
      const models = result.models;
      setModelOptions((current) => ({
        ...current,
        [providerSettings.provider]: models
      }));
      setModelLoadStatus("ready");
      setModelMessage(models.length > 0 ? modelLoadedMessage(models.length, uiLanguage) : emptyModelMessage(uiLanguage));

      if (models.length > 0) {
        const currentModel = getSelectedModel(providerSettings);
        if (!currentModel || !models.includes(currentModel)) {
          updateProviderModel(providerSettings.provider, models[0] ?? "");
        }
      }
    } catch (error) {
      setModelLoadStatus("error");
      setModelMessage(error instanceof Error ? error.message : modelFailedMessage(activeProviderLabel, uiLanguage));
    }
  }

  function updateProviderModel(provider: ProviderId, value: string) {
    clearAiSettingsFeedback();
    setProviderSettings((current) => {
      if (provider === "openai") {
        return { ...current, openaiModel: value };
      }
      if (provider === "gemini") {
        return { ...current, geminiModel: value };
      }
      if (provider === "azure-openai") {
        return {
          ...current,
          azureDeployment: value,
          azureOcrDeployment: current.azureOcrDeployment || value,
          azureReasoningDeployment: current.azureReasoningDeployment || value
        };
      }
      return current;
    });
    setConnectionStatus("idle");
    setConnectionMessage(providerPendingMessage(uiLanguage));
  }

  function resetProviderSettings() {
    clearAiSettingsFeedback();
    window.localStorage.removeItem(SETTINGS_STORAGE_KEY);
    LEGACY_SETTINGS_STORAGE_KEYS.forEach((key) => window.localStorage.removeItem(key));
    setProviderSettings(defaultProviderSettings);
    setConnectionStatus("idle");
    setModelOptions({});
    setModelLoadStatus("idle");
    setModelMessage(modelIdleMessage(uiLanguage));
    setConnectionMessage(providerResetMessage(uiLanguage));
    showAiSettingsFeedback("reset");
  }

  function saveRunSettings() {
    try {
      parseHeadersJson(headersJson);
      window.localStorage.setItem(RUN_SETTINGS_STORAGE_KEY, JSON.stringify({
        sourceMode,
        locale,
        headersJson
      }));
      setErrorMessage("");
      showRunSettingsFeedback("saved");
    } catch (error) {
      clearRunSettingsFeedback();
      setErrorMessage(error instanceof Error ? error.message : "Headers JSON is invalid.");
    }
  }

  function resetRunSettings() {
    window.localStorage.removeItem(RUN_SETTINGS_STORAGE_KEY);
    setSourceMode("auto");
    setLocale("ko-KR");
    setHeadersJson("{}");
    setErrorMessage("");
    showRunSettingsFeedback("reset");
  }

  function selectRagTarget(target: RagProfileTarget) {
    clearRagSettingsFeedback();
    setSelectedRagTarget(target);
    setSelectedRagFileId(ragProfiles[target].files[0]?.id ?? null);
  }

  function updateRagAnalysisPrompt(value: string) {
    clearRagSettingsFeedback();
    setRagProfiles((current) => ({
      ...current,
      [selectedRagTarget]: {
        ...current[selectedRagTarget],
        analysisPrompt: value
      }
    }));
    setRagMessage(ragChangedMessage(uiLanguage));
  }

  async function importRagFiles(files: File[]) {
    if (files.length === 0) {
      return;
    }

    clearRagSettingsFeedback();
    const attachments = await Promise.all(
      files.map(async (file) => ({
        id: crypto.randomUUID(),
        name: file.name,
        version: extractRagFileVersion(file.name),
        size: file.size,
        type: file.type || inferRagFileType(file.name),
        content: await file.text(),
        managed: false,
        addedAt: new Date().toISOString()
      }))
    );

    setRagProfiles((current) => ({
      ...current,
      [selectedRagTarget]: {
        ...current[selectedRagTarget],
        files: [...attachments, ...current[selectedRagTarget].files].slice(0, 24)
      }
    }));
    setSelectedRagFileId(attachments[0]?.id ?? null);
    setRagMessage(ragImportedMessage(attachments.length, selectedRagTarget, uiLanguage));
  }

  async function handleRagFileInput(event: ChangeEvent<HTMLInputElement>) {
    await importRagFiles(Array.from(event.currentTarget.files ?? []));
    event.currentTarget.value = "";
  }

  function removeRagFile(id: string) {
    clearRagSettingsFeedback();
    setRagProfiles((current) => {
      const nextFiles = current[selectedRagTarget].files.filter((file) => file.id !== id);
      setSelectedRagFileId((selected) => selected === id ? nextFiles[0]?.id ?? null : selected);

      return {
        ...current,
        [selectedRagTarget]: {
          ...current[selectedRagTarget],
          files: nextFiles
        }
      };
    });
    setRagMessage(ragRemovedMessage(uiLanguage));
  }

  function updateRagFileContent(id: string, content: string) {
    clearRagSettingsFeedback();
    setRagProfiles((current) => ({
      ...current,
      [selectedRagTarget]: {
        ...current[selectedRagTarget],
        files: current[selectedRagTarget].files.map((file) => file.id === id
          ? {
              ...file,
              content,
              size: new TextEncoder().encode(content).length
            }
          : file)
      }
    }));
    setRagMessage(ragChangedMessage(uiLanguage));
  }

  function updateRagFileVersion(id: string, version: string) {
    clearRagSettingsFeedback();
    const normalizedVersion = normalizeRagVersion(version);

    setRagProfiles((current) => ({
      ...current,
      [selectedRagTarget]: {
        ...current[selectedRagTarget],
        files: current[selectedRagTarget].files.map((file) => file.id === id
          ? {
              ...file,
              version: normalizedVersion
            }
          : file)
      }
    }));
    setRagMessage(ragChangedMessage(uiLanguage));
  }

  function toggleRagFileEnabled(id: string) {
    clearRagSettingsFeedback();
    setRagProfiles((current) => ({
      ...current,
      [selectedRagTarget]: {
        ...current[selectedRagTarget],
        files: current[selectedRagTarget].files.map((file) => file.id === id
          ? {
              ...file,
              enabled: !isRagFileEnabled(file)
            }
          : file)
      }
    }));
    setRagMessage(ragChangedMessage(uiLanguage));
  }

  async function saveRagProfileSettings() {
    clearRagSettingsFeedback();
    setRagSettingsAction("save");
    try {
      const profiles = await writeRagProfile(selectedRagTarget, ragProfiles[selectedRagTarget]);
      const mergedProfiles = mergeRagProfileUiState(profiles, ragProfiles);
      setRagProfiles(mergedProfiles);
      setSelectedRagFileId(mergedProfiles[selectedRagTarget].files.find((file) => file.id === selectedRagFileId)?.id ?? mergedProfiles[selectedRagTarget].files[0]?.id ?? null);
      window.localStorage.setItem(RAG_SETTINGS_STORAGE_KEY, JSON.stringify(mergedProfiles));
      setRagMessage(ragSavedMessage(selectedRagTarget, uiLanguage));
      showRagSettingsFeedback("saved");
    } catch (error) {
      setRagMessage(error instanceof Error ? error.message : ragSaveFailedMessage(uiLanguage));
      clearRagSettingsFeedback();
    } finally {
      setRagSettingsAction(null);
    }
  }

  async function resetRagProfileSettings() {
    clearRagSettingsFeedback();
    setRagSettingsAction("reset");
    try {
      const profiles = await resetPackageRagProfile(selectedRagTarget);
      setRagProfiles(profiles);
      setSelectedRagFileId(profiles[selectedRagTarget].files[0]?.id ?? null);
      window.localStorage.setItem(RAG_SETTINGS_STORAGE_KEY, JSON.stringify(profiles));
      setRagMessage(ragResetMessage(selectedRagTarget, uiLanguage));
      showRagSettingsFeedback("reset");
    } catch (error) {
      setRagMessage(error instanceof Error ? error.message : ragResetFailedMessage(uiLanguage));
      clearRagSettingsFeedback();
    } finally {
      setRagSettingsAction(null);
    }
  }

  function createRequestBody(input: NormalizedComposerInput) {
    const generatorRag = createRuntimeRagConfig(ragProfiles.generator);
    const extractorRag = createRuntimeRagConfig(ragProfiles.extractor);
    const common = {
      hints: {
        locale,
        market: marketForLocale(locale)
      },
      rag: {
        mode: ragMode,
        ...generatorRag
      },
      extractorRag,
      headers: parseHeadersJson(headersJson),
      llm: createRuntimeLlmConfig(providerSettings)
    };

    return {
      ...common,
      ...(input.products.length > 0 ? { products: input.products } : {}),
      ...(input.sources.length > 0 ? { sources: input.sources, sourceType: input.sourceType } : {})
    };
  }

  function createMagazineRequestBody(input: NormalizedComposerInput) {
    const generatorRag = createRuntimeRagConfig(ragProfiles.generator);
    const extractorRag = createRuntimeRagConfig(ragProfiles.extractor);
    const common = {
      target: {
        surface: "reddit",
        locale,
        market: marketForLocale(locale),
        audience: uiLanguage === "ko" ? "상품을 비교하고 근거를 확인하려는 Reddit 사용자" : "Reddit users comparing products and evidence",
        communityOrChannelHint: "reddit"
      },
      strategy: {
        avoidPromotionalTone: true,
        contentAngle: "buyer-question",
        generationMode: "single-best",
        variants: {
          diversity: "high",
          avoidNearDuplicate: true
        }
      },
      rag: {
        mode: ragMode === "managed-vector-store-rag" ? "managed-vector-store-rag" : "local-versioned-rag",
        ...generatorRag
      },
      extractorRag,
      headers: parseHeadersJson(headersJson),
      llm: createRuntimeLlmConfig(providerSettings)
    };

    return {
      ...common,
      ...(input.products.length > 0 ? { products: input.products } : {}),
      ...(input.sources.length > 0 ? { sources: input.sources, sourceType: input.sourceType } : {})
    };
  }

  function createExtractorRequestBody(input: NormalizedComposerInput) {
    const extractorRag = createRuntimeRagConfig(ragProfiles.extractor);

    return {
      sources: input.sources,
      sourceType: input.sourceType,
      headers: parseHeadersJson(headersJson),
      llm: createRuntimeLlmConfig(providerSettings),
      rag: extractorRag
    };
  }

  return (
    <main className={shellClassName}>
      <aside className="codexSidebar" aria-label="Workspace">
        <header className="sidebarHeader">
          <div className="brandLockup">
            <span className="brandAvatar" aria-hidden="true">
              <Image
                src="/icons/profile-rounded.png"
                alt=""
                width={22}
                height={22}
                priority
              />
            </span>
            <span className="brandName navText">Agentic GEO</span>
          </div>
          <button className="sidebarToggle" type="button" onClick={() => setIsSidebarCollapsed((current) => !current)} aria-label={text.sidebar.toggle}>
            <PanelLeft size={16} />
          </button>
        </header>

        <section className="modeAccordion" aria-label={text.modes.label}>
          <span className="modeLabel navText">{text.modes.label}</span>
          {(["extractor", "generator", "magazine"] as WorkspaceMode[]).map((mode) => (
            <button
              className={`modeAccordionItem ${activeMode === mode ? "active" : ""}`}
              type="button"
              key={mode}
              onClick={() => selectWorkspaceMode(mode)}
              aria-expanded={activeMode === mode}
              aria-pressed={activeMode === mode}
            >
              <span className="modeText navText">
                <strong>{text.modes[mode].label}</strong>
                <em>{text.modes[mode].description}</em>
              </span>
              <ChevronRight size={14} />
            </button>
          ))}
        </section>

        <nav className="primaryNav" aria-label="Primary">
          <button type="button" onClick={startNewChat}>
            <MessageSquarePlus size={15} />
            <span className="navText">{activeModeCopy.newChat}</span>
          </button>
          <button className={isSearchOpen ? "active" : ""} type="button" onClick={() => setIsSearchOpen((current) => !current)}>
            <Search size={15} />
            <span className="navText">{text.sidebar.search}</span>
          </button>
        </nav>

        {isSearchOpen && (
          <label className="sidebarSearch">
            <Search size={14} />
            <input
              autoFocus
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={activeModeCopy.searchPlaceholder}
            />
          </label>
        )}

        <section className="sidebarSection historySection">
          <h2>{activeModeCopy.history}</h2>
          {activeMode === "extractor" ? (
            visibleExtractorHistory.length === 0 ? (
              <p className="emptyHistory">{extractorResults.length === 0 ? activeModeCopy.emptyHistory : text.sidebar.noSearchResults}</p>
            ) : (
              <div className="historyList">
                {visibleExtractorHistory.map(({ result, index }) => (
                  <div className={`queueThread ${index === selectedExtractorIndex ? "active" : ""}`} key={`${result.sourceType}:${result.source}`}>
                    <button className="queueThreadMain" type="button" onClick={() => setSelectedExtractorIndex(index)}>
                      <CheckCircle2 className="statusIcon done" size={14} />
                      <span className="historyText">
                        <span className="historyTitle">{result.geoProduct.name}</span>
                        <span className="historySource">{result.source}</span>
                      </span>
                      <time dateTime={result.generatedAt}>{formatHistoryTime(result.generatedAt, text)}</time>
                    </button>
                  </div>
                ))}
              </div>
            )
          ) : activeMode === "magazine" ? (
            visibleMagazineHistory.length === 0 ? (
              <p className="emptyHistory">{magazineResults.length === 0 ? activeModeCopy.emptyHistory : text.sidebar.noSearchResults}</p>
            ) : (
              <div className="historyList">
                {visibleMagazineHistory.map(({ result, index }) => (
                  <div className={`queueThread ${index === selectedMagazineIndex ? "active" : ""}`} key={result.id}>
                    <button className="queueThreadMain" type="button" onClick={() => setSelectedMagazineIndex(index)}>
                      <CheckCircle2 className="statusIcon done" size={14} />
                      <span className="historyText">
                        <span className="historyTitle">{result.magazine.artifact.title}</span>
                        <span className="historySource">{result.source}</span>
                      </span>
                      <time dateTime={result.magazine.diagnostics.generatedAt}>{formatHistoryTime(result.magazine.diagnostics.generatedAt, text)}</time>
                    </button>
                  </div>
                ))}
              </div>
            )
          ) : visibleGeneratorHistory.length === 0 ? (
            <p className="emptyHistory">{results.length === 0 ? activeModeCopy.emptyHistory : text.sidebar.noSearchResults}</p>
          ) : (
            <div className="historyList">
              {visibleGeneratorHistory.map(({ result, index }) => (
                <div className={`queueThread ${index === selectedIndex ? "active" : ""}`} key={result.id}>
                  <button className="queueThreadMain" type="button" onClick={() => setSelectedIndex(index)}>
                    <CheckCircle2 className="statusIcon done" size={14} />
                    <span className="historyText">
                      <span className="historyTitle">{result.generator.content.sections.productName}</span>
                      <span className="historySource">{result.source}</span>
                    </span>
                    <time dateTime={result.generator.generatedAt}>{formatHistoryTime(result.generator.generatedAt, text)}</time>
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <footer className="sidebarFooter">
          <button type="button" onClick={() => setIsSettingsOpen(true)}>
            <Settings size={16} />
            <span className="footerText">{text.sidebar.settings}</span>
          </button>
        </footer>
      </aside>

      <section className="codexMain" aria-label="GEO generator conversation">
        <header className="threadHeader">
          <div className="threadTitle">
            <span>{workspaceTitle(activeMode, uiLanguage)}</span>
            <MoreHorizontal size={18} />
          </div>
          <div className="windowActions" aria-label={text.header.viewOptions}>
            <div className="languageToggle" aria-label={text.header.language}>
              {(["ko", "en"] as UiLanguage[]).map((language) => (
                <button
                  className={uiLanguage === language ? "active" : ""}
                  type="button"
                  key={language}
                  onClick={() => setUiLanguage(language)}
                  aria-pressed={uiLanguage === language}
                >
                  {language.toUpperCase()}
                </button>
              ))}
            </div>
            <button className={isArtifactGrid ? "active" : ""} type="button" onClick={() => setIsArtifactGrid((current) => !current)} aria-label={text.header.gridToggle}>
              <LayoutGrid size={17} />
            </button>
            <button className={isSidebarCollapsed ? "active" : ""} type="button" onClick={() => setIsSidebarCollapsed((current) => !current)} aria-label={text.header.leftPanelToggle}>
              <PanelLeft size={17} />
            </button>
            <button className={isStatusPanelOpen ? "active" : ""} type="button" onClick={() => setIsStatusPanelOpen((current) => !current)} aria-label={text.header.rightPanelToggle}>
              <PanelRight size={17} />
            </button>
          </div>
        </header>

        <div className="threadCanvas">
          {!hasStarted && (
            <section className="welcomeStage" aria-label="Start">
              <h1>{workspaceWelcomeTitle(activeMode, uiLanguage)}</h1>
              <div className="starterCards" aria-hidden="true">
                <div>
                  <Globe2 size={18} />
                  <strong>{welcomeCards[0][0]}</strong>
                  <span>{welcomeCards[0][1]}</span>
                </div>
                <div>
                  <FileCode2 size={18} />
                  <strong>{welcomeCards[1][0]}</strong>
                  <span>{welcomeCards[1][1]}</span>
                </div>
                <div>
                  <Copy size={18} />
                  <strong>{welcomeCards[2][0]}</strong>
                  <span>{welcomeCards[2][1]}</span>
                </div>
              </div>
            </section>
          )}

          {hasStarted && (
            <section className="threadStream" aria-label="Conversation">
              {activeMessages.map((message) => (
                <article className={`chatBlock ${message.role}`} key={message.id}>
                  {message.command && (
                    <div className="commandLine">
                      <FileCode2 size={14} />
                      <span>{message.command}</span>
                    </div>
                  )}
                  <p>{message.body}</p>
                </article>
              ))}
              {activeRunStatus === "running" && (
                <article className="chatBlock tool">
                  <div className="commandLine">
                    <Loader2 className="spin" size={14} />
                    <span>{activeMode === "extractor" ? text.messages.extractorRunningTitle : activeMode === "magazine" ? text.messages.magazineRunningTitle : text.messages.runningTitle}</span>
                    <span className="runTimer" aria-label="elapsed time">{runElapsedLabel}</span>
                  </div>
                  <p>{activeMode === "extractor" ? text.messages.extractorRunningBody : activeMode === "magazine" ? text.messages.magazineRunningBody : text.messages.runningBody}</p>
                </article>
              )}
              {errorMessage && (
                <article className="chatBlock agent">
                  <div className="commandLine">
                    <AlertCircle size={14} />
                    <span>{text.messages.warning}</span>
                  </div>
                  <p>{errorMessage}</p>
                </article>
              )}
              {activeMode === "generator" && selectedResult && (
                <>
                  <section className="floatingArtifact" aria-label="Selected output">
                    <div className="artifactTop">
                      <div>
                        <span>{[selectedResult.generator.locale, selectedResult.generator.diagnostics.ragMode, formatRunDurationMeta(selectedResult.runDurationMs, uiLanguage)].filter(Boolean).join(" · ")}</span>
                        <strong>{selectedResult.generator.content.sections.productName}</strong>
                      </div>
                      <div className="windowActions">
                        {(["schema", "content", "diagnostics"] as OutputView[]).map((view) => (
                          <button className={outputView === view ? "active" : ""} type="button" key={view} onClick={() => setOutputView(view)}>
                            <span>{view}</span>
                          </button>
                        ))}
                        <button
                          className={`modalCopyButton${isGeneratorFloatingCopied ? " copied" : ""}`}
                          type="button"
                          onClick={() => void copyArtifactText(generatorOutputText, generatorFloatingCopyTarget)}
                          aria-label={isGeneratorFloatingCopied ? modalCopiedLabel : text.artifact.copyAria}
                          title={isGeneratorFloatingCopied ? modalCopiedLabel : text.artifact.copyAria}
                        >
                          {isGeneratorFloatingCopied ? <CheckCircle2 size={14} /> : <Copy size={14} />}
                          <span className="modalCopyLabel" aria-live="polite">
                            {isGeneratorFloatingCopied ? modalCopiedLabel : text.artifact.copy}
                          </span>
                        </button>
                      </div>
                    </div>
                    <pre>{generatorOutputText}</pre>
                  </section>
                  <GeoQualityIntroMessage uiLanguage={uiLanguage} />
                  <GeoQualityEvaluationPanel result={selectedResult} uiLanguage={uiLanguage} onOpenDetail={openPanelDetail} />
                </>
              )}
              {activeMode === "extractor" && selectedExtractorResult && (
                <section className="floatingArtifact" aria-label="Selected extraction output">
                  <div className="artifactTop">
                    <div>
                      <span>{[selectedExtractorResult.sourceType, selectedExtractorResult.ragProfile, formatRunDurationMeta(selectedExtractorResult.runDurationMs, uiLanguage)].filter(Boolean).join(" · ")}</span>
                      <strong>{selectedExtractorResult.geoProduct.name}</strong>
                    </div>
                    <div className="windowActions">
                      {(["result", "logs"] as ExtractorOutputView[]).map((view) => (
                        <button className={extractorOutputView === view ? "active" : ""} type="button" key={view} onClick={() => setExtractorOutputView(view)}>
                          <span>{view}</span>
                        </button>
                      ))}
                      <button
                        className={`modalCopyButton${isExtractorFloatingCopied ? " copied" : ""}`}
                        type="button"
                        onClick={() => void copyArtifactText(extractorOutputText, extractorFloatingCopyTarget)}
                        aria-label={isExtractorFloatingCopied ? modalCopiedLabel : text.artifact.copyAria}
                        title={isExtractorFloatingCopied ? modalCopiedLabel : text.artifact.copyAria}
                      >
                        {isExtractorFloatingCopied ? <CheckCircle2 size={14} /> : <Copy size={14} />}
                        <span className="modalCopyLabel" aria-live="polite">
                          {isExtractorFloatingCopied ? modalCopiedLabel : text.artifact.copy}
                        </span>
                      </button>
                    </div>
                  </div>
                  <pre>{extractorOutputText}</pre>
                </section>
              )}
              {activeMode === "magazine" && selectedMagazineResult && (
                <>
                  <section className="floatingArtifact" aria-label="Selected magazine output">
                    <div className="artifactTop">
                      <div>
                        <span>{[
                          selectedMagazineResult.magazine.artifact.surface,
                          `readiness ${selectedMagazineResult.magazine.diagnostics.geoCitationReadiness.score}`,
                          selectedMagazineResult.magazine.artifact.flairSuggestion,
                          formatRunDurationMeta(selectedMagazineResult.runDurationMs, uiLanguage)
                        ].filter(Boolean).join(" · ")}</span>
                        <strong>{selectedMagazineResult.magazine.artifact.title}</strong>
                      </div>
                      <div className="windowActions">
                        {(["reddit", "readiness", "diagnostics"] as MagazineOutputView[]).map((view) => (
                          <button className={magazineOutputView === view ? "active" : ""} type="button" key={view} onClick={() => setMagazineOutputView(view)}>
                            <span>{view === "diagnostics" ? "diag" : view}</span>
                          </button>
                        ))}
                        <button
                          className={`modalCopyButton${isMagazineFloatingCopied ? " copied" : ""}`}
                          type="button"
                          onClick={() => void copyArtifactText(magazineOutputText, magazineFloatingCopyTarget)}
                          aria-label={isMagazineFloatingCopied ? modalCopiedLabel : text.artifact.copyAria}
                          title={isMagazineFloatingCopied ? modalCopiedLabel : text.artifact.copyAria}
                        >
                          {isMagazineFloatingCopied ? <CheckCircle2 size={14} /> : <Copy size={14} />}
                          <span className="modalCopyLabel" aria-live="polite">
                            {isMagazineFloatingCopied ? modalCopiedLabel : text.artifact.copy}
                          </span>
                        </button>
                      </div>
                    </div>
                    <pre>{magazineOutputText}</pre>
                  </section>
                  <MagazineQualityIntroMessage uiLanguage={uiLanguage} />
                  <MagazineQualityEvaluationPanel result={selectedMagazineResult} uiLanguage={uiLanguage} onOpenDetail={openPanelDetail} />
                </>
              )}
            </section>
          )}

          {isStatusPanelOpen && (
            <aside className="statusPanel" aria-label="Progress">
              <div className="progressTitle">
                <span>
                  {text.panel.progress}
                  {processProgressLabel && <small>{processProgressLabel}</small>}
                </span>
                <em className={`processBadge ${activeRunStatus}`}>{runSummary}</em>
                <button
                  className="resultCycleButton"
                  type="button"
                  disabled={activeMode === "extractor" ? extractorResults.length <= 1 : activeMode === "magazine" ? magazineResults.length <= 1 : results.length <= 1}
                  onClick={() => {
                    if (activeMode === "extractor") {
                      setSelectedExtractorIndex((current) => (current + 1) % extractorResults.length);
                      return;
                    }
                    if (activeMode === "magazine") {
                      setSelectedMagazineIndex((current) => (current + 1) % magazineResults.length);
                      return;
                    }
                    setSelectedIndex((current) => (current + 1) % results.length);
                  }}
                  aria-label={text.panel.nextResult}
                >
                  <ChevronRight size={14} />
                </button>
              </div>

              {activeMode === "extractor" ? (
                <>
                  <ProcessGroup title={text.panel.extractor} steps={extractorOnlyPanelSteps} fallback={getExtractorSteps(uiLanguage)} runtimeProcess={activeExtractorPipelineProcess} uiLanguage={uiLanguage} group="extractor" skippedMessage={text.artifact.skipped} onOpenDetail={openPanelDetail} />

                  <div className="panelDivider" />
                  <div className="panelBlock">
                    <span>{text.panel.output}</span>
                    {selectedExtractorResult ? (
                      <>
                        <div className="outputTabs" role="tablist" aria-label="Output view">
                          {(["result", "logs"] as ExtractorOutputView[]).map((view) => (
                            <button className={extractorOutputView === view ? "active" : ""} type="button" key={view} onClick={() => setExtractorOutputView(view)}>
                              {view}
                            </button>
                          ))}
                        </div>
                        {extractorOutputView === "logs" ? (
                          <ExtractorDiagnosticLog diagnostics={selectedExtractorLog} text={text} uiLanguage={uiLanguage} onOpenDetail={openPanelDetail} />
                        ) : (
                          <ExtractorOutputSummary result={selectedExtractorResult} text={text} uiLanguage={uiLanguage} onOpenDetail={openPanelDetail} />
                        )}
                        <button
                          className={`copyPanelButton${isExtractorPanelCopied ? " copied" : ""}`}
                          type="button"
                          onClick={() => void copyArtifactText(extractorOutputText, extractorPanelCopyTarget)}
                          aria-label={isExtractorPanelCopied ? modalCopiedLabel : text.artifact.copyAria}
                        >
                          {isExtractorPanelCopied ? <CheckCircle2 size={13} /> : <Copy size={13} />}
                          <span aria-live="polite">{isExtractorPanelCopied ? modalCopiedLabel : text.artifact.copy}</span>
                        </button>
                      </>
                    ) : selectedExtractorLog ? (
                      <>
                        <div className="outputTabs" role="tablist" aria-label="Output view">
                          <button className="active" type="button">
                            logs
                          </button>
                        </div>
                        <ExtractorDiagnosticLog diagnostics={selectedExtractorLog} text={text} uiLanguage={uiLanguage} onOpenDetail={openPanelDetail} />
                      </>
                    ) : activeExtractorPipelineProcess ? (
                      <strong>
                        {uiLanguage === "ko"
                          ? `${activeExtractorPipelineProcess.sourceCount}개 입력 처리 중${processProgressLabel ? ` · ${processProgressLabel}` : ""}`
                          : `${activeExtractorPipelineProcess.sourceCount} input${activeExtractorPipelineProcess.sourceCount === 1 ? "" : "s"} running${processProgressLabel ? ` · ${processProgressLabel}` : ""}`}
                      </strong>
                    ) : (
                      <strong>{text.panel.noDiagnostics}</strong>
                    )}
                  </div>
                </>
              ) : activeMode === "magazine" ? (
                <>
                  <ProcessGroup title={text.panel.extractor} steps={magazineExtractorPanelSteps} fallback={getExtractorSteps(uiLanguage)} runtimeProcess={activeMagazinePipelineProcess} skipped={activeMagazinePipelineProcess?.skipExtractor ?? selectedMagazineResult?.sourceType === "manual-json"} uiLanguage={uiLanguage} group="extractor" skippedMessage={text.artifact.skipped} onOpenDetail={openPanelDetail} />
                  <div className="panelDivider" />
                  <ProcessGroup
                    title={text.panel.magazine}
                    steps={magazinePanelSteps}
                    fallback={getMagazineSteps(uiLanguage)}
                    runtimeProcess={activeMagazinePipelineProcess}
                    uiLanguage={uiLanguage}
                    group="magazine"
                    skippedMessage={text.artifact.skipped}
                    onOpenDetail={openPanelDetail}
                    createStepDetail={(step, status, localized) => createMagazineProcessPanelDetail(step, status, localized, selectedMagazineResult, selectedMagazineDiagnostics, selectedMagazineLog, uiLanguage)}
                  />

                  <div className="panelDivider" />
                  <div className="panelBlock">
                    <span>{text.panel.output}</span>
                    {selectedMagazineResult ? (
                      <>
                        <div className="outputTabs three" role="tablist" aria-label="Output view">
                          {(["reddit", "readiness", "diagnostics"] as MagazineOutputView[]).map((view) => (
                            <button className={magazineOutputView === view ? "active" : ""} type="button" key={view} title={view} onClick={() => setMagazineOutputView(view)}>
                              {compactMagazineOutputViewLabel(view)}
                            </button>
                          ))}
                        </div>
                        {magazineOutputView === "diagnostics" ? (
                          <MagazineDiagnosticLog diagnostics={selectedMagazineDiagnostics} process={selectedMagazineLog?.magazineProcess} text={text} uiLanguage={uiLanguage} onOpenDetail={openPanelDetail} />
                        ) : (
                          <MagazineOutputSummary result={selectedMagazineResult} view={magazineOutputView} text={text} uiLanguage={uiLanguage} onOpenDetail={openPanelDetail} />
                        )}
                        <button
                          className={`copyPanelButton${isMagazinePanelCopied ? " copied" : ""}`}
                          type="button"
                          onClick={() => void copyArtifactText(magazineOutputText, magazinePanelCopyTarget)}
                          aria-label={isMagazinePanelCopied ? modalCopiedLabel : text.artifact.copyAria}
                        >
                          {isMagazinePanelCopied ? <CheckCircle2 size={13} /> : <Copy size={13} />}
                          <span aria-live="polite">{isMagazinePanelCopied ? modalCopiedLabel : text.artifact.copy}</span>
                        </button>
                      </>
                    ) : selectedMagazineDiagnostics ? (
                      <>
                        <div className="outputTabs" role="tablist" aria-label="Output view">
                          <button className="active" type="button">
                            diagnostics
                          </button>
                        </div>
                        <MagazineDiagnosticLog diagnostics={selectedMagazineDiagnostics} process={selectedMagazineLog?.magazineProcess} text={text} uiLanguage={uiLanguage} onOpenDetail={openPanelDetail} />
                      </>
                    ) : activePipelineProcess ? (
                      <strong>
                        {uiLanguage === "ko"
                          ? `${activeMagazinePipelineProcess?.sourceCount ?? 0}개 입력 처리 중${processProgressLabel ? ` · ${processProgressLabel}` : ""}`
                          : `${activeMagazinePipelineProcess?.sourceCount ?? 0} input${activeMagazinePipelineProcess?.sourceCount === 1 ? "" : "s"} running${processProgressLabel ? ` · ${processProgressLabel}` : ""}`}
                      </strong>
                    ) : (
                      <strong>{text.panel.noDiagnostics}</strong>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <ProcessGroup title={text.panel.extractor} steps={extractorPanelSteps} fallback={getExtractorSteps(uiLanguage)} runtimeProcess={activeGeneratorPipelineProcess} skipped={activeGeneratorPipelineProcess?.skipExtractor ?? selectedResult?.sourceType === "manual-json"} uiLanguage={uiLanguage} group="extractor" skippedMessage={text.artifact.skipped} onOpenDetail={openPanelDetail} />
                  <div className="panelDivider" />
                  <ProcessGroup
                    title={text.panel.generator}
                    steps={generatorPanelSteps}
                    fallback={getGeneratorSteps(uiLanguage)}
                    runtimeProcess={activeGeneratorPipelineProcess}
                    uiLanguage={uiLanguage}
                    group="generator"
                    skippedMessage={text.artifact.skipped}
                    onOpenDetail={openPanelDetail}
                    createStepDetail={(step, status, localized) => createGeneratorProcessPanelDetail(step, status, localized, selectedResult, selectedDiagnostics, selectedLog, uiLanguage)}
                  />

                  <div className="panelDivider" />
                  <div className="panelBlock">
                    <span>{text.panel.output}</span>
                    {selectedResult ? (
                  <>
                    <div className="outputTabs three" role="tablist" aria-label="Output view">
                      {(["schema", "content", "diagnostics"] as OutputView[]).map((view) => (
                        <button className={outputView === view ? "active" : ""} type="button" key={view} title={view} onClick={() => setOutputView(view)}>
                          {compactOutputViewLabel(view)}
                        </button>
                      ))}
                    </div>
                    {outputView === "diagnostics" ? (
                      <GeoDiagnosticLog diagnostics={selectedDiagnostics} process={selectedLog?.generatorProcess} text={text} uiLanguage={uiLanguage} onOpenDetail={openPanelDetail} />
                    ) : (
                      <GeoOutputSummary result={selectedResult} view={outputView} text={text} uiLanguage={uiLanguage} onOpenDetail={openPanelDetail} />
                    )}
                    <button
                      className={`copyPanelButton${isGeneratorPanelCopied ? " copied" : ""}`}
                      type="button"
                      onClick={() => void copyArtifactText(generatorOutputText, generatorPanelCopyTarget)}
                      aria-label={isGeneratorPanelCopied ? modalCopiedLabel : text.artifact.copyAria}
                    >
                      {isGeneratorPanelCopied ? <CheckCircle2 size={13} /> : <Copy size={13} />}
                      <span aria-live="polite">{isGeneratorPanelCopied ? modalCopiedLabel : text.artifact.copy}</span>
                    </button>
                  </>
                ) : selectedDiagnostics ? (
                  <>
                    <div className="outputTabs" role="tablist" aria-label="Output view">
                      <button className="active" type="button">
                        diagnostics
                      </button>
                    </div>
                    <GeoDiagnosticLog diagnostics={selectedDiagnostics} process={selectedLog?.generatorProcess} text={text} uiLanguage={uiLanguage} onOpenDetail={openPanelDetail} />
                  </>
                ) : activePipelineProcess ? (
                  <strong>
                    {uiLanguage === "ko"
                      ? `${activeGeneratorPipelineProcess?.sourceCount ?? 0}개 입력 처리 중${processProgressLabel ? ` · ${processProgressLabel}` : ""}`
                      : `${activeGeneratorPipelineProcess?.sourceCount ?? 0} input${activeGeneratorPipelineProcess?.sourceCount === 1 ? "" : "s"} running${processProgressLabel ? ` · ${processProgressLabel}` : ""}`}
                  </strong>
                ) : (
                  <strong>{text.panel.noDiagnostics}</strong>
                )}
                  </div>
                </>
              )}

              <div className="panelDivider" />
              <div className="panelBlock">
                <span>{text.panel.source}</span>
                <div className="sourceList">
                  {panelSources.length > 0 ? (
                    panelSources.map((source) => (
                      isHttpUrl(source) ? (
                        <a key={source} href={source} target="_blank" rel="noreferrer" title={source}>
                          <Globe2 size={14} />
                          <span>{formatPanelSource(source)}</span>
                          <ExternalLink size={12} />
                        </a>
                      ) : (
                        <button key={source} type="button" title={source}>
                          <Globe2 size={14} />
                          <span>{formatPanelSource(source)}</span>
                        </button>
                      )
                    ))
                  ) : (
                    <strong>{text.panel.noSource}</strong>
                  )}
                </div>
                <div className="ragReferenceHeader">
                  <span>{text.panel.ragReferences}</span>
                  <em>{panelRagReferences.length}</em>
                </div>
                {panelRagReferences.length > 0 ? (
                  <div className="ragReferenceList">
                    {panelRagReferences.map((reference) => (
                      <button key={reference.id} type="button" onClick={() => setSelectedRagReference(reference)} title={reference.title}>
                        <FileText size={14} />
                        <span className="ragReferenceContent">
                          <strong>{reference.title}</strong>
                          <em>{formatRagReferenceListMeta(reference)}</em>
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <strong>{text.panel.noRagReferences}</strong>
                )}
              </div>
            </aside>
          )}
        </div>

        <div className="composerDock">
          <div
            className={`composer ${isDragActive ? "dragActive" : ""} ${composerAttachments.length > 0 ? "hasAttachments" : ""}`}
            onDragLeave={handleComposerDragLeave}
            onDragOver={handleComposerDragOver}
            onDrop={(event) => {
              void handleComposerDrop(event);
            }}
          >
            <input
              ref={fileInputRef}
              className="fileInput"
              type="file"
              accept=".txt,.csv,.json,.md,text/plain,text/csv,application/json"
              multiple
              onChange={(event) => {
                void handleFileInput(event);
              }}
            />
            {isDragActive && (
              <div className="dropHint">
                <FileCode2 size={17} />
                <span>{text.composer.dropHint}</span>
              </div>
            )}
            {composerAttachments.length > 0 && (
              <div className="attachmentTray" aria-label={text.composer.attachmentLabel}>
                {composerAttachments.map((attachment) => (
                  <div
                    className={`attachmentChip ${attachment.productCount === 0 && attachment.sourceCount === 0 ? "empty" : ""}`}
                    key={attachment.id}
                    title={`${attachment.name} · ${
                      attachment.kind === "json"
                        ? text.composer.jsonSummary(attachment.productCount)
                        : attachment.sourceCount > 0
                          ? text.composer.sourceSummary(attachment.sourceCount)
                          : text.composer.emptySummary
                    }`}
                  >
                    <FileText size={14} />
                    <span>
                      <strong>{attachment.name}</strong>
                      <em>
                        {attachment.kind === "json"
                          ? text.composer.jsonSummary(attachment.productCount)
                          : attachment.sourceCount > 0
                            ? text.composer.sourceSummary(attachment.sourceCount)
                            : text.composer.emptySummary}
                      </em>
                    </span>
                    <button
                      type="button"
                      aria-label={text.composer.removeAttachment(attachment.name)}
                      title={text.composer.removeAttachment(attachment.name)}
                      onClick={() => removeComposerAttachment(attachment.id)}
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              aria-label={activeMode === "extractor" ? "PDP extractor input" : activeMode === "magazine" ? "GEO magazine input" : "PDP GEO input"}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setComposerStatus("");
              }}
              placeholder={workspaceComposerPlaceholder(activeMode, uiLanguage)}
              rows={composerAttachments.length > 0 ? 1 : 4}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <div className="composerBar">
              <div className="composerTools">
                <button
                  type="button"
                  title={text.composer.attach}
                  aria-label={text.composer.attach}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Plus size={18} />
                </button>
              </div>
              {composerStatus && <span className="composerStatus">{composerStatus}</span>}
              <div className="composerTools right">
                <button className="sendButton" type="button" disabled={!canSubmitComposer || activeRunStatus === "running"} onClick={() => void submit()} aria-label={text.composer.submit}>
                  {activeRunStatus === "running" ? <Loader2 className="spin" size={17} /> : <Send size={17} />}
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {isSettingsOpen && (
        <div className="settingsOverlay" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <div className="settingsModal">
            <aside className="settingsSidebar" aria-label="Settings navigation">
              <button className="backToApp" type="button" onClick={() => setIsSettingsOpen(false)}>
                <ArrowLeft size={15} />
                {text.settings.back}
              </button>
              <label className="settingsSearch">
                <Search size={14} />
                <input placeholder={text.settings.search} readOnly />
              </label>
              <div className="settingsGroup">
                <span>{text.settings.group}</span>
                <button className={settingsTab === "run" ? "active" : ""} type="button" onClick={() => setSettingsTab("run")}>
                  <Globe2 size={15} />
                  {text.settings.run}
                </button>
                <button className={settingsTab === "ai" ? "active" : ""} type="button" onClick={() => setSettingsTab("ai")}>
                  <PlugZap size={15} />
                  {text.settings.ai}
                </button>
                <button className={settingsTab === "rag" ? "active" : ""} type="button" onClick={() => setSettingsTab("rag")}>
                  <Database size={15} />
                  {text.settings.rag}
                </button>
              </div>
            </aside>

            <section className="settingsContent">
              <div className="settingsTopbar">
                <div>
                  <h2 id="settings-title">{settingsTitle}</h2>
                  <p>{settingsDescription}</p>
                </div>
                <button type="button" aria-label={text.settings.close} onClick={() => setIsSettingsOpen(false)}>
                  <X size={18} />
                </button>
              </div>

              {settingsTab === "run" && (
                <>
                  <section className="settingsSection">
                    <h3>{text.settings.inputSection}</h3>
                    <div className="providerGrid">
                      {(["auto", "url", "restApi", "manual-json"] as SourceMode[]).map((mode) => (
                        <button className={sourceMode === mode ? "active" : ""} type="button" key={mode} onClick={() => setSourceMode(mode)}>
                          <span className="providerOptionText">
                            <strong>{sourceModeLabel(mode, text)}</strong>
                            <em>{sourceModeDescription(mode, text)}</em>
                          </span>
                          <Circle size={14} />
                        </button>
                      ))}
                    </div>
                  </section>

                  <section className="settingsSection">
                    <h3>{text.settings.localeSection}</h3>
                    <div className="providerGrid">
                      {(["ko-KR", "ja-JP", "en-US", "en-GB"] as PdpGeoLocale[]).map((item) => (
                        <button className={locale === item ? "active" : ""} type="button" key={item} onClick={() => setLocale(item)}>
                          <span className="providerOptionText">
                            <strong>{text.localeLabels[item]}</strong>
                            <em>{item} · {marketForLocale(item)}</em>
                          </span>
                          <Circle size={14} />
                        </button>
                      ))}
                    </div>
                  </section>

                  <section className="settingsSection">
                    <h3>{text.settings.headersSection}</h3>
                    <label className="settingTextarea">
                      <span>{text.settings.headersLabel}</span>
                      <textarea
                        value={headersJson}
                        rows={6}
                        spellCheck={false}
                        onChange={(event) => setHeadersJson(event.target.value)}
                      />
                    </label>
                    <div className="settingsCard">
                      <strong>{text.settings.headersLabel}</strong>
                      <p>{text.settings.headersHelp}</p>
                    </div>
                  </section>

                  <div className="settingsActions">
                    <button
                      className={runSettingsFeedback === "reset" ? "confirmed" : ""}
                      type="button"
                      onClick={resetRunSettings}
                    >
                      {runSettingsFeedback === "reset" && <CheckCircle2 size={14} />}
                      <span>{runSettingsFeedback === "reset" ? text.settings.resetDone : text.settings.reset}</span>
                    </button>
                    <button
                      className={`primary${runSettingsFeedback === "saved" ? " confirmed" : ""}`}
                      type="button"
                      onClick={saveRunSettings}
                    >
                      {runSettingsFeedback === "saved" && <CheckCircle2 size={14} />}
                      <span>{runSettingsFeedback === "saved" ? text.settings.saved : text.settings.saveRun}</span>
                    </button>
                  </div>
                </>
              )}

              {settingsTab === "ai" && (
                <>
                  <div className={`connectionBanner ${connectionStatus}`} role={connectionStatus === "error" ? "alert" : "status"}>
                    <span className="connectionIcon" aria-hidden="true">
                      <KeyRound size={16} />
                    </span>
                    <div className="connectionCopy">
                      <div className="connectionHeader">
                        <strong>{activeProviderLabel}</strong>
                        <em>{connectionStatusLabel(connectionStatus, uiLanguage)}</em>
                      </div>
                      <p>{connectionMessage || providerInitialMessage(uiLanguage)}</p>
                    </div>
                  </div>

                  <section className="settingsSection">
                    <h3>{text.settings.aiProviderSection}</h3>
                    <div className="providerGrid">
                      {(["mock", "openai", "gemini", "azure-openai", "aistudio"] as ProviderId[]).map((provider) => (
                        <button
                          className={providerSettings.provider === provider ? "active" : ""}
                          key={provider}
                          type="button"
                          onClick={() => updateProviderSetting("provider", provider)}
                        >
                          <span className="providerOptionText">
                            <strong>{providerLabel(provider, uiLanguage)}</strong>
                            <em>{providerDescription(provider, uiLanguage)}</em>
                          </span>
                          <Circle size={14} />
                        </button>
                      ))}
                    </div>
                  </section>

                  <section className="settingsSection">
                    <h3>{text.settings.aiCredentialSection}</h3>
                    {providerSettings.provider === "mock" && (
                      <div className="settingsCard">
                        <strong>{providerLabel("mock", uiLanguage)}</strong>
                        <p>{mockProviderMessage(uiLanguage)}</p>
                      </div>
                    )}

                    {providerSettings.provider === "openai" && (
                      <div className="settingsFields">
                        <SettingField
                          label="OpenAI API Key"
                          type="password"
                          value={providerSettings.openaiApiKey}
                          placeholder="sk-... or OPENAI_API_KEY=..."
                          onChange={(value) => updateProviderSetting("openaiApiKey", value)}
                        />
                        <ModelSelectField
                          label="Model"
                          value={providerSettings.openaiModel}
                          options={activeModelOptions}
                          status={modelLoadStatus}
                          message={modelMessage || modelIdleMessage(uiLanguage)}
                          placeholder={modelPlaceholder(uiLanguage)}
                          refreshLabel={text.settings.loadModels}
                          loadingLabel={text.settings.loadingModels}
                          onRefresh={() => {
                            void loadProviderModels();
                          }}
                          onChange={(value) => updateProviderSetting("openaiModel", value)}
                        />
                      </div>
                    )}

                    {providerSettings.provider === "gemini" && (
                      <div className="settingsFields">
                        <SettingField
                          label="Gemini API Key"
                          type="password"
                          value={providerSettings.geminiApiKey}
                          placeholder="AIza... or GEMINI_API_KEY=..."
                          onChange={(value) => updateProviderSetting("geminiApiKey", value)}
                        />
                        <ModelSelectField
                          label="Model"
                          value={providerSettings.geminiModel}
                          options={activeModelOptions}
                          status={modelLoadStatus}
                          message={modelMessage || modelIdleMessage(uiLanguage)}
                          placeholder={modelPlaceholder(uiLanguage)}
                          refreshLabel={text.settings.loadModels}
                          loadingLabel={text.settings.loadingModels}
                          onRefresh={() => {
                            void loadProviderModels();
                          }}
                          onChange={(value) => updateProviderSetting("geminiModel", value)}
                        />
                      </div>
                    )}

                    {providerSettings.provider === "azure-openai" && (
                      <AzureProviderSettings
                        deploymentListId="geo-generator-azure-deployments"
                        deploymentOptions={activeModelOptions}
                        loadingLabel={text.settings.loadingModels}
                        modelLoadStatus={modelLoadStatus}
                        modelMessage={modelMessage || modelIdleMessage(uiLanguage)}
                        onChange={updateProviderSetting}
                        onRefreshDeployments={() => {
                          void loadProviderModels();
                        }}
                        refreshLabel={text.settings.loadModels}
                        settings={providerSettings}
                      />
                    )}

                    {providerSettings.provider === "aistudio" && (
                      <AistudioProviderSettings
                        language={uiLanguage}
                        onChange={updateProviderSetting}
                        settings={providerSettings}
                      />
                    )}
                  </section>

                  <section className="settingsSection">
                    <h3>{text.settings.aiScopeSection}</h3>
                    <div className="settingsCard">
                      <strong>pdp-extractor-agent + pdp-geo-generator-agent + geo-citation-content-agent</strong>
                      <p>{aiScopeMessage(uiLanguage)}</p>
                    </div>
                  </section>

                  <div className="settingsActions">
                    <button
                      className={aiSettingsFeedback === "reset" ? "confirmed" : ""}
                      type="button"
                      disabled={aiSettingsAction !== null}
                      onClick={resetProviderSettings}
                      aria-live="polite"
                    >
                      {aiSettingsFeedback === "reset" && <CheckCircle2 size={14} />}
                      <span>{aiSettingsFeedback === "reset" ? text.settings.resetDone : text.settings.reset}</span>
                    </button>
                    <button
                      className={aiSettingsFeedback === "tested" ? "confirmed" : ""}
                      type="button"
                      disabled={aiSettingsAction !== null || !isProviderSettingsReady}
                      onClick={() => {
                        void testProviderConnection();
                      }}
                      aria-live="polite"
                    >
                      {aiSettingsAction === "test" && <Loader2 className="spin" size={14} />}
                      {aiSettingsFeedback === "tested" && <CheckCircle2 size={14} />}
                      <span>{aiSettingsAction === "test" ? text.settings.testingConnection : aiSettingsFeedback === "tested" ? text.settings.tested : text.settings.testConnection}</span>
                    </button>
                    <button
                      className={`primary${aiSettingsFeedback === "saved" ? " confirmed" : ""}`}
                      type="button"
                      disabled={aiSettingsAction !== null || !isProviderSettingsReady}
                      onClick={() => {
                        void saveProviderSettings();
                      }}
                      aria-live="polite"
                    >
                      {aiSettingsAction === "save" && <Loader2 className="spin" size={14} />}
                      {aiSettingsFeedback === "saved" && <CheckCircle2 size={14} />}
                      <span>{aiSettingsAction === "save" ? text.settings.saving : aiSettingsFeedback === "saved" ? text.settings.saved : text.settings.saveAndApply}</span>
                    </button>
                  </div>
                </>
              )}

              {settingsTab === "rag" && (
                <>
                  <div className="connectionBanner connected" role="status">
                    <span className="connectionIcon" aria-hidden="true">
                      <Database size={16} />
                    </span>
                    <div className="connectionCopy">
                      <div className="connectionHeader">
                        <strong>{ragTargetLabel(selectedRagTarget, uiLanguage)}</strong>
                        <em>{ragModeLabels[ragMode]}</em>
                      </div>
                      <p>{ragMessage || ragInitialMessage(uiLanguage)}</p>
                    </div>
                  </div>

                  <section className="settingsSection">
                    <h3>{text.settings.ragModeSection}</h3>
                    <div className="providerGrid">
                      {(["local-versioned-rag", "managed-vector-store-rag"] as PdpGeoRagMode[]).map((mode) => (
                        <button className={ragMode === mode ? "active" : ""} type="button" key={mode} onClick={() => setRagMode(mode)}>
                          <span className="providerOptionText">
                            <strong>{ragModeLabels[mode]}</strong>
                            <em>{mode === "local-versioned-rag" ? "provider-neutral" : "adapter"}</em>
                          </span>
                          <Circle size={14} />
                        </button>
                      ))}
                    </div>
                  </section>

                  <section className="settingsSection">
                    <h3>{text.settings.ragTargetSection}</h3>
                    <p className="settingsSectionHelp">{ragProfileSplitHelp(uiLanguage)}</p>
                    <div className="ragProfileTabs" role="tablist" aria-label={text.settings.ragTargetSection}>
                      {(["extractor", "generator"] as RagProfileTarget[]).map((target) => (
                        <button
                          aria-selected={selectedRagTarget === target}
                          className={selectedRagTarget === target ? "active" : ""}
                          role="tab"
                          type="button"
                          key={target}
                          onClick={() => selectRagTarget(target)}
                        >
                          <span className="providerOptionText">
                            <strong>{ragTargetLabel(target, uiLanguage)}</strong>
                            <em>{ragTargetDescription(target, uiLanguage)}</em>
                          </span>
                          <span className="ragTabMeta">{ragFileCountLabel(ragProfiles[target].files.length, uiLanguage)}</span>
                        </button>
                      ))}
                    </div>
                  </section>

                  <div className="ragWorkspace" role="tabpanel" aria-label={ragTargetLabel(selectedRagTarget, uiLanguage)}>
                    <div className="ragWorkspaceHeader">
                      <div>
                        <strong>{ragTargetLabel(selectedRagTarget, uiLanguage)}</strong>
                        <p>{ragTargetDescription(selectedRagTarget, uiLanguage)}</p>
                      </div>
                      <div className="ragWorkspaceStats" aria-label={ragFileBreakdownLabel(uiLanguage)}>
                        <span>{ragManagedCountLabel(selectedRagProfile.files.filter((file) => file.managed).length, uiLanguage)}</span>
                        <span>{ragCustomCountLabel(selectedRagProfile.files.filter((file) => !file.managed).length, uiLanguage)}</span>
                      </div>
                    </div>

                    <section className="settingsSection">
                      <h3>{text.settings.ragPromptSection}</h3>
                      <label className="settingTextarea">
                        <span>{selectedRagProfile.profile ?? ragTargetLabel(selectedRagTarget, uiLanguage)}</span>
                        <textarea
                          value={selectedRagProfile.analysisPrompt}
                          rows={8}
                          onChange={(event) => updateRagAnalysisPrompt(event.target.value)}
                        />
                      </label>
                    </section>

                    <section className="settingsSection">
                      <div className="ragFilesHeader">
                        <h3>{text.settings.ragFilesSection}</h3>
                        <button className="ragUploadButton" type="button" onClick={() => ragFileInputRef.current?.click()}>
                          <Plus size={16} />
                          {text.settings.attachRag}
                        </button>
                      </div>
                      <input
                        ref={ragFileInputRef}
                        className="fileInput"
                        type="file"
                        accept=".md,.txt,.json,.csv,text/markdown,text/plain,application/json,text/csv"
                        multiple
                        onChange={(event) => {
                          void handleRagFileInput(event);
                        }}
                      />
                      <div className="ragFileList" role="listbox" aria-label={text.settings.ragFilesSection}>
                        {selectedRagProfile.files.length === 0 ? (
                          <div className="settingsCard">
                            <strong>{text.settings.emptyRag}</strong>
                            <p>{text.settings.emptyRagHelp}</p>
                          </div>
                        ) : (
                          selectedRagProfile.files.map((file) => (
                            <article
                              aria-selected={selectedRagFile?.id === file.id}
                              className={`ragFileItem ${selectedRagFile?.id === file.id ? "active" : ""} ${!isRagFileEnabled(file) ? "disabled" : ""}`}
                              key={file.id}
                              onClick={() => setSelectedRagFileId(file.id)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  setSelectedRagFileId(file.id);
                                }
                              }}
                              role="option"
                              tabIndex={0}
                            >
                              <FileText size={16} />
                              <div>
                                <strong>{file.name}</strong>
                                <span>
                                  {isRagFileEnabled(file) ? ragEnabledLabel(uiLanguage) : ragDisabledLabel(uiLanguage)} · {file.managed ? managedLabel(uiLanguage) : customLabel(uiLanguage)} · {file.version} · {formatFileSize(file.size)} · {file.content.length.toLocaleString()} chars · {formatDate(file.addedAt, uiLanguage)}
                                </span>
                              </div>
                              <label className="ragFileVersionControl" onClick={(event) => event.stopPropagation()}>
                                <span>Version</span>
                                <input
                                  aria-label={`${file.name} version`}
                                  value={file.version}
                                  onChange={(event) => updateRagFileVersion(file.id, event.target.value)}
                                />
                              </label>
                              <button
                                className="ragFileUseButton"
                                type="button"
                                aria-pressed={isRagFileEnabled(file)}
                                aria-label={`${file.name} ${isRagFileEnabled(file) ? ragEnabledLabel(uiLanguage) : ragDisabledLabel(uiLanguage)}`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  toggleRagFileEnabled(file.id);
                                }}
                              >
                                {isRagFileEnabled(file) ? ragEnabledLabel(uiLanguage) : ragDisabledLabel(uiLanguage)}
                              </button>
                              {!file.managed && (
                                <button
                                  type="button"
                                  aria-label={`${file.name} remove`}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    removeRagFile(file.id);
                                  }}
                                >
                                  <Trash2 size={15} />
                                </button>
                              )}
                            </article>
                          ))
                        )}
                      </div>
                    </section>

                    {selectedRagFile && (
                      <section className="settingsSection">
                        <h3>{text.settings.ragContentSection}</h3>
                        <label className="settingTextarea">
                          <span>{selectedRagFile.name}</span>
                          <textarea
                            value={selectedRagFile.content}
                            rows={9}
                            spellCheck={false}
                            onChange={(event) => updateRagFileContent(selectedRagFile.id, event.target.value)}
                          />
                        </label>
                      </section>
                    )}

                    <div className="settingsActions">
                      <button
                        className={ragSettingsFeedback === "reset" ? "confirmed" : ""}
                        type="button"
                        disabled={ragSettingsAction !== null}
                        onClick={() => {
                          void resetRagProfileSettings();
                        }}
                        aria-live="polite"
                      >
                        {ragSettingsAction === "reset" && <Loader2 className="spin" size={14} />}
                        {ragSettingsFeedback === "reset" && <CheckCircle2 size={14} />}
                        <span>{ragSettingsAction === "reset" ? text.settings.resetting : ragSettingsFeedback === "reset" ? text.settings.resetDone : text.settings.reset}</span>
                      </button>
                      <button
                        className={`primary${ragSettingsFeedback === "saved" ? " confirmed" : ""}`}
                        type="button"
                        disabled={ragSettingsAction !== null}
                        onClick={() => {
                          void saveRagProfileSettings();
                        }}
                        aria-live="polite"
                      >
                        {ragSettingsAction === "save" && <Loader2 className="spin" size={14} />}
                        {ragSettingsFeedback === "saved" && <CheckCircle2 size={14} />}
                        <span>{ragSettingsAction === "save" ? text.settings.saving : ragSettingsFeedback === "saved" ? text.settings.saved : text.settings.saveRag}</span>
                      </button>
                    </div>
                  </div>
                </>
              )}
            </section>
          </div>
        </div>
      )}

      {selectedPanelDetail && (
        <div className="ragReferenceOverlay" role="dialog" aria-modal="true" aria-labelledby="panel-detail-title">
          <section className="ragReferenceModal panelDetailModal">
            <header>
              <div>
                <span>{selectedPanelDetail.label}</span>
                <h2 id="panel-detail-title">{selectedPanelDetail.title}</h2>
                {selectedPanelDetail.subtitle && <p>{selectedPanelDetail.subtitle}</p>}
              </div>
              <div className="windowActions">
                <button
                  className={`modalCopyButton${copiedModalTarget === "panel-detail" ? " copied" : ""}`}
                  type="button"
                  onClick={() => void copyModalText(selectedPanelDetail.text, "panel-detail")}
                  aria-label={copiedModalTarget === "panel-detail" ? modalCopiedLabel : text.artifact.copyAria}
                >
                  {copiedModalTarget === "panel-detail" ? <CheckCircle2 size={15} /> : <Copy size={15} />}
                  <span className="modalCopyLabel" aria-live="polite">
                    {copiedModalTarget === "panel-detail" ? modalCopiedLabel : text.artifact.copy}
                  </span>
                </button>
                <button type="button" onClick={closePanelDetail} aria-label={uiLanguage === "ko" ? "상세 닫기" : "Close detail"}>
                  <X size={17} />
                </button>
              </div>
            </header>
            {selectedPanelDetail.metadata && Object.keys(selectedPanelDetail.metadata).length > 0 && (
              <dl className="ragReferenceMeta">
                {Object.entries(selectedPanelDetail.metadata).slice(0, 8).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{String(value)}</dd>
                  </div>
                ))}
              </dl>
            )}
            <pre>{selectedPanelDetail.text}</pre>
          </section>
        </div>
      )}

      {selectedRagReference && (
        <div className="ragReferenceOverlay" role="dialog" aria-modal="true" aria-labelledby="rag-reference-title">
          <section className="ragReferenceModal">
            <header>
              <div>
                <span>{text.panel.ragModalTitle}</span>
                <h2 id="rag-reference-title">{selectedRagReference.title}</h2>
                <p>{formatRagReferenceMeta(selectedRagReference)}</p>
                {selectedRagReference.usage && <p>{selectedRagReference.usage}</p>}
              </div>
              <div className="windowActions">
                <button
                  className={`modalCopyButton${copiedModalTarget === "rag-reference" ? " copied" : ""}`}
                  type="button"
                  onClick={() => void copyModalText(selectedRagReference.text, "rag-reference")}
                  aria-label={copiedModalTarget === "rag-reference" ? modalCopiedLabel : text.artifact.copyAria}
                >
                  {copiedModalTarget === "rag-reference" ? <CheckCircle2 size={15} /> : <Copy size={15} />}
                  <span className="modalCopyLabel" aria-live="polite">
                    {copiedModalTarget === "rag-reference" ? modalCopiedLabel : text.artifact.copy}
                  </span>
                </button>
                <button type="button" onClick={closeRagReference} aria-label={text.panel.closeRagModal}>
                  <X size={17} />
                </button>
              </div>
            </header>
            {selectedRagReference.metadata && Object.keys(selectedRagReference.metadata).length > 0 && (
              <dl className="ragReferenceMeta">
                {Object.entries(selectedRagReference.metadata).slice(0, 8).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{String(value)}</dd>
                  </div>
                ))}
              </dl>
            )}
            <pre>{selectedRagReference.text}</pre>
          </section>
        </div>
      )}

    </main>
  );
}

function ResultArtifact({ result, text }: { result: GeoGeneratorResult; text: (typeof uiCopy)[UiLanguage] }) {
  return (
    <div className="resultArtifact">
      <div className="artifactTop">
        <div>
          <span>{text.artifact.label}</span>
          <strong>{result.generator.content.sections.productName}</strong>
        </div>
        <button
          className="artifactCopyButton"
          type="button"
          onClick={() => copyText(JSON.stringify({
            schemaMarkup: result.generator.schemaMarkup,
            content: result.generator.content
          }, null, 2))}
        >
          <Copy size={14} />
          <span>{text.artifact.copy}</span>
        </button>
      </div>
      <pre>{JSON.stringify({
        schemaMarkup: result.generator.schemaMarkup,
        content: result.generator.content
      }, null, 2)}</pre>
    </div>
  );
}

function GeoOutputSummary({
  onOpenDetail,
  result,
  text,
  uiLanguage,
  view
}: Readonly<{
  onOpenDetail: (detail: PanelDetail) => void;
  result: GeoGeneratorResult;
  text: (typeof uiCopy)[UiLanguage];
  uiLanguage: UiLanguage;
  view: OutputView;
}>) {
  const diagnostics = result.generator.diagnostics;
  const sections = result.generator.content.sections;
  const productName = sections.productName || diagnostics.normalizedProduct.name;
  const runDuration = formatRunDurationValue(result.runDurationMs);

  if (view === "content") {
    return (
      <div className="outputSummary">
        <strong>{productName}</strong>
        <div className="outputMetricGrid">
          {runDuration && (
            <OutputMetricButton
              label={uiLanguage === "ko" ? "소요" : "Elapsed"}
              value={runDuration}
              detail={createPanelDetail("Run detail", uiLanguage === "ko" ? "최종 실행 시간" : "Final run time", productName, {
                runDurationMs: result.runDurationMs,
                runDuration
              }, {
                durationMs: result.runDurationMs ?? 0
              })}
              onOpenDetail={onOpenDetail}
            />
          )}
          <OutputMetricButton
            label={uiLanguage === "ko" ? "섹션" : "Sections"}
            value={countContentSections(sections)}
            detail={createPanelDetail("Content detail", uiLanguage === "ko" ? "Content 섹션" : "Content sections", productName, sections, {
              sections: countContentSections(sections)
            })}
            onOpenDetail={onOpenDetail}
          />
          <OutputMetricButton
            label="FAQ"
            value={countTextItems(sections.faq)}
            detail={createPanelDetail("Content detail", "FAQ", productName, sections.faq, {
              items: countTextItems(sections.faq)
            })}
            onOpenDetail={onOpenDetail}
          />
          <OutputMetricButton
            label="HowTo"
            value={countTextItems(sections.howToUse)}
            detail={createPanelDetail("Content detail", "HowTo", productName, sections.howToUse, {
              steps: countTextItems(sections.howToUse)
            })}
            onOpenDetail={onOpenDetail}
          />
          <OutputMetricButton
            label="HTML"
            value={formatCompactNumber(result.generator.content.html.length)}
            detail={createPanelDetail("Content detail", "HTML", productName, result.generator.content.html, {
              length: result.generator.content.html.length
            })}
            onOpenDetail={onOpenDetail}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="outputSummary">
      <strong>{productName}</strong>
      <div className="outputMetricGrid">
        {runDuration && (
          <OutputMetricButton
            label={uiLanguage === "ko" ? "소요" : "Elapsed"}
            value={runDuration}
            detail={createPanelDetail("Run detail", uiLanguage === "ko" ? "최종 실행 시간" : "Final run time", productName, {
              runDurationMs: result.runDurationMs,
              runDuration
            }, {
              durationMs: result.runDurationMs ?? 0
            })}
            onOpenDetail={onOpenDetail}
          />
        )}
        <OutputMetricButton
          label="Schema"
          value={countSchemaNodes(result.generator.schemaMarkup.jsonLd)}
          detail={createPanelDetail("Output detail", "Schema", productName, result.generator.schemaMarkup, {
            nodes: countSchemaNodes(result.generator.schemaMarkup.jsonLd)
          })}
          onOpenDetail={onOpenDetail}
        />
        <OutputMetricButton
          label={uiLanguage === "ko" ? "추천" : "Reco."}
          value={diagnostics.recommendations.length}
          detail={createPanelDetail("Diagnostics detail", text.panel.recommendations, productName, diagnostics.recommendations, {
            count: diagnostics.recommendations.length
          })}
          onOpenDetail={onOpenDetail}
        />
        <OutputMetricButton
          label={text.panel.evidence}
          value={diagnostics.evidence.length}
          detail={createPanelDetail("Diagnostics detail", text.panel.evidence, productName, diagnostics.evidence, {
            count: diagnostics.evidence.length
          })}
          onOpenDetail={onOpenDetail}
        />
        <OutputMetricButton
          label="RAG"
          value={diagnostics.selectedRagChunks.length}
          detail={createPanelDetail("RAG detail", "Selected RAG", productName, {
            selectedRagChunks: diagnostics.selectedRagChunks,
            ragUsage: diagnostics.ragUsage ?? [],
            reasoning: diagnostics.reasoning
          }, {
            chunks: diagnostics.selectedRagChunks.length,
            usage: diagnostics.ragUsage?.length ?? 0
          })}
          onOpenDetail={onOpenDetail}
        />
      </div>
    </div>
  );
}

function MagazineOutputSummary({
  onOpenDetail,
  result,
  text,
  uiLanguage,
  view
}: Readonly<{
  onOpenDetail: (detail: PanelDetail) => void;
  result: MagazineGeneratorResult;
  text: (typeof uiCopy)[UiLanguage];
  uiLanguage: UiLanguage;
  view: MagazineOutputView;
}>) {
  const artifact = result.magazine.artifact;
  const diagnostics = result.magazine.diagnostics;
  const readiness = diagnostics.geoCitationReadiness;
  const productName = diagnostics.normalizedProduct.name;
  const runDuration = formatRunDurationValue(result.runDurationMs);

  if (view === "readiness") {
    const passedChecks = readiness.checks.filter((check) => check.passed).length;
    return (
      <div className="outputSummary">
        <strong>{uiLanguage === "ko" ? "GEO citation readiness" : "GEO citation readiness"}</strong>
        <div className="outputMetricGrid">
          <OutputMetricButton
            label="Score"
            value={readiness.score}
            detail={createPanelDetail("Magazine readiness", "GEO citation readiness", productName, readiness, {
              score: readiness.score,
              passed: readiness.passed
            })}
            onOpenDetail={onOpenDetail}
          />
          <OutputMetricButton
            label={uiLanguage === "ko" ? "통과" : "Passed"}
            value={`${passedChecks}/${readiness.checks.length}`}
            detail={createPanelDetail("Magazine readiness", uiLanguage === "ko" ? "Readiness checks" : "Readiness checks", productName, readiness.checks, {
              passed: passedChecks,
              total: readiness.checks.length
            })}
            onOpenDetail={onOpenDetail}
          />
          <OutputMetricButton
            label="Keywords"
            value={`${readiness.keywordCoverage.present.length}/${readiness.keywordCoverage.required.length}`}
            detail={createPanelDetail("Magazine readiness", "Keyword coverage", productName, readiness.keywordCoverage, {
              coverage: Math.round(readiness.keywordCoverage.coverageRatio * 100)
            })}
            onOpenDetail={onOpenDetail}
          />
          <OutputMetricButton
            label={uiLanguage === "ko" ? "경고" : "Warnings"}
            value={readiness.warnings.length}
            detail={createPanelDetail("Magazine readiness", uiLanguage === "ko" ? "Readiness warnings" : "Readiness warnings", productName, readiness.warnings, {
              warnings: readiness.warnings.length
            })}
            onOpenDetail={onOpenDetail}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="outputSummary">
      <strong>{artifact.title}</strong>
      <div className="outputMetricGrid">
        {runDuration && (
          <OutputMetricButton
            label={uiLanguage === "ko" ? "소요" : "Elapsed"}
            value={runDuration}
            detail={createPanelDetail("Run detail", uiLanguage === "ko" ? "최종 실행 시간" : "Final run time", productName, {
              runDurationMs: result.runDurationMs,
              runDuration
            }, {
              durationMs: result.runDurationMs ?? 0
            })}
            onOpenDetail={onOpenDetail}
          />
        )}
        <OutputMetricButton
          label="Body"
          value={formatCompactNumber(artifact.bodyMarkdown.length)}
          detail={createPanelDetail("Magazine output", "Reddit bodyMarkdown", artifact.title, artifact.bodyMarkdown, {
            length: artifact.bodyMarkdown.length
          })}
          onOpenDetail={onOpenDetail}
        />
        <OutputMetricButton
          label="Answers"
          value={result.magazine.brief.answerChunks.length}
          detail={createPanelDetail("Magazine brief", "AI answer chunks", productName, result.magazine.brief.answerChunks, {
            chunks: result.magazine.brief.answerChunks.length
          })}
          onOpenDetail={onOpenDetail}
        />
        <OutputMetricButton
          label={text.panel.evidence}
          value={diagnostics.usedEvidence.length}
          detail={createPanelDetail("Magazine diagnostics", text.panel.evidence, productName, diagnostics.usedEvidence, {
            evidence: diagnostics.usedEvidence.length
          })}
          onOpenDetail={onOpenDetail}
        />
        <OutputMetricButton
          label="RAG"
          value={diagnostics.selectedRagChunks.length}
          detail={createPanelDetail("Magazine RAG", "Selected evidence chunks", productName, {
            selectedRagChunks: diagnostics.selectedRagChunks,
            ragUsage: diagnostics.ragUsage
          }, {
            chunks: diagnostics.selectedRagChunks.length
          })}
          onOpenDetail={onOpenDetail}
        />
      </div>
      <span>{uiLanguage === "ko" ? "홍보 톤 점수" : "Promotional tone"}: {diagnostics.promotionalToneScore}</span>
    </div>
  );
}

function GeoQualityEvaluationPanel({
  onOpenDetail,
  result,
  uiLanguage
}: Readonly<{
  onOpenDetail: (detail: PanelDetail) => void;
  result: GeoGeneratorResult;
  uiLanguage: UiLanguage;
}>) {
  const [copied, setCopied] = useState(false);

  if (countSchemaNodes(result.generator.schemaMarkup.jsonLd) === 0) {
    return null;
  }

  const evaluation = evaluateGeoQuality(result, uiLanguage);
  const copy = getGeoQualityCopy(uiLanguage);
  const copyTextValue = formatGeoQualityEvaluationText(result, evaluation, copy);

  async function copyEvaluation() {
    await copyText(copyTextValue);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <section className="geoQualityPanel" aria-label={copy.panelLabel}>
      <div className="geoQualityHeader">
        <div>
          <span>{copy.kicker}</span>
          <strong>{copy.title}</strong>
        </div>
        <div className="geoQualityHeaderActions">
          <em>{evaluation.overallScore}/100</em>
          <button
            className={`geoQualityCopyButton${copied ? " copied" : ""}`}
            type="button"
            onClick={() => void copyEvaluation()}
            aria-label={copied ? copy.copyDoneLabel : copy.copyLabel}
            title={copied ? copy.copyDoneLabel : copy.copyLabel}
          >
            {copied ? <CheckCircle2 size={14} /> : <Copy size={14} />}
          </button>
          {copied && (
            <span className="geoQualityCopyFeedback" role="status" aria-live="polite">
              {copy.copyDoneLabel}
            </span>
          )}
        </div>
      </div>
      <div className="geoQualityScoreGrid" aria-label={copy.summaryLabel}>
        {evaluation.dimensions.map((dimension) => (
          <button
            className="geoQualityScoreButton"
            type="button"
            key={dimension.id}
            onClick={() => onOpenDetail(createPanelDetail(copy.detailLabel, `${dimension.label} ${dimension.score}/100`, dimension.criteria, {
              criteria: dimension.criteria,
              summary: dimension.summary,
              evidence: dimension.evidence,
              improvements: dimension.improvements,
              validationDetails: evaluation.validationDetails,
              validationImprovements: evaluation.validationImprovements
            }, {
              score: dimension.score
            }))}
          >
            <span>{dimension.label}</span>
            <strong>{dimension.score}</strong>
            <small>{dimension.summary}</small>
          </button>
        ))}
      </div>
      <details className="geoQualityDetails" open>
        <summary>{copy.detailSummary}</summary>
        <div className="geoQualityDimensionList">
          {evaluation.dimensions.map((dimension) => (
            <section className="geoQualityDimension" key={dimension.id}>
              <div className="geoQualityDimensionTitle">
                <strong>{dimension.label}</strong>
                <em>{dimension.score}/100</em>
              </div>
              <p>{dimension.criteria}</p>
              <div className="geoQualityEvidenceColumns">
                <div>
                  <span>{copy.evidenceLabel}</span>
                  <ul>
                    {dimension.evidence.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <span>{copy.improvementLabel}</span>
                  <ul>
                    {dimension.improvements.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </section>
          ))}
          {(evaluation.validationDetails.length > 0 || evaluation.validationImprovements.length > 0) && (
            <section className="geoQualityDimension">
              <div className="geoQualityDimensionTitle">
                <strong>{copy.validationDetailLabel}</strong>
                <em>{evaluation.validationDetails.length}</em>
              </div>
              <p>{copy.validationDetailDescription}</p>
              <div className="geoQualityEvidenceColumns">
                {evaluation.validationDetails.length > 0 && (
                  <div>
                    <span>{copy.validationIssueLabel}</span>
                    <ul>
                      {evaluation.validationDetails.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {evaluation.validationImprovements.length > 0 && (
                  <div>
                    <span>{copy.validationDirectionLabel}</span>
                    <ul>
                      {evaluation.validationImprovements.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </section>
          )}
        </div>
      </details>
    </section>
  );
}

function GeoQualityIntroMessage({
  uiLanguage
}: Readonly<{
  uiLanguage: UiLanguage;
}>) {
  const copy = getGeoQualityCopy(uiLanguage);
  return (
    <article className="chatBlock agent geoQualityIntroMessage">
      <div className="commandLine">
        <CheckCircle2 size={14} />
        <span>{copy.kicker}</span>
      </div>
      <p>{copy.sequenceNote}</p>
    </article>
  );
}

function MagazineQualityIntroMessage({
  uiLanguage
}: Readonly<{
  uiLanguage: UiLanguage;
}>) {
  const copy = getMagazineQualityCopy(uiLanguage);
  return (
    <article className="chatBlock agent geoQualityIntroMessage">
      <div className="commandLine">
        <CheckCircle2 size={14} />
        <span>{copy.kicker}</span>
      </div>
      <p>{copy.sequenceNote}</p>
    </article>
  );
}

function MagazineQualityEvaluationPanel({
  onOpenDetail,
  result,
  uiLanguage
}: Readonly<{
  onOpenDetail: (detail: PanelDetail) => void;
  result: MagazineGeneratorResult;
  uiLanguage: UiLanguage;
}>) {
  const [copied, setCopied] = useState(false);
  const evaluation = evaluateMagazineQuality(result, uiLanguage);
  const copy = getMagazineQualityCopy(uiLanguage);
  const copyTextValue = formatMagazineQualityEvaluationText(result, evaluation, copy);

  async function copyEvaluation() {
    await copyText(copyTextValue);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <section className="geoQualityPanel" aria-label={copy.panelLabel}>
      <div className="geoQualityHeader">
        <div>
          <span>{copy.kicker}</span>
          <strong>{copy.title}</strong>
        </div>
        <div className="geoQualityHeaderActions">
          <em>{evaluation.overallScore}/100</em>
          <button
            className={`geoQualityCopyButton${copied ? " copied" : ""}`}
            type="button"
            onClick={() => void copyEvaluation()}
            aria-label={copied ? copy.copyDoneLabel : copy.copyLabel}
            title={copied ? copy.copyDoneLabel : copy.copyLabel}
          >
            {copied ? <CheckCircle2 size={14} /> : <Copy size={14} />}
          </button>
          {copied && (
            <span className="geoQualityCopyFeedback" role="status" aria-live="polite">
              {copy.copyDoneLabel}
            </span>
          )}
        </div>
      </div>
      <div className="geoQualityScoreGrid" aria-label={copy.summaryLabel}>
        {evaluation.dimensions.map((dimension) => (
          <button
            className="geoQualityScoreButton"
            type="button"
            key={dimension.id}
            onClick={() => onOpenDetail(createPanelDetail(copy.detailLabel, `${dimension.label} ${dimension.score}/100`, dimension.criteria, {
              criteria: dimension.criteria,
              summary: dimension.summary,
              evidence: dimension.evidence,
              improvements: dimension.improvements,
              validationDetails: evaluation.validationDetails,
              validationImprovements: evaluation.validationImprovements
            }, {
              score: dimension.score
            }))}
          >
            <span>{dimension.label}</span>
            <strong>{dimension.score}</strong>
            <small>{dimension.summary}</small>
          </button>
        ))}
      </div>
      <details className="geoQualityDetails" open>
        <summary>{copy.detailSummary}</summary>
        <div className="geoQualityDimensionList">
          {evaluation.dimensions.map((dimension) => (
            <section className="geoQualityDimension" key={dimension.id}>
              <div className="geoQualityDimensionTitle">
                <strong>{dimension.label}</strong>
                <em>{dimension.score}/100</em>
              </div>
              <p>{dimension.criteria}</p>
              <div className="geoQualityEvidenceColumns">
                <div>
                  <span>{copy.evidenceLabel}</span>
                  <ul>
                    {dimension.evidence.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <span>{copy.improvementLabel}</span>
                  <ul>
                    {dimension.improvements.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </section>
          ))}
          {(evaluation.validationDetails.length > 0 || evaluation.validationImprovements.length > 0) && (
            <section className="geoQualityDimension">
              <div className="geoQualityDimensionTitle">
                <strong>{copy.validationDetailLabel}</strong>
                <em>{evaluation.validationDetails.length}</em>
              </div>
              <p>{copy.validationDetailDescription}</p>
              <div className="geoQualityEvidenceColumns">
                {evaluation.validationDetails.length > 0 && (
                  <div>
                    <span>{copy.validationIssueLabel}</span>
                    <ul>
                      {evaluation.validationDetails.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {evaluation.validationImprovements.length > 0 && (
                  <div>
                    <span>{copy.validationDirectionLabel}</span>
                    <ul>
                      {evaluation.validationImprovements.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </section>
          )}
        </div>
      </details>
    </section>
  );
}

function formatMagazineQualityEvaluationText(
  result: MagazineGeneratorResult,
  evaluation: MagazineQualityEvaluation,
  copy: ReturnType<typeof getMagazineQualityCopy>
): string {
  const productName = result.magazine.diagnostics.normalizedProduct.name;
  const lines = [
    copy.title,
    `${copy.productLabel}: ${productName}`,
    `${copy.overallScoreLabel}: ${evaluation.overallScore}/100`,
    ""
  ];

  for (const dimension of evaluation.dimensions) {
    lines.push(`${dimension.label}: ${dimension.score}/100`);
    lines.push(`${copy.criteriaLabel}: ${dimension.criteria}`);
    lines.push(`${copy.summaryLabel}: ${dimension.summary}`);
    lines.push(`${copy.evidenceLabel}:`);
    lines.push(...dimension.evidence.map((item) => `- ${item}`));
    lines.push(`${copy.improvementLabel}:`);
    lines.push(...dimension.improvements.map((item) => `- ${item}`));
    lines.push("");
  }

  if (evaluation.validationDetails.length > 0 || evaluation.validationImprovements.length > 0) {
    lines.push(copy.validationDetailLabel);
    if (evaluation.validationDetails.length > 0) {
      lines.push(`${copy.validationIssueLabel}:`);
      lines.push(...evaluation.validationDetails.map((item) => `- ${item}`));
    }
    if (evaluation.validationImprovements.length > 0) {
      lines.push(`${copy.validationDirectionLabel}:`);
      lines.push(...evaluation.validationImprovements.map((item) => `- ${item}`));
    }
  }

  return lines.join("\n").trim();
}

function formatGeoQualityEvaluationText(
  result: GeoGeneratorResult,
  evaluation: GeoQualityEvaluation,
  copy: ReturnType<typeof getGeoQualityCopy>
): string {
  const productName = result.generator.content.sections.productName;
  const lines = [
    copy.title,
    `${copy.productLabel}: ${productName}`,
    `${copy.overallScoreLabel}: ${evaluation.overallScore}/100`,
    ""
  ];

  for (const dimension of evaluation.dimensions) {
    lines.push(`${dimension.label}: ${dimension.score}/100`);
    lines.push(`${copy.criteriaLabel}: ${dimension.criteria}`);
    lines.push(`${copy.summaryLabel}: ${dimension.summary}`);
    lines.push(`${copy.evidenceLabel}:`);
    lines.push(...dimension.evidence.map((item) => `- ${item}`));
    lines.push(`${copy.improvementLabel}:`);
    lines.push(...dimension.improvements.map((item) => `- ${item}`));
    lines.push("");
  }

  if (evaluation.validationDetails.length > 0 || evaluation.validationImprovements.length > 0) {
    lines.push(copy.validationDetailLabel);
    if (evaluation.validationDetails.length > 0) {
      lines.push(`${copy.validationIssueLabel}:`);
      lines.push(...evaluation.validationDetails.map((item) => `- ${item}`));
    }
    if (evaluation.validationImprovements.length > 0) {
      lines.push(`${copy.validationDirectionLabel}:`);
      lines.push(...evaluation.validationImprovements.map((item) => `- ${item}`));
    }
  }

  return lines.join("\n").trim();
}

function ExtractorOutputSummary({
  onOpenDetail,
  result,
  text,
  uiLanguage
}: Readonly<{
  onOpenDetail: (detail: PanelDetail) => void;
  result: TimedProductExtractionResult;
  text: (typeof uiCopy)[UiLanguage];
  uiLanguage: UiLanguage;
}>) {
  const product = result.geoProduct;
  const runDuration = formatRunDurationValue(result.runDurationMs);

  return (
    <div className="outputSummary">
      <strong>{product.name}</strong>
      <div className="outputMetricGrid">
        {runDuration && (
          <OutputMetricButton
            label={uiLanguage === "ko" ? "소요" : "Elapsed"}
            value={runDuration}
            detail={createPanelDetail("Run detail", uiLanguage === "ko" ? "최종 실행 시간" : "Final run time", product.name, {
              runDurationMs: result.runDurationMs,
              runDuration
            }, {
              durationMs: result.runDurationMs ?? 0
            })}
            onOpenDetail={onOpenDetail}
          />
        )}
        <OutputMetricButton
          label={uiLanguage === "ko" ? "리뷰 키워드" : "Review keys"}
          value={product.reviews.keywords.length}
          detail={createPanelDetail("Extractor detail", uiLanguage === "ko" ? "리뷰 신호" : "Review signals", product.name, product.reviews, {
            keywords: product.reviews.keywords.length,
            reviews: product.reviews.items.length
          })}
          onOpenDetail={onOpenDetail}
        />
        <OutputMetricButton
          label={uiLanguage === "ko" ? "OCR 블록" : "OCR blocks"}
          value={product.ocr.textBlocks.length}
          detail={createPanelDetail("Extractor detail", uiLanguage === "ko" ? "OCR 블록" : "OCR blocks", product.name, product.ocr, {
            blocks: product.ocr.textBlocks.length
          })}
          onOpenDetail={onOpenDetail}
        />
        <OutputMetricButton
          label={uiLanguage === "ko" ? "HTML 분석" : "HTML sections"}
          value={product.contentAnalysis.sections.length}
          detail={createPanelDetail("Extractor detail", uiLanguage === "ko" ? "HTML 분석" : "HTML analysis", product.name, product.contentAnalysis, {
            sections: product.contentAnalysis.sections.length
          })}
          onOpenDetail={onOpenDetail}
        />
        <OutputMetricButton
          label="RAG"
          value={product.rag.chunks.length}
          detail={createPanelDetail("RAG detail", "Extractor RAG", product.name, product.rag, {
            chunks: product.rag.chunks.length
          })}
          onOpenDetail={onOpenDetail}
        />
      </div>
      <span>{text.panel.evidence}: {product.sourceExtraction.html.sections.length + product.sourceExtraction.ocr.textBlocks.length}</span>
    </div>
  );
}

function OutputMetricButton({
  detail,
  label,
  onOpenDetail,
  value
}: Readonly<{
  detail: PanelDetail;
  label: string;
  onOpenDetail: (detail: PanelDetail) => void;
  value: number | string;
}>) {
  return (
    <button className="outputMetricButton" type="button" onClick={() => onOpenDetail(detail)} title={detail.title}>
      <span>{label}</span>
      <strong>{value}</strong>
    </button>
  );
}

function createPanelDetail(
  label: string,
  title: string,
  subtitle: string | undefined,
  data: unknown,
  metadata?: Record<string, string | number | boolean>
): PanelDetail {
  return {
    label,
    title,
    subtitle,
    text: stringifyPanelData(data),
    metadata
  };
}

function createGeneratorProcessPanelDetail(
  step: ProcessStep,
  status: ProcessStep["status"],
  localized: Pick<ProcessStep, "title" | "description">,
  result: GeoGeneratorResult | undefined,
  diagnostics: PdpGeoDiagnostics | undefined,
  log: GeoGeneratorLog | undefined,
  uiLanguage: UiLanguage
): PanelDetail | undefined {
  if (!diagnostics) {
    return undefined;
  }

  const stageId = String(step.id);
  const validationRepairs = diagnostics.validationRepairs ?? [];
  const stageBase = {
    id: step.id,
    title: step.title,
    localized,
    status,
    message: step.message,
    startedAt: "startedAt" in step ? step.startedAt : undefined,
    completedAt: "completedAt" in step ? step.completedAt : undefined
  };
  const baseMetadata = {
    id: stageId,
    status
  };

  if (stageId === "validate" || stageId === "repair") {
    const firstRepair = validationRepairs[0];
    const title = localized.title;
    const subtitle = firstRepair
      ? `${validationRepairs.length}개 보정 · ${firstRepair.field}: ${firstRepair.issue}`
      : diagnostics.validationWarnings.length > 0
        ? `${diagnostics.validationWarnings.length}개 경고 · ${diagnostics.validationWarnings[0]}`
        : (uiLanguage === "ko" ? "검증/보정 변경 없음" : "No validation or repair change");

    return createPanelDetail("Generator process", title, subtitle, {
      stage: stageBase,
      summary: {
        warningCount: diagnostics.validationWarnings.length,
        repairCount: validationRepairs.length,
        firstIssue: firstRepair?.issue,
        firstAction: firstRepair?.action
      },
      brokenDataAndRepairs: validationRepairs.map((repair, index) => ({
        index: index + 1,
        field: repair.field,
        source: repair.source,
        issue: repair.issue,
        action: repair.action,
        before: repair.before,
        after: repair.after,
        evidence: repair.evidence ?? []
      })),
      warnings: diagnostics.validationWarnings,
      repairEvidence: diagnostics.evidence.filter((item) => item.source === "repair" || item.source === "schema-validator" || item.source === "html-validator"),
      finalArtifacts: result
        ? {
          schemaNodeCount: countSchemaNodes(result.generator.schemaMarkup.jsonLd),
          contentSections: result.generator.content.sections,
          htmlLength: result.generator.content.html.length
        }
        : undefined
    }, {
      ...baseMetadata,
      warnings: diagnostics.validationWarnings.length,
      repairs: validationRepairs.length
    });
  }

  if (stageId === "retrieve" || stageId === "rerank") {
    return createPanelDetail("Generator process", localized.title, localized.description, {
      stage: stageBase,
      queryIntents: diagnostics.reasoning?.queryIntents ?? [],
      selectedRagChunks: diagnostics.selectedRagChunks.map((chunk) => ({
        id: chunk.id,
        source: chunk.source,
        title: chunk.title,
        kind: chunk.kind,
        score: chunk.score,
        intents: chunk.intents ?? [],
        fieldTargets: chunk.fieldTargets ?? [],
        excerpt: chunk.text.slice(0, 360)
      })),
      ragUsage: diagnostics.ragUsage ?? [],
      reasoning: diagnostics.reasoning
    }, {
      ...baseMetadata,
      chunks: diagnostics.selectedRagChunks.length,
      ragUsage: diagnostics.ragUsage?.length ?? 0
    });
  }

  if (stageId === "generate") {
    return createPanelDetail("Generator process", localized.title, localized.description, {
      stage: stageBase,
      generatedFrom: {
        normalizedProduct: diagnostics.normalizedProduct,
        ragUsage: diagnostics.ragUsage ?? [],
        ocrSentences: diagnostics.ocrSentences
      },
      generatedEvidence: diagnostics.evidence.filter((item) => item.source === "rag" || item.source === "terminology"),
      recommendations: diagnostics.recommendations,
      output: result
        ? {
          schemaMarkup: result.generator.schemaMarkup,
          content: result.generator.content
        }
        : undefined
    }, {
      ...baseMetadata,
      recommendations: diagnostics.recommendations.length,
      evidence: diagnostics.evidence.length
    });
  }

  if (stageId === "normalize") {
    return createPanelDetail("Generator process", localized.title, localized.description, {
      stage: stageBase,
      normalizedProduct: diagnostics.normalizedProduct,
      sourceEvidence: diagnostics.evidence.filter((item) => item.source === "input" || item.source === "fieldMapping" || item.source === "llm"),
      ocrSentences: diagnostics.ocrSentences
    }, {
      ...baseMetadata,
      evidence: diagnostics.evidence.length,
      ocrSentences: diagnostics.ocrSentences.length
    });
  }

  if (stageId === "artifact") {
    return createPanelDetail("Generator process", localized.title, localized.description, {
      stage: stageBase,
      result: result?.generator,
      diagnostics,
      process: log?.generatorProcess ?? []
    }, {
      ...baseMetadata,
      schemaNodes: result ? countSchemaNodes(result.generator.schemaMarkup.jsonLd) : 0,
      evidence: diagnostics.evidence.length
    });
  }

  return createPanelDetail("Generator process", localized.title, localized.description, {
    stage: stageBase,
    diagnosticsSummary: {
      recommendations: diagnostics.recommendations.length,
      evidence: diagnostics.evidence.length,
      selectedRagChunks: diagnostics.selectedRagChunks.length,
      validationWarnings: diagnostics.validationWarnings.length,
      validationRepairs: validationRepairs.length
    },
    process: log?.generatorProcess ?? []
  }, baseMetadata);
}

function createMagazineProcessPanelDetail(
  step: ProcessStep,
  status: ProcessStep["status"],
  localized: Pick<ProcessStep, "title" | "description">,
  result: MagazineGeneratorResult | undefined,
  diagnostics: GeoCitationDiagnostics | undefined,
  log: MagazineGeneratorLog | undefined,
  uiLanguage: UiLanguage
): PanelDetail | undefined {
  if (!diagnostics) {
    return undefined;
  }

  const stageId = String(step.id);
  const stageBase = {
    id: step.id,
    title: step.title,
    localized,
    status,
    message: step.message,
    startedAt: "startedAt" in step ? step.startedAt : undefined,
    completedAt: "completedAt" in step ? step.completedAt : undefined
  };
  const baseMetadata = {
    id: stageId,
    status
  };

  if (stageId === "validate" || stageId === "repair") {
    return createPanelDetail("Magazine process", localized.title, localized.description, {
      stage: stageBase,
      readiness: diagnostics.geoCitationReadiness,
      unsupportedClaims: diagnostics.unsupportedClaims,
      channelWarnings: diagnostics.channelWarnings,
      validationWarnings: diagnostics.validationWarnings,
      promotionalToneScore: diagnostics.promotionalToneScore,
      artifact: result?.magazine.artifact
    }, {
      ...baseMetadata,
      warnings: diagnostics.validationWarnings.length + diagnostics.channelWarnings.length,
      unsupportedClaims: diagnostics.unsupportedClaims.length
    });
  }

  if (stageId === "retrieve" || stageId === "rerank") {
    return createPanelDetail("Magazine process", localized.title, localized.description, {
      stage: stageBase,
      selectedRagChunks: diagnostics.selectedRagChunks,
      ragUsage: diagnostics.ragUsage,
      usedEvidence: diagnostics.usedEvidence
    }, {
      ...baseMetadata,
      chunks: diagnostics.selectedRagChunks.length,
      evidence: diagnostics.usedEvidence.length
    });
  }

  if (stageId === "brief") {
    return createPanelDetail("Magazine process", localized.title, localized.description, {
      stage: stageBase,
      brief: result?.magazine.brief,
      strategy: result?.magazine.strategy,
      variantStrategy: diagnostics.variantStrategy
    }, {
      ...baseMetadata,
      answerChunks: result?.magazine.brief.answerChunks.length ?? 0
    });
  }

  if (stageId === "generate") {
    return createPanelDetail("Magazine process", localized.title, localized.description, {
      stage: stageBase,
      artifact: result?.magazine.artifact,
      normalizedProduct: diagnostics.normalizedProduct,
      eeatSignals: result?.magazine.brief.eeatSignals,
      cepContexts: result?.magazine.brief.cepContexts
    }, {
      ...baseMetadata,
      readiness: diagnostics.geoCitationReadiness.score
    });
  }

  if (stageId === "normalize") {
    return createPanelDetail("Magazine process", localized.title, localized.description, {
      stage: stageBase,
      normalizedProduct: diagnostics.normalizedProduct,
      evidence: diagnostics.evidence.filter((item) => item.source === "input")
    }, {
      ...baseMetadata,
      evidence: diagnostics.evidence.length
    });
  }

  if (stageId === "artifact") {
    return createPanelDetail("Magazine process", localized.title, localized.description, {
      stage: stageBase,
      result: result?.magazine,
      diagnostics,
      process: log?.magazineProcess ?? []
    }, {
      ...baseMetadata,
      readiness: diagnostics.geoCitationReadiness.score,
      evidence: diagnostics.usedEvidence.length
    });
  }

  return createPanelDetail("Magazine process", localized.title, localized.description, {
    stage: stageBase,
    diagnosticsSummary: {
      readiness: diagnostics.geoCitationReadiness.score,
      recommendations: diagnostics.recommendations.length,
      evidence: diagnostics.evidence.length,
      selectedRagChunks: diagnostics.selectedRagChunks.length,
      channelWarnings: diagnostics.channelWarnings.length,
      validationWarnings: diagnostics.validationWarnings.length
    },
    process: log?.magazineProcess ?? []
  }, baseMetadata);
}

function stringifyPanelData(data: unknown): string {
  if (typeof data === "string") {
    return data.trim().length > 0 ? data : "(empty)";
  }

  return JSON.stringify(data, null, 2) ?? "(empty)";
}

type RuntimeUsageView = {
  steps?: RuntimeStepView[];
  tokenTotals?: TokenUsageView;
  tokenNote?: string;
};

type RuntimeStepView = {
  stage?: string;
  label?: string;
  provider?: string;
  service?: string;
  model?: string;
  deployment?: string;
  mode?: string;
  called?: boolean;
  tokenUsage?: TokenUsageView;
  details?: string;
};

type TokenUsageView = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

function PipelineUsageSummary({
  label,
  onOpenDetail,
  usage,
  uiLanguage
}: Readonly<{
  label: string;
  onOpenDetail: (detail: PanelDetail) => void;
  usage?: RuntimeUsageView;
  uiLanguage: UiLanguage;
}>) {
  const steps = usage?.steps ?? [];

  return (
    <div className="diagnosticSection">
      <strong>{uiLanguage === "ko" ? "사용 모델/검색 구성" : "Runtime pipeline"}</strong>
      {steps.length === 0 ? (
        <p>{uiLanguage === "ko" ? "기록된 모델/검색 구성이 없습니다." : "No runtime model/search usage recorded."}</p>
      ) : (
        steps.map((step, index) => (
          <button
            className="diagnosticEntryButton"
            key={`${step.stage ?? "stage"}-${step.label ?? index}`}
            type="button"
            onClick={() => onOpenDetail(createPanelDetail(label, step.label ?? step.stage ?? "Runtime step", formatRuntimeStepSummary(step, uiLanguage), step, {
              called: step.called ? "yes" : "no",
              stage: step.stage ?? "unknown",
              tokens: step.tokenUsage?.totalTokens ?? 0
            }))}
          >
            <b>{step.label ?? step.stage}</b>
            <span>{formatRuntimeStepSummary(step, uiLanguage)}</span>
          </button>
        ))
      )}
      {usage?.tokenNote && <p>{usage.tokenNote}</p>}
    </div>
  );
}

function formatRuntimeStepSummary(step: RuntimeStepView, uiLanguage: UiLanguage): string {
  const runtimeName = [step.provider, step.service].filter(Boolean).join(" · ") || (uiLanguage === "ko" ? "설정 없음" : "No provider");
  const modelName = step.deployment ? `deployment ${step.deployment}` : step.model ? `model ${step.model}` : step.mode ? `mode ${step.mode}` : "";
  const called = step.called ? (uiLanguage === "ko" ? "호출됨" : "called") : (uiLanguage === "ko" ? "구성만 표시" : "configured");
  const tokens = formatTokenUsage(step.tokenUsage, uiLanguage);
  return [runtimeName, modelName, called, tokens].filter(Boolean).join(" · ");
}

function formatTokenUsage(usage: TokenUsageView | undefined, uiLanguage: UiLanguage): string {
  if (!usage || (usage.inputTokens === undefined && usage.outputTokens === undefined && usage.totalTokens === undefined)) {
    return uiLanguage === "ko" ? "tokens 해당 없음" : "tokens n/a";
  }
  const total = usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
  const input = usage.inputTokens !== undefined ? `in ${formatCompactNumber(usage.inputTokens)}` : undefined;
  const output = usage.outputTokens !== undefined ? `out ${formatCompactNumber(usage.outputTokens)}` : undefined;
  return [`tokens ${formatCompactNumber(total)}`, input, output].filter(Boolean).join(" / ");
}

function formatTokenTotal(usage: RuntimeUsageView | undefined, uiLanguage: UiLanguage): string {
  return formatTokenUsage(usage?.tokenTotals, uiLanguage).replace(/^tokens\s*/i, "");
}

function ExtractorDiagnosticLog({
  diagnostics,
  onOpenDetail,
  text,
  uiLanguage
}: Readonly<{
  diagnostics?: ProductExtractionDiagnostics;
  onOpenDetail: (detail: PanelDetail) => void;
  text: (typeof uiCopy)[UiLanguage];
  uiLanguage: UiLanguage;
}>) {
  if (!diagnostics) {
    return <strong>{text.panel.noDiagnostics}</strong>;
  }

  const warnings = diagnostics.warnings.slice(0, 8);
  const evidence = diagnostics.evidence.slice(0, 8);
  const runtimeUsage = diagnostics.runtimeUsage;

  return (
    <div className="diagnosticLog">
      <div className="diagnosticStats">
        <button type="button" onClick={() => onOpenDetail(createPanelDetail("Extractor logs", "Pipeline usage", undefined, runtimeUsage ?? {}, { count: runtimeUsage?.steps.length ?? 0 }))}>pipeline {runtimeUsage?.steps.length ?? 0}</button>
        <button type="button" onClick={() => onOpenDetail(createPanelDetail("Extractor logs", "Token usage", runtimeUsage?.tokenNote, runtimeUsage?.tokenTotals ?? {}, { totalTokens: runtimeUsage?.tokenTotals?.totalTokens ?? 0 }))}>tokens {formatTokenTotal(runtimeUsage, uiLanguage)}</button>
        <button type="button" onClick={() => onOpenDetail(createPanelDetail("Extractor logs", "Process", undefined, diagnostics.process, { count: diagnostics.process.length }))}>process {diagnostics.process.length}</button>
        <button type="button" onClick={() => onOpenDetail(createPanelDetail("Extractor logs", uiLanguage === "ko" ? "경고" : "Warnings", undefined, diagnostics.warnings, { count: diagnostics.warnings.length }))}>warnings {diagnostics.warnings.length}</button>
        <button type="button" onClick={() => onOpenDetail(createPanelDetail("Extractor logs", text.panel.evidence, undefined, diagnostics.evidence, { count: diagnostics.evidence.length }))}>evidence {diagnostics.evidence.length}</button>
      </div>
      <PipelineUsageSummary label="Extractor pipeline" usage={runtimeUsage} uiLanguage={uiLanguage} onOpenDetail={onOpenDetail} />
      <div className="diagnosticSection">
        <strong>Process</strong>
        {diagnostics.process.length === 0 ? (
          <p>{uiLanguage === "ko" ? "진행 로그가 없습니다." : "No process log yet."}</p>
        ) : (
          diagnostics.process.map((step) => {
            const localized = localizeProcessStep(step, "extractor", uiLanguage);
            return (
              <button
                className="diagnosticEntryButton"
                key={step.id}
                type="button"
                onClick={() => onOpenDetail(createPanelDetail("Extractor process", localized.title, localized.description, {
                  ...step,
                  localized
                }, {
                  id: step.id,
                  status: step.status
                }))}
              >
                <b>{localized.title}</b>
                <span>{step.message ?? localized.description}</span>
              </button>
            );
          })
        )}
      </div>
      <div className="diagnosticSection">
        <strong>{uiLanguage === "ko" ? "경고" : "Warnings"}</strong>
        {warnings.length === 0 ? (
          <p>{uiLanguage === "ko" ? "경고가 없습니다." : "No warnings."}</p>
        ) : (
          warnings.map((warning) => (
            <button
              className="diagnosticEntryButton"
              key={`${warning.code}-${warning.message}`}
              type="button"
              onClick={() => onOpenDetail(createPanelDetail("Extractor warning", warning.code, warning.message, warning, {
                code: warning.code
              }))}
            >
              <b>{warning.code}</b>
              <span>{warning.message}</span>
            </button>
          ))
        )}
      </div>
      <div className="diagnosticSection">
        <strong>{text.panel.evidence}</strong>
        {evidence.length === 0 ? (
          <p>{text.panel.noEvidence}</p>
        ) : (
          evidence.map((item) => (
            <button
              className="diagnosticEntryButton"
              key={`${item.field}-${item.source}-${item.value.slice(0, 30)}`}
              type="button"
              onClick={() => onOpenDetail(createPanelDetail("Extractor evidence", `${item.field} · ${item.source}`, item.value, item, {
                field: item.field,
                source: item.source
              }))}
            >
              <b>{item.field} · {item.source}</b>
              <span>{item.value}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function ProcessGroup({
  createStepDetail,
  onOpenDetail,
  title,
  steps,
  fallback,
  runtimeProcess,
  skipped = false,
  uiLanguage,
  group,
  skippedMessage
}: {
  createStepDetail?: (step: ProcessStep, status: ProcessStep["status"], localized: Pick<ProcessStep, "title" | "description">) => PanelDetail | undefined;
  onOpenDetail: (detail: PanelDetail) => void;
  title: string;
  steps?: ProcessStep[];
  fallback: ProcessStep[];
  runtimeProcess?: GeoPipelineProcessState;
  skipped?: boolean;
  uiLanguage: UiLanguage;
  group: "extractor" | "generator" | "magazine";
  skippedMessage: string;
}) {
  const displaySteps = steps ?? fallback;

  return (
    <div className="panelBlock">
      <span>{title}</span>
      <ol className="processSteps">
        {displaySteps.map((step) => {
          const status = skipped ? "pending" : runtimeProcess ? getPipelineStepStatus(step.id, group, runtimeProcess) : step.status;
          const localized = localizeProcessStep(step, group, uiLanguage);
          return (
            <li className={`processStep ${status}`} key={`${title}-${step.id}`}>
              <button
                className="processStepButton"
                type="button"
                onClick={() => onOpenDetail(createStepDetail?.(step, status, localized) ?? createPanelDetail(`${title} log`, localized.title, skipped ? skippedMessage : localized.description, {
                  ...step,
                  status,
                  localized,
                  runtime: runtimeProcess
                    ? {
                      currentGroup: runtimeProcess.currentGroup,
                      currentStepId: runtimeProcess.currentStepId,
                      status: runtimeProcess.status,
                      activeSource: runtimeProcess.activeSource,
                      completedSourceCount: runtimeProcess.completedSourceCount,
                      sourceCount: runtimeProcess.sourceCount,
                      errorMessage: runtimeProcess.errorMessage
                    }
                    : undefined
                }, {
                  id: step.id,
                  group,
                  status
                }))}
              >
                <StepStatusIcon status={status} />
                <div>
                  <strong>{localized.title}</strong>
                  <span>{skipped ? skippedMessage : localized.description}</span>
                </div>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function GeoDiagnosticLog({
  diagnostics,
  onOpenDetail,
  process,
  text,
  uiLanguage
}: Readonly<{
  diagnostics?: PdpGeoDiagnostics;
  onOpenDetail: (detail: PanelDetail) => void;
  process?: PdpGeoGenerationStep[];
  text: (typeof uiCopy)[UiLanguage];
  uiLanguage: UiLanguage;
}>) {
  if (!diagnostics) {
    return <strong>{text.panel.noDiagnostics}</strong>;
  }

  const processItems = process?.length ? process : [];
  const recommendations = diagnostics.recommendations.slice(0, 8);
  const evidence = diagnostics.evidence.slice(0, 8);
  const ocrSentences = diagnostics.ocrSentences.slice(0, 6);
  const ragUsage = (diagnostics.ragUsage ?? []).slice(0, 6);
  const ragChunks = diagnostics.selectedRagChunks.slice(0, 6);
  const runtimeUsage = diagnostics.runtimeUsage;

  return (
    <div className="diagnosticLog">
      <div className="diagnosticStats">
        <button type="button" onClick={() => onOpenDetail(createPanelDetail("Generator diagnostics", "Pipeline usage", undefined, runtimeUsage ?? {}, { count: runtimeUsage?.steps.length ?? 0 }))}>pipeline {runtimeUsage?.steps.length ?? 0}</button>
        <button type="button" onClick={() => onOpenDetail(createPanelDetail("Generator diagnostics", "Token usage", runtimeUsage?.tokenNote, runtimeUsage?.tokenTotals ?? {}, { totalTokens: runtimeUsage?.tokenTotals?.totalTokens ?? 0 }))}>tokens {formatTokenTotal(runtimeUsage, uiLanguage)}</button>
        <button type="button" onClick={() => onOpenDetail(createPanelDetail("Generator logs", "Process", undefined, processItems, { count: processItems.length }))}>process {processItems.length}</button>
        <button type="button" onClick={() => onOpenDetail(createPanelDetail("Generator diagnostics", text.panel.recommendations, undefined, diagnostics.recommendations, { count: diagnostics.recommendations.length }))}>recommendations {diagnostics.recommendations.length}</button>
        <button type="button" onClick={() => onOpenDetail(createPanelDetail("Generator diagnostics", text.panel.evidence, undefined, diagnostics.evidence, { count: diagnostics.evidence.length }))}>evidence {diagnostics.evidence.length}</button>
        <button type="button" onClick={() => onOpenDetail(createPanelDetail("Generator diagnostics", "OCR sentence sources", undefined, diagnostics.ocrSentences, { count: diagnostics.ocrSentences.length }))}>OCR {diagnostics.ocrSentences.length}</button>
        <button type="button" onClick={() => onOpenDetail(createPanelDetail("Generator diagnostics", "RAG usage", undefined, diagnostics.ragUsage ?? [], { count: diagnostics.ragUsage?.length ?? 0 }))}>RAG usage {diagnostics.ragUsage?.length ?? 0}</button>
      </div>
      <PipelineUsageSummary label="Generator pipeline" usage={runtimeUsage} uiLanguage={uiLanguage} onOpenDetail={onOpenDetail} />
      <div className="diagnosticSection">
        <strong>Process</strong>
        {processItems.length === 0 ? (
          <p>{uiLanguage === "ko" ? "진행 로그가 없습니다." : "No process log yet."}</p>
        ) : (
          processItems.map((step) => {
            const localized = localizeProcessStep(step, "generator", uiLanguage);
            return (
              <button
                className="diagnosticEntryButton"
                key={step.id}
                type="button"
                onClick={() => onOpenDetail(createPanelDetail("Generator process", localized.title, step.message ?? localized.description, {
                  ...step,
                  localized
                }, {
                  id: step.id,
                  status: step.status
                }))}
              >
                <b>{localized.title}</b>
                <span>{step.message ?? localized.description}</span>
              </button>
            );
          })
        )}
      </div>
      <div className="diagnosticSection">
        <strong>{text.panel.recommendations}</strong>
        {recommendations.length === 0 ? (
          <p>{text.panel.noRecommendations}</p>
        ) : (
          recommendations.map((item) => (
            <button
              className="diagnosticEntryButton"
              key={`${item.field}-${item.message}-${item.reason}`}
              type="button"
              onClick={() => onOpenDetail(createPanelDetail("Generator recommendation", item.field, item.message, item, {
                field: item.field
              }))}
            >
              <b>{item.field}</b>
              <span>{item.reason}</span>
            </button>
          ))
        )}
      </div>
      <div className="diagnosticSection">
        <strong>{text.panel.evidence}</strong>
        {evidence.length === 0 ? (
          <p>{text.panel.noEvidence}</p>
        ) : (
          evidence.map((item) => (
            <button
              className="diagnosticEntryButton"
              key={`${item.field}-${item.source}-${item.value.slice(0, 30)}`}
              type="button"
              onClick={() => onOpenDetail(createPanelDetail("Generator evidence", `${item.field} · ${item.source}`, item.value, item, {
                field: item.field,
                source: item.source
              }))}
            >
              <b>{item.field} · {item.source}</b>
              <span>{item.value}</span>
            </button>
          ))
        )}
      </div>
      <div className="diagnosticSection">
        <strong>{uiLanguage === "ko" ? "OCR 문장 출처" : "OCR sentence sources"}</strong>
        {ocrSentences.length === 0 ? (
          <p>{uiLanguage === "ko" ? "OCR 문장 진단이 없습니다." : "No OCR sentence diagnostics."}</p>
        ) : (
          ocrSentences.map((item) => (
            <button
              className="diagnosticEntryButton"
              key={`${item.text}-${item.imageUrls?.join("|") ?? "unknown"}`}
              type="button"
              onClick={() => onOpenDetail(createPanelDetail("OCR sentence source", formatOcrSentenceSource(item, uiLanguage), item.text, item, {
                images: item.imageUrls?.length ?? 0,
                intents: item.intents.join(", ")
              }))}
            >
              <b>{formatOcrSentenceSource(item, uiLanguage)}</b>
              <span>{item.text}</span>
            </button>
          ))
        )}
      </div>
      <div className="diagnosticSection">
        <strong>{uiLanguage === "ko" ? "RAG 활용 판단" : "RAG usage"}</strong>
        {ragUsage.length > 0 ? (
          ragUsage.map((usage) => (
            <button
              className="diagnosticEntryButton"
              key={usage.principle}
              type="button"
              onClick={() => onOpenDetail(createPanelDetail("RAG usage", usage.principle, formatRagUsageTitle(usage), usage, {
                principle: usage.principle,
                confidence: Math.round(usage.confidence * 100) / 100,
                references: usage.references.length
              }))}
            >
              <b>{formatRagUsageTitle(usage)}</b>
              <span>{formatRagUsageBody(usage, uiLanguage)}</span>
            </button>
          ))
        ) : ragChunks.length === 0 ? (
          <p>{uiLanguage === "ko" ? "선택된 RAG chunk가 없습니다." : "No selected RAG chunks."}</p>
        ) : (
          ragChunks.map((chunk) => (
            <button
              className="diagnosticEntryButton"
              key={chunk.id}
              type="button"
              onClick={() => onOpenDetail(createPanelDetail("RAG chunk", chunk.title ?? chunk.source, `${chunk.kind} · ${chunk.source}`, chunk, {
                kind: chunk.kind,
                score: Math.round(chunk.score * 100) / 100
              }))}
            >
              <b>{chunk.kind} · {chunk.source}</b>
              <span>{chunk.title ?? chunk.text}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function MagazineDiagnosticLog({
  diagnostics,
  onOpenDetail,
  process,
  text,
  uiLanguage
}: Readonly<{
  diagnostics?: GeoCitationDiagnostics;
  onOpenDetail: (detail: PanelDetail) => void;
  process?: GeoCitationGenerationStep[];
  text: (typeof uiCopy)[UiLanguage];
  uiLanguage: UiLanguage;
}>) {
  if (!diagnostics) {
    return <strong>{text.panel.noDiagnostics}</strong>;
  }

  const processItems = process?.length ? process : [];
  const recommendations = diagnostics.recommendations.slice(0, 8);
  const evidence = diagnostics.evidence.slice(0, 8);
  const ragUsage = diagnostics.ragUsage.slice(0, 8);
  const readinessWarnings = diagnostics.geoCitationReadiness.warnings.slice(0, 8);

  return (
    <div className="diagnosticLog">
      <div className="diagnosticStats">
        <button type="button" onClick={() => onOpenDetail(createPanelDetail("Magazine diagnostics", "Runtime usage", undefined, diagnostics.runtimeUsage, { called: diagnostics.runtimeUsage.called ? "yes" : "no" }))}>runtime {diagnostics.runtimeUsage.called ? "called" : "mock"}</button>
        <button type="button" onClick={() => onOpenDetail(createPanelDetail("Magazine logs", "Process", undefined, processItems, { count: processItems.length }))}>process {processItems.length}</button>
        <button type="button" onClick={() => onOpenDetail(createPanelDetail("Magazine diagnostics", "Readiness", undefined, diagnostics.geoCitationReadiness, { score: diagnostics.geoCitationReadiness.score }))}>readiness {diagnostics.geoCitationReadiness.score}</button>
        <button type="button" onClick={() => onOpenDetail(createPanelDetail("Magazine diagnostics", text.panel.recommendations, undefined, diagnostics.recommendations, { count: diagnostics.recommendations.length }))}>recommendations {diagnostics.recommendations.length}</button>
        <button type="button" onClick={() => onOpenDetail(createPanelDetail("Magazine diagnostics", text.panel.evidence, undefined, diagnostics.evidence, { count: diagnostics.evidence.length }))}>evidence {diagnostics.evidence.length}</button>
        <button type="button" onClick={() => onOpenDetail(createPanelDetail("Magazine diagnostics", "RAG usage", undefined, diagnostics.ragUsage, { count: diagnostics.ragUsage.length }))}>RAG usage {diagnostics.ragUsage.length}</button>
      </div>
      <div className="diagnosticSection">
        <strong>Runtime</strong>
        <button
          className="diagnosticEntryButton"
          type="button"
          onClick={() => onOpenDetail(createPanelDetail("Magazine runtime", diagnostics.runtimeUsage.service, diagnostics.runtimeUsage.details, diagnostics.runtimeUsage, {
            provider: diagnostics.runtimeUsage.provider,
            called: diagnostics.runtimeUsage.called ? "yes" : "no"
          }))}
        >
          <b>{diagnostics.runtimeUsage.provider} · {diagnostics.runtimeUsage.service}</b>
          <span>{diagnostics.runtimeUsage.details}</span>
        </button>
      </div>
      <div className="diagnosticSection">
        <strong>Process</strong>
        {processItems.length === 0 ? (
          <p>{uiLanguage === "ko" ? "진행 로그가 없습니다." : "No process log yet."}</p>
        ) : (
          processItems.map((step) => {
            const localized = localizeProcessStep(step, "magazine", uiLanguage);
            return (
              <button
                className="diagnosticEntryButton"
                key={step.id}
                type="button"
                onClick={() => onOpenDetail(createPanelDetail("Magazine process", localized.title, step.message ?? localized.description, {
                  ...step,
                  localized
                }, {
                  id: step.id,
                  status: step.status
                }))}
              >
                <b>{localized.title}</b>
                <span>{step.message ?? localized.description}</span>
              </button>
            );
          })
        )}
      </div>
      <div className="diagnosticSection">
        <strong>Readiness</strong>
        {readinessWarnings.length === 0 ? (
          <p>{uiLanguage === "ko" ? "readiness 경고가 없습니다." : "No readiness warnings."}</p>
        ) : (
          readinessWarnings.map((warning) => (
            <button
              className="diagnosticEntryButton"
              key={warning}
              type="button"
              onClick={() => onOpenDetail(createPanelDetail("Magazine readiness", "Readiness warning", warning, warning))}
            >
              <b>{diagnostics.geoCitationReadiness.score}/100</b>
              <span>{warning}</span>
            </button>
          ))
        )}
      </div>
      <div className="diagnosticSection">
        <strong>{text.panel.recommendations}</strong>
        {recommendations.length === 0 ? (
          <p>{text.panel.noRecommendations}</p>
        ) : (
          recommendations.map((item) => (
            <button
              className="diagnosticEntryButton"
              key={`${item.field}-${item.message}-${item.reason}`}
              type="button"
              onClick={() => onOpenDetail(createPanelDetail("Magazine recommendation", item.field, item.message, item, {
                field: item.field
              }))}
            >
              <b>{item.field}</b>
              <span>{item.reason}</span>
            </button>
          ))
        )}
      </div>
      <div className="diagnosticSection">
        <strong>{text.panel.evidence}</strong>
        {evidence.length === 0 ? (
          <p>{text.panel.noEvidence}</p>
        ) : (
          evidence.map((item) => (
            <button
              className="diagnosticEntryButton"
              key={`${item.field}-${item.source}-${item.value.slice(0, 30)}`}
              type="button"
              onClick={() => onOpenDetail(createPanelDetail("Magazine evidence", `${item.field} · ${item.source}`, item.value, item, {
                field: item.field,
                source: item.source
              }))}
            >
              <b>{item.field} · {item.source}</b>
              <span>{item.value}</span>
            </button>
          ))
        )}
      </div>
      <div className="diagnosticSection">
        <strong>{uiLanguage === "ko" ? "RAG 활용 판단" : "RAG usage"}</strong>
        {ragUsage.length === 0 ? (
          <p>{uiLanguage === "ko" ? "선택된 RAG usage가 없습니다." : "No selected RAG usage."}</p>
        ) : (
          ragUsage.map((usage, index) => (
            <button
              className="diagnosticEntryButton"
              key={`${usage.source}-${usage.sourceType}-${usage.score}-${index}-${usage.usage.slice(0, 30)}`}
              type="button"
              onClick={() => onOpenDetail(createPanelDetail("Magazine RAG usage", `${usage.sourceType} · ${usage.source}`, usage.usage, usage, {
                score: Math.round(usage.score * 100) / 100,
                sourceType: usage.sourceType
              }))}
            >
              <b>{usage.sourceType} · score {usage.score.toFixed(2)}</b>
              <span>{usage.usage}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

type ProviderSettingUpdater = <Key extends keyof ProviderSettings>(key: Key, value: ProviderSettings[Key]) => void;

function AistudioProviderSettings({
  language,
  onChange,
  settings
}: Readonly<{
  language: UiLanguage;
  onChange: ProviderSettingUpdater;
  settings: ProviderSettings;
}>) {
  const ko = language === "ko";
  return (
    <div className="settingsFields">
      <SettingField
        label={ko ? "AI Studio Endpoint URL" : "AI Studio endpoint URL"}
        value={settings.aistudioEndpoint}
        placeholder="https://dev-aistudio.example.com:8082/v1/agent/..."
        onChange={(value) => onChange("aistudioEndpoint", value)}
      />
      <SettingField
        label="API Key"
        type="password"
        value={settings.aistudioApiKey}
        placeholder={ko ? "외부에이전트 API Key (Bearer)" : "External agent API key (Bearer)"}
        onChange={(value) => onChange("aistudioApiKey", value)}
      />
      <p className="azureCredentialNote">
        {ko
          ? "Endpoint와 API Key는 OCR/추론, Embedding, Rerank 모델 호출에 공통으로 사용됩니다 (Authorization: Bearer)."
          : "The endpoint and API key are shared across OCR/reasoning, embedding, and rerank calls (Authorization: Bearer)."}
      </p>
      <SettingField
        label={ko ? "OCR/추론 모델 ID" : "OCR/reasoning model id"}
        value={settings.aistudioModel}
        placeholder="gpt-5.5"
        onChange={(value) => onChange("aistudioModel", value)}
      />
      <SettingField
        label={ko ? "Embedding 모델 ID" : "Embedding model id"}
        value={settings.aistudioEmbeddingModel}
        placeholder="text-embedding-3-large"
        onChange={(value) => onChange("aistudioEmbeddingModel", value)}
      />
      <SettingField
        label={ko ? "Rerank 모델 ID (Bedrock, 선택)" : "Rerank model id (Bedrock, optional)"}
        value={settings.aistudioRerankModel}
        placeholder="cohere.rerank-v3-5:0"
        onChange={(value) => onChange("aistudioRerankModel", value)}
      />
      <SettingField
        label={ko ? "API Version (선택)" : "API version (optional)"}
        value={settings.aistudioApiVersion}
        placeholder={ko ? "비워두면 미사용" : "Leave blank to omit"}
        onChange={(value) => onChange("aistudioApiVersion", value)}
      />
    </div>
  );
}

function AzureProviderSettings({
  deploymentListId,
  deploymentOptions,
  loadingLabel,
  modelLoadStatus,
  modelMessage,
  onChange,
  onRefreshDeployments,
  refreshLabel,
  settings
}: Readonly<{
  deploymentListId: string;
  deploymentOptions: string[];
  loadingLabel: string;
  modelLoadStatus: ModelLoadStatus;
  modelMessage: string;
  onChange: ProviderSettingUpdater;
  onRefreshDeployments: () => void;
  refreshLabel: string;
  settings: ProviderSettings;
}>) {
  return (
    <div className="azureProviderSettings">
      <div className="azureConnectionGrid">
        <AzureTextField
          label="Azure API Key"
          type="password"
          value={settings.azureApiKey}
          placeholder="Shared Azure API key"
          onChange={(value) => onChange("azureApiKey", value)}
        />
        <AzureTextField
          label="Azure Endpoint"
          value={settings.azureEndpoint}
          placeholder="https://resource-name.openai.azure.com"
          onChange={(value) => onChange("azureEndpoint", value)}
        />
        <AzureTextField
          label="API Version"
          value={settings.azureApiVersion}
          placeholder="2025-04-01-preview"
          onChange={(value) => onChange("azureApiVersion", value)}
        />
      </div>
      <p className="azureCredentialNote">
        OCR, Embedding, Final classification/reasoning은 위 Azure API Key와 Endpoint를 함께 사용합니다.
      </p>

      <section className="azurePipelineBlock">
        <div className="azurePipelineHeader">
          <h4>Model pipeline</h4>
          <button type="button" disabled={modelLoadStatus === "loading"} onClick={onRefreshDeployments}>
            {modelLoadStatus === "loading" ? loadingLabel : refreshLabel}
          </button>
        </div>
        <small className={modelLoadStatus === "error" ? "azureModelMessage error" : "azureModelMessage"}>{modelMessage}</small>
        <datalist id={deploymentListId}>
          {deploymentOptions.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
        <div className="azurePipeline">
          <AzureDeploymentStep
            deploymentListId={deploymentListId}
            order="1"
            title="OCR"
            subtitle="Structure extraction"
            value={settings.azureOcrDeployment}
            placeholder="gpt-5.5"
            onChange={(value) => onChange("azureOcrDeployment", value)}
          />
          <AzureDeploymentStep
            deploymentListId={deploymentListId}
            order="2"
            title="Embedding"
            subtitle="RAG vectorization"
            note="상단 Azure API 인증 사용"
            value={settings.azureEmbeddingDeployment}
            placeholder="text-embedding-3-small"
            onChange={(value) => onChange("azureEmbeddingDeployment", value)}
          />
          <AzureRerankingStep order="3" settings={settings} onChange={onChange} />
          <AzureDeploymentStep
            deploymentListId={deploymentListId}
            order="4"
            title="Final classification/reasoning"
            subtitle="Classification and analysis"
            value={settings.azureReasoningDeployment}
            placeholder="gpt-5.5"
            onChange={(value) => onChange("azureReasoningDeployment", value)}
          />
        </div>
      </section>
    </div>
  );
}

function AzureTextField({
  label,
  onChange,
  placeholder,
  type = "text",
  value
}: Readonly<{
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: "password" | "text";
  value: string;
}>) {
  return (
    <label className="azureInlineField">
      <span>{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function AzureDeploymentStep({
  deploymentListId,
  note,
  onChange,
  order,
  placeholder,
  subtitle,
  title,
  value
}: Readonly<{
  deploymentListId: string;
  note?: string;
  onChange: (value: string) => void;
  order: string;
  placeholder: string;
  subtitle: string;
  title: string;
  value: string;
}>) {
  return (
    <article className="azurePipelineStep">
      <span className="azureStepNumber">{order}</span>
      <div className="azureStepMeta">
        <strong>{title}</strong>
        <em>{subtitle}</em>
      </div>
      <div className="azureStepControl">
        <input
          list={deploymentListId}
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          onChange={(event) => onChange(event.target.value)}
        />
        {note && <small className="azureStepNote">{note}</small>}
      </div>
    </article>
  );
}

function AzureRerankingStep({
  onChange,
  order,
  settings
}: Readonly<{
  onChange: ProviderSettingUpdater;
  order: string;
  settings: ProviderSettings;
}>) {
  const isCohere = settings.azureRerankerProvider === "cohere";

  return (
    <article className="azurePipelineStep azureRerankingStep">
      <span className="azureStepNumber">{order}</span>
      <div className="azureStepMeta">
        <strong>Reranking</strong>
        <em>별도 reranking/search 서비스</em>
      </div>
      <div className="azureStepControl">
        <select
          value={settings.azureRerankerProvider}
          onChange={(event) => onChange("azureRerankerProvider", event.target.value as ProviderSettings["azureRerankerProvider"])}
        >
          <option value="cohere">Cohere Rerank via Azure Foundry</option>
          <option value="azure-ai-search-semantic">Azure AI Search semantic ranker</option>
        </select>
        <small className="azureStepNote">
          모델 배포 호출 단계가 아니므로 선택한 reranking/search 서비스의 Key/Endpoint를 사용합니다.
        </small>
        <div className="azureStepFields">
          {isCohere ? (
            <>
              <AzureTextField
                label="Cohere/Foundry Key"
                type="password"
                value={settings.azureCohereRerankApiKey}
                placeholder="Cohere rerank key"
                onChange={(value) => onChange("azureCohereRerankApiKey", value)}
              />
              <AzureTextField
                label="Cohere/Foundry Endpoint"
                value={settings.azureCohereRerankEndpoint}
                placeholder="https://.../v2/rerank"
                onChange={(value) => onChange("azureCohereRerankEndpoint", value)}
              />
              <AzureTextField
                label="Model"
                value={settings.azureCohereRerankModel}
                placeholder="optional"
                onChange={(value) => onChange("azureCohereRerankModel", value)}
              />
            </>
          ) : (
            <>
              <AzureTextField
                label="Azure AI Search Key"
                type="password"
                value={settings.azureAiSearchApiKey}
                placeholder="Search key"
                onChange={(value) => onChange("azureAiSearchApiKey", value)}
              />
              <AzureTextField
                label="Azure AI Search Endpoint"
                value={settings.azureAiSearchEndpoint}
                placeholder="https://search-name.search.windows.net"
                onChange={(value) => onChange("azureAiSearchEndpoint", value)}
              />
              <AzureTextField
                label="Index"
                value={settings.azureAiSearchIndexName}
                placeholder="index name"
                onChange={(value) => onChange("azureAiSearchIndexName", value)}
              />
              <AzureTextField
                label="Semantic config"
                value={settings.azureAiSearchSemanticConfiguration}
                placeholder="default"
                onChange={(value) => onChange("azureAiSearchSemanticConfiguration", value)}
              />
            </>
          )}
        </div>
      </div>
    </article>
  );
}

function SettingField({
  label,
  onChange,
  placeholder,
  type = "text",
  value
}: Readonly<{
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: "password" | "text";
  value: string;
}>) {
  return (
    <label className="settingField">
      <span>{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function SettingSelectField<Value extends string>({
  label,
  onChange,
  options,
  value
}: Readonly<{
  label: string;
  onChange: (value: Value) => void;
  options: Array<{ value: Value; label: string }>;
  value: Value;
}>) {
  return (
    <label className="settingField">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value as Value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ModelSelectField({
  label,
  loadingLabel,
  message,
  onChange,
  onRefresh,
  options,
  placeholder,
  refreshLabel,
  status,
  value
}: Readonly<{
  label: string;
  loadingLabel: string;
  message: string;
  onChange: (value: string) => void;
  onRefresh: () => void;
  options: string[];
  placeholder: string;
  refreshLabel: string;
  status: ModelLoadStatus;
  value: string;
}>) {
  const optionValues = value && !options.includes(value) ? [value, ...options] : options;

  return (
    <label className="settingField modelSelectField">
      <span>{label}</span>
      <div className="modelSelectControl">
        <select
          value={value}
          disabled={status === "loading" || optionValues.length === 0}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">{placeholder}</option>
          {optionValues.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <button type="button" disabled={status === "loading"} onClick={onRefresh}>
          {status === "loading" ? loadingLabel : refreshLabel}
        </button>
        <small className={status === "error" ? "error" : ""}>{message}</small>
      </div>
    </label>
  );
}

interface RagProfileApiPayload {
  profile?: string;
  analysisPrompt: string;
  documents: Array<{
    name: string;
    version?: string;
    content: string;
    managed?: boolean;
    path?: string;
    size?: number;
    updatedAt?: string;
  }>;
}

async function requestRagProfiles(): Promise<RagProfiles> {
  const response = await fetch("/api/rag-profile", { cache: "no-store" });
  const payload = await response.json() as { extractor?: RagProfileApiPayload; generator?: RagProfileApiPayload; error?: string };

  if (!response.ok || !payload.extractor || !payload.generator) {
    throw new Error(payload.error ?? `RAG profile load failed: ${response.status}`);
  }

  return {
    extractor: toRagProfileSettings(payload.extractor),
    generator: toRagProfileSettings(payload.generator)
  };
}

async function writeRagProfile(target: RagProfileTarget, settings: RagProfileSettings): Promise<RagProfiles> {
  const response = await fetch("/api/rag-profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      target,
      analysisPrompt: settings.analysisPrompt,
      documents: settings.files.map((file) => ({
        name: file.name,
        version: file.version,
        content: file.content
      }))
    })
  });
  const payload = await response.json() as { error?: string };

  if (!response.ok) {
    throw new Error(payload.error ?? `RAG profile save failed: ${response.status}`);
  }

  return requestRagProfiles();
}

async function resetPackageRagProfile(target: RagProfileTarget): Promise<RagProfiles> {
  const response = await fetch(`/api/rag-profile?target=${encodeURIComponent(target)}`, { method: "DELETE" });
  const payload = await response.json() as { error?: string };

  if (!response.ok) {
    throw new Error(payload.error ?? `RAG profile reset failed: ${response.status}`);
  }

  return requestRagProfiles();
}

function toRagProfileSettings(payload: RagProfileApiPayload): RagProfileSettings {
  return {
    profile: payload.profile,
    analysisPrompt: payload.analysisPrompt,
    files: payload.documents.map((document) => ({
      id: document.path ?? document.name,
      name: document.name,
      version: document.version ?? extractRagFileVersion(document.name),
      size: document.size ?? new TextEncoder().encode(document.content).length,
      type: inferRagFileType(document.name),
      content: document.content,
      managed: document.managed,
      path: document.path,
      addedAt: document.updatedAt ?? new Date().toISOString()
    }))
  };
}

async function validateProviderConnection(
  settings: ProviderSettings,
  options: { listOnly?: boolean } = {}
): Promise<{ message: string; models: string[] }> {
  const response = await fetch("/api/provider/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...createRuntimeLlmConfig(settings),
      listOnly: options.listOnly
    })
  });
  const payload = await response.json() as { ok?: boolean; message?: string; details?: string; models?: string[] };

  if (!response.ok || !payload.ok) {
    throw new Error([payload.message ?? `Provider validation failed: ${response.status}`, payload.details].filter(Boolean).join("\n"));
  }

  return {
    message: payload.message ?? `${providerLabel(settings.provider, "ko")} 연결이 확인되었습니다.`,
    models: payload.models ?? []
  };
}

function createRuntimeLlmConfig(settings: ProviderSettings): RuntimeLlmConfig {
  if (settings.provider === "openai") {
    return {
      provider: "openai",
      apiKey: normalizeSecretInput(settings.openaiApiKey),
      model: settings.openaiModel.trim()
    };
  }

  if (settings.provider === "gemini") {
    return {
      provider: "gemini",
      apiKey: normalizeSecretInput(settings.geminiApiKey),
      model: settings.geminiModel.trim()
    };
  }

  if (settings.provider === "azure-openai") {
    const azureApiKey = normalizeSecretInput(settings.azureApiKey);
    const endpoint = settings.azureEndpoint.trim();
    const apiVersion = settings.azureApiVersion.trim();
    const ocrDeployment = settings.azureOcrDeployment.trim() || settings.azureDeployment.trim();
    const reasoningDeployment = settings.azureReasoningDeployment.trim() || settings.azureDeployment.trim();
    const embeddingDeployment = settings.azureEmbeddingDeployment.trim();
    const cohereSelected = settings.azureRerankerProvider === "cohere";

    return {
      provider: "azure-openai",
      apiKey: azureApiKey,
      endpoint,
      deployment: reasoningDeployment,
      deployments: {
        ocr: ocrDeployment,
        reasoning: reasoningDeployment,
        embedding: embeddingDeployment
      },
      apiVersion,
      embedding: {
        provider: "azure-openai",
        apiKey: azureApiKey,
        endpoint,
        deployment: embeddingDeployment,
        apiVersion
      },
      reranker: {
        provider: settings.azureRerankerProvider,
        apiKey: cohereSelected ? normalizeSecretInput(settings.azureCohereRerankApiKey) : normalizeSecretInput(settings.azureAiSearchApiKey),
        endpoint: cohereSelected ? settings.azureCohereRerankEndpoint.trim() : settings.azureAiSearchEndpoint.trim(),
        model: cohereSelected ? settings.azureCohereRerankModel.trim() : undefined,
        indexName: cohereSelected ? undefined : settings.azureAiSearchIndexName.trim(),
        semanticConfiguration: cohereSelected ? undefined : settings.azureAiSearchSemanticConfiguration.trim(),
        queryLanguage: "ko-kr"
      }
    };
  }

  if (settings.provider === "aistudio") {
    const apiKey = normalizeSecretInput(settings.aistudioApiKey);
    const endpoint = settings.aistudioEndpoint.trim();
    const model = settings.aistudioModel.trim();
    const embeddingModel = settings.aistudioEmbeddingModel.trim();
    const rerankModel = settings.aistudioRerankModel.trim();
    const apiVersion = settings.aistudioApiVersion.trim() || undefined;

    // One AI Studio endpoint + Bearer key fronts all roles: gpt-5.5 (OCR/reasoning),
    // text-embedding-3-large (embedding), and cohere rerank on Bedrock.
    return {
      provider: "aistudio",
      apiKey,
      endpoint,
      deployment: model,
      deployments: {
        ocr: model,
        reasoning: model,
        embedding: embeddingModel
      },
      apiVersion,
      embedding: {
        provider: "aistudio",
        apiKey,
        endpoint,
        deployment: embeddingModel,
        apiVersion,
        model: embeddingModel
      },
      reranker: rerankModel
        ? {
            provider: "aistudio-bedrock-cohere",
            apiKey,
            endpoint,
            model: rerankModel
          }
        : { provider: "local-hybrid" }
    };
  }

  return { provider: "mock" };
}

function createRuntimeRagConfig(settings: RagProfileSettings): RuntimeRagProfile {
  return {
    analysisPrompt: settings.analysisPrompt.trim(),
    documents: settings.files
      .filter((file) => isRagFileEnabled(file))
      .map((file) => ({
        name: file.name,
        version: file.version,
        content: file.content
      }))
  };
}

function isRagFileEnabled(file: Pick<RagAttachment, "enabled">): boolean {
  return file.enabled !== false;
}

function normalizeRagVersion(value: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    return "v1";
  }

  return /^v/i.test(trimmed) ? trimmed : `v${trimmed}`;
}

function mergeRagProfileUiState(base: RagProfiles, uiState: RagProfiles): RagProfiles {
  return {
    extractor: mergeRagProfileTargetUiState(base.extractor, uiState.extractor),
    generator: mergeRagProfileTargetUiState(base.generator, uiState.generator)
  };
}

function mergeRagProfileTargetUiState(base: RagProfileSettings, uiState: RagProfileSettings): RagProfileSettings {
  const uiStateByKey = new Map(uiState.files.flatMap((file) => ragFileStateKeys(file).map((key) => [key, file])));

  return {
    ...base,
    files: base.files.map((file) => {
      const savedFile = ragFileStateKeys(file)
        .map((key) => uiStateByKey.get(key))
        .find(Boolean);

      return {
        ...file,
        version: savedFile?.version ?? file.version,
        enabled: savedFile?.enabled ?? file.enabled ?? true
      };
    })
  };
}

function ragFileStateKeys(file: Pick<RagAttachment, "id" | "name" | "path">): string[] {
  return [file.path, file.name, file.id].filter((value): value is string => Boolean(value));
}

function parseHeadersJson(value: string): Record<string, string> {
  const trimmed = value.trim();

  if (!trimmed) {
    return {};
  }

  const parsed = JSON.parse(trimmed) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Headers JSON must be a JSON object.");
  }

  return Object.fromEntries(
    Object.entries(parsed).map(([key, headerValue]) => [key, String(headerValue)])
  );
}

function providerLabel(provider: ProviderId, language: UiLanguage): string {
  if (provider === "mock") {
    return language === "ko" ? "Mock 테스트" : "Mock";
  }
  if (provider === "azure-openai") {
    return "Azure API";
  }
  if (provider === "aistudio") {
    return "AI Studio";
  }
  if (provider === "gemini") {
    return "Gemini";
  }
  return "OpenAI";
}

function providerDescription(provider: ProviderId, language: UiLanguage): string {
  if (provider === "mock") {
    return language === "ko" ? "UI 흐름 검증" : "UI flow preview";
  }
  if (provider === "openai") {
    return language === "ko" ? "Responses API" : "Responses API";
  }
  if (provider === "gemini") {
    return language === "ko" ? "Google AI Studio" : "Google AI Studio";
  }
  if (provider === "aistudio") {
    return language === "ko" ? "외부에이전트 엔드포인트" : "External agent endpoint";
  }
  return language === "ko" ? "Azure 배포" : "Azure deployment";
}

function workspaceTitle(mode: WorkspaceMode, language: UiLanguage): string {
  if (mode === "extractor") {
    return language === "ko" ? "agentic-geo PDP Extractor" : "agentic-geo PDP Extractor";
  }
  if (mode === "magazine") {
    return language === "ko" ? "agentic-geo Magazine Generator" : "agentic-geo Magazine Generator";
  }
  return language === "ko" ? "agentic-geo PDP GEO 생성" : "agentic-geo PDP GEO Generator";
}

function workspaceWelcomeTitle(mode: WorkspaceMode, language: UiLanguage): string {
  if (mode === "extractor") {
    return language === "ko" ? "추출할 PDP 또는 REST API를 입력하세요" : "Enter a PDP or REST API to extract product data";
  }
  if (mode === "magazine") {
    return language === "ko" ? "Reddit GEO 콘텐츠를 생성할 PDP를 입력하세요" : "Enter a PDP to generate Reddit GEO content";
  }
  return language === "ko" ? "GEO 아티팩트를 생성할 PDP를 입력하세요" : "Enter a PDP to generate GEO artifacts";
}

function workspaceWelcomeCards(
  mode: WorkspaceMode,
  language: UiLanguage
): readonly [readonly [string, string], readonly [string, string], readonly [string, string]] {
  if (mode === "extractor") {
    return language === "ko"
      ? [["URL 입력", "상품 상세 페이지"], ["REST API", "상품 데이터 응답"], ["RAW JSON", "추출 결과"]] as const
      : [["URL input", "Product detail page"], ["REST API", "Product data response"], ["RAW JSON", "Extraction result"]] as const;
  }
  if (mode === "magazine") {
    return language === "ko"
      ? [["URL 입력", "상품 상세 페이지"], ["JSON 파일", "상품 정보 첨부"], ["Reddit 결과", "title/bodyMarkdown"]] as const
      : [["URL input", "Product detail page"], ["JSON file", "Product data attachment"], ["Reddit result", "title/bodyMarkdown"]] as const;
  }

  return language === "ko"
    ? [["URL 입력", "상품 상세 페이지"], ["REST API", "상품 데이터 응답"], ["JSON 결과", "복사 가능한 출력"]] as const
    : [["URL input", "Product detail page"], ["REST API", "Product data response"], ["JSON result", "Copy-ready output"]] as const;
}

function workspaceComposerPlaceholder(mode: WorkspaceMode, language: UiLanguage): string {
  if (mode === "extractor") {
    return language === "ko"
      ? "상품 URL 또는 REST API 주소를 붙여넣으면 상품 RAW JSON을 추출합니다."
      : "Paste a product URL or REST API endpoint to extract product RAW JSON.";
  }
  if (mode === "magazine") {
    return language === "ko"
      ? "상품 URL/API 주소를 붙여넣거나 상품 JSON 파일을 첨부하면 Reddit용 GEO 콘텐츠를 생성합니다."
      : "Paste a product URL/API endpoint or attach product JSON to generate Reddit GEO content.";
  }
  return language === "ko"
    ? "상품 URL이나 API 주소를 붙여넣고, JSON이 있다면 그대로 넣어주세요."
    : "Paste a product URL, API endpoint, or product JSON and I’ll prepare the GEO artifacts.";
}

function ragTargetLabel(target: RagProfileTarget, language: UiLanguage): string {
  if (target === "extractor") {
    return language === "ko" ? "Extractor RAG" : "Extractor RAG";
  }
  return language === "ko" ? "Generator RAG" : "Generator RAG";
}

function ragTargetDescription(target: RagProfileTarget, language: UiLanguage): string {
  if (target === "extractor") {
    return language === "ko" ? "상품정보 추출 참고 문서" : "Product extraction guidance";
  }
  return language === "ko" ? "GEO schema/content 참고 문서" : "GEO schema/content guidance";
}

function ragProfileSplitHelp(language: UiLanguage): string {
  return language === "ko"
    ? "Extractor와 Generator RAG는 별도 프로필로 관리됩니다. 탭을 전환해 각 에이전트의 프롬프트와 파일을 따로 편집하세요."
    : "Extractor and Generator RAG are managed as separate profiles. Switch tabs to edit each agent's prompt and files.";
}

function ragFileCountLabel(count: number, language: UiLanguage): string {
  return language === "ko" ? `${count}개 파일` : `${count} file${count === 1 ? "" : "s"}`;
}

function ragFileBreakdownLabel(language: UiLanguage): string {
  return language === "ko" ? "RAG 파일 구성" : "RAG file breakdown";
}

function ragManagedCountLabel(count: number, language: UiLanguage): string {
  return language === "ko" ? `관리 ${count}` : `Managed ${count}`;
}

function ragCustomCountLabel(count: number, language: UiLanguage): string {
  return language === "ko" ? `첨부 ${count}` : `Custom ${count}`;
}

function ragEnabledLabel(language: UiLanguage): string {
  return language === "ko" ? "사용" : "Use";
}

function ragDisabledLabel(language: UiLanguage): string {
  return language === "ko" ? "미사용" : "Unused";
}

function compactOutputViewLabel(view: OutputView): string {
  return view === "diagnostics" ? "diag" : view;
}

function compactMagazineOutputViewLabel(view: MagazineOutputView): string {
  return view === "diagnostics" ? "diag" : view;
}

function connectionStatusLabel(status: ConnectionStatus, language: UiLanguage): string {
  if (status === "checking") {
    return language === "ko" ? "확인 중" : "Checking";
  }
  if (status === "connected") {
    return language === "ko" ? "정상" : "Connected";
  }
  if (status === "error") {
    return language === "ko" ? "확인 필요" : "Needs attention";
  }
  return language === "ko" ? "미연동" : "Not connected";
}

function modelPlaceholder(language: UiLanguage): string {
  return language === "ko" ? "모델 목록을 불러와 선택" : "Load models, then choose one";
}

function modelIdleMessage(language: UiLanguage): string {
  return language === "ko" ? "AI 키를 입력한 뒤 모델 목록을 불러올 수 있습니다." : "Enter an API key, then load available models.";
}

function modelLoadingMessage(provider: string, language: UiLanguage): string {
  return language === "ko" ? `${provider} 모델 목록을 불러오고 있습니다.` : `Loading ${provider} models.`;
}

function modelLoadedMessage(count: number, language: UiLanguage): string {
  return language === "ko" ? `${count}개 모델을 불러왔습니다. 사용할 모델을 선택해주세요.` : `${count} models loaded. Choose one to use.`;
}

function modelCountMessage(count: number, language: UiLanguage): string {
  return language === "ko" ? `${count}개 모델을 확인했습니다.` : `${count} models found.`;
}

function emptyModelMessage(language: UiLanguage): string {
  return language === "ko" ? "사용 가능한 모델 목록이 비어 있습니다." : "No available models were returned.";
}

function modelFailedMessage(provider: string, language: UiLanguage): string {
  return language === "ko" ? `${provider} 모델 목록을 불러오지 못했습니다.` : `Could not load ${provider} models.`;
}

function providerInitialMessage(language: UiLanguage): string {
  return language === "ko"
    ? "OpenAI, Gemini, Azure API는 Extractor와 Schema Generator에 사용되고, Azure API는 Magazine Generator의 citation 콘텐츠 생성에도 사용됩니다."
    : "OpenAI, Gemini, and Azure API settings are used for Extractor and Schema Generator runs; Azure API is also used for Magazine Generator citation content.";
}

function providerPendingMessage(language: UiLanguage): string {
  return language === "ko" ? "모델 목록을 불러와 선택한 뒤 연결 테스트를 진행해주세요." : "Load models, choose one, then run a connection test.";
}

function connectionCheckingMessage(provider: string, language: UiLanguage): string {
  return language === "ko" ? `${provider} 연결 테스트를 실행하고 있습니다.` : `Testing the ${provider} connection.`;
}

function providerSavedMessage(message: string, language: UiLanguage): string {
  return language === "ko" ? `${message} 설정을 저장했고 다음 실행부터 적용됩니다.` : `${message} Settings saved for the next run.`;
}

function providerReadyMessage(message: string, language: UiLanguage): string {
  return language === "ko" ? `${message} 현재 화면의 실행에 사용할 수 있습니다.` : `${message} You can use it for this session.`;
}

function providerFailedMessage(provider: string, language: UiLanguage): string {
  return language === "ko" ? `${provider} 연결 확인에 실패했습니다.` : `Could not verify the ${provider} connection.`;
}

function providerResetMessage(language: UiLanguage): string {
  return language === "ko" ? "AI 연동 설정을 초기화했습니다." : "AI connection settings were reset.";
}

function mockProviderMessage(language: UiLanguage): string {
  return language === "ko"
    ? "Mock은 UI/UX와 JSON 결과 흐름을 빠르게 확인하는 데모 모드입니다. 실제 생성 품질 검증에는 OpenAI, Gemini, Azure API 중 하나를 연결해주세요."
    : "Mock is for previewing the UI and JSON flow. Connect OpenAI, Gemini, or Azure API settings to validate real generation quality.";
}

function aiScopeMessage(language: UiLanguage): string {
  return language === "ko"
    ? "저장한 AI 연동 설정은 URL/REST API 입력의 상품정보 추출과 GEO schema/content 생성에 전달됩니다. Azure API 설정은 Reddit magazine/content 생성 단계에도 전달됩니다. 키는 서버에 영구 저장하지 않고 이 브라우저의 로컬 저장소에만 보관합니다."
    : "Saved AI settings are passed to URL/REST product extraction and GEO schema/content generation. Azure API settings are also passed to Reddit magazine/content generation. Keys stay in this browser's local storage and are not permanently stored on the server.";
}

function ragInitialMessage(language: UiLanguage): string {
  return language === "ko" ? "현재 패키지 RAG 프로필을 확인하고 편집할 수 있습니다." : "Review and edit the current package RAG profiles.";
}

function ragChangedMessage(language: UiLanguage): string {
  return language === "ko" ? "변경사항을 저장하면 다음 실행부터 적용됩니다." : "Save changes to apply them to the next run.";
}

function ragImportedMessage(count: number, target: RagProfileTarget, language: UiLanguage): string {
  return language === "ko" ? `${count}개 파일을 ${ragTargetLabel(target, language)}에 추가했습니다.` : `${count} file${count === 1 ? "" : "s"} added to ${ragTargetLabel(target, language)}.`;
}

function ragRemovedMessage(language: UiLanguage): string {
  return language === "ko" ? "RAG 파일을 제거했습니다." : "RAG file removed.";
}

function ragSavedMessage(target: RagProfileTarget, language: UiLanguage): string {
  return language === "ko" ? `${ragTargetLabel(target, language)} 프로필을 패키지 RAG 파일과 동기화했습니다.` : `${ragTargetLabel(target, language)} was synced to package RAG files.`;
}

function ragSaveFailedMessage(language: UiLanguage): string {
  return language === "ko" ? "RAG 프로필 저장에 실패했습니다." : "Failed to save the RAG profile.";
}

function ragResetMessage(target: RagProfileTarget, language: UiLanguage): string {
  return language === "ko" ? `${ragTargetLabel(target, language)} 프로필을 기본값으로 초기화했습니다.` : `${ragTargetLabel(target, language)} was reset to defaults.`;
}

function ragResetFailedMessage(language: UiLanguage): string {
  return language === "ko" ? "RAG 프로필 초기화에 실패했습니다." : "Failed to reset the RAG profile.";
}

function managedLabel(language: UiLanguage): string {
  return language === "ko" ? "패키지 관리" : "Managed";
}

function customLabel(language: UiLanguage): string {
  return language === "ko" ? "사용자 첨부" : "Custom";
}

async function requestGeoGenerator(
  body: object,
  onProgress: (event: Extract<GeoGeneratorStreamEvent, { type: "progress" }>) => void
): Promise<{ payload: GeoGeneratorResponse; ok: boolean }> {
  const response = await fetch("/api/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      ...body,
      stream: true
    })
  });

  const contentType = response.headers.get("content-type") ?? "";
  if (!response.body || !contentType.includes("application/x-ndjson")) {
    const payload = await response.json() as GeoGeneratorResponse;
    return { payload, ok: response.ok };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let payload: GeoGeneratorResponse | undefined;
  let streamError: string | undefined;

  const handleLine = (line: string) => {
    if (!line.trim()) {
      return;
    }
    const event = JSON.parse(line) as GeoGeneratorStreamEvent;
    if (event.type === "progress") {
      onProgress(event);
      return;
    }
    if (event.type === "result") {
      payload = event.payload;
      return;
    }
    streamError = event.error;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    lines.forEach(handleLine);
  }

  buffer += decoder.decode();
  handleLine(buffer);

  if (streamError) {
    throw new Error(streamError);
  }
  if (!payload) {
    throw new Error("GEO generation stream ended without a result.");
  }

  return {
    payload,
    ok: payload.failures.length === 0
  };
}

async function requestMagazineGenerator(
  body: object,
  onProgress: (event: Extract<MagazineGeneratorStreamEvent, { type: "progress" }>) => void
): Promise<{ payload: MagazineGeneratorResponse; ok: boolean }> {
  const response = await fetch("/api/magazine", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      ...body,
      stream: true
    })
  });

  const contentType = response.headers.get("content-type") ?? "";
  if (!response.body || !contentType.includes("application/x-ndjson")) {
    const payload = await response.json() as MagazineGeneratorResponse;
    return { payload, ok: response.ok };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let payload: MagazineGeneratorResponse | undefined;
  let streamError: string | undefined;

  const handleLine = (line: string) => {
    if (!line.trim()) {
      return;
    }
    const event = JSON.parse(line) as MagazineGeneratorStreamEvent;
    if (event.type === "progress") {
      onProgress(event);
      return;
    }
    if (event.type === "result") {
      payload = event.payload;
      return;
    }
    streamError = event.error;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    lines.forEach(handleLine);
  }

  buffer += decoder.decode();
  handleLine(buffer);

  if (streamError) {
    throw new Error(streamError);
  }
  if (!payload) {
    throw new Error("GEO magazine/content stream ended without a result.");
  }

  return {
    payload,
    ok: payload.failures.length === 0
  };
}

function applyGeneratorProgressEvent(
  event: Extract<GeoGeneratorStreamEvent, { type: "progress" }>,
  setPipelineProcess: (update: (current: GeoPipelineProcessState) => GeoPipelineProcessState) => void,
  extractorFallback: ProductExtractionStep[],
  generatorFallback: PdpGeoGenerationStep[]
) {
  setPipelineProcess((current) => {
    const isCompletedSource = event.group === "generator" && event.step.id === "artifact" && event.step.status === "done";
    const completedSourceCount = isCompletedSource
      ? Math.max(current.completedSourceCount, event.sourceIndex + 1)
      : Math.max(current.completedSourceCount, event.sourceIndex);

    return {
      ...current,
      status: "running",
      currentGroup: event.group,
      currentStepId: event.step.id,
      sourceCount: event.sourceCount,
      completedSourceCount: Math.min(event.sourceCount, completedSourceCount),
      activeSource: event.source,
      skipExtractor: current.skipExtractor,
      extractorSteps: event.group === "extractor"
        ? mergeRuntimeStep(current.extractorSteps, extractorFallback, event.step as ProductExtractionStep)
        : current.extractorSteps,
      generatorSteps: event.group === "generator"
        ? mergeRuntimeStep(current.generatorSteps, generatorFallback, event.step as PdpGeoGenerationStep)
        : current.generatorSteps
    };
  });
}

function applyMagazineProgressEvent(
  event: Extract<MagazineGeneratorStreamEvent, { type: "progress" }>,
  setPipelineProcess: (update: (current: GeoPipelineProcessState) => GeoPipelineProcessState) => void,
  extractorFallback: ProductExtractionStep[],
  magazineFallback: GeoCitationGenerationStep[]
) {
  setPipelineProcess((current) => {
    const isCompletedSource = event.group === "magazine" && event.step.id === "artifact" && event.step.status === "done";
    const completedSourceCount = isCompletedSource
      ? Math.max(current.completedSourceCount, event.sourceIndex + 1)
      : Math.max(current.completedSourceCount, event.sourceIndex);

    return {
      ...current,
      status: "running",
      currentGroup: event.group,
      currentStepId: event.step.id,
      sourceCount: event.sourceCount,
      completedSourceCount: Math.min(event.sourceCount, completedSourceCount),
      activeSource: event.source,
      skipExtractor: current.skipExtractor,
      extractorSteps: event.group === "extractor"
        ? mergeRuntimeStep(current.extractorSteps, extractorFallback, event.step as ProductExtractionStep)
        : current.extractorSteps,
      magazineSteps: event.group === "magazine"
        ? mergeRuntimeStep(current.magazineSteps, magazineFallback, event.step as GeoCitationGenerationStep)
        : current.magazineSteps
    };
  });
}

function mergeRuntimeStep<Step extends ProcessStep>(current: Step[] | undefined, fallback: Step[], next: Step): Step[] {
  const steps = current ?? fallback;
  return steps.map((step) => step.id === next.id ? { ...step, ...next } : step);
}

async function playExtractorPipelineProgress(
  input: NormalizedComposerInput,
  setPipelineProcess: (update: (current: GeoPipelineProcessState) => GeoPipelineProcessState) => void,
  controller: { cancelled: boolean }
) {
  const sourceCount = Math.max(input.sources.length, 1);
  const activeSource = input.sources[0];

  for (const stepId of extractorStepIds) {
    if (controller.cancelled) {
      return;
    }
    setPipelineProcess((current) => ({
      ...current,
      status: "running",
      currentGroup: "extractor",
      currentStepId: stepId,
      sourceCount,
      completedSourceCount: stepId === "json" ? Math.max(current.completedSourceCount, input.sources.length) : current.completedSourceCount,
      activeSource,
      skipExtractor: false
    }));
    await waitForPipelineStep();
  }
}

function waitForPipelineStep(duration = 130): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, duration);
  });
}

function createComposerAttachment(file: File, rawContent: string): ComposerAttachment | undefined {
  const content = rawContent.trim();

  if (!content) {
    return undefined;
  }

  const parsed = parseJsonSafely(content);

  if (parsed.ok) {
    const products = asProductArray(parsed.value);
    return {
      id: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      kind: "json",
      content: JSON.stringify(products.length === 1 ? products[0] : products, null, 2),
      productCount: products.length,
      sourceCount: 0
    };
  }

  if (isJsonLikeComposerFile(file, content)) {
    return undefined;
  }

  const sources = extractSourceInputs(content);

  if (sources.length === 0) {
    return undefined;
  }

  return {
    id: crypto.randomUUID(),
    name: file.name,
    size: file.size,
    kind: "sources",
    content: sources.join("\n"),
    productCount: 0,
    sourceCount: sources.length
  };
}

function isJsonLikeComposerFile(file: File, content: string): boolean {
  return /\.json$/i.test(file.name) || /^[{[]/.test(content);
}

function normalizeComposerInput(
  draft: string,
  attachments: ComposerAttachment[],
  mode: SourceMode,
  text: (typeof uiCopy)[UiLanguage]
): NormalizedComposerInput {
  const products: unknown[] = [];
  const sourceLines: string[] = [];
  const displayLines: string[] = [];
  const trimmedDraft = draft.trim();

  if (trimmedDraft) {
    const resolvedMode = resolveSourceMode(trimmedDraft, mode);

    if (resolvedMode === "manual-json") {
      const parsed = parseJsonSafely(trimmedDraft);

      if (!parsed.ok) {
        throw new Error(text.composer.invalidJson);
      }

      products.push(...asProductArray(parsed.value));
    } else {
      sourceLines.push(...extractSourceInputs(trimmedDraft));
    }

    displayLines.push(trimmedDraft);
  }

  for (const attachment of attachments) {
    if (attachment.kind === "json") {
      const parsed = parseJsonSafely(attachment.content);

      if (!parsed.ok) {
        throw new Error(text.composer.invalidJson);
      }

      products.push(...asProductArray(parsed.value));
      displayLines.push(`${attachment.name} · ${text.composer.jsonSummary(attachment.productCount)}`);
      continue;
    }

    const attachmentSources = extractSourceInputs(attachment.content);
    sourceLines.push(...attachmentSources);
    displayLines.push(
      attachmentSources.length > 0
        ? `${attachment.name} · ${text.composer.sourceSummary(attachmentSources.length)}`
        : `${attachment.name} · ${text.composer.emptySummary}`
    );
  }

  return {
    displayValue: displayLines.filter(Boolean).join("\n"),
    products,
    sources: uniqueValues(sourceLines),
    sourceType: mode === "restApi" ? "restApi" : "url"
  };
}

function normalizeExtractorComposerInput(
  draft: string,
  attachments: ComposerAttachment[],
  mode: SourceMode
): NormalizedComposerInput {
  const sourceLines: string[] = [];
  const displayLines: string[] = [];
  const trimmedDraft = draft.trim();

  if (trimmedDraft) {
    sourceLines.push(...extractSourceInputs(trimmedDraft));
    displayLines.push(trimmedDraft);
  }

  for (const attachment of attachments) {
    const attachmentSources = extractSourceInputs(attachment.content);
    sourceLines.push(...attachmentSources);
    displayLines.push(attachment.name);
  }

  return {
    displayValue: displayLines.filter(Boolean).join("\n"),
    products: [],
    sources: uniqueValues(sourceLines),
    sourceType: mode === "restApi" ? "restApi" : "url"
  };
}

function parseJsonSafely(value: string): { ok: true; value: unknown } | { ok: false } {
  if (!value || !/^[{[]/.test(value)) {
    return { ok: false };
  }

  try {
    return {
      ok: true,
      value: JSON.parse(value) as unknown
    };
  } catch {
    return { ok: false };
  }
}

function asProductArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function extractSourceInputs(value: string): string[] {
  const urlMatches = value.match(/https?:\/\/[^\s"'`<>{}|\\^]+/g) ?? [];

  if (urlMatches.length > 0) {
    return uniqueValues(urlMatches.map(cleanSourceInput));
  }

  return uniqueValues(
    value
      .split(/[\n,]+/)
      .map(cleanSourceInput)
      .filter(Boolean)
  );
}

function cleanSourceInput(value: string): string {
  return value.trim().replace(/^[\s"'`]+/g, "").replace(/[\s"'`,;)\]}]+$/g, "");
}

function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizeSecretInput(value: string): string {
  const withoutExport = value.trim().replace(/^export\s+/i, "");
  const assignment = withoutExport.match(/^[A-Z0-9_]+\s*=\s*(.+)$/i);
  const rawValue = assignment?.[1] ?? withoutExport;

  return rawValue.trim().replace(/^["']|["']$/g, "");
}

function validateProviderSettings(settings: ProviderSettings, language: UiLanguage): boolean {
  return getProviderValidationMessage(settings, language) === undefined;
}

function isAuthorizedAiSettings(settings: ProviderSettings): boolean {
  return settings.provider !== "mock" && validateProviderSettings(settings, "ko");
}

function getProviderValidationMessage(settings: ProviderSettings, language: UiLanguage): string | undefined {
  const credentialMessage = getProviderCredentialValidationMessage(settings, language);

  if (credentialMessage) {
    return credentialMessage;
  }

  if (settings.provider === "openai" && settings.openaiModel.trim().length === 0) {
    return language === "ko" ? "OpenAI 모델을 선택해주세요." : "Choose an OpenAI model.";
  }

  if (settings.provider === "gemini" && settings.geminiModel.trim().length === 0) {
    return language === "ko" ? "Gemini 모델을 선택해주세요." : "Choose a Gemini model.";
  }

  if (settings.provider === "azure-openai") {
    if ((settings.azureOcrDeployment.trim() || settings.azureDeployment.trim()).length === 0) {
      return language === "ko" ? "Azure OCR/structure deployment를 입력해주세요." : "Enter an Azure OCR/structure deployment.";
    }
    if ((settings.azureReasoningDeployment.trim() || settings.azureDeployment.trim()).length === 0) {
      return language === "ko" ? "Azure 최종 분류/분석 deployment를 입력해주세요." : "Enter an Azure final reasoning deployment.";
    }
    if (settings.azureEmbeddingDeployment.trim().length === 0) {
      return language === "ko" ? "Azure embedding deployment를 입력해주세요." : "Enter an Azure embedding deployment.";
    }
    if (settings.azureRerankerProvider === "cohere") {
      if (normalizeSecretInput(settings.azureCohereRerankApiKey).length === 0 || settings.azureCohereRerankEndpoint.trim().length === 0) {
        return language === "ko"
          ? "Cohere Rerank는 Cohere/Foundry Key와 Endpoint가 필요합니다."
          : "Cohere Rerank needs a Cohere/Foundry key and endpoint.";
      }
    }
    if (settings.azureRerankerProvider === "azure-ai-search-semantic") {
      if (normalizeSecretInput(settings.azureAiSearchApiKey).length === 0 || settings.azureAiSearchEndpoint.trim().length === 0 || settings.azureAiSearchIndexName.trim().length === 0) {
        return language === "ko"
          ? "Azure AI Search semantic ranker는 별도 Search 서비스 Endpoint, Key, Index name이 필요합니다."
          : "Azure AI Search semantic ranker needs a separate Search endpoint, key, and index name.";
      }
    }
  }

  if (settings.provider === "aistudio") {
    if (settings.aistudioModel.trim().length === 0) {
      return language === "ko" ? "AI Studio reasoning/OCR 모델 ID를 입력해주세요." : "Enter an AI Studio reasoning/OCR model id.";
    }
    if (settings.aistudioEmbeddingModel.trim().length === 0) {
      return language === "ko" ? "AI Studio embedding 모델 ID를 입력해주세요." : "Enter an AI Studio embedding model id.";
    }
  }

  return undefined;
}

function getProviderCredentialValidationMessage(settings: ProviderSettings, language: UiLanguage): string | undefined {
  if (settings.provider === "mock") {
    return language === "ko"
      ? "실제 AI 연동을 위해 OpenAI, Gemini, Azure API, AI Studio 중 하나를 선택해주세요."
      : "Choose OpenAI, Gemini, Azure API, or AI Studio settings for a real AI connection.";
  }

  if (settings.provider === "openai" && normalizeSecretInput(settings.openaiApiKey).length === 0) {
    return language === "ko" ? "OpenAI API Key를 입력해주세요." : "Enter an OpenAI API key.";
  }

  if (settings.provider === "gemini" && normalizeSecretInput(settings.geminiApiKey).length === 0) {
    return language === "ko" ? "Gemini API Key를 입력해주세요." : "Enter a Gemini API key.";
  }

  if (settings.provider === "azure-openai") {
    if (normalizeSecretInput(settings.azureApiKey).length === 0) {
      return language === "ko" ? "Azure API Key를 입력해주세요." : "Enter an Azure API key.";
    }
    if (settings.azureEndpoint.trim().length === 0) {
      return language === "ko" ? "Azure Endpoint를 입력해주세요." : "Enter an Azure endpoint.";
    }
  }

  if (settings.provider === "aistudio") {
    if (normalizeSecretInput(settings.aistudioApiKey).length === 0) {
      return language === "ko" ? "AI Studio API Key를 입력해주세요." : "Enter an AI Studio API key.";
    }
    if (settings.aistudioEndpoint.trim().length === 0) {
      return language === "ko" ? "AI Studio Endpoint URL을 입력해주세요." : "Enter an AI Studio endpoint URL.";
    }
  }

  return undefined;
}

function getSelectedModel(settings: ProviderSettings): string {
  if (settings.provider === "openai") {
    return settings.openaiModel.trim();
  }
  if (settings.provider === "gemini") {
    return settings.geminiModel.trim();
  }
  if (settings.provider === "azure-openai") {
    return settings.azureOcrDeployment.trim() || settings.azureDeployment.trim();
  }
  if (settings.provider === "aistudio") {
    return settings.aistudioModel.trim();
  }
  return "";
}

function formatFileSize(size: number): string {
  if (size < 1024) {
    return `${size}B`;
  }
  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)}KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)}MB`;
}

function formatDate(value: string, language: UiLanguage): string {
  return new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "en-US", {
    month: "short",
    day: "numeric"
  }).format(new Date(value));
}

function extractRagFileVersion(name: string): string {
  const version = name.match(/_v(\d+)\.[^.]+$/i)?.[1];
  return version ? `v${version}` : "v1";
}

function inferRagFileType(name: string): string {
  if (name.endsWith(".json")) {
    return "application/json";
  }
  if (name.endsWith(".csv")) {
    return "text/csv";
  }
  if (name.endsWith(".md")) {
    return "text/markdown";
  }
  return "text/plain";
}

function readStoredProviderSettings(): ProviderSettings {
  if (typeof window === "undefined") {
    return defaultProviderSettings;
  }

  try {
    const rawSettings = window.localStorage.getItem(SETTINGS_STORAGE_KEY)
      ?? LEGACY_SETTINGS_STORAGE_KEYS.map((key) => window.localStorage.getItem(key)).find((value): value is string => Boolean(value));

    if (!rawSettings) {
      return defaultProviderSettings;
    }

    return {
      ...defaultProviderSettings,
      ...JSON.parse(rawSettings) as Partial<ProviderSettings>
    };
  } catch {
    return defaultProviderSettings;
  }
}

function readStoredRunSettings(): { sourceMode: SourceMode; locale: PdpGeoLocale; headersJson: string } {
  if (typeof window === "undefined") {
    return {
      sourceMode: "auto",
      locale: "ko-KR",
      headersJson: "{}"
    };
  }

  try {
    const rawSettings = window.localStorage.getItem(RUN_SETTINGS_STORAGE_KEY);

    if (!rawSettings) {
      return {
        sourceMode: "auto",
        locale: "ko-KR",
        headersJson: "{}"
      };
    }

    const parsed = JSON.parse(rawSettings) as Partial<{ sourceMode: SourceMode; locale: PdpGeoLocale; headersJson: string }>;

    return {
      sourceMode: isSourceMode(parsed.sourceMode) ? parsed.sourceMode : "auto",
      locale: isPdpGeoLocale(parsed.locale) ? parsed.locale : "ko-KR",
      headersJson: typeof parsed.headersJson === "string" ? parsed.headersJson : "{}"
    };
  } catch {
    return {
      sourceMode: "auto",
      locale: "ko-KR",
      headersJson: "{}"
    };
  }
}

function readStoredRagProfiles(): RagProfiles {
  if (typeof window === "undefined") {
    return defaultRagProfiles;
  }

  try {
    const rawSettings = window.localStorage.getItem(RAG_SETTINGS_STORAGE_KEY);

    if (!rawSettings) {
      return defaultRagProfiles;
    }

    const parsed = JSON.parse(rawSettings) as Partial<Record<RagProfileTarget, Partial<RagProfileSettings>>>;

    return {
      extractor: normalizeStoredRagProfile(parsed.extractor),
      generator: normalizeStoredRagProfile(parsed.generator)
    };
  } catch {
    return defaultRagProfiles;
  }
}

function readStoredGeoHistory(): { results: GeoGeneratorResult[]; logs: GeoGeneratorLog[] } {
  if (typeof window === "undefined") {
    return { results: [], logs: [] };
  }

  try {
    const rawHistory = window.sessionStorage.getItem(HISTORY_STORAGE_KEY);

    if (!rawHistory) {
      return { results: [], logs: [] };
    }

    const parsed = JSON.parse(rawHistory) as Partial<{
      results: unknown[];
      logs: unknown[];
    }>;
    const results = Array.isArray(parsed.results)
      ? parsed.results.map(normalizeStoredGeoResult).filter((result): result is GeoGeneratorResult => Boolean(result))
      : [];
    const resultSources = new Set(results.map((result) => result.source));
    const logs = Array.isArray(parsed.logs)
      ? parsed.logs
          .map(normalizeStoredGeoLog)
          .filter((log): log is GeoGeneratorLog => Boolean(log))
          .filter((log) => resultSources.has(log.source))
      : [];

    return {
      results: results.slice(0, HISTORY_LIMIT),
      logs: logs.slice(0, HISTORY_LIMIT)
    };
  } catch {
    return { results: [], logs: [] };
  }
}

function readStoredExtractorHistory(): { results: TimedProductExtractionResult[]; logs: ProductExtractionDiagnostics[] } {
  if (typeof window === "undefined") {
    return { results: [], logs: [] };
  }

  try {
    const rawHistory = window.sessionStorage.getItem(EXTRACTOR_HISTORY_STORAGE_KEY);

    if (!rawHistory) {
      return { results: [], logs: [] };
    }

    const parsed = JSON.parse(rawHistory) as Partial<{
      results: unknown[];
      logs: unknown[];
    }>;
    const results = Array.isArray(parsed.results)
      ? parsed.results.map(normalizeStoredExtractorResult).filter((result): result is ProductExtractionResult => Boolean(result))
      : [];
    const resultSources = new Set(results.map((result) => result.source));
    const logs = Array.isArray(parsed.logs)
      ? parsed.logs
          .map(normalizeStoredExtractorLog)
          .filter((log): log is ProductExtractionDiagnostics => Boolean(log))
          .filter((log) => resultSources.has(log.source))
      : [];

    return {
      results: results.slice(0, HISTORY_LIMIT),
      logs: logs.slice(0, HISTORY_LIMIT)
    };
  } catch {
    return { results: [], logs: [] };
  }
}

function readStoredMagazineHistory(): { results: MagazineGeneratorResult[]; logs: MagazineGeneratorLog[] } {
  if (typeof window === "undefined") {
    return { results: [], logs: [] };
  }

  try {
    const rawHistory = window.sessionStorage.getItem(MAGAZINE_HISTORY_STORAGE_KEY);

    if (!rawHistory) {
      return { results: [], logs: [] };
    }

    const parsed = JSON.parse(rawHistory) as Partial<{
      results: unknown[];
      logs: unknown[];
    }>;
    const results = Array.isArray(parsed.results)
      ? parsed.results.map(normalizeStoredMagazineResult).filter((result): result is MagazineGeneratorResult => Boolean(result))
      : [];
    const resultSources = new Set(results.map((result) => result.source));
    const logs = Array.isArray(parsed.logs)
      ? parsed.logs
          .map(normalizeStoredMagazineLog)
          .filter((log): log is MagazineGeneratorLog => Boolean(log))
          .filter((log) => resultSources.has(log.source))
      : [];

    return {
      results: results.slice(0, HISTORY_LIMIT),
      logs: logs.slice(0, HISTORY_LIMIT)
    };
  } catch {
    return { results: [], logs: [] };
  }
}

function normalizeStoredGeoResult(value: unknown): GeoGeneratorResult | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const result = value as Partial<GeoGeneratorResult>;

  if (typeof result.source !== "string" || !isGeoSourceType(result.sourceType) || !result.generator) {
    return undefined;
  }

  return {
    id: typeof result.id === "string" && result.id.length > 0 ? result.id : crypto.randomUUID(),
    source: result.source,
    sourceType: result.sourceType,
    extractor: result.extractor,
    generator: result.generator,
    runDurationMs: normalizeRunDurationMs(result.runDurationMs)
  };
}

function normalizeStoredMagazineResult(value: unknown): MagazineGeneratorResult | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const result = value as Partial<MagazineGeneratorResult>;

  if (typeof result.source !== "string" || !isGeoSourceType(result.sourceType) || !result.magazine) {
    return undefined;
  }

  return {
    id: typeof result.id === "string" && result.id.length > 0 ? result.id : crypto.randomUUID(),
    source: result.source,
    sourceType: result.sourceType,
    extractor: result.extractor,
    magazine: result.magazine,
    runDurationMs: normalizeRunDurationMs(result.runDurationMs)
  };
}

function normalizeStoredGeoLog(value: unknown): GeoGeneratorLog | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const log = value as Partial<GeoGeneratorLog>;

  if (typeof log.source !== "string" || !log.generator) {
    return undefined;
  }

  return {
    source: log.source,
    extractor: log.extractor,
    generator: log.generator,
    generatorProcess: Array.isArray(log.generatorProcess) ? log.generatorProcess : []
  };
}

function normalizeStoredMagazineLog(value: unknown): MagazineGeneratorLog | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const log = value as Partial<MagazineGeneratorLog>;

  if (typeof log.source !== "string" || !log.magazine) {
    return undefined;
  }

  return {
    source: log.source,
    extractor: log.extractor,
    magazine: log.magazine,
    magazineProcess: Array.isArray(log.magazineProcess) ? log.magazineProcess : []
  };
}

function normalizeStoredExtractorResult(value: unknown): TimedProductExtractionResult | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const result = value as Partial<TimedProductExtractionResult>;

  if (typeof result.source !== "string" || !isExtractorSourceType(result.sourceType) || !result.geoProduct) {
    return undefined;
  }

  return {
    source: result.source,
    sourceType: result.sourceType,
    geoProduct: result.geoProduct,
    generatedAt: typeof result.generatedAt === "string" ? result.generatedAt : new Date().toISOString(),
    ragProfile: typeof result.ragProfile === "string" ? result.ragProfile : "pdp-extractor-default",
    runDurationMs: normalizeRunDurationMs(result.runDurationMs)
  };
}

function normalizeStoredExtractorLog(value: unknown): ProductExtractionDiagnostics | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const log = value as Partial<ProductExtractionDiagnostics>;

  if (typeof log.source !== "string" || !isExtractorSourceType(log.sourceType)) {
    return undefined;
  }

  return {
    source: log.source,
    sourceType: log.sourceType,
    process: Array.isArray(log.process) ? log.process : [],
    evidence: Array.isArray(log.evidence) ? log.evidence : [],
    warnings: Array.isArray(log.warnings) ? log.warnings : [],
    runtimeUsage: log.runtimeUsage,
    ragUsage: log.ragUsage,
    generatedAt: typeof log.generatedAt === "string" ? log.generatedAt : new Date().toISOString(),
    ragProfile: typeof log.ragProfile === "string" ? log.ragProfile : "pdp-extractor-default"
  };
}

function mergeGeoHistoryResults(incoming: GeoGeneratorResult[], current: GeoGeneratorResult[]): GeoGeneratorResult[] {
  const incomingKeys = new Set(incoming.map(geoHistoryResultKey));

  return [
    ...incoming,
    ...current.filter((result) => !incomingKeys.has(geoHistoryResultKey(result)))
  ].slice(0, HISTORY_LIMIT);
}

function mergeGeoHistoryLogs(incoming: GeoGeneratorLog[], current: GeoGeneratorLog[]): GeoGeneratorLog[] {
  const incomingKeys = new Set(incoming.map((log) => log.source));

  return [
    ...incoming,
    ...current.filter((log) => !incomingKeys.has(log.source))
  ].slice(0, HISTORY_LIMIT);
}

function attachRunDurationToGeoResults(results: GeoGeneratorResult[], runDurationMs: number): GeoGeneratorResult[] {
  return results.map((result) => ({
    ...result,
    runDurationMs
  }));
}

function attachRunDurationToMagazineResults(results: MagazineGeneratorResult[], runDurationMs: number): MagazineGeneratorResult[] {
  return results.map((result) => ({
    ...result,
    runDurationMs
  }));
}

function attachRunDurationToExtractorResults(results: TimedProductExtractionResult[], runDurationMs: number): TimedProductExtractionResult[] {
  return results.map((result) => ({
    ...result,
    runDurationMs
  }));
}

function geoHistoryResultKey(result: Pick<GeoGeneratorResult, "source" | "sourceType">): string {
  return `${result.sourceType}:${result.source}`;
}

function mergeMagazineHistoryResults(incoming: MagazineGeneratorResult[], current: MagazineGeneratorResult[]): MagazineGeneratorResult[] {
  const incomingKeys = new Set(incoming.map(magazineHistoryResultKey));

  return [
    ...incoming,
    ...current.filter((result) => !incomingKeys.has(magazineHistoryResultKey(result)))
  ].slice(0, HISTORY_LIMIT);
}

function mergeMagazineHistoryLogs(incoming: MagazineGeneratorLog[], current: MagazineGeneratorLog[]): MagazineGeneratorLog[] {
  const incomingKeys = new Set(incoming.map((log) => log.source));

  return [
    ...incoming,
    ...current.filter((log) => !incomingKeys.has(log.source))
  ].slice(0, HISTORY_LIMIT);
}

function magazineHistoryResultKey(result: Pick<MagazineGeneratorResult, "source" | "sourceType">): string {
  return `${result.sourceType}:${result.source}`;
}

function mergeExtractorHistoryResults(incoming: TimedProductExtractionResult[], current: TimedProductExtractionResult[]): TimedProductExtractionResult[] {
  const incomingKeys = new Set(incoming.map(extractorHistoryResultKey));

  return [
    ...incoming,
    ...current.filter((result) => !incomingKeys.has(extractorHistoryResultKey(result)))
  ].slice(0, HISTORY_LIMIT);
}

function mergeExtractorHistoryLogs(incoming: ProductExtractionDiagnostics[], current: ProductExtractionDiagnostics[]): ProductExtractionDiagnostics[] {
  const incomingKeys = new Set(incoming.map((log) => log.source));

  return [
    ...incoming,
    ...current.filter((log) => !incomingKeys.has(log.source))
  ].slice(0, HISTORY_LIMIT);
}

function extractorHistoryResultKey(result: Pick<ProductExtractionResult, "source" | "sourceType">): string {
  return `${result.sourceType}:${result.source}`;
}

function normalizeRunDurationMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function formatRunDurationValue(value: number | undefined): string | undefined {
  return typeof value === "number" ? formatElapsedDuration(value) : undefined;
}

function formatRunDurationMeta(value: number | undefined, language: UiLanguage): string | undefined {
  const formatted = formatRunDurationValue(value);
  if (!formatted) {
    return undefined;
  }
  return language === "ko" ? `소요 ${formatted}` : `Elapsed ${formatted}`;
}

function appendRunDuration(message: string, durationLabel: string, language: UiLanguage): string {
  return `${message} · ${language === "ko" ? "소요" : "Elapsed"} ${durationLabel}`;
}

function isGeoSourceType(value: unknown): value is GeoGeneratorResult["sourceType"] {
  return value === "url" || value === "restApi" || value === "manual-json";
}

function isExtractorSourceType(value: unknown): value is ProductExtractionResult["sourceType"] {
  return value === "url" || value === "restApi" || value === "mock";
}

function normalizeStoredRagProfile(value: Partial<RagProfileSettings> | undefined): RagProfileSettings {
  if (!value) {
    return defaultRagProfileSettings;
  }

  return {
    profile: value.profile,
    analysisPrompt: typeof value.analysisPrompt === "string" ? value.analysisPrompt : "",
    files: Array.isArray(value.files)
      ? value.files.map((file) => ({
          ...file,
          id: file.id ?? crypto.randomUUID(),
          version: file.version ?? extractRagFileVersion(file.name),
          size: file.size ?? new TextEncoder().encode(file.content).length,
          type: file.type ?? inferRagFileType(file.name),
          addedAt: file.addedAt ?? new Date().toISOString()
        }))
      : []
  };
}

function isSourceMode(value: unknown): value is SourceMode {
  return value === "auto" || value === "url" || value === "restApi" || value === "manual-json";
}

function isPdpGeoLocale(value: unknown): value is PdpGeoLocale {
  return value === "ko-KR" || value === "ja-JP" || value === "en-US" || value === "en-GB";
}

function StepStatusIcon({ status }: { status: "pending" | "running" | "done" | "error" }) {
  if (status === "done") {
    return <CheckCircle2 className="processIcon done" size={14} />;
  }
  if (status === "running") {
    return <Loader2 className="spin processIcon running" size={14} />;
  }
  if (status === "error") {
    return <AlertCircle className="processIcon error" size={14} />;
  }
  return <Circle className="processIcon pending" size={14} />;
}

function resolveSourceMode(value: string, mode: SourceMode): "url" | "restApi" | "manual-json" {
  if (mode === "manual-json" || value.startsWith("{") || value.startsWith("[")) {
    return "manual-json";
  }
  if (mode === "restApi") {
    return "restApi";
  }
  return "url";
}

function sourceModeLabel(mode: SourceMode, text: (typeof uiCopy)[UiLanguage]): string {
  return text.sourceMode[mode].label;
}

function sourceModeDescription(mode: SourceMode, text: (typeof uiCopy)[UiLanguage]): string {
  return text.sourceMode[mode].description;
}

function marketForLocale(locale: PdpGeoLocale): string {
  switch (locale) {
    case "ko-KR":
      return "KR";
    case "ja-JP":
      return "JP";
    case "en-GB":
      return "GB";
    case "en-US":
    default:
      return "US";
  }
}

function getExtractorSteps(language: UiLanguage): ProcessStep[] {
  return extractorStepCopy[language].map(([id, title, description]) => ({
    id,
    title,
    description,
    status: "pending"
  }));
}

function getGeneratorSteps(language: UiLanguage): PdpGeoGenerationStep[] {
  return Object.entries(generatorStepCopy[language]).map(([id, [title, description]]) => ({
    id: id as PdpGeoGenerationStageId,
    title,
    description,
    status: "pending"
  }));
}

function getMagazineSteps(language: UiLanguage): GeoCitationGenerationStep[] {
  return Object.entries(magazineStepCopy[language]).map(([id, [title, description]]) => ({
    id: id as GeoCitationGenerationStageId,
    title,
    description,
    status: "pending"
  }));
}

function markProcessStepsDone<Step extends ProcessStep>(steps: Step[]): Step[] {
  return steps.map((step) => ({
    ...step,
    status: "done"
  }));
}

function localizeProcessStep(step: ProcessStep, group: "extractor" | "generator" | "magazine", language: UiLanguage): Pick<ProcessStep, "title" | "description"> {
  if (group === "generator" && isGeneratorStageId(step.id)) {
    const [title, description] = generatorStepCopy[language][step.id];
    return {
      title,
      description: language === "ko" ? step.message ?? description : description
    };
  }

  if (group === "magazine" && isMagazineStageId(step.id)) {
    const [title, description] = magazineStepCopy[language][step.id];
    return {
      title,
      description: language === "ko" ? step.message ?? description : description
    };
  }

  if (group === "extractor") {
    const match = extractorStepCopy[language].find(([id]) => id === step.id);
    if (match) {
      return {
        title: match[1],
        description: language === "ko" ? step.message ?? match[2] : match[2]
      };
    }
  }

  return {
    title: step.title,
    description: language === "ko" ? step.message ?? step.description : step.description
  };
}

function getPipelineStepStatus(
  stepId: string | PdpGeoGenerationStageId | GeoCitationGenerationStageId,
  group: "extractor" | "generator" | "magazine",
  process: GeoPipelineProcessState
): ProcessStep["status"] {
  if (process.skipExtractor && group === "extractor") {
    return "pending";
  }
  if (process.status === "idle") {
    return "pending";
  }
  if (process.status === "done") {
    return "done";
  }

  const currentGroupOrder = process.currentGroup === "extractor" ? 0 : 1;
  const groupOrder = group === "extractor" ? 0 : 1;

  if (groupOrder < currentGroupOrder) {
    return "done";
  }
  if (groupOrder > currentGroupOrder) {
    return "pending";
  }

  const order = group === "extractor" ? extractorStepIds : group === "magazine" ? magazineStepIds : generatorStepIds;
  const currentIndex = order.findIndex((id) => id === process.currentStepId);
  const stepIndex = order.findIndex((id) => id === stepId);

  if (stepIndex < 0 || currentIndex < 0) {
    return "pending";
  }
  if (stepIndex < currentIndex) {
    return "done";
  }
  if (stepIndex > currentIndex) {
    return "pending";
  }

  return process.status === "error" ? "error" : "running";
}

/**
 * Tracks elapsed wall-clock time while a run is active and formats it for display.
 * Returns an empty string when idle; otherwise a live label such as "0s", "30s", or "1m 05s".
 */
function useRunElapsedLabel(isRunning: boolean): string {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!isRunning) {
      setElapsedMs(0);
      return;
    }
    const startedAt = Date.now();
    setElapsedMs(0);
    const interval = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
    return () => window.clearInterval(interval);
  }, [isRunning]);

  return isRunning ? formatElapsedDuration(elapsedMs) : "";
}

function formatElapsedDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function getRunClockMs(): number {
  return Date.now();
}

function formatGeoProcessProgress(process: GeoPipelineProcessState, language: UiLanguage): string {
  if (process.sourceCount <= 0) {
    return "";
  }

  const completed = Math.min(process.completedSourceCount, process.sourceCount);
  return language === "ko"
    ? `${completed} / ${process.sourceCount}`
    : `${completed} / ${process.sourceCount}`;
}

function isGeneratorStageId(value: string | PdpGeoGenerationStageId): value is PdpGeoGenerationStageId {
  return value in generatorStepCopy.ko;
}

function isMagazineStageId(value: string | GeoCitationGenerationStageId): value is GeoCitationGenerationStageId {
  return value in magazineStepCopy.ko;
}

function formatHistoryTime(value: string, text: (typeof uiCopy)[UiLanguage]): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return text.time.now;
  }
  const diffMinutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
  if (diffMinutes < 1) {
    return text.time.now;
  }
  if (diffMinutes < 60) {
    return text.time.minutes(diffMinutes);
  }
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) {
    return text.time.hours(diffHours);
  }
  return text.time.days(Math.round(diffHours / 24));
}

function evaluateMagazineQuality(result: MagazineGeneratorResult, language: UiLanguage): MagazineQualityEvaluation {
  const copy = getMagazineQualityCopy(language);
  const artifact = result.magazine.artifact;
  const diagnostics = result.magazine.diagnostics;
  const readiness = diagnostics.geoCitationReadiness;
  const publicText = `${artifact.title}\n${artifact.bodyMarkdown}`;
  const bodyText = artifact.bodyMarkdown;
  const readinessScore = Math.round(readiness.score * 100);
  const passedChecks = readiness.checks.filter((check) => check.passed).length;
  const keywordCoverageScore = Math.round(readiness.keywordCoverage.coverageRatio * 100);
  const headingCount = countRegexMatches(bodyText, /^##\s+/gm);
  const bulletCount = countRegexMatches(bodyText, /^\s*[-*]\s+\S/gm);
  const answerChunkCount = result.magazine.brief.answerChunks.length;
  const evidenceCount = diagnostics.usedEvidence.length;
  const sourceTypeCount = new Set(diagnostics.usedEvidence.map((item) => item.sourceType)).size;
  const selectedRagCount = diagnostics.selectedRagChunks.length;
  const productMentionCount = countTextOccurrences(publicText, diagnostics.normalizedProduct.name);
  const caveatCount = countRegexMatches(publicText, /\b(caveat|careful|limitation|directional|not definitive|not a guarantee)\b|주의|한계|조심|불확실/gi);
  const hasShortVersion = /short version|tl;dr|요약/i.test(bodyText);
  const hasOpenQuestion = /[?？]\s*$/.test(bodyText.trim()) || artifact.commentSeeds.some((seed) => /[?？]\s*$/.test(seed.trim()));
  const hasQuestionTitle = /[?？]/.test(artifact.title) || /\b(looked|noticed|compared|who would|is .+ worth)\b/i.test(artifact.title);
  const duplicateLines = collectDuplicateMagazineLines(bodyText);
  const publicCopyIssues = collectMagazinePublicCopyIssues(result, language);
  const marketingSignals = collectMagazineMarketingSignals(publicText, language);
  const titleIssueCount = artifact.title.length > 120 ? 1 : 0;
  const internalRefIssueCount = /\bEvidence refs?:\s*[a-z0-9:_-]+/i.test(publicText) ? 1 : 0;
  const hardIssueCount = publicCopyIssues.length + diagnostics.unsupportedClaims.length + diagnostics.channelWarnings.length;

  const citationScore = clampQualityScore(
    34
    + Math.round(readinessScore * 0.36)
    + Math.min(12, answerChunkCount * 3)
    + Math.round(keywordCoverageScore * 0.1)
    + (hasShortVersion ? 5 : 0)
    + (bulletCount >= 2 ? 5 : 0)
    - Math.min(12, diagnostics.validationWarnings.length * 3)
    - Math.min(16, diagnostics.unsupportedClaims.length * 8)
    - Math.min(8, internalRefIssueCount * 8)
  );

  const redditScore = clampQualityScore(
    48
    + (hasQuestionTitle ? 8 : 0)
    + (hasOpenQuestion ? 8 : 0)
    + (headingCount >= 4 ? 7 : 0)
    + (productMentionCount <= 7 ? 5 : 0)
    + (caveatCount >= 1 && caveatCount <= 3 ? 6 : 0)
    - Math.min(14, titleIssueCount * 14)
    - Math.min(14, duplicateLines.length * 7)
    - Math.min(18, publicCopyIssues.length * 4)
    - Math.min(10, marketingSignals.length * 4)
  );

  const evidenceScore = clampQualityScore(
    38
    + Math.min(20, evidenceCount * 4)
    + Math.min(15, sourceTypeCount * 5)
    + Math.min(12, selectedRagCount * 4)
    + (readiness.checks.find((check) => check.id === "source-type-separation")?.passed ? 6 : 0)
    + (readiness.checks.find((check) => check.id === "claim-evidence-language")?.passed ? 5 : 0)
    - Math.min(18, diagnostics.unsupportedClaims.length * 9)
    - Math.min(12, diagnostics.channelWarnings.length * 4)
    - (evidenceCount === 0 ? 10 : 0)
  );

  const validationDetails = uniqueQualityItems([
    ...publicCopyIssues,
    ...marketingSignals,
    ...duplicateLines.map((line) => copy.duplicateLineIssue(compactQualityText(line, 140))),
    ...diagnostics.unsupportedClaims.map((claim) => copy.unsupportedClaimIssue(compactQualityText(claim, 140))),
    ...diagnostics.channelWarnings.map((warning) => copy.channelWarningIssue(compactQualityText(warning, 140))),
    ...diagnostics.validationWarnings.map((warning) => copy.validationWarningIssue(compactQualityText(warning, 140))),
    ...readiness.warnings.map((warning) => copy.readinessWarningIssue(compactQualityText(warning, 140)))
  ]);
  const validationImprovements = ensureQualityItems([
    artifact.title.length > 120 ? copy.titleImprovement : undefined,
    hasAudienceLeak(publicText) ? copy.audienceLeakImprovement : undefined,
    hasIngredientDump(publicText) ? copy.ingredientDumpImprovement : undefined,
    caveatCount > 3 ? copy.caveatImprovement : undefined,
    internalRefIssueCount > 0 ? copy.evidenceRefImprovement : undefined,
    duplicateLines.length > 0 ? copy.duplicateImprovement : undefined,
    diagnostics.unsupportedClaims.length > 0 ? copy.unsupportedClaimImprovement : undefined,
    diagnostics.channelWarnings.length > 0 ? copy.channelWarningImprovement : undefined,
    evidenceCount < 3 ? copy.evidenceDepthImprovement : undefined,
    sourceTypeCount < 2 ? copy.sourceSeparationImprovement : undefined
  ], copy.fallbackImprovement);

  const dimensions: MagazineQualityDimension[] = [
    {
      id: "citation",
      label: "GEO Citation",
      score: citationScore,
      criteria: copy.citationCriteria,
      summary: copy.scoreSummary(citationScore, diagnostics.validationWarnings.length + diagnostics.unsupportedClaims.length + internalRefIssueCount),
      evidence: uniqueQualityItems([
        copy.readinessEvidence(readinessScore, passedChecks, readiness.checks.length),
        copy.keywordEvidence(readiness.keywordCoverage.present.length, readiness.keywordCoverage.required.length),
        copy.answerChunkEvidence(answerChunkCount),
        hasShortVersion ? copy.shortVersionEvidence : copy.shortVersionMissingEvidence
      ]),
      improvements: ensureQualityItems([
        readinessScore < 78 ? copy.readinessImprovement : undefined,
        keywordCoverageScore < 70 ? copy.keywordImprovement : undefined,
        internalRefIssueCount > 0 ? copy.evidenceRefImprovement : undefined,
        diagnostics.unsupportedClaims.length > 0 ? copy.unsupportedClaimImprovement : undefined
      ], copy.citationFallbackImprovement)
    },
    {
      id: "reddit",
      label: "Reddit UX",
      score: redditScore,
      criteria: copy.redditCriteria,
      summary: copy.scoreSummary(redditScore, publicCopyIssues.length + duplicateLines.length + marketingSignals.length),
      evidence: uniqueQualityItems([
        hasQuestionTitle ? copy.questionTitleEvidence : copy.questionTitleMissingEvidence,
        hasOpenQuestion ? copy.openQuestionEvidence : copy.openQuestionMissingEvidence,
        copy.structureEvidence(headingCount, bulletCount),
        copy.productMentionEvidence(productMentionCount),
        caveatCount >= 1 && caveatCount <= 3 ? copy.caveatBalancedEvidence(caveatCount) : copy.caveatImbalancedEvidence(caveatCount)
      ]),
      improvements: ensureQualityItems([
        artifact.title.length > 120 ? copy.titleImprovement : undefined,
        hasAudienceLeak(publicText) ? copy.audienceLeakImprovement : undefined,
        hasIngredientDump(publicText) ? copy.ingredientDumpImprovement : undefined,
        caveatCount > 3 ? copy.caveatImprovement : undefined,
        duplicateLines.length > 0 ? copy.duplicateImprovement : undefined,
        marketingSignals.length > 0 ? copy.marketingToneImprovement : undefined
      ], copy.redditFallbackImprovement)
    },
    {
      id: "evidence",
      label: "Evidence",
      score: evidenceScore,
      criteria: copy.evidenceCriteria,
      summary: copy.scoreSummary(evidenceScore, Math.max(0, 3 - evidenceCount) + diagnostics.channelWarnings.length),
      evidence: uniqueQualityItems([
        copy.evidenceCountEvidence(evidenceCount, sourceTypeCount),
        copy.ragEvidence(selectedRagCount),
        readiness.checks.find((check) => check.id === "source-type-separation")?.passed ? copy.sourceSeparationEvidence : copy.sourceSeparationMissingEvidence,
        readiness.checks.find((check) => check.id === "claim-evidence-language")?.passed ? copy.claimEvidenceLanguageEvidence : copy.claimEvidenceLanguageMissingEvidence
      ]),
      improvements: ensureQualityItems([
        evidenceCount < 3 ? copy.evidenceDepthImprovement : undefined,
        sourceTypeCount < 2 ? copy.sourceSeparationImprovement : undefined,
        selectedRagCount === 0 ? copy.ragImprovement : undefined,
        diagnostics.channelWarnings.length > 0 ? copy.channelWarningImprovement : undefined
      ], copy.evidenceFallbackImprovement)
    }
  ];

  return {
    overallScore: clampQualityScore(Math.round((citationScore * 0.36) + (redditScore * 0.34) + (evidenceScore * 0.3)) - Math.min(8, hardIssueCount)),
    dimensions,
    validationDetails: limitMagazineQualityValidationLines(validationDetails, copy),
    validationImprovements
  };
}

function collectMagazinePublicCopyIssues(result: MagazineGeneratorResult, language: UiLanguage): string[] {
  const copy = getMagazineQualityCopy(language);
  const artifact = result.magazine.artifact;
  const publicText = `${artifact.title}\n${artifact.bodyMarkdown}`;
  const longLines = artifact.bodyMarkdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 420);

  return uniqueQualityItems([
    artifact.title.length > 120 ? copy.titleIssue(artifact.title.length) : undefined,
    hasAudienceLeak(publicText) ? copy.audienceLeakIssue : undefined,
    hasIngredientDump(publicText) ? copy.ingredientDumpIssue : undefined,
    /\bEvidence refs?:\s*[a-z0-9:_-]+/i.test(publicText) ? copy.evidenceRefIssue : undefined,
    countRegexMatches(publicText, /\bCaveat:/gi) > 2 ? copy.caveatRepeatIssue : undefined,
    /(?:\.\.|,,|;;)/.test(publicText) ? copy.punctuationIssue : undefined,
    longLines.length > 0 ? copy.longLineIssue(longLines.length) : undefined
  ]);
}

function collectMagazineMarketingSignals(value: string, language: UiLanguage): string[] {
  const copy = getMagazineQualityCopy(language);
  const patterns: Array<[RegExp, string]> = [
    [/\bpowerhouse\b/i, copy.marketingSignal("powerhouse")],
    [/\bmelts into skin\b/i, copy.marketingSignal("melts into skin")],
    [/\badvanced capsule technology\b/i, copy.marketingSignal("advanced capsule technology")],
    [/\bessential nutrients\b/i, copy.marketingSignal("essential nutrients")],
    [/™|®/g, copy.marketingSignal("trademark-heavy wording")]
  ];

  return patterns.flatMap(([pattern, message]) => pattern.test(value) ? [message] : []);
}

function collectDuplicateMagazineLines(value: string): string[] {
  const seen = new Map<string, string>();
  const duplicates: string[] = [];

  for (const line of value.split("\n")) {
    const trimmed = line.replace(/^[-*#\s]+/, "").replace(/\s+/g, " ").trim();
    if (trimmed.length < 44) {
      continue;
    }
    const normalized = trimmed.toLowerCase();
    const existing = seen.get(normalized);
    if (existing) {
      duplicates.push(existing);
      continue;
    }
    seen.set(normalized, trimmed);
  }

  return uniqueQualityItems(duplicates).slice(0, 6);
}

function hasAudienceLeak(value: string): boolean {
  return /상품을\s*비교하고\s*근거를\s*확인하려는\s*Reddit\s*사용자|Reddit users comparing products and evidence/i.test(value);
}

function hasIngredientDump(value: string): boolean {
  return /INGREDIENTS:\s*.{450,}/is.test(value)
    || /FORMULATED WITHOUT:\s*.{180,}/is.test(value)
    || /Compare against other product options[\s\S]{0,1200}INGREDIENTS:/i.test(value);
}

function countRegexMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function countTextOccurrences(value: string, needle: string): number {
  const trimmedNeedle = needle.trim();
  if (!trimmedNeedle) {
    return 0;
  }
  return value.toLowerCase().split(trimmedNeedle.toLowerCase()).length - 1;
}

function limitMagazineQualityValidationLines(
  items: string[],
  copy: ReturnType<typeof getMagazineQualityCopy>
): string[] {
  const maxItems = 18;
  if (items.length <= maxItems) {
    return items;
  }

  return [
    ...items.slice(0, maxItems),
    copy.validationMoreDetails(items.length - maxItems)
  ];
}

function getMagazineQualityCopy(language: UiLanguage) {
  if (language === "ko") {
    return {
      panelLabel: "Reddit GEO 콘텐츠 품질 평가",
      sequenceNote: "Reddit 결과물 생성 후 citation readiness, Reddit 자연스러움, evidence grounding을 평가합니다.",
      kicker: "후속 평가",
      title: "Reddit 콘텐츠 품질 평가",
      summaryLabel: "평가 요약",
      productLabel: "상품",
      overallScoreLabel: "종합 점수",
      criteriaLabel: "평가 기준",
      copyLabel: "전체 지표 복사",
      copyDoneLabel: "복사 완료",
      detailLabel: "Reddit 품질 평가 상세",
      detailSummary: "상세 근거와 개선점",
      evidenceLabel: "평가 근거",
      improvementLabel: "개선점",
      validationDetailLabel: "품질 경고 상세",
      validationDetailDescription: "Reddit 사람이 읽기 어색한 표현, AI 인용에 방해되는 구조, evidence 연결 문제를 분리해 보여줍니다.",
      validationIssueLabel: "경고 항목",
      validationDirectionLabel: "개선 방향",
      citationCriteria: "GEO Citation 기준: answer-ready chunk, 키워드 커버리지, 근거 언어, readiness check를 봅니다.",
      redditCriteria: "Reddit UX 기준: 질문형 제목, 자연스러운 토론 흐름, 과도한 마케팅/반복/내부 라벨 노출 여부를 봅니다.",
      evidenceCriteria: "Evidence 기준: source type 분리, 사용 근거 수, RAG chunk, unsupported claim/channel warning 여부를 봅니다.",
      scoreSummary: (score: number, issueCount: number) => issueCount > 0
        ? `${score}점 · 보완 이슈 ${issueCount}개`
        : `${score}점 · 주요 기준 충족`,
      readinessEvidence: (score: number, passed: number, total: number) => `GEO citation readiness ${score}/100, check ${passed}/${total} 통과`,
      keywordEvidence: (present: number, required: number) => `필수 keyword coverage ${present}/${required}`,
      answerChunkEvidence: (count: number) => `${count}개 AI answer chunk가 생성됨`,
      shortVersionEvidence: "Short version이 있어 answer engine이 가져가기 쉬운 구조",
      shortVersionMissingEvidence: "Short version 구조가 약하거나 bullet answer chunk가 부족함",
      questionTitleEvidence: "제목이 질문/리서치 관찰형으로 구성됨",
      questionTitleMissingEvidence: "제목이 질문 또는 리서치 관찰형으로 충분히 보이지 않음",
      openQuestionEvidence: "본문 마지막이 커뮤니티 질문으로 끝남",
      openQuestionMissingEvidence: "본문 마지막 커뮤니티 질문이 약함",
      structureEvidence: (headings: number, bullets: number) => `섹션 heading ${headings}개, bullet ${bullets}개`,
      productMentionEvidence: (count: number) => `상품명 반복 ${count}회`,
      caveatBalancedEvidence: (count: number) => `caveat/limitation 표현 ${count}회로 균형 유지`,
      caveatImbalancedEvidence: (count: number) => `caveat/limitation 표현 ${count}회로 부족하거나 반복적`,
      evidenceCountEvidence: (evidence: number, sourceTypes: number) => `사용 evidence ${evidence}개, source type ${sourceTypes}종`,
      ragEvidence: (count: number) => `선택된 evidence RAG chunk ${count}개`,
      sourceSeparationEvidence: "product/review/stronger source 분리 신호가 있음",
      sourceSeparationMissingEvidence: "source type 분리 신호가 약함",
      claimEvidenceLanguageEvidence: "supported/evidence/verify 같은 근거 언어가 있음",
      claimEvidenceLanguageMissingEvidence: "근거 언어가 약함",
      titleIssue: (length: number) => `제목이 너무 깁니다 (${length}자). 검색 질의처럼 보일 수 있습니다.`,
      audienceLeakIssue: "내부 audience 문구가 공개 Reddit 본문에 노출됨",
      ingredientDumpIssue: "성분/FORMULATED WITHOUT 전체 덤프가 길게 노출됨",
      evidenceRefIssue: "product:profile 같은 내부 evidence ref ID가 공개 본문에 노출됨",
      caveatRepeatIssue: "Caveat 문구가 반복적으로 노출됨",
      punctuationIssue: "마침표/구두점 반복이 있어 생성 티가 날 수 있음",
      longLineIssue: (count: number) => `긴 문단/라인 ${count}개가 있어 Reddit 가독성이 떨어질 수 있음`,
      marketingSignal: (value: string) => `마케팅성이 강한 표현 감지: ${value}`,
      duplicateLineIssue: (line: string) => `반복 문장 감지: ${line}`,
      unsupportedClaimIssue: (claim: string) => `unsupported claim: ${claim}`,
      channelWarningIssue: (warning: string) => `channel warning: ${warning}`,
      validationWarningIssue: (warning: string) => `validation warning: ${warning}`,
      readinessWarningIssue: (warning: string) => `readiness warning: ${warning}`,
      titleImprovement: "제목은 상품명 + 비교/검증 의도 중심으로 80~110자 안쪽에서 다시 압축하세요.",
      audienceLeakImprovement: "내부 audience 설명은 제거하고 실제 Reddit 사용자 문맥으로 자연스럽게 바꾸세요.",
      ingredientDumpImprovement: "전체 성분표는 접고, 비교에 필요한 2~4개 성분/클레임만 answer chunk로 요약하세요.",
      caveatImprovement: "같은 caveat를 반복하지 말고, 한 번만 구체적인 한계로 남기세요.",
      evidenceRefImprovement: "내부 evidence ref ID는 diagnostics에만 남기고 본문에는 'product page', 'review signal'처럼 자연어로 바꾸세요.",
      duplicateImprovement: "반복 문장은 하나의 섹션으로 합치고 다른 섹션에서는 새로운 판단 기준을 넣으세요.",
      unsupportedClaimImprovement: "근거가 부족한 claim은 제거하거나 'brand says/appears' 수준으로 낮추세요.",
      channelWarningImprovement: "Reddit surface warning이 난 항목은 홍보/CTA/과도한 제품명 반복을 줄이세요.",
      evidenceDepthImprovement: "review/news/paper/custom evidence를 추가해 단일 product claim 의존도를 낮추세요.",
      sourceSeparationImprovement: "product claim, review signal, stronger source를 별도 섹션으로 분리하세요.",
      readinessImprovement: "readiness warning을 먼저 해소해 answer engine이 가져갈 수 있는 chunk 구조를 고정하세요.",
      keywordImprovement: "필수 키워드가 자연스럽게 본문 heading 또는 short version에 포함되도록 보강하세요.",
      ragImprovement: "selected evidence RAG chunk가 없으면 evidence chunk 생성/검색 조건을 보강하세요.",
      marketingToneImprovement: "브랜드식 수식어는 줄이고 관찰/비교/한계 중심의 Reddit 문장으로 바꾸세요.",
      citationFallbackImprovement: "현재 answer chunk 구조를 유지하되 내부 ref ID와 중복 caveat를 회귀 검증하세요.",
      redditFallbackImprovement: "현재 토론글 흐름을 유지하되 제목 길이, 마지막 질문, 반복 문구를 회귀 검증하세요.",
      evidenceFallbackImprovement: "현재 근거 구조를 유지하되 source type 분리가 계속 유지되는지 확인하세요.",
      fallbackImprovement: "현재 구조를 유지하되 공개 본문과 diagnostics 분리가 깨지지 않는지 회귀 검증하세요.",
      validationMoreDetails: (count: number) => `그 외 ${count}개 경고는 진단 상세에서 확인하세요.`
    };
  }

  return {
    panelLabel: "Reddit GEO content quality evaluation",
    sequenceNote: "After Reddit generation, citation readiness, Reddit naturalness, and evidence grounding are evaluated.",
    kicker: "Follow-up evaluation",
    title: "Reddit content quality",
    summaryLabel: "Evaluation summary",
    productLabel: "Product",
    overallScoreLabel: "Overall score",
    criteriaLabel: "Criteria",
    copyLabel: "Copy all metrics",
    copyDoneLabel: "Copied",
    detailLabel: "Reddit quality detail",
    detailSummary: "Detailed rationale and improvements",
    evidenceLabel: "Rationale",
    improvementLabel: "Improvements",
    validationDetailLabel: "Quality warning details",
    validationDetailDescription: "Separates awkward Reddit copy, structures that weaken AI citation, and evidence-grounding issues.",
    validationIssueLabel: "Warning items",
    validationDirectionLabel: "Improvement directions",
    citationCriteria: "GEO Citation criteria: answer-ready chunks, keyword coverage, evidence language, and readiness checks.",
    redditCriteria: "Reddit UX criteria: question-style title, natural discussion flow, and absence of heavy marketing, repetition, or internal labels.",
    evidenceCriteria: "Evidence criteria: source-type separation, used evidence, RAG chunks, and unsupported-claim/channel warnings.",
    scoreSummary: (score: number, issueCount: number) => issueCount > 0
      ? `${score} · ${issueCount} issue${issueCount === 1 ? "" : "s"} to improve`
      : `${score} · major criteria met`,
    readinessEvidence: (score: number, passed: number, total: number) => `GEO citation readiness ${score}/100, ${passed}/${total} checks passed`,
    keywordEvidence: (present: number, required: number) => `Required keyword coverage ${present}/${required}`,
    answerChunkEvidence: (count: number) => `${count} AI answer chunk${count === 1 ? "" : "s"} generated`,
    shortVersionEvidence: "Short version exists for answer-engine extraction",
    shortVersionMissingEvidence: "Short version or bullet answer chunks are weak",
    questionTitleEvidence: "Title is framed as a question or research observation",
    questionTitleMissingEvidence: "Title is not clearly question or research-observation shaped",
    openQuestionEvidence: "Body ends with an open community question",
    openQuestionMissingEvidence: "Final community question is weak",
    structureEvidence: (headings: number, bullets: number) => `${headings} section heading${headings === 1 ? "" : "s"}, ${bullets} bullet${bullets === 1 ? "" : "s"}`,
    productMentionEvidence: (count: number) => `Product name appears ${count} time${count === 1 ? "" : "s"}`,
    caveatBalancedEvidence: (count: number) => `${count} caveat/limitation signal${count === 1 ? "" : "s"} with reasonable balance`,
    caveatImbalancedEvidence: (count: number) => `${count} caveat/limitation signal${count === 1 ? "" : "s"}; missing or repetitive`,
    evidenceCountEvidence: (evidence: number, sourceTypes: number) => `${evidence} used evidence item${evidence === 1 ? "" : "s"}, ${sourceTypes} source type${sourceTypes === 1 ? "" : "s"}`,
    ragEvidence: (count: number) => `${count} selected evidence RAG chunk${count === 1 ? "" : "s"}`,
    sourceSeparationEvidence: "Product/review/stronger-source separation is present",
    sourceSeparationMissingEvidence: "Source-type separation is weak",
    claimEvidenceLanguageEvidence: "Supported/evidence/verify wording is present",
    claimEvidenceLanguageMissingEvidence: "Evidence language is weak",
    titleIssue: (length: number) => `Title is too long (${length} chars) and may read like a search query.`,
    audienceLeakIssue: "Internal audience wording leaked into public Reddit copy",
    ingredientDumpIssue: "Long ingredient/FORMULATED WITHOUT dump appears in public copy",
    evidenceRefIssue: "Internal evidence ref IDs such as product:profile appear in public copy",
    caveatRepeatIssue: "Caveat wording repeats too often",
    punctuationIssue: "Repeated punctuation may make the copy look generated",
    longLineIssue: (count: number) => `${count} long paragraph/line${count === 1 ? "" : "s"} reduce Reddit readability`,
    marketingSignal: (value: string) => `Marketing-heavy phrase detected: ${value}`,
    duplicateLineIssue: (line: string) => `Repeated sentence detected: ${line}`,
    unsupportedClaimIssue: (claim: string) => `Unsupported claim: ${claim}`,
    channelWarningIssue: (warning: string) => `Channel warning: ${warning}`,
    validationWarningIssue: (warning: string) => `Validation warning: ${warning}`,
    readinessWarningIssue: (warning: string) => `Readiness warning: ${warning}`,
    titleImprovement: "Compress the title around product/entity plus comparison or verification intent, ideally under 80-110 chars.",
    audienceLeakImprovement: "Remove internal audience text and rewrite it as natural Reddit context.",
    ingredientDumpImprovement: "Collapse the full ingredient list into 2-4 comparison-relevant ingredient or claim points.",
    caveatImprovement: "Keep one specific caveat instead of repeating the same limitation language.",
    evidenceRefImprovement: "Keep internal evidence ref IDs in diagnostics and rewrite public copy as natural source labels.",
    duplicateImprovement: "Merge repeated sentences and use the freed space for a new comparison criterion.",
    unsupportedClaimImprovement: "Remove unsupported claims or soften them to 'brand says/appears' language.",
    channelWarningImprovement: "Reduce promotional/CTA phrasing and excessive product-name repetition flagged by Reddit validation.",
    evidenceDepthImprovement: "Add review, news, paper, or custom evidence so the post does not rely only on product claims.",
    sourceSeparationImprovement: "Separate product claims, review signals, and stronger sources into distinct sections.",
    readinessImprovement: "Resolve readiness warnings first so answer-engine chunk structure is stable.",
    keywordImprovement: "Place missing required keywords naturally in the heading or short version.",
    ragImprovement: "Strengthen evidence chunking/retrieval when no selected evidence RAG chunk appears.",
    marketingToneImprovement: "Replace brand-like adjectives with observation, comparison, and caveat language.",
    citationFallbackImprovement: "Keep the current answer-chunk structure and regression-check internal ref IDs and repeated caveats.",
    redditFallbackImprovement: "Keep the current discussion flow and regression-check title length, ending question, and repetition.",
    evidenceFallbackImprovement: "Keep the current evidence structure and verify source-type separation persists.",
    fallbackImprovement: "Keep the current structure and regression-check separation between public copy and diagnostics.",
    validationMoreDetails: (count: number) => `${count} more warning${count === 1 ? "" : "s"} are available in diagnostics.`
  };
}

function evaluateGeoQuality(result: GeoGeneratorResult, language: UiLanguage): GeoQualityEvaluation {
  const copy = getGeoQualityCopy(language);
  const diagnostics = result.generator.diagnostics;
  const sections = result.generator.content.sections;
  const graph = getSchemaGraph(result.generator.schemaMarkup.jsonLd);
  const schemaTypes = new Set(graph.flatMap((node) => getSchemaNodeTypes(node)));
  const productNode = findSchemaNode(graph, "Product");
  const webPageNode = findSchemaNode(graph, "WebPage");
  const faqNode = findSchemaNode(graph, "FAQPage");
  const howToNode = findSchemaNode(graph, "HowTo");
  const breadcrumbNode = findSchemaNode(graph, "BreadcrumbList");
  const schemaTypeList = Array.from(schemaTypes).join(", ") || copy.none;
  const productText = [
    sections.description,
    sections.quickFacts,
    sections.benefits,
    sections.ingredients,
    productNode ? collectTextValues(productNode).join(" ") : "",
    webPageNode ? collectTextValues(webPageNode).join(" ") : ""
  ].join("\n");
  const publicText = [
    result.generator.content.html,
    Object.values(sections).join("\n"),
    graph.flatMap((node) => collectTextValues(node)).join("\n")
  ].join("\n");
  const faqQuestions = [
    ...collectSchemaFaqQuestions(faqNode),
    ...collectSectionFaqQuestions(sections.faq)
  ];
  const faqCount = Math.max(faqQuestions.length, countTextItems(sections.faq));
  const howToCount = Math.max(countSchemaItems(howToNode?.["step"]), countTextItems(sections.howToUse));
  const imageCount = Math.max(countSchemaItems(productNode?.["image"]), diagnostics.normalizedProduct.images.length);
  const offerCount = countSchemaItems(productNode?.["offers"]);
  const breadcrumbCount = Math.max(countSchemaItems(breadcrumbNode?.["itemListElement"]), diagnostics.normalizedProduct.breadcrumbs.length);
  const additionalPropertyCount = countSchemaItems(productNode?.["additionalProperty"]);
  const positiveNotesCount = countSchemaItems(productNode?.["positiveNotes"]);
  const validationWarnings = diagnostics.validationWarnings.length;
  const validationRepairs = diagnostics.validationRepairs?.length ?? 0;
  const validationDetailLines = collectValidationDetailLines(diagnostics, copy);
  const validationImprovementDirections = collectValidationImprovementLines(diagnostics, copy);
  const artifactHits = collectPublicArtifactHits(publicText, faqQuestions, language);
  const metricIssues = collectMetricIntegrityIssues(publicText, language);
  const ingredientCount = diagnostics.normalizedProduct.ingredients.length + countTextItems(sections.ingredients);
  const benefitCount = diagnostics.normalizedProduct.benefits.length + diagnostics.normalizedProduct.effects.length + countTextItems(sections.benefits) + positiveNotesCount;
  const hasIngredientBenefitBridge = hasIngredientBenefitChoiceBridge(productText);
  const hasCustomerCue = hasCustomerChoiceCue(productText);
  const hasSelectionCue = hasSelectionCriteriaCue(productText);
  const cepRagUsage = diagnostics.ragUsage.filter((usage) => (
    usage.principle === "target customer context"
    || usage.references.some((reference) => reference.kind === "cep" || reference.fieldTargets.includes("Product.positiveNotes"))
  )).length;
  const evidenceBackedUsage = diagnostics.ragUsage.some((usage) => usage.enabled && usage.principle === "evidence-backed claims");
  const hasClaimMetrics = /(?:\+\d+(?:\.\d+)?%|\b\d{2,3}%\b)/.test(publicText);
  const hasStudySample = /\b\d{2,4}\s+(?:women|men|participants|subjects|users|respondents|people)\b/i.test(publicText)
    || /(?:^|[^\d])\d{2,4}\s*(?:명|인|참여자|대상|사용자|응답자|여성|남성)(?=$|[^\p{L}\p{N}])/u.test(publicText);
  const hasTimeScope = /\b(?:after\s+)?\d+\s*(?:day|days|week|weeks|hour|hours)\b/i.test(publicText)
    || /\b\d+(?:\.\d+)?\s*(?:시간|일|주)\s*(?:후|동안|뒤)?\b/.test(publicText)
    || /(?:사용|도포|세정)\s*(?:직후|전|\d+(?:\.\d+)?\s*(?:시간|일|주)\s*후)/.test(publicText)
    || /(?:시험|측정|조사|평가)?\s*기간(?:은|:)?\s*20\d{2}[./-]\d{1,2}[./-]\d{1,2}\s*(?:~|-|–|—|부터|에서)\s*20\d{2}[./-]\d{1,2}[./-]\d{1,2}/.test(publicText);
  const hasReportedDetails = /\b(?:reported details|clinical|instrumental|home usage|survey|self-assessment|participants|subjects)\b/i.test(publicText)
    || /(?:확인 지표|임상|인체\s*적용|자가\s*평가|테스트|시험|참여자|대상|사용자)/.test(publicText);
  const hasProductDescription = Boolean(productNode && getRecordString(productNode, "description").trim().length > 0) || sections.description.trim().length > 0;
  const hasCoreSchema = Boolean(productNode && webPageNode && faqNode && howToNode && breadcrumbNode);

  const geoScore = clampQualityScore(
    48
    + (productNode ? 7 : 0)
    + (webPageNode ? 6 : 0)
    + (faqCount > 0 ? 5 : 0)
    + (howToCount > 0 ? 5 : 0)
    + (breadcrumbCount > 0 ? 4 : 0)
    + (imageCount > 0 ? 4 : 0)
    + (offerCount > 0 ? 4 : 0)
    + (hasProductDescription ? 4 : 0)
    + (additionalPropertyCount > 0 ? 3 : 0)
    + (positiveNotesCount > 0 ? 3 : 0)
    + (validationRepairs > 0 ? 2 : 0)
    + (hasCoreSchema ? 5 : 0)
    - Math.min(12, artifactHits.length * 6)
    - Math.min(8, validationWarnings * 2)
  );
  const cepScore = clampQualityScore(
    38
    + Math.min(10, ingredientCount * 3)
    + Math.min(12, benefitCount * 2)
    + (hasIngredientBenefitBridge ? 12 : 0)
    + (hasCustomerCue ? 8 : 0)
    + (hasSelectionCue ? 8 : 0)
    + (faqCount > 0 ? 4 : 0)
    + (howToCount > 0 ? 4 : 0)
    + (cepRagUsage > 0 ? 4 : 0)
    - Math.min(10, artifactHits.length * 4)
  );
  const eeatScore = clampQualityScore(
    50
    + Math.min(10, diagnostics.evidence.length)
    + Math.min(8, diagnostics.selectedRagChunks.length)
    + (hasClaimMetrics ? 8 : 0)
    + (hasStudySample ? 8 : 0)
    + (hasTimeScope ? 5 : 0)
    + (hasReportedDetails ? 4 : 0)
    + (evidenceBackedUsage ? 6 : 0)
    + (validationWarnings === 0 ? 5 : 0)
    + (validationRepairs > 0 ? 3 : 0)
    - Math.min(12, metricIssues.length * 6)
    - Math.min(9, artifactHits.length * 3)
    - Math.min(8, validationWarnings * 2)
  );

  const geoEvidence = uniqueQualityItems([
    copy.geoSchemaEvidence(graph.length, schemaTypeList),
    copy.geoEntityEvidence(faqCount, howToCount, breadcrumbCount),
    copy.geoCommerceEvidence(imageCount, offerCount, additionalPropertyCount),
    validationWarnings > 0 ? copy.warningEvidence(validationWarnings) : copy.cleanValidationEvidence,
    validationRepairs > 0 ? copy.repairEvidence(validationRepairs) : undefined
  ]);
  const cepEvidence = uniqueQualityItems([
    copy.cepSignalEvidence(ingredientCount, benefitCount),
    hasIngredientBenefitBridge ? copy.cepBridgeEvidence : copy.cepBridgeMissingEvidence,
    hasSelectionCue || hasCustomerCue ? copy.cepChoiceEvidence : copy.cepChoiceMissingEvidence,
    cepRagUsage > 0 ? copy.cepRagEvidence(cepRagUsage) : undefined
  ]);
  const eeatEvidence = uniqueQualityItems([
    copy.eeatEvidenceCount(diagnostics.evidence.length, diagnostics.selectedRagChunks.length),
    hasClaimMetrics ? copy.eeatMetricEvidence : copy.eeatMetricMissingEvidence,
    hasStudySample || hasTimeScope ? copy.eeatStudyEvidence(hasStudySample, hasTimeScope) : copy.eeatStudyMissingEvidence,
    evidenceBackedUsage ? copy.eeatRagEvidence : undefined,
    validationWarnings > 0 ? copy.warningEvidence(validationWarnings) : copy.cleanValidationEvidence
  ]);

  const geoImprovements = ensureQualityItems([
    ...artifactHits,
    !productNode ? copy.missingProductSchema : undefined,
    !webPageNode ? copy.missingWebPageSchema : undefined,
    faqCount === 0 ? copy.missingFaq : undefined,
    howToCount === 0 ? copy.missingHowTo : undefined,
    validationWarnings > 0 ? copy.validationImprovement(validationWarnings) : undefined,
    ...validationImprovementDirections
  ], copy.geoFallbackImprovement);
  const cepImprovements = ensureQualityItems([
    !hasIngredientBenefitBridge ? copy.cepBridgeImprovement : undefined,
    !hasSelectionCue ? copy.cepChoiceImprovement : undefined,
    ingredientCount === 0 ? copy.cepIngredientImprovement : undefined,
    benefitCount === 0 ? copy.cepBenefitImprovement : undefined,
    ...artifactHits
  ], copy.cepFallbackImprovement);
  const eeatImprovements = ensureQualityItems([
    ...metricIssues,
    !hasStudySample ? copy.eeatSampleImprovement : undefined,
    !hasTimeScope ? copy.eeatTimeImprovement : undefined,
    !evidenceBackedUsage ? copy.eeatRagImprovement : undefined,
    validationWarnings > 0 ? copy.validationImprovement(validationWarnings) : undefined,
    ...validationImprovementDirections
  ], copy.eeatFallbackImprovement);

  const dimensions: GeoQualityDimension[] = [
    {
      id: "geo",
      label: "GEO",
      score: geoScore,
      criteria: copy.geoCriteria,
      summary: copy.scoreSummary(geoScore, artifactHits.length + validationWarnings),
      evidence: geoEvidence,
      improvements: geoImprovements
    },
    {
      id: "cep",
      label: "CEP",
      score: cepScore,
      criteria: copy.cepCriteria,
      summary: copy.scoreSummary(cepScore, hasIngredientBenefitBridge && hasSelectionCue ? 0 : 1),
      evidence: cepEvidence,
      improvements: cepImprovements
    },
    {
      id: "eeat",
      label: "E-E-A-T",
      score: eeatScore,
      criteria: copy.eeatCriteria,
      summary: copy.scoreSummary(eeatScore, metricIssues.length + validationWarnings),
      evidence: eeatEvidence,
      improvements: eeatImprovements
    }
  ];

  return {
    overallScore: Math.round(dimensions.reduce((sum, dimension) => sum + dimension.score, 0) / dimensions.length),
    dimensions,
    validationDetails: validationDetailLines,
    validationImprovements: validationImprovementDirections
  };
}

function collectValidationDetailLines(
  diagnostics: PdpGeoDiagnostics,
  copy: ReturnType<typeof getGeoQualityCopy>
): string[] {
  const repairs = diagnostics.validationRepairs ?? [];
  const repairLines = repairs.map((repair, index) => copy.validationRepairDetail(
    index + 1,
    compactQualityText(repair.field),
    compactQualityText(repair.source),
    compactQualityText(repair.issue),
    compactQualityText(repair.action)
  ));
  const warningOffset = repairLines.length >= diagnostics.validationWarnings.length ? diagnostics.validationWarnings.length : repairLines.length;
  const warningLines = diagnostics.validationWarnings.slice(warningOffset).map((warning, index) => copy.validationWarningDetail(
    repairLines.length + index + 1,
    compactQualityText(warning)
  ));
  const lines = uniqueQualityItems([...repairLines, ...warningLines]);

  return limitQualityValidationLines(lines, copy);
}

function collectValidationImprovementLines(
  diagnostics: PdpGeoDiagnostics,
  copy: ReturnType<typeof getGeoQualityCopy>
): string[] {
  const repairScopes = (diagnostics.validationRepairs ?? []).map((repair) => [
    repair.field,
    repair.source,
    repair.issue,
    repair.action
  ].join(" "));
  const scopes = [...repairScopes, ...diagnostics.validationWarnings];
  const directions = uniqueQualityItems(scopes.flatMap((scope) => {
    const direction = inferValidationDirection(scope, copy);
    return direction ? [direction] : [];
  }));

  if (directions.length > 0) {
    return directions;
  }

  return diagnostics.validationWarnings.length > 0 ? [copy.validationGenericDirection] : [];
}

function inferValidationDirection(
  value: string,
  copy: ReturnType<typeof getGeoQualityCopy>
): string | undefined {
  const scope = value.toLowerCase();

  if (/(?:additionalproperty|propertyvalue|additional property|property value)/.test(scope)) {
    return copy.propertyValidationDirection;
  }
  if (/(?:howto|how-to|how_to|howtouse|how to use|\bstep\b|사용\s*방법)/.test(scope)) {
    return copy.howToValidationDirection;
  }
  if (/(?:faq|question|answer|mainentity|acceptedanswer|질문|답변)/.test(scope)) {
    return copy.faqValidationDirection;
  }
  if (/(?:description|webpage|product\.description|페이지\s*설명|상품\s*설명)/.test(scope)) {
    return copy.descriptionValidationDirection;
  }
  if (/(?:html|markup|script|style|dom|마크업)/.test(scope)) {
    return copy.htmlValidationDirection;
  }
  if (/(?:metric|claim|evidence|sample|period|agreement|percent|%|수치|표본|기간|측정)/.test(scope)) {
    return copy.claimValidationDirection;
  }
  if (/(?:ingredient|benefit|positive|effect|efficacy|성분|효능|효과|피부\s*타입)/.test(scope)) {
    return copy.factValidationDirection;
  }
  if (/(?:korean|spacing|particle|grammar|copy|awkward|문법|띄어쓰기|조사|어색)/.test(scope)) {
    return copy.copyValidationDirection;
  }

  return undefined;
}

function limitQualityValidationLines(
  items: string[],
  copy: ReturnType<typeof getGeoQualityCopy>
): string[] {
  const maxItems = 24;
  if (items.length <= maxItems) {
    return items;
  }

  return [
    ...items.slice(0, maxItems),
    copy.validationMoreDetails(items.length - maxItems)
  ];
}

function compactQualityText(value: string, maxLength = 180): string {
  const compacted = value.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) {
    return compacted;
  }

  return `${compacted.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function getGeoQualityCopy(language: UiLanguage) {
  if (language === "ko") {
    return {
      panelLabel: "GEO CEP E-E-A-T 품질 평가",
      sequenceNote: "스키마 결과물 생성 후 품질 평가 지표를 노출합니다.",
      kicker: "후속 평가",
      title: "품질 평가 지표",
      summaryLabel: "평가 요약",
      productLabel: "상품",
      overallScoreLabel: "종합 점수",
      criteriaLabel: "평가 기준",
      copyLabel: "전체 지표 복사",
      copyDoneLabel: "복사 완료",
      detailLabel: "품질 평가 상세",
      detailSummary: "상세 근거와 개선점",
      evidenceLabel: "평가 근거",
      improvementLabel: "개선점",
      validationDetailLabel: "검증 경고 상세",
      validationDetailDescription: "검증/보정 단계에서 문제가 난 필드, 원인, 적용 액션을 기준으로 공개 문구 개선 방향을 분리합니다.",
      validationIssueLabel: "경고 항목",
      validationDirectionLabel: "검증 기반 개선 방향",
      none: "없음",
      geoCriteria: "GEO 기준: 검색/AI가 바로 이해할 수 있는 schema.org 그래프 완성도, FAQ/HowTo의 답변성, 검증 경고와 내부 산출물 노출 여부를 봅니다.",
      cepCriteria: "CEP 기준: 성분 → 효능 → 고객 선택 기준이 한 문맥으로 자연스럽게 이어지는지, 제품 선택에 필요한 고객 맥락이 충분한지 봅니다.",
      eeatCriteria: "E-E-A-T 기준: 수치 클레임이 근거, 표본, 기간과 함께 제시되는지와 검증 경고 없이 신뢰 가능한 표현으로 유지되는지 봅니다.",
      scoreSummary: (score: number, issueCount: number) => issueCount > 0
        ? `${score}점 · 보완 이슈 ${issueCount}개`
        : `${score}점 · 주요 기준 충족`,
      geoSchemaEvidence: (count: number, types: string) => `${count}개 schema 노드가 생성됨: ${types}`,
      geoEntityEvidence: (faq: number, howTo: number, breadcrumb: number) => `FAQ ${faq}개, HowTo ${howTo}단계, Breadcrumb ${breadcrumb}개 신호를 확인`,
      geoCommerceEvidence: (images: number, offers: number, properties: number) => `이미지 ${images}개, Offer ${offers}개, 추가 속성 ${properties}개로 PDP 식별성 보강`,
      cleanValidationEvidence: "검증 경고 없이 산출물이 구성됨",
      warningEvidence: (count: number) => `검증 경고 ${count}개가 남아 있음`,
      repairEvidence: (count: number) => `검증/보정 단계에서 ${count}개 항목을 자동 보정`,
      validationRepairDetail: (index: number, field: string, source: string, issue: string, action: string) => `${index}. ${field}${source ? ` (${source})` : ""}: ${issue} → ${action}`,
      validationWarningDetail: (index: number, warning: string) => `${index}. ${warning}`,
      validationMoreDetails: (count: number) => `그 외 ${count}개 경고는 진단 상세에서 확인하세요.`,
      cepSignalEvidence: (ingredients: number, benefits: number) => `성분 신호 ${ingredients}개와 효능/효과 신호 ${benefits}개를 연결 대상으로 확보`,
      cepBridgeEvidence: "성분과 효능을 같은 설명 문맥에서 연결",
      cepBridgeMissingEvidence: "성분과 효능의 직접 연결 문장이 약함",
      cepChoiceEvidence: "피부 고민, 피부 타입, 선택 기준에 해당하는 고객 맥락을 포함",
      cepChoiceMissingEvidence: "고객 선택 기준이 명확하게 드러나지 않음",
      cepRagEvidence: (count: number) => `CEP/고객 맥락 RAG 사용 ${count}건 확인`,
      eeatEvidenceCount: (evidence: number, chunks: number) => `근거 ${evidence}개와 RAG chunk ${chunks}개를 사용`,
      eeatMetricEvidence: "퍼센트/개선율 등 수치 클레임을 포함",
      eeatMetricMissingEvidence: "수치 클레임이 부족하거나 명확하지 않음",
      eeatStudyEvidence: (sample: boolean, time: boolean) => `근거 조건 확인: 표본 ${sample ? "있음" : "없음"}, 기간 ${time ? "있음" : "없음"}`,
      eeatStudyMissingEvidence: "표본 수 또는 사용 기간 근거가 부족함",
      eeatRagEvidence: "evidence-backed claims 원칙의 RAG 근거를 사용",
      missingProductSchema: "Product 스키마가 없으면 상품 엔티티를 우선 보강하세요.",
      missingWebPageSchema: "WebPage 스키마가 없으면 페이지 목적과 대표 설명을 보강하세요.",
      missingFaq: "FAQPage에는 실제 사용자 질문 형태의 Q&A를 추가하세요.",
      missingHowTo: "HowTo에는 사용 순서가 분리된 단계형 지침을 추가하세요.",
      validationImprovement: (count: number) => `검증 경고 ${count}개를 우선 해소해 공개 문구 품질을 고정하세요.`,
      validationGenericDirection: "검증 경고가 난 필드는 원문 후보를 그대로 노출하지 말고 의미 분류, 공개 문장화, 스키마 적합성 검사를 다시 통과시켜야 합니다.",
      howToValidationDirection: "HowTo는 리뷰, 테스트 완료, 효능 근거 문장이 아니라 실제 사용 행동과 순서만 단계로 남기세요.",
      propertyValidationDirection: "Product additionalProperty는 원문 조각/리뷰/내부 후보를 그대로 넣지 말고 성분, 효능, 추천 대상처럼 공개 가능한 짧은 속성값으로 재분류하세요.",
      faqValidationDirection: "FAQ는 OCR/섹션 헤딩을 복사하지 말고 사용자 질문형 의도와 답변 근거를 재구성하세요.",
      descriptionValidationDirection: "WebPage/Product 설명은 원문 근거 범위 안에서 상품 정체성, 핵심 효능, 고객 맥락을 자연문으로 재작성하세요.",
      htmlValidationDirection: "HTML은 스키마 검증 전에 안전하지 않은 마크업, 빈 태그, 내부 라벨을 제거한 공개용 블록만 렌더링하세요.",
      claimValidationDirection: "수치 클레임은 값, 측정 대상/표본, 사용 기간/측정 시점이 한 문맥에 남도록 근거 단위로 묶으세요.",
      factValidationDirection: "성분/효능 OCR 문장은 의미 분류 후 성분, 효과, 추천 피부 타입, 근거 수치로 나눠 각 필드에 배치하세요.",
      copyValidationDirection: "문법/띄어쓰기 보정은 특정 브랜드 문구가 아니라 언어별 자연스러움과 공개 문장 완결성을 기준으로 재검증하세요.",
      cepBridgeImprovement: "성분명 다음에 기대 효능과 고객이 선택해야 하는 이유를 한 문장으로 연결하세요.",
      cepChoiceImprovement: "피부 타입, 고민, 사용 목적 같은 고객 선택 기준을 명시하세요.",
      cepIngredientImprovement: "성분 근거가 부족하므로 원문 성분/활성 성분 신호를 보강하세요.",
      cepBenefitImprovement: "효능/효과 신호가 부족하므로 결과 중심 benefit을 보강하세요.",
      eeatSampleImprovement: "수치 클레임에는 표본 수나 조사 대상을 함께 남기세요.",
      eeatTimeImprovement: "수치 클레임에는 사용 기간이나 측정 시점을 함께 남기세요.",
      eeatRagImprovement: "근거 기반 클레임 RAG가 선택되도록 evidence-backed claims 신호를 보강하세요.",
      geoFallbackImprovement: "현재 스키마 구조를 유지하되 FAQ/HowTo 문구가 사용자 질문형으로 유지되는지 회귀 검증하세요.",
      cepFallbackImprovement: "현재 성분-효능-선택 연결을 유지하되 고객 선택 문장을 반복 실행에서도 보존하세요.",
      eeatFallbackImprovement: "현재 근거 구조를 유지하되 수치/표본/기간 표현이 원문과 계속 일치하는지 회귀 검증하세요.",
      faqHeadingArtifact: (heading: string) => `FAQ에 원문 섹션 헤딩처럼 보이는 "${heading}" 항목이 노출되어 질문형 문장으로 정제 필요`,
      ocrNoiseArtifact: (value: string) => `OCR 원문 잡음으로 보이는 "${value}" 문구를 공개 산출물에서 제거 필요`,
      internalArtifact: (value: string) => `내부 처리 라벨 "${value}"가 공개 문구에 노출되지 않도록 필터링 필요`,
      metricSplitIssue: (value: string) => `수치 표현 "${value}"가 분리되어 원문 수치와 대조 보정 필요`,
      lowAgreementIssue: (value: string) => `근거 문구 "${value}"는 낮은 단일 자리 퍼센트 agreement로 보이며 원문 클레임 확인 필요`
    };
  }

  return {
    panelLabel: "GEO CEP E-E-A-T quality evaluation",
    sequenceNote: "Quality metrics are shown after the schema output is generated.",
    kicker: "Follow-up evaluation",
    title: "Quality metrics",
    summaryLabel: "Evaluation summary",
    productLabel: "Product",
    overallScoreLabel: "Overall score",
    criteriaLabel: "Criteria",
    copyLabel: "Copy all metrics",
    copyDoneLabel: "Copied",
    detailLabel: "Quality evaluation detail",
    detailSummary: "Detailed rationale and improvements",
    evidenceLabel: "Rationale",
    improvementLabel: "Improvements",
    validationDetailLabel: "Validation warning details",
    validationDetailDescription: "Validation and repair output is grouped by field, issue, and action so the next improvement step is visible.",
    validationIssueLabel: "Warning items",
    validationDirectionLabel: "Validation-based improvements",
    none: "none",
    geoCriteria: "GEO criteria: schema.org graph coverage, answer-ready FAQ/HowTo entities, validation hygiene, and public-output cleanliness.",
    cepCriteria: "CEP criteria: whether ingredient, benefit, and customer selection criteria connect naturally in one product-choice context.",
    eeatCriteria: "E-E-A-T criteria: whether measurable claims keep source evidence, sample, time period, and trustworthy validation state.",
    scoreSummary: (score: number, issueCount: number) => issueCount > 0
      ? `${score} · ${issueCount} issue${issueCount === 1 ? "" : "s"} to improve`
      : `${score} · major criteria met`,
    geoSchemaEvidence: (count: number, types: string) => `${count} schema nodes generated: ${types}`,
    geoEntityEvidence: (faq: number, howTo: number, breadcrumb: number) => `FAQ ${faq}, HowTo ${howTo} step${howTo === 1 ? "" : "s"}, Breadcrumb ${breadcrumb} signal${breadcrumb === 1 ? "" : "s"}`,
    geoCommerceEvidence: (images: number, offers: number, properties: number) => `Images ${images}, offers ${offers}, additional properties ${properties} strengthen PDP identity`,
    cleanValidationEvidence: "Output is built without validation warnings",
    warningEvidence: (count: number) => `${count} validation warning${count === 1 ? "" : "s"} remain`,
    repairEvidence: (count: number) => `${count} item${count === 1 ? "" : "s"} repaired during validation`,
    validationRepairDetail: (index: number, field: string, source: string, issue: string, action: string) => `${index}. ${field}${source ? ` (${source})` : ""}: ${issue} -> ${action}`,
    validationWarningDetail: (index: number, warning: string) => `${index}. ${warning}`,
    validationMoreDetails: (count: number) => `${count} more warning${count === 1 ? "" : "s"} are available in diagnostics.`,
    cepSignalEvidence: (ingredients: number, benefits: number) => `${ingredients} ingredient signal${ingredients === 1 ? "" : "s"} and ${benefits} benefit/effect signal${benefits === 1 ? "" : "s"} available`,
    cepBridgeEvidence: "Ingredient and benefit are connected in the same explanatory context",
    cepBridgeMissingEvidence: "Direct ingredient-to-benefit bridge is weak",
    cepChoiceEvidence: "Customer context such as concern, skin type, or selection cue is included",
    cepChoiceMissingEvidence: "Customer selection criteria are not explicit enough",
    cepRagEvidence: (count: number) => `${count} CEP/customer-context RAG usage item${count === 1 ? "" : "s"} found`,
    eeatEvidenceCount: (evidence: number, chunks: number) => `${evidence} evidence item${evidence === 1 ? "" : "s"} and ${chunks} RAG chunk${chunks === 1 ? "" : "s"} used`,
    eeatMetricEvidence: "Includes numeric claims such as percentages or improvement rates",
    eeatMetricMissingEvidence: "Numeric claims are missing or unclear",
    eeatStudyEvidence: (sample: boolean, time: boolean) => `Evidence conditions: sample ${sample ? "present" : "missing"}, time period ${time ? "present" : "missing"}`,
    eeatStudyMissingEvidence: "Sample size or usage period evidence is weak",
    eeatRagEvidence: "Uses RAG evidence for the evidence-backed claims principle",
    missingProductSchema: "Add Product schema first when the product entity is missing.",
    missingWebPageSchema: "Add WebPage schema with page purpose and representative description.",
    missingFaq: "Add FAQPage entries as real user questions and answers.",
    missingHowTo: "Add HowTo as separated step-by-step usage instructions.",
    validationImprovement: (count: number) => `Resolve ${count} validation warning${count === 1 ? "" : "s"} before treating the copy as public-ready.`,
    validationGenericDirection: "Fields with validation warnings should pass semantic classification, public-copy rewriting, and schema suitability checks before publication.",
    howToValidationDirection: "Keep HowTo steps limited to real user actions and sequence, not reviews, completed tests, or efficacy proof text.",
    propertyValidationDirection: "Regenerate Product additionalProperty values as short public attributes such as ingredients, benefits, or target users instead of raw source fragments.",
    faqValidationDirection: "Rewrite FAQ entries from OCR or section headings into user-question intent plus evidence-backed answers.",
    descriptionValidationDirection: "Rewrite WebPage/Product descriptions as natural product identity, core benefit, and customer context within the source-evidence boundary.",
    htmlValidationDirection: "Render only public-safe blocks after removing unsafe markup, empty tags, and internal labels before schema validation.",
    claimValidationDirection: "Keep numeric claim value, audience/sample, and usage period or measurement timing together as one evidence unit.",
    factValidationDirection: "Classify OCR ingredient/effect text into ingredient, effect, recommended skin type, and evidence metric before assigning fields.",
    copyValidationDirection: "Run grammar and spacing repairs against language naturalness and sentence completeness, not brand-specific wording rules.",
    cepBridgeImprovement: "Connect each ingredient to its expected benefit and customer choice reason in one sentence.",
    cepChoiceImprovement: "Make customer selection criteria such as skin type, concern, or usage purpose explicit.",
    cepIngredientImprovement: "Strengthen source ingredient or active-ingredient signals.",
    cepBenefitImprovement: "Strengthen result-oriented benefit/effect signals.",
    eeatSampleImprovement: "Keep sample size or study audience next to numeric claims.",
    eeatTimeImprovement: "Keep usage period or measurement timing next to numeric claims.",
    eeatRagImprovement: "Strengthen evidence-backed claims signals so RAG selects the right proof.",
    geoFallbackImprovement: "Keep the current schema shape and regression-check FAQ/HowTo wording as user-question oriented.",
    cepFallbackImprovement: "Keep the current ingredient-benefit-choice bridge and preserve customer-choice wording across reruns.",
    eeatFallbackImprovement: "Keep the current evidence structure and regression-check metric, sample, and time expressions against source.",
    faqHeadingArtifact: (heading: string) => `FAQ exposes source-section heading "${heading}"; rewrite it as a user question.`,
    ocrNoiseArtifact: (value: string) => `Remove OCR noise "${value}" from public output.`,
    internalArtifact: (value: string) => `Prevent internal processing label "${value}" from leaking into public copy.`,
    metricSplitIssue: (value: string) => `Metric "${value}" appears split and should be checked against source evidence.`,
    lowAgreementIssue: (value: string) => `Evidence phrase "${value}" looks like a suspicious single-digit agreement claim; verify the source metric.`
  };
}

function countContentSections(sections: PdpGeoGenerationResult["content"]["sections"]): number {
  return Object.values(sections).filter((value) => value.trim().length > 0).length;
}

function countTextItems(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) {
    return 0;
  }

  const structuredMatches = trimmed.match(/(?:^|\n)\s*(?:Q\.|\d+\.|- |\* )/g);
  return structuredMatches?.length ?? 1;
}

function countSchemaNodes(jsonLd: unknown): number {
  if (isRecord(jsonLd)) {
    const graph = jsonLd["@graph"];
    if (Array.isArray(graph)) {
      return graph.length;
    }
    return 1;
  }

  return 0;
}

function getSchemaGraph(jsonLd: unknown): Record<string, unknown>[] {
  if (!isRecord(jsonLd)) {
    return [];
  }

  const graph = jsonLd["@graph"];
  if (Array.isArray(graph)) {
    return graph.filter(isRecord);
  }

  return [jsonLd];
}

function findSchemaNode(graph: Record<string, unknown>[], type: string): Record<string, unknown> | undefined {
  return graph.find((node) => getSchemaNodeTypes(node).includes(type));
}

function getSchemaNodeTypes(node: Record<string, unknown>): string[] {
  const type = node["@type"];
  if (typeof type === "string") {
    return [type];
  }
  if (Array.isArray(type)) {
    return type.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function getRecordString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function countSchemaItems(value: unknown): number {
  if (Array.isArray(value)) {
    return value.filter(Boolean).length;
  }

  if (isRecord(value)) {
    const itemListElement = value["itemListElement"];
    const mainEntity = value["mainEntity"];
    const step = value["step"];
    if (Array.isArray(itemListElement)) {
      return itemListElement.filter(Boolean).length;
    }
    if (Array.isArray(mainEntity)) {
      return mainEntity.filter(Boolean).length;
    }
    if (Array.isArray(step)) {
      return step.filter(Boolean).length;
    }
    return 1;
  }

  return typeof value === "string" && value.trim().length > 0 ? 1 : 0;
}

function collectTextValues(value: unknown, depth = 0): string[] {
  if (depth > 5) {
    return [];
  }
  if (typeof value === "string") {
    return value.trim().length > 0 ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectTextValues(item, depth + 1));
  }
  if (isRecord(value)) {
    return Object.values(value).flatMap((item) => collectTextValues(item, depth + 1));
  }
  return [];
}

function collectSchemaFaqQuestions(faqNode: Record<string, unknown> | undefined): string[] {
  if (!faqNode) {
    return [];
  }

  const entities = faqNode["mainEntity"];
  if (!Array.isArray(entities)) {
    return [];
  }

  return entities.flatMap((entity) => {
    if (!isRecord(entity)) {
      return [];
    }
    const name = entity["name"];
    return typeof name === "string" && name.trim().length > 0 ? [name.trim()] : [];
  });
}

function collectSectionFaqQuestions(faqText: string): string[] {
  return faqText
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:Q\.|Question:|\d+\.|-|\*)\s*/i, "").trim())
    .filter((line) => line.length > 0 && !/^A\.|^Answer:/i.test(line));
}

function collectPublicArtifactHits(publicText: string, faqQuestions: string[], language: UiLanguage): string[] {
  const copy = getGeoQualityCopy(language);
  const hits: string[] = [];
  const sourceHeadingQuestion = faqQuestions.find((question) => /^(?:key ingredients|ingredients|benefits|how to use|summary)$/i.test(question.trim()));
  const ocrNoise = publicText.match(/\b(?:3Home|SÉRUM|SERUM\s+ACTIVATEUR|ACTIVATEUR)\b/i)?.[0];
  const internalLabel = publicText.match(/\b(?:fallbackDescription|sentence QA|RAG chunk|schema-validator|html-validator)\b/i)?.[0];

  if (sourceHeadingQuestion) {
    hits.push(copy.faqHeadingArtifact(sourceHeadingQuestion));
  }
  if (ocrNoise) {
    hits.push(copy.ocrNoiseArtifact(ocrNoise));
  }
  if (internalLabel) {
    hits.push(copy.internalArtifact(internalLabel));
  }

  return uniqueQualityItems(hits);
}

function collectMetricIntegrityIssues(publicText: string, language: UiLanguage): string[] {
  const copy = getGeoQualityCopy(language);
  const splitMetrics = Array.from(publicText.matchAll(/\+\d+\.\s+\d%/g)).map((match) => match[0]);
  const lowAgreementMetrics = Array.from(publicText.matchAll(/\b[1-9]%\s+agreed\b/gi)).map((match) => match[0]);

  return uniqueQualityItems([
    ...splitMetrics.map((value) => copy.metricSplitIssue(value)),
    ...lowAgreementMetrics.map((value) => copy.lowAgreementIssue(value))
  ]);
}

function hasIngredientBenefitChoiceBridge(text: string): boolean {
  return /(?:ingredient|active|extract|formula|formulated|contains|powered by|with|성분|함유).{0,160}(?:help|support|improv|target|benefit|elastic|firm|wrinkle|hydration|moistur|radiance|texture|효능|개선|도움|선택)/is.test(text);
}

function hasCustomerChoiceCue(text: string): boolean {
  return /(?:skin type|works best for|solution for|ideal for|for customers|for users|concern|wrinkle|elasticity|dry|oily|combination|sensitive|피부|고민|선택|추천|적합)/i.test(text);
}

function hasSelectionCriteriaCue(text: string): boolean {
  return /(?:choose|choice|selection|works best|solution for|skin type|customer|고객|선택|추천|적합)/i.test(text);
}

function uniqueQualityItems(items: Array<string | undefined>): string[] {
  return Array.from(new Set(items.filter((item): item is string => Boolean(item && item.trim().length > 0))));
}

function ensureQualityItems(items: Array<string | undefined>, fallback: string): string[] {
  const uniqueItems = uniqueQualityItems(items);
  return uniqueItems.length > 0 ? uniqueItems : [fallback];
}

function clampQualityScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatCompactNumber(value: number): string {
  if (value < 1000) {
    return value.toString();
  }

  return `${Math.round(value / 100) / 10}k`;
}

function formatPanelSource(source: string): string {
  try {
    const url = new URL(source);
    const path = url.pathname === "/" ? "" : url.pathname;
    const compactPath = path.length > 26 ? `${path.slice(0, 26)}...` : path;
    return `${url.hostname}${compactPath}`;
  } catch {
    return source.length > 34 ? `${source.slice(0, 34)}...` : source;
  }
}

function getGeneratorPanelRagReferences(diagnostics?: PdpGeoDiagnostics): PanelRagReference[] {
  const chunks = diagnostics?.selectedRagChunks ?? [];
  const usageReferences = (diagnostics?.ragUsage ?? []).flatMap((usage, usageIndex) => (
    usage.references.map((reference, referenceIndex) => {
      const matchedChunk = chunks.find((chunk) => chunk.source === reference.source && (chunk.title ?? "") === (reference.title ?? ""));
      const title = reference.title ?? reference.source;
      return {
        id: `generator-rag-usage-${usageIndex}-${referenceIndex}-${reference.source}-${title}`,
        title,
        source: reference.source,
        kind: reference.kind,
        text: matchedChunk?.text ?? reference.excerpt,
        score: reference.score,
        principle: usage.principle,
        usage: reference.usage,
        intents: reference.intents,
        fieldTargets: reference.fieldTargets,
        metadata: {
          principle: usage.principle,
          confidence: Math.round(usage.confidence * 100) / 100,
          enabled: usage.enabled,
          evidence: usage.productEvidenceCount,
          intents: reference.intents.join(", "),
          fieldTargets: reference.fieldTargets.join(", "),
          source: reference.source
        }
      } satisfies PanelRagReference;
    })
  ));

  if (usageReferences.length > 0) {
    return usageReferences;
  }

  return chunks.map((chunk, index) => ({
    id: `generator-rag-${chunk.id}-${index}`,
    title: chunk.title ?? chunk.source ?? chunk.id,
    source: chunk.source,
    kind: chunk.kind,
    text: chunk.text,
    score: chunk.score,
    metadata: chunk.metadata
  }));
}

function getMagazinePanelRagReferences(diagnostics?: GeoCitationDiagnostics): PanelRagReference[] {
  const chunks = diagnostics?.selectedRagChunks ?? [];
  const usageReferences = (diagnostics?.ragUsage ?? []).map((usage, index) => {
    const matchedChunk = chunks.find((chunk) => chunk.sourceType === usage.sourceType && chunk.text.includes(usage.excerpt.slice(0, 40)));
    return {
      id: `magazine-rag-usage-${index}-${usage.source}-${usage.sourceType}`,
      title: `${usage.sourceType} · ${usage.source}`,
      source: usage.source,
      kind: usage.sourceType,
      text: matchedChunk?.text ?? usage.excerpt,
      score: usage.score,
      usage: usage.usage,
      metadata: {
        sourceType: usage.sourceType,
        score: Math.round(usage.score * 100) / 100,
        source: usage.source
      }
    } satisfies PanelRagReference;
  });

  if (usageReferences.length > 0) {
    return usageReferences;
  }

  return chunks.map((chunk, index) => ({
    id: `magazine-rag-${chunk.id}-${index}`,
    title: chunk.title ?? `${chunk.sourceType} evidence`,
    source: chunk.url ?? chunk.sourceType,
    kind: chunk.sourceType,
    text: chunk.text,
    score: chunk.score,
    metadata: {
      reason: chunk.reason,
      sourceType: chunk.sourceType
    }
  }));
}

function getExtractorPanelRagReferences(result?: ProductExtractionResult): PanelRagReference[] {
  return (result?.geoProduct.rag.chunks ?? []).map((chunk, index) => ({
    id: `extractor-rag-${chunk.id}-${index}`,
    title: `${chunk.kind} · ${chunk.id}`,
    source: result?.ragProfile ?? "pdp-extractor",
    kind: chunk.kind,
    text: chunk.text,
    metadata: {
      source: result?.source ?? "",
      ragProfile: result?.ragProfile ?? ""
    }
  }));
}

function formatRagReferenceMeta(reference: PanelRagReference): string {
  return [
    reference.principle,
    reference.kind,
    reference.source,
    reference.fieldTargets?.length ? `targets ${reference.fieldTargets.slice(0, 3).join(", ")}` : undefined,
    typeof reference.score === "number" ? `score ${reference.score.toFixed(2)}` : undefined
  ].filter(Boolean).join(" · ");
}

function formatRagReferenceListMeta(reference: PanelRagReference): string {
  return [
    reference.principle,
    reference.kind,
    typeof reference.score === "number" ? `score ${reference.score.toFixed(2)}` : undefined
  ].filter(Boolean).join(" · ") || reference.source;
}

function formatOcrSentenceSource(item: PdpGeoOcrSentenceDiagnostic, uiLanguage: UiLanguage): string {
  const imageCount = item.imageUrls?.length ?? 0;
  const firstImage = item.imageUrls?.[0];
  if (!firstImage) {
    return uiLanguage === "ko" ? "OCR 이미지 출처 없음" : "OCR source unknown";
  }
  const source = formatPanelSource(firstImage);
  if (imageCount > 1) {
    return uiLanguage === "ko" ? `OCR 이미지 ${imageCount}개 · ${source}` : `${imageCount} OCR images · ${source}`;
  }
  return uiLanguage === "ko" ? `OCR 이미지 · ${source}` : `OCR image · ${source}`;
}

function formatRagUsageTitle(usage: PdpGeoDiagnostics["ragUsage"][number]): string {
  return `${usage.principle} · ${usage.enabled ? "enabled" : "disabled"} · confidence ${usage.confidence.toFixed(2)}`;
}

function formatRagUsageBody(usage: PdpGeoDiagnostics["ragUsage"][number], uiLanguage: UiLanguage): string {
  const references = usage.references
    .slice(0, 3)
    .map((reference) => {
      const title = reference.title ?? reference.source;
      const targets = reference.fieldTargets.length > 0 ? ` (${reference.fieldTargets.slice(0, 3).join(", ")})` : "";
      return `${reference.usage} · ${reference.kind}/${title}${targets}`;
    })
    .join(" | ");
  const evidenceLabel = uiLanguage === "ko" ? "상품 근거" : "product evidence";
  const noReferences = uiLanguage === "ko" ? "매칭된 RAG 원문 없음" : "no matched RAG reference";
  return `${evidenceLabel} ${usage.productEvidenceCount} · ${references || noReferences} · ${usage.rationale}`;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function createArtifactCopyTarget(
  surface: ArtifactCopySurface,
  resultId: string | undefined,
  view: OutputView | ExtractorOutputView | MagazineOutputView
): string {
  return `${surface}:${resultId ?? "none"}:${view}`;
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.left = "-1000px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}
