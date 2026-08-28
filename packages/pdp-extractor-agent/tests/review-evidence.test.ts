import { describe, expect, it } from "vitest";
import { extractProductFromHtml } from "../src";

/**
 * Mirrors a Shopify PDP whose review widget is client-rendered: the aggregate
 * rating ships in JSON-LD, but no review body exists in the fetched HTML.
 */
const clientRenderedReviewHtml = `
<!doctype html>
<html>
  <head>
    <title>Botanical Renewal Serum</title>
    <meta name="description" content="Firming serum formulated with herbal botanicals to improve elasticity." />
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "Product",
        "name": "Botanical Renewal Serum",
        "brand": { "@type": "Brand", "name": "ExampleLuxe" },
        "offers": { "@type": "Offer", "price": "215.00", "priceCurrency": "USD" },
        "aggregateRating": {
          "@type": "AggregateRating",
          "bestRating": "5",
          "worstRating": "1",
          "ratingValue": "4.8",
          "reviewCount": "854"
        }
      }
    </script>
  </head>
  <body>
    <main>
      <h1>Botanical Renewal Serum</h1>
      <img src="/clinical.jpg" data-ocr-text="AFTER 6 WEEKS OF USE 100% SHOWED IMPROVEMENT IN FIRMNESS AND ELASTICITY. GINSENG PEPTIDE HELPS SUPPORT SKIN FIRMNESS AND ELASTICITY." />
      <section class="pdp-benefits">
        <h2>Benefits</h2>
        <p>Lightweight, fast-absorbing firming serum that improves the look of plumpness and skin resilience.</p>
      </section>
      <section class="reviews-section">
        <h2>Reviews</h2>
        <button class="review-write-button">Write A Review</button>
        <div class="yotpo-widget-instance" data-yotpo-instance-id="123"></div>
      </section>
    </main>
  </body>
</html>
`;

describe("review evidence", () => {
  it("records the aggregate rating source and flags missing review bodies", async () => {
    const { result, diagnostics } = await extractProductFromHtml(
      clientRenderedReviewHtml,
      "https://example.com/products/botanical-renewal-serum"
    );

    expect(result.geoProduct.reviews.rating).toBe(4.8);
    expect(result.geoProduct.reviews.reviewCount).toBe(854);

    const ratingEvidence = diagnostics.evidence.find((item) => item.field === "product.reviews.rating");
    expect(ratingEvidence).toEqual({ field: "product.reviews.rating", source: "jsonLd", value: "4.8" });

    const reviewCountEvidence = diagnostics.evidence.find((item) => item.field === "product.reviews.reviewCount");
    expect(reviewCountEvidence).toEqual({ field: "product.reviews.reviewCount", source: "jsonLd", value: "854" });

    expect(result.geoProduct.reviews.items).toHaveLength(0);
    expect(diagnostics.warnings.map((warning) => warning.code)).toContain("REVIEW_BODIES_UNAVAILABLE");

    const reviewStep = diagnostics.process.find((step) => step.id === "review");
    expect(reviewStep?.message).toContain("4.8");
    expect(reviewStep?.message).toContain("854");
  });

  it("attributes each aggregate field to the source that produced it", async () => {
    // JSON-LD carries the rating only; the review count comes from the DOM.
    const partialJsonLdHtml = clientRenderedReviewHtml
      .replace('"ratingValue": "4.8",\n          "reviewCount": "854"', '"ratingValue": "4.8"')
      .replace(
        '<button class="review-write-button">Write A Review</button>',
        '<button class="review-write-button">Write A Review</button><div class="review-count" aria-label="854 reviews">854 reviews</div>'
      );

    const { result, diagnostics } = await extractProductFromHtml(
      partialJsonLdHtml,
      "https://example.com/products/botanical-renewal-serum"
    );

    expect(result.geoProduct.reviews.rating).toBe(4.8);
    expect(result.geoProduct.reviews.reviewCount).toBe(854);
    expect(diagnostics.evidence.find((item) => item.field === "product.reviews.rating")?.source).toBe("jsonLd");
    expect(diagnostics.evidence.find((item) => item.field === "product.reviews.reviewCount")?.source).toBe("dom");
  });

  it("keeps OCR and product copy out of review keywords", async () => {
    const { result } = await extractProductFromHtml(
      clientRenderedReviewHtml,
      "https://example.com/products/botanical-renewal-serum"
    );

    const reviewKeywords = result.geoProduct.reviews.keywords.map((keyword) => keyword.toLowerCase());

    for (const productCopyKeyword of ["firmness", "elasticity", "plumpness", "peptide", "ginseng"]) {
      expect(reviewKeywords).not.toContain(productCopyKeyword);
    }
    for (const chromeKeyword of ["review", "reviews", "rating", "customer", "stars"]) {
      expect(reviewKeywords).not.toContain(chromeKeyword);
    }
  });

  it("derives review keywords from real review bodies when they are present", async () => {
    const withReviewBodies = clientRenderedReviewHtml.replace(
      '<div class="yotpo-widget-instance" data-yotpo-instance-id="123"></div>',
      `<div itemprop="review"><p>Absorbs fast and leaves my skin smooth, I am satisfied enough to repurchase.</p></div>`
    );

    const { result, diagnostics } = await extractProductFromHtml(
      withReviewBodies,
      "https://example.com/products/botanical-renewal-serum"
    );

    expect(result.geoProduct.reviews.items).toHaveLength(1);
    expect(result.geoProduct.reviews.keywords.map((keyword) => keyword.toLowerCase())).toContain("smooth");
    expect(diagnostics.warnings.map((warning) => warning.code)).not.toContain("REVIEW_BODIES_UNAVAILABLE");
  });
});
