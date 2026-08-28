type SchemaNode = Record<string, unknown>;

/** True when the node's `@type` (string or array) includes the given type. */
export function schemaNodeHasType(node: Record<string, unknown> | undefined, type: string): boolean {
  if (!node) {
    return false;
  }
  const value = node["@type"];
  return value === type || (Array.isArray(value) && value.includes(type));
}

/** Resolves the page's current Product by graph linkage instead of array order. */
export function resolvePrimaryProductNode(graph: unknown[]): SchemaNode | undefined {
  const nodes = graph.filter(isRecord);
  const webPage = nodes.find((node) => schemaNodeHasType(node, "WebPage"));
  const mainEntityId = referenceId(webPage?.mainEntity);
  if (mainEntityId) {
    const linked = nodes.find((node) =>
      node["@type"] === "Product" && node["@id"] === mainEntityId
    );
    if (linked) {
      return linked;
    }
  }

  return nodes.find((node) =>
    node["@type"] === "Product"
    && typeof node["@id"] === "string"
    && node["@id"].endsWith("#product")
  ) ?? nodes.find((node) => node["@type"] === "Product");
}

export function resolveProductGroupNode(graph: unknown[]): SchemaNode | undefined {
  const nodes = graph.filter(isRecord);
  const primary = resolvePrimaryProductNode(nodes);
  const groupId = referenceId(primary?.isVariantOf);
  return (groupId
    ? nodes.find((node) => node["@type"] === "ProductGroup" && node["@id"] === groupId)
    : undefined)
    ?? nodes.find((node) => node["@type"] === "ProductGroup");
}

function referenceId(value: unknown): string | undefined {
  return isRecord(value) && typeof value["@id"] === "string"
    ? value["@id"]
    : undefined;
}

function isRecord(value: unknown): value is SchemaNode {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
