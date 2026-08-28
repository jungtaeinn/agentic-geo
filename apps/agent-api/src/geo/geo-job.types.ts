export interface GeoJobData {
  geoGenerationId: string;
  locale: string;
  product: unknown;
  /** Official brand entity URLs; see SubmitGenerationDto.brandSameAs. */
  brandSameAs?: string[];
}
