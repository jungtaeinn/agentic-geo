"""Frozen source fixtures for product-normalization prompt construction."""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
from typing import Any

import pytest

from pdp_extractor_agent.normalizer import create_product_profile_normalization_prompt

_FIXTURE_PATH = Path(__file__).with_name("fixtures") / "product-profile-normalization-prompt.v1.json"


def _fixture() -> dict[str, Any]:
    value: dict[str, Any] = json.loads(_FIXTURE_PATH.read_text(encoding="utf-8"))
    return value


_PROMPT_FIXTURE = _fixture()
_CASES: list[dict[str, Any]] = _PROMPT_FIXTURE["cases"]


def test_product_normalization_prompt_fixture_records_public_contract_provenance() -> None:
    """Keep the public serialization contract self-describing and deterministic."""

    provenance: dict[str, Any] = _PROMPT_FIXTURE["sourceProvenance"]

    assert provenance == {
        "capture": "agentic-geo-public-normalizer-prompt-v1",
        "runtime": "Python deterministic serializer",
    }


@pytest.mark.parametrize("case", _CASES, ids=lambda case: str(case["id"]))
def test_product_normalization_prompt_matches_public_contract_bytes(case: dict[str, Any]) -> None:
    """Exercise the public builder, including numeric and truncation serialization."""

    request: dict[str, Any] = case["request"]
    max_source_characters: int = case["maxSourceCharacters"]
    expected: dict[str, str] = case["expected"]

    prompt = create_product_profile_normalization_prompt(request, max_source_characters)
    expected_system = base64.b64decode(expected["systemBase64"]).decode("utf-8")
    expected_user = base64.b64decode(expected["userBase64"]).decode("utf-8")

    assert prompt == {"system": expected_system, "user": expected_user}
    assert hashlib.sha256(prompt["system"].encode("utf-8")).hexdigest() == expected["systemSha256"]
    assert hashlib.sha256(prompt["user"].encode("utf-8")).hexdigest() == expected["userSha256"]

    if case["id"] == "javascript-numeric-and-surrogate-boundaries":
        assert '"negativeZero": 0' in prompt["user"]
        assert '"micro": 0.000001' in prompt["user"]
        assert '"large": 100000000000000000000' in prompt["user"]
        assert '"integral": 4' in prompt["user"]
        assert '"surrogate": "x\\ud800"' in prompt["user"]
