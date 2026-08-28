import type { GeoProductRawData, ProductExtractionResult } from "./types";

export interface GeoProductRefinementInput {
  result: ProductExtractionResult;
  instruction: string;
}

export interface GeoProductRefinementOutput {
  result: ProductExtractionResult;
  changes: string[];
  summary: string;
}

/** Applies a focused instruction to the public GEO RAW JSON artifact. */
export function refineGeoProductResult(input: GeoProductRefinementInput): GeoProductRefinementOutput {
  const geoProduct = cloneJson(input.result.geoProduct);
  const changes: string[] = [];
  const instruction = input.instruction.trim();
  const patch = readInlineJsonPatch(instruction);

  if (patch) {
    mergeGeoProductPatch(geoProduct, isRecord(patch.geoProduct) ? patch.geoProduct : patch, changes);
  }

  applyNaturalLanguagePatch(geoProduct, instruction, changes);

  const result: ProductExtractionResult = {
    ...input.result,
    geoProduct
  };

  return {
    result,
    changes,
    summary: changes.length > 0
      ? `${changes.length}개 GEO RAW JSON 필드를 수정했습니다: ${changes.join(", ")}.`
      : "요청을 해석했지만 변경할 상품 RAW JSON 필드를 찾지 못했습니다. 필드명과 값을 더 구체적으로 입력해주세요."
  };
}

function applyNaturalLanguagePatch(geoProduct: GeoProductRawData, instruction: string, changes: string[]) {
  if (matchesAny(instruction, [/상품명|product\s*name|name/i])) {
    const name = firstQuotedValue(instruction) ?? valueAfterColon(instruction);
    if (name) {
      geoProduct.name = name;
      pushChange(changes, "name");
    }
  }

  if (matchesAny(instruction, [/설명|description/i])) {
    const description = firstQuotedValue(instruction) ?? valueAfterColon(instruction);
    if (description) {
      geoProduct.description = description;
      pushChange(changes, "description");
    }
  }

  if (matchesAny(instruction, [/가격|price/i])) {
    const raw = instruction.match(/(?:\$|₩)\s*[\d,.]+|[\d,]+(?:\.\d+)?\s*(?:원|usd|krw|달러)?/i)?.[0];
    if (raw) {
      geoProduct.price = {
        raw,
        amount: priceAmount(raw),
        currency: geoProduct.price?.currency
      };
      pushChange(changes, "price");
    }
  }

  const metrics = extractMetricPhrases(instruction);
  if (metrics.length > 0) {
    geoProduct.metrics = mergeStrings(geoProduct.metrics, metrics);
    geoProduct.ocr.keywords.metric = mergeStrings(geoProduct.ocr.keywords.metric, metrics);
    pushChange(changes, "metrics");
  }

  const ingredients = valuesForField(instruction, /성분|ingredient/i, ingredientPattern);
  if (ingredients.length > 0) {
    geoProduct.ingredients = mergeStrings(geoProduct.ingredients, ingredients);
    geoProduct.ocr.keywords.ingredient = mergeStrings(geoProduct.ocr.keywords.ingredient, ingredients);
    pushChange(changes, "ingredients");
  }

  const benefits = valuesForField(instruction, /효능|benefit|장점|고객 가치/i, benefitPattern);
  if (benefits.length > 0) {
    geoProduct.benefits = mergeStrings(geoProduct.benefits, benefits);
    geoProduct.ocr.keywords.benefit = mergeStrings(geoProduct.ocr.keywords.benefit, benefits);
    pushChange(changes, "benefits");
  }

  const effects = valuesForField(instruction, /효과|effect|개선|결과/i, effectPattern);
  if (effects.length > 0) {
    geoProduct.effects = mergeStrings(geoProduct.effects, effects);
    geoProduct.ocr.keywords.effect = mergeStrings(geoProduct.ocr.keywords.effect, effects);
    pushChange(changes, "effects");
  }

  const usage = valuesForField(instruction, /사용|usage|how to use|루틴/i, usagePattern);
  if (usage.length > 0) {
    geoProduct.usage = mergeStrings(geoProduct.usage, usage);
    geoProduct.ocr.keywords.usage = mergeStrings(geoProduct.ocr.keywords.usage, usage);
    pushChange(changes, "usage");
  }

  const reviewKeywords = valuesForField(instruction, /리뷰|review|고객|평점/i, reviewPattern);
  if (reviewKeywords.length > 0) {
    geoProduct.reviews.keywords = mergeStrings(geoProduct.reviews.keywords, reviewKeywords);
    geoProduct.ocr.keywords.review = mergeStrings(geoProduct.ocr.keywords.review, reviewKeywords);
    pushChange(changes, "reviews.keywords");
  }

  if (matchesAny(instruction, [/ocr|텍스트\s*블록|원문|근거/i])) {
    const textBlocks = quotedValues(instruction).filter((value) => value.length >= 4);
    if (textBlocks.length > 0) {
      geoProduct.ocr.textBlocks = mergeStrings(geoProduct.ocr.textBlocks, textBlocks);
      pushChange(changes, "ocr.textBlocks");
    }
  }
}

function mergeGeoProductPatch(geoProduct: GeoProductRawData, patch: Record<string, unknown>, changes: string[]) {
  if (typeof patch.name === "string") {
    geoProduct.name = patch.name;
    pushChange(changes, "name");
  }

  if (typeof patch.description === "string") {
    geoProduct.description = patch.description;
    pushChange(changes, "description");
  }

  if (typeof patch.price === "string") {
    geoProduct.price = {
      raw: patch.price,
      amount: priceAmount(patch.price),
      currency: geoProduct.price?.currency
    };
    pushChange(changes, "price");
  } else if (isRecord(patch.price)) {
    const raw = stringValue(patch.price.raw) ?? geoProduct.price?.raw;
    if (raw) {
      geoProduct.price = {
        raw,
        amount: numberValue(patch.price.amount) ?? priceAmount(raw),
        currency: stringValue(patch.price.currency) ?? geoProduct.price?.currency
      };
      pushChange(changes, "price");
    }
  }

  mergeArrayField(geoProduct, patch, "images", changes);
  mergeArrayField(geoProduct, patch, "options", changes);
  mergeArrayField(geoProduct, patch, "benefits", changes);
  mergeArrayField(geoProduct, patch, "effects", changes);
  mergeArrayField(geoProduct, patch, "ingredients", changes);
  mergeArrayField(geoProduct, patch, "usage", changes);
  mergeArrayField(geoProduct, patch, "metrics", changes);

  if (Array.isArray(patch.faq)) {
    geoProduct.faq = [
      ...geoProduct.faq,
      ...patch.faq.filter(isRecord).flatMap((item) => {
        const question = stringValue(item.question);
        const answer = stringValue(item.answer);
        return question && answer ? [{ question, answer }] : [];
      })
    ];
    pushChange(changes, "faq");
  }

  if (isRecord(patch.reviews)) {
    geoProduct.reviews = {
      ...geoProduct.reviews,
      rating: numberValue(patch.reviews.rating) ?? geoProduct.reviews.rating,
      reviewCount: numberValue(patch.reviews.reviewCount) ?? geoProduct.reviews.reviewCount,
      items: Array.isArray(patch.reviews.items) ? mergeReviewItems(geoProduct.reviews.items, patch.reviews.items) : geoProduct.reviews.items,
      keywords: mergeStrings(geoProduct.reviews.keywords, arrayValues(patch.reviews.keywords))
    };
    pushChange(changes, "reviews");
  }

  if (isRecord(patch.ocr)) {
    geoProduct.ocr.textBlocks = mergeStrings(geoProduct.ocr.textBlocks, arrayValues(patch.ocr.textBlocks));
    if (isRecord(patch.ocr.keywords)) {
      for (const category of Object.keys(geoProduct.ocr.keywords) as Array<keyof GeoProductRawData["ocr"]["keywords"]>) {
        geoProduct.ocr.keywords[category] = mergeStrings(geoProduct.ocr.keywords[category], arrayValues(patch.ocr.keywords[category]));
      }
    }
    pushChange(changes, "ocr");
  }

  if (isRecord(patch.rag) && Array.isArray(patch.rag.chunks)) {
    geoProduct.rag.chunks = [
      ...geoProduct.rag.chunks,
      ...patch.rag.chunks.filter(isRecord).flatMap((chunk, index) => {
        const text = stringValue(chunk.text);
        return text ? [{ id: stringValue(chunk.id) ?? `manual-rag-${Date.now()}-${index}`, kind: ragChunkKind(chunk.kind), text }] : [];
      })
    ];
    pushChange(changes, "rag.chunks");
  }
}

function ragChunkKind(value: unknown): GeoProductRawData["rag"]["chunks"][number]["kind"] {
  const kind = stringValue(value);
  return kind === "review" || kind === "faq" || kind === "ocr" || kind === "source" ? kind : "product";
}

function mergeArrayField<Key extends "images" | "options" | "benefits" | "effects" | "ingredients" | "usage" | "metrics">(
  geoProduct: GeoProductRawData,
  patch: Record<string, unknown>,
  key: Key,
  changes: string[]
) {
  const values = arrayValues(patch[key]);
  if (values.length === 0) {
    return;
  }

  geoProduct[key] = mergeStrings(geoProduct[key], values);
  pushChange(changes, key);
}

function readInlineJsonPatch(instruction: string): Record<string, unknown> | undefined {
  const jsonText = instruction.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonText) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(jsonText) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function valuesForField(instruction: string, fieldPattern: RegExp, knownPattern: RegExp): string[] {
  if (!fieldPattern.test(instruction)) {
    return [];
  }

  return mergeStrings([
    ...quotedValues(instruction),
    ...Array.from(instruction.matchAll(knownPattern)).map((match) => match[0]),
    ...valuesAfterFieldWord(instruction, fieldPattern)
  ], []);
}

function valuesAfterFieldWord(instruction: string, fieldPattern: RegExp): string[] {
  const match = instruction.match(fieldPattern);
  if (!match || match.index === undefined) {
    return [];
  }

  return instruction
    .slice(match.index + match[0].length)
    .replace(/(에|을|를|으로|로|추가|수정|반영|넣어|넣어줘|해주세요|해줘|json|객체|데이터|필드|정보|해주세요)/g, " ")
    .split(/[,/\n]/)
    .map((value) => cleanValue(value))
    .filter((value) => value.length >= 2 && value.length <= 40);
}

function quotedValues(text: string): string[] {
  return Array.from(text.matchAll(/["'“”‘’`]([^"'“”‘’`]+)["'“”‘’`]/g)).map((match) => cleanValue(match[1])).filter(Boolean);
}

function firstQuotedValue(text: string): string | undefined {
  return quotedValues(text)[0];
}

function valueAfterColon(text: string): string | undefined {
  const value = text.match(/[:：]\s*(.+)$/)?.[1];
  return value ? cleanValue(value) : undefined;
}

function extractMetricPhrases(text: string): string[] {
  return mergeStrings([
    ...(text.match(/\b\d+(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?\s?(?:ml|mL|oz|fl\.?\s?oz|weeks?|days?|hours?|stars?)\b/gi) ?? []),
    ...(text.match(/\b(?:after|in)\s+\d+(?:\.\d+)?\s?(?:weeks?|days?|hours?)\b/gi) ?? []),
    ...(text.match(/\b\d+(?:\.\d+)?\s?(?:점|개|명|회|주|일|시간|퍼센트)\b/g) ?? [])
  ], []);
}

function mergeReviewItems(current: GeoProductRawData["reviews"]["items"], values: unknown[]): GeoProductRawData["reviews"]["items"] {
  return [
    ...current,
    ...values.filter(isRecord).flatMap((item) => {
      const body = stringValue(item.body);
      return body
        ? [{
            body,
            author: stringValue(item.author),
            rating: numberValue(item.rating),
            datePublished: stringValue(item.datePublished)
          }]
        : [];
    })
  ];
}

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function pushChange(changes: string[], field: string) {
  if (!changes.includes(field)) {
    changes.push(field);
  }
}

function mergeStrings(current: string[], incoming: string[]): string[] {
  return Array.from(new Set([...current, ...incoming.map(cleanValue).filter(Boolean)]));
}

function cleanValue(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").replace(/[.。]$/, "");
}

function priceAmount(value: string): number | undefined {
  const normalized = value.replace(/[^\d.]/g, "");
  return normalized.length > 0 ? numberValue(normalized) : undefined;
}

function arrayValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(arrayValues);
  }
  const text = stringValue(value);
  return text ? [text] : [];
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }

  const text = cleanValue(String(value));
  return text.length > 0 ? text : undefined;
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const ingredientPattern = /(ginseng|panax|niacinamide|retinol|peptide|hyaluronic|ceramide|vitamin|collagen|ingredient|성분|인삼|펩타이드|레티놀|나이아신아마이드|히알루론산|세라마이드|콜라겐|비타민|병풀|시카)/gi;
const benefitPattern = /(hydration|moisture|moisturizing|soothing|brightening|firming|anti-aging|radiance|elasticity|resilience|barrier|보습|수분|진정|미백|탄력|광채|장벽|영양)/gi;
const effectPattern = /(effect|improve|improvement|reduce|diminish|care|wrinkle|wrinkles|fine lines|firmness|texture|lift|효과|개선|완화|케어|주름|잔주름|피부결|리프팅)/gi;
const usagePattern = /(use|apply|morning|night|ritual|pump|face|neck|daily use|사용|도포|아침|저녁|루틴|펌프|얼굴|목|매일)/gi;
const reviewPattern = /(review|rating|customer|stars|repurchase|satisfied|smooth|absorption|리뷰|평점|고객|만족|재구매|흡수|촉촉|산뜻)/gi;
