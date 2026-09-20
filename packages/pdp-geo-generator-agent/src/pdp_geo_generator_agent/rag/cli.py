"""Offline command-line utilities retained from the TypeScript RAG scripts."""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import re
import sys
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

import httpx
from neo_js_compat import js_json_bytes, js_number_to_string, js_to_fixed

from .._json import as_dict, as_list
from .default_profile import DEFAULT_PDP_GEO_GENERATOR_RAG_PROFILE
from .embedding_snapshot import (
    create_embedding_snapshot_key,
    create_empty_pdp_geo_embedding_snapshot,
    save_embedding_snapshot,
)
from .eval import (
    create_pdp_geo_rag_eval_delta,
    load_pdp_geo_rag_eval_baseline,
    run_pdp_geo_rag_eval,
)
from .index_skeleton import create_pdp_geo_rag_index_skeleton, render_pdp_geo_rag_index_skeleton
from .profile_store import read_pdp_geo_generator_rag_profile
from .retrieval import chunk_pdp_geo_rag_document, create_pdp_geo_contextual_retrieval_text

_URL = re.compile(r"https?://[^\s<>\"')\]]+", re.IGNORECASE)


def index_skeleton_main(argv: Sequence[str] | None = None) -> int:
    """Print the reviewable typed-index skeleton, optionally as JSON."""

    parser = argparse.ArgumentParser(prog="pdp-geo-rag-index-skeleton")
    parser.add_argument("--json", action="store_true", dest="as_json")
    args = parser.parse_args(argv)
    profile = asyncio.run(read_pdp_geo_generator_rag_profile())
    rows = create_pdp_geo_rag_index_skeleton([as_dict(item) for item in as_list(profile.get("documents"))])
    if args.as_json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return 0
    for row in rows:
        sections = as_list(row.get("sections"))
        indexed = len(sections) - int(row.get("unindexedSectionCount", 0))
        suffix = "" if row.get("documentIndexed") else " (NO DOCUMENT-LEVEL ENTRY)"
        print(
            f"{row.get('document', '')} [{row.get('kind', 'custom')}] — sections indexed {indexed}/{len(sections)}{suffix}"
        )
    rendered = render_pdp_geo_rag_index_skeleton(rows)
    print(
        "\n--- paste-ready section entries for unindexed headings ---\n"
        if rendered
        else "\nAll document headings resolve to typed rag-index routing."
    )
    if rendered:
        print(rendered)
    return 0


def generate_fallback_main(argv: Sequence[str] | None = None) -> int:
    """Generate a byte-preserving JSON fallback from the shipped resources."""

    parser = argparse.ArgumentParser(prog="pdp-geo-rag-generate-fallback")
    parser.add_argument("--out", default="default-profile-fallback.generated.json")
    args = parser.parse_args(argv)
    profile = DEFAULT_PDP_GEO_GENERATOR_RAG_PROFILE
    payload = {
        "analysisPrompt": profile["analysisPrompt"],
        "documents": {str(item["name"]): item["content"] for item in profile["documents"]},
    }
    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"generated {output} with {len(payload['documents'])} documents")
    return 0


def ingest_sources_main(argv: Sequence[str] | None = None) -> int:
    """Fetch external source links once and print human-review evidence cards."""

    parser = argparse.ArgumentParser(prog="pdp-geo-rag-ingest-sources")
    parser.add_argument("--document", default="geo-research_v3.md")
    parser.add_argument("--limit", type=int, default=30)
    args = parser.parse_args(argv)
    profile = asyncio.run(read_pdp_geo_generator_rag_profile())
    document = next(
        (as_dict(item) for item in as_list(profile.get("documents")) if as_dict(item).get("name") == args.document),
        None,
    )
    if document is None:
        print(f"Document not found in RAG profile: {args.document}", file=sys.stderr)
        return 1
    urls = _extract_urls(str(document.get("content") or ""))[: max(0, args.limit)]
    print(f"# Evidence card skeletons from {args.document} ({len(urls)} source link(s))\n")
    with httpx.Client(
        timeout=10.0, follow_redirects=True, headers={"User-Agent": "pdp-geo-generator-agent-ingest/0.1"}
    ) as client:
        for url in urls:
            title, extract = _fetch_source(client, url)
            print(f"### {title or 'TODO: source title'}\n")
            print(
                f"- Source: {url} · Status: TODO(peer-reviewed|preprint|draft) · Checked: {datetime.now(UTC).date().isoformat()}"
            )
            print(
                f"- Raw extract (distill into claims, do not paste verbatim): {extract[:500]}"
                if extract
                else "- Raw extract: (fetch failed — distill manually from the source)"
            )
            print("- Claim: TODO. Applies to: TODO(fieldTargets).")
            print("- Do not use: TODO.\n")
    print("Merge distilled cards into the versioned RAG evidence corpus after human review.")
    return 0


def precompute_embeddings_main(argv: Sequence[str] | None = None) -> int:
    """Build a committed OpenAI embedding snapshot for the static corpus."""

    parser = argparse.ArgumentParser(prog="pdp-geo-rag-precompute-embeddings")
    parser.add_argument("--model", default=os.environ.get("EMBEDDING_MODEL", "text-embedding-3-small"))
    parser.add_argument(
        "--out", default="src/pdp_geo_generator_agent/resources/rag/embeddings/embedding-snapshot_v1.json"
    )
    args = parser.parse_args(argv)
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        print("OPENAI_API_KEY is required (offline precompute only; nothing runs at generation time).", file=sys.stderr)
        return 1
    profile = asyncio.run(read_pdp_geo_generator_rag_profile())
    texts: dict[str, str] = {}
    for raw_document in as_list(profile.get("documents")):
        document = as_dict(raw_document)
        for chunk in chunk_pdp_geo_rag_document(
            str(document.get("name") or ""), str(document.get("content") or ""), str(document.get("version") or "v1")
        ):
            text = create_pdp_geo_contextual_retrieval_text(chunk)
            texts[create_embedding_snapshot_key(text)] = text
    snapshot = create_empty_pdp_geo_embedding_snapshot(str(args.model), 0)
    entries = list(texts.items())
    print(f"Embedding {len(entries)} unique corpus chunk(s) with {args.model}...")
    with httpx.Client(timeout=60.0) as client:
        for start in range(0, len(entries), 64):
            batch = entries[start : start + 64]
            response = client.post(
                "https://api.openai.com/v1/embeddings",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                content=js_json_bytes({"model": args.model, "input": [text for _, text in batch]}),
            )
            if response.status_code >= 400:
                print(f"OpenAI embeddings failed: {response.status_code} {response.text[:300]}", file=sys.stderr)
                return 1
            data = as_list(as_dict(response.json()).get("data"))
            vectors = {int(as_dict(item).get("index", -1)): as_list(as_dict(item).get("embedding")) for item in data}
            for index, (key, _) in enumerate(batch):
                vector = [float(item) for item in vectors.get(index, []) if isinstance(item, int | float)]
                if vector:
                    entries_by_key = snapshot["entries"]
                    if isinstance(entries_by_key, dict):
                        entries_by_key[key] = vector
                    snapshot["dimensions"] = len(vector)
            print(f"  {min(start + len(batch), len(entries))}/{len(entries)}")
    asyncio.run(save_embedding_snapshot(args.out, snapshot))
    print(
        f"Wrote {len(as_dict(snapshot['entries']))} embedding(s) ({snapshot['dimensions']}d, {args.model}) to {args.out}"
    )
    return 0


def eval_main(argv: Sequence[str] | None = None) -> int:
    """Run the retained deterministic golden retrieval benchmark without network access."""

    parser = argparse.ArgumentParser(prog="pdp-geo-rag-eval")
    parser.add_argument("--json", action="store_true", dest="as_json")
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--out", default=".pdp-geo-generator-rag/baseline.json")
    args = parser.parse_args(argv)
    result = asyncio.run(run_pdp_geo_rag_eval())
    anchors = [str(item) for item in as_list(result.get("unresolvableAnchors")) if isinstance(item, str)]
    if anchors:
        if args.as_json:
            print(json.dumps({"status": "error", "unresolvableAnchors": anchors}, ensure_ascii=False, indent=2))
        else:
            print("Unresolvable golden anchors (fix frozen RAG goldens):", file=sys.stderr)
            for anchor in anchors:
                print(f"  - {anchor}", file=sys.stderr)
        return 1

    generated_at = datetime.now(UTC).date().isoformat()
    baseline_file = load_pdp_geo_rag_eval_baseline()
    baseline = as_dict(baseline_file.get("aggregates"))
    aggregates = as_dict(result.get("aggregates"))
    delta = create_pdp_geo_rag_eval_delta(aggregates, baseline) if baseline else None
    wire_aggregates = _typescript_json_wire_value(aggregates)
    wire_baseline = _typescript_json_wire_value(baseline)
    wire_delta = _typescript_json_wire_value(delta)
    wire_scores = _typescript_json_wire_value(as_list(result.get("scores")))
    if args.as_json:
        payload: dict[str, object] = {
            "status": "ok",
            "generatedAt": generated_at,
            "aggregates": wire_aggregates,
        }
        if baseline:
            payload["baseline"] = wire_baseline
            payload["baselineGeneratedAt"] = baseline_file.get("generatedAt")
            payload["deltaVsBaseline"] = wire_delta
        # Retained ``run-rag-eval.ts`` serializes scores last.  Insertion order
        # is part of the CLI's stable machine-readable JSON wire contract.
        payload["scores"] = wire_scores
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        if args.write:
            _write_rag_eval_baseline(Path(args.out), generated_at, wire_aggregates)
        return 0

    _print_rag_eval_report(
        [as_dict(item) for item in as_list(result.get("scores"))],
        aggregates,
        delta if isinstance(delta, Mapping) else {},
        baseline_file,
        args.out,
    )
    if args.write:
        _write_rag_eval_baseline(Path(args.out), generated_at, wire_aggregates)
        print(f"Baseline written to {args.out}")
    return 0


def _write_rag_eval_baseline(target: Path, generated_at: str, aggregates: object) -> None:
    """Persist only after the report, matching legacy write-failure chronology."""

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps({"generatedAt": generated_at, "aggregates": aggregates}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _typescript_json_wire_value(value: object) -> object:
    """Match ``JSON.stringify``'s integral-number spelling without mutating metrics.

    The evaluator intentionally retains Python floats while computing aggregate
    scores.  JavaScript serializes finite integral numbers as ``1``/``0``;
    Python's encoder emits ``1.0``/``0.0``.  Convert only the output DTO and
    preserve mapping/list insertion order, which is also observable to CLI
    consumers that hash the retained JSON wire.
    """

    if isinstance(value, float):
        return int(value) if math.isfinite(value) and value.is_integer() else value
    if isinstance(value, Mapping):
        mapping = cast(Mapping[object, object], value)
        return {str(key): _typescript_json_wire_value(item) for key, item in mapping.items()}
    if isinstance(value, list):
        return [_typescript_json_wire_value(item) for item in cast(list[object], value)]
    if isinstance(value, tuple):
        return [_typescript_json_wire_value(item) for item in cast(tuple[object, ...], value)]
    return value


def _print_rag_eval_report(
    scores: Sequence[Mapping[str, object]],
    aggregates: Mapping[str, object],
    delta: Mapping[str, object],
    baseline_file: Mapping[str, object],
    baseline_path: str,
) -> None:
    """Keep the readable report structurally aligned with scripts/run-rag-eval.ts."""

    print("Per-golden scores:")
    for score in scores:
        classification = as_dict(score.get("classification"))
        claim_recall = _number(score.get("claimRecall"))
        flag = " *" if claim_recall < 1 else ""
        print(
            f"  {str(score.get('goldenId') or '').ljust(18)} "
            f"target={str(score.get('target') or '').ljust(18)} "
            f"claimR={js_to_fixed(claim_recall, 2)} "
            f"clsP={js_to_fixed(_number(classification.get('precision')), 2)} "
            f"clsR={js_to_fixed(_number(classification.get('recall')), 2)} "
            f"acc={js_to_fixed(_number(classification.get('accuracy')), 2)} "
            f"cm={int(_number(classification.get('tp')))}/{int(_number(classification.get('fp')))}/"
            f"{int(_number(classification.get('fn')))}/{int(_number(classification.get('tn')))} "
            f"noise={js_to_fixed(_number(score.get('noiseChunkRate')), 2)} "
            f"selected={int(_number(score.get('retrievedCount')))}{flag}"
        )
        for missed in as_list(score.get("missedAnchors")):
            print(f"      missed: {missed}")

    classification = as_dict(aggregates.get("classification"))
    delta_classification = as_dict(delta.get("classification"))
    print("\nAggregates:")
    print(f"  goldens           {int(_number(aggregates.get('goldens')))}")
    print(f"  claim recall      {_number_text(aggregates.get('claimRecall'))}{_format_delta(delta.get('claimRecall'))}")
    print(
        f"  context precision {_number_text(aggregates.get('contextPrecision'))}"
        f"{_format_delta(delta.get('contextPrecision'))}"
    )
    print(
        f"  class precision   {_number_text(classification.get('precision'))}"
        f"{_format_delta(delta_classification.get('precision'))}"
    )
    print(
        f"  class recall      {_number_text(classification.get('recall'))}"
        f"{_format_delta(delta_classification.get('recall'))}"
    )
    print(
        f"  class accuracy    {_number_text(classification.get('accuracy'))}"
        f"{_format_delta(delta_classification.get('accuracy'))}"
    )
    print(
        "  confusion matrix  "
        f"TP={int(_number(classification.get('tp')))} FP={int(_number(classification.get('fp')))} "
        f"FN={int(_number(classification.get('fn')))} TN={int(_number(classification.get('tn')))}"
    )
    print(f"  noise chunk rate  {_number_text(aggregates.get('noiseChunkRate'))}{_format_delta(delta.get('noiseChunkRate'))}")
    print("  by target:")
    delta_targets = as_dict(delta.get("byTarget"))
    for target, raw_bucket in as_dict(aggregates.get("byTarget")).items():
        bucket, target_delta = as_dict(raw_bucket), as_dict(delta_targets.get(target))
        target_classification = as_dict(bucket.get("classification"))
        target_delta_classification = as_dict(target_delta.get("classification"))
        print(
            f"    {target.ljust(20)} claimR={_number_text(bucket.get('claimRecall'))}"
            f"{_format_delta(target_delta.get('claimRecall'))} "
            f"clsP={_number_text(target_classification.get('precision'))}"
            f"{_format_delta(target_delta_classification.get('precision'))} "
            f"clsR={_number_text(target_classification.get('recall'))}"
            f"{_format_delta(target_delta_classification.get('recall'))} "
            f"acc={_number_text(target_classification.get('accuracy'))}"
            f"{_format_delta(target_delta_classification.get('accuracy'))} "
            f"(n={int(_number(bucket.get('goldens')))})"
        )
    if baseline_file:
        print(
            f"\nBaseline: {baseline_path} (generated {baseline_file.get('generatedAt')}); deltas shown in parentheses."
        )
    else:
        print("\nNo committed baseline found. Run with --write to create one.")


def _number(value: object) -> float:
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else 0.0


def _number_text(value: object) -> str:
    """Format a metric with JavaScript template-literal number spelling."""

    return js_number_to_string(_number(value))


def _format_delta(value: object) -> str:
    if not isinstance(value, int | float) or isinstance(value, bool):
        return ""
    sign = "+" if value > 0 else ""
    return f" ({sign}{js_number_to_string(float(value))} vs baseline)"


def _extract_urls(content: str) -> list[str]:
    without_code = re.sub(r"```[\s\S]*?```", " ", content)
    return list(dict.fromkeys(match.group(0).rstrip(".,;:!?") for match in _URL.finditer(without_code)))


def _fetch_source(client: httpx.Client, url: str) -> tuple[str | None, str]:
    try:
        response = client.get(url, headers={"Accept": "text/html,text/plain;q=0.9"})
        if response.status_code >= 400:
            return None, ""
        body = response.text[:400_000]
        title_match = re.search(r"<title[^>]*>([\s\S]*?)</title>", body, re.IGNORECASE)
        abstract_match = re.search(
            r"<blockquote[^>]*class=\"abstract[^\"]*\"[^>]*>([\s\S]*?)</blockquote>", body, re.IGNORECASE
        )
        title = _html_to_text(title_match.group(1)) if title_match else None
        return title, _html_to_text(abstract_match.group(1) if abstract_match else body)[:1200]
    except httpx.HTTPError:
        return None, ""


def _html_to_text(value: str) -> str:
    value = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", " ", value, flags=re.IGNORECASE)
    value = re.sub(r"</(?:p|div|section|li|h[1-6])>", "\n", value, flags=re.IGNORECASE)
    value = re.sub(r"<[^>]+>", " ", value)
    value = value.replace("&nbsp;", " ").replace("&amp;", "&")
    return re.sub(r"\s+", " ", value).strip()


if __name__ == "__main__":  # pragma: no cover - console entry dispatches directly
    raise SystemExit(index_skeleton_main())
