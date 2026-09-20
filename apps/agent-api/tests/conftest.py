from __future__ import annotations

from collections.abc import AsyncIterator, Mapping
from typing import Any, Protocol, cast

import httpx
import pytest
from fastapi import FastAPI
from neo_agent_api.main import create_app
from neo_agent_api.settings import Settings


class ProcessingRepository:
    """Small in-memory boundary double; routes and validation stay real."""

    def __init__(self, status: str | None = "PROCESSING", *, fails: bool = False) -> None:
        self.status = status
        self.fails = fails

    async def find_status(self, geo_generation_id: str) -> str | None:
        if self.fails:
            raise RuntimeError("database unavailable")
        return self.status


class CapturingQueue:
    def __init__(self, *, waiting: int = 0) -> None:
        self.waiting = waiting
        self.added: list[dict[str, Any]] = []

    def waiting_count(self) -> int:
        return self.waiting

    async def add(self, data: Mapping[str, Any]) -> None:
        self.added.append(dict(data))


class FixedGeneration:
    async def generate(self, data: Mapping[str, Any]) -> dict[str, Any]:
        del data
        return {
            "resultStatus": "SUCCEEDED",
            "jsonLd": {"@type": "Product"},
            "scriptTag": '<script type="application/ld+json">{}</script>',
            "schemaTypes": ["Product"],
            "resultHash": "a" * 64,
            "ragProfile": "pdp-geo-generator-default",
            "diagnostics": {"validationWarnings": []},
            "contentSections": {"productName": "Serum"},
            "generatedAt": "2026-09-10T00:00:00.000Z",
        }


class AppFactory(Protocol):
    def __call__(
        self,
        *,
        api_key: str = "",
        sync_enabled: bool = False,
        queue_waiting: int = 0,
        status: str | None = "PROCESSING",
        repository_fails: bool = False,
    ) -> FastAPI: ...


def capturing_queue(app: FastAPI) -> CapturingQueue:
    """Narrow the known test factory queue after checking its runtime value."""

    queue = getattr(app.state, "queue", None)
    assert isinstance(queue, CapturingQueue)
    return queue


def object_mapping(value: object) -> dict[str, object]:
    """Validate a JSON-object test value before inspecting named fields."""

    if not isinstance(value, dict):
        raise AssertionError("Expected a JSON object")
    raw_mapping = cast(dict[object, object], value)
    mapped: dict[str, object] = {}
    for key, item in raw_mapping.items():
        if not isinstance(key, str):
            raise AssertionError("Expected a JSON object with string keys")
        mapped[key] = item
    return mapped


@pytest.fixture
def app_factory() -> AppFactory:
    def make(
        *,
        api_key: str = "",
        sync_enabled: bool = False,
        queue_waiting: int = 0,
        status: str | None = "PROCESSING",
        repository_fails: bool = False,
    ) -> FastAPI:
        settings = Settings(
            api_key=api_key,
            geo_test_sync_endpoint=sync_enabled,
            queue_max_waiting=1,
            database_url="postgresql+psycopg://unused:unused@localhost:1/unused",
        )
        return create_app(
            settings=settings,
            generation_repository=ProcessingRepository(status, fails=repository_fails),
            queue=CapturingQueue(waiting=queue_waiting),
            generation_service=FixedGeneration(),
        )

    return make


@pytest.fixture
async def client(app_factory: AppFactory) -> AsyncIterator[httpx.AsyncClient]:
    app = app_factory()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as test_client:
        yield test_client
