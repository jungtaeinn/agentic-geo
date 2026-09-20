from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any, cast

import pytest
from test_frozen_legacy_contracts import load_frozen_rag_profile_contract

import pdp_geo_generator_agent.rag.profile_store as profile_store
from pdp_geo_generator_agent.rag.default_profile import DEFAULT_PDP_GEO_GENERATOR_RAG_PROFILE
from pdp_geo_generator_agent.rag.manifest import PDP_GEO_GENERATOR_RAG_MANIFEST
from pdp_geo_generator_agent.rag.profile_store import (
    read_pdp_geo_generator_rag_profile,
    reset_pdp_geo_generator_rag_profile,
    write_pdp_geo_generator_rag_profile,
)


@pytest.mark.parametrize("name", ["..txt", ".txt", "...txt", ".config.json", "doc.txt/", "dir/.txt"])
def test_custom_profile_preserves_node_extname_for_dotfiles(tmp_path: Path, name: str) -> None:
    profile = {"analysisPrompt": "Retained prompt", "documents": [{"name": name, "content": "x"}]}

    stored = asyncio.run(write_pdp_geo_generator_rag_profile(profile, tmp_path))

    assert [document["name"] for document in stored["documents"] if not document["managed"]]
    assert all(path.read_bytes() == b"x\n" for path in (tmp_path / "custom").iterdir())


def test_custom_profile_filename_versions_use_retained_ascii_digits(tmp_path: Path) -> None:
    profile = {
        "analysisPrompt": "Retained prompt",
        "documents": [
            {"name": "doc_v١.txt", "content": "x"},
            {"name": "plain.txt", "version": "v١", "content": "x"},
            {"name": "ascii_v12.txt", "content": "x"},
        ],
    }
    asyncio.run(write_pdp_geo_generator_rag_profile(profile, tmp_path))

    assert sorted(path.name for path in (tmp_path / "custom").iterdir()) == [
        "ascii_v12.txt", "doc_v١_v1.txt", "plain_v١.txt"
    ]


def test_custom_profile_checks_node_extension_before_nfkc_normalization(tmp_path: Path) -> None:
    """``path.extname`` sees the full-width dot before filename normalization."""

    asyncio.run(
        write_pdp_geo_generator_rag_profile(
            {"analysisPrompt": "Retained prompt", "documents": [{"name": "doc．txt", "content": "x"}]}, tmp_path
        )
    )

    assert sorted(path.name for path in (tmp_path / "custom").iterdir()) == ["doc.txt_v1.md"]


def test_profile_non_string_custom_content_errors_after_earlier_write_without_cleanup(tmp_path: Path) -> None:
    """Legacy ``ensureTrailingNewline`` rejects even falsy numeric content."""

    custom = tmp_path / "custom"
    custom.mkdir()
    (custom / "stale_v1.md").write_text("stale\n", encoding="utf-8")
    profile: dict[str, object] = {
        "analysisPrompt": "p",
        "documents": [
            {"name": "first.md", "content": "first"},
            {"name": "bad.md", "content": 0},
        ],
    }

    with pytest.raises(TypeError, match="value\\.endsWith is not a function"):
        asyncio.run(write_pdp_geo_generator_rag_profile(profile, tmp_path))

    assert (tmp_path / "analysis-prompt_v1.md").read_text(encoding="utf-8") == "p\n"
    assert {path.name for path in custom.iterdir()} == {"first_v1.md", "stale_v1.md"}
    assert (custom / "first_v1.md").read_text(encoding="utf-8") == "first\n"


def test_profile_non_string_brand_content_errors_after_earlier_brand_write(tmp_path: Path) -> None:
    """Brand files use the same direct TypeScript string method boundary."""

    custom = tmp_path / "custom"
    custom.mkdir()
    (custom / "stale_v1.md").write_text("stale\n", encoding="utf-8")
    profile: dict[str, object] = {
        "analysisPrompt": "p",
        "documents": [
            {"name": "brands/neo/first.md", "content": "first"},
            {"name": "brands/neo/bad.md", "content": 0},
        ],
    }

    with pytest.raises(TypeError, match="value\\.endsWith is not a function"):
        asyncio.run(write_pdp_geo_generator_rag_profile(profile, tmp_path))

    assert (tmp_path / "analysis-prompt_v1.md").read_text(encoding="utf-8") == "p\n"
    assert (tmp_path / "brands" / "neo" / "first_v1.md").read_text(encoding="utf-8") == "first\n"
    assert not (tmp_path / "brands" / "neo" / "bad_v1.md").exists()
    assert {path.name for path in custom.iterdir()} == {"stale_v1.md"}


@pytest.mark.parametrize("analysis_prompt", [[], {}])
def test_profile_js_truthy_prompt_objects_fail_before_any_file_write(tmp_path: Path, analysis_prompt: object) -> None:
    """Empty JS arrays/objects are truthy, so legacy calls ``endsWith`` on them."""

    state = tmp_path / "state"
    with pytest.raises(TypeError, match=r"value\.endsWith is not a function"):
        asyncio.run(write_pdp_geo_generator_rag_profile({"analysisPrompt": analysis_prompt}, state))

    assert state.is_dir()
    assert list(state.iterdir()) == []


def test_profile_non_array_documents_fail_after_prompt_write_before_managed_writes(tmp_path: Path) -> None:
    """The source ``(profile.documents ?? []).map`` boundary leaves only the prompt on disk."""

    state = tmp_path / "state"
    with pytest.raises(TypeError, match=r"\(profile\.documents \?\? \[\]\)\.map is not a function"):
        asyncio.run(write_pdp_geo_generator_rag_profile({"analysisPrompt": "p", "documents": {}}, state))

    assert (state / "analysis-prompt_v1.md").read_text(encoding="utf-8") == "p\n"
    assert [path.name for path in state.iterdir()] == ["analysis-prompt_v1.md"]


def test_profile_null_document_fails_during_map_before_managed_writes(tmp_path: Path) -> None:
    """A null element faults at ``document.name`` before the legacy managed-file loop."""

    state = tmp_path / "state"
    with pytest.raises(TypeError, match=r"Cannot read properties of null \(reading 'name'\)"):
        asyncio.run(write_pdp_geo_generator_rag_profile({"analysisPrompt": "p", "documents": [None]}, state))

    assert (state / "analysis-prompt_v1.md").read_text(encoding="utf-8") == "p\n"
    assert [path.name for path in state.iterdir()] == ["analysis-prompt_v1.md"]


@pytest.mark.parametrize("scalar", [0, "scalar"])
def test_profile_scalar_document_fails_after_managed_writes_before_brand_filtering(tmp_path: Path, scalar: object) -> None:
    """JS boxes scalar property access, then faults when the brand predicate calls ``undefined.replace``."""

    state = tmp_path / "state"
    with pytest.raises(TypeError, match=r"Cannot read properties of undefined \(reading 'replace'\)"):
        asyncio.run(write_pdp_geo_generator_rag_profile({"analysisPrompt": "p", "documents": [scalar]}, state))

    assert (state / "analysis-prompt_v1.md").read_text(encoding="utf-8") == "p\n"
    assert all((state / str(document["name"])).is_file() for document in DEFAULT_PDP_GEO_GENERATOR_RAG_PROFILE["documents"])
    assert not (state / "custom").exists()


def test_custom_profile_write_and_read_preserve_retained_locale_order(tmp_path: Path) -> None:
    profile = {
        "analysisPrompt": "Retained prompt",
        "documents": [{"name": name, "content": name} for name in ["Z.md", "a.md", "ä.md"]],
    }
    written = asyncio.run(write_pdp_geo_generator_rag_profile(profile, tmp_path))
    read = asyncio.run(read_pdp_geo_generator_rag_profile(tmp_path))

    for stored in [written, read]:
        assert [document["name"] for document in stored["documents"] if not document["managed"]] == [
            "a_v1.md", "ä_v1.md", "Z_v1.md"
        ]


def test_profile_reads_nested_brand_paths_in_retained_locale_order(tmp_path: Path) -> None:
    """Legacy recursive ``localeCompare`` ordering applies to brand paths too."""

    for name in ["brands/Z/identity_v1.md", "brands/a/identity_v1.md", "brands/ä/identity_v1.md"]:
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(name, encoding="utf-8")

    stored = asyncio.run(read_pdp_geo_generator_rag_profile(tmp_path))

    assert [
        document["name"]
        for document in stored["documents"]
        if document["managed"] and document["name"] in {"brands/Z/identity_v1.md", "brands/a/identity_v1.md", "brands/ä/identity_v1.md"}
    ] == ["brands/a/identity_v1.md", "brands/ä/identity_v1.md", "brands/Z/identity_v1.md"]


def test_profile_read_replaces_invalid_utf8_and_keeps_allowed_extension_directories(tmp_path: Path) -> None:
    """Node's UTF-8 reader replaces malformed bytes and reads ``folder.md`` as an empty attachment."""

    custom = tmp_path / "custom"
    custom.mkdir()
    (custom / "bad_v1.md").write_bytes(b"\xff")
    (custom / "folder.md").mkdir()

    stored = asyncio.run(read_pdp_geo_generator_rag_profile(tmp_path))

    custom_documents = [
        {key: value for key, value in document.items() if key != "updatedAt"}
        for document in stored["documents"]
        if not document["managed"]
    ]
    assert custom_documents == [
        {"name": "bad_v1.md", "version": "v1", "content": "�", "managed": False, "path": "custom/bad_v1.md", "size": 3},
        {"name": "folder.md", "version": "v1", "content": "", "managed": False, "path": "custom/folder.md", "size": 0},
    ]


def test_explicit_profile_directory_does_not_merge_packaged_brand_overlay(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An explicit legacy directory is its complete brand corpus, not an overlay target."""

    packaged = tmp_path / "packaged"
    packaged_brand = packaged / "brands" / "packaged" / "identity_v1.md"
    packaged_brand.parent.mkdir(parents=True)
    packaged_brand.write_text("# packaged\n", encoding="utf-8")
    state = tmp_path / "state"
    state_brand = state / "brands" / "state" / "identity_v1.md"
    state_brand.parent.mkdir(parents=True)
    state_brand.write_text("# state\n", encoding="utf-8")
    monkeypatch.setattr(profile_store, "managed_rag_directory", cast(Callable[[], object], lambda: packaged))

    stored = asyncio.run(read_pdp_geo_generator_rag_profile(state))

    names = [document["name"] for document in stored["documents"] if document["managed"]]
    assert "brands/state/identity_v1.md" in names
    assert "brands/packaged/identity_v1.md" not in names


def test_custom_profile_preserves_retained_enumeration_for_collation_equal_names(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Give both real stores the same non-codepoint directory enumeration.
    names = ["a\u2060.md", "a.md", "a\u200d.md", "a\u00ad.md"]
    custom = tmp_path / "custom"
    custom.mkdir()
    for name in names:
        (custom / name).write_text("x\n", encoding="utf-8")
    original_iterdir = Path.iterdir

    def controlled_iterdir(path: Path) -> Iterator[Path]:
        return iter(custom / name for name in names) if path == custom else original_iterdir(path)

    monkeypatch.setattr(Path, "iterdir", controlled_iterdir)

    stored = asyncio.run(read_pdp_geo_generator_rag_profile(tmp_path))

    assert [document["name"] for document in stored["documents"] if not document["managed"]] == names


def test_profile_loads_managed_corpus_and_brand_overlays() -> None:
    profile: dict[str, Any] = asyncio.run(read_pdp_geo_generator_rag_profile())
    documents = cast(list[dict[str, Any]], profile["documents"])
    names = {document["name"] for document in documents}
    manifest_documents = cast(dict[str, str], PDP_GEO_GENERATOR_RAG_MANIFEST["documents"])
    brand_identities = cast(dict[str, str], PDP_GEO_GENERATOR_RAG_MANIFEST["brandIdentities"])
    assert profile["profile"] == "pdp-geo-generator-default"
    assert manifest_documents["contentFieldContracts"] in names
    assert brand_identities["sample_botanics"] in names
    assert brand_identities["sample_derma"] in names


def test_profile_reset_preserves_existing_managed_file_and_removes_custom_attachment(tmp_path: Path) -> None:
    documents = cast(dict[str, str], PDP_GEO_GENERATOR_RAG_MANIFEST["documents"])
    name = documents["geoResearch"]
    source = tmp_path / name
    source.write_text("# Updated managed corpus\n", encoding="utf-8")
    custom = tmp_path / "custom" / "attachment_v1.md"
    custom.parent.mkdir()
    custom.write_text("# Attachment\n", encoding="utf-8")

    asyncio.run(reset_pdp_geo_generator_rag_profile(tmp_path))

    assert source.read_text(encoding="utf-8") == "# Updated managed corpus\n"
    assert not custom.exists()
    asyncio.run(write_pdp_geo_generator_rag_profile({"analysisPrompt": "custom prompt"}, tmp_path))
    assert source.read_text(encoding="utf-8") == "# Updated managed corpus\n"


def test_default_writes_use_configured_state_volume_not_read_only_package_data(
    tmp_path: Path, monkeypatch: Any
) -> None:
    """Package RAG assets are immutable; only the configured state volume mutates.

    This simulates an installed wheel whose bundled resource directory is
    read-only.  The default read keeps package-managed brand data available,
    while default write/reset persist across a later read through the mounted
    state directory instead of touching those package bytes.
    """

    package_root = tmp_path / "installed-wheel-rag"
    brand = package_root / "brands" / "neo" / "brand-identity_v1.md"
    brand.parent.mkdir(parents=True)
    brand.write_text("# Neo identity\n", encoding="utf-8")
    package_root.chmod(0o555)
    brand.parent.chmod(0o555)
    brand.chmod(0o444)
    state = tmp_path / "persistent-volume"
    monkeypatch.setenv("PDP_GEO_GENERATOR_RAG_STATE_DIR", str(state))
    monkeypatch.setattr(profile_store, "managed_rag_directory", cast(Callable[[], object], lambda: package_root))

    before = brand.read_bytes()
    initial = asyncio.run(read_pdp_geo_generator_rag_profile())
    assert any(document["name"] == "brands/neo/brand-identity_v1.md" for document in initial["documents"])

    written = asyncio.run(
        write_pdp_geo_generator_rag_profile(
            {
                "analysisPrompt": "State-only policy",
                "documents": [{"name": "ＡＢＣ.md", "version": "v1", "content": "first attachment"}],
            }
        )
    )
    assert (state / "custom" / "ABC_v1.md").read_text(encoding="utf-8") == "first attachment\n"
    assert brand.read_bytes() == before
    assert any(document["name"] == "ABC_v1.md" for document in written["documents"])

    restarted = asyncio.run(read_pdp_geo_generator_rag_profile())
    assert restarted["analysisPrompt"] == "State-only policy\n"
    assert any(
        document["name"] == "ABC_v1.md" and document["content"] == "first attachment\n"
        for document in restarted["documents"]
    )

    asyncio.run(
        write_pdp_geo_generator_rag_profile(
            {"analysisPrompt": "State-only policy", "documents": [{"name": "ABC.md", "content": "replacement"}]}
        )
    )
    assert sorted(path.name for path in (state / "custom").iterdir()) == ["ABC_v1.md"]
    assert (state / "custom" / "ABC_v1.md").read_text(encoding="utf-8") == "replacement\n"

    asyncio.run(reset_pdp_geo_generator_rag_profile())
    assert not (state / "custom" / "ABC_v1.md").exists()
    assert brand.read_bytes() == before


def test_custom_filename_limit_uses_retained_utf16_slice_semantics(tmp_path: Path) -> None:
    deseret = "\U00010400"
    profile = {"analysisPrompt": "Terminal retained prompt", "documents": [{"name": f"{deseret * 80}.md", "content": "x"}]}
    asyncio.run(write_pdp_geo_generator_rag_profile(profile, tmp_path))

    assert sorted(path.name for path in (tmp_path / "custom").iterdir()) == [f"{deseret * 40}_v1.md"]


def test_custom_odd_utf16_slice_matches_node_filename_cleanup(tmp_path: Path) -> None:
    deseret = "\U00010400"
    profile = {"analysisPrompt": "Terminal retained prompt", "documents": [{"name": f"A{deseret * 40}.md", "content": "x"}]}
    stored = asyncio.run(write_pdp_geo_generator_rag_profile(profile, tmp_path))

    assert [document["name"] for document in stored["documents"] if not document["managed"]] == []
    assert list((tmp_path / "custom").iterdir()) == []


def _frozen_profile_sha256(value: object) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def _without_updated_at(document: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in document.items() if key != "updatedAt"}


def test_frozen_profile_contract_replays_filename_locale_utf16_and_partial_write_order(tmp_path: Path) -> None:
    """Characterize the legacy Node profile store without keeping a Node oracle."""

    contract = load_frozen_rag_profile_contract()
    deseret = "\U00010400"
    inputs: dict[str, dict[str, object]] = {
        "dotfiles": {
            "analysisPrompt": "Retained prompt",
            "documents": [
                {"name": name, "content": "x"}
                for name in ["..txt", ".txt", "...txt", ".config.json", "doc.txt/", "dir/.txt"]
            ],
        },
        "version-digits": {
            "analysisPrompt": "Retained prompt",
            "documents": [
                {"name": "doc_v١.txt", "content": "x"},
                {"name": "plain.txt", "version": "v١", "content": "x"},
                {"name": "ascii_v12.txt", "content": "x"},
            ],
        },
        "locale-order": {
            "analysisPrompt": "Retained prompt",
            "documents": [{"name": name, "content": name} for name in ["Z.md", "a.md", "ä.md"]],
        },
        "utf16-even": {
            "analysisPrompt": "Terminal retained prompt",
            "documents": [{"name": f"{deseret * 80}.md", "content": "x"}],
        },
        "utf16-odd": {
            "analysisPrompt": "Terminal retained prompt",
            "documents": [{"name": f"A{deseret * 40}.md", "content": "x"}],
        },
        "nfkc-extension": {
            "analysisPrompt": "Retained prompt",
            "documents": [{"name": "doc．txt", "content": "x"}],
        },
    }

    for expected in cast(list[dict[str, str]], contract["cases"]):
        profile = inputs[expected["id"]]
        directory = tmp_path / expected["id"]
        stored = asyncio.run(write_pdp_geo_generator_rag_profile(profile, directory))
        read = asyncio.run(read_pdp_geo_generator_rag_profile(directory))
        output = {
            "filenames": sorted(path.name for path in (directory / "custom").iterdir()),
            "documents": [
                _without_updated_at(document)
                for document in cast(list[dict[str, Any]], stored["documents"])
                if not document["managed"]
            ],
            "readDocuments": [
                _without_updated_at(document)
                for document in cast(list[dict[str, Any]], read["documents"])
                if not document["managed"]
            ],
        }
        assert _frozen_profile_sha256(profile) == expected["inputSha256"]
        assert _frozen_profile_sha256(output) == expected["outputSha256"]

    partial = {
        "analysisPrompt": "partial prompt",
        "documents": [
            {
                "name": cast(dict[str, str], PDP_GEO_GENERATOR_RAG_MANIFEST["documents"])["contentFieldContracts"],
                "content": 42,
            }
        ],
    }
    partial_directory = tmp_path / "partial"
    expected_error = cast(dict[str, str], cast(dict[str, Any], contract["partialWrite"])["error"])
    with pytest.raises(TypeError) as partial_error:
        asyncio.run(write_pdp_geo_generator_rag_profile(partial, partial_directory))
    assert {"name": type(partial_error.value).__name__, "message": str(partial_error.value)} == expected_error
    partial_output = {
        "error": {"name": type(partial_error.value).__name__, "message": str(partial_error.value)},
        "analysisPrompt": (partial_directory / "analysis-prompt_v1.md").read_text(encoding="utf-8"),
        "customNames": sorted(path.name for path in (partial_directory / "custom").iterdir())
        if (partial_directory / "custom").exists()
        else [],
    }
    partial_contract = cast(dict[str, str], contract["partialWrite"])
    assert _frozen_profile_sha256(partial) == partial_contract["inputSha256"]
    assert _frozen_profile_sha256(partial_output) == partial_contract["outputSha256"]

    failure_inputs: dict[str, dict[str, object]] = {
        "custom-non-string": {
            "profile": {
                "analysisPrompt": "p",
                "documents": [{"name": "first.md", "content": "first"}, {"name": "bad.md", "content": 0}],
            },
            "initialCustom": {"stale_v1.md": "stale\n"},
        },
        "brand-non-string": {
            "profile": {
                "analysisPrompt": "p",
                "documents": [
                    {"name": "brands/neo/first.md", "content": "first"},
                    {"name": "brands/neo/bad.md", "content": 0},
                ],
            },
            "initialCustom": {"stale_v1.md": "stale\n"},
        },
    }
    for expected in cast(list[dict[str, object]], contract["failureCases"]):
        failure_input = failure_inputs[cast(str, expected["id"])]
        profile = cast(dict[str, object], failure_input["profile"])
        failure_directory = tmp_path / cast(str, expected["id"])
        custom = failure_directory / "custom"
        custom.mkdir(parents=True)
        for name, content in cast(dict[str, str], failure_input["initialCustom"]).items():
            (custom / name).write_text(content, encoding="utf-8")

        with pytest.raises(TypeError) as failure_error:
            asyncio.run(write_pdp_geo_generator_rag_profile(profile, failure_directory))
        error = {"name": type(failure_error.value).__name__, "message": str(failure_error.value)}
        assert error == expected["error"]

        def contents(directory: Path) -> dict[str, str]:
            return {
                path.name: path.read_text(encoding="utf-8")
                for path in sorted(directory.iterdir())
            } if directory.exists() else {}

        output = {
            "error": error,
            "analysisPrompt": (failure_directory / "analysis-prompt_v1.md").read_text(encoding="utf-8"),
            "custom": contents(custom),
            "brand": contents(failure_directory / "brands" / "neo"),
        }
        assert _frozen_profile_sha256(failure_input) == expected["inputSha256"]
        assert _frozen_profile_sha256(output) == expected["outputSha256"]
