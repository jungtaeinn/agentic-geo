/** RAG profile used to keep document-level versions explicit and testable. */
export const productExtractorRagManifest = {
  profile: "product-extractor-default",
  analysisPrompt: "analysis-prompt_v1.md",
  documents: {
    productNormalization: "product-normalization_v1.md",
    reviewKeywordExtraction: "review-keyword-extraction_v1.md",
    ocrKeywordClassification: "ocr-keyword-classification_v1.md",
    faqExtraction: "faq-extraction_v1.md"
  }
} as const;
