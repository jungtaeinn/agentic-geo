import { Column, Entity, PrimaryColumn } from "typeorm";

/**
 * agentic_geo.geo_generation 부분 매핑 (설계 §9, 의도적).
 * agent-api는 이 row를 INSERT하지 않는다 — 접수는 upstream-api가 소유한다.
 * agent-api는 status를 PROCESSING→SUCCEEDED/FAILED로 가드 UPDATE하고 product/locale/status를 읽을 뿐이므로,
 * dedup_key·attempt_count·next_retry_at·created_at 등 접수/재시도 전용 컬럼은 매핑하지 않는다.
 */
@Entity({ schema: "agentic_geo", name: "geo_generation" })
export class GeoGeneration {
  @PrimaryColumn({ name: "geo_generation_id", type: "uuid" })
  geoGenerationId!: string;

  @Column({ name: "channel_id", type: "bigint" })
  channelId!: string;

  @Column({ name: "locale", type: "varchar" })
  locale!: string;

  @Column({ name: "product", type: "jsonb" })
  product!: unknown;

  @Column({ name: "status", type: "varchar" })
  status!: string;

  @Column({ name: "error_phase", type: "varchar", nullable: true })
  errorPhase!: string | null;

  @Column({ name: "error_code", type: "varchar", nullable: true })
  errorCode!: string | null;

  @Column({ name: "error_detail", type: "text", nullable: true })
  errorDetail!: string | null;

  @Column({ name: "claimed_at", type: "timestamptz", nullable: true })
  claimedAt!: Date | null;

  @Column({ name: "claimed_by", type: "varchar", nullable: true })
  claimedBy!: string | null;

  @Column({ name: "version", type: "bigint" })
  version!: string;

  @Column({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
