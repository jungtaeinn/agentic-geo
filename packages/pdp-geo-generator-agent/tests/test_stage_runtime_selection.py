"""Runtime-stage selection regressions retained from the TypeScript agent."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable, Mapping
from typing import Any, cast

import httpx
import pytest

import pdp_geo_generator_agent.content_planning as content_planning
import pdp_geo_generator_agent.final_proofreader as final_proofreader
from pdp_geo_generator_agent.content_planning import ModelBackedContentPlanner
from pdp_geo_generator_agent.final_proofreader import ModelBackedFinalProofreader

_resolve_content_planner = cast(
    Callable[[Mapping[str, Any]], tuple[object | None, str | None]],
    getattr(content_planning, "_resolve_content_planner"),
)
_resolve_proofreader = cast(
    Callable[[Mapping[str, Any]], tuple[object | None, str | None]],
    getattr(final_proofreader, "_resolve_proofreader"),
)


def test_content_planning_uses_runtime_reasoning_deployment_when_stage_and_default_are_absent() -> None:
    """The planning stage retains the TypeScript reasoning-deployment fallback."""

    planner, warning = _resolve_content_planner(
        {
            "provider": "azure-openai",
            "apiKey": "test-key",
            "endpoint": "https://provider.example",
            "deployments": {"reasoning": "runtime-reasoning"},
            "contentPlanning": {"enabled": True},
        }
    )

    assert warning is None
    assert isinstance(planner, ModelBackedContentPlanner)
    assert cast(Mapping[str, Any], planner.planner)["deployment"] == "runtime-reasoning"


def test_final_proofreading_prefers_runtime_proofreading_deployment_before_reasoning_and_default() -> None:
    """Proofreading must not accidentally run on the generic reasoning deployment."""

    proofreader, warning = _resolve_proofreader(
        {
            "provider": "azure-openai",
            "apiKey": "test-key",
            "endpoint": "https://provider.example",
            "deployment": "runtime-default",
            "deployments": {"reasoning": "runtime-reasoning", "proofreading": "runtime-proofreading"},
            "finalProofreading": {"enabled": True},
        }
    )

    assert warning is None
    assert isinstance(proofreader, ModelBackedFinalProofreader)
    assert proofreader.config["deployment"] == "runtime-proofreading"


@pytest.mark.parametrize(
    ("stage_config", "expected_max_output_tokens"),
    [
        pytest.param({}, 6000, id="default"),
        pytest.param({"maxOutputTokens": 1536}, 1536, id="configured"),
    ],
)
def test_model_backed_final_proofreader_requests_ts_compatible_output_cap(
    stage_config: dict[str, Any], expected_max_output_tokens: int
) -> None:
    """The provider request keeps the retained 6000-token default and override."""

    seen: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"output_text": '{"edits":[],"warnings":[]}'})

    result = asyncio.run(
        ModelBackedFinalProofreader(
            {
                "provider": "openai",
                "apiKey": "test-key",
                "model": "test-model",
                "transport": httpx.MockTransport(handler),
                **stage_config,
            }
        ).proofread({"locale": "en-US", "productName": "Glow Serum", "fields": []})
    )

    assert seen["body"]["max_output_tokens"] == expected_max_output_tokens
    assert result["edits"] == []
