"""Contract coverage for sanitized provenance decision diagnostics."""

from __future__ import annotations

import json
from typing import Any

import pytest
from neo_agent_api.services import console_orchestration

_PRIVATE_COPY = "Glow Serum visibly transforms dry skin overnight."
_PRIVATE_SOURCE = "The internal source record must not be published."
_PRIVATE_URL = "https://private.example.test/evidence"
_PRIVATE_KEY = "credential-must-not-appear"


class _QualityGateBlocked(RuntimeError):
    def __init__(self) -> None:
        super().__init__("Quality gate blocked final artifact after corrective refinement.")
        self.diagnostics: dict[str, Any] = {
            "process": [{"id": "quality-gate", "status": "error"}],
            "qualityGate": {
                "attempted": True,
                "adopted": False,
                "reason": "Quality gate blocked final artifact after corrective refinement.",
                "shortfalls": ["1 unresolved public-copy provenance warning(s)"],
                "blockingShortfalls": ["1 unresolved public-copy provenance warning(s)"],
                "correctiveDiagnostics": {
                    "correctiveApplied": True,
                    "correctedMissingPaths": ["Product.description", _PRIVATE_URL],
                    "adoptionReason": "provenanceRegression",
                    "structuralShortfallCount": 0,
                    "provenanceRegressionDelta": 1,
                    "candidateCopy": _PRIVATE_COPY,
                    "apiKey": _PRIVATE_KEY,
                },
            },
            "validationFindings": [],
            "finalPublicCopyProvenance": {"count": 0, "fieldPaths": []},
            "publicCopyProvenanceDecisionDiagnostics": [
                {
                    "fieldPath": "Product.description",
                    "phase": "correctedCandidate",
                    "sentenceIndex": 0,
                    "outcome": "unsupported",
                    "reason": "assertionFrameRejected",
                    "plan": {"mode": "model", "fieldIncluded": True, "textHashMatch": False},
                    "eligibleEvidenceCount": 1,
                    "eligibleRoleCounts": {"description": 1},
                    "selectedEvidenceCount": 0,
                    "text": _PRIVATE_COPY,
                    "source": _PRIVATE_SOURCE,
                    "sourceUrl": _PRIVATE_URL,
                    "apiKey": _PRIVATE_KEY,
                    "sourceHash": "fnv1a-secret",
                    "evidenceIds": ["private-evidence"],
                },
                {
                    "fieldPath": _PRIVATE_URL,
                    "phase": "initial",
                    "sentenceIndex": 0,
                    "outcome": "unsupported",
                    "reason": "noEligibleEvidence",
                },
            ],
        }


async def _raise_quality_gate_block(*_args: object, **_kwargs: object) -> dict[str, Any]:
    raise _QualityGateBlocked()


@pytest.mark.asyncio
async def test_run_generate_forwards_only_safe_provenance_decision_diagnostics(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(console_orchestration, "generate_pdp_geo", _raise_quality_gate_block)

    payload = await console_orchestration.run_generate(
        {"product": {"name": "Barrier Serum"}}, runtime={"provider": "mock"}
    )

    diagnostics = payload["failures"][0]["diagnostics"]
    assert diagnostics["qualityGate"]["correctiveDiagnostics"] == {
        "correctiveApplied": True,
        "correctedMissingPaths": ["Product.description"],
        "adoptionReason": "provenanceRegression",
        "structuralShortfallCount": 0,
        "provenanceRegressionDelta": 1,
    }
    assert diagnostics["publicCopyProvenanceDecisionDiagnostics"] == [
        {
            "fieldPath": "Product.description",
            "phase": "correctedCandidate",
            "sentenceIndex": 0,
            "outcome": "unsupported",
            "reason": "assertionFrameRejected",
            "plan": {"mode": "model", "fieldIncluded": True, "textHashMatch": False},
            "eligibleEvidenceCount": 1,
            "eligibleRoleCounts": {"description": 1},
            "selectedEvidenceCount": 0,
        }
    ]
    serialized = json.dumps(diagnostics)
    for private_value in (_PRIVATE_COPY, _PRIVATE_SOURCE, _PRIVATE_URL, _PRIVATE_KEY, "sourceHash", "evidenceIds"):
        assert private_value not in serialized
