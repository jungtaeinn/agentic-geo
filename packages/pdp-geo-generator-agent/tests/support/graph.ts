/**
 * Shared readers for the generated JSON-LD graph.
 *
 * Four files declared their own `graphOf` and two more declared `graphNodes`,
 * each with a different parameter type — a run, a run's `result`, a validator
 * output, a bare `{ schemaMarkup }` — for the same one-line read. A change to
 * the graph's shape had to be found in six places. These accept every carrier
 * the callers already pass.
 */

/** A node as tests read it: they index freely (`node["@type"]`, `node.description`). */
export type GraphNode = Record<string, any>;

interface SchemaCarrier {
  schemaMarkup: { jsonLd: Record<string, unknown> };
}

/** A run, or the result inside it, or anything else carrying the markup. */
export type GraphSource = SchemaCarrier | { result: SchemaCarrier };

/** Narrows a graph entry, a `mainEntity` item, or a nested node to an object. */
export function isGraphNode(value: unknown): value is GraphNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The graph's object nodes. Non-object entries are dropped rather than cast
 * through, which is what two of the six original readers already did.
 */
export function graphOf(source: GraphSource): GraphNode[] {
  const carrier = "result" in source ? source.result : source;
  const graph = carrier.schemaMarkup.jsonLd["@graph"];
  return Array.isArray(graph) ? graph.filter(isGraphNode) : [];
}

/** The first node carrying `type`, whether `@type` is a string or an array. */
export function nodeOf(source: GraphSource | GraphNode[], type: string): GraphNode | undefined {
  const nodes = Array.isArray(source) ? source : graphOf(source);
  return nodes.find((node) => (Array.isArray(node["@type"]) ? node["@type"].includes(type) : node["@type"] === type));
}
