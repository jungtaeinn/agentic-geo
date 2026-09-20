"""Structural public contracts for evaluator, probe, and benchmark callers.

These are deliberately local contracts rather than imports from the extractor
or generator packages.  They mirror the TypeScript evaluator's structural
interfaces so an application can pass compatible dictionaries without making
the agent packages depend on one another.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Literal, NotRequired, TypedDict

type GeoEvalProvider = Literal["openai", "gemini", "azure-openai", "aistudio"]
type EvalUiLanguage = Literal["ko", "en"]
type EvalProductId = Literal[
    "fieldnote-arcwell-night-serum",
    "fieldnote-daybreak-first-essence",
    "byeolmorae-waterfold-toner",
    "byeolmorae-cloudveil-mist",
]
type GeoCepFocus = Literal["need", "routine", "selection", "concern"]
type CitationProbeQuerySource = Literal["content-plan-faq", "content-plan-cep", "template"]
type CitationSupportLevel = Literal["full_support", "partial_support", "no_support"]
type KeypointLabel = Literal["Supported", "Omitted", "Contradicted"]
type GeoQualityDimensionId = Literal["geo", "cep", "eeat"]


class EvalEvidenceItem(TypedDict):
    id: str
    role: str
    text: str


class EvalContentSections(TypedDict):
    productName: str
    description: str
    quickFacts: str
    benefits: str
    ingredients: str
    howToUse: str
    faq: str


class EvalContentPlanDescription(TypedDict):
    include: bool
    evidenceIds: list[str]


class EvalContentPlanFaq(TypedDict):
    include: bool
    question: str
    evidenceIds: NotRequired[list[str]]


class EvalContentPlanHowToStep(TypedDict):
    evidenceIds: NotRequired[list[str]]


class EvalContentPlanHowTo(TypedDict):
    eligible: bool
    steps: list[EvalContentPlanHowToStep]


class EvalContentPlanCep(TypedDict):
    situation: str
    need: str
    constraint: NotRequired[str]
    evidenceIds: NotRequired[list[str]]


class EvalContentPlanInput(TypedDict):
    faq: list[EvalContentPlanFaq]
    cep: list[EvalContentPlanCep]
    mode: NotRequired[str]
    productDescription: NotRequired[EvalContentPlanDescription]
    webPageDescription: NotRequired[EvalContentPlanDescription]
    howTo: NotRequired[EvalContentPlanHowTo]


class EvalBreadcrumb(TypedDict):
    name: NotRequired[str]
    url: NotRequired[str]


class EvalFaqItem(TypedDict):
    question: str
    answer: str


class EvalReviews(TypedDict):
    keywords: NotRequired[list[str]]


class EvalNormalizedProduct(TypedDict):
    name: NotRequired[str]
    brand: NotRequired[str]
    category: NotRequired[str]
    images: NotRequired[list[object]]
    breadcrumbs: NotRequired[list[EvalBreadcrumb]]
    benefits: NotRequired[list[str]]
    effects: NotRequired[list[str]]
    ingredients: NotRequired[list[str]]
    usage: NotRequired[list[str]]
    faq: NotRequired[list[EvalFaqItem]]
    reviews: NotRequired[EvalReviews]
    sourceTexts: NotRequired[list[str]]


class EvalRagUsageReference(TypedDict):
    kind: NotRequired[str]
    fieldTargets: NotRequired[list[str]]


class EvalRagUsageItem(TypedDict):
    principle: str
    references: list[EvalRagUsageReference]
    enabled: NotRequired[bool]


class EvalEvidenceRecord(TypedDict):
    field: str
    source: str
    value: str


class EvalValidationRepair(TypedDict):
    field: str
    source: NotRequired[str]
    issue: NotRequired[str]
    action: NotRequired[str]


class EvalDiagnosticsInput(TypedDict):
    normalizedProduct: EvalNormalizedProduct
    validationWarnings: list[str]
    validationRepairs: NotRequired[list[EvalValidationRepair]]
    ragUsage: NotRequired[list[EvalRagUsageItem]]
    evidence: NotRequired[list[EvalEvidenceRecord]]
    evidenceLedger: NotRequired[list[EvalEvidenceItem]]
    contentPlan: NotRequired[EvalContentPlanInput]


class GeoQualityEvalInput(TypedDict):
    jsonLd: object
    diagnostics: EvalDiagnosticsInput


class ImageProvenanceSentence(TypedDict):
    text: str
    imageUrls: NotRequired[list[str]]


class ImageProvenanceEntry(TypedDict):
    fieldPath: str
    text: NotRequired[str]
    imageUrls: NotRequired[list[str]]
    sentences: NotRequired[list[ImageProvenanceSentence]]


class UtilityGateInput(TypedDict):
    visibilityDelta: NotRequired[float]
    keypointCoverage: NotRequired[object]
    citationQuality: NotRequired[object]


class QualityPromptContext(TypedDict):
    productName: str
    contentSections: EvalContentSections
    jsonLd: object


class ProbePromptContext(TypedDict):
    productName: str
    contentSections: EvalContentSections


class GeoEvalEngineConfig(TypedDict):
    provider: GeoEvalProvider
    apiKey: str
    model: NotRequired[str]
    deployment: NotRequired[str]
    endpoint: NotRequired[str]
    apiVersion: NotRequired[str]
    temperature: NotRequired[float]
    maxRetries: NotRequired[int]
    retryDelayMs: NotRequired[int]
    timeoutMs: NotRequired[int]


class GeoEvalEngineAnswer(TypedDict):
    answer: str
    engineId: str


class CitationProbeShare(TypedDict):
    wordpos: float
    word: float
    pos: float


class CitationProbeQueryResult(TypedDict):
    query: str
    querySource: CitationProbeQuerySource
    vanilla: CitationProbeShare
    generated: CitationProbeShare
    delta: CitationProbeShare
    hallucinatedCitations: list[int]
    sectionAttribution: NotRequired[list[dict[str, object]]]
    imageAttribution: NotRequired[list[dict[str, object]]]


class CitationProbeMean(TypedDict):
    vanilla: CitationProbeShare
    generated: CitationProbeShare
    delta: CitationProbeShare


class CitationProbeResult(TypedDict):
    engineId: str
    probedAt: str
    queries: list[CitationProbeQueryResult]
    mean: CitationProbeMean
    gate: dict[str, object]
    warnings: list[str]
    interpretation: str
    keypointCoverage: NotRequired[dict[str, object]]
    sectionAttribution: NotRequired[list[dict[str, object]]]
    imageAttribution: NotRequired[list[dict[str, object]]]


class CitationProbeContext(TypedDict):
    generatedText: str
    vanillaText: str
    locale: str
    category: NotRequired[str]
    brand: NotRequired[str]
    productName: NotRequired[str]
    benefits: NotRequired[list[str]]
    contentPlan: NotRequired[EvalContentPlanInput]
    evidenceLedger: NotRequired[list[EvalEvidenceItem]]
    queries: NotRequired[list[str]]
    generatedSections: NotRequired[list[dict[str, str]]]
    imageSections: NotRequired[list[dict[str, str]]]


class CitationProbeOptions(TypedDict):
    engine: GeoEvalEngineConfig
    judge: NotRequired[GeoEvalEngineConfig]
    maxQueries: NotRequired[int]
    includeUtility: NotRequired[bool]


class GeneratedProductArtifact(TypedDict):
    publicText: str
    evidenceLedger: list[EvalEvidenceItem]


class GeoEvalVariantScore(TypedDict):
    wordpos: float
    word: float
    pos: float
    citedSentenceCount: int
    sentenceCount: int
    hallucinatedCitations: list[int]
    cachedAnswer: bool


class GeoEvalShareAggregate(TypedDict):
    wordpos: float
    word: float
    pos: float


class GeoEvalGoldenUtility(TypedDict):
    keypointCoverage: NotRequired[dict[str, object]]
    citationQuality: NotRequired[dict[str, object]]


class GeoEvalGoldenResult(TypedDict):
    goldenId: str
    productId: EvalProductId
    locale: str
    cepFocus: str
    query: str
    vanilla: GeoEvalVariantScore
    generated: GeoEvalVariantScore
    delta: GeoEvalShareAggregate
    gate: dict[str, object]
    utility: NotRequired[GeoEvalGoldenUtility]


class GeoEvalLocaleAggregate(TypedDict):
    goldens: int
    vanilla: GeoEvalShareAggregate
    generated: GeoEvalShareAggregate
    delta: GeoEvalShareAggregate


class GeoEvalCepFocusAggregate(TypedDict):
    goldens: int
    delta: GeoEvalShareAggregate


class GeoEvalAggregateGate(TypedDict):
    evaluated: int
    passed: int


class GeoEvalAggregateUtility(TypedDict):
    meanKpr: float | None
    meanKpc: float | None
    meanCitationPrecision: float | None
    meanCitationRecall: float | None


class GeoEvalAggregates(TypedDict):
    goldens: int
    engineId: str
    vanilla: GeoEvalShareAggregate
    generated: GeoEvalShareAggregate
    delta: GeoEvalShareAggregate
    byLocale: dict[str, GeoEvalLocaleAggregate]
    byCepFocus: dict[str, GeoEvalCepFocusAggregate]
    gate: GeoEvalAggregateGate
    utility: NotRequired[GeoEvalAggregateUtility]


class GeoEvalGolden(TypedDict):
    id: str
    productId: EvalProductId
    locale: Literal["en-US", "ko-KR"]
    market: Literal["US", "KR"]
    query: str
    cepFocus: GeoCepFocus


class GeoEvalRunOptions(TypedDict):
    engine: GeoEvalEngineConfig
    artifacts: dict[EvalProductId, GeneratedProductArtifact]
    judge: NotRequired[GeoEvalEngineConfig]
    includeUtility: NotRequired[bool]
    goldenIds: NotRequired[list[str]]
    cacheDir: NotRequired[str]
    useCache: NotRequired[bool]
    onProgress: NotRequired[Callable[[str], None]]


class GeoEvalRunResult(TypedDict):
    engineId: str
    scores: list[GeoEvalGoldenResult]
    aggregates: GeoEvalAggregates


__all__ = [
    "CitationProbeContext",
    "CitationProbeOptions",
    "CitationProbeQueryResult",
    "CitationProbeQuerySource",
    "CitationProbeResult",
    "CitationProbeShare",
    "EvalContentPlanInput",
    "EvalContentSections",
    "EvalDiagnosticsInput",
    "EvalEvidenceItem",
    "EvalEvidenceRecord",
    "EvalNormalizedProduct",
    "EvalProductId",
    "EvalRagUsageItem",
    "EvalUiLanguage",
    "EvalValidationRepair",
    "GeneratedProductArtifact",
    "GeoCepFocus",
    "GeoEvalAggregates",
    "GeoEvalEngineAnswer",
    "GeoEvalEngineConfig",
    "GeoEvalGolden",
    "GeoEvalGoldenResult",
    "GeoEvalProvider",
    "GeoEvalRunOptions",
    "GeoEvalRunResult",
    "GeoEvalShareAggregate",
    "GeoEvalVariantScore",
    "GeoQualityEvalInput",
]
