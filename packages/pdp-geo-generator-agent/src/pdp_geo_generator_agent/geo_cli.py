"""Generator-owned operational console commands retained from the Node app."""

from __future__ import annotations

import asyncio
import json
import math
import os
import re
import sys
from collections.abc import Callable, Iterable, Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import TextIO, TypeGuard, cast

from neo_js_compat import (
    js_code_unit_length,
    js_json_dumps,
    js_number_to_string,
    js_parse_float,
    js_round,
    js_to_fixed,
    js_trim,
    js_utf8_replacement_text,
    js_utf16_slice,
    js_whitespace_characters,
)
from pdp_geo_eval_agent import (
    arg_value,
    build_generated_source_text,
    build_vanilla_source_text,
    complete_with_provider,
    geo_eval_engine_id,
    resolve_engine_config_from_env,
)
from pdp_geo_eval_agent.benchmark import eval_products, geo_eval_goldens, run_geo_benchmark

from .service import generate_pdp_geo

EXPLAINER_SYSTEM = "You are an expert AI analyst studying how generative search engines choose which product documents to cite."
EXTRACTOR_SYSTEM = "You extract general, reusable content rules. Respond only with a JSON array of strings."
MERGER_SYSTEM = "You are an expert in information retrieval content quality. Respond only with a JSON array of strings."
FILTER_SYSTEM = "You are a technical writer creating context-independent documentation. Respond only with the requested JSON object."
_EXTRACT_USAGE = "Usage: pdp-geo-extract-rules --provider <openai|gemini|azure-openai|aistudio> --results <geo-eval-json> [--threshold 0.05] [--out <dir>]"
_BENCHMARK_MISSING_PROVIDER = "Missing --provider (openai | gemini | azure-openai | aistudio). See packages/pdp-geo-eval-agent."
_MERGE_CHUNK_CHAR_BUDGET = 24_000
_BASELINE_PATH_ENV = "PDP_GEO_BENCHMARK_BASELINE_PATH"

_TRIM_CLASS = re.escape(js_whitespace_characters())
_OPEN_FENCE = re.compile(rf"^```(?:json)?[{_TRIM_CLASS}]*", re.IGNORECASE | re.ASCII)
_CLOSE_FENCE = re.compile(rf"```[{_TRIM_CLASS}]*$")


def extract_rules_main(argv: Sequence[str] | None = None, *, environ: Mapping[str, str] | None = None, stdout: TextIO | None = None, stderr: TextIO | None = None) -> int:
    """Mine checkpointed engine-preference rules from benchmark JSON."""
    del stdout
    args = list(sys.argv[1:] if argv is None else argv)
    env = os.environ if environ is None else environ
    err = sys.stderr if stderr is None else stderr
    provider_arg = arg_value(args, "--provider")
    provider = provider_arg if provider_arg is not None else env.get("GEO_EVAL_PROVIDER", "")
    results_path = arg_value(args, "--results")
    if not provider or not results_path:
        print(_EXTRACT_USAGE, file=err)
        return 1
    try:
        config = resolve_engine_config_from_env(provider, args, 0.2, environ=env)
    except (OSError, ValueError) as error:
        print(str(error), file=err)
        return 1
    out_value = arg_value(args, "--out")
    out_dir = Path(out_value) if out_value is not None else Path("scripts") / "rule-drafts" / _utc_day()
    pairs_dir = out_dir / "pairs"
    pairs_dir.mkdir(parents=True, exist_ok=True)
    try:
        eval_output = _object(json.loads(Path(results_path).read_text(encoding="utf-8"), parse_constant=_reject_constant))
    except (OSError, UnicodeDecodeError, ValueError, json.JSONDecodeError) as error:
        print(str(error), file=err)
        return 1
    raw_scores = eval_output.get("scores")
    if not _is_list(raw_scores):
        print(f"No scores found in {results_path}. Expected the output of `pdp-geo-benchmark --json`.", file=err)
        return 1
    threshold_arg = arg_value(args, "--threshold")
    threshold = js_parse_float("0.05" if threshold_arg is None else threshold_arg)
    scores = [_object(score) for score in raw_scores if _is_mapping(score)]
    try:
        return asyncio.run(_extract_rules(scores, threshold, out_dir, pairs_dir, config, arg_value(args, "--engine-label"), eval_output.get("engineId"), "engineId" in eval_output, err))
    except Exception as error:  # Command boundary deliberately keeps provider errors terse.
        print(str(error), file=err)
        return 1


async def _extract_rules(scores: Sequence[Mapping[str, object]], threshold: float, out_dir: Path, pairs_dir: Path, config: Mapping[str, object], engine_label: str | None, engine_id: object, has_engine_id: bool, stderr: TextIO) -> int:
    pairs = await _collect_preference_pairs(scores, threshold, stderr)
    print(f"Found {len(pairs)} preference pair(s) with |Δwordpos| >= {_js_number(threshold)} (from {len(scores)} goldens).", file=stderr)
    if not pairs:
        print("Nothing to extract. Lower --threshold or run pdp-geo-benchmark on more goldens.", file=stderr)
        return 0
    extractions: list[Mapping[str, object]] = []
    for pair in pairs:
        checkpoint = pairs_dir / f"{pair['goldenId']}.json"
        if checkpoint.exists():
            # Existing checkpoint content is intentionally trusted as the resume boundary.
            extractions.append(_object(json.loads(checkpoint.read_text(encoding="utf-8"), parse_constant=_reject_constant)))
            print(f"  [skip] {pair['goldenId']} (checkpoint exists)", file=stderr)
            continue
        print(f"  [explain] {pair['goldenId']} (winner={pair['winnerVariant']}, Δwordpos={_js_number(pair['wordposDelta'])})", file=stderr)
        explanation = await complete_with_provider(config, EXPLAINER_SYSTEM, _build_explainer_prompt(pair))
        rules = _parse_json_string_array(await complete_with_provider(config, EXTRACTOR_SYSTEM, _build_extractor_prompt(explanation)), stderr)
        extraction: dict[str, object] = {"goldenId": pair["goldenId"], "winnerVariant": pair["winnerVariant"], "wordposDelta": pair["wordposDelta"], "explanation": explanation, "rules": rules}
        _write_json(checkpoint, extraction)
        extractions.append(extraction)
    unique_rules = _js_sorted_unique(rule for extraction in extractions for rule in _checkpoint_rules(extraction.get("rules")))
    print(f"Merging {len(unique_rules)} unique rule candidate(s)…", file=stderr)
    merged_rules = await _hierarchical_merge(unique_rules, config, stderr)
    print(f"Filtering {len(merged_rules)} merged rule(s) for query independence…", file=stderr)
    filtered: list[str] = []
    for rule in merged_rules:
        modified = _parse_modified_rule(await complete_with_provider(config, FILTER_SYSTEM, _build_filter_prompt(rule)))
        if modified is not None:
            filtered.append(modified)
    final_rules = _js_sorted_unique(filtered)
    payload: dict[str, object] = {}
    if has_engine_id:
        payload["engineId"] = engine_id
    payload.update({"extractionModel": geo_eval_engine_id(config), "threshold": threshold, "pairCount": len(pairs), "extractedRuleCount": len(unique_rules), "mergedRules": merged_rules, "filteredRules": final_rules})
    merged_path = out_dir / "merged-rules.json"
    _write_json(merged_path, payload)
    draft_path = out_dir / "engine-preference-rules_draft.md"
    _write_utf8(draft_path, _build_draft_document(final_rules, extractions, engine_label, engine_id, threshold, config))
    print(f"\nDone. {len(final_rules)} filtered rule(s).", file=stderr)
    print(f"  - {merged_path}\n  - {draft_path}", file=stderr)
    print("\nNEXT STEP (human review required): review the draft, remove anything that", file=stderr)
    print("encourages unevidenced claims, then move approved rules into a versioned", file=stderr)
    print("bundled Python RAG resource with rag-index metadata and attach before/after pdp-geo-benchmark", file=stderr)
    print("deltas to the same commit. Never commit the draft directly.", file=stderr)
    return 0


async def _collect_preference_pairs(scores: Sequence[Mapping[str, object]], threshold: float, stderr: TextIO) -> list[dict[str, object]]:
    goldens = {_string(_object(golden).get("id")): _object(golden) for golden in geo_eval_goldens}
    generated_by_product: dict[str, str] = {}
    pairs: list[dict[str, object]] = []
    for score in scores:
        delta = _number(_object(score.get("delta")).get("wordpos"))
        if delta is None or abs(delta) < threshold:
            continue
        golden_id = _string(score.get("goldenId"))
        golden = goldens.get(golden_id)
        if golden is None:
            print(f"  [warn] golden {golden_id} not found in current goldens; skipping.", file=stderr)
            continue
        product_id = _string(golden.get("productId"))
        product = eval_products.get(product_id)
        if product is None:
            print(f"  [warn] product {product_id} not found in current fixtures; skipping.", file=stderr)
            continue
        product_data = _object(product)
        if product_id not in generated_by_product:
            run = _object(await generate_pdp_geo({"product": product, "hints": {"locale": _string(golden.get("locale")), "market": golden.get("market"), "brand": product_data.get("brand"), "category": product_data.get("category")}}))
            sections = _object(_object(_object(run.get("result")).get("content")).get("sections"))
            generated_by_product[product_id] = build_generated_source_text(sections)
        generated = generated_by_product[product_id]
        vanilla = build_vanilla_source_text(product)
        generated_won = delta > 0
        pairs.append({"goldenId": golden_id, "productId": product_id, "query": _string(golden.get("query")), "winnerText": generated if generated_won else vanilla, "loserText": vanilla if generated_won else generated, "winnerVariant": "generated" if generated_won else "vanilla", "wordposDelta": delta})
    return pairs


async def _hierarchical_merge(rules: list[str], config: Mapping[str, object], stderr: TextIO) -> list[str]:
    if not rules:
        return []
    current = rules
    while _total_js_chars(current) > _MERGE_CHUNK_CHAR_BUDGET:
        chunks = _chunk_by_char_budget(current, _MERGE_CHUNK_CHAR_BUDGET)
        print(f"  merge level: {len(current)} rules -> {len(chunks)} chunks", file=stderr)
        next_rules: list[str] = []
        for chunk in chunks:
            next_rules.extend(_parse_json_string_array(await complete_with_provider(config, MERGER_SYSTEM, _build_merger_prompt(chunk)), stderr))
        current = _js_sorted_unique(next_rules)
    final = _parse_json_string_array(await complete_with_provider(config, MERGER_SYSTEM, _build_merger_prompt(current)), stderr)
    return _js_sorted_unique(final) if final else current


def _total_js_chars(rules: Sequence[str]) -> int:
    return sum(js_code_unit_length(rule) for rule in rules)


def _chunk_by_char_budget(rules: Sequence[str], budget: int) -> list[list[str]]:
    chunks: list[list[str]] = []
    current: list[str] = []
    length = 0
    for rule in rules:
        rule_length = js_code_unit_length(rule)
        if length + rule_length > budget and current:
            chunks.append(current)
            current, length = [], 0
        current.append(rule)
        length += rule_length
    if current:
        chunks.append(current)
    return chunks


def _parse_json_string_array(raw: str, stderr: TextIO) -> list[str]:
    text = _unfence(raw)
    start, end = text.find("["), text.rfind("]")
    if start == -1 or end == -1 or end < start:
        print(f"  [warn] no JSON array in response (preview: {_utf8_text(_js_slice_utf16(text, 0, 120))}…); skipping.", file=stderr)
        return []
    try:
        return _string_list(json.loads(text[start : end + 1], parse_constant=_reject_constant))
    except (ValueError, json.JSONDecodeError) as error:
        print(f"  [warn] failed to parse rule array: {error}; skipping.", file=stderr)
        return []


def _parse_modified_rule(raw: str) -> str | None:
    text = _unfence(raw)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        return None
    try:
        value = _object(json.loads(text[start : end + 1], parse_constant=_reject_constant)).get("modifiedRule")
    except (ValueError, json.JSONDecodeError):
        return None
    trimmed = _ecma_trim(value) if isinstance(value, str) else ""
    return trimmed or None


def _unfence(raw: str) -> str:
    return _CLOSE_FENCE.sub("", _OPEN_FENCE.sub("", _ecma_trim(raw)))


def _build_explainer_prompt(pair: Mapping[str, object]) -> str:
    return f"""[Task]
Two product documents competed as sources for a generative engine answering a customer's question. Both were available alongside identical competitor documents; the engine cited the winning document substantially more (citation share difference: {_format_share(pair.get('wordposDelta'))}).

Explain in detail why the engine likely preferred the winning document. Consider factors such as:
- Directness: does it answer the customer's question head-on?
- Completeness: does it cover the aspects the question implies?
- Relevance: is the content on-topic without navigational or promotional noise?
- Structure: do headings/lists/atomic paragraphs make information easy to extract?
- Accuracy and specificity: precise names, quantities, and concrete usage details?
- Evidence presentation: are claims scoped, attributed, and verifiable?
- Conciseness: necessary information without filler?

[Customer Question]
{_string(pair.get('query'))}

[Document A]
{_string(pair.get('winnerText'))}

[Document B]
{_string(pair.get('loserText'))}

[Winning Document]: Document A

[Your Explanation]
Explain the strengths of the winning document and the weaknesses of the other in relation to the customer's question."""


def _build_extractor_prompt(explanation: str) -> str:
    return f"""[Instruction]
Based on the following explanation about why one product document was cited more by a generative engine, extract a set of general, reusable rules that define a high-quality product source document.

Rules must be objective, deterministic principles about how to PRESENT truthful product information (structure, specificity, evidence scoping, phrasing). NEVER extract a rule that would require inventing claims, metrics, or credentials that the product data does not contain.

Examples:
["The document should state the product's primary benefit in the first sentence."]
["The document should present usage steps as an ordered list.", "The document should scope clinical results with test conditions and duration."]

Return the list as a JSON array of strings. Do not use markdown fences. If no clear rules can be extracted, return [].

[Explanation]
{explanation}"""


def _build_merger_prompt(rules: Sequence[str]) -> str:
    return f"""[Task]
Consolidate the given list of rules into a set of core principles. Merge semantically similar rules, eliminate duplicates, and rephrase for clarity.

[Criteria for a Good Merged Rule]
1. Atomic: expresses a single, distinct idea.
2. Actionable: provides a clear, evaluatable instruction.
3. Unambiguous: uses simple, direct language.

[Example of what to avoid (over-merging)]
- Original: ["The text needs to be factual.", "The text should provide multiple viewpoints."]
- Bad merge: ["The text must be factual and provide multiple viewpoints."] (two distinct ideas — keep them separate)

Return the merged list as a single, valid JSON array of strings. No markdown fences, no explanations.

[Original Rules]
{"\n".join(f"- {rule}" for rule in rules)}

[Merged Rules JSON]"""


def _build_filter_prompt(rule: str) -> str:
    return f"""[Task]
Analyze the following rule. Remove any part that makes it dependent on a specific customer "query" or "question" — at generation time the future queries are unknown, so only general principles are useful.

- If the rule contains a general principle AND a query reference, keep only the general principle.
- If the entire rule is ONLY about handling a query (e.g. "Directly answer the customer's question."), return an empty string.

Return a single JSON object: {{"modifiedRule": "<string>"}}

[Input Rule]
"{rule}"

[Output JSON]"""


def _build_draft_document(rules: Sequence[str], extractions: Sequence[Mapping[str, object]], engine_label: str | None, engine_id: object, threshold: float, config: Mapping[str, object]) -> str:
    label = engine_label if engine_label is not None else _string(engine_id) or "unknown-engine"
    pair_lines = "\n".join(f"  - {_string(item.get('goldenId'))}: winner={_string(item.get('winnerVariant'))}, Δwordpos={_js_number(item.get('wordposDelta'))}, rules={len(_checkpoint_rules(item.get('rules')))}" for item in extractions)
    rules_lines = "\n".join(f"- {rule}" for rule in rules)
    return f"""# Engine Preference Rules (DRAFT — human review required)

> Status: **draft / not reviewed**. Do NOT load this file into the generation
> RAG corpus. After review, move approved rules into a versioned
> `src/pdp_geo_generator_agent/resources/rag/engine-preference-rules_v1.md` with rag-index metadata
> (kind/intents/fieldTargets/ruleExtraction), and attach the before/after
> `pdp-geo-benchmark` deltas to the same commit.

- Source: observed citation preferences of `{label}` (simulated engine)
- Checked: {_utc_day()}
- Method: AutoGEO-style preference-pair mining (explainer → extractor → merge → query-independence filter)
- Preference pairs (|Δwordpos| >= {_js_number(threshold)}):
{pair_lines}
- Extraction model: {geo_eval_engine_id(config)}
- Do-not-use: any rule that requires adding claims, metrics, certifications, or review content without product evidence — the evidence contract always wins over citation-visibility tactics.

## Observed rules (filtered)

{rules_lines}
"""


def resolve_benchmark_baseline_path(environ: Mapping[str, str] | None = None) -> Path | None:
    """Resolve explicit standalone configuration or an exact source-tree layout."""
    env = os.environ if environ is None else environ
    configured = env.get(_BASELINE_PATH_ENV)
    if configured:
        return Path(configured)
    module = Path(__file__).resolve()
    source_root, package_root, packages_root = module.parent.parent, module.parent.parent.parent, module.parent.parent.parent.parent
    if module.parent.name == "pdp_geo_generator_agent" and source_root.name == "src" and package_root.name == "pdp-geo-generator-agent" and packages_root.name == "packages" and (packages_root.parent / "apps" / "geo-generator").is_dir():
        return packages_root.parent / "apps" / "geo-generator" / "scripts" / "geo-benchmark-baseline.json"
    return None


def benchmark_main(argv: Sequence[str] | None = None, *, environ: Mapping[str, str] | None = None, stdout: TextIO | None = None, stderr: TextIO | None = None) -> int:
    """Generate all frozen artifacts then run the paired evaluator benchmark."""
    args = list(sys.argv[1:] if argv is None else argv)
    env = os.environ if environ is None else environ
    out, err = (sys.stdout if stdout is None else stdout), (sys.stderr if stderr is None else stderr)
    provider_arg = arg_value(args, "--provider")
    provider = provider_arg if provider_arg is not None else env.get("GEO_EVAL_PROVIDER", "")
    if not provider:
        print(_BENCHMARK_MISSING_PROVIDER, file=err)
        return 1
    try:
        engine = resolve_engine_config_from_env(provider, args, environ=env)
    except (OSError, ValueError) as error:
        print(str(error), file=err)
        return 1
    golden_arg = arg_value(args, "--golden")
    golden_ids = [_ecma_trim(value) for value in golden_arg.split(",") if _ecma_trim(value)] if golden_arg is not None else None
    as_json = "--json" in args
    baseline_path = resolve_benchmark_baseline_path(env)
    baseline = _read_baseline(baseline_path) if baseline_path is not None else None
    try:
        result = asyncio.run(_run_generator_benchmark(engine, as_json, golden_ids, args, err))
    except Exception as error:
        print(str(error), file=err)
        return 1
    delta = _baseline_delta(baseline, result)
    if as_json:
        print(_js_json_dumps(_json_report(result, baseline, delta)), file=out)
    else:
        _print_human_report(result, baseline, delta, out)
    if "--write" in args:
        if baseline_path is None:
            print(f"Set {_BASELINE_PATH_ENV} to write a benchmark baseline from a standalone installation.", file=err)
            return 1
        try:
            _write_baseline(baseline_path, result)
        except OSError as error:
            print(str(error), file=err)
            return 1
        if not as_json:
            print(f"\nBaseline written to {baseline_path}", file=out)
    return 0


async def _run_generator_benchmark(engine: Mapping[str, object], as_json: bool, golden_ids: list[str] | None, args: Sequence[str], stderr: TextIO) -> dict[str, object]:
    artifacts: dict[str, object] = {}
    for product_id, product in eval_products.items():
        if not as_json:
            print(f"  … generating PDP artifact for {product_id}", file=stderr)
        data = _object(product)
        locale = "ko-KR" if product_id.startswith(("sample_derma", "byeolmorae")) else "en-US"
        run = _object(await generate_pdp_geo({"product": product, "hints": {"locale": locale, "market": "KR" if locale == "ko-KR" else "US", "brand": data.get("brand"), "category": data.get("category")}}))
        sections = _object(_object(_object(run.get("result")).get("content")).get("sections"))
        ledger = _object(run.get("diagnostics")).get("evidenceLedger")
        artifacts[product_id] = {"publicText": build_generated_source_text(sections), "evidenceLedger": list(ledger) if _is_list(ledger) else []}
    options: dict[str, object] = {"engine": dict(engine), "artifacts": artifacts, "includeUtility": "--utility" in args, "goldenIds": golden_ids, "useCache": "--no-cache" not in args}
    if not as_json:
        options["onProgress"] = _progress_to(stderr)
    return _object(await run_geo_benchmark(options))


def _progress_to(stderr: TextIO) -> Callable[[str], None]:
    return lambda message: print(f"  … {message}", file=stderr)


def _read_baseline(path: Path) -> dict[str, object] | None:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"), parse_constant=_reject_constant)
    except (OSError, UnicodeDecodeError, ValueError, json.JSONDecodeError):
        return None
    baseline = _object(raw)
    generated_at, engine_id, aggregates = baseline.get("generatedAt"), baseline.get("engineId"), _valid_aggregates(baseline.get("aggregates"))
    if not isinstance(generated_at, str) or not isinstance(engine_id, str) or aggregates is None:
        return None
    return {"generatedAt": generated_at, "engineId": engine_id, "aggregates": aggregates}


def _reject_constant(value: str) -> object:
    raise ValueError(f"JSON does not allow {value}")


def _valid_aggregates(value: object) -> dict[str, object] | None:
    data = _object(value)
    goldens, engine_id = _integer(data.get("goldens")), data.get("engineId")
    vanilla, generated, delta = _valid_share(data.get("vanilla")), _valid_share(data.get("generated")), _valid_share(data.get("delta"))
    gate, locales, focuses = _valid_gate(data.get("gate")), _valid_locales(data.get("byLocale")), _valid_focuses(data.get("byCepFocus"))
    if goldens is None or not isinstance(engine_id, str) or vanilla is None or generated is None or delta is None or gate is None or locales is None or focuses is None:
        return None
    result: dict[str, object] = {"goldens": goldens, "engineId": engine_id, "vanilla": vanilla, "generated": generated, "delta": delta, "byLocale": locales, "byCepFocus": focuses, "gate": gate}
    if "utility" in data:
        utility = _valid_utility(data.get("utility"))
        if utility is None:
            return None
        result["utility"] = utility
    return result


def _valid_share(value: object) -> dict[str, float] | None:
    data = _object(value)
    result: dict[str, float] = {}
    for field in ("wordpos", "word", "pos"):
        number = _finite(data.get(field))
        if number is None:
            return None
        result[field] = number
    return result


def _valid_gate(value: object) -> dict[str, int] | None:
    data = _object(value)
    evaluated, passed = _integer(data.get("evaluated")), _integer(data.get("passed"))
    return {"evaluated": evaluated, "passed": passed} if evaluated is not None and passed is not None else None


def _valid_locales(value: object) -> dict[str, object] | None:
    if not _is_mapping(value):
        return None
    result: dict[str, object] = {}
    for locale, raw in _object(value).items():
        data = _object(raw)
        goldens, vanilla, generated, delta = _integer(data.get("goldens")), _valid_share(data.get("vanilla")), _valid_share(data.get("generated")), _valid_share(data.get("delta"))
        if goldens is None or vanilla is None or generated is None or delta is None:
            return None
        result[locale] = {"goldens": goldens, "vanilla": vanilla, "generated": generated, "delta": delta}
    return result


def _valid_focuses(value: object) -> dict[str, object] | None:
    if not _is_mapping(value):
        return None
    result: dict[str, object] = {}
    for focus, raw in _object(value).items():
        data = _object(raw)
        goldens, delta = _integer(data.get("goldens")), _valid_share(data.get("delta"))
        if goldens is None or delta is None:
            return None
        result[focus] = {"goldens": goldens, "delta": delta}
    return result


def _valid_utility(value: object) -> dict[str, float | None] | None:
    if not _is_mapping(value):
        return None
    data = _object(value)
    result: dict[str, float | None] = {}
    for field in ("meanKpr", "meanKpc", "meanCitationPrecision", "meanCitationRecall"):
        if field not in data:
            return None
        raw = data[field]
        if raw is None:
            result[field] = None
        else:
            number = _finite(raw)
            if number is None:
                return None
            result[field] = number
    return result


def _baseline_delta(baseline: Mapping[str, object] | None, result: Mapping[str, object]) -> dict[str, float] | None:
    if baseline is None or baseline.get("engineId") != result.get("engineId"):
        return None
    before, after = _object(baseline.get("aggregates")), _object(result.get("aggregates"))
    values = (_finite(_object(after.get("delta")).get("wordpos")), _finite(_object(before.get("delta")).get("wordpos")), _finite(_object(after.get("generated")).get("wordpos")), _finite(_object(before.get("generated")).get("wordpos")))
    if any(value is None for value in values):
        return None
    after_delta, before_delta, after_generated, before_generated = values
    if after_delta is None or before_delta is None or after_generated is None or before_generated is None:
        return None
    return {"deltaWordpos": _round(after_delta - before_delta), "generatedWordpos": _round(after_generated - before_generated)}


def _json_report(result: Mapping[str, object], baseline: Mapping[str, object] | None, delta: Mapping[str, float] | None) -> dict[str, object]:
    report: dict[str, object] = {"status": "ok", "engineId": result.get("engineId"), "aggregates": result.get("aggregates")}
    if baseline is not None:
        for source, target in (("aggregates", "baseline"), ("engineId", "baselineEngineId"), ("generatedAt", "baselineGeneratedAt")):
            report[target] = baseline[source]
    if delta is not None:
        report["deltaVsBaseline"] = dict(delta)
    if "scores" in result:
        report["scores"] = result["scores"]
    return report


def _write_baseline(path: Path, result: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    _write_json(path, {"generatedAt": _utc_day(), "engineId": result.get("engineId"), "aggregates": result.get("aggregates")})


def _print_human_report(result: Mapping[str, object], baseline: Mapping[str, object] | None, delta: Mapping[str, float] | None, output: TextIO) -> None:
    aggregates = _object(result.get("aggregates"))
    print(f"Engine: {_string(result.get('engineId'))}\n", file=output)
    print("Per-golden citation share (wordpos, vanilla → generated):", file=output)
    scores = result.get("scores")
    if _is_list(scores):
        for raw_score in scores:
            score = _object(raw_score)
            vanilla, generated = _object(score.get("vanilla")), _object(score.get("generated"))
            score_delta, gate = _object(score.get("delta")), _object(score.get("gate"))
            cache = " (cached)" if vanilla.get("cachedAnswer") and generated.get("cachedAnswer") else ""
            failure_flag = "" if gate.get("pass") else "  GATE FAIL"
            print(f"  {_string(score.get('goldenId')):<14} {_string(score.get('cepFocus')):<10} {_format_share(vanilla.get('wordpos'))} → {_format_share(generated.get('wordpos'))}  Δ={_format_delta(score_delta.get('wordpos'))}{cache}{failure_flag}", file=output)
            failures = gate.get("failures")
            if not gate.get("pass") and _is_list(failures):
                for failure in failures:
                    print(f"      fail: {_display(failure)}", file=output)
            hallucinated = _distinct(vanilla.get("hallucinatedCitations"), generated.get("hallucinatedCitations"))
            if hallucinated:
                print(f"      hallucinated citations ignored: [{', '.join(_display(value) for value in hallucinated)}]", file=output)
    vanilla, generated, aggregate_delta, gate = _object(aggregates.get("vanilla")), _object(aggregates.get("generated")), _object(aggregates.get("delta")), _object(aggregates.get("gate"))
    print("\nAggregates (mean share-of-voice across goldens):", file=output)
    print(f"  vanilla    wordpos={_js_number(vanilla.get('wordpos'))} word={_js_number(vanilla.get('word'))} pos={_js_number(vanilla.get('pos'))}", file=output)
    print(f"  generated  wordpos={_js_number(generated.get('wordpos'))} word={_js_number(generated.get('word'))} pos={_js_number(generated.get('pos'))}", file=output)
    print(f"  delta      wordpos={_format_delta(aggregate_delta.get('wordpos'))} word={_format_delta(aggregate_delta.get('word'))} pos={_format_delta(aggregate_delta.get('pos'))}", file=output)
    print(f"  gate       {_js_number(gate.get('passed'))}/{_js_number(gate.get('evaluated'))} passed", file=output)
    utility = aggregates.get("utility")
    if _is_mapping(utility):
        print(f"  utility    KPR={_nullish(utility.get('meanKpr'))} KPC={_nullish(utility.get('meanKpc'))} citationP={_nullish(utility.get('meanCitationPrecision'))} citationR={_nullish(utility.get('meanCitationRecall'))}", file=output)
    print("  by locale:", file=output)
    for locale, raw in _object(aggregates.get("byLocale")).items():
        bucket = _object(raw)
        print(f"    {locale:<8} Δwordpos={_format_delta(_object(bucket.get('delta')).get('wordpos'))} (vanilla {_js_number(_object(bucket.get('vanilla')).get('wordpos'))} → generated {_js_number(_object(bucket.get('generated')).get('wordpos'))}, n={_js_number(bucket.get('goldens'))})", file=output)
    print("  by CEP focus:", file=output)
    for focus, raw in _object(aggregates.get("byCepFocus")).items():
        bucket = _object(raw)
        print(f"    {focus:<10} Δwordpos={_format_delta(_object(bucket.get('delta')).get('wordpos'))} (n={_js_number(bucket.get('goldens'))})", file=output)
    if baseline is None:
        print("\nNo committed baseline found. Run with --write to create one.", file=output)
    elif baseline.get("engineId") == result.get("engineId") and delta is not None:
        print(f"\nBaseline: geo-benchmark-baseline.json ({_display(baseline.get('generatedAt'))}, {_display(baseline.get('engineId'))})", file=output)
        print(f"  Δ(delta.wordpos) vs baseline: {_format_delta(delta['deltaWordpos'])}", file=output)
        print(f"  Δ(generated.wordpos) vs baseline: {_format_delta(delta['generatedWordpos'])}", file=output)
    else:
        print(f"\nBaseline exists for a different engine ({_display(baseline.get('engineId'))}); no comparison shown.", file=output)


def _is_mapping(value: object) -> TypeGuard[Mapping[object, object]]:
    return isinstance(value, Mapping)


def _is_list(value: object) -> TypeGuard[list[object]]:
    return isinstance(value, list)


def _object(value: object) -> dict[str, object]:
    return {key: item for key, item in value.items() if isinstance(key, str)} if _is_mapping(value) else {}


def _string_list(value: object) -> list[str]:
    return [trimmed for item in value if isinstance(item, str) and (trimmed := _ecma_trim(item))] if _is_list(value) else []


def _checkpoint_rules(value: object) -> list[str]:
    """Trust saved string arrays exactly; fresh model output is normalized earlier."""
    return cast(list[str], value) if _is_list(value) else []


def _string(value: object) -> str:
    return value if isinstance(value, str) else ""


def _number(value: object) -> float | None:
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else None


def _finite(value: object) -> float | None:
    number = _number(value)
    return number if number is not None and math.isfinite(number) else None


def _integer(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _ecma_trim(value: str) -> str:
    return js_trim(value)


def _js_sorted_unique(values: Iterable[str]) -> list[str]:
    return sorted(set(values), key=lambda value: value.encode("utf-16-be", "surrogatepass"))


def _js_slice_utf16(value: str, start: int, end: int) -> str:
    return js_utf16_slice(value, start, end)


def _js_json_dumps(value: object) -> str:
    return _json_stringify_layout(js_json_dumps(value))


def _json_stringify_layout(compact: str) -> str:
    """Apply ``JSON.stringify(value, null, 2)`` layout to shared compact JSON.

    ``js_json_dumps`` remains the only implementation of JavaScript number,
    string-escape, object-order, and non-finite-value semantics.  This loop
    only reads JSON punctuation outside strings and inserts whitespace.
    """
    rendered: list[str] = []
    depth = 0
    in_string = False
    escaped = False
    for index, character in enumerate(compact):
        if in_string:
            rendered.append(character)
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue
        if character == '"':
            in_string = True
            rendered.append(character)
        elif character in "{[":
            rendered.append(character)
            closing = "}" if character == "{" else "]"
            if index + 1 < len(compact) and compact[index + 1] != closing:
                depth += 1
                rendered.append("\n" + "  " * depth)
        elif character in "}]":
            if index > 0 and compact[index - 1] not in "{[":
                depth -= 1
                rendered.append("\n" + "  " * depth)
            rendered.append(character)
        elif character == ",":
            rendered.append(",\n" + "  " * depth)
        elif character == ":":
            rendered.append(": ")
        else:
            rendered.append(character)
    return "".join(rendered)


def _write_json(path: Path, value: object) -> None:
    _write_utf8(path, _js_json_dumps(value) + "\n")


def _write_utf8(path: Path, value: str) -> None:
    path.write_bytes(_utf8_text(value).encode("utf-8"))


def _utf8_text(value: str) -> str:
    return js_utf8_replacement_text(value)


def _round(value: float) -> float:
    return js_round(value * 1000) / 1000


def _format_share(value: object) -> str:
    number = _number(value)
    return js_to_fixed(0.0 if number is None or number == 0 else number, 3)


def _format_delta(value: object) -> str:
    number = _number(value)
    number = 0.0 if number is None or number == 0 else number
    return f"{'+' if number > 0 else ''}{js_to_fixed(number, 3)}"


def _js_number(value: object) -> str:
    number = _number(value)
    if number is None:
        return "undefined"
    return js_number_to_string(number)


def _display(value: object) -> str:
    if value is None:
        return "null"
    if isinstance(value, str):
        return _utf8_text(value)
    if isinstance(value, bool):
        return "true" if value else "false"
    return _js_number(value)


def _nullish(value: object) -> str:
    return "-" if value is None else _display(value)


def _distinct(*values: object) -> list[object]:
    result: list[object] = []
    for value in values:
        if _is_list(value):
            for item in value:
                if item not in result:
                    result.append(item)
    return result


def _utc_day() -> str:
    return datetime.now(UTC).date().isoformat()
