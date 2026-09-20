"""PDP GEO generator public Python surface.

This module exposes Python-native equivalents instead of importing or
subprocessing a Node runtime, so deployed wheels have no Node dependency.
"""

from .content_planning import (
    ModelBackedContentPlanner,
    create_pdp_geo_evidence_ledger,
    createPdpGeoEvidenceLedger,
    pdp_geo_content_plan_json_schema,
    pdpGeoContentPlanJsonSchema,
    plan_pdp_geo_content,
    planPdpGeoContent,
)
from .copy_refiner import ModelBackedCopyRefiner, refine_pdp_geo_copy, refinePdpGeoCopy
from .final_proofreader import (
    ModelBackedFinalProofreader,
    create_pdp_geo_public_copy_provenance,
    createPdpGeoPublicCopyProvenance,
    final_proofread_pdp_geo_artifacts,
    finalProofreadPdpGeoArtifacts,
    pdp_geo_final_proofreading_json_schema,
    pdpGeoFinalProofreadingJsonSchema,
)
from .normalization import (
    infer_pdp_evidence_roles,
    inferPdpEvidenceRoles,
    sanitize_pdp_semantic_facts,
    sanitizePdpSemanticFacts,
)
from .product_normalizer import (
    ModelBackedProductNormalizer,
    normalize_pdp_product_with_agent,
    normalizePdpProductWithAgent,
)
from .rag.embedding_snapshot import (
    create_embedding_snapshot_key,
    create_empty_pdp_geo_embedding_snapshot,
    create_snapshot_backed_embedder,
    createEmptyPdpGeoEmbeddingSnapshot,
    createPdpGeoEmbeddingSnapshotKey,
    createSnapshotBackedPdpGeoEmbedder,
    load_embedding_snapshot,
    loadPdpGeoEmbeddingSnapshot,
    save_embedding_snapshot,
    savePdpGeoEmbeddingSnapshot,
)
from .rag.index import PDP_GEO_RAG_INDEX, pdpGeoRagIndex
from .rag.index_skeleton import (
    create_pdp_geo_rag_index_skeleton,
    createPdpGeoRagIndexSkeleton,
    render_pdp_geo_rag_index_skeleton,
    renderPdpGeoRagIndexSkeleton,
)
from .rag.manifest import PDP_GEO_GENERATOR_RAG_MANIFEST, pdpGeoGeneratorRagManifest
from .rag.policy import (
    compile_pdp_geo_policy_checklist,
    compilePdpGeoPolicyChecklist,
    format_policy_checklist_payload,
    format_policy_compliance_recap,
    formatPolicyChecklistPayload,
    formatPolicyComplianceRecap,
)
from .rag.profile_store import (
    read_pdp_geo_generator_rag_profile,
    readPdpGeoGeneratorRagProfile,
    reset_pdp_geo_generator_rag_profile,
    resetPdpGeoGeneratorRagProfile,
    write_pdp_geo_generator_rag_profile,
    writePdpGeoGeneratorRagProfile,
)
from .rag.reasoning import create_pdp_geo_reasoning, createPdpGeoReasoning
from .rest import create_pdp_geo_generator_rest_handler, createPdpGeoGeneratorRestHandler
from .service import generate_pdp_geo, generatePdpGeo
from .validation import (
    apply_safe_public_copy_repairs,
    applySafePublicCopyRepairs,
    validate_and_repair_pdp_geo_artifacts,
    validate_pdp_geo_artifacts,
    validateAndRepairPdpGeoArtifacts,
    validatePdpGeoArtifacts,
)

# The Python surface offers snake_case APIs and direct-port camelCase aliases,
# so callers do not need a submodule import for package-index compatibility.
__all__ = [
    "ModelBackedContentPlanner",
    "ModelBackedCopyRefiner",
    "ModelBackedFinalProofreader",
    "ModelBackedProductNormalizer",
    "PDP_GEO_GENERATOR_RAG_MANIFEST",
    "PDP_GEO_RAG_INDEX",
    "apply_safe_public_copy_repairs",
    "applySafePublicCopyRepairs",
    "compile_pdp_geo_policy_checklist",
    "compilePdpGeoPolicyChecklist",
    "create_empty_pdp_geo_embedding_snapshot",
    "createEmptyPdpGeoEmbeddingSnapshot",
    "create_embedding_snapshot_key",
    "createPdpGeoEmbeddingSnapshotKey",
    "create_pdp_geo_evidence_ledger",
    "createPdpGeoEvidenceLedger",
    "create_pdp_geo_generator_rest_handler",
    "createPdpGeoGeneratorRestHandler",
    "create_pdp_geo_public_copy_provenance",
    "createPdpGeoPublicCopyProvenance",
    "create_pdp_geo_rag_index_skeleton",
    "createPdpGeoRagIndexSkeleton",
    "create_pdp_geo_reasoning",
    "createPdpGeoReasoning",
    "create_snapshot_backed_embedder",
    "createSnapshotBackedPdpGeoEmbedder",
    "final_proofread_pdp_geo_artifacts",
    "finalProofreadPdpGeoArtifacts",
    "format_policy_checklist_payload",
    "formatPolicyChecklistPayload",
    "format_policy_compliance_recap",
    "formatPolicyComplianceRecap",
    "generate_pdp_geo",
    "generatePdpGeo",
    "infer_pdp_evidence_roles",
    "inferPdpEvidenceRoles",
    "load_embedding_snapshot",
    "loadPdpGeoEmbeddingSnapshot",
    "normalize_pdp_product_with_agent",
    "normalizePdpProductWithAgent",
    "pdp_geo_final_proofreading_json_schema",
    "pdp_geo_content_plan_json_schema",
    "pdpGeoContentPlanJsonSchema",
    "pdpGeoFinalProofreadingJsonSchema",
    "pdpGeoGeneratorRagManifest",
    "pdpGeoRagIndex",
    "plan_pdp_geo_content",
    "planPdpGeoContent",
    "read_pdp_geo_generator_rag_profile",
    "readPdpGeoGeneratorRagProfile",
    "refine_pdp_geo_copy",
    "refinePdpGeoCopy",
    "render_pdp_geo_rag_index_skeleton",
    "renderPdpGeoRagIndexSkeleton",
    "reset_pdp_geo_generator_rag_profile",
    "resetPdpGeoGeneratorRagProfile",
    "sanitize_pdp_semantic_facts",
    "sanitizePdpSemanticFacts",
    "save_embedding_snapshot",
    "savePdpGeoEmbeddingSnapshot",
    "validate_and_repair_pdp_geo_artifacts",
    "validate_pdp_geo_artifacts",
    "validateAndRepairPdpGeoArtifacts",
    "validatePdpGeoArtifacts",
    "write_pdp_geo_generator_rag_profile",
    "writePdpGeoGeneratorRagProfile",
]
