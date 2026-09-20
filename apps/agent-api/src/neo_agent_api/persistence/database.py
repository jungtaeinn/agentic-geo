"""Async SQLAlchemy engine setup without taking ownership of migrations."""

from __future__ import annotations

import re
from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

_SCHEMA = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


@dataclass(frozen=True, slots=True)
class Database:
    engine: AsyncEngine
    schema: str

    async def ensure_ready(self) -> None:
        """Force the same startup connection check TypeORM performs."""

        async with self.engine.connect() as connection:
            await connection.execute(text("SELECT 1"))

    async def dispose(self) -> None:
        await self.engine.dispose()


def create_database(url: str, *, schema: str = "neo") -> Database:
    if not _SCHEMA.fullmatch(schema):
        raise ValueError("DB_SCHEMA must be a plain PostgreSQL identifier")
    normalized = url
    if normalized.startswith("postgresql://"):
        normalized = "postgresql+psycopg://" + normalized.removeprefix("postgresql://")
    return Database(create_async_engine(normalized, pool_pre_ping=True), schema)
