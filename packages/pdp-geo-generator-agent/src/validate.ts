import type { JsonObject, JsonValue, PdpGeoContentArtifact, PdpGeoContentSections, PdpGeoLocale, PdpGeoSchemaMarkup, PdpGeoValidationRepair } from "./types";

interface ValidateAndRepairInput {
  schemaMarkup: PdpGeoSchemaMarkup;
  content: PdpGeoContentArtifact;
  fallbackProductName: string;
  fallbackDescription: string;
  locale?: PdpGeoLocale;
}

interface ValidateAndRepairOutput {
  schemaMarkup: PdpGeoSchemaMarkup;
  content: PdpGeoContentArtifact;
  validationWarnings: string[];
  validationRepairs: PdpGeoValidationRepair[];
}

const allowedGraphTypes = new Set(["WebPage", "Product", "FAQPage", "HowTo", "BreadcrumbList", "Question", "Answer", "HowToStep", "Offer", "AggregateRating", "Review", "Rating", "PropertyValue", "ItemList", "ListItem", "Brand", "Person"]);

/** Validates and repairs generated JSON-LD and simple accordion HTML. */
export function validateAndRepairPdpGeoArtifacts(input: ValidateAndRepairInput): ValidateAndRepairOutput {
  const validationWarnings: string[] = [];
  const validationRepairs: PdpGeoValidationRepair[] = [];
  const locale = input.locale ?? "en-US";
  const fallbackProductName = repairGeneratedText(input.fallbackProductName, locale, "fallbackProductName", validationWarnings, validationRepairs);
  const fallbackDescription = repairGeneratedText(input.fallbackDescription, locale, "fallbackDescription", validationWarnings, validationRepairs);
  const jsonLd = repairJsonLd(input.schemaMarkup.jsonLd, fallbackProductName, fallbackDescription, locale, validationWarnings, validationRepairs);
  const schemaMarkup = {
    jsonLd,
    scriptTag: `<script type="application/ld+json">${escapeScriptJson(JSON.stringify(jsonLd, null, 2))}</script>`
  };
  const sections = repairContentSections(input.content.sections, locale, validationWarnings, validationRepairs);
  const sanitizedHtml = sanitizeAccordionHtml(input.content.html, validationWarnings, validationRepairs);
  const content = {
    ...input.content,
    sections,
    html: createAccordionHtml(sections, locale)
  };
  if (sanitizedHtml !== input.content.html || content.html !== input.content.html) {
    addRepair(validationWarnings, validationRepairs, {
      field: "content.html",
      source: "html-validator",
      issue: "Generated HTML was not trusted as final output because it may contain unsafe markup or may not match the repaired section data.",
      action: "Rebuilt the accordion HTML from repaired content.sections so public HTML matches validated copy.",
      before: input.content.html,
      after: content.html,
      evidence: ["content.sections", "html sanitizer"]
    }, "Generated HTML was rebuilt from repaired content sections.");
  }

  return {
    schemaMarkup,
    content,
    validationWarnings,
    validationRepairs
  };
}

function repairJsonLd(
  value: JsonObject,
  fallbackProductName: string,
  fallbackDescription: string,
  locale: PdpGeoLocale,
  warnings: string[],
  repairs: PdpGeoValidationRepair[]
): JsonObject {
  const root = isRecord(value) ? { ...value } : {};
  if (root["@context"] !== "https://schema.org") {
    const before = root["@context"];
    root["@context"] = "https://schema.org";
    addRepair(warnings, repairs, {
      field: "@context",
      source: "schema-validator",
      issue: "JSON-LD context was missing or not schema.org.",
      action: "Set @context to https://schema.org.",
      before: toJsonValue(before),
      after: "https://schema.org",
      evidence: ["schema.org JSON-LD requirement"]
    }, "JSON-LD @context was repaired to https://schema.org.");
  }

  const rawGraph: unknown[] = Array.isArray(root["@graph"]) ? root["@graph"] : [];
  const graph = rawGraph.filter(isRecord).map((node) => repairGraphNode(node, locale, warnings, repairs));
  if (graph.length === 0) {
    const addedProduct = {
      "@type": "Product",
      "@id": `urn:agentic-geo:pdp:${slug(fallbackProductName)}#product`,
      name: fallbackProductName,
      description: fallbackDescription
    };
    graph.push(addedProduct);
    addRepair(warnings, repairs, {
      field: "@graph",
      source: "schema-validator",
      issue: "JSON-LD @graph was missing or empty.",
      action: "Added a minimal Product node from fallback product name and description.",
      before: toJsonValue(root["@graph"]),
      after: addedProduct,
      evidence: ["fallbackProductName", "fallbackDescription"]
    }, "JSON-LD @graph was missing and a minimal Product node was added.");
  }

  const product = graph.find((node) => node["@type"] === "Product");
  if (!product) {
    const addedProduct = {
      "@type": "Product",
      "@id": `urn:agentic-geo:pdp:${slug(fallbackProductName)}#product`,
      name: fallbackProductName,
      description: fallbackDescription
    };
    graph.push(addedProduct);
    addRepair(warnings, repairs, {
      field: "@graph.Product",
      source: "schema-validator",
      issue: "Product node was missing from JSON-LD graph.",
      action: "Added a Product node from fallback product name and description.",
      before: null,
      after: addedProduct,
      evidence: ["fallbackProductName", "fallbackDescription"]
    }, "JSON-LD Product node was missing and was added.");
  } else {
    if (typeof product.name !== "string" || product.name.trim().length === 0) {
      const before = product.name;
      product.name = fallbackProductName;
      addRepair(warnings, repairs, {
        field: "Product.name",
        source: "schema-validator",
        issue: "Product.name was missing or blank.",
        action: "Filled Product.name with fallback product name.",
        before: toJsonValue(before),
        after: fallbackProductName,
        evidence: ["fallbackProductName"]
      }, "Product.name was missing and was repaired.");
    }
    if (typeof product.description !== "string" || product.description.trim().length === 0) {
      const before = product.description;
      product.description = fallbackDescription;
      addRepair(warnings, repairs, {
        field: "Product.description",
        source: "schema-validator",
        issue: "Product.description was missing or blank.",
        action: "Filled Product.description with fallback description.",
        before: toJsonValue(before),
        after: fallbackDescription,
        evidence: ["fallbackDescription"]
      }, "Product.description was missing and was repaired.");
    }
  }

  repairSchemaEvidenceConsistency(graph, locale, warnings, repairs);

  return cleanJson({
    ...root,
    "@graph": graph
  }) as JsonObject;
}

function repairSchemaEvidenceConsistency(
  graph: Array<Record<string, unknown>>,
  locale: PdpGeoLocale,
  warnings: string[],
  repairs: PdpGeoValidationRepair[]
): void {
  const product = graph.find((node) => node["@type"] === "Product");
  const reportedDetails = product ? readReportedDetailsProperty(product) : undefined;
  if (!reportedDetails) {
    return;
  }

  for (const node of graph) {
    const type = stringValue(node["@type"]);
    if (type !== "WebPage" && type !== "Product") {
      continue;
    }
    const description = stringValue(node.description);
    if (!description) {
      continue;
    }
    const aligned = alignDescriptionEvidenceScope(description, reportedDetails);
    if (aligned === description) {
      continue;
    }
    node.description = aligned;
    addRepair(warnings, repairs, {
      field: `${type}.description`,
      source: "field-contract-validator",
      issue: "Description evidence scope did not match the retained Product Reported details.",
      action: "Aligned public description claims to the evidence duration and metric scope retained in Reported details.",
      before: description,
      after: aligned,
      evidence: ["Product.additionalProperty.Reported details", `${type}.description`, locale]
    }, `${type}.description was aligned to retained reported evidence details.`);
  }
}

function readReportedDetailsProperty(product: Record<string, unknown>): string | undefined {
  const properties = Array.isArray(product.additionalProperty) ? product.additionalProperty : [];
  return properties
    .filter(isRecord)
    .map((item) => ({
      name: stringValue(item.name),
      value: stringValue(item.value)
    }))
    .find((item) => item.name && /reported details/i.test(item.name) && item.value)?.value;
}

function alignDescriptionEvidenceScope(description: string, reportedDetails: string): string {
  const reported = reportedDetails.toLowerCase();
  let next = description
    .replace(/([+\-−]?\d+)\.\s+(\d+%)/g, "$1.$2")
    .replace(/\s+/g, " ")
    .trim();

  if (!/\b8\s+weeks?\b/i.test(reported)) {
    next = next
      .replace(/\b4\s+weeks?\s+and\s+8\s+weeks?(?:\s+of\s+(?:daily\s+)?use)?/gi, "4 weeks of use")
      .replace(/\s+and\s+8\s+weeks?(?:\s+of\s+(?:daily\s+)?use)?/gi, "");
  }

  if (!/\binstrumental\b/i.test(reported)) {
    next = next.replace(/\binstrumental results?\b/gi, "Reported details");
  }

  return normalizeRepeatedPunctuation(next)
    .replace(/\s+([,.!?。！？])/g, "$1")
    .replace(/([.。！？?])(?=\S)/g, addSentencePunctuationSpacing)
    .replace(/\s+/g, " ")
    .trim();
}

function repairGraphNode(
  node: Record<string, unknown>,
  locale: PdpGeoLocale,
  warnings: string[],
  repairs: PdpGeoValidationRepair[]
): Record<string, unknown> {
  const type = node["@type"];
  if (typeof type === "string" && !allowedGraphTypes.has(type)) {
    addRepair(warnings, repairs, {
      field: `${type}.@type`,
      source: "schema-validator",
      issue: `Unsupported schema.org node type "${type}" was detected.`,
      action: "Kept the node for compatibility but flagged it for review.",
      before: type,
      after: type,
      evidence: ["allowedGraphTypes"]
    }, `Unsupported schema.org node type "${type}" was kept for compatibility but flagged.`);
  }

  if (node["@type"] === "FAQPage" && Array.isArray(node.mainEntity)) {
    node.mainEntity = node.mainEntity.filter(isRecord).flatMap((item) => {
      const name = stringValue(item.name);
      const acceptedAnswer = isRecord(item.acceptedAnswer) ? item.acceptedAnswer : undefined;
      const answer = stringValue(acceptedAnswer?.text);
      if (!name || !answer) {
        addRepair(warnings, repairs, {
          field: "FAQPage.mainEntity",
          source: "schema-validator",
          issue: "FAQ question was missing a question name or accepted answer text.",
          action: "Removed the invalid FAQ item from mainEntity.",
          before: toJsonValue(item),
          after: null,
          evidence: ["FAQPage.mainEntity.name", "FAQPage.mainEntity.acceptedAnswer.text"]
        }, "Invalid FAQ question without answer was removed.");
        return [];
      }
      const repairedQuestion = repairGeneratedText(name, locale, "FAQPage.mainEntity.name", warnings, repairs);
      const repairedAnswer = repairGeneratedText(answer, locale, "FAQPage.mainEntity.acceptedAnswer.text", warnings, repairs);
      if (isSectionHeadingFaqQuestion(repairedQuestion)) {
        addRepair(warnings, repairs, {
          field: "FAQPage.mainEntity",
          source: "field-contract-validator",
          issue: "FAQ question was a source section heading rather than an answer-ready user question.",
          action: "Removed the section-heading FAQ item from mainEntity.",
          before: toJsonValue(item),
          after: null,
          evidence: ["FAQPage.mainEntity.name", "answer-ready FAQ contract"]
        }, "Section-heading FAQ item was removed during final sentence QA.");
        return [];
      }
      const aligned = repairFaqQuestionAnswerAlignment(repairedQuestion, repairedAnswer, locale, warnings, repairs);

      return [{
        "@type": "Question",
        name: aligned.question,
        acceptedAnswer: {
          "@type": "Answer",
          text: aligned.answer
        }
      }];
    });
  }

  if (node["@type"] === "HowTo" && Array.isArray(node.step)) {
    let nextPosition = 1;
    node.step = node.step.filter(isRecord).flatMap((item) => {
      const text = stringValue(item.text);
      if (!text) {
        addRepair(warnings, repairs, {
          field: "HowTo.step",
          source: "schema-validator",
          issue: "HowTo step was missing text.",
          action: "Removed the invalid HowTo step.",
          before: toJsonValue(item),
          after: null,
          evidence: ["HowTo.step.text"]
        }, "Invalid HowTo step without text was removed.");
        return [];
      }
      const repairedText = repairGeneratedText(text, locale, "HowTo.step.text", warnings, repairs);
      if (!isActionableUsageText(repairedText)) {
        addRepair(warnings, repairs, {
          field: "HowTo.step.text",
          source: "field-contract-validator",
          issue: "HowTo.step text did not satisfy the RAG field evidence contract for actionable usage directions.",
          action: "Removed the invalid HowTo step so benefit, evidence, ingredient, or review copy does not appear as a usage action.",
          before: toJsonValue(item),
          after: null,
          evidence: ["RAG Field Evidence Contract", "HowTo.step requires actionable usage evidence"]
        }, "HowTo step was removed because it was not actionable usage content.");
        return [];
      }
      return [{
        "@type": "HowToStep",
        position: nextPosition++,
        name: stringValue(item.name) ? repairGeneratedText(stringValue(item.name) ?? "", locale, "HowTo.step.name", warnings, repairs) : undefined,
        text: repairedText
      }];
    });
  }

  if (node["@type"] === "Product") {
    repairProductTrustFields(node, locale, warnings, repairs);
  }

  if (node["@type"] === "BreadcrumbList") {
    repairBreadcrumbListNode(node, warnings, repairs);
  }

  const repaired = repairSchemaTextFields(node, locale, warnings, repairs);
  return cleanJson(pruneInvalidSchemaText(repaired, locale, warnings, repairs));
}

function repairProductTrustFields(
  node: Record<string, unknown>,
  _locale: PdpGeoLocale,
  warnings: string[],
  repairs: PdpGeoValidationRepair[]
): void {
  const productName = stringValue(node.name);

  if (node.image !== undefined) {
    const before = node.image;
    const images = normalizeSchemaImageValues(node.image);
    if (images.length === 0) {
      delete node.image;
    } else {
      node.image = images;
    }
    if (JSON.stringify(before) !== JSON.stringify(node.image)) {
      addRepair(warnings, repairs, {
        field: "Product.image",
        source: "trust-field-validator",
        issue: "Product.image included duplicate, low-quality, icon-like, or non-canonical image URLs.",
        action: images.length > 0 ? "Canonicalized and deduplicated Product.image URLs." : "Removed Product.image because no schema-safe image URL remained.",
        before: toJsonValue(before),
        after: toJsonValue(node.image),
        evidence: ["Product.image", "schema image quality gate"]
      }, "Product.image was repaired by the schema trust-field validator.");
    }
  }

  if (node.offers !== undefined) {
    const before = node.offers;
    const repairedOffer = normalizeOfferNode(node.offers);
    if (repairedOffer) {
      node.offers = repairedOffer;
    } else {
      delete node.offers;
    }
    if (JSON.stringify(before) !== JSON.stringify(node.offers)) {
      addRepair(warnings, repairs, {
        field: "Product.offers",
        source: "trust-field-validator",
        issue: "Product.offers lacked a trustworthy positive price and ISO currency.",
        action: repairedOffer ? "Normalized Offer price and currency." : "Removed Offer because price/currency evidence was insufficient.",
        before: toJsonValue(before),
        after: toJsonValue(node.offers),
        evidence: ["Offer.price", "Offer.priceCurrency", "E-E-A-T trust-sensitive field policy"]
      }, "Product.offers was repaired by the schema trust-field validator.");
    }
  }

  if (node.aggregateRating !== undefined) {
    const before = node.aggregateRating;
    const repairedRating = normalizeAggregateRatingNode(node.aggregateRating);
    if (repairedRating) {
      node.aggregateRating = repairedRating;
    } else {
      delete node.aggregateRating;
    }
    if (JSON.stringify(before) !== JSON.stringify(node.aggregateRating)) {
      addRepair(warnings, repairs, {
        field: "Product.aggregateRating",
        source: "trust-field-validator",
        issue: "AggregateRating lacked a valid rating value and positive review count.",
        action: repairedRating ? "Normalized AggregateRating." : "Removed AggregateRating because rating evidence was insufficient.",
        before: toJsonValue(before),
        after: toJsonValue(node.aggregateRating),
        evidence: ["AggregateRating.ratingValue", "AggregateRating.reviewCount", "E-E-A-T review evidence policy"]
      }, "Product.aggregateRating was repaired by the schema trust-field validator.");
    }
  }

  if (node.review !== undefined) {
    const before = node.review;
    const repairedReviews = normalizeReviewNodes(node.review, productName, _locale);
    if (repairedReviews.length > 0) {
      node.review = repairedReviews;
    } else {
      delete node.review;
    }
    if (JSON.stringify(before) !== JSON.stringify(node.review)) {
      addRepair(warnings, repairs, {
        field: "Product.review",
        source: "trust-field-validator",
        issue: "Review schema lacked meaningful customer review body evidence or reused product/rating summary text.",
        action: repairedReviews.length > 0 ? "Kept only meaningful customer reviews." : "Removed Review schema because no valid review body remained.",
        before: toJsonValue(before),
        after: toJsonValue(node.review),
        evidence: ["Review.reviewBody", "E-E-A-T review evidence policy"]
      }, "Product.review was repaired by the schema trust-field validator.");
    }
  }
}

function normalizeSchemaImageValues(value: unknown): string[] {
  const values = (Array.isArray(value) ? value : [value])
    .flatMap((item) => typeof item === "string" ? [item] : isRecord(item) ? [stringValue(item.url), stringValue(item.contentUrl)].filter((url): url is string => Boolean(url)) : [])
    .flatMap((item) => item.split(/\s*,\s*/))
    .map(canonicalizeSchemaImageUrl)
    .filter((item): item is string => Boolean(item))
    .filter((item) => !isLowQualitySchemaImageUrl(item));
  const seen = new Set<string>();
  return values.filter((item) => {
    const key = schemaImageDedupeKey(item);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  }).slice(0, 8);
}

function canonicalizeSchemaImageUrl(value: string): string | undefined {
  const raw = value.trim();
  if (!raw || /^data:/i.test(raw) || /\.svg(?:\?|$)/i.test(raw)) {
    return undefined;
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    if (url.protocol === "http:") {
      url.protocol = "https:";
    }
    for (const key of Array.from(url.searchParams.keys())) {
      if (/^(?:width|height|w|h|fit|crop|format|fm|q|quality|v|_pos|variant|sw|sh)$/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function schemaImageDedupeKey(value: string): string {
  try {
    const url = new URL(value);
    return `${url.hostname.toLowerCase()}${url.pathname.toLowerCase()
      .replace(/(?:[_-])?(?:\d{2,5}x\d{2,5}|x\d{2,5}|\d{2,5}x)(?=\.[a-z]{3,4}$)/i, "")
      .replace(/@(?:2x|3x)(?=\.[a-z]{3,4}$)/i, "")}`;
  } catch {
    return value.toLowerCase();
  }
}

function isLowQualitySchemaImageUrl(value: string): boolean {
  const text = decodeURIComponent(value).toLowerCase();
  const sizeValues = Array.from(text.matchAll(/(?:width|height|[?&]w|[?&]h)=([0-9]{1,4})|[_-]([0-9]{1,4})x([0-9]{1,4})(?=[_.-]|$)/gi))
    .flatMap((match) => [match[1], match[2], match[3]])
    .map((item) => item ? Number(item) : undefined)
    .filter((item): item is number => typeof item === "number" && Number.isFinite(item));
  if (sizeValues.some((item) => item > 0 && item <= 96)) {
    return true;
  }
  return /\b(?:icons?|logos?|sprite|badge|star|rating|review|avatar|profile|swatch|payment|reward|loyalty|placeholder|spinner)\b/i.test(text);
}

function normalizeOfferNode(value: unknown): Record<string, unknown> | undefined {
  const offer = Array.isArray(value) ? value.find(isRecord) : isRecord(value) ? value : undefined;
  if (!offer) {
    return undefined;
  }
  const currency = stringValue(offer.priceCurrency)?.toUpperCase();
  const price = numberValue(offer.price);
  if (!currency || !/^[A-Z]{3}$/.test(currency) || typeof price !== "number" || price <= 0) {
    return undefined;
  }
  return cleanJson({
    ...offer,
    "@type": "Offer",
    price,
    priceCurrency: currency
  });
}

function normalizeAggregateRatingNode(value: unknown): Record<string, unknown> | undefined {
  const rating = isRecord(value) ? value : undefined;
  if (!rating) {
    return undefined;
  }
  const ratingValue = numberValue(rating.ratingValue);
  const reviewCount = numberValue(rating.reviewCount);
  if (typeof ratingValue !== "number" || ratingValue <= 0 || ratingValue > 5 || typeof reviewCount !== "number" || reviewCount <= 0) {
    return undefined;
  }
  return cleanJson({
    ...rating,
    "@type": "AggregateRating",
    ratingValue,
    reviewCount
  });
}

function normalizeReviewNodes(value: unknown, productName: string | undefined, locale: PdpGeoLocale): Record<string, unknown>[] {
  const reviews = (Array.isArray(value) ? value : [value]).filter(isRecord);
  const seen = new Set<string>();
  return reviews.flatMap((review) => {
    const body = repairGeneratedText(stringValue(review.reviewBody) ?? stringValue(review.name) ?? "", locale, "Product.review.reviewBody", [], []);
    if (!isMeaningfulSchemaReviewBody(body, productName)) {
      return [];
    }
    const key = body.toLowerCase();
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [cleanJson({
      ...review,
      "@type": "Review",
      reviewBody: body
    })];
  }).slice(0, 3);
}

function isMeaningfulSchemaReviewBody(value: string, productName?: string): boolean {
  const normalized = value.trim();
  if (normalized.length < 20 || normalized.length > 600) {
    return false;
  }
  if (productName && normalized.toLowerCase() === productName.trim().toLowerCase()) {
    return false;
  }
  if (/^(review|reviews|rating|ratings|star|stars|smooth|moisture|hydration|firmness|elasticity|plumpness)$/i.test(normalized)) {
    return false;
  }
  if (/^(?:rating|평점|評価)?\s*\d(?:\.\s*\d+)?\s*(?:\/\s*5)?\s*(?:stars?)?\s+\d[\d,]*\s+(?:reviews?|ratings?|리뷰|후기)$/i.test(normalized)) {
    return false;
  }
  return normalized.split(/\s+/).length >= 4 || /[가-힣ぁ-んァ-ン]/.test(normalized);
}

function repairBreadcrumbListNode(
  node: Record<string, unknown>,
  warnings: string[],
  repairs: PdpGeoValidationRepair[]
): void {
  if (!Array.isArray(node.itemListElement)) {
    return;
  }
  const before = node.itemListElement;
  const items = node.itemListElement.filter(isRecord).flatMap((item, index) => {
    const name = stringValue(item.name);
    if (!name) {
      return [];
    }
    return [cleanJson({
      ...item,
      "@type": "ListItem",
      position: numberValue(item.position) ?? index + 1,
      name
    })];
  });
  node.itemListElement = items.map((item, index) => ({
    ...item,
    position: index + 1
  }));
  if (items.length < 2) {
    addRepair(warnings, repairs, {
      field: "BreadcrumbList.itemListElement",
      source: "trust-field-validator",
      issue: "BreadcrumbList has fewer than two valid hierarchy items.",
      action: "Kept the breadcrumb node but flagged it because stronger hierarchy evidence is needed.",
      before: toJsonValue(before),
      after: toJsonValue(node.itemListElement),
      evidence: ["BreadcrumbList.itemListElement", "schema hierarchy quality gate"]
    }, "BreadcrumbList has fewer than two valid hierarchy items.");
  } else if (JSON.stringify(before) !== JSON.stringify(node.itemListElement)) {
    addRepair(warnings, repairs, {
      field: "BreadcrumbList.itemListElement",
      source: "schema-validator",
      issue: "BreadcrumbList item positions or names were invalid.",
      action: "Removed invalid breadcrumb items and renumbered positions.",
      before: toJsonValue(before),
      after: toJsonValue(node.itemListElement),
      evidence: ["BreadcrumbList.itemListElement"]
    }, "BreadcrumbList items were repaired.");
  }
}

function sanitizeAccordionHtml(html: string, warnings: string[], repairs: PdpGeoValidationRepair[]): string {
  let next = html;
  const before = next;
  next = next.replace(/<script[\s\S]*?<\/script>/gi, "");
  next = next.replace(/\son[a-z]+\s*=\s*["'][^"']*["']/gi, "");
  next = next.replace(/\sstyle\s*=\s*["'][^"']*["']/gi, "");
  next = next.replace(/<(\/?)(?!div\b|button\b|ul\b|li\b|p\b|br\b)([a-z][a-z0-9-]*)([^>]*)>/gi, "");

  if (next !== before) {
    addRepair(warnings, repairs, {
      field: "content.html",
      source: "html-validator",
      issue: "Generated HTML contained unsafe or unsupported tags or attributes.",
      action: "Removed script tags, inline event handlers, inline styles, and unsupported tags before rebuilding final accordion HTML.",
      before,
      after: next,
      evidence: ["HTML allowlist: div, button, ul, li, p, br"]
    }, "Generated HTML contained unsafe or unsupported tags/attributes and was sanitized.");
  }
  if (!/class="geo-content-accordion"/.test(next)) {
    addRepair(warnings, repairs, {
      field: "content.html",
      source: "html-validator",
      issue: "Generated HTML did not include the expected geo-content-accordion wrapper.",
      action: "Flagged HTML for rebuild from repaired content sections.",
      before: next,
      after: "createAccordionHtml(content.sections)",
      evidence: ["expected wrapper: class=\"geo-content-accordion\""]
    }, "Generated HTML did not include the expected accordion wrapper.");
  }

  return next;
}

function repairContentSections(
  sections: PdpGeoContentSections,
  locale: PdpGeoLocale,
  warnings: string[],
  repairs: PdpGeoValidationRepair[]
): PdpGeoContentSections {
  const repairedFaq = repairMultilineGeneratedText(sections.faq, locale, "content.sections.faq", warnings, repairs);
  const repaired = {
    productName: repairGeneratedText(sections.productName, locale, "content.sections.productName", warnings, repairs),
    description: repairGeneratedText(sections.description, locale, "content.sections.description", warnings, repairs),
    quickFacts: repairMultilineGeneratedText(sections.quickFacts, locale, "content.sections.quickFacts", warnings, repairs),
    benefits: repairMultilineGeneratedText(sections.benefits, locale, "content.sections.benefits", warnings, repairs),
    ingredients: repairMultilineGeneratedText(sections.ingredients, locale, "content.sections.ingredients", warnings, repairs),
    howToUse: repairMultilineGeneratedText(sections.howToUse, locale, "content.sections.howToUse", warnings, repairs),
    faq: repairFaqSectionText(repairedFaq, locale, warnings, repairs)
  };

  return repairContentFieldContracts(repaired, locale, warnings, repairs);
}

function repairMultilineGeneratedText(
  value: string,
  locale: PdpGeoLocale,
  path: string,
  warnings: string[],
  repairs: PdpGeoValidationRepair[]
): string {
  if (!value.includes("\n")) {
    return repairGeneratedText(value, locale, path, warnings, repairs);
  }

  return value
    .split("\n")
    .map((line) => {
      if (!line.trim()) {
        return "";
      }
      const prefix = line.match(/^(\s*(?:[-*]|\d+[.)]|[QA][.:])\s+)([\s\S]+)$/i);
      if (!prefix?.[1] || !prefix[2]) {
        return repairGeneratedText(line, locale, path, warnings, repairs);
      }
      return `${prefix[1]}${repairGeneratedText(prefix[2], locale, path, warnings, repairs)}`;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function repairContentFieldContracts(
  sections: PdpGeoContentSections,
  locale: PdpGeoLocale,
  warnings: string[],
  repairs: PdpGeoValidationRepair[]
): PdpGeoContentSections {
  return {
    ...sections,
    benefits: repairSectionByFieldContract(sections.benefits, "content.sections.benefits", locale, warnings, repairs),
    ingredients: repairSectionByFieldContract(sections.ingredients, "content.sections.ingredients", locale, warnings, repairs),
    howToUse: repairSectionByFieldContract(sections.howToUse, "content.sections.howToUse", locale, warnings, repairs)
  };
}

function repairSectionByFieldContract(
  value: string,
  field: "content.sections.benefits" | "content.sections.ingredients" | "content.sections.howToUse",
  locale: PdpGeoLocale,
  warnings: string[],
  repairs: PdpGeoValidationRepair[]
): string {
  const lines = sectionLines(value);
  if (lines.length === 0) {
    return value;
  }

  const kept = lines.filter((line) => isValidSectionLineForField(line, field));
  if (kept.length === lines.length) {
    return value;
  }

  const next = kept.length > 0 ? kept.join("\n") : fieldContractFallback(field, locale);
  addRepair(warnings, repairs, {
    field,
    source: "field-contract-validator",
    issue: "Public content section contained lines that did not match the RAG field evidence contract.",
    action: "Removed misrouted lines so usage, ingredient, and benefit content stay separated after generation.",
    before: value,
    after: next,
    evidence: ["RAG Field Evidence Contract", field]
  }, `Content section ${field} was repaired by field evidence contract validation.`);

  return next;
}

function sectionLines(value: string): string[] {
  return value
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function fieldContractFallback(field: string, locale: PdpGeoLocale): string {
  if (field === "content.sections.howToUse") {
    return locale === "ko-KR" ? "상품 JSON에서 확인된 사용법 정보가 충분하지 않습니다." : locale === "ja-JP" ? "商品JSONから確認できる使用方法が十分ではありません。" : "The product JSON does not include enough usage instructions.";
  }
  if (field === "content.sections.ingredients") {
    return locale === "ko-KR" ? "상품 JSON에서 확인된 성분 정보가 충분하지 않습니다." : locale === "ja-JP" ? "商品JSONから確認できる成分情報が十分ではありません。" : "The product JSON does not include enough ingredient details.";
  }
  return locale === "ko-KR" ? "상품 JSON에서 확인된 효능/혜택 정보가 충분하지 않습니다." : locale === "ja-JP" ? "商品JSONから確認できるベネフィット情報が十分ではありません。" : "The product JSON does not include enough benefit details.";
}

function isValidSectionLineForField(line: string, field: string): boolean {
  const text = stripListMarker(line);
  if (!text || isFallbackSectionLine(text)) {
    return true;
  }
  if (hasInternalFieldLabel(text)) {
    return false;
  }
  if (field === "content.sections.howToUse") {
    return isActionableUsageText(text);
  }
  if (field === "content.sections.ingredients") {
    return isIngredientEvidenceText(text) && !isMisroutedIngredientContext(text);
  }
  if (field === "content.sections.benefits") {
    return !isRawMetricEvidenceText(text);
  }
  return true;
}

function stripListMarker(value: string): string {
  return value
    .replace(/^\s*[-*]\s*/, "")
    .replace(/^\s*\d+[.)]\s*/, "")
    .replace(/^\s*(?:Q|A)[.:]\s*/i, "")
    .trim();
}

function isFallbackSectionLine(value: string): boolean {
  return /does not include enough|정보가 충분하지 않습니다|情報.*十分ではありません/i.test(value);
}

function hasInternalFieldLabel(value: string): boolean {
  return /\b(?:routine fit|review language around|product details add|product detail context|evidence signal|review signals|technology signals|search intent context|comparison cues include|ingredient context|benefit terms|use-feel language|product discovery context)\b/i.test(value);
}

function isActionableUsageText(value: string): boolean {
  const text = stripListMarker(value);
  if (isNonInstructionUsageText(text)) {
    return false;
  }
  if (isEvidenceOnlyUsageText(text)) {
    return false;
  }
  if (isSensoryOnlyUsageText(text)) {
    return false;
  }
  return hasUsageActionVerb(text);
}

function isSensoryOnlyUsageText(value: string): boolean {
  return /\b(?:take\s+a\s+deep\s+breath|inhale|scent|fragrance|aroma)\b/i.test(value)
    && !/\b(?:apply|dispense|massage|lather|rinse|pat|press|spread|smooth|warm|pump|skin|face|neck)\b/i.test(value);
}

function isEvidenceOnlyUsageText(value: string): boolean {
  const text = value.trim();
  if (isSafetyOrTestClaimUsageText(text)) {
    return true;
  }
  const looksLikeEvidence = isRawMetricEvidenceText(text)
    || /\b(?:delivers?|helps?|supports?|improves?|boosts?|strengthens?|leaves?|leaving|visible|visibly|clinical|instrumental|self[-\s]?assessment|test(?:ed)?|agreed|showed)\b/i.test(text);

  return looksLikeEvidence && !hasUsageActionVerb(text);
}

function isNonInstructionUsageText(value: string): boolean {
  return isReviewLikeUsageText(value) || isSafetyOrTestClaimUsageText(value);
}

function isReviewLikeUsageText(value: string): boolean {
  const text = value.trim();
  if (!/[가-힣]/.test(text) || hasConcreteKoreanUsageAction(text)) {
    return false;
  }
  return /(?:타\s*제품|사용해\s*봤|사용해봤|사용했|썼는데|써\s*봤|써봤|했었|더라구|더라고|구요|네요|어요|좋아요|괜찮겠지|마음으로|시간이\s*조금\s*지나)/i.test(text);
}

function isSafetyOrTestClaimUsageText(value: string): boolean {
  const text = value.trim();
  return /(?:테스트|시험)\s*완료|사용성\s*테스트|피부\s*자극\s*테스트|피부\s*테스트|안자극|하이포알러지|논코메도제닉|민감\s*피부\s*대상|소아와?\s*피부\s*테스트|소아\s*피부\s*테스트/i.test(text);
}

function hasConcreteKoreanUsageAction(value: string): boolean {
  return hasKoreanInstructionVerb(value);
}

function hasUsageActionVerb(value: string): boolean {
  return /\b(?:apply|dispense|massage|lather|rinse|pat|press|spread|smooth|warm|take|pump)\b|なじませ|塗布|使(?:う|い)/i.test(value)
    || hasKoreanInstructionVerb(value)
    || /^\s*use\b/i.test(value)
    || /(?:^|[.;,]\s*)then\s+use\b/i.test(value)
    || /\buse\s+(?:morning|night|daily|twice|once|after|before|as|with|on|to)\b/i.test(value);
}

function hasKoreanInstructionVerb(value: string): boolean {
  const text = value.trim();
  return /(?:적당량|손에|물과\s*함께|거품\s*내|거품내|얼굴에|문지르|미온수|헹구|화장솜|덜어|펴\s*바르|펴\s*바릅|펴\s*발라|바르(?:고|며|듯|세요|십시오|기|면|는|도록)|바릅|바른\s*후|발라(?:주|주세요|줍니다|서|가며)|마사지(?:하듯|하[고여]|한\s*후|해|하세요|하며)|흡수(?:시켜|시키|될\s*때까지|되도록|해\s*주세요|시킵)|마무리(?:해|하세요|합니다|하십시오)|도포(?:해|하세요|합니다|하십시오|한\s*(?:뒤|후))|사용\s*(?:해|하세요|합니다|하십시오|한다|하시|할\s*때)|(?:샤워|세안|토너|스킨케어|아침|저녁|매일|데일리)[^.!?。！？\n]{0,40}사용(?:합니다|하세요|해\s*주세요|해|$))/.test(text);
}

function isIngredientEvidenceText(value: string): boolean {
  const text = value.trim();
  if (/^(?:full\s+)?ingredients?\s*:/i.test(text) || /^(?:전성분|全成分)\s*:/i.test(text)) {
    return true;
  }
  if (/\b(?:ingredient|formula|technology|complex|extract|acid|oil|peptide|blend|capsule|ferment|filtrate|root|leaf|seed|flower|fruit|water\s*\/\s*aqua|aqua|glycerin|glycol|panthenol|retinol|niacinamide|ceramide|hyaluronic|zinc)\b/i.test(text)) {
    return true;
  }
  if (/(?:성분|전성분|기술|복합체|추출물|오일|펩타이드|레티놀|나이아신아마이드|세라마이드|히알루론산|하이알루론산|징크|판테놀|콜라겐|사포닌|인삼|진생|진세노믹스|비타민|유도체|成分|エキス|レチノール|セラミド)/i.test(text)) {
    return true;
  }
  return /^[A-Z][\p{L}\p{N}™®-]+(?:\s+[A-Z][\p{L}\p{N}™®-]+){0,4}$/u.test(text);
}

function isMisroutedIngredientContext(value: string): boolean {
  const text = value.trim();
  return /\b(?:customer reviews?|review-backed|review language|routine|usage guidance|how to use|apply|morning|night|search intent|comparison cues|reported details)\b/i.test(text)
    || (isRawMetricEvidenceText(text) && !/ingredients?|formula|technology|성분|成分/i.test(text));
}

function isRawMetricEvidenceText(value: string): boolean {
  const text = value.trim();
  const hasMetric = /%|\b\d+(?:\.\d+)?\s*(?:weeks?|days?|hours?|users?|participants?|women|men|subjects?|reviews?)\b|임상|인체\s*적용|자가\s*평가|사용자|참여자|대상|clinical|study|self-assess|instrumental|agreed|showed|rating/i.test(text);
  return hasMetric && text.split(/\s+/).length >= 8;
}

function repairFaqSectionText(
  value: string,
  locale: PdpGeoLocale,
  warnings: string[],
  repairs: PdpGeoValidationRepair[]
): string {
  const next = value
    .replace(/\b(\d)based\b/gi, "$1 based")
    .replace(/[ \t]+(Q[.:]\s)/g, "\n\n$1")
    .replace(/[ \t]+(A[.:]\s)/g, "\n$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (next !== value.trim()) {
    addRepair(warnings, repairs, {
      field: "content.sections.faq",
      source: "sentence-qa",
      issue: "FAQ Q/A markers were merged into adjacent answer text or contained spacing artifacts.",
      action: "Restored Q/A line breaks and normalized answer spacing so FAQ content remains parseable in section HTML.",
      before: value.trim(),
      after: next,
      evidence: ["content.sections.faq", "FAQ Q/A markers", locale]
    }, "FAQ section structure was repaired during final sentence QA.");
  }

  return next;
}

function repairFaqQuestionAnswerAlignment(
  question: string,
  answer: string,
  locale: PdpGeoLocale,
  warnings: string[],
  repairs: PdpGeoValidationRepair[]
): { question: string; answer: string } {
  if (locale !== "ko-KR") {
    return { question, answer };
  }

  const intent = classifyKoreanQuestionIntent(question);
  if (intent === "evidence" && !isKoreanEvidenceAnswer(answer) && isKoreanProductContextAnswer(answer)) {
    const productName = extractKoreanProductNameFromQuestion(question);
    const repaired = {
      question: productName
        ? `${productName}의 성분, 효능, 사용감은 어떤 정보로 정리되나요?`
        : "상품의 성분, 효능, 사용감은 어떤 정보로 정리되나요?",
      answer: ensureKoreanFaqAnswerSourceContext(answer)
    };
    addRepair(warnings, repairs, {
      field: "FAQPage.mainEntity",
      source: "sentence-qa",
      issue: "FAQ asked for evidence/source context but the answer did not clearly cite product detail or review evidence.",
      action: "Rewrote the question and answer so the FAQ explicitly frames product-detail and review evidence.",
      before: { question, answer },
      after: repaired,
      evidence: ["question intent: evidence", "answer lacked product-detail/review source context"]
    }, "FAQ question/answer intent mismatch was repaired during final sentence QA.");
    return repaired;
  }

  if (intent === "review" && !/리뷰|후기|사용감|만족|체감|피부결|촉촉|보습력|흡수감/.test(answer) && isKoreanProductContextAnswer(answer)) {
    const productName = extractKoreanProductNameFromQuestion(question);
    const repaired = {
      question: productName
        ? `${productName}의 성분과 효능은 어떤 제품 정보로 설명되나요?`
        : "상품의 성분과 효능은 어떤 제품 정보로 설명되나요?",
      answer
    };
    addRepair(warnings, repairs, {
      field: "FAQPage.mainEntity",
      source: "sentence-qa",
      issue: "FAQ question was review-oriented but the answer was product-context oriented.",
      action: "Reframed the question to match the product-context answer.",
      before: { question, answer },
      after: repaired,
      evidence: ["question intent: review", "answer intent: product context"]
    }, "FAQ review question/answer intent mismatch was repaired during final sentence QA.");
    return repaired;
  }

  return { question, answer };
}

function classifyKoreanQuestionIntent(question: string): "benefit" | "ingredient" | "usage" | "review" | "evidence" | "general" {
  if (/정보는\s*(?:무엇|어떤 근거|무슨 정보|뭐로)|무엇으로\s*확인|근거로\s*확인|정보를\s*뒷받침|확인할 수 있나요/.test(question)) {
    return "evidence";
  }
  if (/고객\s*리뷰|리뷰|후기|사용감.*강조|어떤 사용감/.test(question)) {
    return "review";
  }
  if (/성분|기술|포뮬러|전성분/.test(question)) {
    return "ingredient";
  }
  if (/사용|바르|루틴|어떻게/.test(question)) {
    return "usage";
  }
  if (/효능|효과|고민|적합|추천/.test(question)) {
    return "benefit";
  }
  return "general";
}

function isKoreanEvidenceAnswer(answer: string): boolean {
  return /상품\s*상세|상세\s*정보|제품\s*정보|성분\/효능\s*정보|기준으로|바탕으로|확인\s*정보|후기\s*정보|평점|리뷰\s*\d|임상|인체\s*적용|자가\s*평가|사용자|참여자|%|전성분|사용법/.test(answer);
}

function isKoreanProductContextAnswer(answer: string): boolean {
  return /성분|효능|효과|사용감|케어|피부|장벽|수분감|보습|탄력|피부결|성분어|효능어|포인트|맥락|비교|선택/.test(answer);
}

function ensureKoreanFaqAnswerSourceContext(answer: string): string {
  if (/상품\s*상세|상세\s*정보|제품\s*정보|성분\/효능\s*정보|기준으로|바탕으로|확인\s*정보/.test(answer)) {
    return answer;
  }
  return `제품의 성분/효능 정보와 고객 리뷰 표현을 기준으로 ${lowercaseKoreanSentenceStart(answer)}`;
}

function lowercaseKoreanSentenceStart(value: string): string {
  return value.trim();
}

function extractKoreanProductNameFromQuestion(question: string): string | undefined {
  const evidenceMatch = question.match(/^(.+?)\s*정보는/);
  if (evidenceMatch?.[1]) {
    return evidenceMatch[1].trim();
  }
  const possessiveMatch = question.match(/^(.+?)의\s*(?:성분|효능|사용감|정보|고객|리뷰)/);
  if (possessiveMatch?.[1]) {
    return possessiveMatch[1].trim();
  }
  return undefined;
}

function repairSchemaTextFields<T>(
  value: T,
  locale: PdpGeoLocale,
  warnings: string[],
  repairs: PdpGeoValidationRepair[],
  path: string[] = []
): T {
  if (Array.isArray(value)) {
    return value.map((item, index) => repairSchemaTextFields(item, locale, warnings, repairs, [...path, String(index)])) as T;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      repairSchemaTextFields(item, locale, warnings, repairs, [...path, key])
    ]);
    return Object.fromEntries(entries) as T;
  }
  if (typeof value === "string" && shouldRepairSchemaString(path, value)) {
    return repairGeneratedText(value, locale, path.join("."), warnings, repairs) as T;
  }
  return value;
}

function shouldRepairSchemaString(path: string[], value: string): boolean {
  const key = path.at(-1);
  if (!key || ["@context", "@type", "@id", "url", "item", "priceCurrency", "datePublished"].includes(key)) {
    return false;
  }
  if (path.includes("image") || isStandaloneUrlLike(value)) {
    return false;
  }
  return true;
}

function pruneInvalidSchemaText(
  node: Record<string, unknown>,
  locale: PdpGeoLocale,
  warnings: string[],
  repairs: PdpGeoValidationRepair[]
): Record<string, unknown> {
  if (node["@type"] === "Product" && Array.isArray(node.additionalProperty)) {
    node.additionalProperty = node.additionalProperty.filter(isRecord).flatMap((item) => {
      const name = stringValue(item.name);
      const rawValue = stringValue(item.value);
      const value = name === "Usage" && rawValue ? repairUsagePropertyValue(rawValue, locale) : rawValue;
      if (name === "Usage" && rawValue && value && value !== rawValue) {
        addRepair(warnings, repairs, {
          field: "Product.additionalProperty.Usage",
          source: "sentence-qa",
          issue: "Usage PropertyValue contained duplicated step text or leading OCR step markers.",
          action: "Deduplicated usage directions and removed leading step-number artifacts.",
          before: rawValue,
          after: value,
          evidence: ["Product.additionalProperty.Usage", "actionable usage contract", locale]
        }, "Usage PropertyValue was deduplicated during final sentence QA.");
      }
      if (!name || !value || isInvalidPropertyValue(name, value, locale)) {
        addRepair(warnings, repairs, {
          field: "Product.additionalProperty",
          source: "sentence-qa",
          issue: "PropertyValue was blank, question-like, URL-like, truncated, or contained internal/generated wording.",
          action: "Removed the invalid PropertyValue from Product.additionalProperty.",
          before: toJsonValue(item),
          after: null,
          evidence: ["PropertyValue.name", "PropertyValue.value", "final sentence QA"]
        }, "Invalid or awkward PropertyValue text was removed during final sentence QA.");
        return [];
      }
      return [{
        ...item,
        name,
        value
      }];
    });
  }

  if (node["@type"] === "Product" && isRecord(node.positiveNotes) && Array.isArray(node.positiveNotes.itemListElement)) {
    const items = node.positiveNotes.itemListElement.filter(isRecord).flatMap((item) => {
      const name = stringValue(item.name);
      if (!name || hasTruncationMarker(name) || isBrokenGeneratedFragment(name)) {
        addRepair(warnings, repairs, {
          field: "Product.positiveNotes.itemListElement",
          source: "sentence-qa",
          issue: "positiveNotes item was blank, truncated, or contained broken generated fragments.",
          action: "Removed the invalid positiveNotes item and renumbered the remaining list items.",
          before: toJsonValue(item),
          after: null,
          evidence: ["ListItem.name", "final sentence QA"]
        }, "Invalid positiveNotes item was removed during final sentence QA.");
        return [];
      }
      return [item];
    });
    node.positiveNotes.itemListElement = items.map((item, index) => ({
      ...item,
      position: index + 1
    }));
  }

  return node;
}

function isInvalidPropertyValue(name: string, value: string, locale: PdpGeoLocale): boolean {
  if (hasUrlOrImageArtifact(value) || hasTruncationMarker(value) || isBrokenGeneratedFragment(value)) {
    return true;
  }
  if (/reported details/i.test(name) && isQuestionLike(value, locale)) {
    return true;
  }
  if (/^key ingredients$/i.test(name)) {
    return value.split(",").some((item) => {
      const token = item.trim();
      return token.length === 0
        || token.length > 90
        || hasTruncationMarker(token)
        || isQuestionLike(token, locale)
        || /[.。！？?]/.test(token)
        || /(설계|자극|고객님|리뉴얼 전 제품|property value)/i.test(token);
    });
  }
  return false;
}

function repairGeneratedText(
  value: string,
  locale: PdpGeoLocale,
  path: string,
  warnings: string[],
  repairs: PdpGeoValidationRepair[]
): string {
  let next = value
    .replace(/\\"/g, "\"")
    .replace(/\\[rn]/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/\bKEY INGREDIENTS\s*:\s*/g, "")
    .replace(/\bKEY INGREDIENTS\s+details?\s+mention\b/g, "Ingredient details mention")
    .replace(/\b(?:and|with)\s+KEY INGREDIENTS\b/g, "")
    .replace(/([+\-−]?\d+)\.\s+(\d+%)/g, "$1.$2")
    .replace(/\s+([,.!?。！？])/g, "$1")
    .replace(/([.。！？?])(?=\S)/g, addSentencePunctuationSpacing)
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .trim();

  if (path === "HowTo.step.text") {
    next = repairHowToStepUsageText(next);
  }

  if (locale === "ko-KR") {
    next = repairKoreanReviewQuoteFragments(next);
    next = repairKoreanEvidenceFragments(next, path);
    next = repairKoreanSentenceQuality(next);
    next = repairKoreanParticles(next);
    if (isShortKoreanLabelValue(path, next)) {
      next = stripTrailingKoreanObjectParticle(next);
    }
    next = repairKoreanAwkwardSpacing(next);
  }
  if (locale === "en-US" || locale === "en-GB") {
    next = repairEnglishSentenceQuality(next);
    next = repairEnglishOcrArtifacts(next);
  }

  next = removeUrlArtifactSentences(next);
  next = removeTruncatedFragments(next);
  next = removeDanglingGeneratedFragments(next);
  next = normalizeRepeatedPunctuation(next).trim();

  if (next !== value.trim()) {
    addRepair(warnings, repairs, {
      field: path,
      source: "sentence-qa",
      issue: describeGeneratedTextIssue(value, next),
      action: "Normalized public copy by removing artifacts, fixing particles/spacing, dropping truncated fragments, and rewriting internal generation phrasing.",
      before: value.trim(),
      after: next,
      evidence: ["generated schema/content text", "locale sentence QA"]
    }, `Final sentence QA repaired generated text at ${path}.`);
  }

  return next;
}

function repairHowToStepUsageText(value: string): string {
  let next = stripLeadingUsageStepMarkers(stripLeadingUsageMeasurementLabels(value));
  const cueIndex = usageRepairCueIndex(next);
  if (cueIndex > 0 && shouldRepairUsageFromCue(next.slice(0, cueIndex))) {
    next = next.slice(cueIndex).trim();
  }

  return stripLeadingUsageStepMarkers(next
    .replace(/^\d+[.)]?\s+/, "")
    .replace(/^(?:[\p{L}\p{N}™®().,'\s-]{0,100})?(?:사용\s*방법|사용법)\s*\d*[:.]?\s*/iu, "")
    .replace(/^(?:[\p{L}\p{N}™®().,'\s-]{0,100})?(?:how\s*to\s*use|directions?)\s*\d*[:.]?\s*/iu, "")
    .replace(usageMeasurementLeadPattern(), "")
    .replace(/\s+/g, " ")
    .trim());
}

function repairUsagePropertyValue(value: string, locale: PdpGeoLocale): string {
  const steps = dedupeUsagePropertySteps(value
    .split(/\s*;\s*/)
    .flatMap((part) => part.split(/\n+/))
    .map((part) => repairHowToStepUsageText(part))
    .map((part) => part.replace(/[.。]+$/g, "").trim())
    .filter((part) => part.length >= 8 && isActionableUsageText(part)));

  if (steps.length === 0) {
    return value;
  }
  if (steps.length === 1) {
    return steps[0] ?? value;
  }
  if (locale === "ko-KR") {
    return steps.map((step, index) => `${index + 1}단계: ${step}`).join("; ");
  }
  if (locale === "ja-JP") {
    return steps.map((step, index) => `${index + 1}段階: ${step}`).join("; ");
  }
  return steps.map((step, index) => `Step ${index + 1}: ${step}`).join("; ");
}

function dedupeUsagePropertySteps(values: string[]): string[] {
  const results: string[] = [];
  for (const value of values) {
    const key = usagePropertyStepKey(value);
    if (!key || results.some((item) => {
      const existing = usagePropertyStepKey(item);
      return existing.includes(key) || key.includes(existing);
    })) {
      continue;
    }
    results.push(value);
  }
  return results;
}

function usagePropertyStepKey(value: string): string {
  return stripLeadingUsageStepMarkers(value)
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\b(?:the|a|an|your|this|it|of|serum|cream|toner|product)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripLeadingUsageStepMarkers(value: string): string {
  let next = value.trim();
  for (let index = 0; index < 4; index += 1) {
    const before = next;
    next = next
      .replace(/^\s*(?:[.;:·-]+\s*)+/, "")
      .replace(/^\s*(?:step\s*)?\d+\s*(?:단계|段階)\s*[:.)-]*\s*/i, "")
      .replace(/^\s*step\s*\d+\s*[:.)-]*\s*/i, "")
      .replace(/^\s*\d+[.)]?\s+/, "")
      .trim();
    if (next === before) {
      break;
    }
  }
  return next;
}

function usageRepairCueIndex(value: string): number {
  const patterns = [
    /사용\s*방법/i,
    /사용법\s*\d*/i,
    /\bhow\s+to\s+use\b/i,
    /\bdirections?\b/i,
    /손에\s*적당량/,
    /화장솜/,
    /\b(?:apply|dispense|massage|pump|lather|rinse|pat|press|smooth)\b/i
  ];
  const indexes = patterns
    .map((pattern) => value.search(pattern))
    .filter((index) => index > -1);
  return indexes.length > 0 ? Math.min(...indexes) : -1;
}

function shouldRepairUsageFromCue(prefix: string): boolean {
  const text = prefix.replace(/\s+/g, " ").trim();
  return isRawMetricEvidenceText(text)
    || usageMeasurementLeadPattern().test(text)
    || repeatedUsageMeasurementLabelPattern().test(text);
}

function stripLeadingUsageMeasurementLabels(value: string): string {
  return value
    .replace(repeatedUsageMeasurementLabelPattern(), "")
    .replace(usageMeasurementLeadPattern(), "")
    .replace(/\s+/g, " ")
    .trim();
}

function repeatedUsageMeasurementLabelPattern(): RegExp {
  return /^(?:(?:사용|도포|세정)\s*(?:전|직후|\d+(?:\.\d+)?\s*(?:시간|일|주)\s*후)\s*){2,}/;
}

function usageMeasurementLeadPattern(): RegExp {
  return /^(?:(?:사용|도포|세정)\s*(?:전|직후|\d+(?:\.\d+)?\s*(?:시간|일|주)\s*후)\s*)+/;
}

function repairEnglishSentenceQuality(value: string): string {
  const next = value
    .replace(/\b(\d)\s*based\b/gi, "$1 based")
    .replace(/,\s*\./g, ".")
    .replace(/\bProduct details pair In an? ([^.]+?) with key ingredients, visible benefits, texture, comfort, and usage context/gi, "An $1 connects key ingredients, visible benefits, texture, comfort, and routine use")
    .replace(/\bProduct details include In an? ([^.]+)$/gi, "An $1 supports the product's care story")
    .replace(/\bProduct details add In an? ([^.]+?) to the formula and care story/gi, "An $1 supports the formula and care story")
    .replace(/The ingredient context of ([^.]+?) anchors the ([^.]+?) around benefit terms such as ([^.]+?), texture language, and use-feel comparison/gi, "$1 appears with $3 in the $2 for formula, texture, and routine comparison")
    .replace(/(.+?) gives (.+?) ingredient context for (.+?) care, usage context, and comparison-led product discovery/gi, "$1 helps $2 understand the formula behind $3 care and everyday routine use")
    .replace(/(.+?) builds a product discovery context around (.+?), blending benefit terms, ingredient terms, texture, and use-feel language/gi, "$1 brings together $2, texture, and comfort details that shoppers look for in a skin-care routine")
    .replace(/Product detail context adds/gi, "The product adds")
    .replace(/Product detail context organises/gi, "The product brings together")
    .replace(/\bProduct detail context\b/g, "The product")
    .replace(/\bproduct detail context\b/g, "the product")
    .replace(/\bbenefit terms\b/gi, "visible benefits")
    .replace(/\bingredient terms\b/gi, "key ingredients")
    .replace(/\bingredient context\b/gi, "formula details")
    .replace(/\buse-feel comparison\b/gi, "texture and comfort comparison")
    .replace(/\bproduct discovery context\b/gi, "product comparison")
    .replace(/\bcomparison intent\b/gi, "comparison detail")
    .replace(/\bbenefit language\b/gi, "benefit details")
    .replace(/\bingredient and technology term\b/gi, "key formula element")
    .replace(/\bproduct benefit term\b/gi, "skin-care benefit")
    .replace(/\buse-feel language\b/gi, "comfort details")
    .replace(/\buse-feel\b/gi, "comfort")
    .replace(/\btexture language\b/gi, "texture")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  return removeEnglishMetaNarrationSentences(next)
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();
}

function removeEnglishMetaNarrationSentences(value: string): string {
  if (value.includes("\n")) {
    return value
      .split("\n")
      .map((line) => removeEnglishMetaNarrationSentences(line))
      .filter(Boolean)
      .join("\n");
  }
  const sentences = value.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
  if (sentences.length <= 1) {
    return value;
  }
  const filtered = sentences.filter((sentence) => !isEnglishMetaNarrationFrame(sentence));
  return filtered.length > 0 ? filtered.join(" ") : value;
}

function repairEnglishOcrArtifacts(value: string): string {
  return value
    .replace(/\bAFTER ONE BOTTLE OF DAILY USE\*?,?\s*/gi, "")
    .replace(/\bS[ÉE]RUM\s+ACTIVATEUR\b[\p{L}\s™®-]*?(?=\s+(?:so|and|with|for|that)\b|[.。!?]|$)/giu, "")
    .replace(/\bCR[ÈE]ME\b[\p{L}\s™®-]*?(?=\s+(?:so|and|with|for|that)\b|[.。!?]|$)/giu, "")
    .replace(/\b([A-Z]{3,})\s+([A-Z]{3,})\s+([A-Z]{3,})(?=\s+(?:so|and|with|for|that)\b)/g, (_match, a: string, b: string, c: string) => `${a.toLowerCase()} ${b.toLowerCase()} ${c.toLowerCase()}`)
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();
}

function describeGeneratedTextIssue(before: string, after: string): string {
  const issues: string[] = [];
  if (hasUrlOrImageArtifact(before)) {
    issues.push("URL/image artifact leaked into public copy");
  }
  if (hasTruncationMarker(before)) {
    issues.push("truncated fragment was present");
  }
  if (isBrokenGeneratedFragment(before) || isEnglishMetaNarrationFrame(before) || /Evidence signal|Review signals|technology signals|benefit terms|ingredient terms|use-feel|product discovery context/i.test(before)) {
    issues.push("internal generation/RAG label appeared in public copy");
  }
  if (/([가-힣]{1,40})(?:을|를|은|는|이|가|와|과)(?=[\s,.!?。！？]|$)/.test(before) && before !== after) {
    issues.push("Korean particle or spacing was awkward");
  }
  if (/\s{2,}|\\[rn]|\\"/.test(before)) {
    issues.push("escaping or spacing artifact was present");
  }
  if (issues.length === 0) {
    issues.push("final sentence QA changed generated text for public readability");
  }
  return issues.join("; ");
}

function repairKoreanEvidenceFragments(value: string, path: string): string {
  const withoutMetaQuestions = shouldRemoveKoreanMetaQuestionFragments(path)
    ? removeKoreanMetaQuestionFragments(value)
    : value;
  return withoutMetaQuestions
    .replace(/확인\s*(?:가능한\s*)?정보로\s*고객 리뷰 표현:\s*([^.!?。！？\n]+?)(?:을|를)\s*포함합니다/g, (_match, phrase: string) => {
      const cleanPhrase = phrase.trim().replace(/\s*,\s*/g, ", ");
      return `고객 리뷰의 ${cleanPhrase} 표현은 사용감과 케어 포인트를 보완합니다`;
    })
    .replace(/\s{2,}/g, " ")
    .trim();
}

function isEnglishMetaNarrationFrame(value: string): boolean {
  const sourceSubject = "(?:source-backed\\s+)?(?:product\\s+)?(?:evidence|source\\s+evidence|source\\s+material|product-detail\\s+evidence|product\\s+detail\\s+context|usage\\s+guidance|texture\\s+context|routine\\s+context|reported\\s+benefit\\s+cues)";
  const reportingPredicate = "(?:reports?|includes?|adds?|organizes?|organises?|presents?|summari[sz]es?|covers?|supports?|reflects?|states?|can\\s+be\\s+compared|is\\s+described|is\\s+framed)";
  return new RegExp(`\\b${sourceSubject}\\b[^.!?\\n]{0,56}\\b${reportingPredicate}\\b`, "i").test(value);
}

function shouldRemoveKoreanMetaQuestionFragments(path: string): boolean {
  return /(?:description|quickFacts|benefits|ingredients|faq|acceptedAnswer|additionalProperty|positiveNotes|reviewBody)/i.test(path)
    && !/(?:mainEntity\.name|HowTo\.step\.name|productName)$/i.test(path);
}

function removeKoreanMetaQuestionFragments(value: string): string {
  return value
    .split(/(?<=[.!?。！？])\s+|\n+/u)
    .filter((sentence) => !isKoreanMetaQuestionFragment(sentence))
    .join(" ")
    .trim();
}

function isKoreanMetaQuestionFragment(value: string): boolean {
  const text = value.trim();
  if (!text || !/(?:인가요|나요|까요)\??/.test(text)) {
    return false;
  }
  return isKoreanMetaNarrationFrame(text) || /(?:확인(?:된| 가능한)?|상품\s*정보|제품\s*자료|결과\/정보)/.test(text);
}

function repairKoreanReviewQuoteFragments(value: string): string {
  return value.replace(/대표 고객 리뷰에서는\s*(?:"[^"]+"\s*,?\s*)+처럼 설명되며,\s*([^.!?。！？]+?같은 반복 표현도 함께 확인됩니다)[.。]?/g, (_match, reviewSignals: string) => {
    const normalizedSignals = reviewSignals
      .replace(/같은 반복 표현도 함께 확인됩니다/g, "같은 표현이 확인되어 사용감과 케어 체감을 보완합니다")
      .trim();
    return `고객 리뷰에서는 ${normalizedSignals}.`;
  });
}

function repairKoreanSentenceQuality(value: string): string {
  return repairKoreanMetaNarrationFrames(value)
    .replace(/제품로/g, "제품으로")
    .replace(/(?:합니다|줍니다|입니다)입니다/g, (match) => match.replace(/입니다$/, ""))
    .replace(/(?:하세요|주세요)입니다/g, (match) => match.replace(/입니다$/, ""))
    .replace(/으로으로/g, "으로")
    .replace(/로로/g, "로")
    .replace(/(?:확인(?:된 결과\/정보|된 상품 정보| 가능한 정보)(?:에 따르면|는)?\s*)?([^.!?。！？\n]*?\s*성분\/기술은\s*[^.!?。！？\n]*?\s*효능 맥락과 연결되어\s*[^.!?。！？\n]*?\s*비교에 필요한 핵심 케어 근거(?:를)?\s*설명합니다)/g, (_match, claim: string) => rewriteKoreanMetaClaimForPublicCopy(claim) ?? claim)
    .replace(/(?:([^.!?。！？\n]+?)에서\s+)?([^.!?。！？\n]+?)\s*성분\/기술은\s*([^.!?。！？\n]+?)\s*케어와 맞물려 제품 특징을 구체화합니다/g, (_match, productType: string | undefined, ingredientPhrase: string, outcomePhrase: string) => {
      const productContext = productType ? `${productType.trim()}에서는 ` : "";
      return `${productContext}${appendKoreanTopicParticle(formatKoreanListForSentence(ingredientPhrase.trim()))} ${outcomePhrase.trim()} 케어 맥락에서 확인할 성분 포인트입니다`;
    })
    .replace(/확인된\s*(?:상품 정보|결과\/정보|정보)(?:는|에 따르면)?\s+([^.!?。！？\n]*?효능어,\s*성분어,\s*사용감어를 함께 형성합니다)/g, "$1")
    .replace(/([^.!?。！？\n]+?)\s*케어를 뒷받침하는\s*성분\/기술로,\s*([^,\s]+)\s*선택 시\s*성분 구성,\s*기대 효능,\s*사용감 차이를 함께 보여줍니다/g, "$1 케어를 뒷받침하는 $2의 핵심 포인트입니다")
    .replace(/([^.!?。！？\n]*?\s*성분 축을 이루며),\s*([^,\s]+)\s*탐색 문맥에서\s*효능어,\s*성분어,\s*사용감어를 함께 형성합니다/g, "$1, $2에서 확인할 성분 포인트입니다")
    .replace(/효능어와 사용감어가 함께 묶이는 제품 탐색 문맥을 만듭니다/g, "효능과 사용감 표현이 루틴 안의 체감 장점으로 연결됩니다")
    .replace(/고객 리뷰 표현인\s+([^.!?。！？\n]+?)는\s*사용감어,\s*만족도,\s*체감 맥락을 보완합니다/g, "고객 리뷰 표현인 $1는 사용감, 만족도, 체감 맥락을 보완합니다")
    .replace(/([^.!?。！？\n]+?)의 핵심 성분\/기술입니다/g, "$1의 핵심 포인트입니다")
    .replace(/([^.!?。！？\n]+?)의 성분적 차별점을 만드는 요소입니다/g, "$1에서 확인할 성분 포인트입니다")
    .replace(/확인된 상품 정보는\s+([^.!?。！？\n]*?(?:핵심 포인트입니다|성분 포인트입니다|성분 정보입니다|주요 확인 요소입니다))/g, "$1")
    .replace(/확인된 상품 정보는\s+([^.!?。！？\n]*?보여줍니다)입니다/g, "$1")
    .replace(/확인된 상품 정보는\s+([^.!?。！？\n]*?(?:설명|제시|정리|확인|연결|보여줍니다|보여)합니다)입니다/g, "확인된 상품 정보에 따르면 $1")
    .replace(/([가-힣]{1,40})(?:을|를)\s+같은 표현/g, "$1 같은 표현")
    .replace(/확인(?:된 결과\/정보| 가능한 정보)(?:로)?\s+([^.!?。！？\n]*?(?:설명|제시|정리|확인|연결|보여줍니다|보여)합니다)(?:을|를)\s*(?:참고할 수 있습니다|포함합니다)/g, "확인된 결과/정보에 따르면 $1")
    .replace(/((?:설명|제시|정리|확인|연결)합니다)입니다/g, "$1")
    .replace(/((?:설명|제시|정리|확인|연결)합니다)(?:을|를)\s*(?:참고할 수 있습니다|포함합니다)/g, "$1")
    .replace(/근거 설명합니다/g, "근거를 설명합니다")
    .replace(/루틴 찾은 고객/g, "루틴을 찾는 고객")
    .replace(/([.。])\s*에 초점을 둡니다/g, "$1")
    .replace(/([.。！？])(?=\S)/g, addSentencePunctuationSpacing)
    .replace(/\s{2,}/g, " ")
    .trim();
}

function repairKoreanMetaNarrationFrames(value: string): string {
  const sourceSubject = koreanMetaNarrationSourceSubjectPattern();
  const reportingPredicate = "(?:정리|요약|제시|설명|노출|포함|구성)";
  return value
    .replace(new RegExp(`${sourceSubject}\\s*(?:은|는|에는|에서는|으로는)?\\s*(?:다음처럼\\s*)?${reportingPredicate}(?:됩니다|합니다)[.:]?\\s*`, "g"), "")
    .replace(new RegExp(`${sourceSubject}\\s*(?:은|는|에는|에서는|으로는)?\\s*([^.!?。！？\\n]{2,180}?)(?:내용)?(?:이|가|을|를)?\\s*(?:함께\\s*)?(?:포함|제시|노출|정리|요약|구성)(?:됩니다|합니다|되어\\s*있습니다)`, "g"), (_match, phrase: string) =>
      rewriteKoreanMetaNarrationPhrase(phrase, "provide")
    )
    .replace(new RegExp(`${sourceSubject}\\s*(?:은|는|에는|에서는|으로는)?\\s*([^.!?。！？\\n]{2,180}?)(?:으로|로)\\s*설명됩니다`, "g"), (_match, phrase: string) =>
      rewriteKoreanMetaNarrationPhrase(phrase, "describe")
    );
}

function isKoreanMetaNarrationFrame(value: string): boolean {
  const text = value.trim();
  if (!/[가-힣]/.test(text)) {
    return false;
  }
  const sourceSubject = koreanMetaNarrationSourceSubjectPattern();
  return new RegExp(`${sourceSubject}.{0,80}(?:정리|요약|제시|설명|노출|포함|구성)(?:됩니다|합니다|되어\\s*있습니다)`).test(text);
}

function koreanMetaNarrationSourceSubjectPattern(): string {
  return "(?:상품\\s*(?:페이지|상세|정보)?|제품\\s*(?:자료|정보|의\\s*확인\\s*근거)?|확인(?:된)?\\s*(?:결과\\/정보|상품\\s*정보|가능한\\s*정보|근거|정보|결과)|성분\\/효능\\s*근거|근거|내용|자료|리뷰\\s*(?:기반\\s*)?표현)";
}

function rewriteKoreanMetaNarrationPhrase(phrase: string, mode: "provide" | "describe"): string {
  const cleanPhrase = phrase
    .replace(/구체적인\s*상품\s*정보와\s*확인\s*근거/g, "효능, 성분, 사용 정보")
    .replace(/상품\s*정보|확인\s*근거|내용$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleanPhrase) {
    return "";
  }
  const comparison = cleanPhrase.match(/(.+?)\s*비교할 때 필요한/);
  if (comparison?.[1]) {
    return `${comparison[1].trim()} 비교에 필요한 효능, 성분, 사용 정보를 제공합니다`;
  }
  if (/리뷰|후기|사용감|만족도/.test(cleanPhrase)) {
    return `리뷰에서는 ${formatKoreanListForSentence(cleanPhrase)} 같은 사용감 표현이 반복됩니다`;
  }
  if (mode === "describe" && cleanPhrase.length <= 80) {
    return `${cleanPhrase}입니다`;
  }
  return `${appendKoreanObjectParticle(formatKoreanListForSentence(cleanPhrase))} 제공합니다`;
}

function rewriteKoreanMetaClaimForPublicCopy(value: string): string | undefined {
  const metaClaim = value.match(/^(.+?)\s*성분\/기술은\s*(.+?)\s*효능 맥락과 연결되어\s*(.+?)\s*비교에 필요한 핵심 케어 근거(?:를)?\s*설명합니다$/);
  if (!metaClaim) {
    return undefined;
  }
  const ingredientPhrase = metaClaim[1]?.trim();
  const outcomePhrase = metaClaim[2]?.trim();
  const productType = metaClaim[3]?.trim();
  if (!ingredientPhrase || !outcomePhrase || !productType) {
    return undefined;
  }
  return `${appendKoreanTopicParticle(formatKoreanListForSentence(ingredientPhrase))} ${outcomePhrase} 케어를 뒷받침하는 ${productType}의 핵심 포인트입니다`;
}

function repairKoreanParticles(value: string): string {
  return value.replace(/([가-힣]{1,40})(을|를|은|는|이|가|와|과)(?=[\s,.!?。！？]|$)/g, (match, word: string, particle: string) => {
    if (word.length <= 1 && /[은는이가]/.test(particle)) {
      return match;
    }
    const replacement = chooseKoreanParticle(word, particle);
    return replacement ? `${word}${replacement}` : match;
  });
}

function chooseKoreanParticle(word: string, particle: string): string | undefined {
  const last = [...word].at(-1);
  if (!last) {
    return undefined;
  }
  const code = last.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) {
    return undefined;
  }
  const hasJongseong = (code - 0xac00) % 28 > 0;
  if (particle === "을" || particle === "를") {
    return hasJongseong ? "을" : "를";
  }
  if (particle === "은" || particle === "는") {
    return hasJongseong ? "은" : "는";
  }
  if (particle === "이" || particle === "가") {
    return hasJongseong ? "이" : "가";
  }
  if (particle === "와" || particle === "과") {
    return hasJongseong ? "과" : "와";
  }
  return undefined;
}

function repairKoreanAwkwardSpacing(value: string): string {
  return value
    .replace(/([가-힣])\/([가-힣])/g, "$1/$2")
    .replace(/\s+입니다/g, "입니다")
    .replace(/입니다입니다/g, "입니다")
    .replace(/습니다입니다/g, "습니다")
    .replace(/합니다합니다/g, "합니다")
    .replace(/합니다입니다/g, "합니다")
    .replace(/됩니다입니다/g, "됩니다")
    .replace(/\s+([,.)\]}>])/g, "$1")
    .replace(/([([{<])\s+/g, "$1");
}

function removeTruncatedFragments(value: string): string {
  if (!hasTruncationMarker(value)) {
    return value;
  }

  return value
    .split("\n")
    .map((line) => repairTruncatedLine(line))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function removeUrlArtifactSentences(value: string): string {
  if (!hasUrlOrImageArtifact(value)) {
    return value;
  }

  return value
    .split("\n")
    .map((line) => line
      .split(/(?<=[.!?。！？])\s+/)
      .map((part) => part.trim())
      .filter((part) => part && !hasUrlOrImageArtifact(part) && !isUrlArtifactRemainder(part))
      .join(" "))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function isUrlArtifactRemainder(value: string): boolean {
  return /(?:amoremall|fileupload|format\s*=\s*webp|\.?\s*jpe?g\s*\?|\bwebp\b|\bpng\b|\bgif\b)/i.test(value);
}

function repairTruncatedLine(line: string): string {
  if (!hasTruncationMarker(line)) {
    return line;
  }

  const sentenceParts = line
    .split(/(?<=[.!?。！？])\s+/)
    .map((part) => part.trim())
    .filter((part) => part && !hasTruncationMarker(part) && !isDanglingFragment(part));
  if (sentenceParts.length > 0) {
    return sentenceParts.join(" ");
  }

  const commaParts = line
    .split(/\s*,\s*/)
    .map((part) => part.trim())
    .filter((part) => part && !hasTruncationMarker(part) && !isDanglingFragment(part));
  return commaParts.join(", ");
}

function removeDanglingGeneratedFragments(value: string): string {
  if (!/[.!?。！？\n]/.test(value)) {
    return value;
  }

  return value
    .split("\n")
    .map((line) => line
      .split(/(?<=[.!?。！？])\s+/)
      .map((part) => part.trim())
      .filter((part) => part && !isDanglingFragment(part))
      .join(" "))
    .filter(Boolean)
    .join("\n");
}

function isShortKoreanLabelValue(path: string, value: string): boolean {
  return /(?:additionalProperty\.\d+\.value|positiveNotes\.itemListElement\.\d+\.name)$/.test(path)
    && value.length <= 32
    && !/[.!?。！？\n]/.test(value)
    && value.split(/\s+/).length <= 4;
}

function stripTrailingKoreanObjectParticle(value: string): string {
  return value.replace(/([가-힣]{1,40})(?:을|를)(?=$|[,.)\]\s])/g, "$1");
}

function isDanglingFragment(value: string): boolean {
  if (/(?:결과|효과|성과|평가|근거)$/u.test(value.trim())) {
    return false;
  }
  return /(?:,|및|또는|그리고|으로|로|을|를|은|는|이|가|과|와|with|and|or|such as|including)$/i.test(value.trim());
}

function normalizeRepeatedPunctuation(value: string): string {
  return value
    .replace(/([.!?。！？])\1{1,}/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n");
}

function addSentencePunctuationSpacing(_match: string, punctuation: string, offset: number, input: string): string {
  if (punctuation === "." && /\d/.test(input[offset - 1] ?? "") && /\d/.test(input[offset + 1] ?? "")) {
    return punctuation;
  }
  return `${punctuation} `;
}

function isQuestionLike(value: string, locale: PdpGeoLocale): boolean {
  const text = value.trim();
  if (/[?？]$/.test(text)) {
    return true;
  }
  return locale === "ko-KR" && /(인가요|나요|까요|무엇인가요|어떤가요)\s*[?？]?$/.test(text);
}

function isSectionHeadingFaqQuestion(value: string): boolean {
  const text = value
    .trim()
    .replace(/^[\s:[\]-]+|[\s:?\]-]+$/g, "");
  return /^(?:key\s*ingredients?|ingredients?|ingredient\s*list|full\s*ingredients?|benefits?|summary|how\s*to\s*use|usage|directions?|reviews?|clinical\s*results?|proven\s*results?)$/i.test(text);
}

function isBrokenGeneratedFragment(value: string): boolean {
  const text = value.trim();
  const openParens = (text.match(/\(/g) ?? []).length;
  const closeParens = (text.match(/\)/g) ?? []).length;
  return openParens !== closeParens
    || /(property value|Evidence signal|Review signals|technology signals|main benefit signal)/i.test(text);
}

function isStandaloneUrlLike(value: string): boolean {
  return /^(?:https?:\/\/|urn:|data:image\/)/i.test(value);
}

function hasUrlOrImageArtifact(value: string): boolean {
  const normalized = value
    .replace(/https?\s*:\s*\/\s*\//gi, "https://")
    .replace(/\s*\.\s*/g, ".")
    .replace(/\?\s*/g, "?")
    .trim();
  return /https?:\/\/|www\.|data:image\//i.test(normalized)
    || /\.(?:jpe?g|png|webp|gif|avif|svg)(?:\?|$)/i.test(normalized)
    || /fileupload\/reviews/i.test(normalized);
}

function createAccordionHtml(sections: PdpGeoContentSections, locale: PdpGeoLocale): string {
  const labels = sectionLabels(locale);
  const entries: Array<[keyof PdpGeoContentSections, string]> = [
    ["productName", sections.productName],
    ["description", sections.description],
    ["quickFacts", sections.quickFacts],
    ["benefits", sections.benefits],
    ["ingredients", sections.ingredients],
    ["howToUse", sections.howToUse],
    ["faq", sections.faq]
  ];

  const items = entries.map(([key, value], index) => `
    <div class="geo-content-accordion__item">
      <button class="geo-content-accordion__trigger" type="button" aria-expanded="${index === 0 ? "true" : "false"}">
        ${escapeHtml(labels[key])}
      </button>
      <div class="geo-content-accordion__panel">
        ${formatSectionHtml(value)}
      </div>
    </div>`).join("\n");

  return `<div class="geo-content-accordion" data-locale="${escapeHtml(locale)}">${items}\n</div>`;
}

function sectionLabels(locale: PdpGeoLocale): Record<keyof PdpGeoContentSections, string> {
  return {
    productName: locale === "ko-KR" ? "상품명" : locale === "ja-JP" ? "商品名" : "Product name",
    description: locale === "ko-KR" ? "GEO 설명" : locale === "ja-JP" ? "GEO説明" : "GEO description",
    quickFacts: locale === "ko-KR" ? "핵심 정보" : locale === "ja-JP" ? "主な情報" : "Quick facts",
    benefits: locale === "ko-KR" ? "효능/효과" : locale === "ja-JP" ? "ベネフィット" : "Benefits",
    ingredients: locale === "ko-KR" ? "성분" : locale === "ja-JP" ? "成分" : "Ingredients",
    howToUse: locale === "ko-KR" ? "사용법" : locale === "ja-JP" ? "使い方" : "How to use",
    faq: "FAQ"
  };
}

function formatSectionHtml(value: string): string {
  if (value.includes("\n")) {
    const lines = value.split("\n").filter(Boolean);
    return `<ul>${lines.map((line) => `<li>${escapeHtml(line.replace(/^[-\d.]+\s*/, ""))}</li>`).join("")}</ul>`;
  }
  return `<p>${escapeHtml(value)}</p>`;
}

function addWarning(warnings: string[], warning: string): void {
  if (!warnings.includes(warning)) {
    warnings.push(warning);
  }
}

function addRepair(
  warnings: string[],
  repairs: PdpGeoValidationRepair[],
  repair: PdpGeoValidationRepair,
  warning: string
): void {
  addWarning(warnings, warning);
  repairs.push({
    ...repair,
    before: repair.before === undefined ? undefined : toJsonValue(repair.before),
    after: repair.after === undefined ? undefined : toJsonValue(repair.after)
  });
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => toJsonValue(item))
      .filter((item): item is JsonValue => item !== undefined);
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [key, toJsonValue(item)] as const)
        .filter(([, item]) => item !== undefined)
    ) as JsonValue;
  }
  return String(value);
}

function cleanJson<T>(value: T): T {
  if (Array.isArray(value)) {
    return value
      .map((item) => cleanJson(item))
      .filter((item) => item !== undefined && item !== null && !(Array.isArray(item) && item.length === 0)) as T;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, cleanJson(item)] as const)
      .filter(([, item]) => item !== undefined && item !== null && item !== "" && !(Array.isArray(item) && item.length === 0));
    return Object.fromEntries(entries) as T;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function hasTruncationMarker(value: string): boolean {
  return /…|⋯|\.{3,}/.test(value);
}

function formatKoreanListForSentence(value: string): string {
  const items = value.split(/\s*,\s*/).map((item) => item.trim()).filter(Boolean);
  if (items.length <= 1) {
    return value.trim();
  }
  const head = items.slice(0, -1).join(", ");
  const tail = items.at(-1) ?? "";
  return `${head}${hasKoreanBatchim(tail) ? "과" : "와"} ${tail}`;
}

function appendKoreanTopicParticle(value: string): string {
  return `${value}${hasKoreanBatchim(value) ? "은" : "는"}`;
}

function appendKoreanObjectParticle(value: string): string {
  return `${value}${hasKoreanBatchim(value) ? "을" : "를"}`;
}

function hasKoreanBatchim(value: string): boolean {
  const last = [...value.trim()].at(-1);
  if (!last) {
    return false;
  }
  const code = last.charCodeAt(0);
  return code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 > 0;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeScriptJson(value: string): string {
  return value.replace(/</g, "\\u003c");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9가-힣ぁ-んァ-ン一-龯]+/gi, "-").replace(/^-+|-+$/g, "") || "product";
}
