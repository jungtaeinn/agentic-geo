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

  it("normalizes product, review, HTML sections, OCR, and RAG data from PDP HTML", async () => {
    const { result, diagnostics } = await extractProductFromHtml(html, "https://example.com/products/hydra");

    expect(result.geoProduct.name).toBe("Hydra Barrier Cream");
    expect(result.geoProduct.price?.raw).toBe("32000");
    expect(result.geoProduct.reviews.rating).toBe(4.8);
    expect(result.geoProduct.ocr.keywords.benefit.length).toBeGreaterThan(0);
    expect(result.geoProduct.rag.chunks.some((chunk) => chunk.kind === "ocr")).toBe(true);
    expect(diagnostics.evidence.some((item) => item.field === "page.obstructionsRemoved")).toBe(true);
    expect(diagnostics.evidence.some((item) => item.field === "page.scrollSections")).toBe(true);
    expect(result.geoProduct.ocr.textBlocks.length).toBeGreaterThan(0);
    expect(result.geoProduct.sourceExtraction.html.sections.some((section) => section.text.includes("After 6 weeks"))).toBe(true);
    expect(result.geoProduct.ocr.textBlocks.some((text) => text.includes("After 6 weeks"))).toBe(false);
    expect(result.geoProduct.metrics.some((metric) => metric.includes("6 weeks"))).toBe(true);
    expect(result.geoProduct.benefits.some((text) => text.includes("rejuvenating abilities"))).toBe(true);
    expect(result.geoProduct.ingredients.some((text) => text.includes("KOREAN GINSENG ACTIVES"))).toBe(true);
    expect(result.geoProduct.ingredients.some((text) => text.includes("PANAX GINSENG ROOT EXTRACT"))).toBe(true);
    expect(result.geoProduct.usage.some((text) => text.includes("Apply two pumps"))).toBe(true);
    expect(result.geoProduct.rag.chunks.some((chunk) => chunk.kind === "source" && chunk.text.includes("Korean Ginseng"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("confidence");
    expect(result.geoProduct.sourceExtraction.ocr.imageTexts.some((item) => item.imageUrl.includes("detail.jpg"))).toBe(true);
    expect(result.geoProduct.aiAnalysis.keywords.ingredient.some((keyword) => keyword.toLowerCase() === "ginseng")).toBe(true);
    expect(result.geoProduct.categorizedProductInfo.ingredients.some((text) => text.includes("PANAX GINSENG ROOT EXTRACT"))).toBe(true);
    expect(result.geoProduct.customerReviewAnalysis.rating).toBe(4.8);
    expect(diagnostics.process.map((step) => step.id)).toEqual(["input", "fetch", "extract", "ocr", "review", "rag", "json"]);
    expect(diagnostics.process.find((step) => step.id === "json")?.status).toBe("done");
  });

  it("keeps source-backed brand separate from SKU-heavy product names", async () => {
    const skuHeavyHtml = `
      <!doctype html>
      <html>
        <head>
          <title>[Source Beauty][Mini] Renewal Cream 30ml</title>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "Product",
              "name": "[Source Beauty][Mini] Renewal Cream 30ml",
              "brand": { "@type": "Brand", "name": "Source Beauty" },
              "description": "Renewal cream for firming and hydration care.",
              "offers": { "@type": "Offer", "price": "168000", "priceCurrency": "KRW" }
            }
          </script>
        </head>
        <body>
          <main>
            <a href="/brand/source-beauty">Source Beauty</a>
            <h1>[Source Beauty][Mini] Renewal Cream 30ml</h1>
            <section>
              <h2>Key Ingredients</h2>
              <p>Peptide complex and vitamin derivative support firming care.</p>
            </section>
          </main>
        </body>
      </html>
    `;

    const { result, diagnostics } = await extractProductFromHtml(skuHeavyHtml, "https://example.com/products/renewal-cream");

    expect(result.geoProduct.name).toBe("[Source Beauty][Mini] Renewal Cream 30ml");
    expect(result.geoProduct.brand).toBe("Source Beauty");
    expect(diagnostics.evidence.some((item) => item.field === "product.brand" && item.value === "Source Beauty")).toBe(true);
  });

  it("uses an optional product profile normalization agent before OCR and RAG extraction", async () => {
    const rawPayload = {
      upstreamPayload: {
        displayLabel: "Agentic Repair Serum",
        storyLine: "Agentic Repair Serum supports moisture barrier hydration with Ceramide.",
        activeBlob: "Ceramide",
        benefitCopy: "moisture barrier hydration support",
        ritualCopy: "Apply after toner."
      }
    };

    const { result, diagnostics } = await extractProductFromHtml(
      JSON.stringify(rawPayload),
      "https://example.com/products/agentic-repair-serum",
      {
        customProductNormalizer: {
          async normalizeProductProfile(request) {
            expect(request.bootstrapProduct.name).toBe("Untitled product");
            expect(request.analysisPrompt).toContain("typed RAG index");
            expect(request.ragDocuments?.some((document) => document.name === "product-normalization_v1.md")).toBe(true);
            return {
              product: {
                name: "Agentic Repair Serum",
                description: "Agentic Repair Serum supports moisture barrier hydration with Ceramide.",
                benefits: ["moisture barrier hydration support"],
                ingredients: ["Ceramide"],
                usage: ["Apply after toner."]
              },
              usage: {
                inputTokens: 25,
                outputTokens: 15,
                totalTokens: 40
              }
            };
          }
        }
      }
    );

    const normalizationStep = diagnostics.runtimeUsage?.steps.find((step) => step.label === "Product profile normalization/reasoning");

    expect(result.geoProduct.name).toBe("Agentic Repair Serum");
    expect(result.geoProduct.description).toContain("Ceramide");
    expect(result.geoProduct.benefits).toContain("moisture barrier hydration support");
    expect(result.geoProduct.ingredients).toContain("Ceramide");
    expect(result.geoProduct.usage).toContain("Apply after toner.");
    expect(diagnostics.evidence.some((item) => item.field === "product.normalization" && item.source === "llm")).toBe(true);
    expect(normalizationStep?.called).toBe(true);
    expect(normalizationStep?.tokenUsage?.totalTokens).toBe(40);
    expect(diagnostics.runtimeUsage?.tokenTotals.totalTokens).toBe(40);
  });

  it("keeps HTML ingredient lists out of OCR sentence diagnostics", async () => {
    const ingredientList = [
      "WATER / AQUA / EAU",
      "POTASSIUM COCOYL GLYCINATE",
      "DISODIUM COCOAMPHODIACETATE",
      "COCAMIDOPROPYL BETAINE",
      "ACRYLATES/BEHENETH-25 METHACRYLATE COPOLYMER",
      "PEG-200 HYDROGENATED GLYCERYL PALMATE",
      "SODIUM CHLORIDE",
      "PENTYLENE GLYCOL",
      "1,2-HEXANEDIOL",
      "SODIUM METHYL COCOYL TAURATE",
      "CAPRYLYL/CAPRYL GLUCOSIDE",
      "PEG-7 GLYCERYL COCOATE",
      "FRAGRANCE / PARFUM",
      "ISOSTEARIC ACID",
      "POTASSIUM HYDROXIDE",
      "BUTYLENE GLYCOL",
      "LIMONENE",
      "DISODIUM EDTA",
      "ETHYLHEXYLGLYCERIN",
      "SODIUM BENZOATE",
      "TETRASODIUM EDTA",
      "COIX LACRYMA-JOBI MA-YUEN SEED EXTRACT",
      "CITRUS UNSHIU PEEL EXTRACT"
    ].join(", ");
    const ingredientHtml = `
      <main>
        <h1>Gentle Cleansing Foam</h1>
        <section class="ingredients">
          <h2>Ingredients</h2>
          <p>${ingredientList}</p>
        </section>
      </main>
    `;

    const { result } = await extractProductFromHtml(ingredientHtml, "https://example.com/products/gentle-cleansing-foam");

    expect(result.geoProduct.ingredients.some((text) => text.includes("CITRUS UNSHIU PEEL EXTRACT"))).toBe(true);
    expect(result.geoProduct.sourceExtraction.html.sections.some((section) => section.text.includes("CITRUS UNSHIU PEEL EXTRACT"))).toBe(true);
    expect(result.geoProduct.rag.chunks.some((chunk) => chunk.kind === "source" && chunk.text.includes("CITRUS UNSHIU PEEL EXTRACT"))).toBe(true);
    expect(result.geoProduct.sourceExtraction.ocr.textBlocks.some((text) => text.includes("WATER / AQUA"))).toBe(false);
    expect(result.geoProduct.ocr.sentenceInsights.some((item) => item.text.includes("WATER / AQUA"))).toBe(false);
  });

  it("preserves Korean full ingredient accordion sections as ingredient data", async () => {
    const koreanFullIngredients = [
      "정제수",
      "부틸렌글라이콜",
      "글리세린",
      "프로판다이올",
      "1,2-헥산다이올",
      "식물성스쿠알란",
      "세테아릴알코올",
      "하이드록시프로필스타치포스페이트",
      "잔탄검",
      "글리세릴스테아레이트",
      "하이드로제네이티드레시틴",
      "아크릴레이트/C10-30알킬아크릴레이트크로스폴리머",
      "아세틸글루코사민",
      "스테아릭애씨드",
      "글리세릴스테아레이트시트레이트",
      "판테놀",
      "글루코노락톤",
      "카보머",
      "콜레스테롤",
      "세라마이드엔피",
      "토코페롤"
    ].join(", ");
    const koreanAccordionHtml = `
      <main>
        <h1>에스트라 아토베리어365 바디로션</h1>
        <p>건조로 민감해진 피부장벽을 강화하여 하루종일 촉촉함을 유지시켜주는 고보습 바디로션</p>
        <div class="product-accordion">
          <button aria-controls="full-ingredients-panel">전성분</button>
          <div id="full-ingredients-panel">
            <p>${koreanFullIngredients}</p>
          </div>
        </div>
      </main>
    `;

    const { result } = await extractProductFromHtml(koreanAccordionHtml, "https://example.com/products/body-lotion");

    expect(result.geoProduct.ingredients.some((text) => text.includes("세라마이드엔피"))).toBe(true);
    expect(result.geoProduct.categorizedProductInfo.ingredients.some((text) => text.includes("아크릴레이트/C10-30알킬아크릴레이트크로스폴리머"))).toBe(true);
    expect(result.geoProduct.contentAnalysis.sections.some((section) =>
      section.category === "ingredient"
      && section.title === "전성분"
      && section.text.includes("글루코노락톤")
    )).toBe(true);
    expect(result.geoProduct.rag.chunks.some((chunk) =>
      chunk.kind === "source"
      && chunk.text.includes("전성분")
      && chunk.text.includes("세라마이드엔피")
    )).toBe(true);
  });

  it("does not treat visual alt text as OCR sentence evidence", async () => {
    const visualAltHtml = `
      <main>
        <h1>Gentle Cleansing Foam</h1>
        <img
          src="/model-applying-cleanser.png"
          alt="Sulwhasoo Gentle Cleansing Foam, facial cleanser, model applying product to face"
        />
      </main>
    `;

    const { result } = await extractProductFromHtml(visualAltHtml, "https://example.com/products/gentle-cleansing-foam");

    expect(result.geoProduct.sourceExtraction.ocr.imageTexts.some((item) => item.text.includes("model applying product"))).toBe(false);
    expect(result.geoProduct.ocr.sentenceInsights.some((item) => item.text.includes("model applying product"))).toBe(false);
  });

  it("includes runtime RAG profile prompt and documents in the final chunks", async () => {
    const { result } = await extractProductFromHtml(
      html,
      "https://example.com/products/hydra",
      {
        analysisPrompt: "Runtime extraction prompt for PDP benefit classification.",
        ragDocuments: [
          {
            name: "runtime-rag-rules_v1.md",
            content: "Runtime RAG document content for downstream GEO audit."
          }
        ]
      }
    );

    expect(result.geoProduct.rag.chunks.some((chunk) =>
      chunk.id === "rag-profile-analysis-prompt"
      && chunk.text.includes("Runtime extraction prompt")
    )).toBe(true);
    expect(result.geoProduct.rag.chunks.some((chunk) =>
      chunk.id === "rag-profile-file-1"
      && chunk.text.includes("Runtime RAG document content")
    )).toBe(true);
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

  it("prefers product metadata that matches the URL handle over stale embedded records", async () => {
    const staleStateHtml = `
      <html>
        <head>
          <title>Concentrated Ginseng Rejuvenating Serum | Korean Skincare | Sulwhasoo</title>
          <meta property="og:title" content="Concentrated Ginseng Rejuvenating Serum" />
          <meta name="description" content="A concentrated ginseng serum that supports visibly firmer, resilient skin." />
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "Product",
              "name": "First Care Activating Serum VI",
              "description": "First Care Activating Serum VI is a different serum for first-step hydration.",
              "image": ["/wrong-serum.jpg"]
            }
          </script>
          <script id="__NEXT_DATA__" type="application/json">
            ${JSON.stringify({
              props: {
                pageProps: {
                  initialState: JSON.stringify({
                    productDetail: {
                      staleProduct: {
                        handle: "first-care-activating-serum-vi",
                        productName: "First Care Activating Serum VI",
                        linePromoDesc: "First Care Activating Serum VI is a first-step hydration serum.",
                        images: [{ src: "/first-care.jpg" }]
                      },
                      currentProduct: {
                        handle: "concentrated-ginseng-rejuvenating-serum",
                        productName: "Concentrated Ginseng Rejuvenating Serum",
                        linePromoDesc: "Korean Ginseng serum with retinol capsules helps skin look firmer, smoother, and more resilient.",
                        priceInfo: { price: "215.00" },
                        images: [{ src: "/concentrated-ginseng-serum.jpg" }]
                      }
                    }
                  })
                }
              }
            })}
          </script>
        </head>
        <body>
          <main>
            <h1>Concentrated Ginseng Rejuvenating Serum</h1>
            <section>
              <h2>Benefits</h2>
              <p>After 6 weeks, fine lines, wrinkles, elasticity, and firmness visibly improve.</p>
            </section>
          </main>
        </body>
      </html>
    `;

    const { result } = await extractProductFromHtml(
      staleStateHtml,
      "https://us.sulwhasoo.com/products/concentrated-ginseng-rejuvenating-serum?variant=43202379841581"
    );

    expect(result.geoProduct.name).toBe("Concentrated Ginseng Rejuvenating Serum");
    expect(result.geoProduct.description).toContain("ginseng serum");
    expect(result.geoProduct.description).not.toContain("First Care");
    expect(result.geoProduct.price?.raw).toBe("215.00");
    expect(result.geoProduct.images).toContain("https://us.sulwhasoo.com/concentrated-ginseng-serum.jpg");
    expect(JSON.stringify(result.geoProduct)).not.toContain("First Care Activating Serum VI");
  });

  it("prefers the URL handle name when a page candidate expands that exact handle with extra tail words", async () => {
    const mixedNameHtml = `
      <html>
        <head>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "Product",
              "name": "Gentle Cleansing Foam hydration Serum",
              "description": "A gentle cleansing foam that lathers into a rich foam to remove impurities without leaving skin feeling dry.",
              "image": ["/gentle-cleansing-foam.jpg"]
            }
          </script>
        </head>
        <body>
          <main>
            <section>
              <h2>How to use</h2>
              <p>Lather two pumps of cleansing foam and massage into damp skin, then rinse with lukewarm water.</p>
            </section>
          </main>
        </body>
      </html>
    `;

    const { result, diagnostics } = await extractProductFromHtml(
      mixedNameHtml,
      "https://us.sulwhasoo.com/products/gentle-cleansing-foam?variant=41663478792237"
    );

    expect(result.geoProduct.name).toBe("Gentle Cleansing Foam");
    expect(diagnostics.evidence.find((item) => item.field === "product.name")).toMatchObject({
      source: "url",
      value: "Gentle Cleansing Foam"
    });
    expect(JSON.stringify(result.geoProduct)).not.toContain("Gentle Cleansing Foam hydration Serum");
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

  it("reconstructs OCR visual copy into sentence-level ingredient and effect evidence", async () => {
    const peptideOcrHtml = `
      <main>
        <h1>Concentrated Ginseng Rejuvenating Serum</h1>
        <img
          src="/ginseng-peptide.jpg"
          data-ocr-text="Maximizing Effects with Ginseng Peptide™
Ginseng Peptide™ is a 6-peptide blend that combines a potent ginseng-extracted peptide with 5 other peptides. This advanced formula, working synergistically with Korean Ginseng Actives, enhances skin firmness, elasticity, and resilience, helping to diminish visible signs of aging.
INGREDIENTS: WATER / AQUA / EAU, GLYCERIN, NIACINAMIDE, PANAX GINSENG ROOT EXTRACT, GINSENG PEPTIDE, RETINOL."
        />
      </main>
    `;

    const { result } = await extractProductFromHtml(peptideOcrHtml, "https://example.com/products/ginseng-serum");

    expect(result.geoProduct.ocr.sentenceInsights.some((item) => item.text.includes("6-peptide blend") && item.category === "ingredient")).toBe(true);
    expect(result.geoProduct.ocr.sentenceInsights.some((item) => item.text.includes("enhances skin firmness") && item.category === "effect")).toBe(true);
    expect(result.geoProduct.ingredients.some((text) => text.includes("6-peptide blend"))).toBe(true);
    expect(result.geoProduct.effects.some((text) => text.includes("enhances skin firmness"))).toBe(true);
    expect(result.geoProduct.ingredients.some((text) => text.includes("INGREDIENTS: WATER / AQUA"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("confidence");
  });

  it("joins wrapped OCR lines into semantic sentence insights when punctuation is missing", async () => {
    const wrappedOcrHtml = `
      <main>
        <h1>Concentrated Ginseng Rejuvenating Serum</h1>
        <img
          src="/wrapped-ginseng-peptide.jpg"
          data-ocr-text="Maximizing Effects with
Ginseng Peptide™
Ginseng Peptide™ is a 6-peptide blend that combines a potent
ginseng-extracted peptide with 5 other peptides This advanced formula
working synergistically with Korean Ginseng Actives enhances skin firmness
elasticity and resilience helping to diminish visible signs of aging"
        />
      </main>
    `;

    const { result } = await extractProductFromHtml(wrappedOcrHtml, "https://example.com/products/ginseng-serum");
    const insights = result.geoProduct.ocr.sentenceInsights.map((item) => item.text);

    expect(insights.some((text) =>
      text.includes("combines a potent ginseng-extracted peptide with 5 other peptides This advanced formula")
      && text.includes("enhances skin firmness elasticity and resilience")
    )).toBe(true);
    expect(insights).not.toContain("ginseng-extracted peptide with 5 other peptides This advanced formula");
  });

  it("sends English product-detail section images to vision OCR before review images", async () => {
    const sentImageUrls: string[] = [];
    const detailImages = Array.from({ length: 16 }, (_, index) =>
      `https://cdn.example.com/pdp/technical-description/detail-section-${index + 1}.png?ver=2026061802`
    );
    const htmlWithManyImages = `
      <main>
        <h1>Barrier Hydro Soothing Cream</h1>
        <section class="product-detail technical-description ingredient-technology">
          <h2>Technical Ingredients</h2>
          ${detailImages.slice(0, 8).map((src) => `<img data-lazy-src="${src}" />`).join("\n")}
          <picture>
            <source data-srcset="${detailImages.slice(8, 13).map((src, index) => `${src} ${index + 1}x`).join(", ")}" />
          </picture>
        </section>
        <img src="https://images-kr.amoremall.com/fileupload/reviews/2026/06/18/review.jpg?format=webp" />
      </main>
      <script>
        window.__PRODUCT__ = {
          productName: "Barrier Hydro Soothing Cream",
          detailDesc: ${JSON.stringify(detailImages.slice(13).map((src) => `<img data-src="${src}" />`).join(""))}
        };
      </script>
    `;
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const content = body.input?.[0]?.content;
      const imageParts = Array.isArray(content) ? content.filter((part: { type?: string }) => part.type === "input_image") : [];

      if (imageParts.length > 0) {
        sentImageUrls.push(...imageParts.map((part: { image_url: string }) => part.image_url));
        return new Response(JSON.stringify({
          output_text: JSON.stringify({
            images: [
              {
                imageUrl: detailImages[0],
                text: "Compressed Hyaluronic Acid\nPatented technology compresses hyaluronic acid to 1/100 size for fast moisture charging and lasting hydration"
              },
              {
                imageUrl: detailImages[1],
                text: "High-density Ceramide Capsule\nLong-chain ceramide and linker ceramide help reinforce skin barrier moisture for sensitive skin"
              }
            ]
          })
        }), { status: 200 });
      }

      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          keywords: [
            { keyword: "Compressed Hyaluronic Acid", category: "ingredient", confidence: 0.9, source: "llm" },
            { keyword: "lasting hydration", category: "benefit", confidence: 0.9, source: "llm" },
            { keyword: "High-density Ceramide Capsule", category: "ingredient", confidence: 0.9, source: "llm" },
            { keyword: "skin barrier moisture", category: "benefit", confidence: 0.9, source: "llm" }
          ],
          sentenceInsights: [],
          summary: "classified"
        })
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result, diagnostics } = await extractProductFromHtml(
      htmlWithManyImages,
      "https://brand.example.com/products/barrier-hydro-soothing-cream",
      { provider: "openai", apiKey: "test-key", model: "gpt-5.4-mini" }
    );

    expect(diagnostics.evidence).toContainEqual({ field: "runtime.provider", source: "api", value: "openai" });
    expect(sentImageUrls.length).toBeGreaterThan(10);
    expect(sentImageUrls).toEqual(expect.arrayContaining([detailImages[0], detailImages[12]]));
    expect(sentImageUrls).not.toContain(detailImages[15]);
    expect(sentImageUrls.some((url) => /fileupload\/reviews/i.test(url))).toBe(false);
    expect(result.geoProduct.ocr.textBlocks.join(" ")).toContain("Compressed Hyaluronic Acid");
    expect(result.geoProduct.ocr.sentenceInsights.some((item) => item.text.includes("Compressed Hyaluronic Acid") && item.category === "ingredient")).toBe(true);
    expect(result.geoProduct.ocr.sentenceInsights.some((item) => item.text.includes("High-density Ceramide Capsule"))).toBe(true);
    expect(result.geoProduct.ingredients.some((text) => text.includes("Compressed Hyaluronic Acid"))).toBe(true);
    expect(result.geoProduct.benefits.some((text) => text.includes("skin barrier moisture") || text.includes("lasting hydration"))).toBe(true);
    expect(diagnostics.warnings.some((warning) => warning.code === "IMAGE_OCR_PROVIDER_NOT_CONFIGURED")).toBe(false);
  });

  it("caps product-detail image OCR targets while preserving page-order evidence", async () => {
    const detailImages = Array.from({ length: 30 }, (_, index) =>
      `https://cdn.example.com/pdp/technical-description/detail-section-${index + 1}.png`
    );
    const htmlWithThirtyImages = `
      <main>
        <h1>Barrier Hydro Soothing Cream</h1>
        <section class="product-detail technical-description">
          <h2>Ingredients and effects</h2>
          ${detailImages.map((imageUrl) => `<img data-src="${imageUrl}" alt="ingredient technology detail" />`).join("\n")}
        </section>
      </main>
    `;
    const imageBatches: string[][] = [];
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const content = body.input?.[0]?.content;
      const imageParts = Array.isArray(content) ? content.filter((part: { type?: string }) => part.type === "input_image") : [];

      if (imageParts.length > 0) {
        const urls = imageParts.map((part: { image_url: string }) => part.image_url);
        imageBatches.push(urls);
        return new Response(JSON.stringify({
          output_text: JSON.stringify({
            images: urls.map((imageUrl) => {
              const sectionNumber = imageUrl.match(/detail-section-(\d+)/)?.[1] ?? "0";
              return {
                imageUrl,
                text: `Compressed Hyaluronic Acid section ${sectionNumber}. Product-detail image text explains fast hydration, skin barrier moisture, and sensitive skin care.`
              };
            })
          })
        }), { status: 200 });
      }

      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          keywords: [],
          sentenceInsights: [],
          summary: "classified"
        })
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = await extractProductFromHtml(
      htmlWithThirtyImages,
      "https://brand.example.com/products/barrier-hydro-soothing-cream",
      { provider: "openai", apiKey: "test-key", model: "gpt-5.4-mini" }
    );

    expect(imageBatches).toHaveLength(3);
    expect(imageBatches.every((batch) => batch.length <= 10)).toBe(true);
    expect(imageBatches.flat()).toHaveLength(24);
    expect(imageBatches.flat()).toEqual(expect.arrayContaining([detailImages[0], detailImages[12], detailImages[23]]));
    expect(imageBatches.flat()).not.toContain(detailImages[24]);
    expect(result.geoProduct.sourceExtraction.ocr.imageTexts).toHaveLength(24);
    expect(result.geoProduct.ocr.textBlocks.join(" ")).toContain("Compressed Hyaluronic Acid section 24");
  });

  it("keeps image OCR scoped to product-evidence sections instead of related commerce imagery", async () => {
    const evidenceImage = "https://cdn.example.com/pdp/results/clinical-result.png";
    const ingredientImage = "https://cdn.example.com/pdp/ingredients/peptide-tech.png";
    const relatedImage = "https://cdn.example.com/product-card/unrelated-cream.png";
    const routineTileImage = "https://cdn.example.com/product-card/first-care-activating-serum.png";
    const reviewImage = "https://cdn.example.com/fileupload/reviews/review-before-after.png";
    const promoImage = "https://cdn.example.com/promo/gift-set.png";
    const sentImageUrls: string[] = [];
    const htmlWithMixedImages = `
      <main>
        <h1>Barrier Hydro Soothing Cream</h1>
        <section class="product-detail clinical-results">
          <h2>Proven Results</h2>
          <img src="${evidenceImage}" alt="clinical result fine lines firmness" />
        </section>
        <section class="ingredient-technology">
          <h2>Core Ingredients</h2>
          <img src="${ingredientImage}" alt="Compressed Hyaluronic Acid ingredient technology" />
        </section>
        <section class="related-products">
          <h2>You may also like</h2>
          <img src="${relatedImage}" alt="Unrelated cream product card" />
        </section>
        <section class="routine-builder">
          <h2>Your Routine</h2>
          <div class="product-tile product-tile--slider" role="group" aria-label="product">
            <img src="${routineTileImage}" alt="First Care Activating Serum routine step" />
          </div>
        </section>
        <section class="reviews">
          <h2>Reviews</h2>
          <img src="${reviewImage}" alt="Customer review image" />
        </section>
        <section class="promotion-offer">
          <h2>Special Offer</h2>
          <img src="${promoImage}" alt="Gift with purchase" />
        </section>
      </main>
    `;
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const content = body.input?.[0]?.content;
      const imageParts = Array.isArray(content) ? content.filter((part: { type?: string }) => part.type === "input_image") : [];

      if (imageParts.length > 0) {
        const urls = imageParts.map((part: { image_url: string }) => part.image_url);
        sentImageUrls.push(...urls);
        return new Response(JSON.stringify({
          output_text: JSON.stringify({
            images: urls.map((imageUrl) => ({
              imageUrl,
              text: imageUrl.includes("ingredients")
                ? "Compressed Hyaluronic Acid. Ingredient technology supports lasting hydration."
                : "100% showed improved firmness after 6 weeks."
            }))
          })
        }), { status: 200 });
      }

      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          keywords: [],
          sentenceInsights: [],
          summary: "classified"
        })
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = await extractProductFromHtml(
      htmlWithMixedImages,
      "https://brand.example.com/products/barrier-hydro-soothing-cream",
      { provider: "openai", apiKey: "test-key", model: "gpt-5.4-mini" }
    );

    expect(sentImageUrls).toEqual([evidenceImage, ingredientImage]);
    expect(result.geoProduct.ocr.textBlocks.join(" ")).toContain("Compressed Hyaluronic Acid");
    expect(result.geoProduct.ocr.textBlocks.join(" ")).toContain("improved firmness");
  });

  it("deduplicates responsive image variants before sending image OCR", async () => {
    const sentImageUrls: string[] = [];
    const htmlWithResponsiveVariants = `
      <main>
        <h1>Barrier Hydro Soothing Cream</h1>
        <section class="product-detail clinical-results">
          <h2>Proven Results</h2>
          <picture>
            <source srcset="https://cdn.example.com/pdp/results/proven.png?width=320 320w, https://cdn.example.com/pdp/results/proven.png?width=640 640w, https://cdn.example.com/pdp/results/proven.png?width=1280 1280w" />
            <img src="https://cdn.example.com/pdp/results/proven.png?width=320" alt="clinical result fine lines firmness" />
          </picture>
        </section>
      </main>
    `;
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const content = body.input?.[0]?.content;
      const imageParts = Array.isArray(content) ? content.filter((part: { type?: string }) => part.type === "input_image") : [];

      if (imageParts.length > 0) {
        const urls = imageParts.map((part: { image_url: string }) => part.image_url);
        sentImageUrls.push(...urls);
        return new Response(JSON.stringify({
          output_text: JSON.stringify({
            images: urls.map((imageUrl) => ({
              imageUrl,
              text: "100% showed improved firmness after 6 weeks."
            }))
          })
        }), { status: 200 });
      }

      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          keywords: [],
          sentenceInsights: [],
          summary: "classified"
        })
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await extractProductFromHtml(
      htmlWithResponsiveVariants,
      "https://brand.example.com/products/barrier-hydro-soothing-cream",
      { provider: "openai", apiKey: "test-key", model: "gpt-5.4-mini" }
    );

    expect(sentImageUrls).toEqual(["https://cdn.example.com/pdp/results/proven.png?width=1280"]);
  });

  it("warns when product-detail image OCR candidates exist but the active provider is mock", async () => {
    const imageOnlyHtml = `
      <main>
        <h1>Barrier Hydro Soothing Cream</h1>
        <section class="product-detail technical-description">
          <h2>기술서</h2>
          <img src="https://cdn.example.com/pdp/technical-description/detail-section-1.png?ver=2026061802" />
        </section>
      </main>
    `;

    const { diagnostics } = await extractProductFromHtml(imageOnlyHtml, "https://brand.example.com/products/barrier-hydro-soothing-cream");

    expect(diagnostics.warnings.some((warning) =>
      warning.code === "IMAGE_OCR_PROVIDER_NOT_CONFIGURED"
      && warning.message.includes("product-detail image OCR candidates")
    )).toBe(true);
  });

  it("sends raw image URLs embedded in page scripts to image OCR", async () => {
    const rawScriptImageUrl = "https://assets.example.com/upload/editor/f4652a02-f514-4936-ac7e-00f5fcab61b4.png";
    const sentImageUrls: string[] = [];
    const htmlWithRawScriptImage = `
      <main>
        <h1>Barrier Hydro Soothing Cream</h1>
      </main>
      <script>
        window.detailAsset = "${rawScriptImageUrl}";
      </script>
    `;
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const content = body.input?.[0]?.content;
      const imageParts = Array.isArray(content) ? content.filter((part: { type?: string }) => part.type === "input_image") : [];

      if (imageParts.length > 0) {
        sentImageUrls.push(...imageParts.map((part: { image_url: string }) => part.image_url));
        return new Response(JSON.stringify({
          output_text: JSON.stringify({
            images: [
              {
                imageUrl: rawScriptImageUrl,
                text: "Compressed Hyaluronic Acid. Fast hydration and lasting moisture support the skin barrier."
              }
            ]
          })
        }), { status: 200 });
      }

      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          keywords: [],
          sentenceInsights: [],
          summary: "classified"
        })
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = await extractProductFromHtml(
      htmlWithRawScriptImage,
      "https://brand.example.com/products/barrier-hydro-soothing-cream",
      { provider: "openai", apiKey: "test-key", model: "gpt-5.4-mini" }
    );

    expect(sentImageUrls).toContain(rawScriptImageUrl);
    expect(result.geoProduct.sourceExtraction.ocr.imageTexts.some((item) => item.imageUrl === rawScriptImageUrl)).toBe(true);
    expect(result.geoProduct.ocr.textBlocks.join(" ")).toContain("Compressed Hyaluronic Acid");
  });

  it("uses semantic OCR sentence analysis instead of raw OCR copy for downstream evidence", async () => {
    const detailImage = "https://assets.example.com/upload/editor/barrier-capsule-detail.png";
    const ocrText = [
      "고밀도 세라마이드 캡슐",
      "링커 세라마이드가 피부 장벽과 수분 보습을 돕습니다.",
      "사용 전 사용 직후 수분량 105% 개선"
    ].join("\n");
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const content = body.input?.[0]?.content;
      const imageParts = Array.isArray(content) ? content.filter((part: { type?: string }) => part.type === "input_image") : [];

      if (imageParts.length > 0) {
        return new Response(JSON.stringify({
          output_text: JSON.stringify({
            images: [
              {
                imageUrl: detailImage,
                text: ocrText
              }
            ]
          })
        }), { status: 200 });
      }

      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          keywords: [
            { keyword: "고밀도 세라마이드 캡슐", category: "ingredient", confidence: 0.94, source: "llm" },
            { keyword: "링커 세라마이드", category: "ingredient", confidence: 0.9, source: "llm" },
            { keyword: "피부 장벽", category: "benefit", confidence: 0.9, source: "llm" },
            { keyword: "수분 보습", category: "benefit", confidence: 0.86, source: "llm" },
            { keyword: "105%", category: "metric", confidence: 0.88, source: "llm" }
          ],
          sentenceInsights: [
            {
              text: "고밀도 세라마이드 캡슐과 링커 세라마이드는 피부 장벽과 수분 보습 케어를 뒷받침하는 성분 기술입니다.",
              category: "ingredient",
              keywords: ["고밀도 세라마이드 캡슐", "링커 세라마이드", "피부 장벽", "수분 보습"],
              confidence: 0.92,
              source: "llm"
            },
            {
              text: "사용 전과 사용 직후의 수분량 105% 개선은 사용 직후 보습 효과 지표입니다.",
              category: "metric",
              keywords: ["사용 직후", "수분량", "105%", "보습 효과"],
              confidence: 0.88,
              source: "llm"
            }
          ],
          summary: "semantic OCR evidence classified"
        })
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = await extractProductFromHtml(
      `
        <main>
          <h1>Barrier Capsule Toner</h1>
          <section class="product-detail rich-text-content">
            <h2>상품 상세</h2>
            <img src="${detailImage}" />
          </section>
        </main>
      `,
      "https://brand.example.com/products/barrier-capsule-toner",
      { provider: "openai", apiKey: "test-key", model: "gpt-5.4-mini" }
    );
    const insightTexts = result.geoProduct.ocr.sentenceInsights.map((item) => item.text);

    expect(result.geoProduct.sourceExtraction.ocr.imageTexts[0]?.text).toContain("사용 전 사용 직후");
    expect(insightTexts.some((text) => text.includes("성분 기술"))).toBe(true);
    expect(insightTexts.some((text) => text.includes("105% 개선"))).toBe(true);
    expect(insightTexts.some((text) => text.includes("사용 전 사용 직후"))).toBe(false);
    expect(insightTexts.some((text) => /상품 상세|OCR|image|evidence/i.test(text))).toBe(false);
    expect(result.geoProduct.usage.some((text) => text.includes("사용 전"))).toBe(false);
    expect(result.geoProduct.metrics).toContain("105%");
  });

  it("sends escaped product-detail HTML images to OCR even when gallery images are present", async () => {
    const galleryImages = [
      "https://assets.example.com/upload/product/barrier-toner-main.png",
      "https://assets.example.com/upload/product/barrier-toner-texture.png"
    ];
    const escapedDetailImage = "https://assets.example.com/cms/rich-content/long-scroll-detail.png";
    const sentImageUrls: string[] = [];
    const htmlWithEscapedDetailImage = `
      <main>
        <h1>Barrier Capsule Toner</h1>
        <section class="product-gallery product-media">
          <h2>Product images</h2>
          ${galleryImages.map((imageUrl) => `<img src="${imageUrl}" alt="Barrier Capsule Toner product image" />`).join("\n")}
        </section>
        <section class="product-detail rich-text-content">
          <h2>상품 상세</h2>
          <div class="cms-html-container" style="display:none;">
            &lt;p&gt;&lt;img src=&quot;${escapedDetailImage}&quot; title=&quot;long-scroll-detail.png&quot;&gt;&lt;/p&gt;
          </div>
        </section>
      </main>
    `;
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const content = body.input?.[0]?.content;
      const imageParts = Array.isArray(content) ? content.filter((part: { type?: string }) => part.type === "input_image") : [];

      if (imageParts.length > 0) {
        const urls = imageParts.map((part: { image_url: string }) => part.image_url);
        sentImageUrls.push(...urls);
        return new Response(JSON.stringify({
          output_text: JSON.stringify({
            images: [
              {
                imageUrl: escapedDetailImage,
                text: "세라마이드 캡슐 기술\n고밀도 세라마이드 캡슐이 피부 장벽 수분 보습을 돕습니다."
              }
            ]
          })
        }), { status: 200 });
      }

      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          keywords: [
            { keyword: "세라마이드 캡슐", category: "ingredient", confidence: 0.9, source: "llm" },
            { keyword: "피부 장벽", category: "benefit", confidence: 0.9, source: "llm" }
          ],
          sentenceInsights: [],
          summary: "classified"
        })
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = await extractProductFromHtml(
      htmlWithEscapedDetailImage,
      "https://brand.example.com/products/barrier-capsule-toner",
      { provider: "openai", apiKey: "test-key", model: "gpt-5.4-mini" }
    );

    expect(sentImageUrls).toContain(escapedDetailImage);
    expect(result.geoProduct.sourceExtraction.ocr.imageTexts.some((item) => item.imageUrl === escapedDetailImage)).toBe(true);
    expect(result.geoProduct.ocr.textBlocks.join(" ")).toContain("고밀도 세라마이드 캡슐");
  });

  it("warns when an image OCR provider returns no readable product text", async () => {
    const imageOnlyHtml = `
      <main>
        <h1>Barrier Hydro Soothing Cream</h1>
        <section class="product-detail technical-description">
          <h2>기술서</h2>
          <img src="https://cdn.example.com/pdp/technical-description/detail-section-empty.png?ver=2026061802" />
        </section>
      </main>
    `;
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        output_text: JSON.stringify({
          images: []
        })
      }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { diagnostics } = await extractProductFromHtml(
      imageOnlyHtml,
      "https://brand.example.com/products/barrier-hydro-soothing-cream",
      { provider: "openai", apiKey: "test-key", model: "gpt-5.4-mini" }
    );

    expect(diagnostics.warnings.some((warning) =>
      warning.code === "IMAGE_OCR_NO_TEXT_EXTRACTED"
      && warning.message.includes("product-detail image OCR candidates were sent")
    )).toBe(true);
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
