"""Shared vocabulary for analysis-only evidence labels.

The regular-expression sources deliberately mirror the TypeScript contract so
callers can compose them into larger patterns without duplicating vocabulary.
"""

from __future__ import annotations

import re

INTERNAL_ANALYSIS_LABEL_ALTERNATION = "|".join(
    (
        r"확인\s*지표",
        r"확인\s*근거",
        r"평가\s*지표",
        r"측정\s*/\s*평가\s*결과",
        r"측정\s*결과",
        r"reported\s*results?",
        r"consumer\s*assessment",
        "試験結果",
        "確認指標",
        "確認根拠",
    )
)
REPORTING_LEAD_LABEL_ALTERNATION = f"{INTERNAL_ANALYSIS_LABEL_ALTERNATION}|시험\\s*결과"
PRIMARY_ANALYSIS_LABEL: dict[str, str] = {
    "ko-KR": "확인 지표",
    "ja-JP": "確認指標",
    "en-US": "Reported result",
    "en-GB": "Reported result",
}
CONSUMER_ASSESSMENT_LABEL = "Consumer assessment"
PUBLISHABLE_KOREAN_RESULT_PHRASE = "시험 결과"
RENAMEABLE_KOREAN_LABEL_PATTERN = re.compile(r"확인\s*(?:지표|근거)")
LABEL_AS_NOUN_PHRASE_SUFFIX = r"\s*(?:[:：]|[은는이가을를에](?![가-힣])|$)"

_LABEL_PREFIX_PATTERN = re.compile(rf"^(?:{INTERNAL_ANALYSIS_LABEL_ALTERNATION})\s*[:：]\s+", re.IGNORECASE)
_LABEL_ARTIFACT_PATTERN = re.compile(
    rf"(?:{INTERNAL_ANALYSIS_LABEL_ALTERNATION})\s*(?:[:：]|[은는이가]\s)", re.IGNORECASE
)
analysis_label_prefixes_anywhere = re.compile(rf"(?:{INTERNAL_ANALYSIS_LABEL_ALTERNATION})\s*[:：]\s*", re.IGNORECASE)
leading_label_field_pattern = re.compile(
    rf"^(?:{REPORTING_LEAD_LABEL_ALTERNATION})\s*(?:[:：]|[은는이가](?=\s|$))\s*", re.IGNORECASE
)
leading_bare_reporting_label_pattern = re.compile(
    rf"^(?:{REPORTING_LEAD_LABEL_ALTERNATION})\s*(?:[:：]|[은는이가](?=\s|$))?\s*", re.IGNORECASE
)
leading_internal_label_pattern = re.compile(
    rf"^(?:{INTERNAL_ANALYSIS_LABEL_ALTERNATION})\s*(?:[:：]|[은는이가](?=\s|$))?\s*", re.IGNORECASE
)
_ASSESSMENT_CONTEXT_LABEL_PATTERN = re.compile(
    rf"^(.{{2,140}}?)\s*기준\s*(?:{INTERNAL_ANALYSIS_LABEL_ALTERNATION})?\s*[:：]?\s*(.+)$"
)


def is_analysis_label_prefixed(value: str) -> bool:
    """Return whether an internal label opens ``value`` as a field name."""
    return _LABEL_PREFIX_PATTERN.search(value) is not None


def has_analysis_label_artifact(value: str) -> bool:
    """Return whether an internal label is used as a field or subject."""
    return _LABEL_ARTIFACT_PATTERN.search(value) is not None


def match_assessment_context_label(value: str) -> re.Match[str] | None:
    """Match ``<context> 기준 <label>: <value>`` and expose its two groups."""
    return _ASSESSMENT_CONTEXT_LABEL_PATTERN.search(value)


# Stable camel-case aliases for mechanically ported TypeScript callers.
analysisLabelPrefixesAnywhere = analysis_label_prefixes_anywhere
leadingLabelFieldPattern = leading_label_field_pattern
leadingBareReportingLabelPattern = leading_bare_reporting_label_pattern
leadingInternalLabelPattern = leading_internal_label_pattern
isAnalysisLabelPrefixed = is_analysis_label_prefixed
hasAnalysisLabelArtifact = has_analysis_label_artifact
matchAssessmentContextLabel = match_assessment_context_label


__all__ = [
    "CONSUMER_ASSESSMENT_LABEL",
    "INTERNAL_ANALYSIS_LABEL_ALTERNATION",
    "LABEL_AS_NOUN_PHRASE_SUFFIX",
    "PUBLISHABLE_KOREAN_RESULT_PHRASE",
    "PRIMARY_ANALYSIS_LABEL",
    "RENAMEABLE_KOREAN_LABEL_PATTERN",
    "REPORTING_LEAD_LABEL_ALTERNATION",
    "analysis_label_prefixes_anywhere",
    "analysisLabelPrefixesAnywhere",
    "has_analysis_label_artifact",
    "hasAnalysisLabelArtifact",
    "is_analysis_label_prefixed",
    "isAnalysisLabelPrefixed",
    "leading_bare_reporting_label_pattern",
    "leading_internal_label_pattern",
    "leading_label_field_pattern",
    "leadingBareReportingLabelPattern",
    "leadingInternalLabelPattern",
    "leadingLabelFieldPattern",
    "match_assessment_context_label",
    "matchAssessmentContextLabel",
]
