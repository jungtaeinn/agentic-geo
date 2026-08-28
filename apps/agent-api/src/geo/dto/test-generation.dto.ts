import { ArrayMaxSize, IsArray, IsBoolean, IsNotEmpty, IsObject, IsOptional, IsString, IsUrl } from "class-validator";

/** 동기 테스트 전용 — geoGenerationId는 서버가 생성하므로 받지 않는다. */
export class TestGenerationDto {
  @IsString()
  @IsNotEmpty()
  locale!: string;

  @IsObject()
  product!: Record<string, unknown>;

  /**
   * 켜면 응답에 생성기 diagnostics 전체와 내부 콘텐츠 섹션을 함께 싣는다.
   * 로컬 리그레션이 품질 루브릭(evaluateGeoQuality)과 개선 프롬프트를 산출하려면
   * validationWarnings만으로는 부족하고 normalizedProduct·ragUsage·evidence·contentPlan이 필요하다.
   * 응답이 커지므로 기본은 끔 — 이 엔드포인트 자체가 GEO_TEST_SYNC_ENDPOINT 게이트 뒤의 로컬 전용이다.
   */
  @IsOptional()
  @IsBoolean()
  includeDiagnostics?: boolean;

  /** 공개 제출 경로와 같은 브랜드 엔티티 URL 힌트 — 로컬 회귀가 Brand.sameAs를 실측하려면 필요하다. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUrl({ protocols: ["http", "https"], require_protocol: true }, { each: true })
  brandSameAs?: string[];
}
