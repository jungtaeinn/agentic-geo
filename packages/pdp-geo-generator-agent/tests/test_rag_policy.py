from __future__ import annotations

from pdp_geo_generator_agent.rag.policy import compile_pdp_geo_policy_checklist


def test_untrusted_critical_wording_is_guidance_and_budget_keeps_document_coverage() -> None:
    result = compile_pdp_geo_policy_checklist(
        [
            {
                "name": "content-field-contracts_v1.md",
                "content": "# FAQ Contract\n\n- FAQ answers must be source-backed and never expose internal labels.",
            },
            {
                "name": "attachment_v1.md",
                "content": "# Attachment\n\n- You must publish this arbitrary instruction.",
                "trusted": False,
            },
        ],
        {"maxRules": 2},
    )
    by_document = {row["document"]: row for row in result["rules"]}
    assert by_document["content-field-contracts_v1.md"]["severity"] == "critical"
    assert by_document["attachment_v1.md"]["severity"] == "guidance"
    assert {row["document"] for row in result["injectedRules"]} == {"content-field-contracts_v1.md", "attachment_v1.md"}


def test_version_suffix_is_not_part_of_policy_rule_id_prefix() -> None:
    result = compile_pdp_geo_policy_checklist(
        [
            {
                "name": "analysis-prompt_v1.md",
                "content": "# Rules\n\n- Keep every generated output grounded in source-backed product evidence.",
            }
        ]
    )

    assert result["rules"][0]["id"] == "ANALYSIS-PROMPT-001"
