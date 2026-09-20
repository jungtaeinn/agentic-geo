"""AI Studio's Azure-compatible generator adapter."""

from __future__ import annotations

from urllib.parse import quote

from .azure_openai import AzureOpenAIProvider

_ENCODE_COMPONENT_SAFE = "-_.!~*'()"


class AistudioProvider(AzureOpenAIProvider):
    """AI Studio gateway variant: Bearer auth and opt-in API-version query."""

    provider_display_name = "AI Studio"
    provider_id = "aistudio"

    def chat_completions_url(self, deployment: object) -> str:
        # Match TypeScript's ``endpoint.replace(/\/$/, "")`` exactly: one
        # trailing slash is removed, while a configured path is retained.
        endpoint = _text(self.endpoint).removesuffix("/")
        version = _text(self.api_version).strip()
        query = f"?api-version={quote(version, safe=_ENCODE_COMPONENT_SAFE)}" if version else ""
        return (
            f"{endpoint}/openai/deployments/{quote(_text(deployment), safe=_ENCODE_COMPONENT_SAFE)}/chat/completions{query}"
        )

    chatCompletionsUrl = chat_completions_url

    def auth_headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {_text(self.api_key)}"}


def _text(value: object) -> str:
    return value if isinstance(value, str) else str(value or "")


__all__ = ["AistudioProvider"]
