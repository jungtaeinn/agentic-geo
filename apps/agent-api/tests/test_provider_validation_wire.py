"""Frozen byte-level transport coverage for the retained AI Studio route."""

from __future__ import annotations

import base64
import hashlib
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from types import TracebackType

import httpx
import pytest
from neo_agent_api.services.provider_validation import validate_provider
from pydantic import BaseModel

_FIXTURE = Path(__file__).with_name("fixtures") / "aistudio-provider-validation-wire.v1.json"


@dataclass(frozen=True)
class _FrozenRequest:
    name: str
    body: bytes
    sha256: str


class _FixtureProvenance(BaseModel):
    legacySourceCommit: str
    legacySourcePaths: list[str]
    legacySourceSha256: str
    runtime: str
    captureMethod: str


class _FixtureRequest(BaseModel):
    name: str
    bodyUtf8Base64: str
    bodySha256: str


class _FixtureContract(BaseModel):
    schemaVersion: int
    provenance: _FixtureProvenance
    requests: list[_FixtureRequest]


def _frozen_requests() -> tuple[_FrozenRequest, ...]:
    fixture = _FixtureContract.model_validate_json(_FIXTURE.read_text(encoding="utf-8"))
    assert fixture.schemaVersion == 1
    assert fixture.provenance == _FixtureProvenance(
        legacySourceCommit="6702158280ec7de675594af93c7c381eb2feae38",
        legacySourcePaths=[
            "apps/geo-generator/src/app/api/provider/validate/route.ts",
            "apps/pdp-extractor/src/app/api/provider/validate/route.ts",
        ],
        legacySourceSha256="049a178b86dfdd19b6ddea22c717ccf66189c6283e3bdc035d327f9c3667964c",
        runtime="Node v24.11.0",
        captureMethod=(
            "At legacySourceCommit, the identical validateAistudio implementations call JSON.stringify(check.body). "
            "Node v24.11.0 captured the UTF-8 bytes and SHA-256 digests below; Python tests replay only these literals."
        ),
    )

    requests: list[_FrozenRequest] = []
    for item in fixture.requests:
        body = base64.b64decode(item.bodyUtf8Base64, validate=True)
        assert hashlib.sha256(body).hexdigest() == item.bodySha256
        requests.append(_FrozenRequest(item.name, body, item.bodySha256))
    return tuple(requests)


@pytest.mark.asyncio
async def test_aistudio_validation_replays_literal_legacy_json_bytes_over_real_mock_transport(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The historical fetch loop sends JSON.stringify bytes, never a client serializer seam."""

    expected = _frozen_requests()
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, content=b"{}", request=request)

    transport = httpx.MockTransport(handler)
    real_async_client = httpx.AsyncClient

    class Client:
        def __init__(self, *, follow_redirects: bool) -> None:
            self._client = real_async_client(transport=transport, follow_redirects=follow_redirects)

        async def __aenter__(self) -> Client:
            return self

        async def __aexit__(
            self,
            _exc_type: type[BaseException] | None,
            _exc_value: BaseException | None,
            _traceback: TracebackType | None,
        ) -> None:
            await self._client.aclose()

        async def post(self, url: str, *, headers: Mapping[str, str], content: bytes) -> httpx.Response:
            return await self._client.post(url, headers=headers, content=content)

    monkeypatch.setattr("neo_agent_api.services.provider_validation.httpx.AsyncClient", Client)
    result = await validate_provider(
        {
            "provider": "aistudio",
            "apiKey": "wire-key",
            "endpoint": "https://studio.example.test/",
            "apiVersion": "2025-04-01-preview",
            "deployments": {"ocr": "reasoner"},
            "embedding": {"deployment": "embedding"},
        }
    )

    assert result == {
        "ok": True,
        "provider": "aistudio",
        "message": "AI Studio Endpoint, API Key, 2개 모델 호출을 확인했습니다.",
        "models": [],
    }
    assert [str(request.url) for request in seen] == [
        "https://studio.example.test/openai/deployments/embedding/embeddings?api-version=2025-04-01-preview",
        "https://studio.example.test/openai/deployments/reasoner/chat/completions?api-version=2025-04-01-preview",
    ]
    assert [request.method for request in seen] == ["POST", "POST"]
    assert [request.headers["content-type"] for request in seen] == ["application/json", "application/json"]
    assert [request.headers["authorization"] for request in seen] == ["Bearer wire-key", "Bearer wire-key"]
    assert [request.content for request in seen] == [item.body for item in expected]
    assert [hashlib.sha256(request.content).hexdigest() for request in seen] == [item.sha256 for item in expected]
