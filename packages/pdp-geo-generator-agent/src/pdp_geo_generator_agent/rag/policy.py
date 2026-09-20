"""Compile managed RAG documents into bounded, auditable policy rules."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any, cast

from .index import find_pdp_geo_rag_index_entry, find_pdp_geo_rag_section_entry

DEFAULT_POLICY_RULE_BUDGET = 240
_DEFAULT_MAX_RULE_CHARS = 260
_MIN_RULE_CHARS = 24
_CRITICAL = re.compile(
    r"(?:\bmust\b|\bmust not\b|\bnever\b|\bdo not\b|\bdon['’]t\b|\bcannot\b|\bnot allowed\b|\bprohibit(?:ed|s)?\b|\bforbidden\b|\breject\b|\bavoid\b|\bexclude\b|\brequired\b|\bpreserve\b|\bonly when\b|\bonly if\b|금지|반드시|하지 마|하지 않|해야 합니다|없어야|제외)",
    re.I,
)
_LIST_ITEM = re.compile(r"^\s{0,6}(?:[-*+]|\d{1,2}[.)])\s+(.+)$")
_HEADING = re.compile(r"^(#{1,4})\s+(.+?)\s*$")


def compile_pdp_geo_policy_checklist(
    documents: Sequence[Mapping[str, object]], settings: Mapping[str, object] | None = None
) -> dict[str, Any]:
    config = dict(settings or {})
    maximum = _integer(config.get("maxRules"), DEFAULT_POLICY_RULE_BUDGET)
    max_chars = _integer(config.get("maxRuleChars"), _DEFAULT_MAX_RULE_CHARS)
    rules = [] if config.get("enabled") is False else extract_policy_rules(documents, max_chars)
    injected, excluded = _select_for_injection(rules, maximum)
    return {"rules": rules, "injectedRules": injected, "coverage": _coverage(rules, injected, excluded)}


def extract_policy_rules(documents: Sequence[Mapping[str, object]], max_rule_chars: int) -> list[dict[str, Any]]:
    rules: list[dict[str, Any]] = []
    seen: set[str] = set()
    for document in documents:
        name = str(document.get("name") or "")
        if not _is_policy_document(name):
            continue
        content = str(document.get("content") or "")
        index_entry = find_pdp_geo_rag_index_entry(name)
        headings: list[tuple[int, str]] = []
        in_fence = False
        pending: str | None = None
        count = 0

        def flush() -> None:
            nonlocal pending, count
            if pending is None:
                return
            text = _clean_rule(pending, max_rule_chars)
            pending = None
            if len(text) < _MIN_RULE_CHARS:
                return
            key = normalize_rule_key(text)
            if key in seen:
                return
            seen.add(key)
            count += 1
            heading = headings[-1][1] if headings else "General"
            section = _section_for_stack(name, headings)
            extraction = str((section or index_entry or {}).get("ruleExtraction") or "rules")
            base_priority = float((section or index_entry or {}).get("priority") or 0.8)
            trusted = document.get("trusted") is not False
            rules.append(
                {
                    "id": f"{_rule_prefix(name)}-{count:03d}",
                    "document": name,
                    **({"version": document["version"]} if isinstance(document.get("version"), str) else {}),
                    "kind": str((index_entry or {}).get("kind") or "custom"),
                    "heading": heading,
                    "text": text,
                    "intents": list((section or index_entry or {}).get("intents") or ["general"]),
                    "fieldTargets": list((section or index_entry or {}).get("fieldTargets") or []),
                    "severity": "guidance"
                    if extraction == "narrative" or not trusted
                    else "critical"
                    if _CRITICAL.search(text)
                    else "guidance",
                    "extraction": extraction,
                    "priority": min(base_priority, 0.6) if extraction == "narrative" else base_priority,
                }
            )

        for line in content.splitlines():
            if re.match(r"^\s*```", line):
                flush()
                in_fence = not in_fence
                continue
            if in_fence:
                continue
            heading_match = _HEADING.match(line)
            if heading_match:
                flush()
                level = len(heading_match.group(1))
                title = heading_match.group(2)
                headings = [entry for entry in headings if entry[0] < level]
                headings.append((level, title))
                continue
            if re.match(r"^\s*\|", line):
                flush()
                continue
            list_match = _LIST_ITEM.match(line)
            if list_match:
                flush()
                pending = list_match.group(1)
                continue
            if pending and line.strip() and re.match(r"^\s{2,}", line):
                pending = f"{pending} {line.strip()}"
                continue
            flush()
        flush()
    return rules


def format_policy_checklist_payload(rules: Sequence[Mapping[str, object]]) -> dict[str, Any] | None:
    if not rules:
        return None
    groups: dict[str, list[Mapping[str, object]]] = {}
    for rule in rules:
        groups.setdefault(_field_group(_strings(rule.get("fieldTargets"))), []).append(rule)
    return {
        "instruction": [
            "policyChecklist is the budget-bounded compiled requirement set selected across the loaded RAG policy documents; it is authoritative over any looser summary of the same selected rules.",
            "The selector preserves cross-document coverage before filling remaining capacity by severity and priority; apply each included rule without assuming that an omitted rule was contradicted.",
            "Apply every [critical] rule as a hard constraint on the requested fields. Apply [guidance] rules unless product evidence makes them inapplicable.",
            "[brand-context] entries are brand positioning/tone background, not requirements: use them for vocabulary and mood, and never convert them into product claims or facts.",
            "Before returning JSON, re-check each [critical] rule against your draft and report any rule you could not satisfy in ruleCompliance.violatedRuleIds.",
        ],
        "groups": [
            {
                "field": field,
                "rules": [
                    _format_rule(rule)
                    for rule in sorted(
                        group,
                        key=lambda row: (
                            0 if row.get("severity") == "critical" else 1,
                            -_number(row.get("priority"), 0),
                        ),
                    )
                ],
            }
            for field, group in groups.items()
        ],
    }


def format_policy_compliance_recap(rules: Sequence[Mapping[str, object]]) -> dict[str, Any] | None:
    critical = [str(rule.get("id")) for rule in rules if rule.get("severity") == "critical"]
    return (
        {
            "instruction": "Final check before answering: verify the draft against every critical rule id below, fix violations, then list any remaining unsatisfied ids in ruleCompliance.violatedRuleIds with a short note in ruleCompliance.notes.",
            "criticalRuleIds": critical,
        }
        if critical
        else None
    )


def normalize_rule_key(text: str) -> str:
    return "".join(char for char in text.lower() if char.isascii() and char.isalnum() or "가" <= char <= "힣")


def _select_for_injection(rules: list[dict[str, Any]], maximum: int) -> tuple[list[dict[str, Any]], list[str]]:
    eligible = [rule for rule in rules if not _non_authoring(rule)]
    budget = max(0, maximum)
    ordered = sorted(eligible, key=_coverage_sort_key)
    representatives: list[dict[str, Any]] = []
    documents: set[str] = set()
    for rule in ordered:
        if rule["document"] not in documents and len(representatives) < budget:
            representatives.append(rule)
            documents.add(str(rule["document"]))
    injected = list(representatives)
    ids = {str(rule["id"]) for rule in injected}
    for rule in sorted([item for item in eligible if item["severity"] == "critical"], key=_coverage_sort_key) + sorted(
        [item for item in eligible if item["severity"] == "guidance"], key=_coverage_sort_key
    ):
        if len(injected) >= budget:
            break
        if str(rule["id"]) not in ids:
            injected.append(rule)
            ids.add(str(rule["id"]))
    return injected, [str(rule["id"]) for rule in rules if str(rule["id"]) not in ids]


def _coverage_sort_key(rule: Mapping[str, object]) -> tuple[int, int, float, str]:
    kind_priority = {
        "field-contracts": 101,
        "evidence-cards": 100,
        "geo-research": 100,
        "eeat": 99,
        "cep": 98,
        "orchestration": 95,
        "schema": 90,
        "best-practice": 88,
        "locale": 82,
        "terminology": 80,
        "official-docs": 78,
    }
    return (
        -int(rule.get("severity") == "critical"),
        -kind_priority.get(str(rule.get("kind")), 0),
        -_number(rule.get("priority"), 0),
        f"{rule.get('document', '')}\0{rule.get('id', '')}",
    )


def _coverage(rules: list[dict[str, Any]], injected: list[dict[str, Any]], excluded: list[str]) -> dict[str, Any]:
    ids = {str(rule["id"]) for rule in injected}
    documents: dict[str, dict[str, Any]] = {}
    for rule in rules:
        entry = documents.setdefault(
            str(rule["document"]),
            {
                "document": rule["document"],
                "kind": rule["kind"],
                "totalRules": 0,
                "injectedRules": 0,
                "criticalRules": 0,
                "injectedCriticalRules": 0,
                "narrativeRules": 0,
            },
        )
        entry["totalRules"] += 1
        if rule["severity"] == "critical" and not _non_authoring(rule):
            entry["criticalRules"] += 1
        if rule["extraction"] == "narrative":
            entry["narrativeRules"] += 1
        if str(rule["id"]) in ids:
            entry["injectedRules"] += 1
            if rule["severity"] == "critical":
                entry["injectedCriticalRules"] += 1
    critical = sum(1 for rule in rules if rule["severity"] == "critical" and not _non_authoring(rule))
    injected_critical = sum(1 for rule in injected if rule["severity"] == "critical")
    return {
        "mode": "compiled-policy-checklist",
        "totalRules": len(rules),
        "injectedRules": len(injected),
        "criticalRules": critical,
        "injectedCriticalRules": injected_critical,
        "criticalCoverageRatio": 1 if critical == 0 else injected_critical / critical,
        "documents": list(documents.values()),
        "excludedRuleIds": excluded,
    }


def _section_for_stack(name: str, stack: Sequence[tuple[int, str]]) -> dict[str, Any] | None:
    for _, heading in reversed(stack):
        section = find_pdp_geo_rag_section_entry(name, heading)
        if section:
            return section
    return None


def _non_authoring(rule: Mapping[str, object]) -> bool:
    targets = _strings(rule.get("fieldTargets"))
    return bool(targets) and all(target in {"retrieval", "diagnostics"} for target in targets)


def _field_group(targets: Sequence[str]) -> str:
    public = [target for target in targets if target not in {"retrieval", "diagnostics"}]
    return "General / cross-field" if not public or len(public) > 2 else " & ".join(public)


def _format_rule(rule: Mapping[str, object]) -> str:
    severity = "brand-context" if rule.get("extraction") == "narrative" else str(rule.get("severity"))
    return f"[{rule.get('id')}][{severity}] {rule.get('text')} ({rule.get('document')} § {rule.get('heading')})"


def _clean_rule(raw: str, maximum: int) -> str:
    text = re.sub(
        r"\s+",
        " ",
        re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", re.sub(r"`([^`]+)`", r"\1", re.sub(r"\*+([^*]+)\*+", r"\1", raw))),
    ).strip()
    if len(text) <= maximum:
        return text
    truncated = text[:maximum]
    split = max(truncated.rfind(". "), truncated.rfind("; "))
    return (truncated[: split + 1] if split > maximum * 0.6 else truncated) + "…"


def _is_policy_document(name: str) -> bool:
    return bool(re.search(r"\.(?:md|markdown|txt)$", name, re.I)) or not bool(re.search(r"\.[a-z0-9]+$", name, re.I))


def _rule_prefix(name: str) -> str:
    return (
        re.sub(
            r"^-+|-+$",
            "",
            re.sub(
                r"[^A-Za-z0-9]+",
                "-",
                re.sub(r"_v\d+$", "", re.sub(r"\.[a-z0-9]+$", "", name, flags=re.I), flags=re.I),
            ),
        ).upper()[:32]
        or "POLICY"
    )


def _strings(value: object) -> list[str]:
    return [item for item in cast(list[object], value) if isinstance(item, str)] if isinstance(value, list) else []


def _integer(value: object | None, default: int) -> int:
    """Keep the JavaScript-port coercion while narrowing the JSON boundary."""
    return int(cast(int | float | str, value if value is not None else default))


def _number(value: object, default: int | float) -> float:
    """Preserve ``float(value or default)`` semantics for decoded settings."""
    return float(cast(int | float | str, value or default))


compilePdpGeoPolicyChecklist = compile_pdp_geo_policy_checklist
extractPolicyRules = extract_policy_rules
formatPolicyChecklistPayload = format_policy_checklist_payload
formatPolicyComplianceRecap = format_policy_compliance_recap
