import type { EvalNormalizedProduct } from "../types";

/**
 * Assembles the vanilla (pre-generation) PDP source text from a normalized
 * product signal. This is the counterfactual control document for the
 * citation probe: the same probe slot is alternately filled with this text
 * and the generated PDP text, so both variants compete against identical
 * distractors on identical queries.
 *
 * The layout intentionally mirrors a raw PDP dump (title, marketing copy,
 * spec-ish lists) rather than an optimized document.
 */
export function buildVanillaSourceText(product: EvalNormalizedProduct): string {
  const lines: string[] = [];
  lines.push([product.brand, product.name].filter(Boolean).join(" "));
  if (product.category) {
    lines.push(`Category: ${product.category}`);
  }
  if (product.sourceTexts && product.sourceTexts.length > 0) {
    lines.push(...product.sourceTexts);
  }
  if (product.benefits && product.benefits.length > 0) {
    lines.push(`Benefits: ${product.benefits.join(", ")}`);
  }
  if (product.effects && product.effects.length > 0) {
    lines.push(`Effects: ${product.effects.join(", ")}`);
  }
  if (product.ingredients && product.ingredients.length > 0) {
    lines.push(`Key ingredients: ${product.ingredients.join(", ")}`);
  }
  if (product.usage && product.usage.length > 0) {
    lines.push(`How to use: ${product.usage.join(" ")}`);
  }
  if (product.faq && product.faq.length > 0) {
    for (const item of product.faq) {
      lines.push(`Q: ${item.question} A: ${item.answer}`);
    }
  }
  if (product.reviews?.keywords && product.reviews.keywords.length > 0) {
    lines.push(`Review keywords: ${product.reviews.keywords.join(", ")}`);
  }
  return lines.filter((line) => line.trim().length > 0).join("\n");
}
