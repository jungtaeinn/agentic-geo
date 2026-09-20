from __future__ import annotations

import math
from collections.abc import Iterator
from pathlib import Path
from typing import LiteralString, cast

import psycopg
import pytest
from docker.errors import DockerException
from neo_agent_api.persistence.database import create_database
from neo_agent_api.persistence.geo_generation_repository import GeoGenerationRepository
from neo_agent_api.persistence.geo_result_repository import GeoResultRepository
from psycopg import sql
from sqlalchemy import text
from sqlalchemy.exc import DataError
from testcontainers.community.postgres import PostgresContainer

pytestmark = pytest.mark.integration

_FIXTURE = Path(__file__).parents[1] / "fixtures" / "geo-schema.sql"


def _docker_daemon_unavailable(exc: DockerException) -> bool:
    message = str(exc).casefold()
    return "error while fetching server api version" in message and (
        "connection refused" in message or "no such file or directory" in message
    )


@pytest.fixture(scope="module")
def postgres_container() -> Iterator[PostgresContainer]:
    """Start the same disposable PostgreSQL 16 topology as the retained Nest tests."""

    try:
        # Docker client construction itself contacts the daemon on current
        # testcontainers releases, so diagnose that one environmental blocker.
        container = PostgresContainer("postgres:16-alpine")
        container.start()
    except DockerException as exc:
        if _docker_daemon_unavailable(exc):
            pytest.skip(f"Testcontainers PostgreSQL unavailable: {type(exc).__name__}: {exc}")
        raise
    try:
        sync_url = container.get_connection_url().replace("postgresql+psycopg2://", "postgresql://", 1)
        with psycopg.connect(sync_url) as connection:
            connection.execute(sql.SQL(cast(LiteralString, _FIXTURE.read_text())))
        yield container
    finally:
        container.stop()


async def _seed_processing(database_url: str, generation_id: str) -> None:
    database = create_database(database_url, schema="neo")
    try:
        async with database.engine.begin() as connection:
            channel_id = (
                await connection.execute(text("SELECT channel_id FROM neo.channel WHERE channel_code = 'TEST'"))
            ).scalar_one()
            await connection.execute(
                text(
                    """
                    INSERT INTO neo.geo_generation
                      (geo_generation_id, channel_id, dedup_key, locale, product, product_sn, status,
                       version, claimed_at, claimed_by, created_at, updated_at)
                    VALUES
                      (:id, :channel_id, :dedup_key, 'ko-KR', CAST(:product AS jsonb), 'SN-TEST', 'PROCESSING',
                       0, now(), 'batch-1', now(), now())
                    """
                ),
                {"id": generation_id, "channel_id": channel_id, "dedup_key": generation_id, "product": "{}"},
            )
    finally:
        await database.dispose()


async def test_guarded_transition_inserts_exactly_one_result_transactionally(
    postgres_container: PostgresContainer,
) -> None:
    database_url = postgres_container.get_connection_url().replace("postgresql+psycopg2://", "postgresql://", 1)
    generation_id = "11111111-1111-1111-1111-111111111111"
    await _seed_processing(database_url, generation_id)
    database = create_database(database_url, schema="neo")
    generation = GeoGenerationRepository(database)
    results = GeoResultRepository(database)
    artifact = {
        "resultStatus": "SUCCEEDED",
        "jsonLd": {"@type": "Product"},
        "scriptTag": "<script/>",
        "schemaTypes": ["Product"],
        "resultHash": "a" * 64,
        "ragProfile": "profile@1",
        "diagnostics": {},
        "generatedAt": "2026-09-10T00:00:00.000Z",
    }
    try:
        assert await results.persist_success(generation_id, artifact) is True
        assert await results.persist_success(generation_id, artifact) is False
        assert await generation.find_status(generation_id) == "SUCCEEDED"
        async with database.engine.connect() as connection:
            row = (
                (
                    await connection.execute(
                        text(
                            """
                        SELECT version, claimed_at, claimed_by,
                               (SELECT count(*) FROM neo.geo_result WHERE geo_generation_id = :id) AS result_count
                        FROM neo.geo_generation WHERE geo_generation_id = :id
                        """
                        ),
                        {"id": generation_id},
                    )
                )
                .mappings()
                .one()
            )
        assert row["version"] == 1
        assert row["claimed_at"] is None
        assert row["claimed_by"] is None
        assert row["result_count"] == 1
    finally:
        await database.dispose()


async def test_failed_transition_is_guarded_and_uses_utf16_code_unit_truncation(
    postgres_container: PostgresContainer,
) -> None:
    database_url = postgres_container.get_connection_url().replace("postgresql+psycopg2://", "postgresql://", 1)
    generation_id = "22222222-2222-2222-2222-222222222222"
    await _seed_processing(database_url, generation_id)
    database = create_database(database_url, schema="neo")
    generation = GeoGenerationRepository(database)
    detail = "😀" * 1200
    try:
        assert await generation.transition_to_failed(generation_id, "GENERATION_ERROR", detail) is True
        assert await generation.transition_to_failed(generation_id, "GENERATION_ERROR", detail) is False
        async with database.engine.connect() as connection:
            row = (
                (
                    await connection.execute(
                        text(
                            "SELECT status, error_phase, error_code, error_detail "
                            "FROM neo.geo_generation WHERE geo_generation_id = :id"
                        ),
                        {"id": generation_id},
                    )
                )
                .mappings()
                .one()
            )
        assert row["status"] == "FAILED"
        assert row["error_phase"] == "GENERATION"
        assert row["error_code"] == "GENERATION_ERROR"
        assert len(str(row["error_detail"]).encode("utf-16-le")) <= 4000
    finally:
        await database.dispose()


async def test_jsonb_persistence_rejects_javascript_lone_surrogates_and_rolls_back(
    postgres_container: PostgresContainer,
) -> None:
    database_url = postgres_container.get_connection_url().replace("postgresql+psycopg2://", "postgresql://", 1)
    generation_id = "33333333-3333-3333-3333-333333333333"
    await _seed_processing(database_url, generation_id)
    database = create_database(database_url, schema="neo")
    results = GeoResultRepository(database)
    invalid_artifact = {
        "resultStatus": "SUCCEEDED",
        "jsonLd": {"score": math.nan, "lone": "\ud83d"},
        "scriptTag": "<script/>",
        "schemaTypes": ["Product", math.inf],
        "resultHash": "c" * 64,
        "ragProfile": "profile@1",
        "diagnostics": {"negative": -0.0, "lone": "\ud83d"},
        "generatedAt": "2026-09-10T00:00:00.000Z",
    }
    try:
        # JSON.stringify emits a lone UTF-16 surrogate as ``\\ud83d``.  That
        # is valid JavaScript JSON, but PostgreSQL JSONB correctly rejects the
        # invalid Unicode escape.  TypeORM's transaction consequently rolls
        # back both the guarded state transition and result insert.
        with pytest.raises(DataError):
            await results.persist_success(generation_id, invalid_artifact)
        async with database.engine.connect() as connection:
            row = (
                (
                    await connection.execute(
                        text(
                            "SELECT status, "
                            "(SELECT count(*) FROM neo.geo_result WHERE geo_generation_id = :id) AS result_count "
                            "FROM neo.geo_generation WHERE geo_generation_id = :id"
                        ),
                        {"id": generation_id},
                    )
                )
                .mappings()
                .one()
            )
        assert row["status"] == "PROCESSING"
        assert row["result_count"] == 0

        artifact = {
            **invalid_artifact,
            "jsonLd": {"score": math.nan},
            "diagnostics": {"negative": -0.0},
        }
        assert await results.persist_success(generation_id, artifact) is True
        async with database.engine.connect() as connection:
            row = (
                (
                    await connection.execute(
                        text(
                            "SELECT json_ld::text AS json_ld, schema_types::text AS schema_types, "
                            "diagnostics::text AS diagnostics "
                            "FROM neo.geo_result WHERE geo_generation_id = :id"
                        ),
                        {"id": generation_id},
                    )
                )
                .mappings()
                .one()
            )
        assert '"score": null' in str(row["json_ld"])
        assert str(row["schema_types"]) == '["Product", null]'
        assert '"negative": 0' in str(row["diagnostics"])
    finally:
        await database.dispose()
