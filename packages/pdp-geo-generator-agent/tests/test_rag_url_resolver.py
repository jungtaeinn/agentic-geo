"""Security contracts for the built-in PDP GEO RAG URL resolver."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Sequence

import httpx
import pytest
from pytest import MonkeyPatch

from pdp_geo_generator_agent.rag.retrieval import FetchRagUrlResolver

type ResponseHandler = Callable[[httpx.Request], httpx.Response | Awaitable[httpx.Response]]


async def _resolve_with_mock_transport(
    monkeypatch: MonkeyPatch,
    url: str,
    handler: ResponseHandler,
    *,
    allowed_domains: Sequence[str] = (),
) -> tuple[dict[str, object] | None, list[str]]:
    """Exercise the real resolver while replacing only the external socket."""

    requests: list[str] = []

    async def recorded_handler(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        value = handler(request)
        return await value if isinstance(value, Awaitable) else value

    transport = httpx.MockTransport(recorded_handler)
    original_client = httpx.AsyncClient

    def client_with_transport(*, timeout: float, follow_redirects: bool = True) -> httpx.AsyncClient:
        return original_client(timeout=timeout, follow_redirects=follow_redirects, transport=transport)

    monkeypatch.setattr(httpx, "AsyncClient", client_with_transport)
    resolver = FetchRagUrlResolver(
        {"allowedUrlDomains": list(allowed_domains), "urlFetchTimeoutMs": 500}
    )
    return await resolver.resolve({"url": url}), requests


@pytest.mark.parametrize(
    "url",
    [
        "http://2130706433/",
        "http://0x7f000001/",
        "http://0177.0.0.1/",
        "http://127.1/",
        "http://loop.localhost/",
        "http://10.1.2.3/",
        "http://172.16.0.1/",
        "http://192.168.0.1/",
        "http://169.254.1.2/",
        "http://[::1]/",
        "http://[fc00::1]/",
    ],
)
def test_builtin_resolver_rejects_canonical_private_and_loopback_destinations_before_request(
    monkeypatch: MonkeyPatch, url: str
) -> None:
    """Numeric aliases must be WHATWG-normalized before the address policy.

    The literals were captured from the retained ``safePublicUrl`` source at
    origin/main 6702158280ec7de675594af93c7c381eb2feae38 with Node v24.11.0.
    The IPv6 unique-local case is deliberately stricter than the old source:
    it is a private address and must never receive a built-in fetch.
    """

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"Content-Type": "text/plain"}, text="must not be fetched")

    resolved, requests = asyncio.run(_resolve_with_mock_transport(monkeypatch, url, handler))

    assert resolved is None
    assert requests == []


def test_builtin_resolver_canonicalizes_allowlisted_effective_url_and_rejects_credentials_and_nondefault_ports(
    monkeypatch: MonkeyPatch,
) -> None:
    """The request and returned identity use Ada's canonical public URL."""

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"Content-Type": "text/plain"},
            text="Canonical public URL content.",
        )

    resolved, requests = asyncio.run(
        _resolve_with_mock_transport(
            monkeypatch,
            "https://Sub.PUBLIC.Example./a/../guide",
            handler,
            allowed_domains=("PUBLIC.EXAMPLE.",),
        )
    )

    assert requests == ["https://sub.public.example/guide"]
    assert resolved == {
        "url": "https://sub.public.example/guide",
        "title": "https://sub.public.example/guide",
        "content": "Canonical public URL content.",
        "sourceType": "web-page",
    }

    for unsafe_url in ("https://user:password@public.example/", "https://public.example:8443/"):
        rejected, rejected_requests = asyncio.run(
            _resolve_with_mock_transport(monkeypatch, unsafe_url, handler, allowed_domains=("public.example",))
        )
        assert rejected is None
        assert rejected_requests == []


def test_builtin_resolver_revalidates_redirects_before_a_second_request(monkeypatch: MonkeyPatch) -> None:
    """A public first hop must not turn a redirect into a loopback fetch."""

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"Location": "http://127.1/internal"})

    resolved, requests = asyncio.run(_resolve_with_mock_transport(monkeypatch, "https://public.example/start", handler))

    assert resolved is None
    assert requests == ["https://public.example/start"]


def test_builtin_resolver_returns_the_effective_public_redirect_url(monkeypatch: MonkeyPatch) -> None:
    """Redirect results retain the canonical target, not the requested source URL."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/start":
            return httpx.Response(302, headers={"Location": "/docs/../guide"})
        return httpx.Response(
            200,
            headers={"Content-Type": "text/html; charset=utf-8"},
            text="<title>Public guide</title><p>Safe public text.</p>",
        )

    resolved, requests = asyncio.run(_resolve_with_mock_transport(monkeypatch, "https://public.example/start", handler))

    assert requests == ["https://public.example/start", "https://public.example/guide"]
    assert resolved == {
        "url": "https://public.example/guide",
        "title": "Public guide",
        "content": "Public guide Safe public text.",
        "sourceType": "web-page",
    }


def test_builtin_resolver_stops_after_a_bounded_redirect_chain(monkeypatch: MonkeyPatch) -> None:
    """A looping public redirect cannot consume HTTPX's broader redirect budget."""

    hops = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal hops
        hops += 1
        return httpx.Response(302, headers={"Location": f"/hop-{hops}"})

    resolved, requests = asyncio.run(_resolve_with_mock_transport(monkeypatch, "https://public.example/hop-0", handler))

    assert resolved is None
    assert requests == [
        "https://public.example/hop-0",
        "https://public.example/hop-1",
        "https://public.example/hop-2",
        "https://public.example/hop-3",
        "https://public.example/hop-4",
    ]


@pytest.mark.parametrize(
    ("content_type", "accepted"),
    [
        ("text/html; charset=utf-8", True),
        ("text/plain", True),
        ("text/markdown", True),
        ("application/json", True),
        ("application/xhtml+xml", True),
        ("", True),
        ("image/png", False),
        ("application/pdf", False),
    ],
)
def test_builtin_resolver_applies_source_captured_content_type_policy(
    monkeypatch: MonkeyPatch, content_type: str, accepted: bool
) -> None:
    """Only the legacy text media families (or omitted type) are readable.

    The accepted media families are literal source-captured results from
    ``isSupportedUrlContentType`` in origin/main retrieval.ts (Node v24.11.0).
    """

    def handler(_: httpx.Request) -> httpx.Response:
        headers = {"Content-Type": content_type} if content_type else {}
        return httpx.Response(200, headers=headers, text="Readable response content.")

    resolved, requests = asyncio.run(_resolve_with_mock_transport(monkeypatch, "https://public.example/content", handler))

    assert requests == ["https://public.example/content"]
    assert (resolved is not None) is accepted


def test_builtin_resolver_caps_read_and_returned_content(monkeypatch: MonkeyPatch) -> None:
    """Large text responses remain bounded at 180k read / 40k returned characters."""

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"Content-Type": "text/plain"}, text=("A" * 180_000) + ("B" * 512))

    resolved, requests = asyncio.run(_resolve_with_mock_transport(monkeypatch, "https://public.example/large", handler))

    assert requests == ["https://public.example/large"]
    assert resolved is not None
    assert resolved["content"] == "A" * 40_000
