"""Guarded state transitions for rows owned by neo-api/Flyway."""

from __future__ import annotations

from sqlalchemy import text

from .database import Database


class GeoGenerationRepository:
    def __init__(self, database: Database) -> None:
        self.database = database

    async def find_status(self, geo_generation_id: str) -> str | None:
        statement = text(f"SELECT status FROM {self.database.schema}.geo_generation WHERE geo_generation_id = :id")
        async with self.database.engine.connect() as connection:
            value = (await connection.execute(statement, {"id": geo_generation_id})).scalar_one_or_none()
        return str(value) if value is not None else None

    async def transition_to_succeeded(self, geo_generation_id: str) -> bool:
        statement = text(
            f"""
            UPDATE {self.database.schema}.geo_generation
            SET status = 'SUCCEEDED', claimed_at = NULL, claimed_by = NULL,
                version = version + 1, updated_at = now()
            WHERE geo_generation_id = :id AND status = 'PROCESSING'
            """
        )
        async with self.database.engine.begin() as connection:
            result = await connection.execute(statement, {"id": geo_generation_id})
        return result.rowcount == 1

    async def transition_to_failed(self, geo_generation_id: str, code: str, detail: str) -> bool:
        statement = text(
            f"""
            UPDATE {self.database.schema}.geo_generation
            SET status = 'FAILED', error_phase = 'GENERATION', error_code = :code,
                error_detail = :detail, claimed_at = NULL, claimed_by = NULL,
                version = version + 1, updated_at = now()
            WHERE geo_generation_id = :id AND status = 'PROCESSING'
            """
        )
        async with self.database.engine.begin() as connection:
            result = await connection.execute(
                statement,
                {"id": geo_generation_id, "code": code, "detail": _utf16_prefix(detail, 2000)},
            )
        return result.rowcount == 1


def _utf16_prefix(value: str, units: int) -> str:
    encoded = value.encode("utf-16-le", errors="surrogatepass")[: units * 2]
    return encoded.decode("utf-16-le", errors="replace")


# Public narrow seam for the repository persistence contract.
utf16_prefix = _utf16_prefix
