"""Public value objects for the PDP GEO evaluator.

The TypeScript package exposes plain JSON-compatible objects.  Python uses
small dataclasses for attribute-friendly library calls and each object can be
serialized through :meth:`to_wire` at HTTP/package boundaries.
"""

from __future__ import annotations

from dataclasses import dataclass, fields, is_dataclass
from typing import Protocol, cast, runtime_checkable


@runtime_checkable
class _WireSerializable(Protocol):
    def to_wire(self) -> object: ...


def to_wire(value: object) -> object:
    """Convert evaluator value objects to camelCase JSON-compatible values.

    ``None`` represents JavaScript ``undefined`` for object fields and is
    omitted recursively.  Lists preserve their items and insertion ordering is
    deliberately retained.
    """
    if isinstance(value, _WireSerializable):
        return value.to_wire()
    if is_dataclass(value) and not isinstance(value, type):
        return {
            _camel_case(field.name): to_wire(field_value)
            for field in fields(value)
            if (field_value := getattr(value, field.name)) is not None
        }
    if isinstance(value, dict):
        return {
            _camel_case(str(key)): to_wire(item)
            for key, item in cast(dict[object, object], value).items()
            if item is not None
        }
    if isinstance(value, list | tuple):
        return [to_wire(item) for item in cast(list[object] | tuple[object, ...], value)]
    return value


def _wire_mapping(value: object) -> dict[str, object]:
    return cast(dict[str, object], to_wire(value))


def _camel_case(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in tail)


@dataclass(slots=True)
class CitationSentence:
    text: str
    paragraph_index: int
    sentence_index: int
    word_count: int
    citations: list[int]

    def to_wire(self) -> dict[str, object]:
        return _wire_mapping({
            "text": self.text,
            "paragraph_index": self.paragraph_index,
            "sentence_index": self.sentence_index,
            "word_count": self.word_count,
            "citations": self.citations,
        })


@dataclass(slots=True)
class ImpressionShares:
    wordpos: list[float]
    word: list[float]
    pos: list[float]
    hallucinated_citations: list[int]
    cited_sentence_count: int
    sentence_count: int

    def to_wire(self) -> dict[str, object]:
        return _wire_mapping({
            "wordpos": self.wordpos,
            "word": self.word,
            "pos": self.pos,
            "hallucinated_citations": self.hallucinated_citations,
            "cited_sentence_count": self.cited_sentence_count,
            "sentence_count": self.sentence_count,
        })


@dataclass(slots=True)
class CitationVisibilityScore:
    wordpos: float
    word: float
    pos: float
    shares: ImpressionShares

    def to_wire(self) -> dict[str, object]:
        return _wire_mapping({"wordpos": self.wordpos, "word": self.word, "pos": self.pos, "shares": self.shares})


@dataclass(slots=True)
class CitationSectionAttribution:
    section_id: str
    share: float
    cited_sentences: int
    sentences: list[str]

    def to_wire(self) -> dict[str, object]:
        return _wire_mapping({
            "section_id": self.section_id,
            "share": self.share,
            "cited_sentences": self.cited_sentences,
            "sentences": self.sentences,
        })


@dataclass(slots=True)
class AttributableSection:
    id: str
    text: str

    def to_wire(self) -> dict[str, object]:
        return {"id": self.id, "text": self.text}


@dataclass(slots=True)
class KeypointJudgment:
    label: str
    justification: str

    def to_wire(self) -> dict[str, object]:
        return {"label": self.label, "justification": self.justification}


@dataclass(slots=True)
class EvidenceContradiction:
    evidence_id: str
    justification: str

    def to_wire(self) -> dict[str, object]:
        return _wire_mapping({"evidence_id": self.evidence_id, "justification": self.justification})


@dataclass(slots=True)
class KeypointCoverageScore:
    kpr: float
    kpc: float
    supported: int
    omitted: int
    contradicted: int
    total: int
    contradictions: list[EvidenceContradiction]

    def to_wire(self) -> dict[str, object]:
        return _wire_mapping({
            "kpr": self.kpr,
            "kpc": self.kpc,
            "supported": self.supported,
            "omitted": self.omitted,
            "contradicted": self.contradicted,
            "total": self.total,
            "contradictions": self.contradictions,
        })


@dataclass(slots=True)
class ExtractedClaim:
    claim_id: int
    claim: str
    source_indices: list[int]

    def to_wire(self) -> dict[str, object]:
        return _wire_mapping({"claim_id": self.claim_id, "claim": self.claim, "source_indices": self.source_indices})


@dataclass(slots=True)
class CitationSupportJudgment:
    support: str
    justification: str

    def to_wire(self) -> dict[str, object]:
        return {"support": self.support, "justification": self.justification}


@dataclass(slots=True)
class WeakClaim:
    claim: str
    best_support: str
    justification: str

    def to_wire(self) -> dict[str, object]:
        return _wire_mapping({
            "claim": self.claim,
            "best_support": self.best_support,
            "justification": self.justification,
        })


@dataclass(slots=True)
class CitationQualityScore:
    precision: float | None
    recall: float | None
    cited_claims: int
    total_claims: int
    weak_claims: list[WeakClaim]

    def to_wire(self) -> dict[str, object]:
        return _wire_mapping({
            "precision": self.precision,
            "recall": self.recall,
            "cited_claims": self.cited_claims,
            "total_claims": self.total_claims,
            "weak_claims": self.weak_claims,
        })


@dataclass(frozen=True, slots=True)
class UtilityGateThresholds:
    min_visibility_delta: float
    max_kpc: float
    min_kpr: float
    min_citation_precision: float

    def to_wire(self) -> dict[str, object]:
        return _wire_mapping({
            "min_visibility_delta": self.min_visibility_delta,
            "max_kpc": self.max_kpc,
            "min_kpr": self.min_kpr,
            "min_citation_precision": self.min_citation_precision,
        })


@dataclass(slots=True)
class UtilityGateResult:
    pass_: bool
    failures: list[str]
    skipped_checks: list[str]

    def to_wire(self) -> dict[str, object]:
        return {"pass": self.pass_, "failures": self.failures, "skippedChecks": self.skipped_checks}


@dataclass(slots=True)
class GeoQualityDimension:
    """One deterministic GEO/CEP/E-E-A-T rubric dimension."""

    id: str
    label: str
    score: int
    criteria: str
    summary: str
    evidence: list[str]
    improvements: list[str]

    def to_wire(self) -> dict[str, object]:
        return {
            "id": self.id,
            "label": self.label,
            "score": self.score,
            "criteria": self.criteria,
            "summary": self.summary,
            "evidence": self.evidence,
            "improvements": self.improvements,
        }


@dataclass(slots=True)
class GeoQualityEvaluation:
    """Wire-compatible result of :func:`evaluate_geo_quality`."""

    overall_score: int
    dimensions: list[GeoQualityDimension]
    validation_details: list[str]
    validation_improvements: list[str]

    def to_wire(self) -> dict[str, object]:
        return _wire_mapping({
            "overall_score": self.overall_score,
            "dimensions": self.dimensions,
            "validation_details": self.validation_details,
            "validation_improvements": self.validation_improvements,
        })
