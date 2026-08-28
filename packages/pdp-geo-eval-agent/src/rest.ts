import { evaluateGeoQuality, formatGeoQualityEvaluationText } from "./quality/evaluate";
import { formatQualityLlmPrompt } from "./prompts/improvement";
import type { EvalContentSections, EvalDiagnosticsInput, EvalUiLanguage } from "./types";

/**
 * Web-API REST handler for standalone quality evaluation.
 *
 * POST body:
 * {
 *   "jsonLd": { ... },                  // required: schema.org graph to score
 *   "diagnostics": { ... },             // optional: generator diagnostics subset
 *   "contentSections": { ... },         // optional: enables the LLM improvement prompt
 *   "productName": "...",               // optional: report/prompt labeling
 *   "language": "ko" | "en"             // optional, default "ko"
 * }
 *
 * Response: { evaluation, report, improvementPrompt? }
 *
 * Because inputs are structural, this endpoint can score ANY PDP markup —
 * generator output, hand-written JSON-LD, or a competitor page's graph. The
 * citation probe is intentionally NOT exposed here (it spends LLM tokens);
 * wire it explicitly in the app when needed.
 */

interface EvalRestRequestBody {
  jsonLd?: unknown;
  diagnostics?: Partial<EvalDiagnosticsInput>;
  contentSections?: Partial<EvalContentSections>;
  productName?: string;
  language?: EvalUiLanguage;
}

const EMPTY_SECTIONS: EvalContentSections = {
  productName: "",
  description: "",
  quickFacts: "",
  benefits: "",
  ingredients: "",
  howToUse: "",
  faq: ""
};

export function createPdpGeoEvalRestHandler(): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    let body: EvalRestRequestBody;
    try {
      body = await request.json() as EvalRestRequestBody;
    } catch {
      return jsonResponse({ error: "Request body must be valid JSON." }, 400);
    }

    if (body.jsonLd === undefined || body.jsonLd === null) {
      return jsonResponse({ error: "\"jsonLd\" is required: the schema.org graph to evaluate." }, 400);
    }

    const language: EvalUiLanguage = body.language === "en" ? "en" : "ko";
    const diagnostics: EvalDiagnosticsInput = {
      normalizedProduct: body.diagnostics?.normalizedProduct ?? {},
      validationWarnings: body.diagnostics?.validationWarnings ?? [],
      validationRepairs: body.diagnostics?.validationRepairs,
      ragUsage: body.diagnostics?.ragUsage,
      evidence: body.diagnostics?.evidence,
      evidenceLedger: body.diagnostics?.evidenceLedger,
      contentPlan: body.diagnostics?.contentPlan
    };

    try {
      const evaluation = evaluateGeoQuality({ jsonLd: body.jsonLd, diagnostics }, language);
      const productName = body.productName
        ?? diagnostics.normalizedProduct.name
        ?? body.contentSections?.productName
        ?? "";
      const report = formatGeoQualityEvaluationText(productName, evaluation, language);
      const improvementPrompt = body.contentSections
        ? formatQualityLlmPrompt(
          {
            productName,
            contentSections: { ...EMPTY_SECTIONS, ...body.contentSections },
            jsonLd: body.jsonLd
          },
          evaluation,
          language
        )
        : undefined;

      return jsonResponse({ evaluation, report, improvementPrompt });
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : "Evaluation failed." }, 500);
    }
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
