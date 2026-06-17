import { pdpGeoGeneratorRagManifest } from "./manifest";

/** A document that can be attached to the PDP GEO generator RAG profile. */
export interface PdpGeoGeneratorRagDocument {
  name: string;
  version: string;
  content: string;
}

/** Default prompt and reference documents shared by the UI, REST adapter, and RAG retrievers. */
export interface PdpGeoGeneratorRagProfile {
  profile: string;
  analysisPrompt: string;
  documents: PdpGeoGeneratorRagDocument[];
}

export const defaultPdpGeoGeneratorAnalysisPrompt = [
  "Generate GEO-optimized PDP artifacts from arbitrary product JSON.",
  "Return two user-facing artifacts: schema markup as JSON-LD and grouped HTML content for PDP sections.",
  "Normalize source product JSON into product signals before generation; do not require a fixed extractor schema.",
  "Rewrite product name, description, quick facts, benefits, ingredients, usage, and FAQ for citation-friendly generative engines.",
  "Description structure: target customer + core benefit/effect + ingredient/technology + use context + repeated positive review keywords + evidence signal.",
  "Use only source product data and selected RAG guidance. Do not invent clinical, medical, or regulatory claims.",
  "Use official AI/search platform docs RAG to choose retrieval, embedding, grounding, structured data, and citation constraints.",
  "Apply locale and market terminology rules before finalizing text.",
  "Validate JSON-LD syntax, schema.org type/property usage, and safe HTML before returning artifacts."
].join("\n");

export const defaultPdpGeoGeneratorRagProfile: PdpGeoGeneratorRagProfile = {
  profile: pdpGeoGeneratorRagManifest.profile,
  analysisPrompt: defaultPdpGeoGeneratorAnalysisPrompt,
  documents: [
    {
      name: pdpGeoGeneratorRagManifest.documents.schemaOrgProduct,
      version: "v1",
      content: [
        "# Schema.org Product Markup v1",
        "",
        "Use schema.org JSON-LD to help machines identify PDP entities and cite grounded facts.",
        "",
        "- Official sources checked on 2026-06-17: https://schema.org/Product, https://schema.org/FAQPage, https://schema.org/HowTo, https://schema.org/BreadcrumbList, https://schema.org/WebPage.",
        "- Treat schema.org as the canonical source for type/property compatibility. This local document is a versioned operating guide, not a frozen replacement for the official docs.",
        "- Generate an `@graph` with `WebPage`, `Product`, `FAQPage`, `HowTo`, and `BreadcrumbList` when source data supports them.",
        "- `Product.name` should use the GEO-recommended product name, not an overstuffed keyword phrase.",
        "- `Product.description` should be concise, factual, and aligned with visible PDP content.",
        "- Use `additionalProperty` for objective product characteristics such as key ingredients, skin type, size, texture, usage timing, target concern, and technology.",
        "- Use `positiveNotes` for product highlights, benefit statements, and review-backed positive points.",
        "- Use `FAQPage.mainEntity` only when both question and answer are available.",
        "- Use `HowTo.step` for explicit ordered usage instructions. If usage is short and unordered, keep it in `additionalProperty` and HTML content too.",
        "- Use `BreadcrumbList` when URL, brand, category, or product hierarchy exists.",
        "- Keep JSON-LD aligned with content visible in the generated HTML. Do not mark up hidden, irrelevant, or misleading facts.",
        "- Avoid fake reviews, unsupported ratings, and medical treatment language."
      ].join("\n")
    },
    {
      name: pdpGeoGeneratorRagManifest.documents.eeat,
      version: "v1",
      content: [
        "# E-E-A-T Guidance v1",
        "",
        "Use E-E-A-T as a content quality lens for generated PDP copy.",
        "",
        "- Official sources checked on 2026-06-17: Google Search Central helpful content guidance and structured data guidance.",
        "- Experience: preserve real customer review signals and product usage context when present.",
        "- Expertise: state ingredients, product technology, and usage directions with precise wording.",
        "- Authoritativeness: prefer brand-owned product facts and schema.org-compatible structure.",
        "- Trustworthiness: avoid unsupported claims, especially medical, permanent, guaranteed, or exaggerated outcomes.",
        "- Separate source facts from recommendations in diagnostics.",
        "- Make generated content helpful for humans first while giving generative engines stable, quotable facts."
      ].join("\n")
    },
    {
      name: pdpGeoGeneratorRagManifest.documents.cep,
      version: "v1",
      content: [
        "# Category Entry Point Guidance v1",
        "",
        "CEP terms describe buying or discovery situations where a customer may remember or search for a product.",
        "",
        "- This is a project-local operating definition. Keep brand/category-specific CEP examples in BestPractice or custom RAG files when the marketing team has a stricter definition.",
        "- Convert product signals into natural category-entry phrasing such as target concern, routine timing, use occasion, ingredient need, or review-backed preference.",
        "- Do not force unrelated category terms into the product name.",
        "- Use CEP in description, quick facts, FAQ questions, and benefits when it is supported by product data.",
        "- For cosmetics and skincare, common CEP examples include dry skin, skin barrier care, sensitive skin routine, firming care, brightening care, morning routine, night routine, lightweight texture, rich cream, serum step, and key ingredient discovery.",
        "- Localize CEP wording with the locale terminology map."
      ].join("\n")
    },
    {
      name: pdpGeoGeneratorRagManifest.documents.bestPractice,
      version: "v1",
      content: [
        "# Best Practice v1",
        "",
        "Add brand, category, market, or internal GEO best practices here.",
        "",
        "- This file is intentionally ready for user-maintained guidance.",
        "- The generator should retrieve this document when present and treat it as project-local policy.",
        "- Keep examples short and evidence-based."
      ].join("\n")
    },
    {
      name: pdpGeoGeneratorRagManifest.documents.geoPaper,
      version: "v1",
      content: [
        "# GEO Paper Guidance v1",
        "",
        "Generative Engine Optimization focuses on improving visibility and citation in generative search answers.",
        "",
        "- Source checked on 2026-06-17: https://generative-engines.com/GEO/.",
        "- Prefer content that is easy to synthesize into answers: clear definitions, entity names, factual attributes, concise claims, and evidence-backed phrases.",
        "- Domain-specific optimization matters; PDP copy should prioritize product, category, ingredient, usage, review, and FAQ signals.",
        "- Minor content changes can improve visibility when they clarify facts and source attribution.",
        "- Avoid generic keyword stuffing. Use structured, human-readable sections and schema markup that reflect visible content.",
        "- Evaluate generated artifacts by citation readiness, not only classic SEO rank signals."
      ].join("\n")
    },
    {
      name: pdpGeoGeneratorRagManifest.documents.officialAiSearchPlatformDocs,
      version: "v1",
      content: [
        "# Official AI and Search Platform Docs v1",
        "",
        "Use this document as a versioned connector map to official provider docs for retrieval, embeddings, grounding, structured data eligibility, and citation diagnostics.",
        "",
        "- Official sources checked on 2026-06-17: OpenAI retrieval, OpenAI file search, OpenAI embeddings, Google Search Central Product structured data, Gemini embeddings, Gemini grounding with Google Search, and Perplexity Search API docs.",
        "- Prefer official provider docs over blog posts or third-party summaries when deciding adapter behavior or generation constraints.",
        "- Keep generated PDP claims grounded in product/source facts. Provider docs can guide retrieval and citation strategy, but they must not create new product benefits.",
        "",
        "## OpenAI Retrieval and Embeddings",
        "",
        "- Official links: https://developers.openai.com/api/docs/guides/retrieval, https://developers.openai.com/api/docs/guides/tools-file-search, https://platform.openai.com/docs/guides/embeddings.",
        "- Use OpenAI managed vector stores when the deployment wants provider-managed file ingestion, chunk indexing, retrieval, and query rewriting.",
        "- Use local-versioned RAG when the deployment needs provider-neutral operation, editable local policy files, or the option to swap OpenAI for another embedding/search stack.",
        "- Embeddings represent semantic relatedness and are appropriate for retrieval over official docs, product facts, reviews, locale terminology, and best-practice files.",
        "- When OpenAI vector store mode is selected, make sure these managed RAG documents are also uploaded or synchronized to the vector store used by the app.",
        "",
        "## Google Search Central Structured Data",
        "",
        "- Official link: https://developers.google.com/search/docs/appearance/structured-data/product.",
        "- Use Google Product structured data guidance as an eligibility and quality layer on top of schema.org compatibility.",
        "- Product snippets and merchant listing experiences can require different property depth; add supported properties only when source data is available.",
        "- Variant, offer, review, rating, and organization policy markup should be generated only when the input contains reliable evidence.",
        "",
        "## Gemini Embeddings and Grounding",
        "",
        "- Official links: https://ai.google.dev/gemini-api/docs/embeddings, https://ai.google.dev/gemini-api/docs/google-search.",
        "- Gemini embeddings can be used as a managed or custom embedding adapter for provider-neutral RAG implementations.",
        "- Embedding model upgrades can create incompatible embedding spaces, so re-embed stored documents when moving between incompatible Gemini embedding versions.",
        "- For live grounding, current Gemini docs use Google Search grounding with the `google_search` tool for supported models.",
        "",
        "## Perplexity Search API",
        "",
        "- Official link: https://docs.perplexity.ai/docs/search/quickstart.",
        "- Use Perplexity Search API as a search/grounding source when the app needs real-time ranked web results with domain, language, or region filters.",
        "- Prefer Search API for raw ranked result evidence and Sonar-style answer APIs only when the product explicitly needs generated prose with citations.",
        "- Store retrieved URLs, snippets, checked dates, and provider names in diagnostics so GEO recommendations remain auditable."
      ].join("\n")
    },
    {
      name: pdpGeoGeneratorRagManifest.documents.localeExpressionGuidelines,
      version: "v1",
      content: [
        "# Locale Expression Guidelines v1",
        "",
        "Use locale and market rules to choose natural PDP wording.",
        "",
        "- `ko-KR`: Prefer concise PDP commerce language. Use 보습, 수분감, 탄력, 피부 장벽, 피부결, 사용감, 흡수감 when supported. Avoid 치료, 완치, 의학적 효능 unless explicitly regulated evidence is present.",
        "- `ja-JP`: Prefer softer, benefit-oriented wording. Use 保湿, うるおい, ハリ, キメ, 肌なじみ, 敏感肌にも使いやすい when supported. Avoid 治療, 完治, 医薬品-like claims unless source data permits.",
        "- `en-US`: Prefer clear benefit wording. Use hydration, moisture, firming, skin barrier, even-looking tone, lightweight feel, rich texture when supported. Avoid cure, treat disease, guaranteed results, and overclaiming.",
        "- `en-GB`: Prefer moisturising, skin barrier support, even-looking tone, and routine-friendly phrasing when supported.",
        "- Keep product names readable. Do not overload names with every benefit keyword.",
        "- Keep FAQ questions in the customer's likely search language for the target locale."
      ].join("\n")
    },
    {
      name: pdpGeoGeneratorRagManifest.documents.localeTerminologyMap,
      version: "v1",
      content: JSON.stringify({
        concepts: [
          {
            concept: "hydration",
            category: "benefit",
            preferred: {
              "ko-KR": ["보습", "수분감"],
              "ja-JP": ["保湿", "うるおい"],
              "en-US": ["hydration", "moisture"],
              "en-GB": ["hydration", "moisturising"]
            },
            avoid: {
              "ko-KR": ["치료"],
              "ja-JP": ["治療"],
              "en-US": ["cure"],
              "en-GB": ["cure"]
            },
            notes: "Use cosmetic benefit wording, not medical treatment wording."
          },
          {
            concept: "brightening",
            category: "benefit",
            preferred: {
              "ko-KR": ["화사함", "맑은 피부톤"],
              "ja-JP": ["明るい印象", "透明感"],
              "en-US": ["brightening", "even-looking tone"],
              "en-GB": ["brightening", "even-looking tone"]
            },
            avoid: {
              "ko-KR": ["미백 치료"],
              "ja-JP": ["漂白"],
              "en-US": ["whitening"],
              "en-GB": ["whitening"]
            },
            notes: "Prefer appearance-oriented tone wording in global English."
          },
          {
            concept: "firming",
            category: "benefit",
            preferred: {
              "ko-KR": ["탄력", "탄탄한 피부"],
              "ja-JP": ["ハリ", "弾力感"],
              "en-US": ["firming", "elasticity"],
              "en-GB": ["firming", "elasticity"]
            },
            avoid: {
              "ko-KR": ["리프팅 수술 효과"],
              "ja-JP": ["手術級"],
              "en-US": ["surgical lift"],
              "en-GB": ["surgical lift"]
            },
            notes: "Keep firming claims cosmetic and evidence-backed."
          },
          {
            concept: "skin-barrier",
            category: "benefit",
            preferred: {
              "ko-KR": ["피부 장벽", "장벽 케어"],
              "ja-JP": ["バリア機能", "肌のバリア"],
              "en-US": ["skin barrier", "barrier support"],
              "en-GB": ["skin barrier", "barrier support"]
            },
            avoid: {
              "ko-KR": ["질환 개선"],
              "ja-JP": ["疾患改善"],
              "en-US": ["eczema treatment"],
              "en-GB": ["eczema treatment"]
            },
            notes: "Do not imply disease treatment."
          }
        ]
      }, null, 2)
    }
  ]
};
