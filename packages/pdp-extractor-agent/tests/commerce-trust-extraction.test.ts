import { describe, expect, it } from "vitest";
import { extractProductFromHtml } from "../src";

// 커머스 신뢰 필드 추출 계약: 소스 페이지 JSON-LD가 Offer·MerchantReturnPolicy를
// @graph의 별도 노드로 두고 @id로 참조하는 구조(Shopify류 실서비스 마크업)에서도
// availability / priceValidUntil / itemCondition / 반품정책이 geoProduct 입력
// 계약으로 전달되어야 downstream generator가 fail-closed 생략 없이 발행할 수 있다.
const graphReferencedHtml = `
<!doctype html>
<html>
  <head>
    <title>Ginseng Firming Serum</title>
    <meta name="description" content="A lightweight firming serum." />
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "MerchantReturnPolicy",
            "@id": "https://brand.example.com/#MerchantReturnPolicy",
            "name": "Brand Merchant Return Policy",
            "returnPolicyCategory": "MerchantReturnFiniteReturnWindow",
            "merchantReturnDays": "45",
            "returnMethod": "ReturnByMail",
            "returnFees": "ReturnFeesCustomerResponsibility",
            "applicableCountry": "US",
            "merchantReturnLink": "/pages/shipping-return-policy"
          },
          {
            "@type": "Product",
            "@id": "https://brand.example.com/products/ginseng-firming-serum#Product",
            "name": "Ginseng Firming Serum",
            "description": "A lightweight firming serum.",
            "sku": "270321046",
            "itemCondition": "https://schema.org/NewCondition",
            "offers": { "@id": "https://brand.example.com/products/ginseng-firming-serum#Offer" }
          },
          {
            "@type": "Offer",
            "@id": "https://brand.example.com/products/ginseng-firming-serum#Offer",
            "price": "215.00",
            "priceCurrency": "USD",
            "availability": "OutOfStock",
            "priceValidUntil": "2027-08-13",
            "hasMerchantReturnPolicy": { "@id": "https://brand.example.com/#MerchantReturnPolicy" }
          }
        ]
      }
    </script>
  </head>
  <body>
    <main>
      <h1>Ginseng Firming Serum</h1>
      <section class="pdp-benefits">
        <h2>Benefits</h2>
        <p>Helps support skin firmness and elasticity.</p>
      </section>
    </main>
  </body>
</html>
`;

describe("commerce trust extraction from source JSON-LD", () => {
  it("resolves @id-referenced Offer and MerchantReturnPolicy into the geoProduct contract", async () => {
    const { result } = await extractProductFromHtml(
      graphReferencedHtml,
      "https://brand.example.com/products/ginseng-firming-serum"
    );

    expect(result.geoProduct.price?.raw).toBe("215.00");
    expect(result.geoProduct.price?.currency).toBe("USD");
    expect(result.geoProduct.availability).toBe("OutOfStock");
    expect(result.geoProduct.priceValidUntil).toBe("2027-08-13");
    expect(result.geoProduct.itemCondition).toContain("NewCondition");
    expect(result.geoProduct.returnPolicy).toMatchObject({
      category: "MerchantReturnFiniteReturnWindow",
      merchantReturnDays: 45,
      returnMethod: "ReturnByMail",
      returnFees: "ReturnFeesCustomerResponsibility",
      applicableCountry: "US",
      url: "https://brand.example.com/pages/shipping-return-policy"
    });
  });

  it("omits commerce trust fields when the source markup does not provide them", async () => {
    const bareHtml = `
<!doctype html>
<html>
  <head>
    <title>Plain Cream</title>
    <script type="application/ld+json">
      { "@context": "https://schema.org", "@type": "Product", "name": "Plain Cream",
        "offers": { "@type": "Offer", "price": "32000", "priceCurrency": "KRW" } }
    </script>
  </head>
  <body><main><h1>Plain Cream</h1></main></body>
</html>
`;
    const { result } = await extractProductFromHtml(bareHtml, "https://example.com/products/plain-cream");

    expect(result.geoProduct.availability).toBeUndefined();
    expect(result.geoProduct.priceValidUntil).toBeUndefined();
    expect(result.geoProduct.returnPolicy).toBeUndefined();
  });
});
