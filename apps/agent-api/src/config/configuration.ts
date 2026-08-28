export interface AppConfig {
  port: number;
  apiKey: string;
  workerConcurrency: number;
  db: {
    host: string;
    port: number;
    database: string;
    username: string;
    password: string;
    schema: string;
    ssl: false | { rejectUnauthorized: boolean };
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3000),
    apiKey: env.AGENT_API_KEY ?? "",
    workerConcurrency: Number(env.GEO_WORKER_CONCURRENCY ?? 4),
    db: {
      host: env.DB_HOST ?? "localhost",
      port: Number(env.DB_PORT ?? 5432),
      database: env.DB_NAME ?? "postgres",
      username: env.DB_USERNAME ?? "postgres",
      password: env.DB_PASSWORD ?? "",
      schema: env.DB_SCHEMA ?? "agentic_geo",
      // Azure Postgres는 SSL 필수. DB_SSL=true로 켜고, 기본은 cert 검증(secure).
      // 로컬에서 Azure cert 검증이 막히면 DB_SSL_REJECT_UNAUTHORIZED=false로 완화.
      ssl: /^true$/i.test(env.DB_SSL ?? "")
        ? { rejectUnauthorized: !/^false$/i.test(env.DB_SSL_REJECT_UNAUTHORIZED ?? "") }
        : false,
    },
  };
}
