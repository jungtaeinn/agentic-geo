"""Versioned local RAG corpus and retrieval utilities for PDP GEO."""

from .embedding_snapshot import (
    create_embedding_snapshot_key,
    create_empty_pdp_geo_embedding_snapshot,
    create_snapshot_backed_embedder,
    load_embedding_snapshot,
    save_embedding_snapshot,
)
from .manifest import PDP_GEO_GENERATOR_RAG_MANIFEST
from .profile_store import (
    read_pdp_geo_generator_rag_profile,
    reset_pdp_geo_generator_rag_profile,
    write_pdp_geo_generator_rag_profile,
)

__all__ = [
    "create_embedding_snapshot_key",
    "create_empty_pdp_geo_embedding_snapshot",
    "create_snapshot_backed_embedder",
    "load_embedding_snapshot",
    "save_embedding_snapshot",
    "PDP_GEO_GENERATOR_RAG_MANIFEST",
    "read_pdp_geo_generator_rag_profile",
    "reset_pdp_geo_generator_rag_profile",
    "write_pdp_geo_generator_rag_profile",
]
