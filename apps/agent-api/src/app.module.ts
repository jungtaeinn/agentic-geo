import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { TypeOrmModule } from "@nestjs/typeorm";
import { HealthController } from "./health/health.controller";
import { ApiKeyGuard } from "./auth/api-key.guard";
import { loadConfig } from "./config/configuration";
import { GeoGeneration } from "./geo/persistence/geo-generation.entity";
import { GeoResult } from "./geo/persistence/geo-result.entity";
import { GeoModule } from "./geo/geo.module";
import { LoggingModule } from "./observability/logging.module";

@Module({
  imports: [
    LoggingModule,
    TypeOrmModule.forRoot({
      type: "postgres",
      ...loadConfig().db,
      entities: [GeoGeneration, GeoResult],
      synchronize: false,
      migrationsRun: false,
    }),
    GeoModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useFactory: () => new ApiKeyGuard(loadConfig().apiKey) }],
})
export class AppModule {}
