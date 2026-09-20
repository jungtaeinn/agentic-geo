"""Ordered ingredient surface vocabulary shared by normalization and rendering."""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass


@dataclass(frozen=True)
class IngredientSurfaceRule:
    """One source spelling, its public surface, and optional substance family."""

    pattern: re.Pattern[str]
    surface: str
    substance: str | None = None


def _rule(
    pattern: str, surface: str, substance: str | None = None, *, ignore_case: bool = True
) -> IngredientSurfaceRule:
    return IngredientSurfaceRule(re.compile(pattern, re.IGNORECASE if ignore_case else 0), surface, substance)


brand_ingredient_surface_rules: tuple[IngredientSurfaceRule, ...] = (
    _rule(r"500[-\s]?hour(?:\s+aged)?\s+ginseng", "500-hour aged ginseng"),
    _rule(r"korean herb extract", "Korean herb extract"),
    _rule(r"botanical_complex|BotanicalComplex", "Korean Ginseng Actives (BotanicalComplex)", "botanical_complex"),
    _rule(r"korean ginseng actives", "Korean Ginseng Actives", "botanical_complex"),
    _rule(r"BotanicalComplex|botanical_complex", "BotanicalComplex", "botanical_complex"),
    _rule(r"진생\s*펩타이드|진생펩타이드|ginseng peptide", "진생펩타이드", "ginseng-peptide"),
    _rule(r"진생\s*레티놀|진생레티놀|ginseng retinol", "진생레티놀", "ginseng-retinol"),
)
generic_ingredient_surface_rules: tuple[IngredientSurfaceRule, ...] = (
    _rule(r"ginseng peptide", "Ginseng Peptide", "ginseng-peptide"),
    _rule(r"retinol", "Retinol", "retinol"),
    _rule(r"niacinamide", "Niacinamide", "niacinamide"),
    _rule(r"hyaluronic(?:\s+acid)?|sodium hyaluronate", "Hyaluronic Acid", "hyaluronic-acid"),
    _rule(r"\bzinc\b", "Zinc", "zinc"),
    _rule(r"ceramide", "Ceramide", "ceramide"),
    _rule(r"panthenol", "Panthenol", "panthenol"),
    _rule(r"betaine", "Betaine", "betaine"),
    _rule(r"probiotics?", "Probiotics", "probiotics"),
    _rule(r"징크", "징크", "zinc", ignore_case=False),
    _rule(r"히알루론산|하이알루론산", "히알루론산", "hyaluronic-acid", ignore_case=False),
    _rule(r"나이아신아마이드", "나이아신아마이드", "niacinamide", ignore_case=False),
    _rule(r"판테놀", "판테놀", "panthenol", ignore_case=False),
    _rule(r"베타인", "베타인", "betaine", ignore_case=False),
    _rule(r"프로바이오틱스", "프로바이오틱스", "probiotics", ignore_case=False),
    _rule(r"세라마이드", "세라마이드", "ceramide", ignore_case=False),
)
ingredient_surface_rules = brand_ingredient_surface_rules + generic_ingredient_surface_rules


def canonical_ingredient_surface(
    text: str, rules: Sequence[IngredientSurfaceRule] = ingredient_surface_rules
) -> str | None:
    """Return the first canonical ingredient surface matching ``text``."""
    return next((rule.surface for rule in rules if rule.pattern.search(text)), None)


def ingredient_surfaces_present_in(haystack: str) -> list[str]:
    """Return every matching canonical surface in vocabulary order."""
    return [rule.surface for rule in ingredient_surface_rules if rule.pattern.search(haystack)]


def ingredient_substance_key(text: str) -> str | None:
    """Return a shared substance key only when text names that substance itself."""
    bare = _bare_substance_text(text)
    if not bare:
        return None
    return next(
        (
            rule.substance
            for rule in ingredient_surface_rules
            if rule.substance is not None and bare == _bare_substance_text(rule.surface)
        ),
        None,
    )


def _bare_substance_text(text: str) -> str:
    without_parentheses = re.sub(r"\([^)]*\)", " ", text)
    without_quantities = re.sub(
        r"\d[\d,.]*\s*(?:%|％|ppm|mg|g|ml|mL|oz)?", " ", without_parentheses, flags=re.IGNORECASE
    )
    return "".join(character for character in without_quantities if character.isalpha()).lower()


brandIngredientSurfaceRules = brand_ingredient_surface_rules
genericIngredientSurfaceRules = generic_ingredient_surface_rules
ingredientSurfaceRules = ingredient_surface_rules
canonicalIngredientSurface = canonical_ingredient_surface
ingredientSurfacesPresentIn = ingredient_surfaces_present_in
ingredientSubstanceKey = ingredient_substance_key


__all__ = [
    "IngredientSurfaceRule",
    "brand_ingredient_surface_rules",
    "brandIngredientSurfaceRules",
    "canonical_ingredient_surface",
    "canonicalIngredientSurface",
    "generic_ingredient_surface_rules",
    "genericIngredientSurfaceRules",
    "ingredient_substance_key",
    "ingredient_surface_rules",
    "ingredient_surfaces_present_in",
    "ingredientSubstanceKey",
    "ingredientSurfaceRules",
    "ingredientSurfacesPresentIn",
]
