"""Offline embedding snapshot support with JavaScript-stable identities."""

from __future__ import annotations

import inspect
import json
from collections.abc import Awaitable, Callable, Iterable, Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

from neo_js_compat import js_embedding_snapshot_key

EmbeddingBatch = Callable[[list[str]], Awaitable[list[list[float]]] | list[list[float]]]


def create_embedding_snapshot_key(text: str) -> str:
    """Return the exact TypeScript ``Math.abs(fnv):text.length`` key."""
    return js_embedding_snapshot_key(text)


def create_empty_pdp_geo_embedding_snapshot(model: str, dimensions: int) -> dict[str, Any]:
    return {
        "model": model,
        "dimensions": dimensions,
        "createdAt": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "entries": {},
    }


async def load_embedding_snapshot(path: str | Path, expected: Mapping[str, object] | None = None) -> dict[str, Any]:
    path_text = str(path)
    raw_parsed: object = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(raw_parsed, dict):
        raise ValueError(
            f"Invalid embedding snapshot at {path_text}: expected {{ model, dimensions, createdAt, entries }}."
        )
    parsed = cast(dict[str, object], raw_parsed)
    if (
        not isinstance(parsed.get("model"), str)
        or not isinstance(parsed.get("dimensions"), int)
        or not isinstance(parsed.get("entries"), dict)
    ):
        raise ValueError(
            f"Invalid embedding snapshot at {path_text}: expected {{ model, dimensions, createdAt, entries }}."
        )
    expectation = dict(expected or {})
    model = cast(str, parsed["model"])
    dimensions = cast(int, parsed["dimensions"])
    if expectation.get("model") and expectation["model"] != model:
        raise ValueError(
            f'Embedding snapshot at {path_text} was built with "{model}" but the query embedder uses "{expectation["model"]}"; re-run the precompute before serving it.'
        )
    if (
        "dimensions" in expectation
        and expectation["dimensions"] is not None
        and expectation["dimensions"] != dimensions
    ):
        raise ValueError(
            f"Embedding snapshot at {path_text} declares {dimensions} dimensions but the query embedder produces {expectation['dimensions']}."
        )
    entries = cast(dict[str, object], parsed["entries"])
    for key, raw_vector in entries.items():
        vector = cast(list[object], raw_vector) if isinstance(raw_vector, list) else None
        if vector is None or len(vector) != dimensions:
            width = len(vector) if vector is not None else "a non-vector"
            raise ValueError(
                f'Embedding snapshot at {path_text} declares {dimensions} dimensions but entry "{key}" holds {width}.'
            )
    return {
        "model": model,
        "dimensions": dimensions,
        "createdAt": parsed.get("createdAt") if isinstance(parsed.get("createdAt"), str) else "",
        "entries": entries,
    }


async def save_embedding_snapshot(path: str | Path, snapshot: Mapping[str, object]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    # JS JSON.stringify(..., null, 2) preserves insertion order and has newline.
    target.write_text(json.dumps(dict(snapshot), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def create_snapshot_backed_embedder(
    snapshot: Mapping[str, object],
    *,
    query_embedder: EmbeddingBatch | object | None = None,
    on_snapshot_miss: Callable[[int, int], object] | None = None,
) -> SnapshotBackedEmbedder:
    return SnapshotBackedEmbedder(snapshot, query_embedder=query_embedder, on_snapshot_miss=on_snapshot_miss)


class SnapshotBackedEmbedder:
    """Adapter implementing the TS ``{ embed(texts) }`` protocol."""

    def __init__(
        self,
        snapshot: Mapping[str, object],
        *,
        query_embedder: EmbeddingBatch | object | None,
        on_snapshot_miss: Callable[[int, int], object] | None,
    ) -> None:
        self.snapshot = snapshot
        self.query_embedder = query_embedder
        self.on_snapshot_miss = on_snapshot_miss

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        raw_entries = self.snapshot.get("entries")
        entries: Mapping[str, object] = cast(Mapping[str, object], raw_entries) if isinstance(raw_entries, Mapping) else {}
        result: list[list[float] | None] = []
        missing: list[int] = []
        for index, text in enumerate(texts):
            vector = entries.get(create_embedding_snapshot_key(text))
            if isinstance(vector, list):
                result.append([float(cast(int | float | str, item)) for item in cast(list[object], vector)])
            else:
                result.append(None)
                missing.append(index)
        if missing:
            if self.on_snapshot_miss is not None:
                self.on_snapshot_miss(len(missing), len(texts))
            if self.query_embedder is None:
                raise ValueError(
                    f"Embedding snapshot ({self.snapshot.get('model')}) is missing {len(missing)}/{len(texts)} text(s) and no queryEmbedder is configured; falling back to deterministic local embeddings."
                )
            embedded = await _embed(self.query_embedder, [texts[index] for index in missing])
            for position, text_index in enumerate(missing):
                vector = embedded[position] if position < len(embedded) else []
                if vector:
                    result[text_index] = vector
        resolved = [vector or [] for vector in result]
        if any(not vector for vector in resolved):
            raise ValueError(
                f"Embedding snapshot ({self.snapshot.get('model')}) could not resolve every text in the batch; falling back to deterministic local embeddings."
            )
        return resolved


async def _embed(embedder: EmbeddingBatch | object, texts: list[str]) -> list[list[float]]:
    method: object = getattr(embedder, "embed", embedder)
    if not callable(method):
        raise TypeError("queryEmbedder must provide embed(texts).")
    value = cast(Callable[[list[str]], object], method)(texts)
    output: object = await cast(Awaitable[object], value) if inspect.isawaitable(value) else value
    return [
        [float(cast(int | float | str, component)) for component in cast(Iterable[object], vector)]
        for vector in cast(Iterable[object], output)
    ]


createPdpGeoEmbeddingSnapshotKey = create_embedding_snapshot_key
createEmptyPdpGeoEmbeddingSnapshot = create_empty_pdp_geo_embedding_snapshot
loadPdpGeoEmbeddingSnapshot = load_embedding_snapshot
savePdpGeoEmbeddingSnapshot = save_embedding_snapshot
createSnapshotBackedPdpGeoEmbedder = create_snapshot_backed_embedder
