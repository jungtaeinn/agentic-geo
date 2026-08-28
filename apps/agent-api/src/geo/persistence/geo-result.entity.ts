import { Column, Entity, PrimaryGeneratedColumn } from "typeorm";

@Entity({ schema: "agentic_geo", name: "geo_result" })
export class GeoResult {
  @PrimaryGeneratedColumn({ name: "geo_result_id", type: "bigint" })
  geoResultId!: string;

  @Column({ name: "geo_generation_id", type: "uuid" })
  geoGenerationId!: string;

  @Column({ name: "result_status", type: "varchar" })
  resultStatus!: string;

  @Column({ name: "json_ld", type: "jsonb", nullable: true })
  jsonLd!: unknown;

  @Column({ name: "script_tag", type: "text", nullable: true })
  scriptTag!: string | null;

  @Column({ name: "schema_types", type: "jsonb", nullable: true })
  schemaTypes!: unknown;

  @Column({ name: "result_hash", type: "varchar", nullable: true })
  resultHash!: string | null;

  @Column({ name: "rag_profile", type: "varchar", nullable: true })
  ragProfile!: string | null;

  @Column({ name: "diagnostics", type: "jsonb", nullable: true })
  diagnostics!: unknown;

  @Column({ name: "generated_at", type: "timestamptz" })
  generatedAt!: Date;
}
