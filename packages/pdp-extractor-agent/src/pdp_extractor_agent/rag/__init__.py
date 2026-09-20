"""Managed extractor RAG assets, profile storage, and retrieval."""

from .default_profile import (
    DEFAULT_PRODUCT_EXTRACTOR_ANALYSIS_PROMPT,
    default_product_extractor_rag_profile,
    default_profile,
    defaultProductExtractorAnalysisPrompt,
    defaultProductExtractorRagProfile,
    managed_assets,
)
from .index import (
    find_product_extractor_rag_index_entry,
    find_product_extractor_rag_section_entry,
    findProductExtractorRagIndexEntry,
    findProductExtractorRagSectionEntry,
    product_extractor_rag_index,
    productExtractorRagIndex,
)
from .manifest import PRODUCT_EXTRACTOR_RAG_MANIFEST, product_extractor_rag_manifest
from .profile_store import (
    read_product_extractor_rag_profile,
    read_profile,
    readProductExtractorRagProfile,
    reset_product_extractor_rag_profile,
    reset_profile,
    resetProductExtractorRagProfile,
    write_product_extractor_rag_profile,
    write_profile,
    writeProductExtractorRagProfile,
)
from .retrieval import (
    create_product_extractor_rag_query,
    retrieve_product_extractor_rag_documents,
    retrieve_product_extractor_rag_documents_with_runtime,
    retrieveProductExtractorRagDocuments,
)

productExtractorRagManifest = PRODUCT_EXTRACTOR_RAG_MANIFEST

__all__ = [
    "PRODUCT_EXTRACTOR_RAG_MANIFEST",
    "DEFAULT_PRODUCT_EXTRACTOR_ANALYSIS_PROMPT",
    "defaultProductExtractorAnalysisPrompt",
    "defaultProductExtractorRagProfile",
    "create_product_extractor_rag_query",
    "default_product_extractor_rag_profile",
    "default_profile",
    "find_product_extractor_rag_index_entry",
    "find_product_extractor_rag_section_entry",
    "findProductExtractorRagIndexEntry",
    "findProductExtractorRagSectionEntry",
    "managed_assets",
    "product_extractor_rag_index",
    "product_extractor_rag_manifest",
    "productExtractorRagIndex",
    "productExtractorRagManifest",
    "read_profile",
    "read_product_extractor_rag_profile",
    "readProductExtractorRagProfile",
    "reset_profile",
    "reset_product_extractor_rag_profile",
    "resetProductExtractorRagProfile",
    "retrieve_product_extractor_rag_documents",
    "retrieve_product_extractor_rag_documents_with_runtime",
    "retrieveProductExtractorRagDocuments",
    "write_profile",
    "write_product_extractor_rag_profile",
    "writeProductExtractorRagProfile",
]
