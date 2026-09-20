"""Console timeout propagation for long-running model stages."""

from __future__ import annotations

from neo_agent_api.services.console_orchestration import runtime_config


def test_console_runtime_preserves_positive_llm_timeout_for_nested_model_stages() -> None:
    """Dropping this field made every stage silently fall back to a five-minute request."""

    runtime = runtime_config(
        {
            "llm": {"provider": "aistudio", "timeoutSeconds": 930},
            "copyRefinement": {"enabled": True, "timeoutSeconds": 975},
        },
        {
            "provider": "aistudio",
            "apiKey": "server-key",
            "endpoint": "https://studio.example",
            "deployment": "reasoning",
            "_providerDefaults": {},
        },
    )

    assert runtime["timeoutSeconds"] == 930
    assert runtime["contentPlanning"]["timeoutSeconds"] == 930
    assert runtime["productNormalization"]["timeoutSeconds"] == 930
    assert runtime["finalProofreading"]["timeoutSeconds"] == 930
    assert runtime["copyRefinement"]["timeoutSeconds"] == 975
