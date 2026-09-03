/** @fileoverview 여러 모델 호출의 토큰 사용량을 합치는 단일 정본. */
import type { PdpGeoTokenUsage } from "./types";

/**
 * Adds two usage records, treating a missing field as "not reported" rather
 * than as zero: if neither side reports a field, the result does not report it
 * either. Reporting 0 where a provider said nothing would look like a measured
 * zero, and these numbers are read as cost.
 */
export function mergeTokenUsage(
  left: PdpGeoTokenUsage | undefined,
  right: PdpGeoTokenUsage | undefined
): PdpGeoTokenUsage | undefined {
  if (!left) return right;
  if (!right) return left;
  return {
    inputTokens: sumReportedTokens(left.inputTokens, right.inputTokens),
    outputTokens: sumReportedTokens(left.outputTokens, right.outputTokens),
    totalTokens: sumReportedTokens(left.totalTokens, right.totalTokens)
  };
}

/** Folds any number of usage records with the same "missing is not zero" rule. */
export function mergeTokenUsages(usages: PdpGeoTokenUsage[]): PdpGeoTokenUsage | undefined {
  return usages.reduce<PdpGeoTokenUsage | undefined>(
    (total, usage) => mergeTokenUsage(total, usage),
    undefined
  );
}

function sumReportedTokens(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined && right === undefined) return undefined;
  return (left ?? 0) + (right ?? 0);
}
