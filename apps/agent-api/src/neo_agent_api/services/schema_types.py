"""Schema type extraction and JavaScript-compatible result hashing."""

from __future__ import annotations

from neo_js_compat import js_result_hash

from neo_agent_api._json import as_dict, as_list


def derive_schema_types(json_ld: object) -> list[str]:
    record = as_dict(json_ld)
    if not record:
        return []
    graph = record.get("@graph")
    nodes = as_list(graph) if isinstance(graph, list) else [record]
    result: list[str] = []
    for node in nodes:
        node_record = as_dict(node)
        if not node_record:
            continue
        raw_type = node_record.get("@type")
        values = as_list(raw_type) if isinstance(raw_type, list) else [raw_type]
        for value in values:
            if isinstance(value, str) and value not in result:
                result.append(value)
    return result


def compute_result_hash(json_ld: object) -> str:
    """Return exactly the retained TypeScript canonicalize/JSON.stringify hash."""

    return js_result_hash(json_ld)
