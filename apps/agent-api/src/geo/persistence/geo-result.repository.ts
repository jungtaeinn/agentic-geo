import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { GeoGeneration } from "./geo-generation.entity";
import { GeoResult } from "./geo-result.entity";
import type { GeneratedArtifact } from "../generation.service";

@Injectable()
export class GeoResultRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async persistSuccess(id: string, artifact: GeneratedArtifact): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const transition = await manager
        .createQueryBuilder()
        .update(GeoGeneration)
        .set({
          status: "SUCCEEDED",
          claimedAt: null,
          claimedBy: null,
          version: () => "version + 1",
          updatedAt: () => "now()",
        })
        .where("geo_generation_id = :id AND status = :expected", { id, expected: "PROCESSING" })
        .execute();

      if (transition.affected !== 1) return false;

      await manager.getRepository(GeoResult).insert({
        geoGenerationId: id,
        resultStatus: artifact.resultStatus,
        jsonLd: artifact.jsonLd,
        scriptTag: artifact.scriptTag,
        schemaTypes: artifact.schemaTypes,
        resultHash: artifact.resultHash,
        ragProfile: artifact.ragProfile,
        diagnostics: artifact.diagnostics,
        generatedAt: new Date(artifact.generatedAt),
      });
      return true;
    });
  }
}
