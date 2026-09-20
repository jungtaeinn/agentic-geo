"""Canonical product-form inference and locale wording."""

from __future__ import annotations

import re
from typing import Literal

PdpGeoLocale = Literal["ko-KR", "ja-JP", "en-US", "en-GB"]


def _clean_product_type_text(value: str) -> str:
    return re.sub(r"\s+([,.])", r"\1", re.sub(r"\s+", " ", value)).strip()


def product_type_from_name(value: str) -> str | None:
    """Infer the canonical product form explicitly named by a source title."""
    name = _clean_product_type_text(value)
    if re.search(r"크림\s*미스트|크림미스트|クリーム\s*ミスト", name, re.IGNORECASE):
        return "Cream Mist"
    if re.search(r"아이[\s-]*크림|アイ[\s-]*クリーム", name, re.IGNORECASE):
        return "Eye Cream"
    if re.search(r"미스트|ミスト", name, re.IGNORECASE):
        return "Mist"
    if re.search(r"cream\s*mist", name, re.IGNORECASE):
        return "Cream Mist"
    if re.search(r"\beye[-\s]*cream\b", name, re.IGNORECASE):
        return "Eye Cream"
    if re.search(r"\bmist\b", name, re.IGNORECASE):
        return "Mist"
    if re.search(r"클렌징|클렌저|세안|폼", name):
        return "Cleanser"
    if re.search(r"세럼|앰플|에센스", name):
        return "Serum"
    if re.search(r"크림|크리미", name):
        return "Cream"
    if re.search(r"cleansing\s+foam|foam\s+cleanser|cleanser|cleaning\s+foam", name, re.IGNORECASE):
        return "Cleanser"
    if re.search(r"serum|ampoule|essence", name, re.IGNORECASE):
        return "Serum"
    if re.search(r"cream|moisturi[sz]er", name, re.IGNORECASE):
        return "Cream"
    if re.search(r"body\s*lotion|lotion|바디\s*로션|바디로션|로션", name, re.IGNORECASE):
        return "Body Lotion" if re.search(r"body\s*lotion|바디\s*로션|바디로션", name, re.IGNORECASE) else "Lotion"
    if re.search(r"toner|skin water", name, re.IGNORECASE):
        return "Toner"
    if re.search(r"mask", name, re.IGNORECASE):
        return "Mask"
    return None


def name_product_type_supersedes_category(category: str, name_type: str) -> bool:
    """Return whether a title names a form more specific than its category."""

    normalized_category = _clean_product_type_text(category)
    normalized_name_type = _clean_product_type_text(name_type)
    if not normalized_category or not normalized_name_type or normalized_category.casefold() == normalized_name_type.casefold():
        return False
    return bool(
        (
            re.search(r"mist|미스트|ミスト", normalized_name_type, re.IGNORECASE)
            and re.search(r"cream|크림|クリーム", normalized_category, re.IGNORECASE)
        )
        or (
            re.search(r"eye[-\s]*cream|아이[\s-]*크림|アイ[\s-]*クリーム", normalized_name_type, re.IGNORECASE)
            and re.search(r"(?:^|\s)cream|크림|クリーム", normalized_category, re.IGNORECASE)
        )
        or (
            re.search(r"body\s*lotion|바디\s*로션|바디로션|ボディローション", normalized_name_type, re.IGNORECASE)
            and re.search(r"lotion|로션|ローション", normalized_category, re.IGNORECASE)
        )
        or (
            re.search(r"cleansing\s*foam|foam\s*cleanser|폼\s*클렌저|포밍\s*클렌저", normalized_name_type, re.IGNORECASE)
            and re.search(r"cleanser|클렌저|폼", normalized_category, re.IGNORECASE)
        )
    )


def _localized(pattern: str, value: str) -> tuple[re.Pattern[str], str]:
    return re.compile(pattern, re.IGNORECASE), value


_PRODUCT_TYPE_MAP: dict[PdpGeoLocale, tuple[tuple[re.Pattern[str], str], ...]] = {
    "ko-KR": (
        _localized(r"body\s*lotion|바디\s*로션|바디로션", "바디로션"),
        _localized(r"cream\s*mist|크림\s*미스트|크림미스트", "크림 미스트"),
        _localized(r"eye[-\s]*cream|아이[\s-]*크림|アイ[\s-]*クリーム", "아이 크림"),
        _localized(r"\bmist\b|미스트", "미스트"),
        _localized(r"lotion|로션", "로션"),
        _localized(r"cream|크림", "크림"),
        _localized(r"serum|세럼|앰플|에센스", "세럼"),
        _localized(r"toner|토너|스킨", "토너"),
        _localized(r"cleanser|클렌저|폼", "클렌저"),
        _localized(r"mask|마스크", "마스크"),
    ),
    "ja-JP": (
        _localized(r"body\s*lotion|ボディローション", "ボディローション"),
        _localized(r"cream\s*mist|クリーム\s*ミスト", "クリームミスト"),
        _localized(r"eye[-\s]*cream|アイ[\s-]*クリーム|아이[\s-]*크림", "アイクリーム"),
        _localized(r"mist|ミスト", "ミスト"),
        _localized(r"lotion|ローション", "ローション"),
        _localized(r"cream|クリーム", "クリーム"),
        _localized(r"serum|美容液|セラム", "美容液"),
        _localized(r"toner|化粧水", "化粧水"),
        _localized(r"cleanser|洗顔|クレンザー", "クレンザー"),
        _localized(r"mask|マスク", "マスク"),
    ),
    "en-US": (
        _localized(r"body\s*lotion|바디\s*로션|バディローション|ボディローション", "Body Lotion"),
        _localized(r"cream\s*mist|크림\s*미스트|크림미스트|クリーム\s*ミスト", "Cream Mist"),
        _localized(r"eye[-\s]*cream|아이[\s-]*크림|アイ[\s-]*クリーム", "Eye Cream"),
        _localized(r"\bmist\b|미스트|ミスト", "Mist"),
        _localized(r"lotion|로션|ローション", "Lotion"),
        _localized(r"cream|크림|クリーム", "Cream"),
        _localized(r"serum|세럼|앰플|에센스|美容液|セラム", "Serum"),
        _localized(r"toner|토너|스킨|化粧水", "Toner"),
        _localized(r"cleanser|클렌저|폼|洗顔|クレンザー", "Cleanser"),
        _localized(r"mask|마스크", "Mask"),
    ),
    "en-GB": (
        _localized(r"body\s*lotion|바디\s*로션|バディローション|ボディローション", "Body Lotion"),
        _localized(r"cream\s*mist|크림\s*미스트|크림미스트|クリーム\s*ミスト", "Cream Mist"),
        _localized(r"eye[-\s]*cream|아이[\s-]*크림|アイ[\s-]*クリーム", "Eye Cream"),
        _localized(r"\bmist\b|미스트|ミスト", "Mist"),
        _localized(r"lotion|로션|ローション", "Lotion"),
        _localized(r"cream|크림|クリーム", "Cream"),
        _localized(r"serum|세럼|앰플|에센스|美容液|セラム", "Serum"),
        _localized(r"toner|토너|스킨|化粧水", "Toner"),
        _localized(r"cleanser|클렌저|폼|洗顔|クレンザー", "Cleanser"),
        _localized(r"mask|마스크", "Mask"),
    ),
}


def localize_product_type_for_locale(product_type: str, locale: PdpGeoLocale) -> str:
    """Return a product form in the market vocabulary for ``locale``."""
    normalized = _clean_product_type_text(product_type)
    lower = normalized.lower()
    for pattern, localized in _PRODUCT_TYPE_MAP[locale]:
        if pattern.search(lower):
            return localized
    return normalized


productTypeFromName = product_type_from_name
localizeProductTypeForLocale = localize_product_type_for_locale


__all__ = [
    "PdpGeoLocale",
    "localize_product_type_for_locale",
    "localizeProductTypeForLocale",
    "name_product_type_supersedes_category",
    "product_type_from_name",
    "productTypeFromName",
]
