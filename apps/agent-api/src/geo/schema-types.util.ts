import { createHash } from "node:crypto";

export function deriveSchemaTypes(jsonLd: Record<string, unknown> | null | undefined): string[] {
  if (!jsonLd || typeof jsonLd !== "object") return [];
  const nodes: unknown[] = Array.isArray((jsonLd as Record<string, unknown>)["@graph"])
    ? ((jsonLd as Record<string, unknown>)["@graph"] as unknown[])
    : [jsonLd];
  const types = new Set<string>();
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const t = (node as Record<string, unknown>)["@type"];
    if (typeof t === "string") types.add(t);
    else if (Array.isArray(t)) for (const v of t) if (typeof v === "string") types.add(v);
  }
  return [...types];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalize((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

export function computeResultHash(jsonLd: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(jsonLd))).digest("hex");
}
