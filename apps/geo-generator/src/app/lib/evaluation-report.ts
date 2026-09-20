import type { GeoQualityEvaluation } from "./python-agent-dtos";
import type { EvalUiLanguage } from "./evaluation-suite";
import { getGeoQualityCopy } from "./evaluation-copy";

export function formatGeoQualityEvaluationText(
  productName: string,
  evaluation: GeoQualityEvaluation,
  language: EvalUiLanguage
): string {
  const copy = getGeoQualityCopy(language);
  const lines = [
    copy.title,
    `${copy.productLabel}: ${productName}`,
    `${copy.overallScoreLabel}: ${evaluation.overallScore}/100`,
    ""
  ];

  for (const dimension of evaluation.dimensions) {
    lines.push(`${dimension.label}: ${dimension.score}/100`);
    lines.push(`${copy.criteriaLabel}: ${dimension.criteria}`);
    lines.push(`${copy.summaryLabel}: ${dimension.summary}`);
    lines.push(`${copy.evidenceLabel}:`);
    lines.push(...dimension.evidence.map((item) => `- ${item}`));
    lines.push(`${copy.improvementLabel}:`);
    lines.push(...dimension.improvements.map((item) => `- ${item}`));
    lines.push("");
  }

  if (evaluation.validationDetails.length > 0 || evaluation.validationImprovements.length > 0) {
    lines.push(copy.validationDetailLabel);
    if (evaluation.validationDetails.length > 0) {
      lines.push(`${copy.validationIssueLabel}:`);
      lines.push(...evaluation.validationDetails.map((item) => `- ${item}`));
    }
    if (evaluation.validationImprovements.length > 0) {
      lines.push(`${copy.validationDirectionLabel}:`);
      lines.push(...evaluation.validationImprovements.map((item) => `- ${item}`));
    }
  }

  return lines.join("\n").trim();
}
