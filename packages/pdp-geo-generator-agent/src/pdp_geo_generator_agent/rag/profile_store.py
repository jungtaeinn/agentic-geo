"""Safe filesystem persistence for editable RAG profiles."""

from __future__ import annotations

import asyncio
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

from .default_profile import DEFAULT_PDP_GEO_GENERATOR_RAG_PROFILE, managed_rag_directory
from .manifest import PDP_GEO_GENERATOR_RAG_MANIFEST

_ALLOWED_EXTENSIONS = {".md", ".txt", ".json", ".csv"}
_STATE_DIRECTORY_ENVIRONMENT = "PDP_GEO_GENERATOR_RAG_STATE_DIR"
_DEFAULT_STATE_DIRECTORY = ".pdp-geo-generator-rag"
_JS_UNDEFINED = object()


class _IcuCollator(Protocol):
    def getSortKey(self, value: str) -> bytes: ...


class _IcuFactory(Protocol):
    @staticmethod
    def createInstance(locale: object) -> _IcuCollator: ...


class _IcuLocaleFactory(Protocol):
    def __call__(self, name: str) -> object: ...


class _IcuModule(Protocol):
    """The small runtime surface used from PyICU's untyped extension module."""

    Collator: _IcuFactory
    Locale: _IcuLocaleFactory


# Match the retained Node server's default localeCompare collation.
_ICU_MODULE = cast(_IcuModule, import_module("icu"))
_ICU = _ICU_MODULE.Collator.createInstance(_ICU_MODULE.Locale("en_US"))


def _state_directory(directory: str | Path | None) -> Path:
    """Return mutable profile state, never an installed package resource."""

    if directory is not None:
        return Path(directory)
    configured = os.environ.get(_STATE_DIRECTORY_ENVIRONMENT)
    return Path(configured) if configured else Path(_DEFAULT_STATE_DIRECTORY)


async def read_pdp_geo_generator_rag_profile(directory: str | Path | None = None) -> dict[str, Any]:
    return await _read_profile(_state_directory(directory), include_packaged_brands=directory is None)


async def _read_profile(root: Path, *, include_packaged_brands: bool) -> dict[str, Any]:
    prompt_name = str(PDP_GEO_GENERATOR_RAG_MANIFEST["analysisPrompt"])
    analysis_prompt = await _read_text(root / prompt_name, str(DEFAULT_PDP_GEO_GENERATOR_RAG_PROFILE["analysisPrompt"]))
    defaults = list(DEFAULT_PDP_GEO_GENERATOR_RAG_PROFILE["documents"])
    documents = [await _read_managed(root, document) for document in defaults]
    documents.extend(await _read_brand(root, include_packaged_brands=include_packaged_brands))
    documents.extend(await _read_custom(root))
    updated = sorted(document["updatedAt"] for document in documents if isinstance(document.get("updatedAt"), str))
    result: dict[str, Any] = {
        "profile": PDP_GEO_GENERATOR_RAG_MANIFEST["profile"],
        "analysisPrompt": analysis_prompt,
        "documents": documents,
    }
    if updated:
        result["updatedAt"] = updated[-1]
    return result


async def write_pdp_geo_generator_rag_profile(
    profile: Mapping[str, object], directory: str | Path | None = None
) -> dict[str, Any]:
    root = _state_directory(directory)
    root.mkdir(parents=True, exist_ok=True)
    analysis_prompt = profile.get("analysisPrompt")
    await _write_text(
        root / str(PDP_GEO_GENERATOR_RAG_MANIFEST["analysisPrompt"]),
        _trailing_newline(
            analysis_prompt if _js_truthy(analysis_prompt) else DEFAULT_PDP_GEO_GENERATOR_RAG_PROFILE["analysisPrompt"]
        ),
    )
    documents = _profile_documents(profile.get("documents"))
    incoming = [(_document_property(document, "name"), document) for document in documents]
    for default in list(DEFAULT_PDP_GEO_GENERATOR_RAG_PROFILE["documents"]):
        name = str(default["name"])
        document = _map_value(incoming, name)
        if document is not _JS_UNDEFINED and _js_truthy(document):
            await _write_text(root / name, _trailing_newline(_document_property(document, "content")))
        elif not (root / name).exists():
            await _write_text(root / name, _trailing_newline(str(default["content"])))
    await _write_brand(root, _brand_documents(documents))
    await _write_custom(
        root,
        _custom_documents(documents),
    )
    return await _read_profile(root, include_packaged_brands=directory is None)


async def reset_pdp_geo_generator_rag_profile(directory: str | Path | None = None) -> dict[str, Any]:
    root = _state_directory(directory)
    await _clear_custom(root)
    return await write_pdp_geo_generator_rag_profile(
        {"analysisPrompt": DEFAULT_PDP_GEO_GENERATOR_RAG_PROFILE["analysisPrompt"]}, directory
    )


async def _read_managed(root: Path, default: Mapping[str, object]) -> dict[str, Any]:
    name = str(default["name"])
    content = await _read_text(root / name, str(default["content"]))
    result: dict[str, Any] = {
        "name": name,
        "version": _version(name) or str(default["version"]),
        "content": content,
        "managed": True,
        "path": name,
    }
    result.update(_metadata(root / name, content))
    return result


async def _read_brand(root: Path, *, include_packaged_brands: bool) -> list[dict[str, Any]]:
    """Overlay writable brand files over immutable package-brand resources."""

    packaged = await asyncio.to_thread(_read_packaged_brand_documents) if include_packaged_brands else []
    state = await _read_state_brand(root)
    by_name = {str(document["name"]): document for document in packaged}
    by_name.update({str(document["name"]): document for document in state})
    return [by_name[name] for name in sorted(by_name, key=_ICU.getSortKey)]


async def _read_state_brand(root: Path) -> list[dict[str, Any]]:
    brand_root = root / "brands"
    paths = await asyncio.to_thread(
        lambda: (
            sorted(
                (path for path in brand_root.rglob("*") if path.is_file() and path.suffix.lower() in _ALLOWED_EXTENSIONS),
                key=lambda path: _ICU.getSortKey(path.relative_to(root).as_posix()),
            )
            if brand_root.exists()
            else []
        )
    )
    output: list[dict[str, Any]] = []
    for path in paths:
        relative = path.relative_to(root).as_posix()
        content = await _read_text(path, "")
        row: dict[str, Any] = {
            "name": relative,
            "version": _version(relative),
            "content": content,
            "managed": True,
            "path": relative,
        }
        row.update(_metadata(path, content))
        output.append(row)
    return output


def _read_packaged_brand_documents() -> list[dict[str, Any]]:
    """Read resource-backed overlays without requiring a source-tree path.

    ``importlib.resources`` may expose a zipped wheel through a Traversable,
    so this intentionally uses only its read/list API and never calls
    ``Path(...)`` or writes beneath it.
    """

    try:
        brand_root = managed_rag_directory().joinpath("brands")
    except (AttributeError, OSError, TypeError):
        return []
    return _walk_packaged_brand_documents(brand_root, "brands")


def _walk_packaged_brand_documents(root: object, prefix: str) -> list[dict[str, Any]]:
    try:
        entries = sorted(cast(Any, root).iterdir(), key=lambda item: str(item.name))
    except (AttributeError, OSError, TypeError):
        return []
    documents: list[dict[str, Any]] = []
    for entry in entries:
        name = str(entry.name)
        relative = f"{prefix}/{name}"
        try:
            if entry.is_dir():
                documents.extend(_walk_packaged_brand_documents(entry, relative))
            elif entry.is_file() and Path(name).suffix.lower() in _ALLOWED_EXTENSIONS:
                content = cast(bytes, entry.read_bytes()).decode("utf-8", errors="replace")
                documents.append(
                    {
                        "name": relative,
                        "version": _version(relative),
                        "content": content,
                        "managed": True,
                        "path": relative,
                        "size": len(content.encode("utf-8")),
                    }
                )
        except (AttributeError, OSError):
            continue
    return documents


async def _read_custom(root: Path) -> list[dict[str, Any]]:
    custom = root / "custom"
    paths = (
        [path for path in custom.iterdir() if path.suffix.lower() in _ALLOWED_EXTENSIONS]
        if custom.exists()
        else []
    )
    output: list[dict[str, Any]] = []
    for path in paths:
        content = await _read_text(path, "")
        row: dict[str, Any] = {
            "name": path.name,
            "version": _version(path.name),
            "content": content,
            "managed": False,
            "path": f"custom/{path.name}",
        }
        row.update(_metadata(path, content))
        output.append(row)
    # Preserve directory enumeration when localeCompare considers names equal.
    return sorted(output, key=lambda document: _ICU.getSortKey(document["name"]))


async def _write_brand(root: Path, documents: list[Mapping[str, object]]) -> None:
    for document in documents:
        version = document["version"] if "version" in document else "v1"
        name = _safe_brand_name(cast(str, document.get("name")), version)
        if name:
            await _write_text(root / name, _trailing_newline(document.get("content")))


async def _write_custom(root: Path, documents: list[Mapping[str, object]]) -> None:
    custom = root / "custom"
    custom.mkdir(parents=True, exist_ok=True)
    names: set[str] = set()
    for document in documents:
        version = document["version"] if "version" in document else "v1"
        name = _safe_filename(document.get("name"), version)
        names.add(name)
        await _write_text(custom / name, _trailing_newline(document.get("content")))
    for path in custom.iterdir():
        if path.is_file() and path.suffix.lower() in _ALLOWED_EXTENSIONS and path.name not in names:
            path.unlink(missing_ok=True)


async def _clear_custom(root: Path) -> None:
    custom = root / "custom"
    if not custom.exists():
        return
    for path in custom.iterdir():
        if path.is_file() and path.suffix.lower() in _ALLOWED_EXTENSIONS:
            path.unlink(missing_ok=True)


async def _read_text(path: Path, fallback: str) -> str:
    try:
        content = await asyncio.to_thread(path.read_bytes)
    except OSError:
        return fallback
    return content.decode("utf-8", errors="replace")


async def _write_text(path: Path, content: str) -> None:
    # Node's writeFile converts a lone UTF-16 surrogate to U+FFFD while it
    # encodes the path and content. Keep the original JS string in callers'
    # Sets so their subsequent readdir cleanup observes the same mismatch.
    node_path = Path(js_utf8_replacement_text(str(path)))
    node_path.parent.mkdir(parents=True, exist_ok=True)
    await asyncio.to_thread(node_path.write_text, js_utf8_replacement_text(content), encoding="utf-8")


def _metadata(path: Path, content: str) -> dict[str, object]:
    try:
        updated = (
            datetime.fromtimestamp(path.stat().st_mtime, tz=UTC)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )
    except OSError:
        updated = None
    return {"size": len(content.encode("utf-8")), **({"updatedAt": updated} if updated else {})}


def _js_truthy(value: object) -> bool:
    """Match the JavaScript ``||`` boundary used for the editable prompt."""

    if value is None or value is False or value == "":
        return False
    if isinstance(value, int | float) and not isinstance(value, bool):
        return value != 0 and not (isinstance(value, float) and math.isnan(value))
    return True


def _profile_documents(value: object) -> list[object]:
    """Port ``(profile.documents ?? []).map(...)`` before any managed writes."""

    if value is None:
        return []
    if not isinstance(value, list):
        raise TypeError("(profile.documents ?? []).map is not a function")
    return cast(list[object], value)


def _document_property(document: object, name: str) -> object:
    """Read a legacy document property with JavaScript's per-element timing."""

    if document is None:
        raise TypeError(f"Cannot read properties of null (reading '{name}')")
    if isinstance(document, Mapping):
        return cast(Mapping[str, object], document).get(name, _JS_UNDEFINED)
    return _JS_UNDEFINED


def _map_value(entries: list[tuple[object, object]], name: str) -> object:
    """Return the last matching `new Map` value without requiring hashable JS keys."""

    value: object = _JS_UNDEFINED
    for key, document in entries:
        if key == name:
            value = document
    return value


def _brand_documents(documents: list[object]) -> list[Mapping[str, object]]:
    output: list[Mapping[str, object]] = []
    for document in documents:
        if _is_brand_name(_document_property(document, "name")):
            output.append(cast(Mapping[str, object], document))
    return output


def _custom_documents(documents: list[object]) -> list[Mapping[str, object]]:
    output: list[Mapping[str, object]] = []
    for document in documents:
        name = _document_property(document, "name")
        if not _is_managed_name(name) and not _is_brand_name(name):
            output.append(cast(Mapping[str, object], document))
    return output


def _version(name: str) -> str:
    match = re.search(r"_v([0-9]+)\.[^.]+$", name, re.I)
    return f"v{match.group(1)}" if match else "v1"


def _safe_segment(value: str) -> str:
    normalized = normalize("NFKC", value)
    return js_utf16_slice(re.sub(r"^-+|-+$", "", re.sub(r"[^\w._-]+", "-", normalized, flags=re.UNICODE)), 0, 80)


def _safe_filename(name: object, version: object = "v1") -> str:
    suffix = _node_extname(name).lower()
    if not isinstance(name, str):
        raise AssertionError("_node_extname must reject non-string names")
    suffix = suffix if suffix in _ALLOWED_EXTENSIONS else ".md"
    # The Node implementation asks ``path.extname`` and strips a literal-dot
    # suffix before NFKC.  A full-width dot therefore remains in the base but
    # becomes a normal dot during segment normalization.
    base = _safe_segment(re.sub(r"\.[^.]+$", "", name)) or "rag-document"
    return f"{base if re.search(r'_v[0-9]+$', base, re.I) else f'{base}_{_js_template_string(version)}'}{suffix}"


def _node_extname(value: object) -> str:
    if not isinstance(value, str):
        if isinstance(value, int | float) and not isinstance(value, bool):
            rendered = js_number_to_string(value)
            raise TypeError(f'The "path" argument must be of type string. Received type number ({rendered})')
        type_name = "boolean" if isinstance(value, bool) else "object"
        raise TypeError(f'The "path" argument must be of type string. Received type {type_name}')
    # Match Node's POSIX extname, including '..txt' and trailing separators.
    basename = value.rstrip("/").rsplit("/", 1)[-1]
    dot = basename.rfind(".")
    return basename[dot:] if dot > 0 and basename != ".." else ""


def _safe_brand_name(name: str, version: object = "v1") -> str | None:
    relative_name = name.replace("\\", "/")
    if not relative_name.startswith("brands/"):
        return None
    parts = [part for part in relative_name.split("/") if part]
    if len(parts) < 3 or any(part in {".", ".."} for part in parts):
        return None
    folders = [_safe_segment(part) for part in parts[:-1]]
    return "/".join([*folders, _safe_filename(parts[-1], version)])


def _is_managed_name(name: object) -> bool:
    return any(document["name"] == name for document in list(DEFAULT_PDP_GEO_GENERATOR_RAG_PROFILE["documents"]))


def _is_brand_name(name: object) -> bool:
    if name is _JS_UNDEFINED:
        raise TypeError("Cannot read properties of undefined (reading 'replace')")
    if not isinstance(name, str):
        raise TypeError("name.replace is not a function")
    return name.replace("\\", "/").startswith("brands/")


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
        return ",".join("" if item is None else _js_template_string(item) for item in cast(list[object], value))
    if isinstance(value, Mapping):
        return "[object Object]"
    return str(value)


def _trailing_newline(value: object) -> str:
    if not isinstance(value, str):
        # Match the legacy JavaScript boundary: prompt and managed-document
        # writes happen before this failure, so callers can observe ordering.
        raise TypeError("value.endsWith is not a function")
    return value if value.endswith("\n") else f"{value}\n"


readPdpGeoGeneratorRagProfile = read_pdp_geo_generator_rag_profile
writePdpGeoGeneratorRagProfile = write_pdp_geo_generator_rag_profile
resetPdpGeoGeneratorRagProfile = reset_pdp_geo_generator_rag_profile
