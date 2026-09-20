"""Byte-level integrity audit for the public RAG corpus."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

_PACKAGE = Path(__file__).resolve().parents[1]
_PYTHON = _PACKAGE / "src" / "pdp_geo_generator_agent" / "resources" / "rag"
_FIXTURE = Path(__file__).parent / "fixtures" / "public-rag-resource-audit-v1.json"
_PINNED_DIGEST = "de52716563cb6bbcf0e4f64a38a31d1f46dcfd4c116974ae7044057ace1db902"


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_public_managed_rag_resources_match_the_integrity_contract() -> None:
    """Catch unreviewed public-corpus content or newline changes."""

    python = {path.relative_to(_PYTHON): path for path in _PYTHON.rglob("*") if path.suffix in {".md", ".json"}}
    fixture = json.loads(_FIXTURE.read_text(encoding="utf-8"))
    whole = {key: value for key, value in fixture.items() if key != "wholeContractSha256"}
    assert hashlib.sha256(json.dumps(whole, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest() == _PINNED_DIGEST
    assert fixture["wholeContractSha256"] == _PINNED_DIGEST
    expected = fixture["publicSha256"]
    expected_paths = set(expected)
    assert expected_paths == {relative.as_posix() for relative in python}
    assert len(expected_paths) == fixture["managedSourceCount"]
    for key, expected_sha256 in expected.items():
        relative = Path(key)
        assert _sha256(python[relative]) == expected_sha256, key
