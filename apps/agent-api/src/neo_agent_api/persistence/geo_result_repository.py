"""One-transaction success persistence with a guarded PROCESSING transition."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from neo_js_compat import js_json_dumps
from sqlalchemy import text

from .database import Database


def _json(value: object) -> str:
    # TypeORM's pg path serializes JSON columns with JSON.stringify.  Reuse the
    # same compatibility serializer so NaN/Infinity, -0, lone surrogates, and
    # numeric rendering arrive at PostgreSQL as valid JavaScript JSON bytes.
    return js_json_dumps(value)


# Public narrow seam for the JavaScript JSON persistence contract.
json_stringify = _json


class GeoResultRepository:
    def __init__(self, database: Database) -> None:
        self.database = database

    async def persist_success(self, geo_generation_id: str, artifact: Mapping[str, Any]) -> bool:
        transition = text(
            f"""
            UPDATE {self.database.schema}.geo_generation
            SET status = 'SUCCEEDED', claimed_at = NULL, claimed_by = NULL,
                version = version + 1, updated_at = now()
            WHERE geo_generation_id = :id AND status = 'PROCESSING'
            """
        )
        insert = text(
            f"""
            INSERT INTO {self.database.schema}.geo_result
              (geo_generation_id, result_status, json_ld, script_tag, schema_types,
               result_hash, rag_profile, diagnostics, generated_at)
            VALUES
              (:id, :result_status, CAST(:json_ld AS jsonb), :script_tag, CAST(:schema_types AS jsonb),
               :result_hash, :rag_profile, CAST(:diagnostics AS jsonb), CAST(:generated_at AS timestamptz))
            """
        )
        async with self.database.engine.begin() as connection:
            result = await connection.execute(transition, {"id": geo_generation_id})
            if result.rowcount != 1:
                return False
            await connection.execute(
                insert,
                {
                    "id": geo_generation_id,
                    "result_status": artifact["resultStatus"],
                    "json_ld": _json(artifact.get("jsonLd")),
                    "script_tag": artifact.get("scriptTag"),
                    "schema_types": _json(artifact.get("schemaTypes")),
                    "result_hash": artifact.get("resultHash"),
                    "rag_profile": artifact.get("ragProfile"),
                    "diagnostics": _json(artifact.get("diagnostics")),
                    "generated_at": artifact["generatedAt"],
                },
            )
        return True
