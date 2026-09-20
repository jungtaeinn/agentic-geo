"""Wire models for the PDP GEO generator.

The Node package deliberately accepts arbitrary product JSON and returns plain
JSON-compatible objects.  These models validate only the control plane while
leaving ``product`` permissive, matching the Zod ``unknown`` input contract.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Annotated, Any, Literal, cast
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

PdpGeoSchemaTarget = Literal["WebPage", "Product", "FAQPage", "HowTo", "BreadcrumbList"]
PdpGeoRagUpdateTarget = Literal[
    "productDescription",
    "webPageDescription",
    "quickFacts",
    "benefits",
    "ingredients",
    "howToUse",
    "faq",
    "schema",
    "breadcrumbs",
    "reviews",
]
PdpGeoRerankerProvider = Literal["local-hybrid", "openai-file-search", "custom"]
PositiveInteger = Annotated[int, Field(gt=0)]
UnitIntervalNumber = Annotated[float, Field(ge=0, le=1)]


def _require_url(value: str) -> str:
    """Validate the same absolute URL boundary as ``z.string().url()``.

    We deliberately retain the caller's spelling instead of constructing an
    URL object, because TypeScript returns the original string on the public
    wire.  Schemes such as ``mailto:`` remain valid URL references; malformed
    HTTP(S) values without a host do not.
    """

    if not value:
        raise ValueError("Input should be a valid URL")
    parsed = urlsplit(value)
    scheme = parsed.scheme.lower()
    if not scheme:
        raise ValueError("Input should be a valid URL")
    # z.string().url() uses the WHATWG URL parser.  In particular it accepts
    # ``http:example.com`` and percent-encodes a space in an HTTP URL path;
    # urllib deliberately treats the former as a scheme plus relative path.
    # Keep the spelling on the public wire, but use the parser's acceptance
    # boundary rather than incorrectly requiring ``//host`` at validation.
    if scheme in {"http", "https"}:
        if parsed.netloc or (parsed.path and not parsed.path.startswith("/")):
            return value
        raise ValueError("Input should be a valid URL")
    if not parsed.netloc and not parsed.path:
        raise ValueError("Input should be a valid URL")
    return value


class WireModel(BaseModel):
    """Pydantic base that mirrors JavaScript omitted-property semantics."""

    # Zod parses the input schema without coercing string/number/boolean
    # values.  Keep that control-plane boundary strict while ``product`` stays
    # intentionally untyped (the source contract is ``z.unknown()``).
    model_config = ConfigDict(extra="ignore", populate_by_name=True, serialize_by_alias=True, strict=True)

    def to_wire(self) -> dict[str, Any]:
        return cast(dict[str, Any], omit_none(self.model_dump(by_alias=True, exclude_none=True)))


class PdpGeoSourceInfo(WireModel):
    type: Literal["pdp-extractor", "rest-api", "manual-json", "unknown"] | None = None
    url: str | None = None
    api_name: str | None = Field(default=None, alias="apiName")


class PdpGeoGenerationHints(WireModel):
    locale: Literal["ko-KR", "ja-JP", "en-US", "en-GB"] | None = None
    market: str | None = None
    brand: str | None = None
    category: str | None = None
    target_audience: str | None = Field(default=None, alias="targetAudience")
    tone: str | None = None
    schema_targets: list[PdpGeoSchemaTarget] | None = Field(default=None, alias="schemaTargets")
    page_type: Literal["ItemPage", "CollectionPage", "AboutPage", "WebPage"] | None = Field(
        default=None, alias="pageType"
    )
    update_targets: list[PdpGeoRagUpdateTarget] | None = Field(default=None, alias="updateTargets")
    brand_same_as: list[str] | None = Field(default=None, alias="brandSameAs")
    organization: PdpGeoOrganization | None = None

    @field_validator("brand_same_as")
    @classmethod
    def _validate_brand_same_as_urls(cls, value: list[str] | None) -> list[str] | None:
        if value is not None:
            for url in value:
                _require_url(url)
        return value


class PdpGeoOrganization(WireModel):
    """The strict organization object accepted by the retained Zod schema."""

    name: str
    url: str
    logo_url: str | None = Field(default=None, alias="logoUrl")
    # Intentionally not URL-validated: the TypeScript schema accepts strings
    # here and filters unsafe values only when emitting schema markup.
    same_as: list[str] | None = Field(default=None, alias="sameAs")

    @field_validator("url", "logo_url")
    @classmethod
    def _validate_organization_urls(cls, value: str | None) -> str | None:
        if value is not None:
            _require_url(value)
        return value


class PdpGeoFieldMapping(WireModel):
    # ``z.record`` preserves arbitrary field-map keys.  Known aliases remain
    # typed below for callers, while extras are retained in ``model_dump``.
    model_config = ConfigDict(extra="allow", populate_by_name=True, serialize_by_alias=True, strict=True)
    name: str | list[str] | None = None
    description: str | list[str] | None = None
    brand: str | list[str] | None = None
    category: str | list[str] | None = None
    price: str | list[str] | None = None
    currency: str | list[str] | None = None
    images: str | list[str] | None = None
    options: str | list[str] | None = None
    benefits: str | list[str] | None = None
    effects: str | list[str] | None = None
    ingredients: str | list[str] | None = None
    usage: str | list[str] | None = None
    faq: str | list[str] | None = None
    reviews: str | list[str] | None = None
    rating: str | list[str] | None = None
    review_count: str | list[str] | None = Field(default=None, alias="reviewCount")
    breadcrumbs: str | list[str] | None = None
    date_modified: str | list[str] | None = Field(default=None, alias="dateModified")

    @model_validator(mode="before")
    @classmethod
    def _validate_record_values(cls, value: object) -> object:
        if not isinstance(value, Mapping):
            raise ValueError("fieldMapping must be an object whose values are strings or string arrays.")
        record = cast(Mapping[object, object], value)
        for key, item in record.items():
            item_is_string_array = isinstance(item, list) and all(
                isinstance(element, str) for element in cast(list[object], item)
            )
            if not isinstance(key, str) or (
                not isinstance(item, str)
                and not item_is_string_array
            ):
                raise ValueError("fieldMapping must be an object whose values are strings or string arrays.")
        return dict(record)


class PdpGeoRagDocument(WireModel):
    name: str
    content: str
    version: str | None = None


class PdpGeoRagQueryPlanningSettings(WireModel):
    enabled: bool | None = None
    update_targets: list[PdpGeoRagUpdateTarget] | None = Field(default=None, alias="updateTargets")
    include_base_query: bool | None = Field(default=None, alias="includeBaseQuery")
    max_subqueries: PositiveInteger | None = Field(default=None, alias="maxSubqueries")


class PdpGeoRagFullDocumentHydrationSettings(WireModel):
    enabled: bool | None = None
    strategic_only: bool | None = Field(default=None, alias="strategicOnly")
    max_documents: PositiveInteger | None = Field(default=None, alias="maxDocuments")


class PdpGeoRagSettings(WireModel):
    mode: Literal["local-versioned-rag", "managed-vector-store-rag"] | None = None
    provider: Literal["local", "openai", "custom"] | None = None
    embedding_provider: Literal["local", "openai", "custom"] | None = Field(default=None, alias="embeddingProvider")
    embedding_model: str | None = Field(default=None, alias="embeddingModel")
    reranker_provider: PdpGeoRerankerProvider | None = Field(default=None, alias="rerankerProvider")
    vector_store_id: str | None = Field(default=None, alias="vectorStoreId")
    max_chunks: PositiveInteger | None = Field(default=None, alias="maxChunks")
    score_threshold: UnitIntervalNumber | None = Field(default=None, alias="scoreThreshold")
    rewrite_query: bool | None = Field(default=None, alias="rewriteQuery")
    managed_search_endpoint: str | None = Field(default=None, alias="managedSearchEndpoint")
    resolve_urls: bool | None = Field(default=None, alias="resolveUrls")
    max_resolved_url_documents: PositiveInteger | None = Field(default=None, alias="maxResolvedUrlDocuments")
    url_fetch_timeout_ms: PositiveInteger | None = Field(default=None, alias="urlFetchTimeoutMs")
    allowed_url_domains: list[str] | None = Field(default=None, alias="allowedUrlDomains")
    documents: list[PdpGeoRagDocument] | None = None
    analysis_prompt: str | None = Field(default=None, alias="analysisPrompt")
    query_planning: PdpGeoRagQueryPlanningSettings | None = Field(default=None, alias="queryPlanning")
    full_document_hydration: PdpGeoRagFullDocumentHydrationSettings | None = Field(
        default=None, alias="fullDocumentHydration"
    )


class PdpGeoGenerationInput(WireModel):
    product: Any
    source: PdpGeoSourceInfo | None = None
    hints: PdpGeoGenerationHints | None = None
    field_mapping: PdpGeoFieldMapping | None = Field(default=None, alias="fieldMapping")
    rag: PdpGeoRagSettings | None = None


class PdpGeoGenerationRun(WireModel):
    result: dict[str, Any]
    diagnostics: dict[str, Any]
    process: list[dict[str, Any]]


def omit_none(value: object) -> object:
    """Recursively omit ``None`` object values without reordering mappings."""

    if isinstance(value, Mapping):
        mapping = cast(Mapping[str, object], value)
        return {key: omit_none(child) for key, child in mapping.items() if child is not None}
    if isinstance(value, Sequence) and not isinstance(value, str | bytes | bytearray):
        return [omit_none(child) for child in cast(Sequence[object], value)]
    return value


__all__ = [
    "PdpGeoFieldMapping",
    "PdpGeoGenerationHints",
    "PdpGeoGenerationInput",
    "PdpGeoGenerationRun",
    "PdpGeoRagSettings",
    "PdpGeoSourceInfo",
    "WireModel",
    "omit_none",
]
