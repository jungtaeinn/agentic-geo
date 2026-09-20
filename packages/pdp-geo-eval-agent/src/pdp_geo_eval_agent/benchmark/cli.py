"""Installable CLI for the injected-artifact GEO benchmark.

The legacy command lives in the generator application because it produces
artifacts before it calls this dependency-free evaluator.  This package-level
entry point keeps that boundary: callers provide the generated artifacts as
JSON, while provider, benchmark, baseline, and report semantics stay aligned
with ``run-geo-benchmark.ts``.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from collections.abc import Callable, Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import TextIO, cast

from neo_js_compat import js_round, js_to_fixed

from ..citation.cli import arg_value, resolve_engine_config_from_env
from .runner import run_geo_benchmark

_MISSING_PROVIDER = "Missing --provider (openai | gemini | azure-openai | aistudio). See packages/pdp-geo-eval-agent."
_MISSING_ARTIFACTS = "Missing --artifacts <generated-artifacts-json>. The evaluator benchmark requires artifacts injected by the generator/API."
_USAGE = "Usage: pdp-geo-eval-benchmark --provider <openai|gemini|azure-openai|aistudio> --artifacts <generated-artifacts-json> [--json] [--write] [--utility] [--golden id,id] [--no-cache]"


def main(
    argv: Sequence[str] | None = None,
    *,
    environ: Mapping[str, str] | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
) -> int:
    """Run the paired benchmark and return a shell-compatible status code."""
    args = list(sys.argv[1:] if argv is None else argv)
    env = os.environ if environ is None else environ
    out = sys.stdout if stdout is None else stdout
    err = sys.stderr if stderr is None else stderr
    if "--help" in args or "-h" in args:
        print(_USAGE, file=out)
        return 0

    provider_arg = arg_value(args, "--provider")
    provider = provider_arg if provider_arg is not None else env.get("GEO_EVAL_PROVIDER", "")
    if not provider:
        print(_MISSING_PROVIDER, file=err)
        return 1

    try:
        engine = resolve_engine_config_from_env(provider, args, environ=env)
    except (OSError, ValueError) as error:
        print(str(error), file=err)
        return 1

    artifacts_location = _arg_or_env(args, "--artifacts", env, "GEO_EVAL_ARTIFACTS")
    if artifacts_location is None:
        print(_MISSING_ARTIFACTS, file=err)
        return 1
    try:
        artifacts = _read_artifacts(Path(artifacts_location))
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"Unable to read benchmark artifacts: {error}", file=err)
        return 1

    baseline_location = _arg_or_env(args, "--baseline", env, "GEO_EVAL_BASELINE_PATH")
    baseline_path = Path(baseline_location) if baseline_location is not None else Path.cwd() / "geo-benchmark-baseline.json"
    baseline = _read_baseline(baseline_path)
    golden_arg = arg_value(args, "--golden")
    golden_ids = [identifier.strip() for identifier in golden_arg.split(",") if identifier.strip()] if golden_arg is not None else None
    as_json = "--json" in args
    options: dict[str, object] = {
        "engine": engine,
        "artifacts": artifacts,
        "includeUtility": "--utility" in args,
        "goldenIds": golden_ids,
        "useCache": "--no-cache" not in args,
    }
    if not as_json:
        options["onProgress"] = _progress_printer(err)

    try:
        result = asyncio.run(run_geo_benchmark(options))
    except Exception as error:  # command-line boundary intentionally emits the provider/runner message verbatim
        print(str(error), file=err)
        return 1

    delta = _baseline_delta(baseline, result)
    if as_json:
        print(json.dumps(_json_report(result, baseline, delta), ensure_ascii=False, indent=2), file=out)
    else:
        _print_human_report(result, baseline, delta, out)

    if "--write" in args:
        try:
            _write_baseline(baseline_path, result)
        except OSError as error:
            print(str(error), file=err)
            return 1
        if not as_json:
            print(f"\nBaseline written to {baseline_path}", file=out)
    return 0


def _arg_or_env(args: Sequence[str], flag: str, environ: Mapping[str, str], env_name: str) -> str | None:
    value = arg_value(args, flag)
    return environ.get(env_name) if value is None else value


def _read_artifacts(path: Path) -> dict[str, object]:
    raw = cast(object, json.loads(path.read_text(encoding="utf-8")))
    raw_mapping = _mapping_or_none(raw)
    if raw_mapping is None:
        raise ValueError("artifact JSON must be an object keyed by fixture product id")
    wrapped = raw_mapping.get("artifacts")
    artifacts = _mapping_or_none(wrapped) or raw_mapping
    return dict(artifacts)


def _read_baseline(path: Path) -> Mapping[str, object] | None:
    try:
        raw = cast(object, json.loads(path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError):
        return None
    return _mapping_or_none(raw)


def _baseline_delta(baseline: Mapping[str, object] | None, result: Mapping[str, object]) -> dict[str, float] | None:
    if baseline is None or baseline.get("engineId") != result.get("engineId"):
        return None
    baseline_aggregates = _mapping(baseline.get("aggregates"))
    result_aggregates = _mapping(result.get("aggregates"))
    baseline_delta = _mapping(baseline_aggregates.get("delta"))
    result_delta = _mapping(result_aggregates.get("delta"))
    baseline_generated = _mapping(baseline_aggregates.get("generated"))
    result_generated = _mapping(result_aggregates.get("generated"))
    try:
        return {
            "deltaWordpos": _round(_float(result_delta["wordpos"]) - _float(baseline_delta["wordpos"])),
            "generatedWordpos": _round(_float(result_generated["wordpos"]) - _float(baseline_generated["wordpos"])),
        }
    except (KeyError, TypeError, ValueError):
        return None


def _json_report(result: Mapping[str, object], baseline: Mapping[str, object] | None, delta: Mapping[str, float] | None) -> dict[str, object]:
    report: dict[str, object] = {
        "status": "ok",
        "engineId": result.get("engineId"),
        "aggregates": result.get("aggregates"),
    }
    # JSON.stringify omits undefined properties; preserve present nulls while
    # leaving absent baseline fields absent.
    if baseline is not None:
        for source, target in (("aggregates", "baseline"), ("engineId", "baselineEngineId"), ("generatedAt", "baselineGeneratedAt")):
            if source in baseline:
                report[target] = baseline[source]
    if delta is not None:
        report["deltaVsBaseline"] = dict(delta)
    report["scores"] = result.get("scores")
    return report


def _write_baseline(path: Path, result: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generatedAt": datetime.now(UTC).date().isoformat(),
        "engineId": result.get("engineId"),
        "aggregates": result.get("aggregates"),
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _print_human_report(result: Mapping[str, object], baseline: Mapping[str, object] | None, delta: Mapping[str, float] | None, out: TextIO) -> None:
    engine_id = str(result.get("engineId", ""))
    scores = result.get("scores")
    aggregates = _mapping(result.get("aggregates"))
    print(f"Engine: {engine_id}\n", file=out)
    print("Per-golden citation share (wordpos, vanilla → generated):", file=out)
    for score_value in _objects(scores):
            score = _mapping(score_value)
            vanilla = _mapping(score.get("vanilla"))
            generated = _mapping(score.get("generated"))
            score_delta = _mapping(score.get("delta"))
            gate = _mapping(score.get("gate"))
            gate_flag = "" if gate.get("pass") else "  GATE FAIL"
            cache_flag = " (cached)" if vanilla.get("cachedAnswer") and generated.get("cachedAnswer") else ""
            print(
                f"  {str(score.get('goldenId', '')):<14} {str(score.get('cepFocus', '')):<10} "
                f"{_format_share(vanilla.get('wordpos'))} → {_format_share(generated.get('wordpos'))}  "
                f"Δ={_format_delta(score_delta.get('wordpos'))}{cache_flag}{gate_flag}",
                file=out,
            )
            if not gate.get("pass"):
                failures = gate.get("failures")
                for failure in _objects(failures):
                    print(f"      fail: {failure}", file=out)
            hallucinated = _distinct_numbers(vanilla.get("hallucinatedCitations"), generated.get("hallucinatedCitations"))
            if hallucinated:
                print(f"      hallucinated citations ignored: [{', '.join(str(value) for value in hallucinated)}]", file=out)

    print("\nAggregates (mean share-of-voice across goldens):", file=out)
    vanilla = _mapping(aggregates.get("vanilla"))
    generated = _mapping(aggregates.get("generated"))
    aggregate_delta = _mapping(aggregates.get("delta"))
    print(f"  vanilla    wordpos={vanilla.get('wordpos')} word={vanilla.get('word')} pos={vanilla.get('pos')}", file=out)
    print(f"  generated  wordpos={generated.get('wordpos')} word={generated.get('word')} pos={generated.get('pos')}", file=out)
    print(f"  delta      wordpos={_format_delta(aggregate_delta.get('wordpos'))} word={_format_delta(aggregate_delta.get('word'))} pos={_format_delta(aggregate_delta.get('pos'))}", file=out)
    gate = _mapping(aggregates.get("gate"))
    print(f"  gate       {gate.get('passed')}/{gate.get('evaluated')} passed", file=out)

    utility = _mapping_or_none(aggregates.get("utility"))
    if utility is not None:
        print(
            f"  utility    KPR={_nullish_display(utility.get('meanKpr'))} KPC={_nullish_display(utility.get('meanKpc'))} "
            f"citationP={_nullish_display(utility.get('meanCitationPrecision'))} citationR={_nullish_display(utility.get('meanCitationRecall'))}",
            file=out,
        )
    print("  by locale:", file=out)
    by_locale = _mapping_or_none(aggregates.get("byLocale"))
    if by_locale is not None:
        for locale, bucket_value in by_locale.items():
            bucket = _mapping(bucket_value)
            bucket_delta = _mapping(bucket.get("delta"))
            bucket_vanilla = _mapping(bucket.get("vanilla"))
            bucket_generated = _mapping(bucket.get("generated"))
            print(
                f"    {str(locale):<8} Δwordpos={_format_delta(bucket_delta.get('wordpos'))} "
                f"(vanilla {bucket_vanilla.get('wordpos')} → {bucket_generated.get('wordpos')}, n={bucket.get('goldens')})",
                file=out,
            )
    print("  by CEP focus:", file=out)
    by_focus = _mapping_or_none(aggregates.get("byCepFocus"))
    if by_focus is not None:
        for focus, bucket_value in by_focus.items():
            bucket = _mapping(bucket_value)
            print(f"    {str(focus):<10} Δwordpos={_format_delta(_mapping(bucket.get('delta')).get('wordpos'))} (n={bucket.get('goldens')})", file=out)

    if baseline is None:
        print("\nNo committed baseline found. Run with --write to create one.", file=out)
    elif baseline.get("engineId") == result.get("engineId") and delta is not None:
        print(f"\nBaseline: geo-benchmark-baseline.json ({baseline.get('generatedAt')}, {baseline.get('engineId')})", file=out)
        print(f"  Δ(delta.wordpos) vs baseline: {_format_delta(delta['deltaWordpos'])}", file=out)
        print(f"  Δ(generated.wordpos) vs baseline: {_format_delta(delta['generatedWordpos'])}", file=out)
    else:
        print(f"\nBaseline exists for a different engine ({baseline.get('engineId')}); no comparison shown.", file=out)


def _mapping(value: object) -> Mapping[str, object]:
    return _mapping_or_none(value) or {}


def _mapping_or_none(value: object) -> Mapping[str, object] | None:
    if not isinstance(value, Mapping):
        return None
    mapping = cast(Mapping[object, object], value)
    return cast(Mapping[str, object], mapping) if all(isinstance(key, str) for key in mapping) else None


def _objects(value: object) -> list[object]:
    return list(cast(list[object], value)) if isinstance(value, list) else []


def _progress_printer(stream: TextIO) -> Callable[[str], None]:
    def print_progress(message: str) -> None:
        print(f"  … {message}", file=stream)

    return print_progress


def _float(value: object) -> float:
    if isinstance(value, (str, int, float)) and not isinstance(value, bool):
        return float(value)
    raise TypeError("not a numeric JSON value")


def _round(value: float) -> float:
    return js_round(value * 1000) / 1000


def _format_share(value: object) -> str:
    number = float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0.0
    return js_to_fixed(0.0 if number == 0 else number, 3)


def _format_delta(value: object) -> str:
    number = float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0.0
    sign = "+" if number > 0 else ""
    return f"{sign}{js_to_fixed(0.0 if number == 0 else number, 3)}"


def _nullish_display(value: object) -> object:
    return "-" if value is None else value


def _distinct_numbers(*values: object) -> list[object]:
    result: list[object] = []
    for value in values:
        if not isinstance(value, list):
            continue
        for item in cast(list[object], value):
            if item not in result:
                result.append(item)
    return result


if __name__ == "__main__":
    raise SystemExit(main())
