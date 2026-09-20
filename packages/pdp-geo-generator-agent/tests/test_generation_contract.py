from __future__ import annotations

import asyncio

from pdp_geo_generator_agent.service import generate_pdp_geo


def test_generation_emits_legacy_stage_ids_and_escapes_jsonld_script_end() -> None:
    events: list[dict[str, object]] = []
    run = asyncio.run(
        generate_pdp_geo(
            {
                "product": {
                    "name": "Glow </script> Serum",
                    "description": "A hydration serum.",
                    "brand": "Neo",
                    "images": ["https://cdn.example.test/glow.jpg"],
                    "faq": [{"question": "How do I use it?", "answer": "Apply after cleansing."}],
                },
                "source": {"url": "https://shop.example.test/products/glow"},
                "hints": {"locale": "en-US"},
            },
            {"onProgress": events.append},
        )
    )

    assert [step["id"] for step in events if step["status"] == "running"] == [
        "input",
        "normalize",
        "rag-load",
        "chunk",
        "embed",
        "retrieve",
        "rerank",
        "generate",
        "repair",
        "validate",
        "quality-gate",
        "artifact",
    ]
    assert [(step["id"], step["status"]) for step in events] == [
        (identifier, status)
        for identifier in [
            "input",
            "normalize",
            "rag-load",
            "chunk",
            "embed",
            "retrieve",
            "rerank",
            "generate",
            "repair",
            "validate",
            "quality-gate",
            "artifact",
        ]
        for status in ["running", "done"]
    ]
    for running, completed in zip(events[::2], events[1::2], strict=True):
        assert "startedAt" in running and "completedAt" not in running
        assert "startedAt" in completed and "completedAt" in completed
    assert [step["id"] for step in run["process"]] == [
        "input",
        "normalize",
        "rag-load",
        "chunk",
        "embed",
        "retrieve",
        "rerank",
        "generate",
        "validate",
        "repair",
        "quality-gate",
        "artifact",
    ]
    script = run["result"]["schemaMarkup"]["scriptTag"]
    assert "</script>" not in script.removesuffix("</script>")
    assert "\\u003c/script>" in script
    assert "WebPage" in run["result"]["schemaMarkup"]["jsonLd"]["@graph"][0]["@type"]
    assert all(step["status"] == "done" for step in run["process"])


def test_generation_preserves_the_legacy_binary64_rag_score() -> None:
    """The deletion-time V8 capture retains this unrounded score beyond metadata precision."""

    run = asyncio.run(
        generate_pdp_geo(
            {
                "product": {
                    "name": "Hydra Barrier Cream",
                    "description": "Daily hydration cream for dry skin.",
                    "brand": "Neo",
                    "benefits": ["Supports hydration"],
                    "ingredients": ["Ceramide"],
                    "usage": ["Apply after serum."],
                },
                "hints": {"locale": "en-US", "market": "US", "brand": "Neo"},
            }
        )
    )

    selected = next(
        chunk
        for chunk in run["diagnostics"]["selectedRagChunks"]
        if chunk["id"] == "content-field-contracts-v1-md-15"
    )
    assert selected["score"] == 0.9891030638603792
