"""First parity contracts for the Python GEO generator port.

These assertions intentionally precede the implementation.  They freeze two
small but high-risk JavaScript behaviours used throughout RAG and evidence
rendering: UTF-16 snapshot identity and metric-context eligibility.
"""

from pdp_geo_generator_agent.contracts.metric_statement import is_structured_atomic_metric_claim
from pdp_geo_generator_agent.rag.embedding_snapshot import create_embedding_snapshot_key


def test_snapshot_key_uses_js_utf16_behavior_for_astral_text() -> None:
    assert create_embedding_snapshot_key("😀") == "885930824:2"


def test_metric_claim_requires_value_and_context() -> None:
    assert not is_structured_atomic_metric_claim({"value": "+84.3", "metric": "ceramide"})
    assert is_structured_atomic_metric_claim({"value": "+84.3", "metric": "ceramide", "timing": "2 weeks"})
