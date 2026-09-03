import type {
  PdpAvailabilityToken,
  PdpItemConditionToken,
  PdpReturnFeesToken,
  PdpReturnMethodToken,
  PdpReturnPolicyCategoryToken
} from "./types";

/**
 * Shared schema.org commerce value normalization (GEO-128).
 *
 * Single implementation used by normalization (input contract) and JSON-LD
 * rendering so generated values always match the official schema.org
 * enumerations and GS1 rules:
 * - `ItemAvailability` members (schema.org V30.0): the only 12 valid values.
 * - `gtin`: all-numeric 8/12/13/14 digits with a valid GS1 check digit,
 *   left-padding neither required nor encouraged (https://schema.org/gtin).
 *
 * Trust policy: these normalizers are fail-closed. A value that cannot be
 * mapped to a canonical member is dropped (never guessed), because a wrong
 * availability or identifier is materially misleading on commerce surfaces.
 */

export const availabilityTokens: readonly PdpAvailabilityToken[] = [
  "BackOrder",
  "Discontinued",
  "InStock",
  "InStoreOnly",
  "LimitedAvailability",
  "MadeToOrder",
  "OnlineOnly",
  "OutOfStock",
  "PreOrder",
  "PreSale",
  "Reserved",
  "SoldOut"
];

const itemConditionTokens: readonly PdpItemConditionToken[] = [
  "NewCondition",
  "RefurbishedCondition",
  "UsedCondition",
  "DamagedCondition"
];

/** Returns the canonical `https://schema.org/<Token>` enumeration URL. */
export function schemaEnumUrl(
  token: PdpAvailabilityToken | PdpItemConditionToken | PdpReturnPolicyCategoryToken | PdpReturnMethodToken | PdpReturnFeesToken
): string {
  return `https://schema.org/${token}`;
}

/**
 * Normalizes arbitrary merchant availability signals to a canonical
 * schema.org `ItemAvailability` member. Accepts canonical tokens in any
 * casing/spacing, full schema.org URLs, boolean stock flags, and common
 * Korean/Japanese/English merchant phrases. Returns `undefined` for anything
 * it cannot map with confidence (fail-closed; never defaults to InStock).
 */
export function normalizeAvailabilityToken(value: unknown): PdpAvailabilityToken | undefined {
  if (typeof value === "boolean") {
    return value ? "InStock" : "OutOfStock";
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const raw = value.trim();
  if (!raw || raw.length > 80) {
    return undefined;
  }
  const compact = raw
    .replace(/^https?:\/\/(?:www\.)?schema\.org\//i, "")
    .replace(/[\s_-]+/g, "")
    .toLowerCase();
  const direct = availabilityTokens.find((token) => token.toLowerCase() === compact);
  if (direct) {
    return direct;
  }
  // Merchant phrase mapping. Negative/terminal states are matched before
  // positive ones so that phrases such as "일시 품절(재입고 예정)" or
  // "currently not available" never resolve to InStock.
  if (/재입고|입고\s*예정|back[\s-]?order(?:ed)?|入荷待ち|取り寄せ/i.test(raw)) {
    return "BackOrder";
  }
  if (/단종|판매\s*종료|생산\s*중단|discontinued|生産終了|販売終了/i.test(raw)) {
    return "Discontinued";
  }
  if (/품절|매진|sold\s*out|売り切れ|完売/i.test(raw)) {
    return "SoldOut";
  }
  if (/재고\s*없음|재고가\s*없|out\s*of\s*stock|not\s+available|unavailable|在庫なし|欠品/i.test(raw)) {
    return "OutOfStock";
  }
  if (/예약\s*판매|사전\s*예약|선주문|pre[\s-]?order|予約販売|予約受付/i.test(raw)) {
    return "PreOrder";
  }
  if (/사전\s*판매|얼리버드|pre[\s-]?sale|先行販売/i.test(raw)) {
    return "PreSale";
  }
  if (/주문\s*제작|맞춤\s*제작|made\s*to\s*order|受注生産/i.test(raw)) {
    return "MadeToOrder";
  }
  if (/온라인\s*전용|온라인\s*단독|online\s*only|オンライン限定/i.test(raw)) {
    return "OnlineOnly";
  }
  if (/매장\s*전용|오프라인\s*전용|매장\s*구매|in[\s-]?store\s*only|店舗限定/i.test(raw)) {
    return "InStoreOnly";
  }
  if (/한정\s*수량|수량\s*한정|소량\s*입고|limited\s*(?:availability|stock|quantity)|数量限定/i.test(raw)) {
    return "LimitedAvailability";
  }
  if (/판매\s*중|판매중|구매\s*가능|재고\s*있음|재고\s*보유|in\s*stock|available\s*now|在庫あり|販売中/i.test(raw)) {
    return "InStock";
  }
  return undefined;
}

/** Normalizes merchant condition signals to a schema.org `OfferItemCondition` member. */
export function normalizeItemConditionToken(value: unknown): PdpItemConditionToken | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const raw = value.trim();
  if (!raw || raw.length > 60) {
    return undefined;
  }
  const compact = raw
    .replace(/^https?:\/\/(?:www\.)?schema\.org\//i, "")
    .replace(/[\s_-]+/g, "")
    .toLowerCase();
  const direct = itemConditionTokens.find((token) => token.toLowerCase() === compact);
  if (direct) {
    return direct;
  }
  if (/^(?:new|신품|새\s*상품|새상품|新品)$/i.test(raw)) {
    return "NewCondition";
  }
  if (/refurbish|리퍼|再生品/i.test(raw)) {
    return "RefurbishedCondition";
  }
  if (/\bused\b|중고|中古/i.test(raw)) {
    return "UsedCondition";
  }
  return undefined;
}

/**
 * Validates and normalizes a GTIN per the official schema.org/gtin rules:
 * an all-numeric string of 8, 12, 13 or 14 digits with a valid GS1 check
 * digit. Separator characters (spaces/hyphens) are tolerated on input.
 * Returns `undefined` for any other shape — an invalid identifier is worse
 * than none because engines use GTIN as the cross-retailer product join key.
 */
export function sanitizeGtinValue(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const text = String(value).trim();
  if (!text || /[^\d\s-]/.test(text)) {
    return undefined;
  }
  const compact = text.replace(/[\s-]/g, "");
  if (!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(compact)) {
    return undefined;
  }
  return hasValidGs1CheckDigit(compact) ? compact : undefined;
}

/** Maps a validated GTIN to its length-specific schema.org sub-property name. */
export function gtinPropertyName(gtin: string): "gtin8" | "gtin12" | "gtin13" | "gtin14" | undefined {
  switch (gtin.length) {
    case 8:
      return "gtin8";
    case 12:
      return "gtin12";
    case 13:
      return "gtin13";
    case 14:
      return "gtin14";
    default:
      return undefined;
  }
}

function hasValidGs1CheckDigit(digits: string): boolean {
  const check = Number(digits[digits.length - 1]);
  const body = digits.slice(0, -1).split("").reverse();
  const sum = body.reduce((acc, char, index) => acc + Number(char) * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/**
 * Sanitizes an explicit merchant SKU for `Product.sku`/`Offer.sku`.
 * SKU is an opaque merchant identifier: whitespace is removed, generic
 * placeholder words are rejected, and length is bounded. Mirrors the
 * inference-side rules in generate.ts so explicit and inferred SKUs share
 * one acceptance contract.
 */
export function sanitizeSkuValue(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const sku = String(value).trim().replace(/\s+/g, "").replace(/[^\p{L}\p{N}._-]/gu, "");
  if (!sku || sku.length < 4 || sku.length > 64 || /^(?:product|item|model|code|번호|상품|제품)$/i.test(sku)) {
    return undefined;
  }
  return sku;
}

const returnPolicyCategoryTokens: readonly PdpReturnPolicyCategoryToken[] = [
  "MerchantReturnFiniteReturnWindow",
  "MerchantReturnUnlimitedWindow",
  "MerchantReturnNotPermitted"
];

const returnMethodTokens: readonly PdpReturnMethodToken[] = [
  "ReturnByMail",
  "ReturnInStore",
  "ReturnAtKiosk"
];

const returnFeesTokens: readonly PdpReturnFeesToken[] = [
  "FreeReturn",
  "ReturnFeesCustomerResponsibility",
  "RestockingFees"
];

function matchEnumToken<T extends string>(value: unknown, tokens: readonly T[]): T | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const raw = value.trim();
  if (!raw || raw.length > 80) {
    return undefined;
  }
  const compact = raw
    .replace(/^https?:\/\/(?:www\.)?schema\.org\//i, "")
    .replace(/[\s_-]+/g, "")
    .toLowerCase();
  return tokens.find((token) => token.toLowerCase() === compact);
}

/**
 * P0 커머스 신뢰 계층 정규화기(fail-closed). 반품 정책의 카테고리/방법/
 * 수수료는 schema.org 공식 enum 멤버(또는 그 URL 표기)만 수용하고, 매핑
 * 불가 값은 버린다 — 잘못된 반품 조건은 커머스 표면에서 실질적 오표기다.
 */
export function normalizeReturnPolicyCategoryToken(value: unknown): PdpReturnPolicyCategoryToken | undefined {
  return matchEnumToken(value, returnPolicyCategoryTokens);
}

export function normalizeReturnMethodToken(value: unknown): PdpReturnMethodToken | undefined {
  return matchEnumToken(value, returnMethodTokens);
}

export function normalizeReturnFeesToken(value: unknown): PdpReturnFeesToken | undefined {
  return matchEnumToken(value, returnFeesTokens);
}

/** ISO 3166-1 alpha-2 country code only (fail-closed, uppercased). */
export function sanitizeCountryCodeValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const code = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : undefined;
}

/** Non-negative integer day count (fail-closed). */
export function sanitizeDayCountValue(value: unknown): number | undefined {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  return Number.isInteger(num) && num >= 0 && num <= 365 ? num : undefined;
}

/**
 * 통화 인지 금액 정규화(공유). Shopify류 소스는 십진 통화 금액을 센트
 * 정수("21500" = $215.00)로 노출하는 경우가 있어, 소수점/통화기호가 없는
 * 1000 이상의 정수는 센트로 해석한다. KRW/JPY 등 zero-decimal 통화는
 * 그대로 둔다. normalize(진단)와 Offer 렌더링이 같은 값을 보도록
 * 단일 구현을 공유한다.
 */
export function normalizeMonetaryAmountForCurrency(raw: string, amount: number | undefined, currency: string | undefined): number | undefined {
  const parsed = amount ?? Number(raw.replace(/[^\d.-]+/g, ""));
  if (!Number.isFinite(parsed) || parsed <= 0 || !currency) {
    return undefined;
  }
  const hasDecimalOrCurrencySymbol = /[.,]\d{1,2}\b|[$£€¥₩]|(?:usd|gbp|eur|jpy|krw)\b/i.test(raw);
  const zeroDecimalCurrencies = new Set(["KRW", "JPY"]);
  const decimalCurrency = !zeroDecimalCurrencies.has(currency);
  const normalized = decimalCurrency && !hasDecimalOrCurrencySymbol && Number.isInteger(parsed) && parsed >= 1000
    ? parsed / 100
    : parsed;
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return undefined;
  }
  return decimalCurrency ? Number(normalized.toFixed(2)) : Math.round(normalized);
}
