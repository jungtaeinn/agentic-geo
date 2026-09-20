"""AI Studio gateway variant of the Azure deployment-scoped adapter."""

from __future__ import annotations

from urllib.parse import quote

from .azure_openai import AzureOpenAIProvider

_ENCODE_COMPONENT_SAFE = "-_.!~*'()"


class AistudioProvider(AzureOpenAIProvider):
    """Azure-compatible AI Studio gateway with Bearer authentication."""

    def chat_completions_url(self, deployment: object) -> str:
        # This intentionally removes just one slash, matching
        # ``endpoint?.replace(/\/$/, "")`` in the retained adapter.
        endpoint = _coerce_text(self.endpoint).removesuffix("/")
        api_version = _coerce_text(self.api_version).strip()
        query = f"?api-version={quote(api_version, safe=_ENCODE_COMPONENT_SAFE)}" if api_version else ""
        return f"{endpoint}/openai/deployments/{deployment}/chat/completions{query}"

    def auth_headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key}"}


AistudioKeywordClassifier = AistudioProvider


def _coerce_text(value: object) -> str:
    """Mirror the base adapter's deferred request-boundary coercion."""

    return value if isinstance(value, str) else str(value or "")
