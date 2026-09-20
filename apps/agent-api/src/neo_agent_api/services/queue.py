"""Single-process FIFO GEO queue with the legacy retry and shutdown behavior."""

from __future__ import annotations

import asyncio
import logging
import math
import time
from collections import deque
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any

from neo_agent_api.observability.job_context import run_in_job_context
from neo_agent_api.observability.logging import log_event


@dataclass(frozen=True, slots=True)
class GeoQueueJob:
    data: dict[str, Any]
    attempts_made: int


GeoQueueHandler = Callable[[GeoQueueJob], Awaitable[None]]


class GeoQueue:
    def __init__(
        self,
        *,
        concurrency: object = 4,
        max_attempts: object = 2,
        backoff_ms: object = 5000,
        logger: logging.Logger | None = None,
    ) -> None:
        if not isinstance(concurrency, int) or isinstance(concurrency, bool) or concurrency < 1:
            raise ValueError("GeoQueue concurrency must be an integer >= 1")
        if not isinstance(max_attempts, int) or isinstance(max_attempts, bool) or max_attempts < 1:
            raise ValueError("GeoQueue max_attempts must be an integer >= 1")
        if (
            not isinstance(backoff_ms, int | float)
            or isinstance(backoff_ms, bool)
            or not math.isfinite(backoff_ms)
            or backoff_ms < 0
        ):
            raise ValueError("GeoQueue backoff_ms must be finite and >= 0")
        self.concurrency = concurrency
        self.max_attempts = max_attempts
        self.backoff_ms = float(backoff_ms)
        self._waiting: deque[GeoQueueJob] = deque()
        self._tracked: set[str] = set()
        self._tasks: set[asyncio.Task[None]] = set()
        self._retry_tasks: set[asyncio.Task[None]] = set()
        self._handler: GeoQueueHandler | None = None
        self._logger = logger
        self._active = 0
        self._stopped = False

    @property
    def active_count(self) -> int:
        return self._active

    def waiting_count(self) -> int:
        return len(self._waiting)

    # Legacy spelling is retained for direct ports and old tests.
    def get_waiting_count(self) -> int:
        return self.waiting_count()

    def set_handler(self, handler: GeoQueueHandler) -> None:
        self._handler = handler
        self._pump()

    async def add(self, data: Mapping[str, Any]) -> None:
        generation_id = str(data.get("geoGenerationId", ""))
        if self._stopped or generation_id in self._tracked:
            return
        self._tracked.add(generation_id)
        self._waiting.append(GeoQueueJob(dict(data), 0))
        self._pump()

    async def shutdown(self) -> None:
        self._stopped = True
        discarded = len(self._waiting)
        self._waiting.clear()
        for task in tuple(self._retry_tasks):
            task.cancel()
        if self._retry_tasks:
            await asyncio.gather(*self._retry_tasks, return_exceptions=True)
        self._retry_tasks.clear()
        if discarded and self._logger is not None:
            log_event(
                self._logger,
                logging.WARNING,
                "queue.discarded_on_shutdown",
                discarded=discarded,
                note="neo-batch stale sweep will reclaim them",
            )

    def _pump(self) -> None:
        if self._handler is None or self._stopped:
            return
        while self._active < self.concurrency and self._waiting:
            job = self._waiting.popleft()
            self._active += 1
            task = asyncio.create_task(self._run(job))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

    async def _run(self, job: GeoQueueJob) -> None:
        generation_id = str(job.data.get("geoGenerationId", ""))
        attempt = job.attempts_made + 1
        started_at = time.monotonic()
        try:
            handler = self._handler
            if handler is None:
                return

            async def invoke() -> None:
                if self._logger is not None:
                    log_event(
                        self._logger,
                        logging.INFO,
                        "job.started",
                        maxAttempts=self.max_attempts,
                        active=self._active,
                        waiting=len(self._waiting),
                    )
                await handler(job)
                if self._logger is not None:
                    log_event(
                        self._logger,
                        logging.INFO,
                        "job.completed",
                        durationMs=round((time.monotonic() - started_at) * 1000),
                        active=self._active - 1,
                        waiting=len(self._waiting),
                    )

            await run_in_job_context(
                {"geoGenerationId": generation_id, "attempt": attempt},
                invoke,
            )
            self._tracked.discard(generation_id)
        except Exception as exc:
            await self._schedule_retry_or_drop(job, exc)
        finally:
            self._active -= 1
            self._pump()

    async def _schedule_retry_or_drop(self, job: GeoQueueJob, error: Exception) -> None:
        generation_id = str(job.data.get("geoGenerationId", ""))
        attempts_done = job.attempts_made + 1
        if self._stopped or attempts_done >= self.max_attempts:
            self._tracked.discard(generation_id)
            if self._logger is not None:
                log_event(
                    self._logger,
                    logging.ERROR,
                    "job.failed",
                    geoGenerationId=generation_id,
                    attempts=attempts_done,
                    maxAttempts=self.max_attempts,
                    err=str(error),
                )
            return
        delay = self.backoff_ms * (2**job.attempts_made) / 1000
        if self._logger is not None:
            log_event(
                self._logger,
                logging.WARNING,
                "job.retrying",
                geoGenerationId=generation_id,
                attempt=attempts_done,
                maxAttempts=self.max_attempts,
                delayMs=round(delay * 1000),
                err=str(error),
            )

        async def retry() -> None:
            try:
                await asyncio.sleep(delay)
                if self._stopped:
                    self._tracked.discard(generation_id)
                    return
                # ``unshift`` in the Node service makes retries lead waiting work.
                self._waiting.appendleft(GeoQueueJob(job.data, attempts_done))
                self._pump()
            finally:
                current = asyncio.current_task()
                if current is not None:
                    self._retry_tasks.discard(current)

        task = asyncio.create_task(retry())
        self._retry_tasks.add(task)
