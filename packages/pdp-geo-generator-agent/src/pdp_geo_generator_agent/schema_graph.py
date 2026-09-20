"""JSON-LD graph lookup helpers that resolve entities by linkage."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import TypeGuard

from neo_js_compat import js_json_pretty_dumps

SchemaNode = dict[str, object]


def _is_record(value: object) -> TypeGuard[Mapping[str, object]]:
    return isinstance(value, Mapping)


def _nodes(graph: Sequence[object]) -> list[SchemaNode]:
    nodes: list[SchemaNode] = []
    for node in graph:
        if _is_record(node):
            nodes.append(dict(node))
    return nodes


def schema_node_has_type(node: Mapping[str, object] | None, type_: str) -> bool:
    """Return whether a node's scalar or array ``@type`` includes ``type_``."""
    if node is None:
        return False
    value = node.get("@type")
    return value == type_ or (isinstance(value, list) and type_ in value)


def _reference_id(value: object) -> str | None:
    if _is_record(value):
        reference = value.get("@id")
        return reference if isinstance(reference, str) else None
    return None


def resolve_primary_product_node(graph: Sequence[object]) -> SchemaNode | None:
    """Resolve the Product linked from WebPage.mainEntity before array fallback."""
    nodes = _nodes(graph)
    web_page = next((node for node in nodes if schema_node_has_type(node, "WebPage")), None)
    main_entity_id = _reference_id(web_page.get("mainEntity") if web_page else None)
    if main_entity_id:
        linked = next(
            (node for node in nodes if node.get("@type") == "Product" and node.get("@id") == main_entity_id), None
        )
        if linked is not None:
            return linked
    fragment_product = next(
        (
            node
            for node in nodes
            if node.get("@type") == "Product"
            and isinstance(node.get("@id"), str)
            and str(node["@id"]).endswith("#product")
        ),
        None,
    )
    return fragment_product or next((node for node in nodes if node.get("@type") == "Product"), None)


def resolve_product_group_node(graph: Sequence[object]) -> SchemaNode | None:
    """Resolve the primary Product's ProductGroup linkage before array fallback."""
    nodes = _nodes(graph)
    primary = resolve_primary_product_node(nodes)
    group_id = _reference_id(primary.get("isVariantOf") if primary else None)
    if group_id:
        linked = next(
            (node for node in nodes if node.get("@type") == "ProductGroup" and node.get("@id") == group_id), None
        )
        if linked is not None:
            return linked
    return next((node for node in nodes if node.get("@type") == "ProductGroup"), None)


def create_schema_markup(
    graph: Sequence[Mapping[str, object]],
    *,
    context: str = "https://schema.org",
) -> dict[str, object]:
    """Render a deterministic, script-safe JSON-LD fragment.

    The returned graph is a stable partition: WebPage nodes lead the graph and
    every remaining node retains its original relative order.  The compact
    boundary intentionally exposes only ``graph`` and ``script`` so the
    generation orchestrator can retain its own artifact envelope.
    """
    nodes = [dict(node) for node in graph]
    ordered = [node for node in nodes if schema_node_has_type(node, "WebPage")]
    ordered.extend(node for node in nodes if not schema_node_has_type(node, "WebPage"))
    payload = {"@context": context, "@graph": ordered}
    serialized = js_json_pretty_dumps(payload).replace("<", "\\u003c")
    return {"graph": ordered, "script": f'<script type="application/ld+json">{serialized}</script>'}


schemaNodeHasType = schema_node_has_type
resolvePrimaryProductNode = resolve_primary_product_node
resolveProductGroupNode = resolve_product_group_node
createSchemaMarkup = create_schema_markup
