"""Narrow untrusted JSON/provider values at the extraction boundary.

HTTP clients, custom callbacks, and JSON decoders deliberately enter this
package as ``object``.  These helpers retain the legacy permissive runtime
semantics while giving the rest of the implementation explicit, parameterized
container types under the workspace's strict Pyright configuration.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, cast


def as_mapping(value: object) -> Mapping[str, Any] | None:
    """Return a string-keyed view of a runtime mapping, if one was supplied."""

    if not isinstance(value, Mapping):
        return None
    return cast(Mapping[str, Any], value)


def as_dict(value: object) -> dict[str, Any] | None:
    """Copy a runtime mapping into the mutable wire-object shape."""

    mapping = as_mapping(value)
    return dict(mapping) if mapping is not None else None


def as_list(value: object) -> list[Any] | None:
    """Return an untrusted JSON list with an explicit element boundary."""

    return cast(list[Any], value) if isinstance(value, list) else None


def as_sequence(value: object) -> Sequence[Any] | None:
    """Return a non-string sequence used by legacy iterable adapters."""

    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        return None
    return cast(Sequence[Any], value)
