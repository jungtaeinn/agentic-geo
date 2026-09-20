"""The package root mirrors the retained TypeScript index exports."""

from __future__ import annotations

from importlib.resources import files

from test_frozen_legacy_contracts import load_frozen_public_surface_contract

import pdp_geo_generator_agent as generator


def test_root_exports_generation_rag_and_public_copy_contracts() -> None:
    for name in (
        "generate_pdp_geo",
        "generatePdpGeo",
        "refine_pdp_geo_copy",
        "refinePdpGeoCopy",
        "final_proofread_pdp_geo_artifacts",
        "finalProofreadPdpGeoArtifacts",
        "create_pdp_geo_public_copy_provenance",
        "createPdpGeoPublicCopyProvenance",
        "validate_pdp_geo_artifacts",
        "validatePdpGeoArtifacts",
        "apply_safe_public_copy_repairs",
        "applySafePublicCopyRepairs",
        "create_pdp_geo_evidence_ledger",
        "createPdpGeoEvidenceLedger",
        "plan_pdp_geo_content",
        "planPdpGeoContent",
        "normalize_pdp_product_with_agent",
        "normalizePdpProductWithAgent",
        "create_pdp_geo_generator_rest_handler",
        "createPdpGeoGeneratorRestHandler",
        "PDP_GEO_GENERATOR_RAG_MANIFEST",
        "PDP_GEO_RAG_INDEX",
        "create_pdp_geo_reasoning",
        "createPdpGeoReasoning",
    ):
        assert hasattr(generator, name), name


def test_root_reexports_every_runtime_value_from_the_retained_typescript_index() -> None:
    """Keep the direct-port root surface aligned with the frozen legacy root.

    Type-only TypeScript exports intentionally have no Python equivalent.  Every
    runtime value, however, must remain importable from the Python package root
    under its legacy camelCase name as well as any snake_case Python alias.
    """

    fixture = load_frozen_public_surface_contract()
    contract = fixture["contract"]
    legacy_runtime_exports = contract["runtimeExports"]
    for name in legacy_runtime_exports:
        assert hasattr(generator, name), name

    # ``__all__`` is the Python package's public boundary.  Its only additions
    # over the deleted TypeScript root are the documented Python-native aliases
    # in the externally pinned parity matrix; no incidental implementation
    # imports may leak into the root API.
    assert generator.__all__ == contract["pythonPublicExports"]
    assert set(generator.__all__) == set(legacy_runtime_exports) | {
        python_name for _, python_name in contract["identityAliases"]
    }
    for legacy_name, python_name in contract["identityAliases"]:
        assert getattr(generator, legacy_name) is getattr(generator, python_name), legacy_name
    for type_only_name in contract["legacyTypeOnlyRuntimeSentinels"]:
        assert not hasattr(generator, type_only_name), type_only_name

    schema = generator.pdpGeoContentPlanJsonSchema
    assert schema["type"] == "object"
    assert schema["additionalProperties"] is False
    assert schema["properties"]["locale"] == {"type": "string", "enum": ["ko-KR", "ja-JP", "en-US", "en-GB"]}
    assert schema["properties"]["howTo"]["properties"]["steps"]["items"]["required"] == [
        "position",
        "name",
        "text",
        "evidenceIds",
    ]


def test_package_declares_inline_type_information() -> None:
    """PEP 561 metadata must survive editable and wheel installs alike."""

    assert files(generator).joinpath("py.typed").is_file()
