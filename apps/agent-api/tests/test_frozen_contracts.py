"""Integrity checks for the frozen legacy API boundary contracts."""

from __future__ import annotations

import copy
import hashlib
import json
import re
from collections.abc import Callable

import pytest
from frozen_contracts import frozen_outcome, load_contract, object_list, object_mapping, verify_contract_integrity

_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_GIT_BLOB = re.compile(r"[0-9a-f]{40}\Z")
Mutation = Callable[[dict[str, object]], None]


def _digest(value: object) -> str:
    encoded = json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


def _source_input_digest(contract: dict[str, object]) -> str:
    outcomes = object_mapping(contract["outcomes"])
    return _digest({name: object_mapping(outcome)["inputs"] for name, outcome in sorted(outcomes.items())})


def _provenance(contract: dict[str, object]) -> dict[str, object]:
    return object_mapping(contract["provenance"])


def _first_source(contract: dict[str, object]) -> dict[str, object]:
    source_files = _provenance(contract)["source_files"]
    sources = object_list(source_files)
    assert sources
    return object_mapping(sources[0])


def _depth_outcome(contract: dict[str, object]) -> dict[str, object]:
    outcomes = object_mapping(contract["outcomes"])
    return object_mapping(outcomes["test_console_json_parser_accepts_runtime_depth_without_python_recursion"])


def _replace_source_commit(contract: dict[str, object]) -> None:
    _provenance(contract)["source_commit"] = "not-a-git-commit"


def _replace_source_input_digest(contract: dict[str, object]) -> None:
    _provenance(contract)["source_input_sha256"] = "not-a-sha256"


def _replace_source_path(contract: dict[str, object]) -> None:
    _first_source(contract)["path"] = "retired.ts"


def _replace_source_blob_sha1(contract: dict[str, object]) -> None:
    _first_source(contract)["blob_sha1"] = "not-a-git-blob"


def _replace_source_blob_sha256(contract: dict[str, object]) -> None:
    _first_source(contract)["blob_sha256"] = "not-a-sha256"


def _replace_outcome_input_digest(contract: dict[str, object]) -> None:
    _depth_outcome(contract)["input_sha256"] = "not-a-sha256"


@pytest.mark.parametrize(
    "contract_name",
    ["round_four", "round_five", "post_terminal"],
)
def test_frozen_contract_has_pinned_provenance_inputs_and_outputs(contract_name: str) -> None:
    """Catch mutable legacy captures that lack verifiable source and boundary evidence."""

    contract = load_contract(contract_name)

    assert contract["version"] == 2
    provenance = _provenance(contract)
    source_commit = provenance["source_commit"]
    source_input_sha256 = provenance["source_input_sha256"]
    assert isinstance(source_commit, str)
    assert isinstance(source_input_sha256, str)
    assert source_commit == "383bec65756ca9c1dce468f434667d28743ae586"
    assert _GIT_BLOB.fullmatch(source_commit)
    assert _SHA256.fullmatch(source_input_sha256)
    assert provenance["dependencies"]
    assert provenance["locale"] == "ko-KR"
    assert provenance["source_files"]
    for source_value in object_list(provenance["source_files"]):
        source = object_mapping(source_value)
        source_path = source["path"]
        source_blob_sha1 = source["blob_sha1"]
        source_blob_sha256 = source["blob_sha256"]
        assert isinstance(source_path, str)
        assert isinstance(source_blob_sha1, str)
        assert isinstance(source_blob_sha256, str)
        assert source_path.startswith("apps/")
        assert source_path.endswith(".ts")
        assert _GIT_BLOB.fullmatch(source_blob_sha1)
        assert _SHA256.fullmatch(source_blob_sha256)

    outcomes = object_mapping(contract["outcomes"])
    assert outcomes
    for outcome_value in outcomes.values():
        outcome = object_mapping(outcome_value)
        assert "inputs" in outcome
        input_sha256 = outcome["input_sha256"]
        assert isinstance(input_sha256, str)
        assert _SHA256.fullmatch(input_sha256)
        assert _digest(outcome["inputs"]) == input_sha256


def test_pinned_contract_digest_rejects_coordinated_input_and_output_mutation() -> None:
    """Changing every mutable outcome field must still fail against the independent pin."""

    contract = copy.deepcopy(load_contract("round_four"))
    outcomes = object_mapping(contract["outcomes"])
    outcome = object_mapping(outcomes["test_console_json_parser_accepts_runtime_depth_without_python_recursion"])
    outcome["inputs"] = {"depth": 7}
    outcome["input_sha256"] = _digest(outcome["inputs"])
    outcome["expected"] = {"ok": False}
    provenance = _provenance(contract)
    provenance["source_input_sha256"] = _source_input_digest(contract)

    with pytest.raises(AssertionError, match="independently pinned"):
        verify_contract_integrity("round_four", contract)


def test_frozen_outcome_rejects_boolean_integer_equality_collision() -> None:
    """A numeric input must not reuse a snapshot captured with a boolean value."""

    with pytest.raises(AssertionError, match="stale test inputs"):
        frozen_outcome(
            "round_four",
            "test_internal_disconnect_is_the_frozen_body_parser_read_failure",
            {"disconnect": 1},
        )


def test_frozen_outcome_rejects_integer_float_equality_collision() -> None:
    """A float input must not reuse a snapshot captured with an integer value."""

    with pytest.raises(AssertionError, match="stale test inputs"):
        frozen_outcome(
            "round_four",
            "test_console_json_parser_accepts_runtime_depth_without_python_recursion",
            {"depth": 2000.0},
        )


def test_frozen_outcome_accepts_exact_recorded_boolean_and_integer_inputs() -> None:
    """The strict canonical comparison still permits the genuine captured values."""

    assert frozen_outcome(
        "round_four",
        "test_internal_disconnect_is_the_frozen_body_parser_read_failure",
        {"disconnect": True},
    ) == {"message": "request aborted", "status": 400}
    assert frozen_outcome(
        "round_four",
        "test_console_json_parser_accepts_runtime_depth_without_python_recursion",
        {"depth": 2000},
    ) == {"ok": True}


@pytest.mark.parametrize(
    "mutation",
    [
        _replace_source_commit,
        _replace_source_input_digest,
        _replace_source_path,
        _replace_source_blob_sha1,
        _replace_source_blob_sha256,
        _replace_outcome_input_digest,
    ],
    ids=[
        "source-commit",
        "source-input-digest",
        "source-path",
        "source-blob-sha1",
        "source-blob-sha256",
        "outcome-input-digest",
    ],
)
def test_frozen_contract_rejects_malformed_source_and_digest_fields(mutation: Mutation) -> None:
    """Malformed source identifiers and digests cannot masquerade as frozen evidence."""

    contract = copy.deepcopy(load_contract("round_four"))
    mutation(contract)

    with pytest.raises(AssertionError, match="invalid"):
        verify_contract_integrity("round_four", contract)
