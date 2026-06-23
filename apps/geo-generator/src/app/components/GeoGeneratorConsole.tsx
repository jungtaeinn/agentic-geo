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
import type { ProductExtractionDiagnostics, ProductExtractionResult } from "@agentic-geo/pdp-extractor-agent/types";
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
type SettingsTab = "run" | "ai" | "rag";
type UiLanguage = "ko" | "en";
type ProviderId = "mock" | "openai" | "gemini" | "azure-openai";
type ConnectionStatus = "idle" | "checking" | "connected" | "error";
type ModelLoadStatus = "idle" | "loading" | "ready" | "error";
type RagProfileTarget = "extractor" | "generator";
type WorkspaceMode = "extractor" | "generator";
type ExtractorOutputView = "result" | "logs";
type ModalCopyTarget = "panel-detail" | "rag-reference";

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

interface GeoGeneratorResult {
  id: string;
  source: string;
  sourceType: "url" | "restApi" | "manual-json";
  extractor?: ProductExtractionResult;
  generator: PdpGeoGenerationResult;
}

interface GeoGeneratorLog {
  source: string;
  extractor?: ProductExtractionDiagnostics;
  generator: PdpGeoDiagnostics;
  generatorProcess: PdpGeoGenerationStep[];
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

interface ProductExtractorResponse {
  results: ProductExtractionResult[];
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
  results?: GeoGeneratorResult[];
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
    provider?: "local" | "azure-openai";
    apiKey?: string;
    endpoint?: string;
    deployment?: string;
    apiVersion?: string;
    model?: string;
  };
  reranker?: {
    provider?: "local-hybrid" | "cohere" | "azure-ai-search-semantic";
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
  id: string | PdpGeoGenerationStageId;
  title: string;
  description: string;
  status: "pending" | "running" | "done" | "error";
  message?: string;
};

interface GeoPipelineProcessState {
  status: RunStatus;
  currentGroup: "extractor" | "generator";
  currentStepId: string | PdpGeoGenerationStageId;
  sourceCount: number;
  completedSourceCount: number;
  activeSource?: string;
  skipExtractor?: boolean;
  errorMessage?: string;
}

const ragModeLabels: Record<PdpGeoRagMode, string> = {
  "local-versioned-rag": "Local RAG",
  "managed-vector-store-rag": "Vector Store"
};

const SETTINGS_STORAGE_KEY = "agentic-geo.geo-generator.provider-settings.v1";
const RUN_SETTINGS_STORAGE_KEY = "agentic-geo.geo-generator.run-settings.v1";
const RAG_SETTINGS_STORAGE_KEY = "agentic-geo.geo-generator.rag-profile-settings.v1";
const HISTORY_STORAGE_KEY = "agentic-geo.geo-generator.history.v1";
const EXTRACTOR_HISTORY_STORAGE_KEY = "agentic-geo.geo-generator.extractor-history.v1";
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
  azureAiSearchSemanticConfiguration: "default"
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
        label: "Generator",
        description: "GEO schema/content 생성",
        newChat: "새 생성",
        history: "Generator 히스토리",
        emptyHistory: "아직 생성 히스토리가 없습니다",
        searchPlaceholder: "생성 히스토리 검색"
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
      warning: "실행 경고"
    },
    panel: {
      progress: "진행 상황",
      nextResult: "다음 결과",
      extractor: "Extractor",
      generator: "Generator",
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
      run: "Run",
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
      saveRun: "Run 설정 저장",
      saveRag: "RAG 프로필 저장",
      attachRag: "GEO/RAG 파일 첨부",
      edit: "편집",
      emptyRag: "첨부된 파일이 없습니다",
      emptyRagHelp: "Schema BestPractice, E-E-A-T, CEP, locale 용어집 같은 md/txt/json/csv 파일을 첨부할 수 있습니다.",
      reset: "초기화",
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
        label: "Generator",
        description: "Generate GEO schema/content",
        newChat: "New generation",
        history: "Generator history",
        emptyHistory: "No generation history yet",
        searchPlaceholder: "Search generation history"
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
      warning: "Run warning"
    },
    panel: {
      progress: "Progress",
      nextResult: "Next result",
      extractor: "Extractor",
      generator: "Generator",
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
      run: "Run",
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
      saveRun: "Save run settings",
      saveRag: "Save RAG profile",
      attachRag: "Attach GEO/RAG file",
      edit: "Edit",
      emptyRag: "No files attached",
      emptyRagHelp: "Attach md/txt/json/csv files such as Schema BestPractice, E-E-A-T, CEP, or locale terminology guides.",
      reset: "Reset",
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

const extractorStepIds = extractorStepCopy.ko.map(([id]) => id);
const generatorStepIds = Object.keys(generatorStepCopy.ko) as PdpGeoGenerationStageId[];

export function GeoGeneratorConsole() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ragFileInputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [uiLanguage, setUiLanguage] = useState<UiLanguage>("ko");
  const [activeMode, setActiveMode] = useState<WorkspaceMode>("generator");
  const [sourceMode, setSourceMode] = useState<SourceMode>("auto");
  const [locale, setLocale] = useState<PdpGeoLocale>("ko-KR");
  const [ragMode, setRagMode] = useState<PdpGeoRagMode>("local-versioned-rag");
  const [headersJson, setHeadersJson] = useState("{}");
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
  const [extractorResults, setExtractorResults] = useState<ProductExtractionResult[]>([]);
  const [extractorLogs, setExtractorLogs] = useState<ProductExtractionDiagnostics[]>([]);
  const [selectedExtractorIndex, setSelectedExtractorIndex] = useState(0);
  const [isHistoryReady, setIsHistoryReady] = useState(false);
  const [runStatus, setRunStatus] = useState<RunStatus>("idle");
  const [extractorRunStatus, setExtractorRunStatus] = useState<RunStatus>("idle");
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
  const [selectedRagReference, setSelectedRagReference] = useState<PanelRagReference | null>(null);
  const [selectedPanelDetail, setSelectedPanelDetail] = useState<PanelDetail | null>(null);
  const [copiedModalTarget, setCopiedModalTarget] = useState<ModalCopyTarget | null>(null);
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
  const activeGeneratorPipelineProcess = runStatus === "running" || (runStatus === "error" && !selectedResult) ? pipelineProcess : undefined;
  const activeExtractorPipelineProcess = extractorRunStatus === "running" || (extractorRunStatus === "error" && !selectedExtractorResult) ? extractorPipelineProcess : undefined;
  const activePipelineProcess = activeMode === "extractor" ? activeExtractorPipelineProcess : activeGeneratorPipelineProcess;
  const processProgressLabel = activePipelineProcess ? formatGeoProcessProgress(activePipelineProcess, uiLanguage) : "";
  const panelSources = activeMode === "extractor"
    ? selectedExtractorResult
      ? [selectedExtractorResult.source]
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
  const hasStarted = activeMode === "extractor" ? extractorHasStarted : generatorHasStarted;
  const activeMessages = activeMode === "extractor" ? extractorMessages : messages;
  const activeRunStatus = activeMode === "extractor" ? extractorRunStatus : runStatus;
  const activeModeCopy = text.modes[activeMode];
  const schemaText = selectedResult ? JSON.stringify(selectedResult.generator.schemaMarkup.jsonLd, null, 2) : "";
  const diagnosticsText = selectedResult ? JSON.stringify({
    extractor: selectedLog?.extractor,
    generator: selectedResult.generator.diagnostics
  }, null, 2) : "";
  const extractorJsonText = selectedExtractorResult ? JSON.stringify(selectedExtractorResult, null, 2) : "";
  const extractorDiagnosticsText = selectedExtractorLog ? JSON.stringify(selectedExtractorLog, null, 2) : "";
  const canSubmitComposer = activeMode === "extractor"
    ? draft.trim().length > 0 || composerAttachments.some((attachment) => attachment.sourceCount > 0)
    : draft.trim().length > 0 || composerAttachments.some((attachment) => attachment.productCount > 0 || attachment.sourceCount > 0);
  const activeProviderLabel = providerLabel(providerSettings.provider, uiLanguage);
  const activeModelOptions = modelOptions[providerSettings.provider] ?? [];
  const selectedRagProfile = ragProfiles[selectedRagTarget];
  const selectedRagFile = selectedRagProfile.files.find((file) => file.id === selectedRagFileId) ?? selectedRagProfile.files[0];
  const panelRagReferences = activeMode === "extractor"
    ? getExtractorPanelRagReferences(selectedExtractorResult)
    : getGeneratorPanelRagReferences(selectedDiagnostics);
  const extractorPanelSteps = activeGeneratorPipelineProcess
    ? undefined
    : selectedLog?.extractor?.process ?? (selectedResult?.extractor ? markProcessStepsDone(getExtractorSteps(uiLanguage)) : undefined);
  const generatorPanelSteps = activeGeneratorPipelineProcess
    ? undefined
    : selectedLog?.generatorProcess ?? (selectedResult ? markProcessStepsDone(getGeneratorSteps(uiLanguage)) : undefined);
  const extractorOnlyPanelSteps = activeExtractorPipelineProcess
    ? undefined
    : selectedExtractorLog?.process ?? (selectedExtractorResult ? markProcessStepsDone(getExtractorSteps(uiLanguage)) : undefined);
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
  const shellClassName = [
    "codexShell",
    isSidebarCollapsed ? "sidebarCollapsed" : "",
    isStatusPanelOpen ? "" : "statusPanelClosed",
    isArtifactGrid ? "artifactGridMode" : "",
    hasStarted ? "" : "chatWelcome"
  ].filter(Boolean).join(" ");

  const runSummary = useMemo(() => {
    const status = activeMode === "extractor" ? extractorRunStatus : runStatus;
    const count = activeMode === "extractor" ? extractorResults.length : results.length;

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
  }, [activeMode, extractorResults.length, extractorRunStatus, results.length, runStatus, text]);

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
    setSelectedRagFileId(storedRagProfiles.generator.files[0]?.id ?? storedRagProfiles.extractor.files[0]?.id ?? null);
    setConnectionStatus(isAuthorizedAiSettings(storedProviderSettings) ? "connected" : "idle");
    setConnectionMessage(isAuthorizedAiSettings(storedProviderSettings)
      ? `${providerLabel(storedProviderSettings.provider, "ko")} 연결 테스트가 완료된 설정을 불러왔습니다.`
      : "OpenAI, Gemini, Azure API 중 하나를 연결하면 Extractor와 Generator 실행에 함께 사용됩니다.");
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
    setSelectedRagReference(null);
  }, [activeMode, selectedExtractorIndex, selectedIndex]);

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
    let progressController: { cancelled: boolean } | undefined;

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
      progressController = { cancelled: false };
      const progress = playGeoPipelineProgress(input, setPipelineProcess, progressController);
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
      const payload = await response.json() as GeoGeneratorResponse;
      await progress;

      if (!response.ok && !payload.results?.length) {
        throw new Error(payload.error ?? `GEO generation failed: ${response.status}`);
      }

      const nextResults = mergeGeoHistoryResults(payload.results ?? [], results);
      const nextLogs = mergeGeoHistoryLogs(payload.logs ?? [], logs);
      setResults(nextResults);
      setLogs(nextLogs);
      setSelectedIndex(payload.results?.length ? 0 : -1);
      setRunStatus(payload.failures?.length ? "error" : "done");
      setPipelineProcess({
        status: payload.failures?.length ? "error" : "done",
        currentGroup: "generator",
        currentStepId: "artifact",
        sourceCount,
        completedSourceCount: (payload.results?.length ?? 0) + (payload.failures?.length ?? 0),
        activeSource: payload.results?.[0]?.source ?? payload.failures?.[0]?.source ?? firstSource,
        skipExtractor: input.sources.length === 0,
        errorMessage: payload.failures?.[0]?.error
      });
      setErrorMessage(payload.failures?.map((failure) => `${failure.source}: ${failure.error}`).join("\n") ?? "");
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: payload.failures?.length ? "agent" : "agent",
          body: payload.failures?.length
            ? text.messages.partial(payload.results.length, payload.failures.length)
            : text.messages.done(payload.results.length)
        }
      ]);
    } catch (error) {
      if (progressController) {
        progressController.cancelled = true;
      }
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
          body: message
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

      const nextResults = mergeExtractorHistoryResults(payload.results ?? [], extractorResults);
      const nextLogs = mergeExtractorHistoryLogs(payload.logs ?? [], extractorLogs);
      setExtractorResults(nextResults);
      setExtractorLogs(nextLogs);
      setSelectedExtractorIndex(payload.results?.length ? 0 : -1);
      setExtractorRunStatus(payload.failures?.length ? "error" : "done");
      setExtractorPipelineProcess({
        status: payload.failures?.length ? "error" : "done",
        currentGroup: "extractor",
        currentStepId: "json",
        sourceCount,
        completedSourceCount: (payload.results?.length ?? 0) + (payload.failures?.length ?? 0),
        activeSource: payload.results?.[0]?.source ?? payload.failures?.[0]?.source ?? firstSource,
        errorMessage: payload.failures?.[0]?.error
      });
      setErrorMessage(payload.failures?.map((failure) => `${failure.source}: ${failure.error}`).join("\n") ?? "");
      setExtractorMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "agent",
          body: payload.failures?.length
            ? text.messages.extractorPartial(payload.results.length, payload.failures.length)
            : text.messages.extractorDone(payload.results.length)
        }
      ]);
    } catch (error) {
      if (progressController) {
        progressController.cancelled = true;
      }
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
          body: message
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

    if (validationMessage) {
      setConnectionStatus("error");
      setConnectionMessage(validationMessage);
      return;
    }

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
    } catch (error) {
      setConnectionStatus("error");
      setConnectionMessage(error instanceof Error ? error.message : providerFailedMessage(activeProviderLabel, uiLanguage));
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
    window.localStorage.removeItem(SETTINGS_STORAGE_KEY);
    setProviderSettings(defaultProviderSettings);
    setConnectionStatus("idle");
    setModelOptions({});
    setModelLoadStatus("idle");
    setModelMessage(modelIdleMessage(uiLanguage));
    setConnectionMessage(providerResetMessage(uiLanguage));
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
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Headers JSON is invalid.");
    }
  }

  function resetRunSettings() {
    window.localStorage.removeItem(RUN_SETTINGS_STORAGE_KEY);
    setSourceMode("auto");
    setLocale("ko-KR");
    setHeadersJson("{}");
  }

  function selectRagTarget(target: RagProfileTarget) {
    setSelectedRagTarget(target);
    setSelectedRagFileId(ragProfiles[target].files[0]?.id ?? null);
  }

  function updateRagAnalysisPrompt(value: string) {
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
    try {
      const profiles = await writeRagProfile(selectedRagTarget, ragProfiles[selectedRagTarget]);
      const mergedProfiles = mergeRagProfileUiState(profiles, ragProfiles);
      setRagProfiles(mergedProfiles);
      setSelectedRagFileId(mergedProfiles[selectedRagTarget].files.find((file) => file.id === selectedRagFileId)?.id ?? mergedProfiles[selectedRagTarget].files[0]?.id ?? null);
      window.localStorage.setItem(RAG_SETTINGS_STORAGE_KEY, JSON.stringify(mergedProfiles));
      setRagMessage(ragSavedMessage(selectedRagTarget, uiLanguage));
    } catch (error) {
      setRagMessage(error instanceof Error ? error.message : ragSaveFailedMessage(uiLanguage));
    }
  }

  async function resetRagProfileSettings() {
    try {
      const profiles = await resetPackageRagProfile(selectedRagTarget);
      setRagProfiles(profiles);
      setSelectedRagFileId(profiles[selectedRagTarget].files[0]?.id ?? null);
      window.localStorage.setItem(RAG_SETTINGS_STORAGE_KEY, JSON.stringify(profiles));
      setRagMessage(ragResetMessage(selectedRagTarget, uiLanguage));
    } catch (error) {
      setRagMessage(error instanceof Error ? error.message : ragResetFailedMessage(uiLanguage));
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
          {(["extractor", "generator"] as WorkspaceMode[]).map((mode) => (
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
                    <span>{activeMode === "extractor" ? text.messages.extractorRunningTitle : text.messages.runningTitle}</span>
                  </div>
                  <p>{activeMode === "extractor" ? text.messages.extractorRunningBody : text.messages.runningBody}</p>
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
                <section className="floatingArtifact" aria-label="Selected output">
                  <div className="artifactTop">
                    <div>
                      <span>{selectedResult.generator.locale} · {selectedResult.generator.diagnostics.ragMode}</span>
                      <strong>{selectedResult.generator.content.sections.productName}</strong>
                    </div>
                    <div className="windowActions">
                      {(["schema", "content", "diagnostics"] as OutputView[]).map((view) => (
                        <button className={outputView === view ? "active" : ""} type="button" key={view} onClick={() => setOutputView(view)}>
                          <span>{view}</span>
                        </button>
                      ))}
                      <button type="button" onClick={() => copyText(outputView === "schema" ? schemaText : outputView === "content" ? selectedResult.generator.content.html : diagnosticsText)} aria-label={text.artifact.copyAria}>
                        <Copy size={14} />
                      </button>
                    </div>
                  </div>
                  <pre>{outputView === "schema" ? schemaText : outputView === "content" ? selectedResult.generator.content.html : diagnosticsText}</pre>
                </section>
              )}
              {activeMode === "extractor" && selectedExtractorResult && (
                <section className="floatingArtifact" aria-label="Selected extraction output">
                  <div className="artifactTop">
                    <div>
                      <span>{selectedExtractorResult.sourceType} · {selectedExtractorResult.ragProfile}</span>
                      <strong>{selectedExtractorResult.geoProduct.name}</strong>
                    </div>
                    <div className="windowActions">
                      {(["result", "logs"] as ExtractorOutputView[]).map((view) => (
                        <button className={extractorOutputView === view ? "active" : ""} type="button" key={view} onClick={() => setExtractorOutputView(view)}>
                          <span>{view}</span>
                        </button>
                      ))}
                      <button type="button" onClick={() => copyText(extractorOutputView === "result" ? extractorJsonText : extractorDiagnosticsText)} aria-label={text.artifact.copyAria}>
                        <Copy size={14} />
                      </button>
                    </div>
                  </div>
                  <pre>{extractorOutputView === "result" ? extractorJsonText : extractorDiagnosticsText}</pre>
                </section>
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
                  disabled={activeMode === "extractor" ? extractorResults.length <= 1 : results.length <= 1}
                  onClick={() => {
                    if (activeMode === "extractor") {
                      setSelectedExtractorIndex((current) => (current + 1) % extractorResults.length);
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
                          className="copyPanelButton"
                          type="button"
                          onClick={() => copyText(extractorOutputView === "result" ? extractorJsonText : extractorDiagnosticsText)}
                        >
                          <Copy size={13} />
                          {text.artifact.copy}
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
                      className="copyPanelButton"
                      type="button"
                      onClick={() => copyText(outputView === "schema" ? schemaText : outputView === "content" ? selectedResult.generator.content.html : diagnosticsText)}
                    >
                      <Copy size={13} />
                      {text.artifact.copy}
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
                        <span>
                          <strong>{reference.title}</strong>
                          {reference.usage && <em className="ragReferenceUsage">{reference.usage}</em>}
                          <em>{formatRagReferenceMeta(reference)}</em>
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
              aria-label={activeMode === "extractor" ? "PDP extractor input" : "PDP GEO input"}
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
                    <button type="button" onClick={resetRunSettings}>
                      {text.settings.reset}
                    </button>
                    <button className="primary" type="button" onClick={saveRunSettings}>
                      {text.settings.saveRun}
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
                      {(["mock", "openai", "gemini", "azure-openai"] as ProviderId[]).map((provider) => (
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
                  </section>

                  <section className="settingsSection">
                    <h3>{text.settings.aiScopeSection}</h3>
                    <div className="settingsCard">
                      <strong>pdp-extractor-agent + pdp-geo-generator-agent</strong>
                      <p>{aiScopeMessage(uiLanguage)}</p>
                    </div>
                  </section>

                  <div className="settingsActions">
                    <button type="button" onClick={resetProviderSettings}>
                      {text.settings.reset}
                    </button>
                    <button
                      type="button"
                      disabled={connectionStatus === "checking" || !isProviderSettingsReady}
                      onClick={() => {
                        void testProviderConnection();
                      }}
                    >
                      {connectionStatus === "checking" ? text.settings.testingConnection : text.settings.testConnection}
                    </button>
                    <button
                      className="primary"
                      type="button"
                      disabled={connectionStatus === "checking" || !isProviderSettingsReady}
                      onClick={() => {
                        void saveProviderSettings();
                      }}
                    >
                      {connectionStatus === "checking" ? text.settings.checking : text.settings.saveAndApply}
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
                        type="button"
                        onClick={() => {
                          void resetRagProfileSettings();
                        }}
                      >
                        {text.settings.reset}
                      </button>
                      <button
                        className="primary"
                        type="button"
                        onClick={() => {
                          void saveRagProfileSettings();
                        }}
                      >
                        {text.settings.saveRag}
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

  if (view === "content") {
    return (
      <div className="outputSummary">
        <strong>{productName}</strong>
        <div className="outputMetricGrid">
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

function ExtractorOutputSummary({
  onOpenDetail,
  result,
  text,
  uiLanguage
}: Readonly<{
  onOpenDetail: (detail: PanelDetail) => void;
  result: ProductExtractionResult;
  text: (typeof uiCopy)[UiLanguage];
  uiLanguage: UiLanguage;
}>) {
  const product = result.geoProduct;

  return (
    <div className="outputSummary">
      <strong>{product.name}</strong>
      <div className="outputMetricGrid">
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
  group: "extractor" | "generator";
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

type ProviderSettingUpdater = <Key extends keyof ProviderSettings>(key: Key, value: ProviderSettings[Key]) => void;

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
  return language === "ko" ? "Azure 배포" : "Azure deployment";
}

function workspaceTitle(mode: WorkspaceMode, language: UiLanguage): string {
  if (mode === "extractor") {
    return language === "ko" ? "agentic-geo PDP Extractor" : "agentic-geo PDP Extractor";
  }
  return language === "ko" ? "agentic-geo PDP GEO 생성" : "agentic-geo PDP GEO Generator";
}

function workspaceWelcomeTitle(mode: WorkspaceMode, language: UiLanguage): string {
  if (mode === "extractor") {
    return language === "ko" ? "추출할 PDP 또는 REST API를 입력하세요" : "Enter a PDP or REST API to extract product data";
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
    ? "OpenAI, Gemini, Azure API 중 하나를 연결하면 Extractor와 Generator 실행에 함께 사용됩니다."
    : "Connect OpenAI, Gemini, or Azure API settings to use it across Extractor and Generator runs.";
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
    ? "저장한 AI 연동 설정은 URL/REST API 입력의 상품정보 추출 단계와 GEO schema/content 생성 단계에 함께 전달됩니다. 키는 서버에 영구 저장하지 않고 이 브라우저의 로컬 저장소에만 보관합니다."
    : "Saved AI settings are passed to both product extraction for URL/REST inputs and GEO schema/content generation. Keys stay in this browser's local storage and are not permanently stored on the server.";
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

async function playGeoPipelineProgress(
  input: NormalizedComposerInput,
  setPipelineProcess: (update: (current: GeoPipelineProcessState) => GeoPipelineProcessState) => void,
  controller: { cancelled: boolean }
) {
  const sourceCount = Math.max(input.products.length + input.sources.length, 1);
  const activeSource = input.sources[0] ?? (input.products.length > 0 ? "manual-json" : undefined);
  const skipExtractor = input.sources.length === 0;

  if (!skipExtractor) {
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
        skipExtractor
      }));
      await waitForPipelineStep();
    }
  }

  for (const stepId of generatorStepIds) {
    if (controller.cancelled) {
      return;
    }
    setPipelineProcess((current) => ({
      ...current,
      status: "running",
      currentGroup: "generator",
      currentStepId: stepId,
      sourceCount,
      completedSourceCount: skipExtractor ? current.completedSourceCount : Math.max(current.completedSourceCount, input.sources.length),
      activeSource,
      skipExtractor
    }));
    await waitForPipelineStep();
  }
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

  return undefined;
}

function getProviderCredentialValidationMessage(settings: ProviderSettings, language: UiLanguage): string | undefined {
  if (settings.provider === "mock") {
    return language === "ko"
      ? "실제 AI 연동을 위해 OpenAI, Gemini, Azure API 중 하나를 선택해주세요."
      : "Choose OpenAI, Gemini, or Azure API settings for a real AI connection.";
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
    const rawSettings = window.localStorage.getItem(SETTINGS_STORAGE_KEY);

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

function readStoredExtractorHistory(): { results: ProductExtractionResult[]; logs: ProductExtractionDiagnostics[] } {
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
    generator: result.generator
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

function normalizeStoredExtractorResult(value: unknown): ProductExtractionResult | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const result = value as Partial<ProductExtractionResult>;

  if (typeof result.source !== "string" || !isExtractorSourceType(result.sourceType) || !result.geoProduct) {
    return undefined;
  }

  return {
    source: result.source,
    sourceType: result.sourceType,
    geoProduct: result.geoProduct,
    generatedAt: typeof result.generatedAt === "string" ? result.generatedAt : new Date().toISOString(),
    ragProfile: typeof result.ragProfile === "string" ? result.ragProfile : "pdp-extractor-default"
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

function geoHistoryResultKey(result: Pick<GeoGeneratorResult, "source" | "sourceType">): string {
  return `${result.sourceType}:${result.source}`;
}

function mergeExtractorHistoryResults(incoming: ProductExtractionResult[], current: ProductExtractionResult[]): ProductExtractionResult[] {
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

function markProcessStepsDone<Step extends ProcessStep>(steps: Step[]): Step[] {
  return steps.map((step) => ({
    ...step,
    status: "done"
  }));
}

function localizeProcessStep(step: ProcessStep, group: "extractor" | "generator", language: UiLanguage): Pick<ProcessStep, "title" | "description"> {
  if (group === "generator" && isGeneratorStageId(step.id)) {
    const [title, description] = generatorStepCopy[language][step.id];
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
  stepId: string | PdpGeoGenerationStageId,
  group: "extractor" | "generator",
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

  const order = group === "extractor" ? extractorStepIds : generatorStepIds;
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

async function copyText(value: string) {
  await navigator.clipboard?.writeText(value);
}
