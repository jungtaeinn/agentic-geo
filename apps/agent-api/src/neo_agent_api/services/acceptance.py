"""Database status gate and capacity admission for internal GEO jobs."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any, Protocol

from neo_agent_api.api.errors import LegacyHttpError
from neo_agent_api.observability.logging import log_event


class GenerationStatusRepository(Protocol):
    async def find_status(self, geo_generation_id: str) -> str | None: ...


class QueueAdmission(Protocol):
    def waiting_count(self) -> int: ...

    async def add(self, data: Mapping[str, Any]) -> None: ...


class GeoAcceptanceService:
    def __init__(
        self,
        repository: GenerationStatusRepository,
        queue: QueueAdmission,
        max_waiting: object = 100,
        logger: logging.Logger | None = None,
    ) -> None:
        self.repository = repository
        self.queue = queue
        self.max_waiting = max_waiting if isinstance(max_waiting, int) and max_waiting > 0 else 100
        self._logger = logger

    async def accept(self, data: Mapping[str, Any]) -> str:
        generation_id = str(data["geoGenerationId"])
        try:
            status = await self.repository.find_status(generation_id)
        except Exception as exc:
            if self._logger is not None:
                log_event(
                    self._logger,
                    logging.ERROR,
                    "geo.accept.db_unavailable",
                    geoGenerationId=generation_id,
                    err=str(exc),
                )
            raise LegacyHttpError(503, "db unavailable", "Service Unavailable") from exc
        if status != "PROCESSING":
            if self._logger is not None:
                log_event(self._logger, logging.INFO, "geo.noop", geoGenerationId=generation_id, status=status)
            return "noop"
        # Preserve the original ordering: capacity wins even if queue dedup would no-op.
        if self.queue.waiting_count() >= self.max_waiting:
            if self._logger is not None:
                log_event(
                    self._logger,
                    logging.WARNING,
                    "geo.rejected.saturated",
                    geoGenerationId=generation_id,
                    waiting=self.queue.waiting_count(),
                    maxWaiting=self.max_waiting,
                )
            raise LegacyHttpError(429, "queue saturated")
        if self._logger is not None:
            log_event(
                self._logger,
                logging.INFO,
                "geo.accepted",
                geoGenerationId=generation_id,
                locale=data.get("locale"),
                waiting=self.queue.waiting_count(),
                active=getattr(self.queue, "active_count", None),
                maxWaiting=self.max_waiting,
            )
        await self.queue.add(dict(data))
        return "enqueued"
