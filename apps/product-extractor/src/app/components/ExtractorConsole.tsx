"use client";

import Image from "next/image";
import { runMockProductExtraction } from "@agentic-geo/product-extractor-agent/mock";
import { refineGeoProductResult } from "@agentic-geo/product-extractor-agent";
import type { ProductExtractionDiagnostics, ProductExtractionResult } from "@agentic-geo/product-extractor-agent/types";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleStop,
  Copy,
  Database,
  FileCode2,
  FileText,
  Globe2,
  KeyRound,
  LayoutGrid,
  Loader2,
  MessageSquarePlus,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  PlugZap,
  Plus,
  Search,
  Send,
  Settings,
  Trash2,
  X
} from "lucide-react";
import type { ChangeEvent, DragEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

type QueueStatus = "idle" | "running" | "done" | "error";
type AgentProcessStatus = "idle" | "running" | "done" | "error";
type AgentStepStatus = "pending" | "running" | "done" | "error";
type AgentStepId = "input" | "fetch" | "extract" | "ocr" | "review" | "rag" | "json";
type ProviderId = "mock" | "openai" | "gemini" | "azure-openai";
type ConnectionStatus = "idle" | "checking" | "connected" | "error";
type SettingsPane = "provider" | "rest" | "rag";
type SourceMode = "auto" | "url" | "restApi";
type ModelLoadStatus = "idle" | "loading" | "ready" | "error";
type OutputPanelView = "result" | "logs";

type DisplayExtractionResult = ProductExtractionResult & {
  diagnostics?: ProductExtractionDiagnostics;
};

interface DisplayExtractionFailure {
  source: string;
  sourceType: "url" | "restApi";
  error: string;
  diagnostics?: ProductExtractionDiagnostics;
}

interface ExtractionRequestResult {
  results: DisplayExtractionResult[];
  failures: DisplayExtractionFailure[];
}

interface QueueItem {
  id: string;
  source: string;
  status: QueueStatus;
  createdAt: string;
  updatedAt: string;
  result?: DisplayExtractionResult;
  diagnostics?: ProductExtractionDiagnostics;
  error?: string;
}

interface ChatMessage {
  id: string;
  role: "agent" | "user" | "tool";
  body: string;
  command?: string;
  results?: DisplayExtractionResult[];
}

interface AgentStep {
  id: AgentStepId;
  title: string;
  description: string;
}

interface AgentProcessState {
  status: AgentProcessStatus;
  currentStepId: AgentStepId;
  sourceCount: number;
  completedSourceCount?: number;
  activeSource?: string;
  errorMessage?: string;
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
  azureApiVersion: string;
}

interface RuntimeLlmConfig {
  provider: ProviderId;
  apiKey?: string;
  model?: string;
  endpoint?: string;
  deployment?: string;
  apiVersion?: string;
}

interface RestApiSettings {
  sourceMode: SourceMode;
  headersJson: string;
}

interface RagAttachment {
  id: string;
  name: string;
  version: string;
  size: number;
  type: string;
  content: string;
  managed?: boolean;
  path?: string;
  addedAt: string;
}

interface ComposerAttachment {
  id: string;
  name: string;
  size: number;
  sources: string[];
  invalidTokens: string[];
}

interface RagProfileSettings {
  analysisPrompt: string;
  files: RagAttachment[];
}

interface RuntimeRagConfig {
  analysisPrompt?: string;
  documents?: Array<{
    name: string;
    content: string;
  }>;
}

const SETTINGS_STORAGE_KEY = "agentic-geo.provider-settings.v1";
const REST_SETTINGS_STORAGE_KEY = "agentic-geo.rest-api-settings.v1";
const RAG_SETTINGS_STORAGE_KEY = "agentic-geo.rag-profile-settings.v1";
const HISTORY_STORAGE_KEY = "agentic-geo.extraction-history.v1";
const HISTORY_LIMIT = 50;

const defaultProviderSettings: ProviderSettings = {
  provider: "mock",
  openaiApiKey: "",
  openaiModel: "",
  geminiApiKey: "",
  geminiModel: "",
  azureApiKey: "",
  azureEndpoint: "",
  azureDeployment: "",
  azureApiVersion: "2024-10-21"
};

const providerLabels: Record<ProviderId, string> = {
  mock: "Mock 테스트",
  openai: "OpenAI",
  gemini: "Gemini",
  "azure-openai": "Azure OpenAI"
};

const defaultRestApiSettings: RestApiSettings = {
  sourceMode: "auto",
  headersJson: "{}"
};

const defaultRagProfileSettings: RagProfileSettings = {
  analysisPrompt: "",
  files: []
};

const agentSteps: AgentStep[] = [
  {
    id: "input",
    title: "입력 정규화",
    description: "URL/REST API 주소를 검증하고 실행 단위로 분리"
  },
  {
    id: "fetch",
    title: "소스 수집",
    description: "페이지 HTML, 메타정보, JSON-LD, API 응답 수집"
  },
  {
    id: "extract",
    title: "상품정보 추출",
    description: "상품명, 가격, 설명, 옵션, FAQ 후보 정규화"
  },
  {
    id: "ocr",
    title: "OCR 키워드 분류",
    description: "이미지/상세 영역의 효능, 효과, 성분 키워드 분류"
  },
  {
    id: "review",
    title: "리뷰 신호 추출",
    description: "평점, 리뷰본문, 대표 키워드, 고객 표현 정리"
  },
  {
    id: "rag",
    title: "RAG chunk 생성",
    description: "상품/리뷰/FAQ/OCR evidence를 RAG 데이터로 구성"
  },
  {
    id: "json",
    title: "JSON 결과 생성",
    description: "복사 가능한 최종 JSON 아티팩트 생성"
  }
];

export function ExtractorConsole() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ragFileInputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isHistoryReady, setIsHistoryReady] = useState(false);
  const [, setHistoryTimeTick] = useState(0);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [hasStarted, setHasStarted] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isRefining, setIsRefining] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);
  const [composerStatus, setComposerStatus] = useState("");
  const [composerAttachments, setComposerAttachments] = useState<ComposerAttachment[]>([]);
  const [isArtifactGrid, setIsArtifactGrid] = useState(false);
  const [isStatusPanelOpen, setIsStatusPanelOpen] = useState(true);
  const [outputPanelView, setOutputPanelView] = useState<OutputPanelView>("result");
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [activeSettingsPane, setActiveSettingsPane] = useState<SettingsPane>("provider");
  const [providerSettings, setProviderSettings] = useState<ProviderSettings>(defaultProviderSettings);
  const [restApiSettings, setRestApiSettings] = useState<RestApiSettings>(defaultRestApiSettings);
  const [ragProfileSettings, setRagProfileSettings] = useState<RagProfileSettings>(defaultRagProfileSettings);
  const [isProviderSettingsReady, setIsProviderSettingsReady] = useState(false);
  const [selectedRagFileId, setSelectedRagFileId] = useState<string | null>(null);
  const [restMessage, setRestMessage] = useState("REST API 입력 처리 설정을 불러왔습니다.");
  const [ragMessage, setRagMessage] = useState("분석 프롬프트와 GEO 참고 파일을 관리합니다.");
  const [modelOptions, setModelOptions] = useState<Partial<Record<ProviderId, string[]>>>({});
  const [modelLoadStatus, setModelLoadStatus] = useState<ModelLoadStatus>("idle");
  const [modelMessage, setModelMessage] = useState("AI 키를 입력한 뒤 모델 목록을 불러올 수 있습니다.");
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("idle");
  const [connectionMessage, setConnectionMessage] = useState("아직 실제 AI가 연동되지 않았습니다. OpenAI, Gemini, Azure OpenAI 중 하나를 연결해주세요.");
  const [copied, setCopied] = useState(false);
  const [agentProcess, setAgentProcess] = useState<AgentProcessState>({
    status: "idle",
    currentStepId: "input",
    sourceCount: 0,
    completedSourceCount: 0
  });

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 980px)");
    let animationFrameId: number | undefined;
    const closePanelOnNarrowViewport = (event: MediaQueryListEvent) => {
      if (event.matches) {
        setIsStatusPanelOpen(false);
      }
    };

    if (mediaQuery.matches) {
      animationFrameId = window.requestAnimationFrame(() => setIsStatusPanelOpen(false));
    }

    mediaQuery.addEventListener("change", closePanelOnNarrowViewport);
    return () => {
      if (animationFrameId !== undefined) {
        window.cancelAnimationFrame(animationFrameId);
      }
      mediaQuery.removeEventListener("change", closePanelOnNarrowViewport);
    };
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setHistoryTimeTick((current) => current + 1);
    }, 60_000);

    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    const timerId = window.setTimeout(() => {
      const storedProviderSettings = readStoredProviderSettings();
      setProviderSettings(storedProviderSettings);
      setRestApiSettings(readStoredRestApiSettings());
      setRagProfileSettings(readStoredRagProfileSettings());
      setQueue(readStoredHistoryQueue());
      setIsHistoryReady(true);
      void requestRagProfile()
        .then((settings) => {
          setRagProfileSettings(settings);
          setSelectedRagFileId(settings.files[0]?.id ?? null);
          window.localStorage.setItem(RAG_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
          setRagMessage("packages/product-extractor-agent의 RAG 프로필을 불러왔습니다.");
        })
        .catch((error: unknown) => {
          setRagMessage(error instanceof Error ? error.message : "패키지 RAG 프로필을 불러오지 못해 브라우저 캐시 값을 사용합니다.");
        });

      if (isAuthorizedAiSettings(storedProviderSettings)) {
        setConnectionStatus("connected");
        setConnectionMessage(`${providerLabels[storedProviderSettings.provider]} 연결 테스트가 완료된 설정을 불러왔습니다.`);
      }
      setIsProviderSettingsReady(true);
    }, 0);

    return () => window.clearTimeout(timerId);
  }, []);

  useEffect(() => {
    if (!isHistoryReady) {
      return;
    }

    try {
      window.sessionStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(queue.slice(0, HISTORY_LIMIT)));
    } catch {
      // Session storage is best effort; keep the in-memory history available if quota is exceeded.
    }
  }, [isHistoryReady, queue]);

  const selectedQueueItem = useMemo(() => {
    if (selectedId) {
      return queue.find((item) => item.id === selectedId);
    }
    return queue.find((item) => item.result || item.error);
  }, [queue, selectedId]);
  const resultQueueItems = queue.filter((item) => item.result || item.error);
  const selectedResultIndex = selectedQueueItem ? resultQueueItems.findIndex((item) => item.id === selectedQueueItem.id) : -1;
  const resultNavigatorLabel = selectedResultIndex >= 0 && resultQueueItems.length > 1
    ? `${selectedResultIndex + 1} / ${resultQueueItems.length}`
    : "";
  const canNavigateResults = resultQueueItems.length > 1;
  const selectedResult = selectedQueueItem?.result;
  const completedCount = queue.filter((item) => item.status === "done").length;
  const runningCount = queue.filter((item) => item.status === "running").length;
  const resultJson = selectedResult ? JSON.stringify(toPublicResult(selectedResult), null, 2) : "{}";
  const displayProcess = selectedResult && agentProcess.status === "idle"
    ? { status: "done" as const, currentStepId: "json" as const, sourceCount: 1, completedSourceCount: 1, activeSource: selectedResult.source }
    : agentProcess;
  const processProgressLabel = formatProcessProgress(displayProcess);
  const selectedDiagnostics = selectedResult?.diagnostics ?? selectedQueueItem?.diagnostics;
  const displaySteps = selectedDiagnostics?.process.length ? selectedDiagnostics.process : agentSteps;
  const normalizedSearch = searchQuery.trim().toLowerCase();
  const visibleQueue = useMemo(
    () =>
      normalizedSearch
        ? queue.filter((item) => matchesSearch([item.source, item.result?.geoProduct.name ?? shortUrl(item.source)], normalizedSearch))
        : queue,
    [normalizedSearch, queue]
  );
  const activeProviderLabel = providerLabels[providerSettings.provider];
  const isAgentBusy = isRunning || isRefining;
  const isAiAuthorized = isProviderSettingsReady && isAuthorizedAiSettings(providerSettings) && connectionStatus === "connected";
  const canSubmitPrompt = isAiAuthorized && !isAgentBusy;
  const shouldShowComposerNotice = isProviderSettingsReady && !isAiAuthorized;
  const activeModelOptions = modelOptions[providerSettings.provider] ?? [];
  const selectedRagFile = ragProfileSettings.files.find((file) => file.id === selectedRagFileId) ?? ragProfileSettings.files[0];
  const composerPlaceholder = selectedResult
    ? "수정할 내용을 적거나 새 상품 페이지 주소를 입력하세요"
    : getComposerPlaceholder(restApiSettings.sourceMode);

  async function submitPrompt() {
    if (!isProviderSettingsReady) {
      return;
    }

    const instruction = draft.trim();
    const draftSources = parseSources(draft);
    const attachmentSources = composerAttachments.flatMap((attachment) => attachment.sources);
    const sources = uniqueValues([...draftSources, ...attachmentSources]);
    const invalidUrlTokens = uniqueValues([
      ...findInvalidUrlTokens(draft),
      ...composerAttachments.flatMap((attachment) => attachment.invalidTokens)
    ]);

    if (invalidUrlTokens.length > 0) {
      appendGuardrailMessage(
        instruction,
        `유효하지 않은 URL 또는 REST API 주소입니다: ${invalidUrlTokens.slice(0, 3).join(", ")}. 상품 상세 URL은 http:// 또는 https://로 시작하는 완전한 주소로 입력해주세요.`
      );
      return;
    }

    if (sources.length === 0) {
      if (instruction.length > 0 && selectedResult) {
        if (isGeoRawEditInstruction(instruction)) {
          await runGeoRawEditAgent(instruction, selectedResult);
          return;
        }

        appendGuardrailMessage(
          instruction,
          "유효하지 않은 질문입니다. 이 입력창은 상품 URL/REST API 주소 입력 또는 선택된 GEO RAW JSON의 상품정보 필드 수정 요청만 처리합니다."
        );
        return;
      }

      appendGuardrailMessage(
        instruction,
        instruction.length > 0
          ? "유효하지 않은 질문입니다. 먼저 상품 URL 또는 REST API 주소를 입력해 추출을 실행하거나, 추출 결과를 선택한 뒤 GEO RAW JSON 상품정보 수정 요청을 입력해주세요."
          : "추출할 상품 URL 또는 REST API 주소를 입력해주세요."
      );
      return;
    }

    if (!isAiAuthorized) {
      setActiveSettingsPane("provider");
      setIsSettingsOpen(true);
      setConnectionMessage("추출을 실행하려면 먼저 실제 AI 연결 테스트를 완료해주세요.");
      return;
    }

    if (isAgentBusy) {
      return;
    }

    const now = new Date().toISOString();
    const requestedItems = sources.map((source) => ({
      id: createId(),
      source,
      status: "idle" as const,
      createdAt: now,
      updatedAt: now
    }));
    const nextQueue = [...requestedItems, ...queue].slice(0, HISTORY_LIMIT);

    setHasStarted(true);
    setMessages((current) => [
      ...(current.length > 0
        ? current
        : [
            {
              id: createId(),
              role: "tool" as const,
              command: "product-extractor-agent 준비됨",
              body: "packages/product-extractor-agent의 독립 에이전트와 REST 어댑터를 사용합니다."
            }
          ]),
      {
        id: createId(),
        role: "user",
        body: sources.join("\n")
      }
    ]);
    setDraft("");
    setComposerStatus("");
    setComposerAttachments([]);
    setSelectedId(requestedItems[0]?.id ?? null);
    setOutputPanelView("result");

    await runItems(nextQueue, requestedItems);
  }

  function appendGuardrailMessage(instruction: string, body: string) {
    setHasStarted(true);
    setMessages((current) => [
      ...current,
      ...(instruction.length > 0
        ? [{
            id: createId(),
            role: "user" as const,
            body: instruction
          }]
        : []),
      {
        id: createId(),
        role: "agent",
        body
      }
    ]);
  }

  async function runItems(nextQueue: QueueItem[], pending: QueueItem[]) {
    const pendingIds = new Set(pending.map((item) => item.id));
    const startedAt = new Date().toISOString();

    setIsRunning(true);
    setAgentProcess({
      status: "running",
      currentStepId: "input",
      sourceCount: pending.length,
      completedSourceCount: 0,
      activeSource: pending[0]?.source
    });
    setQueue(
      nextQueue.map((item) =>
        pendingIds.has(item.id) ? { ...item, status: "running", result: undefined, error: undefined, updatedAt: startedAt } : item
      )
    );
    setMessages((current) => [
      ...current,
      {
        id: createId(),
        role: "tool",
        command: `명령어 ${pending.length}개 실행함`,
        body: "OCR 후보 수집, 리뷰 키워드 분류, RAG chunk 생성을 실행합니다."
      }
    ]);

    try {
      await waitForStep();
      setAgentProcess((current) => ({ ...current, currentStepId: "fetch" }));
      const extraction = await requestExtraction(
        pending.map((item) => item.source),
        providerSettings,
        restApiSettings,
        ragProfileSettings
      );
      const { results, failures } = extraction;
      setAgentProcess((current) => ({
        ...current,
        completedSourceCount: results.length + failures.length
      }));
      for (const stepId of ["extract", "ocr", "review", "rag", "json"] satisfies AgentStepId[]) {
        setAgentProcess((current) => ({ ...current, currentStepId: stepId }));
        await waitForStep();
      }
      const resultBySource = new Map(results.map((result) => [result.source, result]));
      const failureBySource = new Map(failures.map((failure) => [failure.source, failure]));
      const finishedAt = new Date().toISOString();
      setQueue((current) =>
        current.map((item) => {
          if (!pendingIds.has(item.id)) {
            return item;
          }
          const result = resultBySource.get(item.source);
          const failure = failureBySource.get(item.source);
          if (result) {
            return { ...item, status: "done", result, diagnostics: result.diagnostics, error: undefined, updatedAt: finishedAt };
          }
          if (failure) {
            return { ...item, status: "error", diagnostics: failure.diagnostics, error: failure.error, result: undefined, updatedAt: finishedAt };
          }
          return item;
        })
      );
      const firstResultItem = pending.find((item) => resultBySource.has(item.source));
      const firstFailureItem = pending.find((item) => failureBySource.has(item.source));
      setSelectedId((current) => current ?? firstResultItem?.id ?? firstFailureItem?.id ?? pending[0]?.id ?? null);
      const failureSummary = failures.length > 0
        ? ` ${failures.length}개 소스는 수집하지 못했습니다: ${failures.map((failure) => shortUrl(failure.source)).join(", ")}`
        : "";
      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "agent",
          body: results.length > 0
            ? `${results.length}개 URL의 추출이 완료됐습니다. 결과 JSON은 아래 메시지와 우측 출력 패널에서 복사할 수 있습니다.${failureSummary}`
            : `추출 가능한 결과를 만들지 못했습니다.${failureSummary || " 소스 수집 단계에서 실패했습니다."}`,
          results
        }
      ]);
      setAgentProcess((current) => ({
        ...current,
        status: results.length > 0 ? "done" : "error",
        currentStepId: results.length > 0 ? "json" : "fetch",
        completedSourceCount: results.length + failures.length,
        activeSource: results[0]?.source ?? failures[0]?.source ?? current.activeSource,
        errorMessage: results.length > 0 ? undefined : failures[0]?.error
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Extraction failed.";
      const failedAt = new Date().toISOString();
      setAgentProcess((current) => ({
        ...current,
        status: "error",
        completedSourceCount: pending.length,
        errorMessage: message
      }));
      setQueue((current) =>
        current.map((item) =>
          pendingIds.has(item.id) ? { ...item, status: "error", error: message, updatedAt: failedAt } : item
        )
      );
      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "agent",
          body: message
        }
      ]);
    } finally {
      setIsRunning(false);
    }
  }

  async function runGeoRawEditAgent(instruction: string, currentResult: DisplayExtractionResult) {
    if (isAgentBusy) {
      return;
    }

    setHasStarted(true);
    setIsRefining(true);
    setDraft("");
    setOutputPanelView("result");
    setMessages((current) => [
      ...current,
      {
        id: createId(),
        role: "user",
        body: instruction
      },
      {
        id: createId(),
        role: "tool",
        command: "geo-raw-edit-agent 실행",
        body: "선택된 GEO RAW JSON 객체를 읽고, 요청된 상품정보 필드만 부분 수정합니다. 우측 진행상황 단계는 변경하지 않습니다."
      }
    ]);

    try {
      await waitForStep();
      const refinement = refineGeoProductResult({ result: toPublicResult(currentResult), instruction });
      const targetId = selectedQueueItem?.id ?? selectedId;
      const refinedAt = new Date().toISOString();
      const updatedResult: DisplayExtractionResult = {
        ...refinement.result,
        diagnostics: currentResult.diagnostics
      };
      setQueue((current) =>
        current.map((item) => item.id === targetId
          ? { ...item, result: updatedResult, status: "done", error: undefined, updatedAt: refinedAt }
          : item
        )
      );
      setSelectedId((current) => current ?? targetId ?? null);
      await waitForStep();
      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "tool",
          command: refinement.changes.length > 0 ? `GEO RAW JSON ${refinement.changes.length}개 필드 수정` : "GEO RAW JSON 검토 완료",
          body: refinement.summary
        },
        {
          id: createId(),
          role: "agent",
          body: refinement.changes.length > 0
            ? "요청사항을 반영해 GEO RAW JSON을 업데이트했습니다. 변경된 결과는 아래와 우측 출력 패널에서 확인할 수 있습니다."
            : refinement.summary,
          results: [updatedResult]
        }
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "GEO RAW JSON 수정 요청 처리에 실패했습니다.";
      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "agent",
          body: message
        }
      ]);
    } finally {
      setIsRefining(false);
    }
  }

  async function copyJson(value = resultJson) {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1300);
  }

  function startNewChat() {
    setDraft("");
    setComposerStatus("");
    setComposerAttachments([]);
    setSelectedId(null);
    setHasStarted(false);
    setMessages([]);
    setIsArtifactGrid(false);
    setIsStatusPanelOpen(true);
    setOutputPanelView("result");
    setAgentProcess({
      status: "idle",
      currentStepId: "input",
      sourceCount: 0,
      completedSourceCount: 0
    });
  }

  function toggleSearch() {
    setIsSidebarCollapsed(false);
    setIsSearchOpen((current) => !current);
  }

  function appendSourcesToDraft(sources: string[]) {
    if (sources.length === 0) {
      return;
    }

    setDraft((current) => parseSources(`${current}\n${sources.join("\n")}`).join("\n"));
  }

  async function importUrlFiles(files: File[]) {
    if (files.length === 0) {
      return;
    }

    const attachments = await Promise.all(
      files.map(async (file): Promise<ComposerAttachment> => {
        const content = await file.text();
        return {
          id: createId(),
          name: file.name,
          size: file.size,
          sources: parseSources(content),
          invalidTokens: findInvalidUrlTokens(content)
        };
      })
    );
    const importedSources = uniqueValues(attachments.flatMap((attachment) => attachment.sources));
    setComposerAttachments((current) => [
      ...current,
      ...attachments
    ]);
    setComposerStatus(
      importedSources.length > 0
        ? `${importedSources.length}개 URL을 첨부했습니다.`
        : "첨부 파일에서 URL을 찾지 못했습니다."
    );
  }

  function removeComposerAttachment(id: string) {
    const nextAttachments = composerAttachments.filter((attachment) => attachment.id !== id);
    const sourceCount = uniqueValues(nextAttachments.flatMap((attachment) => attachment.sources)).length;
    setComposerAttachments(nextAttachments);
    setComposerStatus(sourceCount > 0 ? `${sourceCount}개 URL이 첨부되어 있습니다.` : "");
  }

  async function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);

    await importUrlFiles(files);
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
    const droppedText = event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain");

    if (files.length > 0) {
      await importUrlFiles(files);
    }

    appendSourcesToDraft(parseSources(droppedText));
  }

  function openHistoryItem(item: QueueItem) {
    setSelectedId(item.id);
    setHasStarted(true);

    if (item.result) {
      setAgentProcess({
        status: "done",
        currentStepId: "json",
        sourceCount: 1,
        completedSourceCount: 1,
        activeSource: item.source
      });
      setMessages([
        {
          id: createId(),
          role: "user",
          body: item.source
        },
        {
          id: createId(),
          role: "agent",
          body: `${item.result.geoProduct.name} 추출 결과를 히스토리에서 불러왔습니다.`,
          results: [item.result]
        }
      ]);
      return;
    }

    setAgentProcess({
      status: item.status === "error" ? "error" : item.status === "running" ? "running" : "idle",
      currentStepId: item.status === "error" || item.status === "running" ? "fetch" : "input",
      sourceCount: 1,
      completedSourceCount: item.status === "idle" || item.status === "running" ? 0 : 1,
      activeSource: item.source,
      errorMessage: item.error
    });
    setMessages([
      {
        id: createId(),
        role: "user",
        body: item.source
      },
      {
        id: createId(),
        role: item.status === "error" ? "agent" : "tool",
        command: item.status === "error" ? undefined : "히스토리 항목 선택",
        body: item.error ?? "아직 생성된 JSON 결과가 없습니다."
      }
    ]);
  }

  function removeHistoryItem(id: string) {
    setQueue((current) => current.filter((item) => item.id !== id));
    setSelectedId((current) => current === id ? null : current);
  }

  function selectNextResultItem() {
    if (!canNavigateResults) {
      return;
    }

    const currentIndex = selectedResultIndex >= 0 ? selectedResultIndex : 0;
    const nextItem = resultQueueItems[(currentIndex + 1) % resultQueueItems.length];

    if (!nextItem) {
      return;
    }

    setSelectedId(nextItem.id);
    setOutputPanelView(nextItem.result ? "result" : "logs");
  }

  function updateProviderSetting<Key extends keyof ProviderSettings>(key: Key, value: ProviderSettings[Key]) {
    setProviderSettings((current) => ({
      ...current,
      [key]: value
    }));
    setConnectionStatus("idle");
    if (key === "provider") {
      setModelLoadStatus("idle");
      setModelMessage("AI 키를 입력한 뒤 모델 목록을 불러올 수 있습니다.");
    }
    setConnectionMessage(
      key === "provider" && value === "mock"
        ? "Mock 테스트는 데모 검증용입니다. 추출 실행 버튼을 사용하려면 실제 AI를 연결해주세요."
        : "모델 목록을 불러와 선택한 뒤 연결 테스트를 진행해주세요."
    );
  }

  async function checkProviderConnection(shouldSave: boolean) {
    const validationMessage = getProviderValidationMessage(providerSettings);

    if (validationMessage) {
      setConnectionStatus("error");
      setConnectionMessage(validationMessage);
      return;
    }

    setConnectionStatus("checking");
    setConnectionMessage(`${activeProviderLabel} 연결 테스트를 실행하고 있습니다.`);

    try {
      const result = await validateProviderConnection(providerSettings);
      setModelOptions((current) => ({
        ...current,
        [providerSettings.provider]: result.models
      }));
      setModelMessage(result.models.length > 0 ? `${result.models.length}개 모델을 확인했습니다.` : "사용 가능한 모델 목록이 비어 있습니다.");
      if (shouldSave) {
        window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(providerSettings));
      }
      setConnectionStatus("connected");
      setConnectionMessage(
        shouldSave
          ? `${result.message} 설정을 저장했고 다음 추출부터 적용됩니다.`
          : `${result.message} 현재 화면의 추출에 사용할 수 있습니다. 저장하면 새로고침 후에도 유지됩니다.`
      );
    } catch (error) {
      setConnectionStatus("error");
      setConnectionMessage(error instanceof Error ? error.message : `${activeProviderLabel} 연결 확인에 실패했습니다.`);
    }
  }

  async function testProviderConnection() {
    await checkProviderConnection(false);
  }

  async function saveProviderSettings() {
    await checkProviderConnection(true);
  }

  async function loadProviderModels() {
    const validationMessage = getProviderCredentialValidationMessage(providerSettings);

    if (validationMessage) {
      setModelLoadStatus("error");
      setModelMessage(validationMessage);
      setConnectionStatus("error");
      setConnectionMessage(validationMessage);
      return;
    }

    setModelLoadStatus("loading");
    setModelMessage(`${activeProviderLabel} 모델 목록을 불러오고 있습니다.`);

    try {
      const result = await validateProviderConnection(providerSettings, { listOnly: true });
      const models = result.models;
      setModelOptions((current) => ({
        ...current,
        [providerSettings.provider]: models
      }));
      setModelLoadStatus("ready");
      setModelMessage(models.length > 0 ? `${models.length}개 모델을 불러왔습니다. 사용할 모델을 선택해주세요.` : "선택 가능한 모델이 없습니다.");

      if (models.length > 0) {
        const currentModel = getSelectedModel(providerSettings);
        if (!currentModel || !models.includes(currentModel)) {
          updateProviderModel(providerSettings.provider, models[0] ?? "");
        }
      }
    } catch (error) {
      setModelLoadStatus("error");
      setModelMessage(error instanceof Error ? error.message : `${activeProviderLabel} 모델 목록을 불러오지 못했습니다.`);
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
        return { ...current, azureDeployment: value };
      }
      return current;
    });
    setConnectionStatus("idle");
    setConnectionMessage("선택한 모델로 연결 테스트를 진행해주세요.");
  }

  function resetProviderSettings() {
    window.localStorage.removeItem(SETTINGS_STORAGE_KEY);
    setProviderSettings(defaultProviderSettings);
    setConnectionStatus("idle");
    setModelOptions({});
    setModelLoadStatus("idle");
    setModelMessage("AI 키를 입력한 뒤 모델 목록을 불러올 수 있습니다.");
    setConnectionMessage("AI 연동 설정을 초기화했습니다. 추출을 실행하려면 실제 AI를 연결해주세요.");
  }

  function updateRestApiSetting<Key extends keyof RestApiSettings>(key: Key, value: RestApiSettings[Key]) {
    setRestApiSettings((current) => ({
      ...current,
      [key]: value
    }));
    setRestMessage("변경사항을 저장하면 다음 추출부터 적용됩니다.");
  }

  function saveRestApiSettings() {
    try {
      parseHeadersJson(restApiSettings.headersJson);
      window.localStorage.setItem(REST_SETTINGS_STORAGE_KEY, JSON.stringify(restApiSettings));
      setRestMessage("REST API 설정이 저장되었습니다. 다음 추출부터 적용됩니다.");
    } catch (error) {
      setRestMessage(error instanceof Error ? error.message : "요청 헤더 JSON 형식을 확인해주세요.");
    }
  }

  function resetRestApiSettings() {
    window.localStorage.removeItem(REST_SETTINGS_STORAGE_KEY);
    setRestApiSettings(defaultRestApiSettings);
    setRestMessage("REST API 설정을 기본값으로 초기화했습니다.");
  }

  function updateRagAnalysisPrompt(value: string) {
    setRagProfileSettings((current) => ({
      ...current,
      analysisPrompt: value
    }));
    setRagMessage("변경사항을 저장하면 다음 추출부터 적용됩니다.");
  }

  async function importRagFiles(files: File[]) {
    if (files.length === 0) {
      return;
    }

    const attachments = await Promise.all(
      files.map(async (file) => ({
        id: createId(),
        name: file.name,
        version: extractRagFileVersion(file.name),
        size: file.size,
        type: file.type || "text/plain",
        content: await file.text(),
        managed: false,
        addedAt: new Date().toISOString()
      }))
    );

    setRagProfileSettings((current) => ({
      ...current,
      files: [...attachments, ...current.files].slice(0, 12)
    }));
    setSelectedRagFileId(attachments[0]?.id ?? null);
    setRagMessage(`${attachments.length}개 파일을 RAG 프로필에 추가했습니다. 저장하면 packages/product-extractor-agent/src/rag에 동기화됩니다.`);
  }

  async function handleRagFileInput(event: ChangeEvent<HTMLInputElement>) {
    await importRagFiles(Array.from(event.currentTarget.files ?? []));
    event.currentTarget.value = "";
  }

  function removeRagFile(id: string) {
    const nextFiles = ragProfileSettings.files.filter((file) => file.id !== id);
    setRagProfileSettings((current) => ({
      ...current,
      files: current.files.filter((file) => file.id !== id)
    }));
    setSelectedRagFileId((selected) => selected === id ? nextFiles[0]?.id ?? null : selected);
    setRagMessage("RAG 파일을 제거했습니다.");
  }

  function updateRagFileContent(id: string, content: string) {
    setRagProfileSettings((current) => ({
      ...current,
      files: current.files.map((file) => file.id === id
        ? {
            ...file,
            content,
            size: new TextEncoder().encode(content).length
          }
        : file)
    }));
    setRagMessage("RAG 파일 내용이 수정되었습니다. 저장하면 패키지 파일에 동기화됩니다.");
  }

  async function saveRagProfileSettings() {
    try {
      const settings = await writeRagProfile(ragProfileSettings);
      setRagProfileSettings(settings);
      setSelectedRagFileId(settings.files.find((file) => file.id === selectedRagFileId)?.id ?? settings.files[0]?.id ?? null);
      window.localStorage.setItem(RAG_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
      setRagMessage("RAG 프로필이 packages/product-extractor-agent/src/rag와 동기화되었습니다. 다음 추출부터 LLM 프롬프트와 RAG chunk에 반영됩니다.");
    } catch (error) {
      setRagMessage(error instanceof Error ? error.message : "RAG 프로필 저장에 실패했습니다.");
    }
  }

  async function resetRagProfileSettings() {
    try {
      const settings = await resetPackageRagProfile();
      setRagProfileSettings(settings);
      setSelectedRagFileId(settings.files[0]?.id ?? null);
      window.localStorage.setItem(RAG_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
      setRagMessage("패키지 RAG 프로필을 기본값으로 초기화했습니다.");
    } catch (error) {
      setRagMessage(error instanceof Error ? error.message : "RAG 프로필 초기화에 실패했습니다.");
    }
  }

  const settingsTitle = activeSettingsPane === "provider"
    ? "AI 연동"
    : activeSettingsPane === "rest"
      ? "REST API 설정"
      : "RAG 프로필";
  const settingsDescription = activeSettingsPane === "provider"
    ? "OpenAI, Gemini, Azure OpenAI 키를 등록하고 연결 테스트를 통과한 설정만 추출 실행에 사용합니다."
    : activeSettingsPane === "rest"
      ? "REST API 주소를 입력했을 때 데이터 소스 타입과 요청 헤더를 어떻게 처리할지 설정합니다."
      : "페이지 내 상품 정보 추출을 위한 분석 프롬프트와 GEO 참고 파일을 RAG 데이터로 관리합니다.";

  return (
    <main
      className={`codexShell ${isSidebarCollapsed ? "sidebarCollapsed" : ""} ${
        hasStarted ? "chatStarted" : "chatWelcome"
      } ${isArtifactGrid ? "artifactGridMode" : ""} ${isStatusPanelOpen ? "" : "statusPanelClosed"}`}
    >
      <aside className="codexSidebar" aria-label="Navigation">
        <div className="sidebarHeader">
          <div className="brandLockup" aria-label="Agentic GEO">
            <span className="brandAvatar" aria-hidden="true">
              <Image
                src="/icons/profile-rounded.png"
                alt=""
                width={22}
                height={22}
                priority
              />
            </span>
            <span className="brandName">Agentic GEO</span>
          </div>
          <button
            className="sidebarToggle"
            type="button"
            aria-label={isSidebarCollapsed ? "사이드바 펼치기" : "사이드바 접기"}
            aria-pressed={isSidebarCollapsed}
            onClick={() => setIsSidebarCollapsed((current) => !current)}
            title={isSidebarCollapsed ? "사이드바 펼치기" : "사이드바 접기"}
          >
            <PanelLeft size={15} />
          </button>
        </div>

        <nav className="primaryNav" aria-label="Primary">
          <button type="button" onClick={startNewChat}>
            <MessageSquarePlus size={15} />
            <span className="navText">새 채팅</span>
          </button>
          <button className={isSearchOpen ? "active" : ""} type="button" onClick={toggleSearch}>
            <Search size={15} />
            <span className="navText">검색</span>
          </button>
        </nav>

        {isSearchOpen && (
          <label className="sidebarSearch">
            <Search size={14} />
            <input
              autoFocus
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="히스토리 검색"
            />
          </label>
        )}

        <section className="sidebarSection historySection">
          <h2>히스토리</h2>
          {visibleQueue.length === 0 ? (
            <p className="emptyHistory">{queue.length === 0 ? "아직 추출 히스토리가 없습니다" : "검색 결과가 없습니다"}</p>
          ) : (
            <div className="historyList">
              {visibleQueue.map((item) => (
                <div
                  className={`queueThread ${selectedId === item.id ? "active" : ""}`}
                  key={item.id}
                >
                  <button
                    className="queueThreadMain"
                    type="button"
                    onClick={() => openHistoryItem(item)}
                  >
                    <StatusDot status={item.status} />
                    <span className="historyText">
                      <span className="historyTitle">{item.result?.geoProduct.name ?? shortUrl(item.source)}</span>
                      <span className="historySource">{item.source}</span>
                    </span>
                    <time dateTime={item.updatedAt}>{formatHistoryTime(item.updatedAt)}</time>
                  </button>
                  <button
                    className="queueRemoveButton"
                    type="button"
                    aria-label={`${item.result?.geoProduct.name ?? shortUrl(item.source)} 히스토리 삭제`}
                    title="히스토리 삭제"
                    onClick={() => removeHistoryItem(item.id)}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <div className="sidebarFooter">
          <button type="button" onClick={() => setIsSettingsOpen(true)}>
            <Settings size={15} />
            <span className="footerText">설정</span>
          </button>
        </div>
      </aside>

      <section className="codexMain" aria-label="Product extractor conversation">
        <header className="threadHeader">
          <div className="threadTitle">
            <span>agentic-geo 상품정보 추출</span>
            <MoreHorizontal size={18} />
          </div>
          <div className="windowActions" aria-label="보기 옵션">
            <button
              className={isArtifactGrid ? "active" : ""}
              type="button"
              aria-label={isArtifactGrid ? "기본 결과 보기" : "넓은 결과 보기"}
              aria-pressed={isArtifactGrid}
              title={isArtifactGrid ? "기본 결과 보기" : "넓은 결과 보기"}
              onClick={() => setIsArtifactGrid((current) => !current)}
            >
              <LayoutGrid size={17} />
            </button>
            <button
              className={isSidebarCollapsed ? "active" : ""}
              type="button"
              aria-label={isSidebarCollapsed ? "왼쪽 패널 펼치기" : "왼쪽 패널 접기"}
              aria-pressed={isSidebarCollapsed}
              title={isSidebarCollapsed ? "왼쪽 패널 펼치기" : "왼쪽 패널 접기"}
              onClick={() => setIsSidebarCollapsed((current) => !current)}
            >
              <PanelLeft size={17} />
            </button>
            <button
              className={isStatusPanelOpen ? "active" : ""}
              type="button"
              aria-label={isStatusPanelOpen ? "오른쪽 진행 패널 숨기기" : "오른쪽 진행 패널 보기"}
              aria-pressed={isStatusPanelOpen}
              title={isStatusPanelOpen ? "오른쪽 진행 패널 숨기기" : "오른쪽 진행 패널 보기"}
              onClick={() => setIsStatusPanelOpen((current) => !current)}
            >
              <PanelRight size={17} />
            </button>
          </div>
        </header>

        <div className="threadCanvas">
          {!hasStarted && (
            <section className="welcomeStage" aria-label="Start">
              <h1>agentic-geo에서 무엇을 추출할까요?</h1>
              <div className="starterCards" aria-hidden="true">
                <div>
                  <Globe2 size={18} />
                  <strong>URL 입력</strong>
                  <span>상품 상세 페이지</span>
                </div>
                <div>
                  <FileCode2 size={18} />
                  <strong>REST API</strong>
                  <span>상품 데이터 응답</span>
                </div>
                <div>
                  <Copy size={18} />
                  <strong>JSON 결과</strong>
                  <span>복사 가능한 출력</span>
                </div>
              </div>
            </section>
          )}

          {!hasStarted && isStatusPanelOpen && (
            <aside className="statusPanel" aria-label="Progress">
              <div className="progressTitle">
                <span>진행 상황</span>
                <em className="processBadge idle">대기</em>
                <ChevronRight size={14} />
              </div>
              <ol className="processSteps">
                {agentSteps.map((step) => (
                  <li className="processStep pending" key={step.id}>
                    <StepStatusIcon status="pending" />
                    <div>
                      <strong>{step.title}</strong>
                      <span>{step.description}</span>
                    </div>
                  </li>
                ))}
              </ol>
              <div className="panelDivider" />
              <div className="panelBlock">
                <span>출력</span>
                <strong>아직 아티팩트가 없습니다</strong>
              </div>
              <div className="panelDivider" />
              <div className="panelBlock">
                <span>출처</span>
                <div className="sourceList">
                  <strong>입력된 URL 또는 REST API가 없습니다</strong>
                </div>
              </div>
            </aside>
          )}

          {hasStarted && (
            <>
              <section className="threadStream" aria-label="Conversation">
                {messages.map((message) => (
                  <article className={`chatBlock ${message.role}`} key={message.id}>
                    {message.command && (
                      <div className="commandLine">
                        <FileCode2 size={14} />
                        <span>{message.command}</span>
                      </div>
                    )}
                    <p>{message.body}</p>
                    {message.results && (
                      <div className="resultStack">
                        {message.results.map((result) => (
                          <div className="resultArtifact" key={result.source}>
                            <div className="artifactTop">
                              <div>
                                <span>GEO RAW JSON</span>
                                <strong>{result.geoProduct.name}</strong>
                              </div>
                              <button
                                className="artifactCopyButton"
                                type="button"
                                onClick={() => copyJson(JSON.stringify(toPublicResult(result), null, 2))}
                                title="JSON 복사"
                                aria-label={`${result.geoProduct.name} JSON 복사`}
                              >
                                <Copy size={14} />
                                <span>복사</span>
                              </button>
                            </div>
                            <pre>{JSON.stringify(toPublicResult(result), null, 2)}</pre>
                          </div>
                        ))}
                      </div>
                    )}
                  </article>
                ))}
                {isRunning && (
                  <article className="chatBlock tool">
                    <div className="commandLine">
                      <Loader2 className="spin" size={14} />
                      <span>product-extractor-agent 실행 중</span>
                    </div>
                    <p>페이지 메타정보, DOM, 이미지 OCR 후보, 리뷰 키워드를 정리하고 있습니다.</p>
                  </article>
                )}
                {isRefining && (
                  <article className="chatBlock tool">
                    <div className="commandLine">
                      <Loader2 className="spin" size={14} />
                      <span>geo-raw-edit-agent 작업 중</span>
                    </div>
                    <p>선택된 GEO RAW JSON 객체에서 요청된 상품정보 필드만 수정하고 있습니다.</p>
                  </article>
                )}
              </section>

              {isStatusPanelOpen && (
                <aside className="statusPanel" aria-label="Progress">
                  <div className="progressTitle">
                    <span>
                      진행 상황
                      {processProgressLabel && (
                        <small>{processProgressLabel}</small>
                      )}
                    </span>
                    <em className={`processBadge ${displayProcess.status}`}>{processStatusLabel(displayProcess.status)}</em>
                    <button
                      className="resultCycleButton"
                      type="button"
                      disabled={!canNavigateResults}
                      aria-label={canNavigateResults ? `다음 결과 보기 (${resultNavigatorLabel})` : "다음 결과 없음"}
                      title={canNavigateResults ? `다음 결과 보기 · ${resultNavigatorLabel}` : "다음 결과 없음"}
                      onClick={selectNextResultItem}
                    >
                      <ChevronRight size={14} />
                    </button>
                  </div>
                  <ol className="processSteps">
                    {displaySteps.map((step) => {
                      const resultStepStatus = "status" in step ? step.status : undefined;
                      const stepStatus = isAgentStepStatus(resultStepStatus) && selectedDiagnostics?.process.length && displayProcess.status === "done"
                        ? resultStepStatus
                        : getStepStatus(step.id, displayProcess);
                      const stepMessage = "message" in step && typeof step.message === "string" && step.message.length > 0
                        ? step.message
                        : step.description;
                      return (
                        <li className={`processStep ${stepStatus}`} key={step.id}>
                          <StepStatusIcon status={stepStatus} />
                          <div>
                            <strong>{step.title}</strong>
                            <span>{stepMessage}</span>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                  <div className="panelDivider" />
                  <div className="panelBlock">
                    <span>출력</span>
                    {selectedResult ? (
                      <>
                        <div className="outputTabs" role="tablist" aria-label="Output view">
                          <button
                            className={outputPanelView === "result" ? "active" : ""}
                            type="button"
                            onClick={() => setOutputPanelView("result")}
                          >
                            결과
                          </button>
                          <button
                            className={outputPanelView === "logs" ? "active" : ""}
                            type="button"
                            onClick={() => setOutputPanelView("logs")}
                          >
                            로그
                          </button>
                        </div>
                        {outputPanelView === "result" ? (
                          <div className="outputSummary">
                            <strong>{selectedResult.geoProduct.name}</strong>
                            <dl>
                              <div>
                                <dt>리뷰 키워드</dt>
                                <dd>{selectedResult.geoProduct.reviews.keywords.length}</dd>
                              </div>
                              <div>
                                <dt>OCR 블록</dt>
                                <dd>{selectedResult.geoProduct.ocr.textBlocks.length}</dd>
                              </div>
                              <div>
                                <dt>HTML 분석</dt>
                                <dd>{selectedResult.geoProduct.contentAnalysis.sections.length}</dd>
                              </div>
                              <div>
                                <dt>RAG chunk</dt>
                                <dd>{selectedResult.geoProduct.rag.chunks.length}</dd>
                              </div>
                            </dl>
                          </div>
                        ) : (
                          <DiagnosticLog diagnostics={selectedDiagnostics} />
                        )}
                      </>
                    ) : selectedDiagnostics ? (
                      <>
                        <div className="outputTabs" role="tablist" aria-label="Output view">
                          <button className="active" type="button">
                            로그
                          </button>
                        </div>
                        <DiagnosticLog diagnostics={selectedDiagnostics} />
                      </>
                    ) : (
                      <strong>
                        {displayProcess.status === "running"
                          ? `${displayProcess.sourceCount}개 소스 처리 중${processProgressLabel ? ` · ${processProgressLabel}` : ""}${runningCount > 0 ? ` · 실행 중 ${runningCount}` : ""}`
                          : "아직 아티팩트가 없습니다"}
                      </strong>
                    )}
                    {selectedResult && (
                      <button className="copyPanelButton" type="button" onClick={() => copyJson()}>
                        <Copy size={13} />
                        {copied ? "복사됨" : "JSON 복사"}
                      </button>
                    )}
                  </div>
                  <div className="panelDivider" />
                  <div className="panelBlock">
                    <span>출처</span>
                    <div className="sourceList">
                      {(selectedResult
                        ? [selectedResult.source, ...selectedResult.geoProduct.images.slice(0, 2)]
                        : selectedQueueItem
                          ? [selectedQueueItem.source]
                        : queue.slice(0, 3).map((item) => item.source)
                      ).map((source) => (
                        <button key={source} type="button" title={source}>
                          <Globe2 size={14} />
                          <span>{shortUrl(source)}</span>
                        </button>
                      ))}
                      {!selectedResult && queue.length === 0 && (
                        <strong>입력된 URL 또는 REST API가 없습니다</strong>
                      )}
                    </div>
                  </div>
                </aside>
              )}
            </>
          )}
        </div>

        <form
          className={`composerDock ${shouldShowComposerNotice ? "needsAuth" : ""}`}
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmitPrompt) {
              void submitPrompt();
            }
          }}
        >
          {shouldShowComposerNotice && (
            <div className="composerNotice" role="status">
              <KeyRound size={16} />
              <div>
                <strong>AI 연동이 필요합니다</strong>
                <span>설정에서 OpenAI, Gemini, Azure OpenAI 중 하나를 연결 테스트하면 추출과 GEO RAW 수정 요청을 실행할 수 있습니다.</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setActiveSettingsPane("provider");
                  setIsSettingsOpen(true);
                }}
              >
                설정 열기
              </button>
            </div>
          )}
          <div className="reviewStrip">
            <span>
              히스토리 {queue.length}개 <b>+{completedCount}</b> <em>-0</em>
            </span>
            <button type="button" onClick={() => selectedResult && copyJson()}>
              검토
            </button>
          </div>
          <div
            className={`composer ${isDragActive ? "dragActive" : ""}`}
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
                <span>URL 파일 또는 텍스트 놓기</span>
              </div>
            )}
            {composerAttachments.length > 0 && (
              <div className="attachmentTray" aria-label="첨부 파일">
                {composerAttachments.map((attachment) => (
                  <div
                    className={`attachmentChip ${attachment.sources.length === 0 ? "empty" : ""}`}
                    key={attachment.id}
                    title={`${attachment.name} · ${attachment.sources.length}개 URL`}
                  >
                    <FileText size={14} />
                    <span>
                      <strong>{attachment.name}</strong>
                      <em>
                        {attachment.sources.length > 0
                          ? `${attachment.sources.length}개 URL`
                          : "URL 없음"}
                      </em>
                    </span>
                    <button
                      type="button"
                      aria-label={`${attachment.name} 첨부 제거`}
                      title="첨부 제거"
                      onClick={() => removeComposerAttachment(attachment.id)}
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              aria-label="URL input"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setComposerStatus("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  if (canSubmitPrompt) {
                    void submitPrompt();
                  }
                }
              }}
              placeholder={
                composerPlaceholder
              }
              rows={2}
            />
            <div className="composerBar">
              <div className="composerTools">
                <button
                  type="button"
                  title="URL 파일 첨부"
                  aria-label="URL 파일 첨부"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Plus size={18} />
                </button>
              </div>
              {composerStatus && <span className="composerStatus">{composerStatus}</span>}
              <div className="composerTools right">
                <button
                  className="sendButton"
                  type="submit"
                  disabled={!canSubmitPrompt}
                  title={
                    isProviderSettingsReady
                      ? isAiAuthorized
                        ? "에이전트 실행"
                        : "설정에서 AI 연동을 완료해주세요"
                      : "AI 연동 상태 확인 중"
                  }
                  aria-label={
                    isProviderSettingsReady
                      ? isAiAuthorized
                        ? "에이전트 실행"
                        : "AI 연동 필요"
                      : "AI 연동 확인 중"
                  }
                >
                  {isAgentBusy ? <CircleStop size={18} /> : <Send size={17} />}
                </button>
              </div>
            </div>
          </div>
        </form>
      </section>

      {isSettingsOpen && (
        <div className="settingsOverlay" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <div className="settingsModal">
            <aside className="settingsSidebar" aria-label="Settings navigation">
              <button className="backToApp" type="button" onClick={() => setIsSettingsOpen(false)}>
                <ArrowLeft size={15} />
                앱으로 돌아가기
              </button>
              <label className="settingsSearch">
                <Search size={14} />
                <input placeholder="설정 검색..." readOnly />
              </label>
              <div className="settingsGroup">
                <span>연결</span>
                <button
                  className={activeSettingsPane === "provider" ? "active" : ""}
                  type="button"
                  onClick={() => setActiveSettingsPane("provider")}
                >
                  <PlugZap size={15} />
                  AI 연동
                </button>
                <button
                  className={activeSettingsPane === "rest" ? "active" : ""}
                  type="button"
                  onClick={() => setActiveSettingsPane("rest")}
                >
                  <Globe2 size={15} />
                  REST API
                </button>
                <button
                  className={activeSettingsPane === "rag" ? "active" : ""}
                  type="button"
                  onClick={() => setActiveSettingsPane("rag")}
                >
                  <FileCode2 size={15} />
                  RAG 프로필
                </button>
              </div>
            </aside>

            <section className="settingsContent">
              <div className="settingsTopbar">
                <div>
                  <h2 id="settings-title">{settingsTitle}</h2>
                  <p>{settingsDescription}</p>
                </div>
                <button type="button" aria-label="설정 닫기" onClick={() => setIsSettingsOpen(false)}>
                  <X size={18} />
                </button>
              </div>

              {activeSettingsPane === "provider" && (
                <>
              <div className={`connectionBanner ${connectionStatus}`}>
                <KeyRound size={16} />
                <div>
                  <strong>{activeProviderLabel} · {connectionStatusLabel(connectionStatus)}</strong>
                  <span>{connectionMessage}</span>
                </div>
              </div>

              <section className="settingsSection">
                <h3>AI 선택</h3>
                <div className="providerGrid">
                  {(["mock", "openai", "gemini", "azure-openai"] satisfies ProviderId[]).map((provider) => (
                    <button
                      className={providerSettings.provider === provider ? "active" : ""}
                      key={provider}
                      type="button"
                      onClick={() => updateProviderSetting("provider", provider)}
                    >
                      <span>{providerLabels[provider]}</span>
                      <Circle size={14} />
                    </button>
                  ))}
                </div>
              </section>

              <section className="settingsSection">
                <h3>인증 정보</h3>
                {providerSettings.provider === "mock" && (
                  <div className="settingsCard">
                    <strong>Mock 테스트</strong>
                    <p>API Key 없이 UI/UX와 JSON 결과 흐름을 빠르게 확인하는 데모 모드입니다. 실제 추출 실행 버튼을 활성화하려면 OpenAI, Gemini, Azure OpenAI 중 하나를 연결해주세요.</p>
                  </div>
                )}

                {providerSettings.provider === "openai" && (
                  <div className="settingsFields">
                    <SettingField
                      label="OpenAI API Key"
                      type="password"
                      value={providerSettings.openaiApiKey}
                      placeholder="sk-... 또는 OPENAI_API_KEY=..."
                      onChange={(value) => updateProviderSetting("openaiApiKey", value)}
                    />
                    <ModelSelectField
                      label="Model"
                      value={providerSettings.openaiModel}
                      options={activeModelOptions}
                      status={modelLoadStatus}
                      message={modelMessage}
                      placeholder="모델 목록을 불러와 선택"
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
                      placeholder="AIza... 또는 GEMINI_API_KEY=..."
                      onChange={(value) => updateProviderSetting("geminiApiKey", value)}
                    />
                    <ModelSelectField
                      label="Model"
                      value={providerSettings.geminiModel}
                      options={activeModelOptions}
                      status={modelLoadStatus}
                      message={modelMessage}
                      placeholder="모델 목록을 불러와 선택"
                      onRefresh={() => {
                        void loadProviderModels();
                      }}
                      onChange={(value) => updateProviderSetting("geminiModel", value)}
                    />
                  </div>
                )}

                {providerSettings.provider === "azure-openai" && (
                  <div className="settingsFields">
                    <SettingField
                      label="Azure API Key"
                      type="password"
                      value={providerSettings.azureApiKey}
                      placeholder="Azure OpenAI key"
                      onChange={(value) => updateProviderSetting("azureApiKey", value)}
                    />
                    <SettingField
                      label="Endpoint"
                      value={providerSettings.azureEndpoint}
                      placeholder="https://resource-name.openai.azure.com"
                      onChange={(value) => updateProviderSetting("azureEndpoint", value)}
                    />
                    <ModelSelectField
                      label="Deployment"
                      value={providerSettings.azureDeployment}
                      options={activeModelOptions}
                      status={modelLoadStatus}
                      message={modelMessage}
                      placeholder="배포 목록을 불러와 선택"
                      onRefresh={() => {
                        void loadProviderModels();
                      }}
                      onChange={(value) => updateProviderSetting("azureDeployment", value)}
                    />
                    <SettingField
                      label="API Version"
                      value={providerSettings.azureApiVersion}
                      placeholder="2024-10-21"
                      onChange={(value) => updateProviderSetting("azureApiVersion", value)}
                    />
                  </div>
                )}
              </section>

              <section className="settingsSection">
                <h3>적용 범위</h3>
                <div className="settingsCard">
                  <strong>product-extractor-agent</strong>
                  <p>저장한 AI 연동 설정은 URL/REST API 추출 중 OCR 키워드 분류 단계에서 사용됩니다. 키는 서버에 영구 저장하지 않고 이 브라우저의 로컬 저장소에만 보관합니다.</p>
                </div>
              </section>

              <div className="settingsActions">
                <button type="button" onClick={resetProviderSettings}>
                  초기화
                </button>
                <button
                  type="button"
                  disabled={connectionStatus === "checking"}
                  onClick={() => {
                    void testProviderConnection();
                  }}
                >
                  {connectionStatus === "checking" ? "테스트 중" : "연결 테스트"}
                </button>
                <button
                  className="primary"
                  type="button"
                  disabled={connectionStatus === "checking"}
                  onClick={() => {
                    void saveProviderSettings();
                  }}
                >
                  {connectionStatus === "checking" ? "확인 중" : "저장 및 적용"}
                </button>
              </div>
                </>
              )}

              {activeSettingsPane === "rest" && (
                <>
                  <div className="connectionBanner connected">
                    <Globe2 size={16} />
                    <div>
                      <strong>REST API</strong>
                      <span>{restMessage}</span>
                    </div>
                  </div>

                  <section className="settingsSection">
                    <h3>입력 처리 모드</h3>
                    <div className="providerGrid threeColumns">
                      {(["auto", "url", "restApi"] satisfies SourceMode[]).map((mode) => (
                        <button
                          className={restApiSettings.sourceMode === mode ? "active" : ""}
                          key={mode}
                          type="button"
                          onClick={() => updateRestApiSetting("sourceMode", mode)}
                        >
                          <span>{sourceModeLabel(mode)}</span>
                          <Circle size={14} />
                        </button>
                      ))}
                    </div>
                  </section>

                  <section className="settingsSection">
                    <h3>요청 헤더</h3>
                    <label className="settingTextarea">
                      <span>Headers JSON</span>
                      <textarea
                        value={restApiSettings.headersJson}
                        rows={7}
                        spellCheck={false}
                        onChange={(event) => updateRestApiSetting("headersJson", event.target.value)}
                      />
                    </label>
                  </section>

                  <section className="settingsSection">
                    <h3>응답 기준</h3>
                    <div className="settingsCard">
                      <strong>product / reviews 구조 권장</strong>
                      <p>REST API 응답은 product, reviews, reviewItems, ocrTexts 등의 필드를 우선 정규화합니다. 모드가 자동이면 /api/ 또는 .json 형태의 주소를 REST API로 추정합니다.</p>
                    </div>
                  </section>

                  <div className="settingsActions">
                    <button type="button" onClick={resetRestApiSettings}>
                      초기화
                    </button>
                    <button className="primary" type="button" onClick={saveRestApiSettings}>
                      REST 설정 저장
                    </button>
                  </div>
                </>
              )}

              {activeSettingsPane === "rag" && (
                <>
                  <div className="connectionBanner connected">
                    <Database size={16} />
                    <div>
                      <strong>RAG 프로필</strong>
                      <span>{ragMessage}</span>
                    </div>
                  </div>

                  <section className="settingsSection">
                    <h3>분석 프롬프트</h3>
                    <label className="settingTextarea">
                      <span>Product GEO Analysis Prompt</span>
                      <textarea
                        value={ragProfileSettings.analysisPrompt}
                        rows={8}
                        onChange={(event) => updateRagAnalysisPrompt(event.target.value)}
                      />
                    </label>
                  </section>

                  <section className="settingsSection">
                    <h3>GEO 참고 파일</h3>
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
                    <button className="ragUploadButton" type="button" onClick={() => ragFileInputRef.current?.click()}>
                      <Plus size={16} />
                      GEO/RAG 파일 첨부
                    </button>
                    <div className="ragFileList">
                      {ragProfileSettings.files.length === 0 ? (
                        <div className="settingsCard">
                          <strong>첨부된 파일이 없습니다</strong>
                          <p>Schema BestPractice, E-E-A-T, CEP, 카테고리 문서, 브랜드 가이드 같은 md/txt/json/csv 파일을 첨부할 수 있습니다.</p>
                        </div>
                      ) : (
                        ragProfileSettings.files.map((file) => (
                          <article className="ragFileItem" key={file.id}>
                            <FileText size={16} />
                            <div>
                              <strong>{file.name}</strong>
                              <span>
                                {file.managed ? "패키지 관리" : "사용자 첨부"} · {file.version} · {formatFileSize(file.size)} · {file.content.length.toLocaleString()}자 · {formatDate(file.addedAt)}
                              </span>
                            </div>
                            <button type="button" aria-label={`${file.name} 편집`} onClick={() => setSelectedRagFileId(file.id)}>
                              편집
                            </button>
                            {!file.managed && (
                              <button type="button" aria-label={`${file.name} 제거`} onClick={() => removeRagFile(file.id)}>
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
                      <h3>RAG 파일 내용</h3>
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

                  <section className="settingsSection">
                    <h3>적용 범위</h3>
                    <div className="settingsCard">
                      <strong>RAG chunk 생성</strong>
                      <p>저장한 분석 프롬프트와 첨부 파일은 다음 추출부터 RAG chunk에 포함되어 downstream GEO 스키마 생성/검수 에이전트가 참조할 수 있는 근거 데이터로 전달됩니다.</p>
                    </div>
                  </section>

                  <div className="settingsActions">
                    <button
                      type="button"
                      onClick={() => {
                        void resetRagProfileSettings();
                      }}
                    >
                      초기화
                    </button>
                    <button
                      className="primary"
                      type="button"
                      onClick={() => {
                        void saveRagProfileSettings();
                      }}
                    >
                      RAG 프로필 저장
                    </button>
                  </div>
                </>
              )}
            </section>
          </div>
        </div>
      )}
    </main>
  );
}

function StatusDot({ status }: { status: QueueStatus }) {
  if (status === "running") {
    return <Loader2 className="spin statusIcon running" size={13} />;
  }
  if (status === "done") {
    return <CheckCircle2 className="statusIcon done" size={13} />;
  }
  return <Circle className={`statusIcon ${status}`} size={13} />;
}

function DiagnosticLog({ diagnostics }: Readonly<{ diagnostics?: ProductExtractionDiagnostics }>) {
  if (!diagnostics) {
    return <strong>아직 분리된 실행 로그가 없습니다</strong>;
  }

  return (
    <div className="diagnosticLog">
      <div className="diagnosticStats">
        <span>process {diagnostics.process.length}</span>
        <span>warnings {diagnostics.warnings.length}</span>
        <span>evidence {diagnostics.evidence.length}</span>
      </div>
      <div className="diagnosticSection">
        <strong>Process</strong>
        {diagnostics.process.map((step) => (
          <p key={step.id}>
            <b>{step.title}</b>
            <span>{step.message ?? step.description}</span>
          </p>
        ))}
      </div>
      <div className="diagnosticSection">
        <strong>Warnings</strong>
        {diagnostics.warnings.length === 0 ? (
          <p>경고가 없습니다.</p>
        ) : (
          diagnostics.warnings.map((warning) => (
            <p key={`${warning.code}-${warning.message}`}>
              <b>{warning.code}</b>
              <span>{warning.message}</span>
            </p>
          ))
        )}
      </div>
      <div className="diagnosticSection">
        <strong>Evidence</strong>
        {diagnostics.evidence.length === 0 ? (
          <p>근거 로그가 없습니다.</p>
        ) : (
          diagnostics.evidence.slice(0, 8).map((item) => (
            <p key={`${item.field}-${item.source}-${item.value.slice(0, 20)}`}>
              <b>{item.field} · {item.source}</b>
              <span>{item.value}</span>
            </p>
          ))
        )}
      </div>
    </div>
  );
}

function StepStatusIcon({ status }: { status: AgentStepStatus }) {
  if (status === "running") {
    return <Loader2 className="spin processIcon running" size={14} />;
  }
  if (status === "done") {
    return <CheckCircle2 className="processIcon done" size={14} />;
  }
  if (status === "error") {
    return <AlertCircle className="processIcon error" size={14} />;
  }
  return <Circle className="processIcon pending" size={14} />;
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

function ModelSelectField({
  label,
  message,
  onChange,
  onRefresh,
  options,
  placeholder,
  status,
  value
}: Readonly<{
  label: string;
  message: string;
  onChange: (value: string) => void;
  onRefresh: () => void;
  options: string[];
  placeholder: string;
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
          {status === "loading" ? "불러오는 중" : "목록 불러오기"}
        </button>
        <small className={status === "error" ? "error" : ""}>{message}</small>
      </div>
    </label>
  );
}

interface RagProfileApiPayload {
  profile: string;
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

async function requestRagProfile(): Promise<RagProfileSettings> {
  const response = await fetch("/api/rag-profile", { cache: "no-store" });
  const payload = await response.json() as RagProfileApiPayload | { error?: string };

  if (!response.ok) {
    throw new Error("error" in payload && payload.error ? payload.error : `RAG profile load failed: ${response.status}`);
  }

  return toRagProfileSettings(payload as RagProfileApiPayload);
}

async function writeRagProfile(settings: RagProfileSettings): Promise<RagProfileSettings> {
  const response = await fetch("/api/rag-profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      analysisPrompt: settings.analysisPrompt,
      documents: settings.files.map((file) => ({
        name: file.name,
        version: file.version,
        content: file.content
      }))
    })
  });
  const payload = await response.json() as RagProfileApiPayload | { error?: string };

  if (!response.ok) {
    throw new Error("error" in payload && payload.error ? payload.error : `RAG profile save failed: ${response.status}`);
  }

  return toRagProfileSettings(payload as RagProfileApiPayload);
}

async function resetPackageRagProfile(): Promise<RagProfileSettings> {
  const response = await fetch("/api/rag-profile", { method: "DELETE" });
  const payload = await response.json() as RagProfileApiPayload | { error?: string };

  if (!response.ok) {
    throw new Error("error" in payload && payload.error ? payload.error : `RAG profile reset failed: ${response.status}`);
  }

  return toRagProfileSettings(payload as RagProfileApiPayload);
}

function toRagProfileSettings(payload: RagProfileApiPayload): RagProfileSettings {
  return {
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

async function requestExtraction(
  sources: string[],
  providerSettings: ProviderSettings,
  restApiSettings: RestApiSettings,
  ragProfileSettings: RagProfileSettings
): Promise<ExtractionRequestResult> {
  const externalApiUrl = process.env.NEXT_PUBLIC_AGENTIC_GEO_API_URL;
  const isStaticExport = process.env.NEXT_PUBLIC_DEPLOY_TARGET === "github-pages";
  const llm = createRuntimeLlmConfig(providerSettings);
  const rag = createRuntimeRagConfig(ragProfileSettings);
  const headers = parseHeadersJson(restApiSettings.headersJson);
  const sourceGroups = groupSourcesByType(sources, restApiSettings.sourceMode);

  if (!validateProviderSettings(providerSettings)) {
    throw new Error(getProviderValidationMessage(providerSettings) ?? "AI provider 설정을 확인해주세요.");
  }

  if (!externalApiUrl) {
    if (isStaticExport) {
      if (llm.provider !== "mock" || restApiSettings.sourceMode === "restApi") {
        throw new Error("정적 배포에서는 NEXT_PUBLIC_AGENTIC_GEO_API_URL이 필요합니다. 로컬 서버 또는 외부 extraction API를 연결해주세요.");
      }
      const runs = await runMockProductExtraction(sources);
      return {
        results: appendRuntimeRagChunks(runs.map(({ result, diagnostics }) => ({ ...result, diagnostics })), rag),
        failures: []
      };
    }

    return requestExtractionGroups("/api/extract", sourceGroups, headers, llm, rag);
  }

  return requestExtractionGroups(`${externalApiUrl.replace(/\/$/, "")}/extract`, sourceGroups, headers, llm, rag);
}

async function requestExtractionGroups(
  endpoint: string,
  groups: Array<{ sourceType: "url" | "restApi"; sources: string[] }>,
  headers: Record<string, string>,
  llm: RuntimeLlmConfig,
  rag: RuntimeRagConfig
): Promise<ExtractionRequestResult> {
  const results: DisplayExtractionResult[] = [];
  const failures: DisplayExtractionFailure[] = [];

  for (const group of groups) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sources: group.sources,
        sourceType: group.sourceType,
        headers: headersForSourceType(headers, group.sourceType),
        llm,
        rag
      })
    });

    const payload = await response.json() as {
      results?: ProductExtractionResult[];
      logs?: ProductExtractionDiagnostics[];
      failures?: Array<{
        source: string;
        sourceType: "url" | "restApi";
        error: string;
      }>;
      error?: string;
    };

    if (!response.ok) {
      throw new Error(payload.error ?? `Extraction API failed: ${response.status}`);
    }

    const logsBySource = new Map((payload.logs ?? []).map((log) => [log.source, log]));
    results.push(...(payload.results ?? []).map((result) => ({ ...result, diagnostics: logsBySource.get(result.source) })));
    failures.push(...(payload.failures ?? []).map((failure) => ({
      ...failure,
      diagnostics: logsBySource.get(failure.source)
    })));
  }

  return { results, failures };
}

function headersForSourceType(headers: Record<string, string>, sourceType: "url" | "restApi"): Record<string, string> {
  if (sourceType === "restApi") {
    return headers;
  }

  const next = { ...headers };
  const acceptKey = Object.keys(next).find((key) => key.toLowerCase() === "accept");

  if (acceptKey && !/(text\/html|application\/xhtml\+xml|\*\/\*)/i.test(next[acceptKey] ?? "")) {
    delete next[acceptKey];
  }

  return next;
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
    throw new Error([payload.message ?? `Provider validation failed: ${response.status}`, payload.details].filter(Boolean).join(" "));
  }

  return {
    message: payload.message ?? `${providerLabels[settings.provider]} 연결이 확인되었습니다.`,
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
    return {
      provider: "azure-openai",
      apiKey: normalizeSecretInput(settings.azureApiKey),
      endpoint: settings.azureEndpoint.trim(),
      deployment: settings.azureDeployment.trim(),
      apiVersion: settings.azureApiVersion.trim()
    };
  }

  return { provider: "mock" };
}

function createRuntimeRagConfig(settings: RagProfileSettings): RuntimeRagConfig {
  return {
    analysisPrompt: settings.analysisPrompt.trim(),
    documents: settings.files.map((file) => ({
      name: file.name,
      content: file.content
    }))
  };
}

function appendRuntimeRagChunks(results: DisplayExtractionResult[], rag: RuntimeRagConfig): DisplayExtractionResult[] {
  const runtimeChunks = createRuntimeRagChunks(rag);

  if (runtimeChunks.length === 0) {
    return results;
  }

  return results.map((result) => ({
    ...result,
    geoProduct: {
      ...result.geoProduct,
      rag: {
        chunks: [
          ...result.geoProduct.rag.chunks,
          ...runtimeChunks
        ]
      }
    }
  }));
}

function toPublicResult(result: DisplayExtractionResult): ProductExtractionResult {
  return {
    source: result.source,
    sourceType: result.sourceType,
    geoProduct: result.geoProduct,
    generatedAt: result.generatedAt,
    ragProfile: result.ragProfile
  };
}

function createRuntimeRagChunks(rag: RuntimeRagConfig): ProductExtractionResult["geoProduct"]["rag"]["chunks"] {
  const chunks: ProductExtractionResult["geoProduct"]["rag"]["chunks"] = [];

  if (rag.analysisPrompt) {
    chunks.push({
      id: "rag-profile-analysis-prompt",
      kind: "source",
      text: rag.analysisPrompt
    });
  }

  for (const [index, document] of (rag.documents ?? []).entries()) {
    chunks.push({
      id: `rag-profile-file-${index + 1}`,
      kind: "source",
      text: document.content.slice(0, 12000)
    });
  }

  return chunks;
}

function parseHeadersJson(value: string): Record<string, string> {
  const trimmed = value.trim();

  if (!trimmed) {
    return {};
  }

  const parsed = JSON.parse(trimmed) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("요청 헤더는 JSON object 형식이어야 합니다.");
  }

  return Object.fromEntries(
    Object.entries(parsed).map(([key, headerValue]) => [key, String(headerValue)])
  );
}

function groupSourcesByType(sources: string[], mode: SourceMode): Array<{ sourceType: "url" | "restApi"; sources: string[] }> {
  const groups = new Map<"url" | "restApi", string[]>();

  for (const source of sources) {
    const sourceType = mode === "auto" ? inferSourceType(source) : mode;
    groups.set(sourceType, [...groups.get(sourceType) ?? [], source]);
  }

  return Array.from(groups.entries()).map(([sourceType, groupedSources]) => ({
    sourceType,
    sources: groupedSources
  }));
}

function inferSourceType(source: string): "url" | "restApi" {
  try {
    const url = new URL(source);
    const path = url.pathname.toLowerCase();
    return path.includes("/api/") || path.endsWith(".json") ? "restApi" : "url";
  } catch {
    return "url";
  }
}

function sourceModeLabel(mode: SourceMode): string {
  if (mode === "auto") {
    return "자동 감지";
  }
  if (mode === "restApi") {
    return "REST API";
  }
  return "상품 URL";
}

function getComposerPlaceholder(mode: SourceMode): string {
  if (mode === "restApi") {
    return "상품 데이터 API 주소를 입력하세요";
  }

  return "상품 페이지 주소를 입력하세요. 여러 개는 줄바꿈으로 추가할 수 있어요";
}

function normalizeSecretInput(value: string): string {
  const withoutExport = value.trim().replace(/^export\s+/i, "");
  const assignment = withoutExport.match(/^[A-Z0-9_]+\s*=\s*(.+)$/i);
  const rawValue = assignment?.[1] ?? withoutExport;

  return rawValue.trim().replace(/^["']|["']$/g, "");
}

function connectionStatusLabel(status: ConnectionStatus): string {
  if (status === "checking") {
    return "확인 중";
  }
  if (status === "connected") {
    return "정상";
  }
  if (status === "error") {
    return "확인 필요";
  }
  return "미연동";
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

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
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

function validateProviderSettings(settings: ProviderSettings): boolean {
  return getProviderValidationMessage(settings) === undefined;
}

function isAuthorizedAiSettings(settings: ProviderSettings): boolean {
  return settings.provider !== "mock" && validateProviderSettings(settings);
}

function getProviderValidationMessage(settings: ProviderSettings): string | undefined {
  const credentialMessage = getProviderCredentialValidationMessage(settings);

  if (credentialMessage) {
    return credentialMessage;
  }

  if (settings.provider === "openai" && settings.openaiModel.trim().length === 0) {
    return "OpenAI 모델을 선택해주세요.";
  }

  if (settings.provider === "gemini" && settings.geminiModel.trim().length === 0) {
    return "Gemini 모델을 선택해주세요.";
  }

  if (settings.provider === "azure-openai" && settings.azureDeployment.trim().length === 0) {
    return "Azure Deployment를 선택해주세요.";
  }

  return undefined;
}

function getProviderCredentialValidationMessage(settings: ProviderSettings): string | undefined {
  if (settings.provider === "mock") {
    return "실제 AI 연동을 위해 OpenAI, Gemini, Azure OpenAI 중 하나를 선택해주세요.";
  }

  if (settings.provider === "openai" && normalizeSecretInput(settings.openaiApiKey).length === 0) {
    return "OpenAI API Key를 입력해주세요.";
  }

  if (settings.provider === "gemini" && normalizeSecretInput(settings.geminiApiKey).length === 0) {
    return "Gemini API Key를 입력해주세요.";
  }

  if (settings.provider === "azure-openai") {
    if (normalizeSecretInput(settings.azureApiKey).length === 0) {
      return "Azure API Key를 입력해주세요.";
    }
    if (settings.azureEndpoint.trim().length === 0) {
      return "Azure Endpoint를 입력해주세요.";
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
    return settings.azureDeployment.trim();
  }
  return "";
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

function readStoredRestApiSettings(): RestApiSettings {
  if (typeof window === "undefined") {
    return defaultRestApiSettings;
  }

  try {
    const rawSettings = window.localStorage.getItem(REST_SETTINGS_STORAGE_KEY);

    if (!rawSettings) {
      return defaultRestApiSettings;
    }

    return {
      ...defaultRestApiSettings,
      ...JSON.parse(rawSettings) as Partial<RestApiSettings>
    };
  } catch {
    return defaultRestApiSettings;
  }
}

function readStoredRagProfileSettings(): RagProfileSettings {
  if (typeof window === "undefined") {
    return defaultRagProfileSettings;
  }

  try {
    const rawSettings = window.localStorage.getItem(RAG_SETTINGS_STORAGE_KEY);

    if (!rawSettings) {
      return defaultRagProfileSettings;
    }

    const parsed = {
      ...defaultRagProfileSettings,
      ...JSON.parse(rawSettings) as Partial<RagProfileSettings>
    };

    return {
      ...parsed,
      files: (parsed.files ?? []).map((file) => ({
        ...file,
        id: file.id ?? createId(),
        version: file.version ?? extractRagFileVersion(file.name),
        size: file.size ?? new TextEncoder().encode(file.content).length,
        type: file.type ?? inferRagFileType(file.name),
        addedAt: file.addedAt ?? new Date().toISOString()
      }))
    };
  } catch {
    return defaultRagProfileSettings;
  }
}

function readStoredHistoryQueue(): QueueItem[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const rawHistory = window.sessionStorage.getItem(HISTORY_STORAGE_KEY);

    if (!rawHistory) {
      return [];
    }

    const parsed = JSON.parse(rawHistory) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map(normalizeStoredQueueItem)
      .filter((item): item is QueueItem => Boolean(item))
      .slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function normalizeStoredQueueItem(value: unknown): QueueItem | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const item = value as Partial<QueueItem>;

  if (typeof item.source !== "string") {
    return undefined;
  }

  const source = cleanSource(item.source);

  if (source.length === 0) {
    return undefined;
  }

  const now = new Date().toISOString();
  const generatedAt = item.result && "generatedAt" in item.result ? item.result.generatedAt : undefined;
  const createdAt = normalizeStoredDate(item.createdAt) ?? normalizeStoredDate(generatedAt) ?? now;
  const updatedAt = normalizeStoredDate(item.updatedAt) ?? createdAt;
  const storedStatus = isQueueStatus(item.status) ? item.status : item.result ? "done" : item.error ? "error" : "idle";
  const status = storedStatus === "running" ? "idle" : storedStatus;

  return {
    id: typeof item.id === "string" && item.id.length > 0 ? item.id : createId(),
    source,
    status,
    createdAt,
    updatedAt,
    result: item.result,
    diagnostics: item.diagnostics ?? item.result?.diagnostics,
    error: typeof item.error === "string" ? item.error : undefined
  };
}

function normalizeStoredDate(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const timestamp = Date.parse(value);

  if (Number.isNaN(timestamp)) {
    return undefined;
  }

  return new Date(timestamp).toISOString();
}

function isQueueStatus(value: unknown): value is QueueStatus {
  return value === "idle" || value === "running" || value === "done" || value === "error";
}

function parseSources(value: string): string[] {
  return Array.from(
    new Set(
      (value.match(/https?:\/\/[^\s"'`<>{}|\\^]+/g) ?? [])
        .map(cleanSource)
        .filter(Boolean)
    )
  );
}

function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function findInvalidUrlTokens(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\s\n\t]+/)
        .map((token) => token.trim().replace(/[),.;\]}]+$/g, ""))
        .filter((token) => looksLikeUrlToken(token) && cleanSource(token).length === 0)
    )
  );
}

function looksLikeUrlToken(value: string): boolean {
  return /^(https?:\/\/|[a-z][a-z0-9+.-]*:\/\/|www\.)/i.test(value) || /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?$/i.test(value);
}

function isGeoRawEditInstruction(value: string): boolean {
  if (/\{[\s\S]*\}/.test(value)) {
    return true;
  }

  const fieldPattern = /(geo\s*raw|geoproduct|json|상품명|가격|설명|효능|효과|성분|고객\s*리뷰|리뷰|수치|옵션|이미지|키워드|ocr|rag|faq|metric|metrics|ingredient|ingredients|benefit|benefits|effect|effects|usage|review|rating|price|description|keyword|keywords)/i;
  const actionPattern = /(수정|변경|추가|삭제|반영|넣어|넣어줘|제거|업데이트|고쳐|바꿔|정리|보완|add|update|remove|replace|set|merge|append)/i;

  return fieldPattern.test(value) && actionPattern.test(value);
}

function cleanSource(source: string): string {
  const cleaned = source.trim().replace(/[),.;\]}]+$/g, "");

  try {
    const url = new URL(cleaned);
    return url.hostname && (url.protocol === "http:" || url.protocol === "https:") ? url.href : "";
  } catch {
    return "";
  }
}

function matchesSearch(values: string[], query: string): boolean {
  return values.some((value) => value.toLowerCase().includes(query));
}

function getStepStatus(stepId: AgentStepId, process: AgentProcessState): AgentStepStatus {
  const stepIndex = agentSteps.findIndex((step) => step.id === stepId);
  const currentIndex = agentSteps.findIndex((step) => step.id === process.currentStepId);

  if (process.status === "done") {
    return "done";
  }

  if (process.status === "error") {
    if (stepIndex < currentIndex) {
      return "done";
    }
    return stepIndex === currentIndex ? "error" : "pending";
  }

  if (process.status === "running") {
    if (stepIndex < currentIndex) {
      return "done";
    }
    return stepIndex === currentIndex ? "running" : "pending";
  }

  return "pending";
}

function isAgentStepStatus(value: unknown): value is AgentStepStatus {
  return value === "pending" || value === "running" || value === "done" || value === "error";
}

function formatProcessProgress(process: AgentProcessState): string {
  if (process.sourceCount <= 1) {
    return "";
  }

  const fallbackCompleted = process.status === "done" || process.status === "error" ? process.sourceCount : 0;
  const completed = Math.min(process.completedSourceCount ?? fallbackCompleted, process.sourceCount);

  return `${completed} / ${process.sourceCount}`;
}

function processStatusLabel(status: AgentProcessStatus): string {
  if (status === "running") {
    return "실행 중";
  }
  if (status === "done") {
    return "완료";
  }
  if (status === "error") {
    return "오류";
  }
  return "대기";
}

function formatHistoryTime(value: string): string {
  const timestamp = Date.parse(value);

  if (Number.isNaN(timestamp)) {
    return "";
  }

  const diffMs = Math.max(0, Date.now() - timestamp);
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  if (diffMs < minuteMs) {
    return "지금";
  }

  if (diffMs < hourMs) {
    return `${Math.floor(diffMs / minuteMs)}분`;
  }

  if (diffMs < dayMs) {
    return `${Math.floor(diffMs / hourMs)}시간`;
  }

  const days = Math.floor(diffMs / dayMs);

  if (days < 30) {
    return `${days}일`;
  }

  if (days < 365) {
    return `${Math.floor(days / 30)}개월`;
  }

  return `${Math.floor(days / 365)}년`;
}

async function waitForStep(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 110));
}

function shortUrl(source: string): string {
  try {
    return new URL(source).pathname.split("/").filter(Boolean).at(-1) ?? source;
  } catch {
    return source;
  }
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `item-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
