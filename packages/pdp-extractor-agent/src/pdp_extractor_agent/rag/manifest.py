"""The immutable managed RAG asset names used on the wire."""

from typing import Final, TypedDict


class ProductExtractorRagDocuments(TypedDict):
    productNormalization: str
    reviewKeywordExtraction: str
    ocrKeywordClassification: str
    faqExtraction: str


class ProductExtractorRagManifest(TypedDict):
    profile: str
    analysisPrompt: str
    documents: ProductExtractorRagDocuments


PRODUCT_EXTRACTOR_RAG_MANIFEST: Final[ProductExtractorRagManifest] = {
    "profile": "pdp-extractor-default",
    "analysisPrompt": "analysis-prompt_v1.md",
    "documents": {
        "productNormalization": "product-normalization_v1.md",
        "reviewKeywordExtraction": "review-keyword-extraction_v1.md",
        "ocrKeywordClassification": "ocr-keyword-classification_v1.md",
        "faqExtraction": "faq-extraction_v1.md",
    },
}

# The lower-case spelling mirrors the TypeScript export for consumers that
# share configuration names across runtimes.
product_extractor_rag_manifest = PRODUCT_EXTRACTOR_RAG_MANIFEST
