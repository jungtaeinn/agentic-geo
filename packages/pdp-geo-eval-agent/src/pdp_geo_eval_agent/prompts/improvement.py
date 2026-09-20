"""Copy-paste LLM prompts grounded in evaluator results."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import cast

from ..quality.suite import (
    build_probe_safety_notes,
    format_pct_delta,
    format_section_attribution,
    get_evaluation_suite_copy,
    probe_query_outcome,
    share_to_pct,
)


def format_content_sections_for_prompt(sections: Mapping[str, object], language: str) -> str:
    labels = [("productName", "상품명", "Product name"), ("description", "설명", "Description"), ("quickFacts", "퀵 팩트", "Quick facts"), ("benefits", "효능", "Benefits"), ("ingredients", "성분", "Ingredients"), ("howToUse", "사용법", "How to use"), ("faq", "FAQ", "FAQ")]
    blocks: list[str] = []
    for key, korean, english in labels:
        value = sections.get(key, sections.get(_snake(key), ""))
        if isinstance(value, str) and value.strip():
            blocks.append(f"### {korean if language == 'ko' else english}\n{value.strip()}")
    return "\n\n".join(blocks)


def format_quality_llm_prompt(context: Mapping[str, object], evaluation: object, language: str) -> str:
    product_name = _string(context.get("productName", context.get("product_name", "")))
    dimensions = _list(_field(evaluation, "dimensions", []))
    blocks: list[str] = []
    for dimension in dimensions:
        improvements = _list(_field(dimension, "improvements", []))
        evidence = _list(_field(dimension, "evidence", []))
        parts = [f"### {_field(dimension, 'label')} — {_field(dimension, 'score')}/100"]
        if improvements:
            parts.append(f"{'개선점' if language == 'ko' else 'Improvements'}:\n" + "\n".join(f"- {item}" for item in improvements))
        if evidence:
            parts.append(f"{'평가 근거' if language == 'ko' else 'Evidence'}:\n" + "\n".join(f"- {item}" for item in evidence))
        blocks.append("\n".join(parts))
    details = _list(_field(evaluation, "validation_details", _field(evaluation, "validationDetails", [])))
    directions = _list(_field(evaluation, "validation_improvements", _field(evaluation, "validationImprovements", [])))
    validation_block = f"\n## {'검증 경고' if language == 'ko' else 'Validation warnings'}\n" + "\n".join(f"- {item}" for item in [*details, *directions]) + "\n" if details or directions else ""
    sections = context.get("contentSections", context.get("content_sections", {}))
    sections_text = format_content_sections_for_prompt(_mapping(sections), language)
    # This is raw user JSON-LD, not an evaluator value object. JSON.stringify
    # preserves unknown key spelling and explicit nulls, so do not pass it
    # through the wire serializer (which camelizes keys and omits None).
    json_ld = json.dumps(context.get("jsonLd", context.get("json_ld")), ensure_ascii=False, indent=2)
    overall = _field(evaluation, "overall_score", _field(evaluation, "overallScore"))
    if language == "ko":
        return f'''당신은 GEO(생성형 엔진 최적화) 콘텐츠 개선 어시스턴트입니다.
아래는 상품 "{product_name}"의 PDP에서 자동 생성된 schema.org JSON-LD·콘텐츠와 자동 품질 진단 결과입니다.

## 작업
1. "개선점"을 우선순위대로 해결하는 구체적인 수정안을 제시하세요. 수정 전/후를 문장 또는 JSON-LD 필드 단위로 보여주세요.
2. 절대 규칙: 아래 콘텐츠와 JSON-LD에 없는 효능·수치·성분·인증·리뷰를 새로 만들지 마세요. 기존 사실 범위 안에서 표현과 구조만 개선합니다.
3. 각 수정안이 어떤 진단 항목(GEO/CEP/E-E-A-T/검증 경고)을 해결하는지 명시하세요.

## 품질 진단 (총점 {overall}/100)
{'\n\n'.join(blocks)}
{validation_block}
## 현재 콘텐츠 섹션
{sections_text}

## 현재 JSON-LD
```json
{json_ld}
```
'''
    return f'''You are a GEO (generative engine optimization) content improvement assistant.
Below are the auto-generated schema.org JSON-LD and content for the product "{product_name}", together with an automated quality diagnosis.

## Tasks
1. Propose concrete fixes that resolve the "Improvements" in priority order, showing before/after at the sentence or JSON-LD field level.
2. Hard rule: never invent benefits, figures, ingredients, certifications, or reviews that are absent from the content and JSON-LD below. Improve wording and structure only within the existing facts.
3. State which diagnosis item (GEO/CEP/E-E-A-T/validation warning) each fix resolves.

## Quality diagnosis (overall {overall}/100)
{'\n\n'.join(blocks)}
{validation_block}
## Current content sections
{sections_text}

## Current JSON-LD
```json
{json_ld}
```
'''


def format_probe_llm_prompt(context: Mapping[str, object], probe: object, language: str) -> str:
    suite = get_evaluation_suite_copy(language)
    product_name = _string(context.get("productName", context.get("product_name", "")))
    lines: list[str] = []
    for query in _list(_field(probe, "queries", [])):
        delta = _field(query, "delta", {})
        outcome = probe_query_outcome(_float(_field(delta, "wordpos", 0)))
        tag = suite.outcome_labels.get(outcome, outcome)
        priority = " · 우선 개선 대상" if language == "ko" and outcome != "improved" else " · fix first" if outcome != "improved" else ""
        attribution = _list(_field(query, "section_attribution", _field(query, "sectionAttribution", [])))
        attribution_text = f" · {suite.attribution_label}: {format_section_attribution(attribution, suite)}" if attribution else ""
        vanilla = _field(query, "vanilla", {})
        generated = _field(query, "generated", {})
        lines.append(f'- [{tag}{priority}] "{_field(query, "query")}" — {share_to_pct(_float(_field(vanilla, "wordpos", 0)))}% → {share_to_pct(_float(_field(generated, "wordpos", 0)))}% (Δ{format_pct_delta(_float(_field(delta, "wordpos", 0)))}){attribution_text}')
    overall = _list(_field(probe, "section_attribution", _field(probe, "sectionAttribution", [])))
    overall_line = f"\n{suite.overall_attribution_label}: {format_section_attribution(overall, suite)}" if overall else ""
    safety = "\n".join(f"- {item}" for item in build_probe_safety_notes(probe, suite))
    sections = context.get("contentSections", context.get("content_sections", {}))
    sections_text = format_content_sections_for_prompt(_mapping(sections), language)
    engine_id = _field(probe, "engine_id", _field(probe, "engineId"))
    if language == "ko":
        return f'''당신은 AI 검색(생성형 엔진) 인용 최적화 어시스턴트입니다.
상품 "{product_name}"의 생성 콘텐츠를 모의 AI 검색엔진({engine_id})에서 테스트했습니다. 같은 질문·같은 경쟁 문서 세트에 원본 PDP와 생성 콘텐츠를 각각 넣고, AI 답변에서 얼마나 인용되는지(점유율)를 비교한 결과입니다.

## 질문별 결과 (원본 → 생성)
{'\n'.join(lines)}{overall_line}

## 안전 점검
{safety or '- (실행되지 않음)'}

## 작업
1. "우선 개선 대상" 질문부터, 콘텐츠가 그 질문의 직접적인 답이 되도록 문장 단위 보강안을 제시하세요. 핵심 결론 선행, 질문-답 구조, 리스트/헤딩 구조화, 근거 범위 내의 구체 수치 스코핑을 우선하세요.
2. 절대 규칙: 아래 콘텐츠에 없는 효능·수치·성분·인증·리뷰를 새로 만들지 마세요.
3. 각 보강안이 어느 질문의 인용률을 높이기 위한 것인지 명시하세요.

## 현재 콘텐츠 섹션
{sections_text}
'''
    return f'''You are an AI-search (generative engine) citation optimization assistant.
The generated content for "{product_name}" was tested on a simulated AI search engine ({engine_id}): with identical questions and competitor documents, the vanilla PDP and the generated content were each measured for citation share in the AI answer.

## Per-question results (vanilla → generated)
{'\n'.join(lines)}{overall_line}

## Safety check
{safety or '- (not run)'}

## Tasks
1. Starting with the questions marked "fix first", propose sentence-level additions so the content directly answers each question — lead with the conclusion, use question-answer structure, lists/headings, and scope any figures within the existing evidence.
2. Hard rule: never invent benefits, figures, ingredients, certifications, or reviews absent from the content below.
3. State which question each addition targets.

## Current content sections
{sections_text}
'''


def _field(value: object, name: str, default: object = None) -> object:
    if isinstance(value, Mapping):
        return cast(Mapping[str, object], value).get(name, default)
    return cast(object, getattr(value, name, default))


def _list(value: object) -> list[object]:
    return cast(list[object], value) if isinstance(value, list) else []


def _mapping(value: object) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[object, object], value).items()}


def _float(value: object) -> float:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0.0


def _snake(name: str) -> str:
    return "".join(("_" + character.lower()) if character.isupper() else character for character in name).lstrip("_")


def _string(value: object) -> str:
    return value if isinstance(value, str) else ""
