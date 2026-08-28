import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { DataSource } from "typeorm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GeoGeneration } from "../../src/geo/persistence/geo-generation.entity";
import { GeoResult } from "../../src/geo/persistence/geo-result.entity";

export interface StartedDb {
  container: StartedPostgreSqlContainer;
  dataSource: DataSource;
  testChannelId: string;
}

export async function startPostgres(): Promise<StartedDb> {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const dataSource = new DataSource({
    type: "postgres",
    host: container.getHost(),
    port: container.getPort(),
    username: container.getUsername(),
    password: container.getPassword(),
    database: container.getDatabase(),
    entities: [GeoGeneration, GeoResult],
    synchronize: false,
  });
  await dataSource.initialize();
  const ddl = readFileSync(join(__dirname, "../fixtures/geo-schema.sql"), "utf8");
  await dataSource.query(ddl);
  const rows = await dataSource.query("select channel_id from agentic_geo.channel where channel_code='TEST'");
  return { container, dataSource, testChannelId: String(rows[0].channel_id) };
}
