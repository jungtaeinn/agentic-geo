import type { JsonObject, PdpGeoContentArtifact, PdpGeoSchemaMarkup } from "./types";

interface ValidateAndRepairInput {
  schemaMarkup: PdpGeoSchemaMarkup;
  content: PdpGeoContentArtifact;
  fallbackProductName: string;
  fallbackDescription: string;
}

interface ValidateAndRepairOutput {
  schemaMarkup: PdpGeoSchemaMarkup;
  content: PdpGeoContentArtifact;
  validationWarnings: string[];
}

const allowedGraphTypes = new Set(["WebPage", "Product", "FAQPage", "HowTo", "BreadcrumbList", "Question", "Answer", "HowToStep", "Offer", "AggregateRating", "Review", "Rating", "PropertyValue", "ItemList", "ListItem", "Brand", "Person"]);

/** Validates and repairs generated JSON-LD and simple accordion HTML. */
export function validateAndRepairPdpGeoArtifacts(input: ValidateAndRepairInput): ValidateAndRepairOutput {
  const validationWarnings: string[] = [];
  const jsonLd = repairJsonLd(input.schemaMarkup.jsonLd, input.fallbackProductName, input.fallbackDescription, validationWarnings);
  const schemaMarkup = {
    jsonLd,
    scriptTag: `<script type="application/ld+json">${escapeScriptJson(JSON.stringify(jsonLd, null, 2))}</script>`
  };
  const content = {
    ...input.content,
    html: sanitizeAccordionHtml(input.content.html, validationWarnings)
  };

  return {
    schemaMarkup,
    content,
    validationWarnings
  };
}

function repairJsonLd(value: JsonObject, fallbackProductName: string, fallbackDescription: string, warnings: string[]): JsonObject {
  const root = isRecord(value) ? { ...value } : {};
  if (root["@context"] !== "https://schema.org") {
    root["@context"] = "https://schema.org";
    warnings.push("JSON-LD @context was repaired to https://schema.org.");
  }

  const rawGraph: unknown[] = Array.isArray(root["@graph"]) ? root["@graph"] : [];
  const graph = rawGraph.filter(isRecord).map((node) => repairGraphNode(node, warnings));
  if (graph.length === 0) {
    graph.push({
      "@type": "Product",
      "@id": `urn:agentic-geo:pdp:${slug(fallbackProductName)}#product`,
      name: fallbackProductName,
      description: fallbackDescription
    });
    warnings.push("JSON-LD @graph was missing and a minimal Product node was added.");
  }

  const product = graph.find((node) => node["@type"] === "Product");
  if (!product) {
    graph.push({
      "@type": "Product",
      "@id": `urn:agentic-geo:pdp:${slug(fallbackProductName)}#product`,
      name: fallbackProductName,
      description: fallbackDescription
    });
    warnings.push("JSON-LD Product node was missing and was added.");
  } else {
    if (typeof product.name !== "string" || product.name.trim().length === 0) {
      product.name = fallbackProductName;
      warnings.push("Product.name was missing and was repaired.");
    }
    if (typeof product.description !== "string" || product.description.trim().length === 0) {
      product.description = fallbackDescription;
      warnings.push("Product.description was missing and was repaired.");
    }
  }

  return cleanJson({
    ...root,
    "@graph": graph
  }) as JsonObject;
}

function repairGraphNode(node: Record<string, unknown>, warnings: string[]): Record<string, unknown> {
  const type = node["@type"];
  if (typeof type === "string" && !allowedGraphTypes.has(type)) {
    warnings.push(`Unsupported schema.org node type "${type}" was kept for compatibility but flagged.`);
  }

  if (node["@type"] === "FAQPage" && Array.isArray(node.mainEntity)) {
    node.mainEntity = node.mainEntity.filter(isRecord).flatMap((item) => {
      const name = stringValue(item.name);
      const acceptedAnswer = isRecord(item.acceptedAnswer) ? item.acceptedAnswer : undefined;
      const answer = stringValue(acceptedAnswer?.text);
      if (!name || !answer) {
        warnings.push("Invalid FAQ question without answer was removed.");
        return [];
      }
      return [{
        "@type": "Question",
        name,
        acceptedAnswer: {
          "@type": "Answer",
          text: answer
        }
      }];
    });
  }

  if (node["@type"] === "HowTo" && Array.isArray(node.step)) {
    node.step = node.step.filter(isRecord).flatMap((item, index) => {
      const text = stringValue(item.text);
      if (!text) {
        warnings.push("Invalid HowTo step without text was removed.");
        return [];
      }
      return [{
        "@type": "HowToStep",
        position: numberValue(item.position) ?? index + 1,
        text
      }];
    });
  }

  return cleanJson(node);
}

function sanitizeAccordionHtml(html: string, warnings: string[]): string {
  let next = html;
  const before = next;
  next = next.replace(/<script[\s\S]*?<\/script>/gi, "");
  next = next.replace(/\son[a-z]+\s*=\s*["'][^"']*["']/gi, "");
  next = next.replace(/\sstyle\s*=\s*["'][^"']*["']/gi, "");
  next = next.replace(/<(\/?)(?!div\b|button\b|ul\b|li\b|p\b|br\b)([a-z][a-z0-9-]*)([^>]*)>/gi, "");

  if (next !== before) {
    warnings.push("Generated HTML contained unsafe or unsupported tags/attributes and was sanitized.");
  }
  if (!/class="geo-content-accordion"/.test(next)) {
    warnings.push("Generated HTML did not include the expected accordion wrapper.");
  }

  return next;
}

function cleanJson<T>(value: T): T {
  if (Array.isArray(value)) {
    return value
      .map((item) => cleanJson(item))
      .filter((item) => item !== undefined && item !== null && !(Array.isArray(item) && item.length === 0)) as T;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, cleanJson(item)] as const)
      .filter(([, item]) => item !== undefined && item !== null && item !== "" && !(Array.isArray(item) && item.length === 0));
    return Object.fromEntries(entries) as T;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function escapeScriptJson(value: string): string {
  return value.replace(/</g, "\\u003c");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9가-힣ぁ-んァ-ン一-龯]+/gi, "-").replace(/^-+|-+$/g, "") || "product";
}
