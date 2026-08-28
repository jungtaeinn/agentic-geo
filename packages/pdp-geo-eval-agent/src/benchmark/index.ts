/**
 * Benchmark surface (Node-only: the runner uses node:fs for its answer cache).
 * Kept out of the package root so client bundles can import the root safely.
 */
export {
  aggregateGeoScores,
  buildSourceSet,
  runGeoBenchmark,
  type GeneratedProductArtifact,
  type GeoEvalAggregates,
  type GeoEvalGoldenResult,
  type GeoEvalRunOptions,
  type GeoEvalRunResult,
  type GeoEvalShareAggregate,
  type GeoEvalVariantScore
} from "./runner";
export { geoEvalGoldens, GEO_EVAL_TARGET_SLOT, type GeoCepFocus, type GeoEvalGolden } from "./goldens";
export { geoEvalDistractors } from "./distractors";
export { evalProducts, type EvalProductId } from "./fixtures";
