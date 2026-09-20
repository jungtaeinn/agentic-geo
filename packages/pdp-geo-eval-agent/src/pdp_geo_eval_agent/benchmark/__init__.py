"""Frozen benchmark fixtures, source assembly, and aggregates."""

from ..citation.probe import GEO_EVAL_TARGET_SLOT
from ..types import (
    EvalProductId,
    GeneratedProductArtifact,
    GeoCepFocus,
    GeoEvalAggregates,
    GeoEvalGolden,
    GeoEvalGoldenResult,
    GeoEvalRunOptions,
    GeoEvalRunResult,
    GeoEvalShareAggregate,
    GeoEvalVariantScore,
)
from .distractors import geo_eval_distractors
from .fixtures import eval_products
from .goldens import geo_eval_goldens
from .runner import aggregate_geo_scores, build_source_set, run_geo_benchmark

__all__ = [
    "GEO_EVAL_TARGET_SLOT", "aggregate_geo_scores", "build_source_set", "eval_products",
    "geo_eval_distractors", "geo_eval_goldens",
    "run_geo_benchmark",
    "EvalProductId", "GeneratedProductArtifact", "GeoCepFocus", "GeoEvalAggregates",
    "GeoEvalGolden", "GeoEvalGoldenResult", "GeoEvalRunOptions", "GeoEvalRunResult",
    "GeoEvalShareAggregate", "GeoEvalVariantScore",
]
