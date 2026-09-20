"""Public input and run models for the PDP extraction contract."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from ._json_types import as_list, as_mapping


def _wire_object_list() -> list[dict[str, Any]]:
    return []


class _WireModel(BaseModel):
    """Match Zod's permissive input and JavaScript's absent-field omission."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True, serialize_by_alias=True)


class ProductExtractionInput(_WireModel):
    """A URL or REST-API source accepted by the extraction pipeline."""

    source_type: Literal["url", "restApi"] = Field(alias="sourceType")
    source: str
    headers: dict[str, str] | None = None
    ai_provider: Literal["mock", "openai", "gemini", "azure-openai", "aistudio"] = Field(
        default="mock", alias="aiProvider"
    )


class ProductExtractionRun(_WireModel):
    """The artifact plus diagnostics returned by the legacy extractor."""

    result: dict[str, Any]
    diagnostics: dict[str, Any]

    def to_wire(self) -> dict[str, Any]:
        return _omit_none(self.model_dump(by_alias=True, exclude_none=True))


class AzureRoleDeployments(_WireModel):
    """Azure deployment IDs independently assigned to OCR, reasoning, and embeddings."""

    ocr: str | None = None
    reasoning: str | None = None
    embedding: str | None = None


class EmbeddingRuntimeConfig(_WireModel):
    """Optional remote embedding configuration used by extractor RAG retrieval."""

    provider: Literal["local", "azure-openai", "aistudio"] | None = None
    api_key: str | None = Field(default=None, alias="apiKey")
    endpoint: str | None = None
    deployment: str | None = None
    api_version: str | None = Field(default=None, alias="apiVersion")
    model: str | None = None


class RerankerRuntimeConfig(_WireModel):
    """Optional post-retrieval reranker configuration."""

    provider: Literal["local-hybrid", "cohere", "azure-ai-search-semantic", "aistudio-bedrock-cohere"] | None = None
    api_key: str | None = Field(default=None, alias="apiKey")
    endpoint: str | None = None
    model: str | None = None
    index_name: str | None = Field(default=None, alias="indexName")
    semantic_configuration: str | None = Field(default=None, alias="semanticConfiguration")
    query_language: str | None = Field(default=None, alias="queryLanguage")


class LlmProviderConfig(_WireModel):
    """Provider-neutral model runtime settings shared by adapter factories."""

    provider: Literal["mock", "openai", "gemini", "azure-openai", "aistudio"] = "mock"
    api_key: str | None = Field(default=None, alias="apiKey")
    model: str | None = None
    endpoint: str | None = None
    deployment: str | None = None
    deployments: AzureRoleDeployments | None = None
    api_version: str | None = Field(default=None, alias="apiVersion")
    temperature: float | None = None
    timeout_seconds: float | None = Field(default=None, alias="timeoutSeconds")
    embedding: EmbeddingRuntimeConfig | None = None
    reranker: RerankerRuntimeConfig | None = None


class KeywordClassificationRequest(_WireModel):
    """Stable provider input for OCR/long-scroll evidence classification."""

    source: str = ""
    product_name: str | None = Field(default=None, alias="productName")
    analysis_prompt: str | None = Field(default=None, alias="analysisPrompt")
    rag_documents: list[dict[str, Any]] = Field(default_factory=_wire_object_list, alias="ragDocuments")
    image_texts: list[dict[str, Any]] = Field(default_factory=_wire_object_list, alias="imageTexts")


class ImageTextExtractionRequest(_WireModel):
    """Stable vision-OCR input, including prepared tall-image slices when present."""

    source: str = ""
    product_name: str | None = Field(default=None, alias="productName")
    image_urls: list[str] = Field(default_factory=list, alias="imageUrls")
    image_inputs: list[dict[str, str]] | None = Field(default=None, alias="imageInputs")


class ProductExtractorRagDocument(_WireModel):
    """A managed or custom policy document attached to extractor retrieval."""

    name: str
    version: str = "v1"
    content: str


class ProductExtractorRagProfile(_WireModel):
    """Portable profile DTO shared by UI, REST, and package-resource readers."""

    profile: str
    analysis_prompt: str = Field(alias="analysisPrompt")
    documents: list[ProductExtractorRagDocument]


class StoredProductExtractorRagDocument(ProductExtractorRagDocument):
    """Profile document enriched with storage metadata when it is available."""

    managed: bool = False
    path: str = ""
    size: int = 0
    updated_at: str | None = Field(default=None, alias="updatedAt")


class StoredProductExtractorRagProfile(_WireModel):
    profile: str
    analysis_prompt: str = Field(alias="analysisPrompt")
    documents: list[StoredProductExtractorRagDocument]
    updated_at: str | None = Field(default=None, alias="updatedAt")


def _omit_none(value: Any) -> Any:
    mapping = as_mapping(value)
    if mapping is not None:
        return {key: _omit_none(child) for key, child in mapping.items() if child is not None}
    items = as_list(value)
    if items is not None:
        return [_omit_none(child) for child in items]
    return value
