import { afterEach, describe, expect, it, vi } from "vitest";
import { extractProduct, extractProductFromHtml } from "../src";

const html = `
<!doctype html>
<html>
  <head>
    <title>Hydra Barrier Cream</title>
    <meta name="description" content="Daily hydration cream for moisture barrier care." />
    <meta property="og:image" content="/hero.jpg" />
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "Product",
        "name": "Hydra Barrier Cream",
        "description": "Daily hydration cream for moisture barrier care.",
        "image": ["/product.jpg"],
        "offers": { "@type": "Offer", "price": "32000", "priceCurrency": "KRW" },
        "aggregateRating": { "@type": "AggregateRating", "ratingValue": "4.8", "reviewCount": "418" },
        "review": [
          { "@type": "Review", "reviewBody": "촉촉하고 흡수가 빨라서 재구매하고 싶어요.", "reviewRating": { "ratingValue": "5" } }
        ]
      }
    </script>
  </head>
  <body>
    <div class="account-modal newsletter-overlay">
      <h2>Sign in</h2>
      <p>Create an account, subscribe for offers, and check your cart.</p>
    </div>
    <main>
      <h1>Hydra Barrier Cream</h1>
      <img src="/detail.jpg" data-ocr-text="보습 장벽 케어 niacinamide daily use FAQ" />
      <section class="pdp-benefits">
        <h2>Clinical Results</h2>
        <p>After 6 weeks, 100% showed improvement in Fine Lines &amp; Wrinkles, Elasticity, and Firmness.</p>
      </section>
      <section class="pdp-ingredient">
        <h2>Key Ingredients</h2>
        <p>Korean Ginseng Actives, Retinol, Peptide, and Niacinamide help support radiant skin texture.</p>
      </section>
      <div class="product-accordion">
        <button aria-controls="benefits-panel">BENEFITS</button>
        <div id="benefits-panel" hidden>
          <p>Strengthens the skin's rejuvenating abilities to show visible improvement in plumpness and wrinkles.</p>
        </div>
        <button aria-controls="ingredients-panel">INGREDIENTS</button>
        <div id="ingredients-panel" hidden>
          <p>KOREAN GINSENG ACTIVES - patented ingredient that amplifies anti-aging compounds found in Ginseng.</p>
          <p>INGREDIENTS: WATER / AQUA / EAU, BUTYLENE GLYCOL, GLYCERIN, NIACINAMIDE, RETINOL, PANAX GINSENG ROOT EXTRACT.</p>
        </div>
        <button aria-controls="how-to-use-panel">HOW TO USE</button>
        <div id="how-to-use-panel" hidden>
          <p>Apply two pumps morning and night after serum, then follow with moisturizer.</p>
        </div>
      </div>
      <details>
        <summary>Can I use it daily?</summary>
        Apply morning and night after serum.
      </details>
    </main>
  </body>
</html>
`;

describe("extractProductFromHtml", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses HTML accept headers for URL extraction even when JSON accept headers are provided", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Accept).toContain("text/html");
      return new Response(`
        <main>
          <h1>Hydra Barrier Cream</h1>
          <section>
            <h2>Ingredients</h2>
            <p>INGREDIENTS: WATER, GLYCERIN, NIACINAMIDE, PANAX GINSENG ROOT EXTRACT.</p>
          </section>
        </main>
      `, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = await extractProduct({
      sourceType: "url",
      source: "https://example.com/products/hydra-barrier-cream",
      headers: { Accept: "application/json" },
      aiProvider: "mock"
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.geoProduct.name).toBe("Hydra Barrier Cream");
    expect(result.geoProduct.ingredients.some((text) => text.includes("PANAX GINSENG ROOT EXTRACT"))).toBe(true);
  });

  it("normalizes product, review, OCR, and RAG data from PDP HTML", async () => {
    const { result, diagnostics } = await extractProductFromHtml(html, "https://example.com/products/hydra");

    expect(result.geoProduct.name).toBe("Hydra Barrier Cream");
    expect(result.geoProduct.price?.raw).toBe("32000");
    expect(result.geoProduct.reviews.rating).toBe(4.8);
    expect(result.geoProduct.ocr.keywords.benefit.length).toBeGreaterThan(0);
    expect(result.geoProduct.rag.chunks.some((chunk) => chunk.kind === "ocr")).toBe(true);
    expect(diagnostics.evidence.some((item) => item.field === "page.obstructionsRemoved")).toBe(true);
    expect(diagnostics.evidence.some((item) => item.field === "page.scrollSections")).toBe(true);
    expect(result.geoProduct.ocr.textBlocks.length).toBeGreaterThan(1);
    expect(result.geoProduct.ocr.textBlocks.some((text) => text.includes("After 6 weeks"))).toBe(true);
    expect(result.geoProduct.metrics.some((metric) => metric.includes("6 weeks"))).toBe(true);
    expect(result.geoProduct.benefits.some((text) => text.includes("rejuvenating abilities"))).toBe(true);
    expect(result.geoProduct.ingredients.some((text) => text.includes("KOREAN GINSENG ACTIVES"))).toBe(true);
    expect(result.geoProduct.ingredients.some((text) => text.includes("PANAX GINSENG ROOT EXTRACT"))).toBe(true);
    expect(result.geoProduct.usage.some((text) => text.includes("Apply two pumps"))).toBe(true);
    expect(result.geoProduct.rag.chunks.some((chunk) => chunk.kind === "ocr" && chunk.text.includes("Korean Ginseng"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("confidence");
    expect(result.geoProduct.sourceExtraction.ocr.imageTexts.some((item) => item.imageUrl.includes("detail.jpg"))).toBe(true);
    expect(result.geoProduct.aiAnalysis.keywords.ingredient).toContain("GINSENG");
    expect(result.geoProduct.categorizedProductInfo.ingredients.some((text) => text.includes("PANAX GINSENG ROOT EXTRACT"))).toBe(true);
    expect(result.geoProduct.customerReviewAnalysis.rating).toBe(4.8);
    expect(diagnostics.process.map((step) => step.id)).toEqual(["input", "fetch", "extract", "ocr", "review", "rag", "json"]);
    expect(diagnostics.process.find((step) => step.id === "json")?.status).toBe("done");
  });

  it("normalizes Shopify product JSON returned from a URL request", async () => {
    const { result, diagnostics } = await extractProductFromHtml(
      JSON.stringify({
        product: {
          id: 8084091011117,
          title: "Concentrated Ginseng Rejuvenating Serum",
          body_html: "<p>Unlock your skin's youthful radiance with Korean Ginseng Actives, Retinol, and Peptide. After 6 weeks, users showed improvement in fine lines and firmness.</p>",
          images: [{ src: "/serum.jpg" }],
          variants: [{ price: "215.00", title: "1.69 fl. oz. / 50 mL" }],
          options: [{ name: "Size", values: ["1.69 fl. oz. / 50 mL"] }]
        }
      }),
      "https://example.com/products/ginseng-serum"
    );

    expect(result.sourceType).toBe("url");
    expect(result.geoProduct.name).toBe("Concentrated Ginseng Rejuvenating Serum");
    expect(result.geoProduct.price?.raw).toBe("215.00");
    expect(result.geoProduct.description).toContain("Korean Ginseng");
    expect(result.geoProduct.images[0]).toBe("https://example.com/serum.jpg");
    expect(result.geoProduct.ocr.textBlocks.length).toBeGreaterThan(0);
    expect(result.geoProduct.metrics.some((metric) => metric.includes("6 weeks"))).toBe(true);
    expect(result.geoProduct.rag.chunks.some((chunk) => chunk.kind === "ocr" && chunk.text.includes("After 6 weeks"))).toBe(true);
    expect(diagnostics.evidence.some((item) => item.field === "url.jsonPayload")).toBe(true);
  });

  it("maps semantic object section keys from JSON payloads into product fields", async () => {
    const { result } = await extractProductFromHtml(
      JSON.stringify({
        product: {
          title: "Concentrated Ginseng Rejuvenating Serum",
          price: "215.00",
          sections: {
            BENEFITS: "Formulated with advanced capsule technology to improve plumpness, skin resilience, and fine lines. After 6 weeks, 100% of users showed improvement in elasticity and firmness.",
            INGREDIENTS: "KOREAN GINSENG ACTIVES - strengthens the skin's rejuvenating abilities. INGREDIENTS: WATER / AQUA / EAU, GLYCERIN, NIACINAMIDE, PANAX GINSENG ROOT EXTRACT, RETINOL.",
            "HOW TO USE": "Use morning and night after applying toner. Warm three pumps between fingers and apply to face and neck with upward motions."
          }
        }
      }),
      "https://example.com/products/ginseng-serum"
    );

    expect(result.geoProduct.benefits.some((text) => text.includes("advanced capsule technology"))).toBe(true);
    expect(result.geoProduct.ingredients.some((text) => text.includes("PANAX GINSENG ROOT EXTRACT"))).toBe(true);
    expect(result.geoProduct.usage.some((text) => text.includes("morning and night"))).toBe(true);
    expect(result.geoProduct.metrics).toEqual(expect.arrayContaining(["6 weeks", "100%"]));
    expect(result.geoProduct.contentAnalysis.sections.some((section) => section.title === "Benefits" && section.category === "benefit")).toBe(true);
    expect(result.geoProduct.contentAnalysis.sections.some((section) => section.title === "Ingredients" && section.category === "ingredient")).toBe(true);
    expect(result.geoProduct.contentAnalysis.sections.some((section) => section.title === "How To Use" && section.category === "usage")).toBe(true);
  });

  it("extracts product disclosures and review summaries from embedded client state JSON", async () => {
    const initialState = {
      productDetail: {
        productInfo: {
          onlineProdName: "자음생크림 리치 단품세트 50ml",
          linePromoDesc: "설화수 인삼 과학의 정수가 담긴 자음생 라인 제품으로 구성된 세트입니다. 피부 본연의 자생력으로 차오른 고밀도 피부를 선사합니다.",
          detailDesc: "<div><img src=\"/detail-rich-cream.jpg\" /></div>",
          onlineImages: [{ imgUrl: "/rich-cream-01.jpg" }],
          onlinePriceInfo: {
            currencyInfo: { isWon: true },
            priceInfo: { discountedPrice: 243000, beforeSalePrice: 270000 }
          },
          products: [{ prodName: "자음생크림 리치 단품세트" }],
          disclosures: [
            {
              disclosureItemName: "사용방법",
              prodDisclosureInfo: "아침, 저녁 적당량을 취해 얼굴 안쪽에서 바깥쪽으로 펴 발라 준 후 가볍게 눌러주며 흡수시켜 줍니다."
            },
            {
              disclosureItemName: "｢화장품법｣에 따라 기재ㆍ표시하여야 하는 모든 성분",
              prodDisclosureInfo: "정제수, 글리세린, 스쿠알란, 부틸렌글라이콜, 인삼추출물, 하이드롤라이즈드홍삼사포닌, 레티놀, 소듐하이알루로네이트, 아세틸헵타펩타이드-4, 아세틸옥타펩타이드-3"
            }
          ],
          reviewInfo: {
            reviewScope: 4.914702581369248,
            reviewCount: 891,
            shortSummary: "리치 보습·탄력 크림이 순하게 잘 흡수돼 만족해요.",
            longSummary: "리치한 보습 크림이 끈적임 없이 흡수돼 탄력·주름 개선을 돕고, 겨울철 건성·민감 피부도 편안해 만족도가 높다는 후기가 많아요."
          }
        }
      }
    };
    const nextDataHtml = `
      <html>
        <head>
          <script id="__NEXT_DATA__" type="application/json">
            ${JSON.stringify({ props: { pageProps: { initialState: JSON.stringify(initialState) } } })}
          </script>
        </head>
        <body><main></main></body>
      </html>
    `;

    const { result, diagnostics } = await extractProductFromHtml(nextDataHtml, "https://example.com/products/rich-cream");

    expect(result.geoProduct.name).toBe("자음생크림 리치 단품세트 50ml");
    expect(result.geoProduct.price?.raw).toBe("243000");
    expect(result.geoProduct.price?.currency).toBe("KRW");
    expect(result.geoProduct.images).toEqual(expect.arrayContaining([
      "https://example.com/rich-cream-01.jpg",
      "https://example.com/detail-rich-cream.jpg"
    ]));
    expect(result.geoProduct.ingredients.some((text) => text.includes("아세틸옥타펩타이드-3"))).toBe(true);
    expect(result.geoProduct.usage.some((text) => text.includes("아침, 저녁"))).toBe(true);
    expect(result.geoProduct.reviews.rating).toBe(4.914702581369248);
    expect(result.geoProduct.reviews.reviewCount).toBe(891);
    expect(result.geoProduct.customerReviewAnalysis.items.some((item) => item.body.includes("리치한 보습 크림"))).toBe(true);
    expect(result.geoProduct.contentAnalysis.sections.some((section) => section.category === "ingredient" && section.text.includes("인삼추출물"))).toBe(true);
    expect(result.geoProduct.contentAnalysis.sections.some((section) => section.category === "review" && section.text.includes("만족도가 높다"))).toBe(true);
    expect(diagnostics.evidence.some((item) => item.field === "page.clientStateProductData")).toBe(true);
  });

  it("preserves OCR clinical result text and classifies metrics and effects", async () => {
    const clinicalOcrHtml = `
      <main>
        <h1>Concentrated Ginseng Rejuvenating Serum</h1>
        <img
          src="/clinical.jpg"
          data-ocr-text="AFTER 6 WEEKS OF USE
AGREED SKIN FEELS FIRMER AND MORE ELASTIC 100%
AGREED SKIN TEXTURE FEELS IMPROVED AND MORE EVEN 100%
AGREED FINE LINES AND WRINKLES FEEL DIMINISHED 93%"
        />
      </main>
    `;

    const { result } = await extractProductFromHtml(clinicalOcrHtml, "https://example.com/products/ginseng-serum");
    const ocrText = result.geoProduct.sourceExtraction.ocr.imageTexts[0]?.text ?? "";

    expect(ocrText).toContain("AFTER 6 WEEKS OF USE\nAGREED SKIN FEELS FIRMER");
    expect(result.geoProduct.metrics).toEqual(expect.arrayContaining(["6 WEEKS", "100%", "93%"]));
    expect(result.geoProduct.aiAnalysis.keywords.metric).toEqual(expect.arrayContaining(["6 WEEKS", "100%", "93%"]));
    expect(result.geoProduct.aiAnalysis.keywords.effect).toEqual(expect.arrayContaining(["FIRMER", "TEXTURE", "WRINKLES"]));
    expect(result.geoProduct.contentAnalysis.sections.some((section) => section.category === "effect" && section.text.includes("FINE LINES"))).toBe(true);
  });

  it("analyzes DOM-only ingredients, efficacy, usage, reviews, and rating content", async () => {
    const domOnlyHtml = `
      <main>
        <h1>Bright Repair Ampoule</h1>
        <p class="price">$58.00</p>
        <section>
          <h2>Benefits</h2>
          <ul>
            <li>Improves visible dullness and supports brighter-looking skin.</li>
            <li>Helps strengthen the moisture barrier after 2 weeks.</li>
          </ul>
        </section>
        <section>
          <h2>Ingredients</h2>
          <p>INGREDIENTS: WATER, GLYCERIN, NIACINAMIDE, VITAMIN C, PANTHENOL, HYALURONIC ACID.</p>
        </section>
        <section>
          <h2>How to use</h2>
          <ol>
            <li>Apply 2-3 drops after toner.</li>
            <li>Use morning and night, then follow with sunscreen during the day.</li>
          </ol>
        </section>
        <section class="reviews">
          <div class="rating-summary" aria-label="4.6 out of 5 stars">4.6</div>
          <span class="review-count">128 reviews</span>
          <article class="review-card">
            <span class="stars" aria-label="5 stars"></span>
            <p class="review-text">My skin looked brighter and smoother after a week. The texture absorbs quickly.</p>
            <span class="author">Mina</span>
            <time datetime="2026-05-01">May 1, 2026</time>
          </article>
        </section>
      </main>
    `;

    const { result } = await extractProductFromHtml(domOnlyHtml, "https://example.com/products/bright-ampoule");

    expect(result.geoProduct.name).toBe("Bright Repair Ampoule");
    expect(result.geoProduct.price?.raw).toBe("$58.00");
    expect(result.geoProduct.benefits.some((text) => text.includes("visible dullness"))).toBe(true);
    expect(result.geoProduct.ingredients.some((text) => text.includes("NIACINAMIDE"))).toBe(true);
    expect(result.geoProduct.usage.some((text) => text.includes("Apply 2-3 drops"))).toBe(true);
    expect(result.geoProduct.metrics).toEqual(expect.arrayContaining(["2 weeks", "2-3 drops"]));
    expect(result.geoProduct.reviews.rating).toBe(4.6);
    expect(result.geoProduct.reviews.reviewCount).toBe(128);
    expect(result.geoProduct.reviews.items[0]?.rating).toBe(5);
    expect(result.geoProduct.reviews.items[0]?.author).toBe("Mina");
    expect(result.geoProduct.contentAnalysis.ratingSummary).toBe("Rating 4.6 · 128 reviews");
    expect(result.geoProduct.contentAnalysis.sections.some((section) => section.category === "ingredient" && section.text.includes("VITAMIN C"))).toBe(true);
    expect(result.geoProduct.contentAnalysis.sections.some((section) => section.category === "review" && section.text.includes("brighter and smoother"))).toBe(true);
  });

  it("preserves Shopify theme product metadata sections from embedded scripts", async () => {
    const shopifyThemeHtml = `
      <main>
        <h1>Concentrated Ginseng Rejuvenating Serum</h1>
        <p>Unlock your skin's youthful radiance with our Concentrated Ginseng Rejuvenating Serum.</p>
      </main>
      <script>
        theme.products.update({
          id: 111,
          title: "Concentrated Ginseng Rejuvenating Cream",
          handle: "concentrated-ginseng-rejuvenating-cream",
          benefits: "Cream-only 24-hour hydration benefit should not be selected.",
          ingredients: "CREAM INGREDIENTS: WATER, GLYCERIN"
        });
        theme.products.update({
          id: 8084091011117,
          title: "Concentrated Ginseng Rejuvenating Serum",
          handle: "concentrated-ginseng-rejuvenating-serum",
          benefits: "Formulated with our advanced capsule technology, enriched with Korean Ginseng Actives and Retinol. This powerhouse serum melts into skin on contact improving the look of plumpness, skin resilience, and fine lines and wrinkles. <br><br><b>After 6 weeks of use</b><br>100% of users showed improvement in Fine Lines & Wrinkles, Elasticity, and Firmness.",
          ingredients: "KOREAN GINSENG ACTIVES - patented ingredient that amplifies anti-aging compounds found in Ginseng.<br>GINSENG CAPSULES WITH RETINOL - helps improve moisturization, firmness, and rejuvenating abilities.<br><br>INGREDIENTS: WATER / AQUA / EAU, BUTYLENE GLYCOL, GLYCERIN, NIACINAMIDE, PANAX GINSENG ROOT EXTRACT, RETINOL.",
          howToUse: "<p>Apply two pumps morning and night after cleansing and toning, then follow with moisturizer.</p>"
        });
      </script>
    `;

    const { result, diagnostics } = await extractProductFromHtml(
      shopifyThemeHtml,
      "https://us.sulwhasoo.com/products/concentrated-ginseng-rejuvenating-serum?variant=43202379841581"
    );
    const productText = [
      ...result.geoProduct.benefits,
      ...result.geoProduct.ingredients,
      ...result.geoProduct.usage,
      ...result.geoProduct.ocr.textBlocks
    ].join(" ");

    expect(result.geoProduct.benefits.some((text) => text.includes("advanced capsule technology"))).toBe(true);
    expect(result.geoProduct.ingredients.some((text) => text.includes("PANAX GINSENG ROOT EXTRACT"))).toBe(true);
    expect(result.geoProduct.usage.some((text) => text.includes("Apply two pumps"))).toBe(true);
    expect(result.geoProduct.metrics).toEqual(expect.arrayContaining(["6 weeks", "100%"]));
    expect(result.geoProduct.contentAnalysis.sections.some((section) => section.title === "BENEFITS" && section.text.includes("plumpness"))).toBe(true);
    expect(result.geoProduct.contentAnalysis.sections.some((section) => section.title === "INGREDIENTS" && section.text.includes("NIACINAMIDE"))).toBe(true);
    expect(result.geoProduct.contentAnalysis.sections.some((section) => section.title === "HOW TO USE" && section.text.includes("morning and night"))).toBe(true);
    expect(productText).not.toContain("Cream-only 24-hour hydration");
    expect(diagnostics.evidence.some((item) => item.field === "page.embeddedProductSections")).toBe(true);
  });

  it("extracts FAQ accordion answers and uses apply-related answers as usage fallback", async () => {
    const faqAccordionHtml = `
      <main>
        <h1>Concentrated Ginseng Rejuvenating Serum</h1>
        <p>Retinol-infused capsules visibly improve firmness and texture.</p>
        <div class="accordion">
          <button class="accordion__trigger" aria-controls="accordion-panel-usage">
            <span class="accordion__title">Should I apply it before or after moisturizers?</span>
          </button>
          <div class="accordion__content" id="accordion-panel-usage">
            <p>Concentrated Ginseng Rejuvenating Serum should be applied after cleansing and toning, and before moisturizing. Apply moisturizer as the final step of your skincare ritual.</p>
          </div>
        </div>
      </main>
    `;

    const { result } = await extractProductFromHtml(faqAccordionHtml, "https://example.com/products/ginseng-serum");

    expect(result.geoProduct.faq[0]?.question).toContain("Should I apply");
    expect(result.geoProduct.faq[0]?.answer).toContain("after cleansing and toning");
    expect(result.geoProduct.usage.some((text) => text.includes("after cleansing and toning"))).toBe(true);
    expect(result.geoProduct.rag.chunks.some((chunk) => chunk.kind === "faq" && chunk.text.includes("before moisturizing"))).toBe(true);
  });

  it("does not classify purchase, benefit-layer, delivery, or return policy UI as product fields", async () => {
    const commerceHeavyHtml = `
      <main>
        <h1>자음생크림 리치 단품세트</h1>
        <meta property="product:price:amount" content="270000" />
        <p class="summary">설화수 인삼 과학의 정수가 담긴 자음생 라인 제품입니다. 피부 본연의 자생력으로 차오른 고밀도 피부를 선사합니다.</p>
        <select>
          <option>자음생크림 리치 단품세트</option>
        </select>
        <div class="option-layer">
          레이어 끌기 버튼 자음생크림 리치 단품세트 제품 수량 감소 01 제품 수량 증가 10% 243,000원 총 상품가 243,000원 혜택 적용가 243,000원 장바구니 구매하기
        </div>
        <section>
          <h2>효능</h2>
          <p>피부 본연의 자생력을 높이고 탄탄한 고밀도 피부와 영양감을 선사합니다.</p>
        </section>
        <section>
          <h2>주요 성분</h2>
          <p>진세노믹스와 인삼 펩타이드가 피부 탄력과 영양 케어를 돕습니다.</p>
        </section>
        <section>
          <h2>사용법</h2>
          <p>아침과 저녁 스킨케어 마지막 단계에서 얼굴과 목에 부드럽게 펴 발라줍니다.</p>
        </section>
        <section>
          <h2>배송/교환/반품 안내</h2>
          <p>배송비 할인 적용 후 최종 결제금액 20,000원 이상 구매시 무료배송입니다. 교환 및 반품 신청에는 사유에 따라 배송비 2,500~5,000원이 부과됩니다. 반품 접수가 완료되면 택배기사님이 방문합니다.</p>
        </section>
        <div class="layer">
          레이어 끌기 버튼 뷰티포인트 적립/사용 제외 상품 적립 제외 상품 (0) 사용 제외 상품 (0) 레이어 닫기
        </div>
      </main>
    `;

    const { result } = await extractProductFromHtml(commerceHeavyHtml, "https://example.com/products/ginseng-cream");
    const productFieldText = [
      ...result.geoProduct.options,
      ...result.geoProduct.benefits,
      ...result.geoProduct.effects,
      ...result.geoProduct.ingredients,
      ...result.geoProduct.usage,
      ...result.geoProduct.metrics,
      ...result.geoProduct.ocr.textBlocks
    ].join(" ");

    expect(result.geoProduct.options).toEqual(["자음생크림 리치 단품세트"]);
    expect(result.geoProduct.benefits.some((text) => text.includes("고밀도 피부"))).toBe(true);
    expect(result.geoProduct.ingredients.some((text) => text.includes("인삼 펩타이드"))).toBe(true);
    expect(result.geoProduct.usage.some((text) => text.includes("스킨케어 마지막 단계"))).toBe(true);
    expect(result.geoProduct.metrics).not.toContain("10%");
    expect(productFieldText).not.toMatch(/반품|배송비|장바구니|구매하기|혜택 적용가|레이어/);
  });
});
