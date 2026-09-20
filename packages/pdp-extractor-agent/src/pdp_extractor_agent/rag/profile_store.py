"""Mutable RAG profile storage outside installed package directories."""

from __future__ import annotations

import json
import math
import os
import re
from collections.abc import Mapping
from datetime import UTC, datetime
from importlib import import_module
from pathlib import Path
from typing import Any, Protocol, cast
from unicodedata import normalize

from neo_js_compat import js_number_to_string, js_utf8_replacement_text, js_utf16_slice

from .._json_types import as_list, as_mapping
from .default_profile import default_profile
from .manifest import PRODUCT_EXTRACTOR_RAG_MANIFEST

_PROFILE_NAME = "pdp-extractor-rag-profile.json"
_ALLOWED_DOCUMENT_EXTENSIONS = {".md", ".txt", ".json", ".csv"}


class _IcuCollator(Protocol):
    def getSortKey(self, value: str) -> bytes: ...


class _IcuFactory(Protocol):
    @staticmethod
    def createInstance(locale: object) -> _IcuCollator: ...


class _IcuLocaleFactory(Protocol):
    def __call__(self, name: str) -> object: ...


# Match the retained Node server's default localeCompare collation. PyICU has
# no bundled type information, so constrain only the two attributes we use.
_ICU_MODULE = import_module("icu")
_ICU = cast(_IcuFactory, getattr(_ICU_MODULE, "Collator")).createInstance(
    cast(_IcuLocaleFactory, getattr(_ICU_MODULE, "Locale"))("en_US")
)


class _Undefined:
    """A source-property value absent from JSON objects, distinct from null."""


_UNDEFINED = _Undefined()


def read_profile(*, state_dir: Path | str | None = None, fixture: Mapping[str, Any] | None = None) -> dict[str, Any]:
    if fixture is not None:
        return _validate_profile(fixture)
    path = _state_path(state_dir)
    if not path.exists():
        return default_profile()
    value: object = json.loads(path.read_text(encoding="utf-8"))
    return _validate_profile(value)


def write_profile(profile: Mapping[str, Any], *, state_dir: Path | str | None = None) -> dict[str, Any]:
    normalized = _validate_profile(profile)
    path = _state_path(state_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(normalized, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return normalized


def reset_profile(*, state_dir: Path | str | None = None) -> dict[str, Any]:
    profile = default_profile()
    return write_profile(profile, state_dir=state_dir)


def read_product_extractor_rag_profile(*, state_dir: Path | str | None = None) -> dict[str, Any]:
    """Read the named public profile shape including managed-document metadata."""

    defaults = default_profile()
    directory = _state_directory(state_dir)
    documents: list[dict[str, Any]] = []
    for default_document in defaults["documents"]:
        name = str(default_document["name"])
        content, metadata_path = _read_public_text(
            directory / name,
            _package_asset_path(name),
            str(default_document["content"]),
        )
        documents.append(
            _public_document(
                name=name,
                version=str(default_document.get("version", "v1")),
                content=content,
                managed=True,
                path=name,
                metadata_path=metadata_path,
            )
        )
    custom_directory = directory / "custom"
    if custom_directory.is_dir():
        custom_paths = sorted(
            (
                candidate
                for candidate in custom_directory.iterdir()
                if candidate.is_file() and candidate.suffix.lower() in _ALLOWED_DOCUMENT_EXTENSIONS
            ),
            key=lambda candidate: _ICU.getSortKey(candidate.name),
        )
        for path in custom_paths:
            content, metadata_path = _read_public_text(path, None, "")
            documents.append(
                _public_document(
                    name=path.name,
                    version=_extract_version(path.name),
                    content=content,
                    managed=False,
                    path=f"custom/{path.name}",
                    metadata_path=metadata_path,
                )
            )
    prompt, _ = _read_public_text(
        directory / PRODUCT_EXTRACTOR_RAG_MANIFEST["analysisPrompt"],
        _package_asset_path(PRODUCT_EXTRACTOR_RAG_MANIFEST["analysisPrompt"]),
        str(defaults["analysisPrompt"]),
    )
    updates = [str(document["updatedAt"]) for document in documents if isinstance(document.get("updatedAt"), str)]
    result: dict[str, Any] = {
        "profile": PRODUCT_EXTRACTOR_RAG_MANIFEST["profile"],
        "analysisPrompt": prompt,
        "documents": documents,
    }
    if updates:
        result["updatedAt"] = max(updates)
    return result


def write_product_extractor_rag_profile(
    profile: Mapping[str, Any], *, state_dir: Path | str | None = None
) -> dict[str, Any]:
    """Write the public patch DTO and return the storage-enriched profile.

    The route-level contract takes only ``analysisPrompt`` plus optional
    documents.  Managed policy files are restored by name when omitted, while
    unrecognized documents are written as normalized custom attachments.
    """

    defaults = default_profile()
    directory = _state_directory(state_dir)
    directory.mkdir(parents=True, exist_ok=True)
    _write_public_text(
        directory / PRODUCT_EXTRACTOR_RAG_MANIFEST["analysisPrompt"],
        _ensure_source_trailing_newline(_public_prompt(profile, defaults)),
    )

    # The retained writer builds this Map *after* prompt persistence, then
    # writes managed replacements, then iterates the raw filtered array for
    # custom files. Keep both the error order and each pre-error write.
    documents = _source_documents(profile)
    incoming = _incoming_documents(documents)
    _write_public_managed_assets(directory, defaults, incoming)
    _write_public_custom_assets(directory, documents, defaults)

    stored = read_product_extractor_rag_profile(state_dir=state_dir)
    # This private Python retrieval snapshot is persisted only after all
    # retained public writes have succeeded, so it cannot alter Node-visible
    # pre-error filesystem state.
    write_profile(stored, state_dir=state_dir)
    return stored


def reset_product_extractor_rag_profile(*, state_dir: Path | str | None = None) -> dict[str, Any]:
    defaults = default_profile()
    return write_product_extractor_rag_profile(
        {"analysisPrompt": defaults["analysisPrompt"], "documents": defaults["documents"]}, state_dir=state_dir
    )


readProductExtractorRagProfile = read_product_extractor_rag_profile
writeProductExtractorRagProfile = write_product_extractor_rag_profile
resetProductExtractorRagProfile = reset_product_extractor_rag_profile


def _state_path(state_dir: Path | str | None) -> Path:
    return _state_directory(state_dir) / _PROFILE_NAME


def _state_directory(state_dir: Path | str | None) -> Path:
    return (
        Path(state_dir)
        if state_dir is not None
        else Path(os.environ.get("PDP_EXTRACTOR_RAG_STATE_DIR", ".pdp-extractor-rag"))
    )


def _package_asset_path(name: str) -> Path | None:
    """Installed wheels expose package data as normal files on supported runtimes."""

    path = Path(__file__).resolve().parents[1] / "resources" / "rag" / name
    return path if path.is_file() else None


def _read_public_text(primary: Path, fallback_path: Path | None, fallback: str) -> tuple[str, Path | None]:
    for path in (primary, fallback_path):
        if path is None:
            continue
        try:
            return _ensure_trailing_newline(path.read_text(encoding="utf-8")), path
        except OSError:
            continue
    return _ensure_trailing_newline(fallback), None


def _public_document(
    *,
    name: str,
    version: str,
    content: str,
    managed: bool,
    path: str,
    metadata_path: Path | None,
) -> dict[str, Any]:
    document: dict[str, Any] = {
        "name": name,
        "version": version,
        "content": content,
        "managed": managed,
        "path": path,
        "size": len(content.encode("utf-8")),
    }

    try:
        timestamp = metadata_path.stat().st_mtime if metadata_path is not None else None
    except OSError:
        timestamp = None
    if timestamp is not None:
        document["updatedAt"] = datetime.fromtimestamp(timestamp, UTC).isoformat(timespec="milliseconds").replace(
            "+00:00", "Z"
        )
    return document


def _public_prompt(value: Mapping[str, Any], defaults: Mapping[str, Any]) -> object:
    """Evaluate retained ``profile.analysisPrompt || default`` without coercion."""

    prompt_value = value.get("analysisPrompt")
    return prompt_value if _js_truthy(prompt_value) else defaults["analysisPrompt"]


def _js_truthy(value: object) -> bool:
    """JavaScript truthiness for decoded JSON values, including empty arrays/maps."""

    if value is None or value is False:
        return False
    if isinstance(value, str):
        return value != ""
    if isinstance(value, int | float) and not isinstance(value, bool):
        return value != 0 and value == value
    return True


def _write_public_text(path: Path, content: str) -> None:
    """Write a Node UTF-8 string, including lone-surrogate replacement."""

    node_path = Path(js_utf8_replacement_text(str(path)))
    node_path.parent.mkdir(parents=True, exist_ok=True)
    node_path.write_text(js_utf8_replacement_text(content), encoding="utf-8")


def _write_public_managed_assets(
    directory: Path, defaults: Mapping[str, Any], incoming: list[tuple[object, object]]
) -> None:
    for default_document in defaults["documents"]:
        replacement = _map_get(incoming, default_document["name"])
        selected = replacement if replacement is not None else default_document
        _write_public_text(
            directory / str(default_document["name"]),
            _ensure_source_trailing_newline(_source_document_property(selected, "content")),
        )


def _write_public_custom_assets(directory: Path, documents: list[object], defaults: Mapping[str, Any]) -> None:
    custom_directory = directory / "custom"
    custom_directory.mkdir(parents=True, exist_ok=True)
    managed_names = {document["name"] for document in defaults["documents"]}
    expected_names: set[str] = set()
    for document in documents:
        name = _source_document_property(document, "name")
        if isinstance(name, str) and name in managed_names:
            continue
        version = _source_document_property(document, "version")
        if version is _UNDEFINED:
            version = "v1"
        safe_name = _safe_rag_file_name(name, version)
        expected_names.add(safe_name)
        _write_public_text(
            custom_directory / safe_name,
            _ensure_source_trailing_newline(_source_document_property(document, "content")),
        )
    for path in custom_directory.iterdir():
        if path.is_file() and path.suffix.lower() in _ALLOWED_DOCUMENT_EXTENSIONS and path.name not in expected_names:
            path.unlink()


def _source_documents(value: Mapping[str, Any]) -> list[object]:
    """Evaluate ``profile.documents ?? []`` at the retained ``.map`` boundary."""

    documents = value.get("documents")
    if documents is None:
        return []
    if not isinstance(documents, list):
        raise TypeError("(profile.documents ?? []).map is not a function")
    return cast(list[object], documents)


def _source_document_property(document: object, name: str) -> object:
    """Read a JavaScript document property, retaining undefined versus null."""

    if document is None:
        raise TypeError(f"Cannot read properties of null (reading '{name}')")
    mapping = as_mapping(document)
    return mapping[name] if mapping is not None and name in mapping else _UNDEFINED


def _ensure_source_trailing_newline(value: object) -> str:
    if value is _UNDEFINED:
        raise TypeError("Cannot read properties of undefined (reading 'endsWith')")
    if value is None:
        raise TypeError("Cannot read properties of null (reading 'endsWith')")
    if not isinstance(value, str):
        raise TypeError("value.endsWith is not a function")
    return _ensure_trailing_newline(value)


def _incoming_documents(documents: list[object]) -> list[tuple[object, object]]:
    """Port ``new Map(documents.map(...))`` without Python hashability limits."""

    incoming: list[tuple[object, object]] = []
    for document in documents:
        name = _source_document_property(document, "name")
        for index, (existing, _existing_document) in enumerate(incoming):
            if _same_map_key(existing, name):
                incoming[index] = (name, document)
                break
        else:
            incoming.append((name, document))
    return incoming


def _map_get(incoming: list[tuple[object, object]], key: object) -> object | None:
    for candidate, document in incoming:
        if _same_map_key(candidate, key):
            return document
    return None


def _same_map_key(left: object, right: object) -> bool:
    """Implement the JSON-relevant subset of JavaScript Map's SameValueZero."""

    if isinstance(left, str) and isinstance(right, str):
        return left == right
    if left is None or right is None:
        return left is right
    if isinstance(left, bool) or isinstance(right, bool):
        return isinstance(left, bool) and isinstance(right, bool) and left is right
    if isinstance(left, int | float) and isinstance(right, int | float):
        return left == right
    return left is right


def _safe_rag_file_name(name: object, version: object = "v1") -> str:
    suffix = _node_extname(name).lower()
    # ``extname`` is deliberately evaluated before ``name.replace`` in the
    # retained implementation, including for malformed non-string names.
    if not isinstance(name, str):
        raise AssertionError("_node_extname must reject non-string names")
    extension = suffix if suffix in _ALLOWED_DOCUMENT_EXTENSIONS else ".md"
    base_name = re.sub(r"\.[^.]+$", "", name)
    base_name = normalize("NFKC", base_name)
    base_name = js_utf16_slice(re.sub(r"[^\w._-]+", "-", base_name, flags=re.UNICODE).strip("-"), 0, 80)
    base_name = base_name or "rag-document"
    versioned = (
        base_name
        if re.search(r"_v[0-9]+$", base_name, re.IGNORECASE)
        else f"{base_name}_{_js_template_string(version)}"
    )
    return f"{versioned}{extension}"


def _node_extname(value: object) -> str:
    """Provide ``node:path.extname``'s observable type boundary."""

    if not isinstance(value, str):
        if value is _UNDEFINED:
            raise TypeError('The "path" argument must be of type string. Received undefined')
        if isinstance(value, int | float) and not isinstance(value, bool):
            rendered = "-0" if value == 0 and math.copysign(1, value) < 0 else js_number_to_string(value)
            raise TypeError(f'The "path" argument must be of type string. Received type number ({rendered})')
        if value is None:
            raise TypeError('The "path" argument must be of type string. Received null')
        if isinstance(value, bool):
            raise TypeError(f'The "path" argument must be of type string. Received type boolean ({str(value).lower()})')
        if isinstance(value, list):
            raise TypeError('The "path" argument must be of type string. Received an instance of Array')
        if isinstance(value, Mapping):
            raise TypeError('The "path" argument must be of type string. Received an instance of Object')
        raise TypeError('The "path" argument must be of type string. Received type object')
    # Node's POSIX extname ignores trailing separators and recognizes the
    # last dot unless it starts the basename or the basename is exactly '..'.
    basename = value.rstrip("/").rsplit("/", 1)[-1]
    dot = basename.rfind(".")
    return basename[dot:] if dot > 0 and basename != ".." else ""


def _js_template_string(value: object) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return value
    if isinstance(value, int | float) and not isinstance(value, bool):
        return js_number_to_string(value)
    if isinstance(value, list):
        # Array#toString delegates to join, whose nullish entries are empty.
        return ",".join("" if item is None else _js_template_string(item) for item in cast(list[object], value))
    if isinstance(value, Mapping):
        return "[object Object]"
    return str(value)


def _extract_version(name: str) -> str:
    matched = re.search(r"_v([0-9]+)\.[^.]+$", name, re.IGNORECASE)
    return f"v{matched.group(1)}" if matched else "v1"


def _ensure_trailing_newline(value: str) -> str:
    return value if value.endswith("\n") else f"{value}\n"


def _validate_profile(value: object) -> dict[str, Any]:
    mapping = as_mapping(value)
    if mapping is None:
        raise ValueError("RAG profile must be an object")
    profile = mapping.get("profile")
    prompt = mapping.get("analysisPrompt")
    documents = as_list(mapping.get("documents"))
    if not isinstance(profile, str) or not isinstance(prompt, str) or documents is None:
        raise ValueError("RAG profile requires profile, analysisPrompt, and documents")
    normalized: list[dict[str, str]] = []
    for raw_document in documents:
        document = as_mapping(raw_document)
        if (
            document is None
            or not isinstance(document.get("name"), str)
            or not isinstance(document.get("content"), str)
        ):
            raise ValueError("RAG documents require string name and content")
        normalized.append(
            {"name": document["name"], "version": str(document.get("version", "v1")), "content": document["content"]}
        )
    return {"profile": profile, "analysisPrompt": prompt, "documents": normalized}
