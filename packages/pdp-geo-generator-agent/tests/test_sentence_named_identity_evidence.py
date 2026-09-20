"""Regression coverage for identity atoms surviving per-sentence evidence narrowing."""

from __future__ import annotations

import json
import pathlib
from collections.abc import Mapping
from typing import Any, cast

from pdp_geo_generator_agent._json import clean_text
from pdp_geo_generator_agent.content_planning import create_pdp_geo_evidence_ledger
from pdp_geo_generator_agent.final_proofreader import select_rendered_sentence_evidence

_FIXTURES = pathlib.Path(__file__).parent / "fixtures" / "source-products"


def _ledger(fixture: str, locale: str) -> list[Mapping[str, Any]]:
    product = json.loads((_FIXTURES / fixture).read_text(encoding="utf-8"))
    return cast(list[Mapping[str, Any]], create_pdp_geo_evidence_ledger(product, locale))


def _selected_roles(sentence: str, ledger: list[Mapping[str, Any]]) -> set[str]:
    roles = sorted({clean_text(item.get("role")) for item in ledger})
    selected = select_rendered_sentence_evidence(sentence, ledger, roles)
    chosen = set(selected["sentenceEvidenceIds"][0])
    return {clean_text(item.get("role")) for item in ledger if clean_text(item.get("id")) in chosen}


def test_korean_sentence_keeps_the_identity_it_names_through_evidence_narrowing() -> None:
    """A Korean sentence that calls the product name keeps that name's atom.

    Narrowing evidence sentence by sentence dropped the identity, and without
    it the digits of ``DailyClean365`` read as an unsourced measurement, so the
    sentence lost its own subject and was deleted from public copy.
    """

    ledger = _ledger("sample-derma-cleansing-foam.json", "ko-KR")
    sentence = "SampleDerma DailyClean365 Cleansing Foam 200g에는 판테놀, 베타인, 글리세린 등이 주요 성분·기술로 포함되어 있습니다."

    assert {"identity", "ingredient"} <= _selected_roles(sentence, ledger)


def test_a_shortened_rendering_of_a_registered_name_still_calls_it() -> None:
    """The renderer writes the name without the quantity the product is sold in.

    A registered name ends in its volume; public copy names the product
    without it.  That is the same name, so the sentence still keeps the
    identity atom its subject comes from.
    """

    ledger = _ledger("sample-derma-cleansing-foam.json", "ko-KR")
    sentence = "SAMPLE_DERMA의 SampleDerma DailyClean365 Cleansing Foam에는 판테놀, 베타인, 글리세린 등이 주요 성분·기술로 포함되어 있습니다."

    assert {"identity", "ingredient"} <= _selected_roles(sentence, ledger)


def test_english_sentence_keeps_the_identity_it_names_through_evidence_narrowing() -> None:
    """The same restoration holds where the locale writes the name in English."""

    ledger = _ledger("sample-botanics-serum.json", "en-US")
    sentence = "SampleBotanics's Daily Renewal Serum VI retains the same core ingredients as earlier versions."

    assert "identity" in _selected_roles(sentence, ledger)


def test_a_measurement_the_ledger_never_published_stays_unsupported() -> None:
    """Restoring a named identity may not excuse a figure no source states."""

    ledger = _ledger("sample-derma-cleansing-foam.json", "ko-KR")
    sentence = "SampleDerma DailyClean365 Cleansing Foam 200g은 99.9%의 세정력을 제공합니다."
    roles = sorted({clean_text(item.get("role")) for item in ledger})

    assert select_rendered_sentence_evidence(sentence, ledger, roles)["sentenceEvidenceIds"] == [[]]


def test_a_sentence_does_not_borrow_the_identity_of_a_name_it_never_writes() -> None:
    """Narrowing still holds: an unnamed identity is not restored to a sentence."""

    ledger = _ledger("sample-derma-cleansing-foam.json", "ko-KR")
    sentence = "판테놀, 베타인, 글리세린 등이 주요 성분·기술로 포함되어 있습니다."

    assert "identity" not in _selected_roles(sentence, ledger)
