"""Async-safe GEO job correlation context."""

from __future__ import annotations

import contextvars
from collections.abc import Awaitable, Callable

JobContext = dict[str, int | str]
_current: contextvars.ContextVar[JobContext | None] = contextvars.ContextVar("neo_geo_job_context", default=None)


def current_job_context() -> JobContext | None:
    value = _current.get()
    return dict(value) if value is not None else None


async def run_in_job_context[T](context: JobContext, callback: Callable[[], Awaitable[T]]) -> T:
    token = _current.set(dict(context))
    try:
        return await callback()
    finally:
        _current.reset(token)
