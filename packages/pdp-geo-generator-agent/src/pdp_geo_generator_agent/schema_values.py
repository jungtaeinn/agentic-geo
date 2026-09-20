"""Fail-closed schema.org commerce value normalization.

This module is a direct behavioral port of ``schema-values.ts``.  It is kept
independent from rendering so intake and JSON-LD construction share exactly the
same acceptance rules.
"""

from __future__ import annotations

import math
import re
from typing import Final

from neo_js_compat import js_round, js_to_fixed

availability_tokens: Final[tuple[str, ...]] = (
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
    "SoldOut",
)
_ITEM_CONDITION_TOKENS: Final[tuple[str, ...]] = (
    "NewCondition",
    "RefurbishedCondition",
    "UsedCondition",
    "DamagedCondition",
)
_RETURN_POLICY_CATEGORY_TOKENS: Final[tuple[str, ...]] = (
    "MerchantReturnFiniteReturnWindow",
    "MerchantReturnUnlimitedWindow",
    "MerchantReturnNotPermitted",
)
_RETURN_METHOD_TOKENS: Final[tuple[str, ...]] = (
    "ReturnByMail",
    "ReturnInStore",
    "ReturnAtKiosk",
)
_RETURN_FEES_TOKENS: Final[tuple[str, ...]] = (
    "FreeReturn",
    "ReturnFeesCustomerResponsibility",
    "RestockingFees",
)
_SCHEMA_PREFIX = re.compile(r"^https?://(?:www\.)?schema\.org/", re.IGNORECASE)


def schema_enum_url(token: str) -> str:
    """Return the canonical schema.org enumeration URL for ``token``."""
    return f"https://schema.org/{token}"


def _compact_schema_token(raw: str) -> str:
    return re.sub(r"[\s_-]+", "", _SCHEMA_PREFIX.sub("", raw)).lower()


def _direct_token(raw: str, tokens: tuple[str, ...]) -> str | None:
    compact = _compact_schema_token(raw)
    return next((token for token in tokens if token.lower() == compact), None)


def normalize_availability_token(value: object) -> str | None:
    """Map supported availability source signals to schema.org ItemAvailability."""
    if isinstance(value, bool):
        return "InStock" if value else "OutOfStock"
    if not isinstance(value, str):
        return None
    raw = value.strip()
    if not raw or len(raw) > 80:
        return None
    direct = _direct_token(raw, availability_tokens)
    if direct:
        return direct
    # Terminal/negative states must precede positive matches.  In particular,
    # "일시 품절(재입고 예정)" is BackOrder rather than InStock.
    mappings: tuple[tuple[str, str], ...] = (
        (r"재입고|입고\s*예정|back[\s-]?order(?:ed)?|入荷待ち|取り寄せ", "BackOrder"),
        (r"단종|판매\s*종료|생산\s*중단|discontinued|生産終了|販売終了", "Discontinued"),
        (r"품절|매진|sold\s*out|売り切れ|完売", "SoldOut"),
        (r"재고\s*없음|재고가\s*없|out\s*of\s*stock|not\s+available|unavailable|在庫なし|欠品", "OutOfStock"),
        (r"예약\s*판매|사전\s*예약|선주문|pre[\s-]?order|予約販売|予約受付", "PreOrder"),
        (r"사전\s*판매|얼리버드|pre[\s-]?sale|先行販売", "PreSale"),
        (r"주문\s*제작|맞춤\s*제작|made\s*to\s*order|受注生産", "MadeToOrder"),
        (r"온라인\s*전용|온라인\s*단독|online\s*only|オンライン限定", "OnlineOnly"),
        (r"매장\s*전용|오프라인\s*전용|매장\s*구매|in[\s-]?store\s*only|店舗限定", "InStoreOnly"),
        (
            r"한정\s*수량|수량\s*한정|소량\s*입고|limited\s*(?:availability|stock|quantity)|数量限定",
            "LimitedAvailability",
        ),
        (r"판매\s*중|판매중|구매\s*가능|재고\s*있음|재고\s*보유|in\s*stock|available\s*now|在庫あり|販売中", "InStock"),
    )
    return next((token for pattern, token in mappings if re.search(pattern, raw, re.IGNORECASE)), None)


def normalize_item_condition_token(value: object) -> str | None:
    """Map a merchant condition signal to an OfferItemCondition member."""
    if not isinstance(value, str):
        return None
    raw = value.strip()
    if not raw or len(raw) > 60:
        return None
    direct = _direct_token(raw, _ITEM_CONDITION_TOKENS)
    if direct:
        return direct
    if re.fullmatch(r"(?:new|신품|새\s*상품|새상품|新品)", raw, re.IGNORECASE):
        return "NewCondition"
    if re.search(r"refurbish|리퍼|再生品", raw, re.IGNORECASE):
        return "RefurbishedCondition"
    if re.search(r"\bused\b|중고|中古", raw, re.IGNORECASE):
        return "UsedCondition"
    return None


def _javascript_string(value: str | int | float) -> str:
    """Enough of ``String(value)`` for supported JSON scalar inputs."""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def sanitize_gtin_value(value: object) -> str | None:
    """Accept only valid 8/12/13/14-digit GS1 identifiers."""
    if isinstance(value, bool) or not isinstance(value, str | int | float):
        return None
    text = _javascript_string(value).strip()
    if not text or re.search(r"[^\d\s-]", text):
        return None
    compact = re.sub(r"[\s-]", "", text)
    if not re.fullmatch(r"(?:\d{8}|\d{12}|\d{13}|\d{14})", compact):
        return None
    return compact if _has_valid_gs1_check_digit(compact) else None


def _has_valid_gs1_check_digit(digits: str) -> bool:
    check = int(digits[-1])
    total = sum(int(char) * (3 if index % 2 == 0 else 1) for index, char in enumerate(reversed(digits[:-1])))
    return (10 - (total % 10)) % 10 == check


def gtin_property_name(gtin: str) -> str | None:
    """Return the length-specific schema.org GTIN property name."""
    return {8: "gtin8", 12: "gtin12", 13: "gtin13", 14: "gtin14"}.get(len(gtin))


def sanitize_sku_value(value: object) -> str | None:
    """Remove formatting from an opaque merchant SKU without guessing one."""
    if isinstance(value, bool) or not isinstance(value, str | int | float):
        return None
    raw = re.sub(r"\s+", "", _javascript_string(value).strip())
    sku = "".join(char for char in raw if char.isalnum() or char in "._-")
    if not sku or not 4 <= len(sku) <= 64:
        return None
    if re.fullmatch(r"(?:product|item|model|code|번호|상품|제품)", sku, re.IGNORECASE):
        return None
    return sku


def _match_enum_token(value: object, tokens: tuple[str, ...]) -> str | None:
    if not isinstance(value, str):
        return None
    raw = value.strip()
    if not raw or len(raw) > 80:
        return None
    return _direct_token(raw, tokens)


def normalize_return_policy_category_token(value: object) -> str | None:
    return _match_enum_token(value, _RETURN_POLICY_CATEGORY_TOKENS)


def normalize_return_method_token(value: object) -> str | None:
    return _match_enum_token(value, _RETURN_METHOD_TOKENS)


def normalize_return_fees_token(value: object) -> str | None:
    return _match_enum_token(value, _RETURN_FEES_TOKENS)


def sanitize_country_code_value(value: object) -> str | None:
    """Accept only an ISO 3166-1 alpha-2 country code."""
    if not isinstance(value, str):
        return None
    code = value.strip().upper()
    return code if re.fullmatch(r"[A-Z]{2}", code) else None


def _number_from_js_input(value: object) -> float:
    if isinstance(value, bool) or value is None:
        return math.nan
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return 0.0
        try:
            return float(text)
        except ValueError:
            return math.nan
    return math.nan


def sanitize_day_count_value(value: object) -> int | None:
    number = _number_from_js_input(value)
    if not math.isfinite(number) or not number.is_integer() or not 0 <= number <= 365:
        return None
    return int(number)


def normalize_monetary_amount_for_currency(
    raw: str, amount: float | int | None, currency: str | None
) -> float | int | None:
    """Normalize cent-style decimal amounts while preserving zero-decimal currencies."""
    parsed = (
        float(amount)
        if amount is not None and not isinstance(amount, bool)
        else _number_from_js_input(re.sub(r"[^\d.-]+", "", raw))
    )
    if not math.isfinite(parsed) or parsed <= 0 or not currency:
        return None
    has_decimal_or_symbol = bool(re.search(r"[.,]\d{1,2}\b|[$£€¥₩]|(?:usd|gbp|eur|jpy|krw)\b", raw, re.IGNORECASE))
    decimal_currency = currency not in {"KRW", "JPY"}
    normalized = (
        parsed / 100
        if decimal_currency and not has_decimal_or_symbol and parsed.is_integer() and parsed >= 1000
        else parsed
    )
    if not math.isfinite(normalized) or normalized <= 0:
        return None
    if not decimal_currency:
        return int(js_round(normalized))
    result = float(js_to_fixed(normalized, 2))
    # JavaScript's `Number` has no distinct float wire representation:
    # JSON.stringify(Number(215)) is `215`, not `215.0`.  Preserve that
    # public JSON-LD token shape while retaining decimal prices when needed.
    return int(result) if result.is_integer() else result


# Camel-case aliases keep mechanically ported callers source-compatible.
schemaEnumUrl = schema_enum_url
normalizeAvailabilityToken = normalize_availability_token
normalizeItemConditionToken = normalize_item_condition_token
sanitizeGtinValue = sanitize_gtin_value
gtinPropertyName = gtin_property_name
sanitizeSkuValue = sanitize_sku_value
normalizeReturnPolicyCategoryToken = normalize_return_policy_category_token
normalizeReturnMethodToken = normalize_return_method_token
normalizeReturnFeesToken = normalize_return_fees_token
sanitizeCountryCodeValue = sanitize_country_code_value
sanitizeDayCountValue = sanitize_day_count_value
normalizeMonetaryAmountForCurrency = normalize_monetary_amount_for_currency
