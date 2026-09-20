"""Python compatibility surface for the Agentic GEO PDP extractor."""

from .mock import (
    create_mock_product_extraction,
    mock_image_ocr,
    mock_keyword_classification,
    run_mock_product_extraction,
)
from .models import (
    AzureRoleDeployments,
    EmbeddingRuntimeConfig,
    ImageTextExtractionRequest,
    KeywordClassificationRequest,
    LlmProviderConfig,
    ProductExtractionInput,
    ProductExtractionRun,
    ProductExtractorRagDocument,
    ProductExtractorRagProfile,
    RerankerRuntimeConfig,
    StoredProductExtractorRagDocument,
    StoredProductExtractorRagProfile,
)
from .normalizer import (
    ModelBackedProductProfileNormalizer,
    create_product_profile_normalization_prompt,
    normalize_extractor_product_profile_with_agent,
)
from .ocr.evidence import extract_image_ocr_evidence
from .providers import create_keyword_classifier
from .rag.default_profile import (
    DEFAULT_PRODUCT_EXTRACTOR_ANALYSIS_PROMPT,
    default_product_extractor_rag_profile,
    defaultProductExtractorAnalysisPrompt,
    defaultProductExtractorRagProfile,
)
from .rag.index import (
    find_product_extractor_rag_index_entry,
    find_product_extractor_rag_section_entry,
    findProductExtractorRagIndexEntry,
    findProductExtractorRagSectionEntry,
    product_extractor_rag_index,
    productExtractorRagIndex,
)
from .rag.manifest import PRODUCT_EXTRACTOR_RAG_MANIFEST, product_extractor_rag_manifest
from .rag.profile_store import (
    read_product_extractor_rag_profile,
    reset_product_extractor_rag_profile,
    write_product_extractor_rag_profile,
)
from .rag.retrieval import (
    create_product_extractor_rag_query,
    retrieve_product_extractor_rag_documents,
    retrieve_product_extractor_rag_documents_with_runtime,
    retrieveProductExtractorRagDocuments,
)
from .refinement import refine_geo_product_result
from .rest import (
    ProductExtractorRestHandler,
    ProductExtractorRestResponse,
    create_product_extractor_rest_handler,
    extract_batch,
)
from .schemas import (
    CHAT_COMPLETIONS_IMAGE_OCR_RESPONSE_FORMAT,
    CHAT_COMPLETIONS_KEYWORD_CLASSIFICATION_RESPONSE_FORMAT,
    GEMINI_IMAGE_OCR_RESPONSE_SCHEMA,
    GEMINI_KEYWORD_CLASSIFICATION_RESPONSE_SCHEMA,
    IMAGE_OCR_JSON_SCHEMA,
    KEYWORD_CLASSIFICATION_JSON_SCHEMA,
    OPENAI_IMAGE_OCR_TEXT_FORMAT,
    OPENAI_KEYWORD_CLASSIFICATION_TEXT_FORMAT,
    chatCompletionsImageOcrResponseFormat,
    chatCompletionsKeywordClassificationResponseFormat,
    geminiImageOcrResponseSchema,
    geminiKeywordClassificationResponseSchema,
    imageOcrJsonSchema,
    keywordClassificationJsonSchema,
    openAiImageOcrTextFormat,
    openAiKeywordClassificationTextFormat,
)
from .service import extract_product, extract_product_from_api_payload, extract_product_from_html

# TS-spelling aliases reduce migration churn for consumers shared by Tasks 5/6.
extractProduct = extract_product
extractProductFromHtml = extract_product_from_html
extractProductFromApiPayload = extract_product_from_api_payload
extractImageOcrEvidence = extract_image_ocr_evidence
refineGeoProductResult = refine_geo_product_result
createMockProductExtraction = create_mock_product_extraction
runMockProductExtraction = run_mock_product_extraction
createProductExtractorRagQuery = create_product_extractor_rag_query
createProductExtractorRestHandler = create_product_extractor_rest_handler
normalizeExtractorProductProfileWithAgent = normalize_extractor_product_profile_with_agent
createProductProfileNormalizationPrompt = create_product_profile_normalization_prompt
createKeywordClassifier = create_keyword_classifier
readProductExtractorRagProfile = read_product_extractor_rag_profile
writeProductExtractorRagProfile = write_product_extractor_rag_profile
resetProductExtractorRagProfile = reset_product_extractor_rag_profile
productExtractorRagManifest = PRODUCT_EXTRACTOR_RAG_MANIFEST

__all__ = [
    "GEMINI_IMAGE_OCR_RESPONSE_SCHEMA",
    "GEMINI_KEYWORD_CLASSIFICATION_RESPONSE_SCHEMA",
    "CHAT_COMPLETIONS_IMAGE_OCR_RESPONSE_FORMAT",
    "CHAT_COMPLETIONS_KEYWORD_CLASSIFICATION_RESPONSE_FORMAT",
    "DEFAULT_PRODUCT_EXTRACTOR_ANALYSIS_PROMPT",
    "IMAGE_OCR_JSON_SCHEMA",
    "KEYWORD_CLASSIFICATION_JSON_SCHEMA",
    "OPENAI_IMAGE_OCR_TEXT_FORMAT",
    "OPENAI_KEYWORD_CLASSIFICATION_TEXT_FORMAT",
    "chatCompletionsImageOcrResponseFormat",
    "chatCompletionsKeywordClassificationResponseFormat",
    "geminiImageOcrResponseSchema",
    "geminiKeywordClassificationResponseSchema",
    "imageOcrJsonSchema",
    "keywordClassificationJsonSchema",
    "openAiImageOcrTextFormat",
    "openAiKeywordClassificationTextFormat",
    "AzureRoleDeployments",
    "EmbeddingRuntimeConfig",
    "ImageTextExtractionRequest",
    "KeywordClassificationRequest",
    "LlmProviderConfig",
    "ModelBackedProductProfileNormalizer",
    "PRODUCT_EXTRACTOR_RAG_MANIFEST",
    "ProductExtractionInput",
    "ProductExtractionRun",
    "ProductExtractorRagDocument",
    "ProductExtractorRagProfile",
    "RerankerRuntimeConfig",
    "ProductExtractorRestHandler",
    "ProductExtractorRestResponse",
    "StoredProductExtractorRagDocument",
    "StoredProductExtractorRagProfile",
    "create_mock_product_extraction",
    "run_mock_product_extraction",
    "create_keyword_classifier",
    "create_product_extractor_rag_query",
    "create_product_extractor_rest_handler",
    "create_product_profile_normalization_prompt",
    "default_product_extractor_rag_profile",
    "defaultProductExtractorAnalysisPrompt",
    "defaultProductExtractorRagProfile",
    "extract_batch",
    "extract_image_ocr_evidence",
    "extract_product",
    "extract_product_from_api_payload",
    "extract_product_from_html",
    "find_product_extractor_rag_index_entry",
    "find_product_extractor_rag_section_entry",
    "findProductExtractorRagIndexEntry",
    "findProductExtractorRagSectionEntry",
    "mock_image_ocr",
    "mock_keyword_classification",
    "normalize_extractor_product_profile_with_agent",
    "product_extractor_rag_index",
    "product_extractor_rag_manifest",
    "productExtractorRagIndex",
    "productExtractorRagManifest",
    "refine_geo_product_result",
    "retrieve_product_extractor_rag_documents",
    "retrieve_product_extractor_rag_documents_with_runtime",
    "read_product_extractor_rag_profile",
    "reset_product_extractor_rag_profile",
    "write_product_extractor_rag_profile",
    "createKeywordClassifier",
    "createMockProductExtraction",
    "runMockProductExtraction",
    "createProductExtractorRagQuery",
    "createProductExtractorRestHandler",
    "createProductProfileNormalizationPrompt",
    "extractImageOcrEvidence",
    "extractProduct",
    "extractProductFromApiPayload",
    "extractProductFromHtml",
    "normalizeExtractorProductProfileWithAgent",
    "readProductExtractorRagProfile",
    "refineGeoProductResult",
    "resetProductExtractorRagProfile",
    "retrieveProductExtractorRagDocuments",
    "writeProductExtractorRagProfile",
]
