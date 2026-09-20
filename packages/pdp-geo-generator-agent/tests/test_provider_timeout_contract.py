"""Model-stage timeout contracts for the Python provider migration."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

import httpx
import pytest

from pdp_geo_generator_agent.copy_refiner import ModelBackedCopyRefiner, resolve_copy_refiner
from pdp_geo_generator_agent.providers import AistudioProvider, create_provider
from pdp_geo_generator_agent.providers.transport import post_json_with_temperature_fallback

_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {"answer": {"type": "string"}},
    "required": ["answer"],
}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("configured_timeout", "expected_seconds"),
    [
        pytest.param(None, 900, id="direct-default"),
        pytest.param({}, 900, id="factory-default"),
        pytest.param({"timeoutSeconds": 300}, 900, id="factory-below-floor"),
        pytest.param({"timeoutSeconds": 960}, 960, id="factory-positive-override"),
        pytest.param({"timeoutSeconds": 0}, 900, id="factory-non-positive-fallback"),
    ],
)
async def test_aistudio_model_timeout_is_generous_and_never_exposes_credentials(
    configured_timeout: dict[str, int] | None, expected_seconds: int
) -> None:
    """A removed/defaulted timeout would prematurely abort long AI Studio work."""

    async def empty_timeout(_: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("")

    if configured_timeout is None:
        generator = AistudioProvider(
            api_key="studio-key",
            endpoint="https://studio.example",
            deployment="reasoning",
            transport=httpx.MockTransport(empty_timeout),
        )
    else:
        generator = cast(
            AistudioProvider,
            create_provider(
                {
                    "provider": "aistudio",
                    "apiKey": "studio-key",
                    "endpoint": "https://studio.example",
                    "deployment": "reasoning",
                    "transport": httpx.MockTransport(empty_timeout),
                    **configured_timeout,
                }
            ),
        )

    with pytest.raises(RuntimeError) as raised:
        await generator.generate_json(
            "system",
            "facts",
            _SCHEMA,
            "plan",
            label="AI Studio content planning",
        )

    assert str(raised.value) == f"AI Studio content planning timed out after {expected_seconds}s."
    assert "studio-key" not in str(raised.value)


def test_copy_refiner_inherits_or_overrides_the_model_timeout_without_losing_stage_scope() -> None:
    """Dropping this setting made the nested copy call revert to a short timeout."""

    inherited, inherited_warning = resolve_copy_refiner(
        {
            "provider": "aistudio",
            "apiKey": "studio-key",
            "endpoint": "https://studio.example",
            "deployment": "reasoning",
            "timeoutSeconds": 930,
            "copyRefinement": {"enabled": True},
        }
    )
    overridden, overridden_warning = resolve_copy_refiner(
        {
            "provider": "aistudio",
            "apiKey": "studio-key",
            "endpoint": "https://studio.example",
            "deployment": "reasoning",
            "timeoutSeconds": 930,
            "copyRefinement": {"enabled": True, "timeoutSeconds": 975},
        }
    )

    assert inherited_warning is None
    assert overridden_warning is None
    assert isinstance(inherited, ModelBackedCopyRefiner)
    assert isinstance(overridden, ModelBackedCopyRefiner)
    assert cast(Mapping[str, Any], inherited.config)["timeoutSeconds"] == 930
    assert cast(Mapping[str, Any], overridden.config)["timeoutSeconds"] == 975


@pytest.mark.asyncio
async def test_timeout_exceptions_remain_actionable_when_the_transport_has_an_empty_message() -> None:
    """The stream terminal error must name the failed stage instead of becoming blank."""

    async def empty_timeout(_: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("")

    provider = AistudioProvider(
        api_key="studio-key",
        endpoint="https://studio.example",
        deployment="reasoning",
        transport=httpx.MockTransport(empty_timeout),
    )

    with pytest.raises(RuntimeError, match=r"AI Studio copy refinement timed out after 900s\."):
        await provider.generate_json(
            "system",
            "facts",
            _SCHEMA,
            "plan",
            stage="copy-refinement",
            label="AI Studio copy refinement",
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("configured_timeout", [0, 300])
async def test_direct_provider_and_transport_enforce_the_model_timeout_floor(configured_timeout: int) -> None:
    """Every entry point retains the 15-minute floor, not only the config factory."""

    async def empty_timeout(_: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("")

    provider = AistudioProvider(
        api_key="studio-key",
        endpoint="https://studio.example",
        deployment="reasoning",
        timeout_seconds=configured_timeout,
        transport=httpx.MockTransport(empty_timeout),
    )

    with pytest.raises(RuntimeError, match=r"AI Studio direct provider timed out after 900s\."):
        await provider.generate_json(
            "system",
            "facts",
            _SCHEMA,
            "plan",
            label="AI Studio direct provider",
        )
    with pytest.raises(RuntimeError, match=r"AI Studio direct transport timed out after 900s\."):
        await post_json_with_temperature_fallback(
            "https://studio.example/chat/completions",
            {"api-key": "studio-key"},
            {"messages": []},
            "AI Studio direct transport",
            timeout_seconds=configured_timeout,
            transport=httpx.MockTransport(empty_timeout),
        )
