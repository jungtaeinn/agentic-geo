from __future__ import annotations

from pathlib import Path

import httpx
import pytest


@pytest.mark.asyncio
async def test_generator_profile_put_and_get_preserve_retained_locale_order(
    client: httpx.AsyncClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PDP_GEO_GENERATOR_RAG_STATE_DIR", str(tmp_path / "generator"))
    written = await client.put(
        "/rag-profile",
        json={
            "target": "generator",
            "analysisPrompt": "Retained prompt",
            "documents": [{"name": name, "content": name} for name in ["Z.md", "a.md", "ä.md"]],
        },
    )
    read = await client.get("/rag-profile")

    assert written.status_code == 200
    assert read.status_code == 200
    assert {
        method: [document["name"] for document in response.json()["generator"]["documents"] if not document["managed"]]
        for method, response in [("PUT", written), ("GET", read)]
    } == {
        "PUT": ["a_v1.md", "ä_v1.md", "Z_v1.md"],
        "GET": ["a_v1.md", "ä_v1.md", "Z_v1.md"],
    }
