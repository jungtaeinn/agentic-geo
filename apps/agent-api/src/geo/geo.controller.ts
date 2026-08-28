import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { SubmitGenerationDto } from "./dto/submit-generation.dto";
import { GeoAcceptService } from "./geo-accept.service";

@Controller("internal/v1/geo/generations")
export class GeoController {
  constructor(private readonly accept: GeoAcceptService) {}

  @Post()
  @HttpCode(202)
  async submit(@Body() dto: SubmitGenerationDto): Promise<{ accepted: true; geoGenerationId: string }> {
    await this.accept.accept({
      geoGenerationId: dto.geoGenerationId,
      locale: dto.locale,
      product: dto.product,
      brandSameAs: dto.brandSameAs,
    });
    return { accepted: true, geoGenerationId: dto.geoGenerationId };
  }
}
