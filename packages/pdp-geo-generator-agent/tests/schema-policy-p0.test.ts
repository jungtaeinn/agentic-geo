import { describe, expect, it } from "vitest";
import { generatePdpGeo } from "../src";

// P0 스키마 정책: 자사 PDP는 머천트 페이지이므로 positiveNotes(Pros&Cons)
// 부적격이며(에디토리얼 리뷰 페이지 전용), self-serving 마크업 리스크만
// 남는다. 벤핏 신호는 가시 콘텐츠 섹션과 Product.description/
// additionalProperty로만 발행한다.
describe("merchant PDP schema policy (P0)", () => {
  const benefitRichProduct = {
    name: "Barrier Hydro Soothing Cream",
    description: "Hydrating cream for dry skin and skin barrier care.",
    category: "Cream",
    benefits: ["hydration", "skin barrier care"],
    effects: ["soothing"],
    ingredients: ["Ceramide", "Panthenol"],
    price: "32,000원",
    currency: "KRW",
    reviews: {
      positiveKeywords: ["수분감", "진정"]
    }
  };

  it("does not emit Product.positiveNotes on merchant PDP markup", async () => {
    const { result } = await generatePdpGeo({
      product: { geoProduct: benefitRichProduct },
      hints: { locale: "ko-KR", market: "KR" }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;

    expect(product).toBeDefined();
    expect(product.positiveNotes).toBeUndefined();
    expect(JSON.stringify(result.schemaMarkup.jsonLd)).not.toContain("positiveNotes");
  });

  it("keeps benefit signals in visible content sections after positiveNotes removal", async () => {
    const { result } = await generatePdpGeo({
      product: { geoProduct: benefitRichProduct },
      hints: { locale: "ko-KR", market: "KR" }
    });

    const benefitsSection = result.content.sections.benefits;
    expect(benefitsSection.trim().length).toBeGreaterThan(0);
  });
});

// P0 커머스 신뢰 계층: 머천트 리스팅 자격 필드(반품정책 객체·배송·가격
// 유효기간)는 소스가 제공할 때만 Offer에 구조화 객체로 발행한다(fail-closed).
describe("Offer commerce trust fields (P0)", () => {
  const commerceProduct = {
    name: "Barrier Hydro Soothing Cream",
    description: "Hydrating cream for dry skin and skin barrier care.",
    category: "Cream",
    benefits: ["hydration"],
    ingredients: ["Ceramide"],
    price: "32,000원",
    currency: "KRW",
    availability: "InStock"
  };

  async function generateOffer(extra: Record<string, unknown>) {
    const { result } = await generatePdpGeo({
      product: { geoProduct: { ...commerceProduct, ...extra } },
      hints: { locale: "ko-KR", market: "KR" }
    });
    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    return product.offers as Record<string, any>;
  }

  it("maps source return policy, shipping, and priceValidUntil into structured Offer fields", async () => {
    const offer = await generateOffer({
      priceValidUntil: "2027-08-13",
      returnPolicy: {
        category: "MerchantReturnFiniteReturnWindow",
        merchantReturnDays: 45,
        returnMethod: "ReturnByMail",
        returnFees: "ReturnFeesCustomerResponsibility",
        applicableCountry: "KR",
        url: "https://example.com/pages/returns"
      },
      shipping: {
        destinationCountry: "KR",
        handlingDaysMin: 0,
        handlingDaysMax: 1,
        transitDaysMin: 1,
        transitDaysMax: 6
      }
    });

    expect(offer.priceValidUntil).toBe("2027-08-13");
    expect(offer.hasMerchantReturnPolicy).toMatchObject({
      "@type": "MerchantReturnPolicy",
      returnPolicyCategory: "https://schema.org/MerchantReturnFiniteReturnWindow",
      merchantReturnDays: 45,
      returnMethod: "https://schema.org/ReturnByMail",
      returnFees: "https://schema.org/ReturnFeesCustomerResponsibility",
      applicableCountry: "KR",
      returnPolicyCountry: "KR",
      merchantReturnLink: "https://example.com/pages/returns"
    });
    expect(offer.shippingDetails).toMatchObject({
      "@type": "OfferShippingDetails",
      shippingDestination: { "@type": "DefinedRegion", addressCountry: "KR" },
      deliveryTime: {
        "@type": "ShippingDeliveryTime",
        handlingTime: { "@type": "QuantitativeValue", minValue: 0, maxValue: 1, unitCode: "DAY" },
        transitTime: { "@type": "QuantitativeValue", minValue: 1, maxValue: 6, unitCode: "DAY" }
      }
    });
  });

  it("omits commerce trust fields entirely when the source does not provide them (fail-closed)", async () => {
    const offer = await generateOffer({});
    expect(offer.priceValidUntil).toBeUndefined();
    expect(offer.hasMerchantReturnPolicy).toBeUndefined();
    expect(offer.shippingDetails).toBeUndefined();
  });

  it("drops unmappable return policy, shipping, and priceValidUntil values (fail-closed)", async () => {
    const offer = await generateOffer({
      priceValidUntil: "soon",
      returnPolicy: { category: "SometimesMaybe", applicableCountry: "KR" },
      shipping: { destinationCountry: "KOREA" }
    });
    expect(offer.priceValidUntil).toBeUndefined();
    expect(offer.hasMerchantReturnPolicy).toBeUndefined();
    expect(offer.shippingDetails).toBeUndefined();
  });

  it("requires merchantReturnDays for a finite return window (fail-closed)", async () => {
    const offer = await generateOffer({
      returnPolicy: { category: "MerchantReturnFiniteReturnWindow", applicableCountry: "KR" }
    });
    expect(offer.hasMerchantReturnPolicy).toBeUndefined();
  });
});

// P0 엔티티 계층: 운영 조직(Organization)은 소스가 제공할 때만 top-level
// 노드로 발행하고 Offer.seller가 참조한다. 빈 sameAs 배열은 지식그래프
// 연결 가치가 0인 노이즈이므로 절대 발행하지 않는다.
describe("Organization entity (P0)", () => {
  const product = {
    name: "Barrier Hydro Soothing Cream",
    description: "Hydrating cream for dry skin and skin barrier care.",
    category: "Cream",
    benefits: ["hydration"],
    ingredients: ["Ceramide"],
    price: "32,000원",
    currency: "KRW",
    availability: "InStock"
  };

  it("emits an Organization node with validated sameAs and links Offer.seller", async () => {
    const { result } = await generatePdpGeo({
      product: { geoProduct: product },
      hints: {
        locale: "ko-KR",
        market: "KR",
        organization: {
          name: "EXAMPLECOMPANY",
          url: "https://brand.example.com",
          logoUrl: "https://brand.example.com/logo.png",
          sameAs: ["https://www.instagram.com/brand.example/", "not-a-url", ""]
        }
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const organization = graph.find((node) => node["@type"] === "Organization") as Record<string, any>;
    const productNode = graph.find((node) => node["@type"] === "Product") as Record<string, any>;

    expect(organization).toMatchObject({
      "@type": "Organization",
      "@id": "https://brand.example.com/#organization",
      name: "EXAMPLECOMPANY",
      url: "https://brand.example.com",
      logo: { "@type": "ImageObject", url: "https://brand.example.com/logo.png" },
      sameAs: ["https://www.instagram.com/brand.example/"]
    });
    expect((productNode.offers as Record<string, any>).seller).toEqual({ "@id": "https://brand.example.com/#organization" });
  });

  it("omits the Organization node and never emits an empty sameAs when the source provides none", async () => {
    const { result } = await generatePdpGeo({
      product: { geoProduct: product },
      hints: { locale: "ko-KR", market: "KR" }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    expect(graph.some((node) => node["@type"] === "Organization")).toBe(false);
    expect(JSON.stringify(result.schemaMarkup.jsonLd)).not.toContain("\"sameAs\":[]");
  });
});

// Brand identity from the page's own address: a PDP that already sits on the
// brand's site carries the one official identity URL the caller never has to
// supply. The host has to prove the relationship by carrying the brand name,
// so a listing hosted elsewhere yields nothing instead of asserting that a
// retailer's domain identifies the brand.
describe("Brand.sameAs derived from the canonical product URL", () => {
  const product = {
    name: "BARRIERCARE365 Cream",
    brand: "EXAMPLEDERMA",
    description: "Barrier cream for dry, sensitive skin.",
    ingredients: ["Ceramide"]
  };

  const brandOf = (jsonLd: unknown): Record<string, unknown> | undefined => {
    const graph = (jsonLd as { "@graph"?: Array<Record<string, unknown>> })["@graph"] ?? [];
    const node = graph.find((entry) => entry["@type"] === "Product");
    return node?.brand as Record<string, unknown> | undefined;
  };

  it("grounds the brand on the site the product page is served from", async () => {
    const { result } = await generatePdpGeo({
      product: { geoProduct: product },
      source: { type: "pdp-extractor", url: "https://www.examplederma.com/web/product/view.do?prdSeq=1149" },
      hints: { locale: "ko-KR", market: "KR" }
    });

    expect(brandOf(result.schemaMarkup.jsonLd)?.sameAs).toEqual(["https://www.examplederma.com/"]);
  });

  it("stays silent when the host does not carry the brand name", async () => {
    const { result } = await generatePdpGeo({
      product: { geoProduct: product },
      source: { type: "pdp-extractor", url: "https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=A123" },
      hints: { locale: "ko-KR", market: "KR" }
    });

    expect(brandOf(result.schemaMarkup.jsonLd)?.sameAs).toBeUndefined();
  });

  it("lets an explicit hint win over the derived origin", async () => {
    const { result } = await generatePdpGeo({
      product: { geoProduct: product },
      source: { type: "pdp-extractor", url: "https://www.examplederma.com/web/product/view.do?prdSeq=1149" },
      hints: { locale: "ko-KR", market: "KR", brandSameAs: ["https://www.wikidata.org/wiki/Q1"] }
    });

    expect(brandOf(result.schemaMarkup.jsonLd)?.sameAs).toEqual(["https://www.wikidata.org/wiki/Q1"]);
  });
});
