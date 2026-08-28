import { ArrayMaxSize, IsArray, IsObject, IsOptional, IsString, IsUUID, IsUrl, IsNotEmpty } from "class-validator";

export class SubmitGenerationDto {
  @IsUUID()
  geoGenerationId!: string;

  @IsString()
  @IsNotEmpty()
  locale!: string;

  @IsObject()
  product!: Record<string, unknown>;

  /**
   * Official brand entity URLs (brand site, Wikidata, verified social profiles)
   * emitted as `Brand.sameAs`. Retrieval research credits agentic-retrieval
   * gains to entity interlinking and dereferenceable identifiers rather than to
   * markup volume, and the generator has no other source for these — a PDP
   * without them publishes a product entity that links to nothing.
   *
   * Validated as absolute http(s) URLs so an unverifiable value fails loudly at
   * the boundary instead of being silently dropped deeper in the graph builder.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUrl({ protocols: ["http", "https"], require_protocol: true }, { each: true })
  brandSameAs?: string[];
}
