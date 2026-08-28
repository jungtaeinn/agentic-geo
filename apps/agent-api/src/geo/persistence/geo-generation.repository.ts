import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { GeoGeneration } from "./geo-generation.entity";

@Injectable()
export class GeoGenerationRepository {
  constructor(@InjectRepository(GeoGeneration) private readonly repo: Repository<GeoGeneration>) {}

  async findStatus(id: string): Promise<string | null> {
    const row = await this.repo.findOne({ where: { geoGenerationId: id }, select: { status: true } });
    return row?.status ?? null;
  }

  async transitionToSucceeded(id: string): Promise<boolean> {
    const result = await this.repo
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
    return result.affected === 1;
  }

  async transitionToFailed(id: string, code: string, detail: string): Promise<boolean> {
    const result = await this.repo
      .createQueryBuilder()
      .update(GeoGeneration)
      .set({
        status: "FAILED",
        errorPhase: "GENERATION",
        errorCode: code,
        errorDetail: detail,
        claimedAt: null,
        claimedBy: null,
        version: () => "version + 1",
        updatedAt: () => "now()",
      })
      .where("geo_generation_id = :id AND status = :expected", { id, expected: "PROCESSING" })
      .execute();
    return result.affected === 1;
  }
}
