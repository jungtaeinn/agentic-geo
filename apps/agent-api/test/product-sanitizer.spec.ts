import { sanitizeProductHtml } from "../src/geo/product-sanitizer";

/**
 * 실물 description의 앞머리를 그대로 옮긴 fixture. style 블록이 900자를 넘기고
 * 블록이 두 번 나타나며 주석이 섞여 있는 구조가 회귀의 핵심이라 줄이지 않았다.
 */
const STYLE_BLOCK = `<style>
    @charset "UTF-8";
    .ap-pdp{--font:Theinhardt,"Noto Sans",Helvetica,"Helvetica Neue",Arial,"Lucida Grande",sans-serif;--font-ko:"Noto Sans KR","Noto Sans",Helvetica,"Helvetica Neue",Arial,"Lucida Grande",sans-serif;container-name:article;container-type:inline-size;max-width:1100px;min-width:280px;margin:0 auto;background-color:#fff;font-family:var(--font);font-weight:500;/*
      400 Light
      500 Regular
      600 Medium
      800 Bold
      */
    line-height:1.4;color:#fff;word-wrap:break-word;text-align:center}
    .ap-pdp__inner{--color-orange:#ff5700;--color-orange2:#ff7702;--container-width:1100;letter-spacing:0}
    @container article (max-width: 640px){
    .ap-pdp__inner{--container-width:640}
    }
    .ap-pdp sup{display:inline-block;position:relative;top:-0.1em;vertical-align:baseline;font-family:var(--font-ko);line-height:1}
    .ap-pdp img,.ap-pdp video{-o-object-fit:cover;display:block;object-fit:cover;width:100%}
</style>`;

const REAL_DESCRIPTION = [
  "<div>",
  '<div class="wpc-pdp-wrapper"><!-- css --></div>',
  "</div>",
  STYLE_BLOCK,
  "<div>",
  '<div class="wpc-pdp-wrapper">',
  "<!--  html -->",
  '<article class="ap-pdp" data-article-year="2024">',
  '<div class="ap-pdp__inner">',
  "<h2>Essential Activating Serum</h2>",
  "<p>HYDRATED, YOUTHFUL-LOOKING SKIN IN EVERY DROP</p>",
  '<p><img src="https://cdn.shopify.com/s/files/1/0622/5579/2294/files/270320591_whiteBG.jpg?v=1733884648" alt="Essential Activating Serum"></p>',
  "</div>",
  "</article>",
  "</div>",
  "</div>",
  '<style> .ap-pdp h1,.ap-pdp h2{font-size:inherit;font-weight:inherit}</style>',
].join("\n");

/**
 * content-planner가 근거 원자를 프롬프트에 실을 때의 창(`truncate(item.text, 900)`)을
 * 그대로 재현한다. 정제의 목적은 바이트 절감이 아니라 이 창에 무엇이 담기느냐다.
 */
function promptWindow(value: unknown): string {
  return String(value)
    .slice(0, 900)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function description(product: unknown): unknown {
  return (product as Record<string, unknown>).description;
}

describe("sanitizeProductHtml", () => {
  it("frees the 900-character prompt window so it carries product copy instead of CSS", () => {
    // 정제 전에는 창이 통째로 CSS다 — 이 fixture가 실제 문제를 재현한다는 증명.
    expect(promptWindow(REAL_DESCRIPTION)).toContain("@charset");

    const sanitized = sanitizeProductHtml({ description: REAL_DESCRIPTION });
    const window = promptWindow(description(sanitized));

    expect(window).not.toMatch(/@charset|font-family|--container-width|line-height/);
    expect(window).toContain("Essential Activating Serum");
    expect(window).toContain("HYDRATED, YOUTHFUL-LOOKING SKIN IN EVERY DROP");
  });

  it("removes every style block, not just the first", () => {
    const sanitized = sanitizeProductHtml({ description: REAL_DESCRIPTION });

    expect(String(description(sanitized))).not.toContain("<style");
    expect(String(description(sanitized))).not.toContain("font-size:inherit");
  });

  it("removes script blocks", () => {
    const sanitized = sanitizeProductHtml({
      description: '<p>Serum</p><script type="text/javascript">alert(1);</script><p>Cream</p>',
    });

    expect(description(sanitized)).toBe("<p>Serum</p><p>Cream</p>");
  });

  it("removes html comments", () => {
    const sanitized = sanitizeProductHtml({
      description: "<p>Serum</p><!--  html --><p>Cream</p>",
    });

    expect(description(sanitized)).toBe("<p>Serum</p><p>Cream</p>");
  });

  it("leaves structural tags, attributes, alt text, media tags, and entities untouched", () => {
    // 이번 범위는 style·script·주석 제거까지다. alt 승격·속성 제거·엔티티 디코드는
    // 의도적으로 하지 않으므로 그 결정을 여기서 고정한다.
    const html =
      '<h2 class="tit">Ginseng &amp; Serum</h2>' +
      '<source media="(max-width: 680px)" srcset="https://cdn.example.com/a.jpg">' +
      '<img src="https://cdn.example.com/b.jpg" alt="-5.87%">';
    const sanitized = sanitizeProductHtml({ description: html });

    expect(description(sanitized)).toBe(html);
  });

  it("walks nested objects and arrays in the product tree", () => {
    const sanitized = sanitizeProductHtml({
      productName: "Serum",
      faq: [{ question: "Q<style>a{}</style>", answer: "A<!--x-->" }],
      metafields: { "custom.detail": "D<script>b()</script>" },
    }) as Record<string, unknown>;

    expect(sanitized.productName).toBe("Serum");
    expect((sanitized.faq as Array<Record<string, unknown>>)[0]).toEqual({
      question: "Q",
      answer: "A",
    });
    expect((sanitized.metafields as Record<string, unknown>)["custom.detail"]).toBe("D");
  });

  it("preserves non-string values and passes non-object input through", () => {
    const sanitized = sanitizeProductHtml({
      price: 32000,
      forceRegenerate: false,
      seoTitle: null,
      tags: ["vegan"],
    }) as Record<string, unknown>;

    expect(sanitized).toEqual({
      price: 32000,
      forceRegenerate: false,
      seoTitle: null,
      tags: ["vegan"],
    });
    expect(sanitizeProductHtml(null)).toBeNull();
    expect(sanitizeProductHtml("plain")).toBe("plain");
  });
});
