"""GEO artifact generation and the queue processor's persistence boundary."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any, Protocol

from pdp_geo_generator_agent import generate_pdp_geo

from neo_agent_api._json import as_dict, as_list
from neo_agent_api.observability.logging import log_event

from .product_sanitizer import sanitize_product_html
from .schema_types import compute_result_hash, derive_schema_types


def resolve_result_status(warnings: list[str]) -> str:
    return "SUCCEEDED_WITH_WARNINGS" if warnings else "SUCCEEDED"


def extract_source_url(product: object) -> str | None:
    record = as_dict(product)
    if not record:
        return None
    for key in ("canonicalUrl", "offerUrl"):
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


class GenerationRunner(Protocol):
    """Minimal generation boundary used by the queue processor."""

    async def generate(self, data: Mapping[str, Any]) -> dict[str, Any]: ...


class OcrEnrichmentRunner(Protocol):
    """Minimal OCR boundary required by artifact generation."""

    async def enrich(self, product: object, source_url: str | None) -> dict[str, Any]: ...


class GenerationService:
    def __init__(
        self,
        ocr_enrichment: OcrEnrichmentRunner,
        *,
        provider: str = "mock",
        runtime: Mapping[str, Any] | None = None,
    ) -> None:
        self.ocr_enrichment = ocr_enrichment
        self.provider = provider
        self.runtime = {"provider": provider, **dict(runtime or {})}

    async def generate(self, data: Mapping[str, Any]) -> dict[str, Any]:
        source_url = extract_source_url(data.get("product"))
        enrichment = await self.ocr_enrichment.enrich(data.get("product"), source_url)
        brand_same_as = data.get("brandSameAs")
        hints: dict[str, Any] = {"locale": str(data["locale"])}
        if isinstance(brand_same_as, list) and brand_same_as:
            hints["brandSameAs"] = [
                value for value in as_list(brand_same_as) if isinstance(value, str) and value.strip()
            ]
        run = await generate_pdp_geo(
            {
                "product": sanitize_product_html(enrichment["product"]),
                "source": {"type": "manual-json", "url": source_url},
                "hints": hints,
            },
            self.runtime,
        )
        result = as_dict(run.get("result"))
        markup = as_dict(result.get("schemaMarkup"))
        json_ld = as_dict(markup.get("jsonLd"))
        diagnostics = as_dict(result.get("diagnostics") or run.get("diagnostics"))
        warnings = [item for item in as_list(diagnostics.get("validationWarnings")) if isinstance(item, str)]
        warnings.extend(str(item) for item in enrichment["warnings"])
        diagnostics["ocrEnrichment"] = enrichment["diagnostics"]
        return {
            "resultStatus": resolve_result_status(warnings),
            "jsonLd": json_ld,
            "scriptTag": markup.get("scriptTag"),
            "schemaTypes": derive_schema_types(json_ld),
            "resultHash": compute_result_hash(json_ld),
            "ragProfile": result.get("ragProfile"),
            "diagnostics": diagnostics,
            "contentSections": as_dict(as_dict(result.get("content")).get("sections")),
            "generatedAt": result.get("generatedAt")
            or datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        }


class ResultPersistence(Protocol):
    async def persist_success(self, geo_generation_id: str, artifact: Mapping[str, Any]) -> bool: ...


class FailurePersistence(Protocol):
    async def transition_to_failed(self, geo_generation_id: str, code: str, detail: str) -> bool: ...


class GeoProcessor:
    def __init__(
        self,
        generation: GenerationRunner,
        results: ResultPersistence,
        generations: FailurePersistence,
        *,
        max_attempts: int,
        logger: logging.Logger | None = None,
    ) -> None:
        self.generation = generation
        self.results = results
        self.generations = generations
        self.max_attempts = max_attempts
        self._logger = logger

    async def process(self, job: Any) -> None:
        try:
            artifact = await self.generation.generate(job.data)
            persisted = await self.results.persist_success(str(job.data["geoGenerationId"]), artifact)
            if not persisted and self._logger is not None:
                log_event(
                    self._logger,
                    logging.WARNING,
                    "geo.persist_skipped",
                    geoGenerationId=str(job.data["geoGenerationId"]),
                    reason="not PROCESSING",
                )
        except Exception:
            if job.attempts_made + 1 >= self.max_attempts:
                try:
                    await self.generations.transition_to_failed(
                        str(job.data["geoGenerationId"]),
                        "GENERATION_ERROR",
                        _utf16_prefix(_message_from_current_exception(), 2000),
                    )
                except Exception as transition_error:
                    if self._logger is not None:
                        log_event(
                            self._logger,
                            logging.ERROR,
                            "geo.transition_failed",
                            geoGenerationId=str(job.data["geoGenerationId"]),
                            err=str(transition_error),
                        )
            raise


def _message_from_current_exception() -> str:
    import sys

    error = sys.exception()
    return str(error) if error is not None else "generation error"


def _utf16_prefix(value: str, units: int) -> str:
    encoded = value.encode("utf-16-le", errors="surrogatepass")[: units * 2]
    # Buffer/string conversion in Node replaces a split surrogate; retaining it
    # would later make a UTF-8 database write fail in Python.
    return encoded.decode("utf-16-le", errors="replace")


# Public narrow seam for database-safe JavaScript prefix parity.
utf16_prefix = _utf16_prefix
