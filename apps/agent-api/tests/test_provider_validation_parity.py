from __future__ import annotations

from typing import Any

import pytest
from neo_agent_api.services.provider_validation import validate_provider


class _Response:
    def __init__(self, status_code: int, payload: object) -> None:
        self.status_code = status_code
        self._payload = payload

    def json(self) -> object:
        return self._payload


@pytest.mark.asyncio
async def test_azure_input_contract_checks_every_requested_deployment_in_next_route_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Client:
        def __init__(self, **_kwargs: object) -> None:
            pass

        async def __aenter__(self) -> Client:
            return self

        async def __aexit__(self, *_args: object) -> bool:
            return False

        async def get(self, *_args: object, **_kwargs: object) -> _Response:
            return _Response(200, {"data": [{"id": "ocr"}, {"id": "reasoning"}, {"id": "embedding"}]})

    monkeypatch.setattr("neo_agent_api.services.provider_validation.httpx.AsyncClient", Client)
    result = await validate_provider(
        {
            "provider": "azure-openai",
            "apiKey": "key",
            "endpoint": "https://azure.example.com",
            "deployment": "legacy-fallback",
            "deployments": {"ocr": "ocr", "reasoning": "reasoning", "embedding": "embedding"},
            "reranker": {"provider": "cohere", "apiKey": "rerank-key", "endpoint": "https://rerank.example.com"},
        }
    )

    assert result == {
        "ok": False,
        "provider": "azure-openai",
        "message": "Azure API 연결은 되었지만 'legacy-fallback' 배포를 확인하지 못했습니다.",
        "details": (
            "Azure AI Foundry 또는 Azure Portal에서 역할별 deployment 이름을 확인하거나 모델 목록에서 선택해주세요."
        ),
    }


@pytest.mark.asyncio
async def test_aistudio_input_contract_keeps_embedding_then_unique_chat_check_wire_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, Any]] = []

    class Client:
        def __init__(self, **_kwargs: object) -> None:
            pass

        async def __aenter__(self) -> Client:
            return self

        async def __aexit__(self, *_args: object) -> bool:
            return False

        async def post(self, url: str, **kwargs: Any) -> _Response:
            calls.append({"url": url, **kwargs})
            return _Response(200, {})

    monkeypatch.setattr("neo_agent_api.services.provider_validation.httpx.AsyncClient", Client)
    result = await validate_provider(
        {
            "provider": "aistudio",
            "apiKey": "key",
            "endpoint": "https://studio.example.com/",
            "apiVersion": "2025-04-01-preview",
            "deployment": "fallback",
            "deployments": {"ocr": "ocr", "reasoning": "reasoning"},
            "embedding": {"deployment": "embedding"},
        }
    )

    assert result == {
        "ok": True,
        "provider": "aistudio",
        "message": "AI Studio Endpoint, API Key, 4개 모델 호출을 확인했습니다.",
        "models": [],
    }
    assert [call["url"] for call in calls] == [
        "https://studio.example.com/openai/deployments/embedding/embeddings?api-version=2025-04-01-preview",
        "https://studio.example.com/openai/deployments/ocr/chat/completions?api-version=2025-04-01-preview",
        "https://studio.example.com/openai/deployments/reasoning/chat/completions?api-version=2025-04-01-preview",
        "https://studio.example.com/openai/deployments/fallback/chat/completions?api-version=2025-04-01-preview",
    ]
    assert calls[0]["headers"] == {"Content-Type": "application/json", "Authorization": "Bearer key"}
