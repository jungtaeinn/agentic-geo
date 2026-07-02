import type {
  GeoCitationNormalizedProduct,
  GeoCitationSourceInfo
} from "../types";

export function normalizeGeoCitationProduct(rawProduct: unknown, source?: GeoCitationSourceInfo): GeoCitationNormalizedProduct {
  const root = asRecord(rawProduct) ?? {};
  const product = asRecord(root.geoProduct) ?? asRecord(root.product) ?? root;
  const reviews = asRecord(product.reviews) ?? asRecord(root.reviews) ?? {};
  const name = firstString([
    product.name,
    product.productName,
    product.title,
    product.displayName,
    root.name,
    root.productName,
    root.title
  ]) ?? "Untitled product";
  const description = firstString([
    product.description,
    product.shortDescription,
    product.summary,
    product.body,
    root.description
  ]);
  const benefits = collectStrings(product.benefits, product.benefit, product.good, product.effects, root.benefits);
  const effects = collectStrings(product.effects, product.effect, root.effects);
  const ingredients = collectStrings(product.ingredients, product.ingredient, product.activeIngredients, root.ingredients);
  const usage = collectStrings(product.usage, product.howToUse, product.directions, product.use, root.usage);
  const images = collectStrings(product.images, product.image, root.images);
  const reviewKeywords = collectStrings(reviews.keywords, reviews.keyword, product.reviewKeywords, root.reviewKeywords);
  const sourceTexts = collectStrings(
    product.sourceTexts,
    description,
    benefits,
    effects,
    ingredients,
    usage,
    reviewKeywords
  );

  return {
    name,
    description,
    brand: firstString([product.brand, product.maker, root.brand]),
    category: firstString([product.category, product.taxonomy, product.type, root.category]),
    benefits: unique(benefits),
    effects: unique(effects),
    ingredients: unique(ingredients),
    usage: unique(usage),
    images: unique(images),
    reviewKeywords: unique(reviewKeywords),
    sourceTexts: unique(sourceTexts),
    observedAt: source?.observedAt
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function firstString(values: unknown[]): string | undefined {
  return values
    .flatMap((value) => collectStrings(value))
    .map((value) => value.trim())
    .find((value) => value.length > 0);
}

function collectStrings(...values: unknown[]): string[] {
  return values.flatMap((value) => {
    if (typeof value === "string") {
      return value.trim().length > 0 ? [value.trim()] : [];
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return [String(value)];
    }

    if (Array.isArray(value)) {
      return value.flatMap((item) => collectStrings(item));
    }

    const record = asRecord(value);
    if (record) {
      return firstString([
        record.name,
        record.title,
        record.label,
        record.text,
        record.body,
        record.url,
        record.src
      ]) ? [firstString([
        record.name,
        record.title,
        record.label,
        record.text,
        record.body,
        record.url,
        record.src
      ]) as string] : [];
    }

    return [];
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
