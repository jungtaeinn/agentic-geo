"""Small, source-preserving normalization helpers shared by refinement paths."""

from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
from typing import Any

from ._json_types import as_list, as_mapping


def merge_source_product(base: Mapping[str, Any], patch: Mapping[str, Any]) -> dict[str, Any]:
    """Recursively merge an explicit patch without discarding source arrays.

    Lists are ordered unions because a user refinement augments source evidence;
    it is not an instruction to erase what the extractor actually observed.
    """

    output: dict[str, Any] = deepcopy(dict(base))
    for key, value in patch.items():
        current = output.get(key)
        current_mapping, value_mapping = as_mapping(current), as_mapping(value)
        if current_mapping is not None and value_mapping is not None:
            output[key] = merge_source_product(current_mapping, value_mapping)
        elif (current_list := as_list(current)) is not None and (value_list := as_list(value)) is not None:
            output[key] = _unique([*current_list, *value_list])
        else:
            output[key] = deepcopy(value)
    return output


def omit_evidence_internals(value: Any) -> Any:
    """Return a detached public artifact without deleting OCR provenance.

    ``imageUrl``, ``imageUrls``, and ``confidence`` are public extraction
    evidence (and are retained by the TypeScript JSON clone).  Earlier Python
    code treated them as transport internals, which made a harmless refinement
    destroy lineage downstream consumers rely on.
    """

    return deepcopy(value)


def _unique(values: list[Any]) -> list[Any]:
    output: list[Any] = []
    for value in values:
        if value not in output:
            output.append(deepcopy(value))
    return output
