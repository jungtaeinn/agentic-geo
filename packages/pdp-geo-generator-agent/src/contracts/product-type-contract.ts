/**
 * Single source of truth for "what kind of product is this" — the canonical
 * product type read from a product name, and its market wording per locale.
 *
 * Why this module exists: the pipeline derived the product type from the name
 * to publish `Product.category`, but the normalized product kept whatever the
 * source (or a model pass) happened to supply, which for many pages is
 * nothing. The run then published a category it held no evidence atom for, so
 * a description sentence naming that category could not be supported and was
 * dropped. Normalization and rendering must read the product type from the
 * same contract.
 *
 * Semantics over keyword lists: the patterns capture the product FORM a name
 * states (mist, cream, serum, cleanser, ...). They are the deterministic floor
 * for a source that names its own form; an explicit source category always
 * wins over this inference.
 */
import type { PdpGeoLocale } from "../types";

function cleanProductTypeText(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\s+([,.])/g, "$1").trim();
}

export function productTypeFromName(value: string): string | undefined {
  const name = cleanProductTypeText(value);
  if (/크림\s*미스트|크림미스트|クリーム\s*ミスト/i.test(name)) {
    return "Cream Mist";
  }
  if (/미스트|ミスト/i.test(name)) {
    return "Mist";
  }
  if (/cream\s*mist/i.test(name)) {
    return "Cream Mist";
  }
  if (/\bmist\b/i.test(name)) {
    return "Mist";
  }
  if (/클렌징|클렌저|세안|폼/.test(name)) {
    return "Cleanser";
  }
  if (/세럼|앰플|에센스/.test(name)) {
    return "Serum";
  }
  if (/크림|크리미/.test(name)) {
    return "Cream";
  }
  if (/cleansing\s+foam|foam\s+cleanser|cleanser|cleaning\s+foam/i.test(name)) {
    return "Cleanser";
  }
  if (/serum|ampoule|essence/i.test(name)) {
    return "Serum";
  }
  if (/cream|moisturi[sz]er/i.test(name)) {
    return "Cream";
  }
  if (/body\s*lotion|lotion|바디\s*로션|바디로션|로션/i.test(name)) {
    return /body\s*lotion|바디\s*로션|바디로션/i.test(name) ? "Body Lotion" : "Lotion";
  }
  if (/toner|skin water/i.test(name)) {
    return "Toner";
  }
  if (/mask/i.test(name)) {
    return "Mask";
  }
  return undefined;
}

export function localizeProductTypeForLocale(productType: string, locale: PdpGeoLocale): string {
  const normalized = cleanProductTypeText(productType);
  const lower = normalized.toLowerCase();
  const productTypeMap: Record<PdpGeoLocale, Array<[RegExp, string]>> = {
    "ko-KR": [
      [/body\s*lotion|바디\s*로션|바디로션/i, "바디로션"],
      [/cream\s*mist|크림\s*미스트|크림미스트/i, "크림 미스트"],
      [/\bmist\b|미스트/i, "미스트"],
      [/lotion|로션/i, "로션"],
      [/cream|크림/i, "크림"],
      [/serum|세럼|앰플|에센스/i, "세럼"],
      [/toner|토너|스킨/i, "토너"],
      [/cleanser|클렌저|폼/i, "클렌저"],
      [/mask|마스크/i, "마스크"]
    ],
    "ja-JP": [
      [/body\s*lotion|ボディローション/i, "ボディローション"],
      [/cream\s*mist|クリーム\s*ミスト/i, "クリームミスト"],
      [/mist|ミスト/i, "ミスト"],
      [/lotion|ローション/i, "ローション"],
      [/cream|クリーム/i, "クリーム"],
      [/serum|美容液|セラム/i, "美容液"],
      [/toner|化粧水/i, "化粧水"],
      [/cleanser|洗顔|クレンザー/i, "クレンザー"],
      [/mask|マスク/i, "マスク"]
    ],
    "en-US": [
      [/body\s*lotion|바디\s*로션|バディローション|ボディローション/i, "Body Lotion"],
      [/cream\s*mist|크림\s*미스트|크림미스트|クリーム\s*ミスト/i, "Cream Mist"],
      [/\bmist\b|미스트|ミスト/i, "Mist"],
      [/lotion|로션|ローション/i, "Lotion"],
      [/cream|크림|クリーム/i, "Cream"],
      [/serum|세럼|앰플|에센스|美容液|セラム/i, "Serum"],
      [/toner|토너|스킨|化粧水/i, "Toner"],
      [/cleanser|클렌저|폼|洗顔|クレンザー/i, "Cleanser"],
      [/mask|마스크/i, "Mask"]
    ],
    "en-GB": [
      [/body\s*lotion|바디\s*로션|バディローション|ボディローション/i, "Body Lotion"],
      [/cream\s*mist|크림\s*미스트|크림미스트|クリーム\s*ミスト/i, "Cream Mist"],
      [/\bmist\b|미스트|ミスト/i, "Mist"],
      [/lotion|로션|ローション/i, "Lotion"],
      [/cream|크림|クリーム/i, "Cream"],
      [/serum|세럼|앰플|에센스|美容液|セラム/i, "Serum"],
      [/toner|토너|스킨|化粧水/i, "Toner"],
      [/cleanser|클렌저|폼|洗顔|クレンザー/i, "Cleanser"],
      [/mask|마스크/i, "Mask"]
    ]
  };

  for (const [pattern, localized] of productTypeMap[locale]) {
    if (pattern.test(lower)) {
      return localized;
    }
  }

  return normalized;
}
