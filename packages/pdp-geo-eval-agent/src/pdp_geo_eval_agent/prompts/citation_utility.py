"""Strict JSON prompt builders for the GEU-style utility judges."""

from __future__ import annotations

import json
from collections.abc import Mapping

from ..models import to_wire


def build_keypoint_judge_prompt(evidence: list[Mapping[str, object]], public_text: str) -> dict[str, str]:
    keypoints = [{"id": item.get("id"), "role": item.get("role"), "content": item.get("text")} for item in evidence]
    return {
        "system": "You are a meticulous fact-checker for product content. Respond strictly with the requested JSON object and nothing else.",
        "user": f'''You are given a JSON array of Key Points (atomic product evidence) and a Document (public product copy).
For EACH Key Point, determine if the Document:
- "Supported": contains information consistent with and supporting the Key Point.
- "Omitted": does not mention or cover the Key Point.
- "Contradicted": states something that disagrees with the Key Point (different numbers, units, ingredients, claim strength, or attribution count as contradictions).

Return a single JSON object. The keys must be the Key Point "id" values. Each value must be an object with:
- "label": one of "Supported", "Omitted", "Contradicted"
- "justification": a brief, specific explanation citing the relevant document wording

Respond ONLY with the JSON object.

---
Key Points:
{json.dumps(to_wire(keypoints), ensure_ascii=False, indent=2)}

---
Document:
{public_text}''',
    }


def build_claim_extraction_prompt(answer: str) -> dict[str, str]:
    return {
        "system": "You are an information extraction expert. Respond strictly with the requested JSON object and nothing else.",
        "user": f'''Given a report, extract all distinct factual claims. For each claim, identify the source indices it cites (e.g., [0], [1], [2][3]).

Return a JSON object with a "claims" list, where each entry has:
- "claimId": a sequential integer starting from 1.
- "claim": a concise, complete sentence of the claim.
- "sourceIndices": a list of integer indices cited for this claim. If no source is cited, return an empty list [].

IMPORTANT:
- Only extract factual claims, not opinions or summaries.
- The source indices must be integers extracted directly from citations like [0] or [1][2].

Report to process:
"""
{answer}
"""

Return the JSON object and nothing else.''',
    }


def build_citation_support_prompt(claim: str, source_text: str) -> dict[str, str]:
    return {
        "system": "You are a meticulous fact-checker. Respond strictly with the requested JSON object and nothing else.",
        "user": f'''Evaluate if a "Statement" is supported by the "Source Text".
Respond strictly in JSON format with "support" ('full_support', 'partial_support', or 'no_support') and a brief "justification".

- "full_support": all information in the statement is directly supported by the source text.
- "partial_support": some parts are supported, but other parts are not.
- "no_support": the source text does not support the statement.

Statement: "{claim}"

Source Text:
"""
{source_text}
"""

Your JSON response:''',
    }
