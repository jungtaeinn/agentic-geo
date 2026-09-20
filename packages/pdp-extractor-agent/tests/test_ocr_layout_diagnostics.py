"""OCR layout diagnostics contracts (3 legacy counterparts)."""

from __future__ import annotations

from typing import Any

from pdp_extractor_agent.ocr.evidence import assemble_image_ocr_evidence

IMAGE = "https://image.example.com/detail.png"
TEXT = "Benefit\\n1\\nBarrier protection"
GROUPS = [
    {"id": "g1", "title": "Benefit", "lines": [{"text": "Benefit", "role": "title"}]},
    {
        "id": "g2",
        "parentId": "g1",
        "ordinal": 1,
        "lines": [{"text": "1", "role": "label"}, {"text": "Barrier protection", "role": "body"}],
    },
]


def _ocr(groups: object = GROUPS) -> dict[str, object]:
    return {"extractedTexts": [{"imageUrl": IMAGE, "text": TEXT, "confidence": 0.98, "groups": groups}]}


def test_records_reported_kept_groups_and_layout_roles() -> None:
    diagnostics: dict[str, Any] = {}
    assemble_image_ocr_evidence(_ocr(), {}, [], "Cleanser", diagnostics=diagnostics)
    assert diagnostics["layout"] == {
        "groupsReported": 2,
        "groupsKept": 2,
        "lineRoles": {"title": 1, "body": 1, "label": 1, "value": 0, "footnote": 0},
        "sliceStitches": 0,
        "structureDiscarded": [],
    }


def test_records_a_quorum_discard_when_transcription_does_not_back_structure() -> None:
    diagnostics: dict[str, Any] = {}
    assemble_image_ocr_evidence(
        _ocr(
            [{"id": "g1", "lines": [{"text": "Missing one", "role": "body"}, {"text": "Missing two", "role": "body"}]}]
        ),
        {},
        [],
        "Cleanser",
        diagnostics=diagnostics,
    )
    assert diagnostics["layout"]["structureDiscarded"] == [{"imageUrl": IMAGE, "reason": "quorum"}]
    assert diagnostics["layout"]["groupsKept"] == 0


def test_omits_layout_diagnostics_when_the_provider_reported_no_structure() -> None:
    diagnostics: dict[str, object] = {}
    assemble_image_ocr_evidence(_ocr(None), {}, [], "Cleanser", diagnostics=diagnostics)
    assert "layout" not in diagnostics
