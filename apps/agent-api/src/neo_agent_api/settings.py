"""Environment-backed configuration retaining the Node service's variable surface."""

from __future__ import annotations

import math
import os
import re
from dataclasses import dataclass
from typing import cast
from urllib.parse import quote, urlsplit

from neo_js_compat import js_trim

from neo_agent_api._json import as_dict, as_list


def _truthy(value: str | None) -> bool:
    return bool(value and value.casefold() == "true")


def _integer(value: str | None, default: int) -> int:
    try:
        return int(value) if value is not None else default
    except ValueError:
        return default


def _number_constructor(value: str | None, default: int) -> int | float:
    """Port ``Number(env.VALUE ?? fallback)`` for queue construction.

    A failed JavaScript ``Number`` conversion is deliberately *not* silently
    replaced by the fallback.  The Nest provider passes ``NaN`` into
    ``GeoQueue``, whose constructor is then responsible for rejecting it at
    startup.  Canonicalising finite integral values to ``int`` preserves the
    queue's ``Number.isInteger``-style validation.
    """

    raw = str(default) if value is None else value
    parsed = _js_number(raw)
    if math.isfinite(parsed) and parsed.is_integer():
        return int(parsed)
    return parsed


def _js_number(raw: str) -> float:
    """Implement JavaScript's string ``Number`` conversion for env values."""

    stripped = js_trim(raw)
    if not stripped:
        return 0.0
    try:
        if re.fullmatch(r"0[xX][0-9a-fA-F]+", stripped):
            return float(int(stripped, 16))
        if re.fullmatch(r"0[bB][01]+", stripped):
            return float(int(stripped, 2))
        if re.fullmatch(r"0[oO][0-7]+", stripped):
            return float(int(stripped, 8))
        if stripped in {"Infinity", "+Infinity"}:
            return math.inf
        if stripped == "-Infinity":
            return -math.inf
        if re.fullmatch(r"[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", stripped) is None:
            return math.nan
        return float(stripped)
    except OverflowError:
        # Unsigned base-prefixed literals can exceed Python's float conversion
        # range; JavaScript ``Number`` represents those as positive infinity.
        return math.inf
    except ValueError:
        return math.nan


# Public narrow seam for retained ECMAScript-number regression coverage.
js_number = _js_number


def _number(value: str | None) -> float | None:
    if value is None or not js_trim(value):
        return None
    parsed = _js_number(value)
    return parsed if math.isfinite(parsed) else None


def _positive_js_integer(value: str | None, default: int) -> int:
    """Mirror ``Number`` followed by ``Number.isInteger(n) && n > 0``."""

    parsed = _number_constructor(value, 0)
    if math.isfinite(parsed) and float(parsed).is_integer() and parsed > 0:
        return int(parsed)
    return default


def _optional(value: str | None) -> str | None:
    trimmed = js_trim(value) if value else ""
    return trimmed or None


def _cors_allowed_origins(value: str | None) -> tuple[str, ...]:
    """Read a comma-separated, literal browser-origin allowlist.

    CORS compares origins literally.  Reject wildcard or URL-shaped values
    that cannot be a browser Origin so an invalid deployment configuration
    fails closed instead of unexpectedly widening browser access.
    """

    origins: list[str] = []
    for raw_origin in (value or "").split(","):
        origin = js_trim(raw_origin)
        if not origin:
            continue
        if "*" in origin:
            raise ValueError("AGENTIC_GEO_CORS_ALLOWED_ORIGINS must contain explicit origins, not wildcards.")
        try:
            parsed = urlsplit(origin)
            hostname = parsed.hostname
            port = parsed.port
        except ValueError as exc:
            raise ValueError("AGENTIC_GEO_CORS_ALLOWED_ORIGINS contains an invalid origin.") from exc
        if (
            parsed.scheme not in {"http", "https"}
            or not hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path
            or parsed.query
            or parsed.fragment
            or (port is not None and not 0 <= port <= 65535)
        ):
            raise ValueError("AGENTIC_GEO_CORS_ALLOWED_ORIGINS must contain exact http(s) origins without paths.")
        if origin not in origins:
            origins.append(origin)
    return tuple(origins)


def _nullish(value: str | None, fallback: str | None) -> str | None:
    """Mirror JavaScript ``??`` for raw process-environment strings."""

    return fallback if value is None else value


def _omit_none(value: object) -> object:
    if isinstance(value, dict):
        return {key: _omit_none(item) for key, item in as_dict(value).items() if item is not None}
    if isinstance(value, list):
        return [_omit_none(item) for item in as_list(value)]
    return value


@dataclass(frozen=True, slots=True)
class Settings:
    port: int = 3000
    api_key: str = ""
    worker_concurrency: int | float = 4
    queue_max_waiting: int = 100
    queue_max_attempts: int = 2
    queue_backoff_ms: int = 5000
    db_host: str = "localhost"
    db_port: int = 5432
    db_name: str = "postgres"
    db_username: str = "postgres"
    db_password: str = ""
    db_schema: str = "neo"
    db_ssl: bool = False
    db_ssl_reject_unauthorized: bool = True
    database_url: str = ""
    provider: str = "mock"
    geo_test_sync_endpoint: bool = False
    log_level: str = "info"
    ocr_image_allowed_hosts: str | None = None
    langfuse_public_key: str = ""
    langfuse_secret_key: str = ""
    langfuse_base_url: str | None = None
    openai_api_key: str | None = None
    openai_model: str | None = None
    gemini_api_key: str | None = None
    gemini_model: str | None = None
    azure_openai_api_key: str | None = None
    azure_openai_endpoint: str | None = None
    azure_openai_deployment: str | None = None
    azure_openai_reasoning_deployment: str | None = None
    azure_openai_ocr_deployment: str | None = None
    azure_openai_embedding_deployment: str | None = None
    azure_openai_embedding_endpoint: str | None = None
    azure_openai_embedding_api_key: str | None = None
    azure_openai_embedding_api_version: str | None = None
    azure_openai_proofreading_deployment: str | None = None
    azure_openai_api_version: str | None = None
    azure_openai_temperature: float | None = None
    aistudio_api_key: str | None = None
    aistudio_endpoint: str | None = None
    aistudio_model: str | None = None
    aistudio_api_version: str | None = None
    product_normalization_raw: str | None = None
    reranker_provider: str = "cohere"
    cohere_rerank_api_key: str | None = None
    cohere_rerank_endpoint: str | None = None
    cohere_rerank_model: str | None = None
    azure_ai_search_api_key: str | None = None
    azure_ai_search_endpoint: str | None = None
    azure_ai_search_index_name: str | None = None
    azure_ai_search_semantic_configuration: str | None = None
    azure_ai_search_query_language: str | None = None
    openai_vector_store_id: str | None = None
    citation_probe_enabled: bool = False
    cors_allowed_origins: tuple[str, ...] = ()

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> Settings:
        values = os.environ if env is None else env
        return cls(
            port=_integer(values.get("PORT"), 3000),
            api_key=values.get("AGENT_API_KEY", ""),
            worker_concurrency=_number_constructor(values.get("GEO_WORKER_CONCURRENCY"), 4),
            queue_max_waiting=_positive_js_integer(values.get("GEO_QUEUE_MAX_WAITING"), 100),
            queue_max_attempts=_integer(values.get("GEO_QUEUE_MAX_ATTEMPTS"), 2),
            queue_backoff_ms=_integer(values.get("GEO_QUEUE_BACKOFF_MS"), 5000),
            db_host=values.get("DB_HOST", "localhost"),
            db_port=_integer(values.get("DB_PORT"), 5432),
            db_name=values.get("DB_NAME", "postgres"),
            db_username=values.get("DB_USERNAME", "postgres"),
            db_password=values.get("DB_PASSWORD", ""),
            db_schema=values.get("DB_SCHEMA", "neo"),
            db_ssl=_truthy(values.get("DB_SSL")),
            db_ssl_reject_unauthorized=not (values.get("DB_SSL_REJECT_UNAUTHORIZED", "").casefold() == "false"),
            database_url=values.get("DATABASE_URL", ""),
            provider=values.get("AGENTIC_GEO_PROVIDER", "mock"),
            geo_test_sync_endpoint=_truthy(values.get("GEO_TEST_SYNC_ENDPOINT")),
            log_level=values.get("LOG_LEVEL", "info"),
            ocr_image_allowed_hosts=values.get("AGENTIC_GEO_OCR_IMAGE_ALLOWED_HOSTS"),
            langfuse_public_key=values.get("LANGFUSE_PUBLIC_KEY", ""),
            langfuse_secret_key=values.get("LANGFUSE_SECRET_KEY", ""),
            langfuse_base_url=_optional(values.get("LANGFUSE_BASE_URL")),
            # Most retained factories pass their environment values through
            # verbatim and use ``??`` for precedence.  Keep raw empty and
            # whitespace values here; individual factory branches call
            # ``_optional`` only where TypeScript calls optionalString().
            openai_api_key=values.get("OPENAI_API_KEY"),
            openai_model=values.get("OPENAI_MODEL"),
            gemini_api_key=values.get("GEMINI_API_KEY"),
            gemini_model=values.get("GEMINI_MODEL"),
            azure_openai_api_key=values.get("AZURE_OPENAI_API_KEY"),
            azure_openai_endpoint=values.get("AZURE_OPENAI_ENDPOINT"),
            azure_openai_deployment=values.get("AZURE_OPENAI_DEPLOYMENT"),
            azure_openai_reasoning_deployment=values.get("AZURE_OPENAI_REASONING_DEPLOYMENT"),
            azure_openai_ocr_deployment=values.get("AZURE_OPENAI_OCR_DEPLOYMENT"),
            azure_openai_embedding_deployment=values.get("AZURE_OPENAI_EMBEDDING_DEPLOYMENT"),
            azure_openai_embedding_endpoint=values.get("AZURE_OPENAI_EMBEDDING_ENDPOINT"),
            azure_openai_embedding_api_key=values.get("AZURE_OPENAI_EMBEDDING_API_KEY"),
            azure_openai_embedding_api_version=values.get("AZURE_OPENAI_EMBEDDING_API_VERSION"),
            azure_openai_proofreading_deployment=values.get("AZURE_OPENAI_PROOFREADING_DEPLOYMENT"),
            azure_openai_api_version=values.get("AZURE_OPENAI_API_VERSION"),
            azure_openai_temperature=_number(values.get("AZURE_OPENAI_TEMPERATURE")),
            aistudio_api_key=values.get("AISTUDIO_API_KEY"),
            aistudio_endpoint=values.get("AISTUDIO_ENDPOINT"),
            aistudio_model=values.get("AISTUDIO_MODEL"),
            aistudio_api_version=values.get("AISTUDIO_API_VERSION"),
            product_normalization_raw=values.get("AGENTIC_GEO_PRODUCT_NORMALIZATION"),
            reranker_provider=values.get("AGENTIC_GEO_RERANKER_PROVIDER", "cohere"),
            cohere_rerank_api_key=values.get("AZURE_COHERE_RERANK_API_KEY"),
            cohere_rerank_endpoint=values.get("AZURE_COHERE_RERANK_ENDPOINT"),
            cohere_rerank_model=values.get("AZURE_COHERE_RERANK_MODEL"),
            azure_ai_search_api_key=values.get("AZURE_AI_SEARCH_API_KEY"),
            azure_ai_search_endpoint=values.get("AZURE_AI_SEARCH_ENDPOINT"),
            azure_ai_search_index_name=values.get("AZURE_AI_SEARCH_INDEX_NAME"),
            azure_ai_search_semantic_configuration=values.get("AZURE_AI_SEARCH_SEMANTIC_CONFIGURATION"),
            azure_ai_search_query_language=values.get("AZURE_AI_SEARCH_QUERY_LANGUAGE"),
            openai_vector_store_id=values.get("OPENAI_VECTOR_STORE_ID"),
            citation_probe_enabled=values.get("AGENTIC_GEO_CITATION_PROBE") == "true",
            cors_allowed_origins=_cors_allowed_origins(values.get("AGENTIC_GEO_CORS_ALLOWED_ORIGINS")),
        )

    @property
    def resolved_database_url(self) -> str:
        if self.database_url:
            return self.database_url
        sslmode = "disable"
        if self.db_ssl:
            sslmode = "verify-full" if self.db_ssl_reject_unauthorized else "require"
        username = quote(self.db_username, safe="")
        password = quote(self.db_password, safe="")
        return (
            f"postgresql+psycopg://{username}:{password}@{self.db_host}:{self.db_port}/{self.db_name}?sslmode={sslmode}"
        )

    def provider_api_key(self, provider: str | None = None) -> str | None:
        selected = self.provider if provider is None else provider
        return {
            "openai": self.openai_api_key,
            "gemini": self.gemini_api_key,
            "azure-openai": self.azure_openai_api_key,
            "aistudio": self.aistudio_api_key,
        }.get(selected)

    def provider_model(self, provider: str | None = None) -> str | None:
        selected = self.provider if provider is None else provider
        if selected == "openai":
            return self.openai_model
        if selected == "gemini":
            return self.gemini_model
        if selected == "azure-openai":
            return _nullish(self.azure_openai_reasoning_deployment, self.azure_openai_deployment)
        if selected == "aistudio":
            return self.aistudio_model
        return None

    def provider_endpoint(self, provider: str | None = None) -> str | None:
        selected = self.provider if provider is None else provider
        if selected == "azure-openai":
            return self.azure_openai_endpoint
        if selected == "aistudio":
            return self.aistudio_endpoint
        return None

    def provider_deployment(self, provider: str | None = None) -> str | None:
        selected = self.provider if provider is None else provider
        if selected == "azure-openai":
            return _nullish(self.azure_openai_reasoning_deployment, self.azure_openai_deployment)
        if selected == "aistudio":
            return self.aistudio_model
        return None

    def provider_api_version(self, provider: str | None = None) -> str | None:
        selected = self.provider if provider is None else provider
        if selected == "azure-openai":
            return self.azure_openai_api_version
        if selected == "aistudio":
            return self.aistudio_api_version
        return None

    def provider_deployments(self, provider: str | None = None) -> dict[str, str]:
        selected = self.provider if provider is None else provider
        if selected == "azure-openai":
            return {
                key: value
                for key, value in {
                    "ocr": _nullish(self.azure_openai_ocr_deployment, self.azure_openai_deployment),
                    "reasoning": _nullish(self.azure_openai_reasoning_deployment, self.azure_openai_deployment),
                    "embedding": self.azure_openai_embedding_deployment,
                    "proofreading": self.azure_openai_proofreading_deployment,
                }.items()
                if value is not None
            }
        if selected == "aistudio" and self.aistudio_model is not None:
            return {"reasoning": self.aistudio_model}
        return {}

    def _embedding_runtime(self) -> dict[str, object]:
        if _optional(self.azure_openai_embedding_endpoint):
            return {
                "provider": "azure-openai",
                "apiKey": _nullish(_optional(self.azure_openai_embedding_api_key), self.azure_openai_api_key),
                "endpoint": self.azure_openai_embedding_endpoint,
                "deployment": self.azure_openai_embedding_deployment,
                "apiVersion": self.azure_openai_embedding_api_version,
            }
        return {
            "provider": "azure-openai" if self.azure_openai_embedding_deployment else "local",
            "apiKey": self.azure_openai_api_key,
            "endpoint": self.azure_openai_endpoint,
            "deployment": self.azure_openai_embedding_deployment,
            "apiVersion": self.azure_openai_api_version,
        }

    def _reranker_runtime(self) -> dict[str, object]:
        azure_search = self.reranker_provider == "azure-ai-search-semantic"
        return {
            "provider": self.reranker_provider,
            "apiKey": self.azure_ai_search_api_key if azure_search else self.cohere_rerank_api_key,
            "endpoint": self.azure_ai_search_endpoint if azure_search else self.cohere_rerank_endpoint,
            "model": self.cohere_rerank_model if self.reranker_provider == "cohere" else None,
            "indexName": self.azure_ai_search_index_name,
            "semanticConfiguration": self.azure_ai_search_semantic_configuration,
            "queryLanguage": self.azure_ai_search_query_language,
        }

    def generator_runtime(self, provider: str | None = None) -> dict[str, object]:
        provider = self.provider if provider is None else provider
        api_key = self.provider_api_key(provider)
        model = self.provider_model(provider)
        deployment = self.provider_deployment(provider)
        deployments = self.provider_deployments(provider)
        normalization_enabled = (
            provider != "mock" and bool(api_key) and js_trim(self.product_normalization_raw or "").lower() != "false"
        )
        proofreading_deployment = deployments.get("proofreading") if provider == "azure-openai" else deployment
        proofreading_deployment = _nullish(proofreading_deployment, deployment)
        runtime = _omit_none(
            {
                "provider": provider,
                "apiKey": api_key,
                "model": model,
                "endpoint": self.provider_endpoint(provider),
                "deployment": deployment,
                "deployments": deployments,
                "apiVersion": self.provider_api_version(provider),
                "temperature": self.azure_openai_temperature,
                "embedding": self._embedding_runtime(),
                "reranker": self._reranker_runtime(),
                "productNormalization": {"enabled": normalization_enabled},
                "finalProofreading": {
                    "enabled": provider != "mock" and bool(api_key),
                    "provider": provider,
                    "apiKey": api_key,
                    "model": _nullish(proofreading_deployment, model),
                    "endpoint": self.provider_endpoint(provider),
                    "deployment": proofreading_deployment,
                    "apiVersion": self.provider_api_version(provider),
                },
                "rag": {"vectorStoreId": self.openai_vector_store_id} if self.openai_vector_store_id else None,
            }
        )
        return cast(dict[str, object], runtime)

    def extractor_runtime(self, provider: str | None = None) -> dict[str, object]:
        runtime = self.generator_runtime(provider)
        deployments = dict(self.provider_deployments(provider))
        deployments.pop("proofreading", None)
        runtime["deployments"] = deployments
        runtime.pop("finalProofreading", None)
        return runtime

    def _internal_shared_runtime(self, provider: str | None = None) -> dict[str, object]:
        """Port ``selectSharedLlmEnv`` for the internal Nest service only.

        The console routes intentionally retain their older, separate env
        lookup. Keeping this factory distinct prevents console RAG/reranker and
        local-embedding defaults from leaking into background GEO jobs.
        """

        selected = self.provider if provider is None else provider
        aistudio_deployment = _optional(self.aistudio_model) if selected == "aistudio" else None
        reasoning_deployment = _nullish(
            aistudio_deployment,
            _nullish(self.azure_openai_reasoning_deployment, self.azure_openai_deployment),
        )
        model = (
            self.openai_model
            if selected == "openai"
            else self.gemini_model
            if selected == "gemini"
            else self.aistudio_model
            if selected == "aistudio"
            else None
        )
        runtime = {
            "provider": selected,
            "apiKey": self.provider_api_key(selected),
            "model": model,
            "endpoint": self.aistudio_endpoint if selected == "aistudio" else self.azure_openai_endpoint,
            "deployment": reasoning_deployment,
            "deployments": {
                "ocr": _nullish(
                    aistudio_deployment,
                    _nullish(self.azure_openai_ocr_deployment, self.azure_openai_deployment),
                ),
                "reasoning": reasoning_deployment,
                "embedding": self.azure_openai_embedding_deployment,
                "proofreading": aistudio_deployment or self.azure_openai_proofreading_deployment,
            },
            "apiVersion": _optional(self.aistudio_api_version)
            if selected == "aistudio"
            else self.azure_openai_api_version,
        }
        return cast(dict[str, object], _omit_none(runtime))

    def internal_generator_runtime(self, provider: str | None = None) -> dict[str, object]:
        """Port ``buildGeneratorOptions`` without browser-only options."""

        selected = self.provider if provider is None else provider
        runtime = self._internal_shared_runtime(selected)
        api_key = self.provider_api_key(selected)
        if _optional(self.azure_openai_embedding_endpoint):
            runtime["embedding"] = cast(
                dict[str, object],
                _omit_none(
                    {
                        "provider": "azure-openai",
                        "apiKey": _nullish(_optional(self.azure_openai_embedding_api_key), self.azure_openai_api_key),
                        "endpoint": self.azure_openai_embedding_endpoint,
                        "deployment": self.azure_openai_embedding_deployment,
                        "apiVersion": _optional(self.azure_openai_embedding_api_version),
                    }
                ),
            )
        if self.azure_openai_temperature is not None:
            runtime["temperature"] = self.azure_openai_temperature
        runtime["productNormalization"] = {
            "enabled": selected != "mock"
            and bool(api_key)
            and js_trim(self.product_normalization_raw or "").lower() != "false"
        }
        runtime["finalProofreading"] = {
            "enabled": selected != "mock" and bool(api_key),
            "provider": selected,
            "apiKey": api_key,
        }
        return cast(dict[str, object], _omit_none(runtime))

    def internal_extractor_runtime(self, provider: str | None = None) -> dict[str, object]:
        """Port ``buildExtractorOptions`` with only its declared fields."""

        shared = self._internal_shared_runtime(provider)
        deployments = as_dict(shared.get("deployments"))
        return cast(
            dict[str, object],
            _omit_none(
                {
                    "provider": shared.get("provider"),
                    "apiKey": shared.get("apiKey"),
                    "model": shared.get("model"),
                    "endpoint": shared.get("endpoint"),
                    "deployment": shared.get("deployment"),
                    "deployments": {
                        "ocr": deployments.get("ocr"),
                        "reasoning": deployments.get("reasoning"),
                        "embedding": deployments.get("embedding"),
                    },
                    "apiVersion": shared.get("apiVersion"),
                }
            ),
        )

    def _console_azure_deployments(self, *, include_proofreading: bool) -> dict[str, str | None]:
        deployments: dict[str, str | None] = {
            "ocr": _nullish(self.azure_openai_ocr_deployment, self.azure_openai_deployment),
            "reasoning": _nullish(self.azure_openai_reasoning_deployment, self.azure_openai_deployment),
            "embedding": self.azure_openai_embedding_deployment,
        }
        if include_proofreading:
            deployments["proofreading"] = self.azure_openai_proofreading_deployment
        return deployments

    def _console_embedding_runtime(self) -> dict[str, object]:
        return cast(
            dict[str, object],
            _omit_none(
                {
                    "provider": "azure-openai" if self.azure_openai_embedding_deployment else "local",
                    "apiKey": self.azure_openai_api_key,
                    "endpoint": self.azure_openai_endpoint,
                    "deployment": self.azure_openai_embedding_deployment,
                    "apiVersion": self.azure_openai_api_version,
                }
            ),
        )

    def generate_console_runtime(self, provider: str | None = None) -> dict[str, object]:
        """Build the `/generate` route's source-defined environment defaults.

        The Next handler always constructs its fallback embedding from the
        primary Azure variables.  It deliberately does not share the internal
        worker's optional dedicated embedding endpoint/key/version.
        """

        selected = self.provider if provider is None else provider
        return cast(
            dict[str, object],
            _omit_none(
                {
                    "provider": selected,
                    "apiKey": self.provider_api_key(selected),
                    "model": self.provider_model(selected),
                    "endpoint": self.provider_endpoint(selected),
                    "deployment": self.provider_deployment(selected),
                    "deployments": self.provider_deployments(selected),
                    "apiVersion": self.provider_api_version(selected),
                    "temperature": self.azure_openai_temperature,
                    "embedding": self._console_embedding_runtime(),
                    "reranker": self._reranker_runtime(),
                    "rag": {"vectorStoreId": self.openai_vector_store_id} if self.openai_vector_store_id else None,
                }
            ),
        )

    def extractor_console_runtime(self) -> dict[str, object]:
        """Port the standalone Next extractor route's deliberately shared env lookup."""

        return cast(
            dict[str, object],
            _omit_none(
                {
                    "provider": self.provider,
                    "apiKey": _nullish(
                        self.openai_api_key,
                        _nullish(self.gemini_api_key, self.azure_openai_api_key),
                    ),
                    "model": _nullish(self.openai_model, self.gemini_model),
                    "endpoint": self.azure_openai_endpoint,
                    "deployment": self.azure_openai_deployment,
                    "deployments": self._console_azure_deployments(include_proofreading=False),
                    "apiVersion": self.azure_openai_api_version,
                    "temperature": self.azure_openai_temperature,
                    "embedding": self._console_embedding_runtime(),
                    "reranker": self._reranker_runtime(),
                }
            ),
        )

    def generator_console_runtime(self) -> dict[str, object]:
        """Port the standalone Next generator route, including its legacy AI Studio omission."""

        selected = self.provider
        api_key = None if selected == "aistudio" else self.provider_api_key(selected)
        model = None if selected == "aistudio" else self.provider_model(selected)
        proofreading_deployment = _nullish(
            self.azure_openai_proofreading_deployment,
            _nullish(self.azure_openai_reasoning_deployment, self.azure_openai_deployment),
        )
        final_deployment = proofreading_deployment if selected == "azure-openai" else None
        final_model = proofreading_deployment if selected == "azure-openai" else model
        return cast(
            dict[str, object],
            _omit_none(
                {
                    "provider": selected,
                    "apiKey": api_key,
                    "model": model,
                    # The retained standalone Next route always uses the Azure env fields here.
                    "endpoint": self.azure_openai_endpoint,
                    "deployment": _nullish(self.azure_openai_reasoning_deployment, self.azure_openai_deployment),
                    "deployments": self._console_azure_deployments(include_proofreading=True),
                    "apiVersion": self.azure_openai_api_version,
                    "temperature": self.azure_openai_temperature,
                    "finalProofreading": {
                        "enabled": selected != "mock" and bool(api_key),
                        "provider": selected,
                        "apiKey": api_key,
                        "model": final_model,
                        "endpoint": self.azure_openai_endpoint,
                        "deployment": final_deployment,
                        "apiVersion": self.azure_openai_api_version,
                    },
                    "embedding": self._console_embedding_runtime(),
                    "reranker": self._reranker_runtime(),
                    "rag": {"vectorStoreId": self.openai_vector_store_id} if self.openai_vector_store_id else None,
                }
            ),
        )
