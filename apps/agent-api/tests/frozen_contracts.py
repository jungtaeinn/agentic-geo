"""Load and verify Python-owned snapshots of retired boundary behavior."""

from __future__ import annotations

import base64
import hashlib
import json
import re
from pathlib import Path
from typing import Any, cast

_FIXTURE = Path(__file__).parent / "fixtures" / "legacy_contracts.json"
_FORMAT = "neo-agent-api-frozen-contracts"
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_GIT_BLOB = re.compile(r"[0-9a-f]{40}\Z")
_PINNED_CONTRACT_SHA256: dict[str, str] = {
    "post_terminal": "2ef4d929a2f3411ed22730657997c3aab1bd67d8ea03e73e8ddaa5bdf17c0440",
    "round_five": "150c873e3945c1414f475dcef39b88dbb724b66f8a8e5aa0e182b365dfe0c54a",
    "round_four": "8456a1523b41173aa2320411572cb4880ea01a8db7e19944303fe5049b1e7ec8",
}


def _normalise(value: object) -> object:
    if isinstance(value, bytes):
        return {"base64": base64.b64encode(value).decode("ascii")}
    if isinstance(value, list):
        raw_items = cast(list[object], value)
        return [_normalise(item) for item in raw_items]
    if isinstance(value, dict):
        raw_mapping = cast(dict[object, object], value)
        return {str(key): _normalise(item) for key, item in raw_mapping.items()}
    return value


def object_mapping(value: object, *, error: str = "Expected a JSON object") -> dict[str, object]:
    """Narrow a decoded JSON object without leaking ``Unknown`` into tests."""

    if not isinstance(value, dict):
        raise AssertionError(error)
    raw_mapping = cast(dict[object, object], value)
    for key in raw_mapping:
        if not isinstance(key, str):
            raise AssertionError(error)
    return cast(dict[str, object], raw_mapping)


def object_list(value: object, *, error: str = "Expected a JSON array") -> list[object]:
    """Narrow a decoded JSON array without leaking ``Unknown`` into tests."""

    if not isinstance(value, list):
        raise AssertionError(error)
    return list(cast(list[object], value))


def string_value(value: object, *, error: str = "Expected a JSON string") -> str:
    """Narrow one frozen JSON scalar before a string-only assertion."""

    if not isinstance(value, str):
        raise AssertionError(error)
    return value


def integer_value(value: object, *, error: str = "Expected a JSON integer") -> int:
    """Narrow one frozen JSON scalar while excluding Python's boolean integers."""

    if not isinstance(value, int) or isinstance(value, bool):
        raise AssertionError(error)
    return value


def _input_hash(value: object) -> str:
    payload = json.dumps(_normalise(value), ensure_ascii=True, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()


def _require_digest(value: object, pattern: re.Pattern[str], field: str) -> str:
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        raise AssertionError(f"Frozen contract has an invalid {field}")
    return value


def _source_input_hash(outcomes: dict[str, object]) -> str:
    try:
        inputs = {name: object_mapping(outcome)["inputs"] for name, outcome in sorted(outcomes.items())}
    except (KeyError, TypeError) as error:
        raise AssertionError("Frozen contract has an invalid outcome inputs manifest") from error
    return _input_hash(inputs)


def verify_contract_integrity(name: str, contract: dict[str, object]) -> None:
    """Reject mutable provenance, inputs, and outputs that differ from the pinned snapshot."""

    if contract.get("version") != 2:
        raise AssertionError("Frozen contract has an invalid version")
    provenance = object_mapping(contract.get("provenance"), error="Frozen contract has an invalid provenance")
    _require_digest(provenance.get("source_commit"), _GIT_BLOB, "source commit")
    source_input_hash = _require_digest(provenance.get("source_input_sha256"), _SHA256, "source input hash")
    source_files = object_list(
        provenance.get("source_files"), error="Frozen contract has an invalid source files manifest"
    )
    if not source_files:
        raise AssertionError("Frozen contract has an invalid source files manifest")
    for source in source_files:
        source = object_mapping(source, error="Frozen contract has an invalid source file")
        source_path = source.get("path")
        if not isinstance(source_path, str) or not source_path.startswith("apps/") or not source_path.endswith(".ts"):
            raise AssertionError("Frozen contract has an invalid source file path")
        _require_digest(source.get("blob_sha1"), _GIT_BLOB, "source blob sha1")
        _require_digest(source.get("blob_sha256"), _SHA256, "source blob sha256")

    outcomes = object_mapping(contract.get("outcomes"), error="Frozen contract has an invalid outcomes manifest")
    if not outcomes:
        raise AssertionError("Frozen contract has an invalid outcomes manifest")
    for outcome in outcomes.values():
        outcome = object_mapping(outcome, error="Frozen contract has an invalid outcome")
        if "inputs" not in outcome or "expected" not in outcome:
            raise AssertionError("Frozen contract has an invalid outcome")
        input_hash = _require_digest(outcome.get("input_sha256"), _SHA256, "outcome input hash")
        if _input_hash(outcome["inputs"]) != input_hash:
            raise AssertionError("Frozen contract has stale outcome inputs")
    if _source_input_hash(outcomes) != source_input_hash:
        raise AssertionError("Frozen contract has stale source inputs")

    pinned = _PINNED_CONTRACT_SHA256.get(name)
    if pinned is None:
        raise AssertionError(f"Frozen contract {name!r} has no independently pinned digest")
    if _input_hash(contract) != pinned:
        raise AssertionError(f"Frozen contract {name!r} does not match its independently pinned digest")


def load_contract(name: str) -> dict[str, object]:
    """Return one versioned contract after confirming its fixture structure."""

    payload = object_mapping(json.loads(_FIXTURE.read_text()), error="Unexpected frozen contract fixture format")
    if payload.get("format") != _FORMAT:
        raise AssertionError("Unexpected frozen contract fixture format")
    contracts = object_mapping(payload.get("contracts"), error=f"Frozen contract {name!r} is unavailable")
    if name not in contracts:
        raise AssertionError(f"Frozen contract {name!r} is unavailable")
    contract = object_mapping(contracts[name], error=f"Frozen contract {name!r} has an invalid shape")
    verify_contract_integrity(name, contract)
    return contract


def frozen_outcome(contract_name: str, test_name: str, inputs: object) -> Any:
    """Return one recorded result only when the test input still matches it."""

    contract = load_contract(contract_name)
    outcomes = object_mapping(
        contract.get("outcomes"), error=f"Frozen outcome {contract_name}/{test_name} is unavailable"
    )
    if test_name not in outcomes:
        raise AssertionError(f"Frozen outcome {contract_name}/{test_name} is unavailable")
    outcome = object_mapping(
        outcomes[test_name], error=f"Frozen outcome {contract_name}/{test_name} has an invalid shape"
    )
    if _input_hash(inputs) != outcome["input_sha256"]:
        raise AssertionError(f"Frozen outcome {contract_name}/{test_name} has stale test inputs")
    return outcome["expected"]
