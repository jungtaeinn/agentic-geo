"""Scoped Langfuse observations for the opt-in synchronous GEO endpoint."""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable, Mapping
from contextlib import nullcontext
from typing import Any, TypeVar

from neo_agent_api._json import as_dict, as_list

T = TypeVar("T")
ClientFactory = Callable[..., Any]
PropagationFactory = Callable[..., Any]


class Tracer:
    def __init__(
        self, client: Any | None = None, *, propagate_attributes_factory: PropagationFactory | None = None
    ) -> None:
        self._client = client
        self._propagate_attributes = propagate_attributes_factory or _default_propagate_attributes
        self.enabled = client is not None

    async def run_sync_generation(
        self,
        callback: Callable[[], Awaitable[T]],
        *,
        geo_generation_id: str | None = None,
        input_payload: Mapping[str, Any] | None = None,
        runtime_usage: Callable[[], object] | None = None,
    ) -> T:
        client = self._client
        if client is None:
            return await callback()
        propagation = (
            self._propagate_attributes(session_id=geo_generation_id, tags=["geo-test-sync"])
            if geo_generation_id is not None
            else nullcontext()
        )
        # Langfuse v4 propagation sets first-class trace/session/tag fields;
        # the controller's geo id remains observation metadata as in Nest.
        with propagation:
            observation = client.start_as_current_observation(
                name="geo-test-generation",
                as_type="generation",
            )
            with observation as span:
                span.update(
                    input=dict(input_payload or {}),
                    metadata={"geoGenerationId": geo_generation_id} if geo_generation_id is not None else {},
                )
                try:
                    result = await callback()
                except Exception as exc:
                    # Keep the client-side error correlated without replacing the
                    # generation exception that controls the legacy HTTP response.
                    span.update(level="ERROR", status_message=str(exc))
                    raise
                self._record_model_calls(client, runtime_usage() if runtime_usage is not None else None)
                span.update(output=result)
                return result

    def _record_model_calls(self, client: Any, usage: object) -> None:
        """Emit the retained per-step child observations within the root span."""

        for raw_step in as_list(as_dict(usage).get("steps")):
            step = as_dict(raw_step)
            if not step.get("called"):
                continue
            label = step.get("label")
            if not isinstance(label, str):
                continue
            token_usage = as_dict(step.get("tokenUsage"))
            usage_details = {
                target: token_usage[source]
                for source, target in (
                    ("inputTokens", "input"),
                    ("outputTokens", "output"),
                    ("totalTokens", "total"),
                )
                if source in token_usage and token_usage[source] is not None
            }
            model = step.get("model") if step.get("model") is not None else step.get("deployment")
            attributes: dict[str, Any] = {
                "name": label,
                "as_type": "embedding" if step.get("stage") == "embedding" else "generation",
                "model": model,
                "metadata": {
                    "stage": step.get("stage"),
                    "provider": step.get("provider"),
                    "service": step.get("service"),
                    "mode": step.get("mode"),
                    "details": step.get("details"),
                },
            }
            if usage_details:
                attributes["usage_details"] = usage_details
            client.start_observation(**attributes).end()

    async def flush(self) -> None:
        if self._client is None:
            return
        outcome = self._client.flush()
        if inspect.isawaitable(outcome):
            await outcome


def _default_client_factory(**kwargs: Any) -> Any:
    from langfuse import Langfuse

    return Langfuse(**kwargs)


def _default_propagate_attributes(**kwargs: Any) -> Any:
    from langfuse import propagate_attributes

    return propagate_attributes(**kwargs)


def create_tracer(
    public_key: str,
    secret_key: str,
    base_url: str | None = None,
    *,
    client_factory: ClientFactory | None = None,
    propagate_attributes_factory: PropagationFactory | None = None,
) -> Tracer:
    """Leave tracing entirely inert unless both retained Langfuse keys exist."""

    if not public_key or not secret_key:
        return Tracer()
    kwargs: dict[str, Any] = {"public_key": public_key, "secret_key": secret_key}
    if base_url is not None:
        kwargs["base_url"] = base_url
    return Tracer(
        (client_factory or _default_client_factory)(**kwargs),
        propagate_attributes_factory=propagate_attributes_factory,
    )
