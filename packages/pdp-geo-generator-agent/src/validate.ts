import type { JsonObject, JsonValue, PdpGeoContentArtifact, PdpGeoContentSections, PdpGeoLocale, PdpGeoSchemaMarkup, PdpGeoValidationRepair } from "./types";
import { captureStructuredContentSnapshot, repairPdpSchemaGraphIntegrity, synchronizeStructuredContentWithGraph } from "./graph-integrity";
import { isNegativeReviewSignalText } from "./review-sentiment";

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

interface PropertyValueNameRepair {
  name: string;
  propertyID: string;
  issue: string;
}

const allowedGraphTypes = new Set(["WebPage", "Product", "FAQPage", "HowTo", "BreadcrumbList", "Question", "Answer", "HowToStep", "Offer", "AggregateRating", "Review", "Rating", "PropertyValue", "ItemList", "ListItem", "Brand", "Person"]);

/** Validates and repairs generated JSON-LD and simple accordion HTML. */
export function validateAndRepairPdpGeoArtifacts(input: ValidateAndRepairInput): ValidateAndRepairOutput {
  const validationWarnings: string[] = [];
  const validationRepairs: PdpGeoValidationRepair[] = [];
  const locale = input.locale ?? "en-US";
  const rawGraph: Array<Record<string, unknown>> = Array.isArray(input.schemaMarkup.jsonLd["@graph"])
    ? input.schemaMarkup.jsonLd["@graph"].flatMap((node) => isRecord(node) ? [node] : [])
    : [];
  const structuredContentSnapshot = captureStructuredContentSnapshot(rawGraph);
  const fallbackProductName = repairGeneratedText(input.fallbackProductName, locale, "fallbackProductName", validationWarnings, validationRepairs);
  const fallbackDescription = repairGeneratedText(input.fallbackDescription, locale, "fallbackDescription", validationWarnings, validationRepairs);
  const jsonLd = repairJsonLd(input.schemaMarkup.jsonLd, fallbackProductName, fallbackDescription, locale, validationWarnings, validationRepairs);
  const schemaMarkup = {
    jsonLd,
    scriptTag: `<script type="application/ld+json">${escapeScriptJson(JSON.stringify(jsonLd, null, 2))}</script>`
  };
  const repairedSections = repairContentSections(input.content.sections, locale, validationWarnings, validationRepairs);
  const validatedGraph: Array<Record<string, unknown>> = Array.isArray(jsonLd["@graph"])
    ? jsonLd["@graph"].flatMap((node) => isRecord(node) ? [node] : [])
    : [];
  const parity = synchronizeStructuredContentWithGraph({
    sections: repairedSections,
    graph: validatedGraph,
    snapshot: structuredContentSnapshot
  });
  for (const repair of parity.repairs) {
    addRepair(validationWarnings, validationRepairs, repair, repair.action);
  }
  const sections = parity.sections;
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

  const integrity = repairPdpSchemaGraphIntegrity(graph, locale);
  for (const repair of integrity.repairs) {
    addRepair(warnings, repairs, repair, repair.action);
  }

  repairSchemaEvidenceConsistency(integrity.graph, locale, warnings, repairs);
  repairSchemaDescriptionRoleSeparation(integrity.graph, fallbackProductName, fallbackDescription, locale, warnings, repairs);

  return cleanJson({
    ...root,
    "@graph": integrity.graph
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

function repairSchemaDescriptionRoleSeparation(
  graph: Array<Record<string, unknown>>,
  fallbackProductName: string,
  fallbackDescription: string,
  locale: PdpGeoLocale,
  warnings: string[],
  repairs: PdpGeoValidationRepair[]
): void {
  const product = graph.find((node) => node["@type"] === "Product");
  const webPage = graph.find((node) => node["@type"] === "WebPage");
  if (!product) {
    return;
  }

  if (typeof product.description === "string") {
    const before = product.description;
    const after = repairProductDescriptionPageEntityLanguage(before, fallbackDescription, fallbackProductName, locale);
    if (after !== before) {
      product.description = after;
      addRepair(warnings, repairs, {
        field: "Product.description",
        source: "field-contract-validator",
        issue: "Product.description described the product page or page coverage rather than the product entity.",
        action: "Removed page-level wording and restored a product-entity description.",
        before,
        after,
        evidence: ["Product.description", "schema.org Product entity role", locale]
      }, "Product.description was repaired to describe the product entity rather than the page.");
    }
  }

  if (!webPage || typeof webPage.description !== "string" || typeof product.description !== "string") {
    return;
  }
  if (!areSchemaDescriptionsTooSimilar(webPage.description, product.description)) {
    return;
  }

  const before = webPage.description;
  const after = createDistinctWebPageDescriptionFallback(fallbackProductName, locale);
  webPage.description = after;
  addRepair(warnings, repairs, {
    field: "WebPage.description",
    source: "field-contract-validator",
    issue: "WebPage.description repeated Product.description instead of describing page-level coverage.",
    action: "Replaced the duplicate WebPage description with a page-level product-page description.",
    before,
    after,
    evidence: ["WebPage.description", "Product.description", "schema.org WebPage/Product role separation", locale]
  }, "WebPage.description was repaired because it duplicated the Product entity description.");
}

function repairProductDescriptionPageEntityLanguage(
  value: string,
  fallbackDescription: string,
  fallbackProductName: string,
  locale: PdpGeoLocale
): string {
  if (!containsProductDescriptionPageEntityLanguage(value)) {
    return value;
  }
  const kept = splitPublicSentences(value)
    .filter((sentence) => !containsProductDescriptionPageEntityLanguage(sentence))
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  if (kept.length > 0) {
    return kept.join(" ").replace(/\s+/g, " ").trim();
  }
  const fallback = fallbackDescription.trim();
  if (fallback && !containsProductDescriptionPageEntityLanguage(fallback)) {
    return fallback;
  }
  return createProductEntityDescriptionFallback(fallbackProductName, locale);
}

function containsProductDescriptionPageEntityLanguage(value: string): boolean {
  return splitPublicSentences(value).some((sentence) => {
    const text = sentence.trim();
    if (/[가-힣]/.test(text)
      && /(?:상품\s*페이지|제품\s*페이지|상세\s*페이지|페이지(?:에서는|에는|는)?)/u.test(text)
      && /(?:상품|제품|고객|피부|성분|기술|효능|효과|사용|리뷰|FAQ|HowTo|구매|정보|다룹니다|소개|추천|안내|확인|제공)/iu.test(text)) {
      return true;
    }
    if (/[A-Za-z]/.test(text)
      && /(?:\bproduct\s+page\b|\bproduct-detail\s+page\b|\bPDP\b|\bthis\s+page\b|\bthe\s+page\b|\bpage\s+(?:covers?|introduces?|summari[sz]es?|presents?|describes?|includes?|helps?))/i.test(text)) {
      return true;
    }
    return /[ぁ-んァ-ン一-龯]/.test(text)
      && /(?:商品ページ|製品ページ|ページでは|ページは)/.test(text);
  });
}

function areSchemaDescriptionsTooSimilar(webPageDescription: string, productDescription: string): boolean {
  const webPageOpening = splitPublicSentences(webPageDescription)[0] ?? "";
  const productOpening = splitPublicSentences(productDescription)[0] ?? "";
  const hasDistinctPageOpening = /(?:상품\s*페이지|제품\s*페이지|상세\s*페이지|product\s+(?:detail\s+)?page|\bPDP\b|商品ページ|製品ページ)/iu.test(webPageOpening)
    && normalizeDescriptionForRoleComparison(webPageOpening) !== normalizeDescriptionForRoleComparison(productOpening);
  const webPage = normalizeDescriptionForRoleComparison(webPageDescription);
  const product = normalizeDescriptionForRoleComparison(productDescription);
  if (!webPage || !product) {
    return false;
  }
  if (webPage === product) {
    return true;
  }
  if (product.length >= 72 && webPage.includes(product)) {
    return true;
  }
  if (webPage.length >= 72 && product.includes(webPage)) {
    return true;
  }
  // Both schema nodes should repeat the same citation-worthy product facts.
  // A distinct, explicit page introduction preserves the WebPage role even
  // when ingredient, benefit, and measured-outcome sentences are shared.
  if (hasDistinctPageOpening) {
    return false;
  }

  const webPageSentences = splitPublicSentences(webPageDescription)
    .map(normalizeDescriptionForRoleComparison)
    .filter((sentence) => sentence.length >= 72);
  const productSentences = splitPublicSentences(productDescription)
    .map(normalizeDescriptionForRoleComparison)
    .filter((sentence) => sentence.length >= 72);
  const duplicateSentenceCount = productSentences.filter((productSentence) =>
    webPageSentences.some((webPageSentence) =>
      webPageSentence === productSentence
      || webPageSentence.includes(productSentence)
      || productSentence.includes(webPageSentence)
    )
  ).length;
  // A page description may legitimately repeat one long, source-backed metric
  // sentence while its other sentences retain page-level coverage. Treat the
  // roles as collapsed only when multiple substantive sentences duplicate.
  return duplicateSentenceCount >= 2;
}

function normalizeDescriptionForRoleComparison(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\b(?:this|the)\b/g, " ")
    .replace(/\b(?:product\s+detail\s+page|product\s+page|pdp|page)\b/g, " ")
    .replace(/\b(?:introduces?|summari[sz]es?|covers?|presents?|describes?|includes?|explains?|helps?|lets?)\b/g, " ")
    .replace(/(?:상품\s*페이지|제품\s*페이지|상세\s*페이지|페이지에서는|페이지에는|페이지는|페이지|소개합니다|추천합니다|다룹니다|안내합니다|설명합니다|제공합니다|확인할\s*수\s*있습니다)/g, " ")
    .replace(/(?:商品ページ|製品ページ|ページでは|ページは|ページ)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function createProductEntityDescriptionFallback(productName: string, locale: PdpGeoLocale): string {
  return fallback(locale, {
    "ko-KR": `${productName}은 상품 원문 근거를 바탕으로 구성된 제품입니다.`,
    "ja-JP": `${productName}は商品原文の根拠に基づく製品です。`,
    "en-US": `${productName} is described as a product backed by the available PDP source evidence.`,
    "en-GB": `${productName} is described as a product backed by the available PDP source evidence.`
  });
}

function createDistinctWebPageDescriptionFallback(productName: string, locale: PdpGeoLocale): string {
  return fallback(locale, {
    "ko-KR": `${productName} 상품 페이지에서는 상품의 주요 효능, 성분/기술, 사용 맥락, 리뷰, 옵션, 측정/평가 근거를 원문 범위 안에서 다룹니다.`,
    "ja-JP": `${productName}の商品ページでは、主なベネフィット、成分/技術、使用文脈、レビュー、選択肢、測定/評価根拠を原文の範囲で扱います。`,
    "en-US": `This ${productName} product page covers the product's key benefits, ingredients or technologies, routine context, reviews, variants, offers, and reported evidence when those details are available in the source.`,
    "en-GB": `This ${productName} product page covers the product's key benefits, ingredients or technologies, routine context, reviews, variants, offers, and reported evidence when those details are available in the source.`
  });
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
    const repairedFaqItems = node.mainEntity.filter(isRecord).flatMap((item) => {
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
      const nonAnswerRepaired = repairFaqNonAnswerLead(repairedAnswer, warnings, repairs, item);
      if (!nonAnswerRepaired) {
        addRepair(warnings, repairs, {
          field: "FAQPage.mainEntity",
          source: "field-contract-validator",
          issue: "FAQ answer was only a non-answer (cannot-confirm) statement with no supported product fact.",
          action: "Removed the non-answer FAQ item because answer engines cannot cite an answer that answers nothing.",
          before: toJsonValue(item),
          after: null,
          evidence: ["FAQPage.mainEntity.acceptedAnswer.text", "answer-ready FAQ contract"]
        }, "Non-answer FAQ item was removed during final sentence QA.");
        return [];
      }
      const fieldContractAnswer = repairFaqAnswerFieldContract(repairedQuestion, nonAnswerRepaired, locale, warnings, repairs);
      if (!fieldContractAnswer) {
        addRepair(warnings, repairs, {
          field: "FAQPage.mainEntity",
          source: "field-contract-validator",
          issue: "FAQ answer only contained review-based wording after field-contract repair.",
          action: "Removed the FAQ item because no product-detail answer remained.",
          before: toJsonValue(item),
          after: null,
          evidence: ["FAQPage.mainEntity.acceptedAnswer.text", "answer-ready FAQ contract"]
        }, "Review-only FAQ item was removed after answer repair.");
        return [];
      }
      if (isReviewBasedFaqItem(repairedQuestion, fieldContractAnswer, locale)) {
        addRepair(warnings, repairs, {
          field: "FAQPage.mainEntity",
          source: "field-contract-validator",
          issue: "FAQ item was based on negative customer review text rather than a reusable review-intent question.",
          action: "Removed the negative review-based FAQ item so FAQPage keeps product-fact questions and positive review-intent questions only.",
          before: toJsonValue(item),
          after: null,
          evidence: ["FAQPage.mainEntity.name", "FAQPage.mainEntity.acceptedAnswer.text", "review-intent FAQ contract"]
        }, "Negative review-based FAQ item was removed during final sentence QA.");
        return [];
      }
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
      const aligned = repairFaqQuestionAnswerAlignment(repairedQuestion, fieldContractAnswer, locale, warnings, repairs);

      return [{
        "@type": "Question",
        name: aligned.question,
        acceptedAnswer: {
          "@type": "Answer",
          text: aligned.answer
        }
      }];
    });
    node.mainEntity = dedupeFaqMainEntityBySemanticIntent(repairedFaqItems, locale, warnings, repairs);
  }

  if (node["@type"] === "HowTo" && Array.isArray(node.step)) {
    let nextPosition = 1;
    const seenStepKeys = new Set<string>();
    const stepCandidates: Array<{
      item: Record<string, unknown>;
      part: string;
      repairedText: string;
    }> = [];

    for (const item of node.step.filter(isRecord)) {
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
        continue;
      }
      const repairedText = repairGeneratedText(text, locale, "HowTo.step.text", warnings, repairs);
      const usageStepParts = splitHowToStepUsageText(repairedText, locale);
      if (usageStepParts.length > 1) {
        addRepair(warnings, repairs, {
          field: "HowTo.step.text",
          source: "field-contract-validator",
          issue: "HowTo.step combined multiple actionable usage directions into one step.",
          action: "Split the compound HowTo step into atomic usage actions before deduplication.",
          before: repairedText,
          after: usageStepParts,
          evidence: ["HowTo.step", "stepwise HowTo contract"]
        }, "Compound HowTo usage step was split into atomic actions.");
      }
      const validParts = usageStepParts.filter((part) => isActionableUsageText(part));
      if (validParts.length === 0) {
        addRepair(warnings, repairs, {
          field: "HowTo.step.text",
          source: "field-contract-validator",
          issue: "HowTo.step text did not satisfy the RAG field evidence contract for actionable usage directions.",
          action: "Removed the invalid HowTo step so benefit, evidence, ingredient, or review copy does not appear as a usage action.",
          before: toJsonValue(item),
          after: null,
          evidence: ["RAG Field Evidence Contract", "HowTo.step requires actionable usage evidence"]
        }, "HowTo step was removed because it was not actionable usage content.");
        continue;
      }

      for (const part of validParts) {
        stepCandidates.push({ item, part, repairedText });
      }
    }

    const redundantCompoundIndexes = findRedundantKoreanCompoundHowToStepIndexes(
      stepCandidates.map((candidate) => candidate.part),
      locale
    );

    node.step = stepCandidates.flatMap((candidate, candidateIndex) => {
      const { item, part, repairedText } = candidate;
      if (redundantCompoundIndexes.has(candidateIndex)) {
        addRepair(warnings, repairs, {
          field: "HowTo.step.text",
          source: "field-contract-validator",
          issue: "HowTo.step repeated a broader compound usage direction already covered by more specific neighboring steps.",
          action: "Removed the broader overlapping HowTo step so each usage action appears once.",
          before: repairedText,
          after: null,
          evidence: ["HowTo.step", "actionable usage overlap dedupe"]
        }, "Overlapping compound HowTo usage step was removed during field contract validation.");
        return [];
      }
      const stepKey = howToStepDedupeKey(part);
      if (stepKey && seenStepKeys.has(stepKey)) {
        addRepair(warnings, repairs, {
          field: "HowTo.step.text",
          source: "field-contract-validator",
          issue: "HowTo.step duplicated the same actionable usage direction with different surface wording.",
          action: "Removed the duplicate HowTo step so usage directions remain concise and non-repetitive.",
          before: toJsonValue(item),
          after: null,
          evidence: ["HowTo.step", "actionable usage dedupe"]
        }, "Duplicate HowTo usage step was removed during field contract validation.");
        return [];
      }
      if (stepKey) {
        seenStepKeys.add(stepKey);
      }
      const position = nextPosition++;
      return [{
        "@type": "HowToStep",
        position,
        name: createValidatedHowToStepName(locale, position),
        text: part
      }];
    });
  }

  if (node["@type"] === "Product") {
    repairProductTrustFields(node, locale, warnings, repairs);
    if (typeof node.description === "string") {
      node.description = dedupeRedundantMetricClausesWithRepair(
        repairProductDescriptionFieldContract(node.description, locale, warnings, repairs),
        "Product.description",
        warnings,
        repairs
      );
    }
  }

  if (node["@type"] === "WebPage" && typeof node.description === "string") {
    node.description = dedupeRedundantMetricClausesWithRepair(
      repairWebPageDescriptionFieldContract(node.description, locale, warnings, repairs),
      "WebPage.description",
      warnings,
      repairs
    );
  }

  if (node["@type"] === "BreadcrumbList") {
    repairBreadcrumbListNode(node, warnings, repairs);
  }

  const repaired = repairSchemaTextFields(node, locale, warnings, repairs);
  return cleanJson(pruneInvalidSchemaText(repaired, locale, warnings, repairs));
}

function repairProductDescriptionFieldContract(
  value: string,
  locale: PdpGeoLocale,
  warnings: string[],
  repairs: PdpGeoValidationRepair[]
): string {
  const sentences = splitPublicSentences(value);
  if (sentences.length === 0) {
    return value;
  }
  let changed = false;
  const kept = sentences.flatMap((sentence) => {
    if (isStiffDescriptionEvidenceSentence(sentence)) {
      changed = true;
      return [];
    }
    const repaired = repairProductDescriptionUsageStepSentence(sentence);
    if (repaired !== sentence) {
      changed = true;
      return repaired ? [repaired] : [];
    }
    return [sentence];
  });
  if (!changed || kept.length === 0) {
    return value;
  }
  const next = kept.join(" ").replace(/\s+/g, " ").trim();
  addRepair(warnings, repairs, {
    field: "Product.description",
    source: "field-contract-validator",
    issue: "Product.description mixed product identity and benefit copy with concrete usage directions or stiff source-report evidence narration.",
    action: "Removed concrete usage directions and report-style evidence sentences while keeping detailed usage and measured evidence in their dedicated schema fields.",
    before: value,
    after: next,
    evidence: ["Product.description", "HowTo/Usage field evidence contract", locale]
  }, "Product.description usage directions were moved out of the product entity description.");
  return next;
}

function repairProductDescriptionUsageStepSentence(value: string): string {
  const text = value.trim();
  if (!/[가-힣]/.test(text) || !hasActionableApplicationVerb(text)) {
    return value;
  }
  const withoutUsageClause = text
    .replace(/(?:,\s*)?(?:사용\s*시|사용할\s*때|사용\s*방법은|사용법은)\s+[^.!?。！？]*(?:닦아냅니다|닦아내는\s*방식입니다|흡수시킵니다|흡수시켜\s*줍니다|바릅니다|펴\s*바릅니다|펴\s*발라\s*줍니다|도포합니다|사용합니다)[.!?。！？]?$/u, "")
    .replace(/(?:,\s*)?(?:화장솜|손바닥|손에|적당량|얼굴\s*전체|피부결)[^.!?。！？]*(?:닦아냅니다|닦아내는\s*방식입니다|흡수시킵니다|흡수시켜\s*줍니다|바릅니다|펴\s*바릅니다|펴\s*발라\s*줍니다|도포합니다|사용합니다)[.!?。！？]?$/u, "")
    .replace(/(?:제시|확인|보고)되며$/u, (match) => match.replace(/되며$/u, "됩니다"))
    .replace(/(?:제공|개선|회복)되며$/u, (match) => match.replace(/되며$/u, "됩니다"))
    .replace(/며$/u, "습니다")
    .replace(/\s+/g, " ")
    .trim();
  if (withoutUsageClause === text) {
    return value;
  }
  const repaired = withoutUsageClause.replace(/[.。]+$/g, "").trim();
  if (!repaired || hasActionableApplicationVerb(repaired)) {
    return "";
  }
  return `${repaired}.`;
}

function repairWebPageDescriptionFieldContract(
  value: string,
  locale: PdpGeoLocale,
  warnings: string[],
  repairs: PdpGeoValidationRepair[]
): string {
  const sentences = splitPublicSentences(value);
  if (sentences.length === 0) {
    return value;
  }
  let changed = false;
  const benefitContext = extractKoreanWebPageBenefitContext(value);
  const kept = sentences.flatMap((sentence) => {
    if (isStiffDescriptionEvidenceSentence(sentence)) {
      changed = true;
      return [];
    }
    const targetActorRepaired = repairKoreanSkinTypeActorOpening(sentence);
    if (targetActorRepaired !== sentence) {
      changed = true;
      return targetActorRepaired ? [targetActorRepaired] : [];
    }
    const faqHowToRepaired = repairMixedFaqHowToUsageSentence(sentence);
    if (faqHowToRepaired !== sentence) {
      changed = true;
      return faqHowToRepaired ? [faqHowToRepaired] : [];
    }
    const redundantNavigationRepaired = repairRedundantKoreanFaqHowToNavigationSentence(sentence);
    if (redundantNavigationRepaired !== sentence) {
      changed = true;
      return redundantNavigationRepaired ? [redundantNavigationRepaired] : [];
    }
    if (isKoreanWebPageQuestionNavigationSentence(sentence)) {
      changed = true;
      return [];
    }
    if (isRedundantKoreanFaqHowToNavigationSentence(sentence)) {
      changed = true;
      return [];
    }
    const patentTechnologyRepaired = repairKoreanWebPagePatentTechnologySentence(sentence, benefitContext);
    if (patentTechnologyRepaired !== sentence) {
      changed = true;
      return patentTechnologyRepaired ? [patentTechnologyRepaired] : [];
    }
    const factNavigationRepaired = repairKoreanWebPageFactNavigationSentence(sentence);
    if (factNavigationRepaired !== sentence) {
      changed = true;
      return factNavigationRepaired ? [factNavigationRepaired] : [];
    }
    const mixedIngredientMetricRepaired = repairKoreanWebPageMixedIngredientMetricEvidenceSentence(sentence, benefitContext);
    if (mixedIngredientMetricRepaired) {
      changed = true;
      return mixedIngredientMetricRepaired;
    }
    if (isMisroutedWebPageUsageTechnologySentence(sentence)) {
      changed = true;
      return [];
    }
    const repaired = repairIngredientTechnologyUsageCoverageBlendSentence(sentence);
    if (repaired !== sentence) {
      changed = true;
    }
    return [repaired];
  });
  if (!changed || kept.length === 0) {
    return value;
  }

  const next = kept.join(" ").replace(/\s+/g, " ").trim();
  addRepair(warnings, repairs, {
    field: "WebPage.description",
    source: "field-contract-validator",
    issue: "WebPage.description contained awkward target-customer grammar, stiff evidence narration, mixed page coverage, or over-merged ingredient/metric evidence.",
    action: "Rewrote awkward target-customer openings and removed report-style certification/test narration while keeping detailed evidence in dedicated schema fields.",
    before: value,
    after: next,
    evidence: ["WebPage.description", "HowTo/Usage field evidence contract", locale]
  }, "WebPage.description usage/technology routing was repaired.");
  return next;
}

function isStiffDescriptionEvidenceSentence(value: string): boolean {
  const text = value.trim();
  if (!/[가-힣]/u.test(text)) {
    return false;
  }
  return /(?:민감\s*피부\s*사용\s*맥락은[^.!?。！？]{0,120}?(?:보완|뒷받침)(?:됩니다|합니다)|해당\s*결과(?:는|가)[^.!?。！？]{0,180}?(?:표기되어\s*있|제시되어\s*있)|원료적\s*특성에\s*한한[^.!?。！？]{0,120}?(?:결과|테스트)|(?:결과|수치)(?:가|는)?\s*(?:제시|표기)되며[^.!?。！？]{0,160}?표기되어\s*있다)/iu.test(text);
}

function repairKoreanSkinTypeActorOpening(value: string): string {
  const text = value.trim();
  if (!/[가-힣]/.test(text) || !/상품\s*페이지/.test(text)) {
    return value;
  }
  const skinTypeActor = text.match(/^(.*?상품\s*페이지)(?:는|에서는)\s+((?:민감|건조|건성|지성|복합성|트러블|여드름|수부지|악건성|장벽\s*약한|민감\s*건조)\s*피부(?:\s*(?:또는|혹은|및|과|와)\s*(?:민감|건조|건성|지성|복합성|트러블|여드름|수부지|악건성|장벽\s*약한|민감\s*건조)\s*피부)*)\s*(?:이|가)\s+([^.!?。！？]{2,120}?)(?:을|를)?\s*(?:비교|선택|참고|확인|살펴|고려)할\s*때[^.!?。！？]{0,80}?(?:참고할\s*수\s*있는\s*)?([^.!?。！？]{2,80}?)\s*정보를\s*(?:다룹니다|안내합니다|설명합니다|확인할\s*수\s*있습니다)[.!?。！？]?$/u);
  if (!skinTypeActor) {
    return value;
  }
  const pageSubject = normalizeKoreanRepairPhrase(skinTypeActor[1] ?? "");
  const skinTypes = normalizeKoreanRepairPhrase(skinTypeActor[2] ?? "");
  const comparisonContext = stripTrailingKoreanObjectParticle(normalizeKoreanRepairPhrase(skinTypeActor[3] ?? ""));
  const productInfo = stripTrailingKoreanObjectParticle(normalizeKoreanRepairPhrase(skinTypeActor[4] ?? "")
    .replace(/^참고할\s*수\s*있는\s*/u, "")
    .replace(/(?:상품|제품)?\s*정보$/u, ""));
  if (!pageSubject || !skinTypes || !comparisonContext) {
    return value;
  }
  const productObject = appendKoreanObjectParticle(ensureKoreanProductIntroNoun(productInfo || "제품"));
  return `${pageSubject}에서는 ${skinTypes} 고객에게 ${comparisonContext}에 효과적인 ${productObject} 추천합니다.`;
}

function ensureKoreanProductIntroNoun(value: string): string {
  const text = normalizeKoreanRepairPhrase(value)
    .replace(/\s*정보$/u, "")
    .trim();
  if (!text) {
    return "제품";
  }
  return /(?:상품|제품)$/u.test(text) ? text : `${text} 상품`;
}

function normalizeKoreanRepairPhrase(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .replace(/떠\s*있은/g, "떠 있는")
    .replace(/떠\s*있어야/g, "떠 있어야")
    .replace(/떠\s*있는\s+것이/g, "떠 있는 것이")
    .replace(/[.。！？!?]+$/g, "")
    .trim();
}

function repairMixedFaqHowToUsageSentence(value: string): string {
  if (!isMixedFaqHowToUsageSentence(value)) {
    return value;
  }
  return "";
}

function isMixedFaqHowToUsageSentence(value: string): boolean {
  const text = value.trim();
  if (!/[가-힣]/.test(text) || !/(?:FAQ\s*(?:와|및|\/|과)\s*HowTo|HowTo\s*(?:와|및|\/|과)\s*FAQ)/i.test(text)) {
    return false;
  }
  return /(?:손바닥|적당량|얼굴\s*전체|피부결|펴\s*바른|펴\s*발라|흡수|두드려|도포|바르는\s*방법|사용\s*방법|사용법)[^.!?。！？]{0,120}(?:이유|동일\s*여부|차이|문의|질문|FAQ|캡슐|워터)/i.test(text)
    || /(?:방법|사용법)(?:과|와)[^.!?。！？]{0,120}(?:이유|동일\s*여부|차이|FAQ|캡슐|워터)/i.test(text);
}

function isRedundantKoreanFaqHowToNavigationSentence(value: string): boolean {
  const text = value.trim();
  if (!/[가-힣]/.test(text) || !/(?:FAQ|HowTo|사용법\s*영역|FAQ\s*영역)/i.test(text)) {
    return false;
  }
  return /(?:FAQ|HowTo|사용법\s*영역|FAQ\s*영역)[^.!?。！？]{0,180}(?:확인할\s*수\s*있습니다|확인합니다|다룹니다|답변으로\s*다룹니다|살펴볼\s*수\s*있습니다|이어(?:서)?\s*살펴볼\s*수\s*있습니다|(?:함께\s*)?제공됩니다)/i.test(text)
    || /비교\s*과정에서는[^.!?。！？]{0,160}(?:FAQ|HowTo|사용법)[^.!?。！？]{0,120}(?:살펴볼\s*수\s*있습니다|확인할\s*수\s*있습니다)/i.test(text);
}

function repairRedundantKoreanFaqHowToNavigationSentence(value: string): string {
  if (!isRedundantKoreanFaqHowToNavigationSentence(value)) {
    return value;
  }
  const text = value.trim();
  const withoutNavigationTail = text
    .replace(/,\s*(?:(?:구매\s*정보|가격|혜택)(?:와|과)\s*)?(?:FAQ|HowTo)(?:와|과|및|\/)?(?:\s*HowTo|\s*FAQ)?(?:가|도)?\s*(?:함께\s*)?(?:제공됩니다|확인할\s*수\s*있습니다|확인합니다|다룹니다|살펴볼\s*수\s*있습니다)[.!?。！？]?$/iu, "")
    .replace(/,\s*(?:구매\s*정보|가격|혜택)(?:와|과)\s*(?:FAQ|HowTo)[^.!?。！？]{0,80}(?:제공됩니다|확인할\s*수\s*있습니다)[.!?。！？]?$/iu, "")
    .replace(/\s+/g, " ")
    .trim();

  if (withoutNavigationTail === text || !withoutNavigationTail || /(?:FAQ|HowTo|사용법\s*영역|FAQ\s*영역)/i.test(withoutNavigationTail)) {
    return "";
  }

  const base = withoutNavigationTail.replace(/[.。！？!?]+$/g, "").trim();
  if (!base) {
    return "";
  }
  if (/(?:결과|수치|근거)$/u.test(base)) {
    return `${base}입니다.`;
  }
  return `${base}.`;
}

function isKoreanWebPageQuestionNavigationSentence(value: string): boolean {
  const text = value.trim();
  if (!/[가-힣]/.test(text)) {
    return false;
  }
  return /(?:질문|문의|궁금증)(?:도)?\s*(?:함께\s*)?(?:다룹니다|제공됩니다|확인할\s*수\s*있습니다)[.!?。！？]?$/u.test(text)
    && /(?:이유|동일|관련|차이|캡슐|워터|크림|FAQ|HowTo)/i.test(text);
}

function repairKoreanWebPagePatentTechnologySentence(value: string, benefitContext?: string): string {
  const text = value.trim();
  if (!/[가-힣]/.test(text) || !/특허\s*출원\s*번호/.test(text) || !/(?:핵심\s*)?(?:기술|성분\/기술|포뮬러)/.test(text)) {
    return value;
  }

  const phrase = normalizeKoreanIngredientMetricEvidencePhrase(text
    .replace(/^(?:핵심\s*)?(?:기술|성분\/기술|포뮬러)(?:은|는)\s*/u, "")
    .replace(/\s*(?:이며|이고|,)?\s*특허\s*출원\s*번호(?:는|:)?\s*[A-Z]{1,4}\d[\d-]*.*$/iu, "")
    .replace(/\s+/g, " ")
    .trim());
  if (!phrase) {
    return "";
  }
  if (benefitContext) {
    return `${appendKoreanObjectParticle(benefitContext)} 뒷받침하는 핵심 성분/기술은 ${phrase}입니다.`;
  }
  return `핵심 성분/기술은 ${phrase}입니다.`;
}

function extractKoreanWebPageBenefitContext(value: string): string | undefined {
  for (const sentence of splitPublicSentences(value)) {
    const text = normalizeKoreanRepairPhrase(sentence);
    const objectMatch = text.match(/고객에게\s+(.{2,100}?)(?:을|를)\s+(?:내세우는|돕는|제공하는|지원하는|케어하는|위한)\s+/u);
    if (objectMatch?.[1]) {
      return normalizeKoreanBenefitContextPhrase(objectMatch[1]);
    }
    const effectiveMatch = text.match(/고객에게\s+(.{2,100}?)에\s+효과적인\s+/u);
    if (effectiveMatch?.[1]) {
      return normalizeKoreanBenefitContextPhrase(effectiveMatch[1]);
    }
  }
  return undefined;
}

function normalizeKoreanBenefitContextPhrase(value: string): string | undefined {
  const phrase = normalizeKoreanRepairPhrase(value)
    .replace(/\s*(?:상품|제품|토너|크림|세럼|로션)$/u, "")
    .trim();
  return phrase.length >= 2 ? phrase : undefined;
}

function repairKoreanWebPageFactNavigationSentence(value: string): string {
  const text = value.trim();
  if (!/[가-힣]/.test(text)) {
    return value;
  }

  const formulaMatch = text.match(/^(.{2,260}?)를\s*중심으로\s*(?:포뮬러|성분\/기술|성분|기술)\s*특징을\s*(?:살펴볼|확인할)\s*수\s*있습니다[.!?。！？]?$/u);
  if (formulaMatch?.[1]) {
    const phrase = normalizeKoreanRepairPhrase(formulaMatch[1])
      .replace(/\s*성분\/기술$/u, "")
      .trim();
    return phrase ? `핵심 성분/기술은 ${phrase}입니다.` : "";
  }

  const evidenceMatch = text.match(/^측정\/평가\s*(?:정보|결과)에서는\s+(.{2,260}?)(?:를|을)?\s*(?:함께\s*)?(?:참고|확인)할\s*수\s*있습니다[.!?。！？]?$/u);
  if (evidenceMatch?.[1]) {
    const phrase = normalizeKoreanRepairPhrase(evidenceMatch[1])
      .replace(/\s*관련\s*결과$/u, " 관련 결과")
      .trim();
    return phrase ? createKoreanEvidenceResultSentence(phrase) : "";
  }

  return value;
}

function repairKoreanWebPageMixedIngredientMetricEvidenceSentence(value: string, benefitContext?: string): string[] | undefined {
  const text = value.trim();
  if (!isKoreanWebPageMixedIngredientMetricEvidenceSentence(text)) {
    return undefined;
  }

  const withoutAwkwardPredicate = text
    .replace(/[.!?。！？]+$/u, "")
    .replace(/\s*(?:선택의\s*)?(?:핵심\s*)?근거(?:로를|로|를)?\s*(?:제공합니다|제시합니다|됩니다)$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  const split = withoutAwkwardPredicate.match(/^(.{2,260}?(?:구성|포뮬러|워터|캡슐|지방산|콜레스테롤|세라마이드))과\s+(.{2,320})$/u);
  if (!split?.[1] || !split[2]) {
    const base = stripTrailingKoreanSubjectParticle(withoutAwkwardPredicate);
    return base ? [createKoreanEvidenceResultSentence(base)] : undefined;
  }

  const ingredientPhrase = normalizeKoreanIngredientMetricEvidencePhrase(split[1]);
  const metricPhrase = stripTrailingKoreanSubjectParticle(normalizeKoreanMetricEvidencePhrase(split[2]));
  const repaired: string[] = [];
  if (ingredientPhrase) {
    repaired.push(benefitContext
      ? `핵심 성분/기술은 ${ingredientPhrase}이며, ${appendKoreanObjectParticle(benefitContext)} 뒷받침합니다.`
      : `핵심 성분/기술은 ${ingredientPhrase}입니다.`);
  }
  if (metricPhrase) {
    repaired.push(createKoreanEvidenceResultSentence(metricPhrase));
  }
  return repaired.length > 0 ? repaired : undefined;
}

const KOREAN_METRIC_OUTCOME_PATTERN = "회복|개선|감소|증가|상승|향상|완화|잔존|지속";

function createKoreanEvidenceResultSentence(value: string): string {
  const text = normalizeKoreanEvidenceResultValue(value);
  if (isKoreanNaturalMetricResultSentence(text)) {
    return `${text}.`;
  }
  const naturalSentence = formatKoreanEvidenceResultSentence(text);
  if (naturalSentence) {
    return `${naturalSentence}.`;
  }
  return text ? `${appendKoreanTopicParticle("측정/평가 결과")} ${text}입니다.` : "";
}

function isKoreanNaturalMetricResultSentence(value: string): boolean {
  return hasKoreanQuantifiedReportedSignal(value)
    && new RegExp(`(${KOREAN_METRIC_OUTCOME_PATTERN})(?:했|되었)습니다$`, "u").test(value.trim());
}

function normalizeKoreanEvidenceResultValue(value: string): string {
  return normalizeKoreanRepairPhrase(value)
    .replace(/^(?:측정\/평가\s*결과|측정\s*결과|평가\s*지표|확인\s*지표)(?:는|은|:)?\s*/u, "")
    .replace(/^시험\/평가\s*결과로\s*/u, "")
    .replace(/^(?:평가\s*지표|확인\s*지표)\s*:\s*/u, "")
    .replace(/\s*(?:가\s*)?보고되었습니다$/u, "")
    .replace(/\s*(?:가\s*)?확인됩니다$/u, "")
    .replace(new RegExp(`(${KOREAN_METRIC_OUTCOME_PATTERN})(?:된다고|된|한)?\\s*(?:것으로|결과가|수치가)?\\s*(?:제시(?:됩니다|되었습니다|된다|되며)|나타났습니다)$`, "u"), "$1")
    .replace(new RegExp(`(${KOREAN_METRIC_OUTCOME_PATTERN})(?:된다고|된|한)?\\s*결과(?:를|을)\\s*제시합니다$`, "u"), "$1")
    .replace(/\s*(?:결과|수치)(?:가|이)?\s*$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatKoreanEvidenceResultSentence(value: string): string | undefined {
  const text = normalizeKoreanEvidenceContextPunctuation(value);
  if (!text || !hasKoreanQuantifiedReportedSignal(text)) {
    return undefined;
  }

  const { context, claim } = splitKoreanEvidenceContext(text);
  const claimSentence = formatKoreanMetricClaimSentence(claim);
  if (!claimSentence) {
    return undefined;
  }
  return context ? `${context}, ${claimSentence}` : claimSentence;
}

function normalizeKoreanEvidenceContextPunctuation(value: string): string {
  return normalizeKoreanRepairPhrase(value)
    .replace(/\s*[:：]\s*/g, ": ")
    .replace(/\s*;\s*/g, "; ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitKoreanEvidenceContext(value: string): { context?: string; claim: string } {
  const text = normalizeKoreanEvidenceContextPunctuation(value);
  const contextMatch = text.match(/^(.{2,140}?)\s*기준\s*(?:평가\s*지표|측정\s*결과)?\s*:?\s*(.+)$/u);
  if (contextMatch?.[1] && contextMatch[2] && !hasKoreanQuantifiedReportedSignal(contextMatch[1])) {
    return {
      context: `${normalizeKoreanEvidenceContextPunctuation(contextMatch[1]).replace(/\s*기준$/u, "")} 기준`,
      claim: contextMatch[2].trim()
    };
  }

  const methodMatch = text.match(/^(.{2,140}?(?:테스트|시험|평가|ex\s*vivo|in\s*vitro)[^,，。！？]{0,60}?)(?:에서|으로|에\s*의한)\s+(.+)$/iu);
  if (methodMatch?.[1] && methodMatch[2] && !hasKoreanQuantifiedReportedSignal(methodMatch[1])) {
    return {
      context: `${normalizeKoreanEvidenceContextPunctuation(methodMatch[1]).replace(/\s*결과$/u, "")} 기준`,
      claim: methodMatch[2].trim()
    };
  }

  return { claim: text };
}

function formatKoreanMetricClaimSentence(value: string): string | undefined {
  const segments = value
    .split(/\s*;\s*/u)
    .flatMap(splitKoreanCommaSeparatedMetricOutcomeSegments)
    .map((segment) => normalizeKoreanMetricClaimPhrase(segment))
    .filter(Boolean);
  if (segments.length === 0) {
    return undefined;
  }

  const clauses = segments
    .map(formatKoreanMetricClaimSegment)
    .filter((segment): segment is string => Boolean(segment));
  if (clauses.length === 0) {
    return undefined;
  }
  if (clauses.length === 1) {
    return clauses[0];
  }

  return clauses
    .map((clause, index) => index < clauses.length - 1 ? convertKoreanResultSentenceToConnector(clause) : clause)
    .join(", ");
}

function splitKoreanCommaSeparatedMetricOutcomeSegments(value: string): string[] {
  const parts = value.split(/\s*,\s*/u).map((part) => part.trim()).filter(Boolean);
  if (parts.length <= 1) {
    return [value];
  }
  const outcomePattern = new RegExp(`\\d+(?:\\.\\d+)?\\s*(?:%|배)\\s*(${KOREAN_METRIC_OUTCOME_PATTERN})(?:된다고|된|한)?$`, "u");
  return parts.every((part) => outcomePattern.test(part)) ? parts : [value];
}

function normalizeKoreanMetricClaimPhrase(value: string): string {
  return normalizeKoreanEvidenceContextPunctuation(value)
    .replace(/\s*(?:결과|수치)(?:가|이)?\s*$/u, "")
    .replace(new RegExp(`(${KOREAN_METRIC_OUTCOME_PATTERN})(?:된다고|된|한)?$`, "u"), "$1")
    .trim();
}

function formatKoreanMetricClaimSegment(value: string): string | undefined {
  const text = normalizeKoreanMetricClaimPhrase(value);
  if (!text || !hasKoreanQuantifiedReportedSignal(text)) {
    return undefined;
  }

  const retainedAndImproved = text.match(/^(.{2,120}?)\s+잔존\s+(\d+(?:\.\d+)?\s*(?:%|배))\s*,\s*(.{2,90}?)\s+(\d+(?:\.\d+)?\s*(?:%|배))\s*(?:및|과|와)\s*(.{2,90}?)\s+(\d+(?:\.\d+)?\s*(?:%|배))\s*개선$/u);
  if (retainedAndImproved?.[1] && retainedAndImproved[2] && retainedAndImproved[3] && retainedAndImproved[4] && retainedAndImproved[5] && retainedAndImproved[6]) {
    return `${formatKoreanMetricSubject(`${retainedAndImproved[1]} 잔존율`)} ${retainedAndImproved[2].trim()}이고, ${formatKoreanMetricSubject(retainedAndImproved[3])} ${retainedAndImproved[4].trim()}, ${formatKoreanMetricSubject(retainedAndImproved[5])} ${retainedAndImproved[6].trim()} 개선되었습니다`;
  }

  const particleSubject = text.match(new RegExp(`^(.{2,120}?(?:은|는))\\s+(.{1,180}?\\d+(?:\\.\\d+)?\\s*(?:%|배).{0,120}?)\\s*(${KOREAN_METRIC_OUTCOME_PATTERN})$`, "u"));
  if (particleSubject?.[1] && particleSubject[2] && particleSubject[3]) {
    return `${particleSubject[1].trim()} ${particleSubject[2].trim()} ${koreanMetricOutcomePredicate(particleSubject[3])}`;
  }

  const dualMetric = text.match(new RegExp(`^(.{2,90}?)\\s+(\\d+(?:\\.\\d+)?\\s*(?:%|배))\\s*(?:및|과|와|,)\\s*(.{2,90}?)\\s+(\\d+(?:\\.\\d+)?\\s*(?:%|배))\\s*(${KOREAN_METRIC_OUTCOME_PATTERN})$`, "u"));
  if (dualMetric?.[1] && dualMetric[2] && dualMetric[3] && dualMetric[4] && dualMetric[5]) {
    const firstSubject = formatKoreanMetricSubject(dualMetric[1]);
    const secondSubject = formatKoreanMetricSubject(dualMetric[3]);
    return `${firstSubject} ${dualMetric[2].trim()}, ${secondSubject} ${dualMetric[4].trim()} ${koreanMetricOutcomePredicate(dualMetric[5])}`;
  }

  const metricBeforeOutcome = text.match(new RegExp(`^(.{0,140}?)\\s*(\\d+(?:\\.\\d+)?\\s*(?:%|배))\\s*(${KOREAN_METRIC_OUTCOME_PATTERN})$`, "u"));
  if (metricBeforeOutcome?.[2] && metricBeforeOutcome[3]) {
    const subject = normalizeKoreanMetricClaimPhrase(metricBeforeOutcome[1] ?? "");
    const metric = metricBeforeOutcome[2].trim();
    const outcome = metricBeforeOutcome[3].trim();
    return subject
      ? `${formatKoreanMetricSubject(subject)} ${metric} ${koreanMetricOutcomePredicate(outcome)}`
      : `${metric} ${koreanMetricOutcomePredicate(outcome)}`;
  }

  const outcomeBeforeMetric = text.match(new RegExp(`^(.{2,120}?)\\s+(${KOREAN_METRIC_OUTCOME_PATTERN})\\s+(\\d+(?:\\.\\d+)?\\s*(?:%|배))$`, "u"));
  if (outcomeBeforeMetric?.[1] && outcomeBeforeMetric[2] && outcomeBeforeMetric[3]) {
    const subject = normalizeKoreanMetricClaimPhrase(outcomeBeforeMetric[1]);
    const outcome = outcomeBeforeMetric[2].trim();
    const metric = outcomeBeforeMetric[3].trim();
    if (outcome === "잔존") {
      return `${formatKoreanMetricSubject(`${subject} 잔존율`)} ${metric}입니다`;
    }
    return `${formatKoreanMetricSubject(subject)} ${metric} ${koreanMetricOutcomePredicate(outcome)}`;
  }

  const trailingOutcome = text.match(new RegExp(`^(.{2,220}?\\d+(?:\\.\\d+)?\\s*(?:%|배).{0,120}?)\\s*(${KOREAN_METRIC_OUTCOME_PATTERN})$`, "u"));
  if (trailingOutcome?.[1] && trailingOutcome[2]) {
    return `${trailingOutcome[1].trim()} ${koreanMetricOutcomePredicate(trailingOutcome[2])}`;
  }

  return undefined;
}

function formatKoreanMetricSubject(value: string): string {
  const subject = normalizeKoreanMetricClaimPhrase(value)
    .replace(/\s*(?:은|는)$/u, "")
    .trim();
  if (isKoreanMetricTimingOnlySubject(subject)) {
    return subject;
  }
  return subject ? appendKoreanTopicParticle(subject) : subject;
}

function isKoreanMetricTimingOnlySubject(value: string): boolean {
  return /^(?:사용|도포|적용|세정)\s*(?:직후|전|후|\d+(?:\.\d+)?\s*(?:시간|일|주|개월)\s*후)$/u.test(value)
    || /^\d+(?:\.\d+)?\s*(?:시간|일|주|개월)\s*(?:후|동안|뒤)$/u.test(value);
}

function koreanMetricOutcomePredicate(outcome: string): string {
  switch (outcome.trim()) {
    case "증가":
      return "증가했습니다";
    case "감소":
      return "감소했습니다";
    case "상승":
      return "상승했습니다";
    case "잔존":
      return "잔존했습니다";
    case "지속":
      return "지속되었습니다";
    case "회복":
      return "회복되었습니다";
    case "개선":
      return "개선되었습니다";
    case "향상":
      return "향상되었습니다";
    case "완화":
      return "완화되었습니다";
    default:
      return `${outcome.trim()}되었습니다`;
  }
}

function convertKoreanResultSentenceToConnector(value: string): string {
  return value
    .replace(/되었습니다$/u, "되었고")
    .replace(/했습니다$/u, "했고")
    .replace(/입니다$/u, "이고");
}

function hasKoreanQuantifiedReportedSignal(value: string): boolean {
  return /(?:\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*배)/.test(value);
}

function isKoreanWebPageMixedIngredientMetricEvidenceSentence(value: string): boolean {
  const text = value.trim();
  if (!/[가-힣]/.test(text) || !hasIngredientTechnologyCoverageText(text) || !/%/.test(text)) {
    return false;
  }
  return /(?:선택의\s*)?(?:핵심\s*)?근거(?:로를|로|를)?\s*(?:제공합니다|제시합니다|됩니다)[.!?。！？]?$/u.test(text)
    || /근거로를\s*제공합니다[.!?。！？]?$/u.test(text);
}

function normalizeKoreanIngredientMetricEvidencePhrase(value: string): string {
  return normalizeKoreanRepairPhrase(value)
    .replace(/\s*\/\s*/g, "·")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeKoreanMetricEvidencePhrase(value: string): string {
  return repairKoreanScientificTestWording(normalizeKoreanRepairPhrase(value))
    .replace(/\s+/g, " ")
    .trim();
}

function splitPublicSentences(value: string): string[] {
  return value
    .split(/(?<=[.!?。！？])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function isMisroutedWebPageUsageTechnologySentence(value: string): boolean {
  const text = value.trim();
  if (!/(?:사용법\s*영역|HowTo|how\s*to\s*use|usage\s+(?:area|section|guidance|steps?))/i.test(text)) {
    return false;
  }
  return isIngredientTechnologyUsageLeak(text);
}

function repairIngredientTechnologyUsageCoverageBlendSentence(value: string): string {
  if (!isIngredientTechnologyUsageCoverageBlendSentence(value)) {
    return value;
  }
  const repaired = value
    .replace(/,\s*(?:사용법|사용\s*방법)(?:을|를)?\s*(확인(?:하고|할 수 있습니다|할 수 있고|합니다)?|비교(?:하고|할 수 있습니다)?|살펴(?:볼 수 있습니다|보고)?)/g, " 등 성분/기술 정보를 $1")
    .replace(/\s+/g, " ")
    .trim();
  const base = repaired.replace(/[.。]+$/g, "").trim();
  return `${base}.`;
}

function isIngredientTechnologyUsageCoverageBlendSentence(value: string): boolean {
  const text = value.trim();
  if (!/(?:사용법|사용\s*방법|HowTo|how\s*to\s*use|usage\s+guidance|directions?)/i.test(text) || !hasIngredientTechnologyCoverageText(text)) {
    return false;
  }
  return /(?:성분|기술|포뮬러|복합체|캡슐|세라마이드|콜레스테롤|지방산|PHA|formula|technology|complex|capsule|ceramide)[^.!?。！？]{0,160},\s*(?:사용법|사용\s*방법|HowTo|how\s*to\s*use|usage\s+guidance|directions?)(?:을|를)?\s*(?:확인|비교|살펴|다루|안내|제공|check|compare|review|cover|include)/i.test(text)
    || /(?:고객|사용자|customers?|users?)[^.!?。！？]{0,40}(?:은|는)?[^.!?。！？]{0,180}(?:성분|기술|포뮬러|복합체|캡슐|세라마이드|콜레스테롤|지방산|PHA|formula|technology|complex|capsule|ceramide)[^.!?。！？]{0,120}(?:사용법|사용\s*방법|HowTo|how\s*to\s*use|usage\s+guidance|directions?)(?:을|를)?\s*(?:확인|비교|살펴|check|compare|review)/i.test(text);
}

function hasIngredientTechnologyCoverageText(value: string): boolean {
  return /(?:성분|기술|포뮬러|복합체|캡슐|세라마이드|콜레스테롤|지방산|히알루론산|레티놀|나이아신아마이드|펩타이드|PHA|formula|technology|complex|capsule|ceramide|hyaluronic|retinol|niacinamide|peptide)/i.test(value);
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
  const repairedLines = field === "content.sections.howToUse"
    ? kept.every((line) => isFallbackSectionLine(stripListMarker(line)))
      ? []
      : repairHowToUseSectionLines(kept, locale)
    : kept;
  const removedInvalidLines = kept.length !== lines.length;
  const changedHowToLines = !arraysEqual(repairedLines, kept);
  if (!removedInvalidLines && !changedHowToLines) {
    return value;
  }

  const next = repairedLines.length > 0 ? repairedLines.join("\n") : fieldContractFallback(field, locale);
  const isHowToDedupeOnly = field === "content.sections.howToUse" && !removedInvalidLines && changedHowToLines;
  addRepair(warnings, repairs, {
    field,
    source: "field-contract-validator",
    issue: isHowToDedupeOnly
      ? "Public how-to section duplicated the same actionable usage direction with different surface wording."
      : "Public content section contained lines that did not match the RAG field evidence contract.",
    action: isHowToDedupeOnly
      ? "Deduplicated semantically equivalent HowTo lines and rebuilt the ordered usage section."
      : "Removed misrouted lines so usage, ingredient, and benefit content stay separated after generation.",
    before: value,
    after: next,
    evidence: ["RAG Field Evidence Contract", field]
  }, `Content section ${field} was repaired by field evidence contract validation.`);

  return next;
}

function repairHowToUseSectionLines(lines: string[], locale: PdpGeoLocale): string[] {
  if (lines.every((line) => isFallbackSectionLine(stripListMarker(line)))) {
    return lines;
  }

  const results: string[] = [];
  const seenKeys = new Set<string>();

  for (const line of lines) {
    const text = stripListMarker(line);
    const parts = splitHowToStepUsageText(text, locale).filter((part) => isActionableUsageText(part));
    for (const part of parts) {
      const key = howToStepDedupeKey(part);
      if (key && seenKeys.has(key)) {
        continue;
      }
      if (key) {
        seenKeys.add(key);
      }
      results.push(part);
    }
  }

  return results.map((step, index) => `${index + 1}. ${step}`);
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sectionLines(value: string): string[] {
  return value
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function fieldContractFallback(field: string, locale: PdpGeoLocale): string {
  if (field === "content.sections.howToUse") {
    return "";
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
    return (isIngredientEvidenceText(text) || isConciseIngredientToken(text)) && !isMisroutedIngredientContext(text);
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
  if (isNonProceduralUsageCandidate(text)) {
    return false;
  }
  if (isEvidenceOnlyUsageText(text)) {
    return false;
  }
  if (isSensoryOnlyUsageText(text)) {
    return false;
  }
  if (isIngredientTechnologyUsageLeak(text)) {
    return false;
  }
  return isProceduralUsageInstruction(text);
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
  if (/(?:%|％|\d+(?:\.\d+)?\s*배|임상|인체\s*적용|자가\s*평가|실험|시험|테스트|측정|평가|결과|대비|\bvs\.?\b|clinical|instrumental|study|test(?:ed)?|result|versus)/iu.test(text)
    && /(?:개선|증가|감소|높|낮|잔존|효과|효능|improv|increase|decrease|higher|lower|retention|effect)/iu.test(text)) {
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
  if (!/[가-힣]/.test(text)) {
    return false;
  }
  if (isKoreanCustomerReviewNarrativeUsageLeak(text)) {
    return true;
  }
  const hasReviewVoice = /(?:아직|본격적으로|워낙\s*평|평이\s*좋|기대(?:가|되|하)|타\s*제품|사용해\s*보|사용해보|사용해\s*봤|사용해봤|사용했|썼는데|써\s*보|써보|했었|더라구|더라고|구요|네요|어요|좋아요|괜찮겠지|마음으로|시간이\s*조금\s*지나)/i.test(text);
  return hasReviewVoice && !hasActionableApplicationVerb(text);
}

function isKoreanCustomerReviewNarrativeUsageLeak(value: string): boolean {
  const text = stripListMarker(value).trim();
  return /(?:^|\s)[A-Za-z0-9_*.-]{2,}\s+20\d{2}[-.]\d{1,2}[-.]\d{1,2}\b/u.test(text)
    || /(?:아직\s*본격적으로|워낙\s*평|평이\s*좋|기대가\s*많|기대되|고객\s*리뷰|후기|리뷰)/u.test(text)
    || /(?:구매했|구매\s*했|구매했어요|필요해서\s*구매|배송|포장|도착했|득템|저렴한\s*가격|쓰기\s*전부터|쓰기도\s*전부터|기분이\s*정말\s*좋)/u.test(text)
    || /(?:초등학생|딸|아들|남편|어머니|엄마|가족)[^.!?。！？]{0,80}(?:구매|필요|사용|쓰|선크림)/u.test(text)
    || /(?:느낌이네요|느낌입니다|좋습니다|좋네요|좋아요|같아요|같습니다)\s*$/u.test(text) && !hasActionableApplicationVerbWithoutGenericApply(text);
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
  return /(?:적당량|손에|물과\s*함께|거품\s*내|거품내|얼굴에|문지르|미온수|헹구|화장솜|덜어|펴\s*바르|펴\s*바릅|펴\s*발라|바르(?:고|며|듯|세요|십시오|기|면|는|도록)|바릅|바른\s*후|발라(?:주|주세요|줍니다|서|가며)|마사지(?:하듯|하[고여]|한\s*후|해|하세요|하며)|흡수(?:시켜|시키|될\s*때까지|되도록|해\s*주세요|시킵)|마무리(?:해|하세요|합니다|하십시오)|도포(?:해|하세요|합니다|하십시오|한\s*(?:뒤|후))|사용\s*(?:해|하세요|합니다|하십시오|한다|하시)|(?:샤워|세안|토너|스킨케어|아침|저녁|매일|데일리)[^.!?。！？\n]{0,40}사용(?:합니다|하세요|해\s*주세요|해|$))/.test(text);
}

function isIngredientTechnologyUsageLeak(value: string): boolean {
  const text = stripListMarker(value).trim();
  const hasFormulaOrTechnology = /(?:성분|기술|포뮬러|복합체|캡슐|세라마이드|히알루론산|레티놀|나이아신아마이드|펩타이드|formula|technology|complex|capsule|ceramide|hyaluronic|retinol|niacinamide|peptide|成分|技術|処方|フォーミュラ|複合体|カプセル|セラミド|ヒアルロン酸|レチノール|ナイアシンアミド|ペプチド)/i.test(text);
  const hasInstructionCue = /(?:사용\s*방법|사용법|\bhow\s+to\s+use\b|\bdirections?\b|使い方|使用方法|適量|手のひら|顔全体|肌になじませ|塗布|すすぎ|マッサージ|적당량|손에|얼굴에|피부결|펴\s*바르|발라|흡수|도포|massage|apply|dispense|pat|press|spread|smooth|rinse|lather)/i.test(text);
  const hasOnlyDescriptiveUse = /(?:사용할\s*때마다|사용\s*시|when\s+used|with\s+each\s+use|使用時|使うたび)/i.test(text) && !hasInstructionCue;
  const hasTechnologyUseFrame = /(?:성분|기술|포뮬러|복합체|캡슐)[^.!?。！？]{0,60}(?:사용|적용|쓰(?:인|이는)|활용)|(?:uses?|using|applies?)[^.!?]{0,60}(?:ingredient|formula|technology|complex|capsule)|(?:成分|技術|処方|フォーミュラ|複合体|カプセル)[^.!?。！？]{0,60}(?:使用|採用|配合|活用)/i.test(text);
  const hasReportingFrame = /(?:적용|설계|제공|도출|방출|설명|특징|구성|함유|담(?:긴|은)|녹지\s*않|patent|proprietary|designed|delivers?|provides?|contains?|features?|採用|設計|提供|説明|特徴|構成|配合|含有|特許|独自)/i.test(text);
  return hasFormulaOrTechnology && (hasOnlyDescriptiveUse || hasTechnologyUseFrame || hasReportingFrame) && !hasActionableApplicationVerb(text);
}

function isProceduralUsageInstruction(value: string): boolean {
  const text = stripListMarker(value).trim();
  if (!text) {
    return false;
  }
  const proceduralScore = usageProcedureSignalScore(text);
  const descriptiveScore = usageDescriptionSignalScore(text);
  if ((hasDescriptiveApplicationFrame(text) || hasSensoryEvaluationFrame(text)) && proceduralScore < 3) {
    return false;
  }
  return (hasProcedureActionCue(text) || hasRoutinePlacementCue(text))
    && proceduralScore >= 2
    && proceduralScore >= descriptiveScore;
}

function isNonProceduralUsageCandidate(value: string): boolean {
  const text = stripListMarker(value).trim();
  if (!text || (!hasProcedureActionCue(text) && !hasRoutinePlacementCue(text))) {
    return false;
  }
  return !isProceduralUsageInstruction(text) && usageDescriptionSignalScore(text) > 0;
}

function usageProcedureSignalScore(value: string): number {
  const text = stripListMarker(value).trim();
  return [
    /(?:적당량|소량|충분량|손바닥|손에|화장솜|얼굴|피부결|미온수|물과\s*함께|appropriate amount|small amount|palm|hands?|cotton pad|face|skin|neck|water|適量|手のひら|顔|肌|コットン)/i.test(text) ? 1 : 0,
    hasProcedureActionCue(text) ? 1 : 0,
    /(?:후|뒤|다음|먼저|마지막|단계|순서|때는|then|after|before|next|finally|step|when|後|次|最後)/i.test(text) ? 1 : 0,
    /(?:주세요|줍니다|합니다|하세요|하십시오|바릅니다|흡수시킵니다|헹굽니다|사용할\s*수\s*있|\buse\b|\bapply\b|\bdispense\b|ます|してください)/i.test(text) ? 1 : 0,
    /(?:아침|저녁|매일|데일리|morning|night|daily|twice|once|朝|夜|毎日)/i.test(text) ? 1 : 0
  ].reduce((sum, score) => sum + score, 0);
}

function usageDescriptionSignalScore(value: string): number {
  const text = stripListMarker(value).trim();
  return [
    hasDescriptiveApplicationFrame(text) ? 2 : 0,
    hasSensoryEvaluationFrame(text) ? 2 : 0,
    /(?:케어|개선|도움|효과|효능|추천|위한|민감|건조|보습|수분|장벽|care|benefit|helps?|supports?|improves?|recommended|for\s+\w+|効果|ケア|改善|おすすめ|向け)/i.test(text) ? 1 : 0,
    /(?:성분|원료|캡슐|포뮬러|기술|ingredient|formula|technology|capsule|成分|処方|技術|カプセル)/i.test(text) ? 1 : 0,
    /(?:제품|상품|토너|크림|세럼|로션|클렌저|product|toner|cream|serum|lotion|cleanser|商品|製品|化粧水|クリーム|美容液)/i.test(text) ? 1 : 0
  ].reduce((sum, score) => sum + score, 0);
}

function hasDescriptiveApplicationFrame(value: string): boolean {
  return /(?:바르는\s*순간|사용(?:할\s*때마다|하는\s*순간)|도포\s*직후|on\s+application|upon\s+application|when\s+(?:used|applied)|with\s+each\s+use|塗った瞬間|使用(?:時|する瞬間)|使うたび)/i.test(value);
}

function hasSensoryEvaluationFrame(value: string): boolean {
  return /(?:테스트|시험|사용감|마무리감|수분감|보습감|흡수감|끈적임|산뜻|촉촉|느껴지는|진정되는|피부가\s*진정|부드러운|피부결이\s*부드러운|use[-\s]?feel|finish(?:es)?|non[-\s]?sticky|stickiness|fresh\s+feel|dewy|soothing|skin\s+feels?\s+smooth|tested?|sensory|使用感|仕上がり|べたつき|さっぱり|しっとり|うるおい感|なめらか|落ち着|テスト|試験|感じられる)/i.test(value);
}

function hasProcedureActionCue(value: string): boolean {
  return /(?:덜어|적셔|올려두|펴\s*바르|펴\s*발라|두드려|흡수(?!감)|마사지|문지르|헹구|헹굽|거품|도포(?!감)|마무리(?:해|하세요|합니다|하십시오)|사용(?:해|하세요|합니다|하십시오|할\s*수\s*있)|apply|dispense|spread|smooth|pat|press|absorb|massage|lather|rinse|pump|take|use\s+as|なじませ|塗布|すすぎ|マッサージ)/i.test(value);
}

function hasRoutinePlacementCue(value: string): boolean {
  return /(?:아침|저녁|매일|데일리|스킨케어|샤워\s*후|세안\s*후|마지막\s*단계|첫\s*단계|루틴|morning|night|daily|routine|after\s+(?:cleansing|shower)|last\s+step|first\s+step|朝|夜|毎日|スキンケア|洗顔後|最後のステップ)/i.test(value);
}

function hasActionableApplicationVerb(value: string): boolean {
  const text = stripListMarker(value).trim();
  return /\b(?:apply|dispense|massage|lather|rinse|pat|press|spread|smooth|warm|pump)\b|なじませ|塗布/i.test(text)
    || /(?:적당량|손에|물과\s*함께|거품\s*내|거품내|얼굴에|문지르|미온수|헹구|화장솜|덜어|펴\s*바르|펴\s*바릅|펴\s*발라|바르(?:고|며|듯|세요|십시오|기|면|는|도록)|바릅|바른\s*후|발라(?:주|주세요|줍니다|서|가며)|마사지(?:하듯|하[고여]|한\s*후|해|하세요|하며)|흡수(?:시켜|시키|될\s*때까지|되도록|해\s*주세요|시킵)|마무리(?:해|하세요|합니다|하십시오)|도포(?:해|하세요|합니다|하십시오|한\s*(?:뒤|후)))/.test(text);
}

function hasActionableApplicationVerbWithoutGenericApply(value: string): boolean {
  const text = stripListMarker(value).trim();
  return /\b(?:apply|dispense|massage|lather|rinse|pat|press|spread|smooth|warm|pump)\b|なじませ|塗布/i.test(text)
    || /(?:적당량|손에|물과\s*함께|거품\s*내|거품내|얼굴에|문지르|미온수|헹구|화장솜|덜어|펴\s*바르|펴\s*바릅|펴\s*발라|발라(?:주|주세요|줍니다|서|가며)|마사지(?:하듯|하[고여]|한\s*후|해|하세요|하며)|흡수(?:시켜|시키|될\s*때까지|되도록|해\s*주세요|시킵)|마무리(?:해|하세요|합니다|하십시오)|도포(?:해|하세요|합니다|하십시오|한\s*(?:뒤|후)))/.test(text);
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

function isConciseIngredientToken(value: string): boolean {
  const text = value.trim();
  if (!text || text.length > 80 || /[.!?。！？]/u.test(text) || text.split(/\s+/u).length > 6) {
    return false;
  }
  if (isIngredientAttributePropertyToken(text)
    || /(?:고객|리뷰|후기|사용법|루틴|효과가|도움|개선|진정|보습력|흡수력|review|customer|usage|routine|benefit|effect)/iu.test(text)) {
    return false;
  }
  return /^[\p{L}\p{N}][\p{L}\p{N}\s+()\[\],.'’®™-]*$/u.test(text);
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
  let next = value
    .replace(/\b(\d)based\b/gi, "$1 based")
    .replace(/[ \t]+(Q[.:]\s)/g, "\n\n$1")
    .replace(/[ \t]+(A[.:]\s)/g, "\n$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (locale === "ko-KR") {
    next = removeReviewBasedFaqSectionItems(next, value, locale, warnings, repairs);
  }
  next = dedupeFaqSectionTextBySemanticIntent(next, value, locale, warnings, repairs);

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

function dedupeFaqSectionTextBySemanticIntent(
  value: string,
  original: string,
  locale: PdpGeoLocale,
  warnings: string[],
  repairs: PdpGeoValidationRepair[]
): string {
  const lines = value.split("\n");
  const selected: Array<{
    block: string[];
    question: string;
    answer: string;
    key: string;
    semanticKeys: string[];
    preference: number;
  }> = [];
  let changed = false;

  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? "";
    const match = line.match(/^(Q[.:]\s*)(.+)$/u);
    if (!match?.[2]) {
      selected.push({
        block: [line],
        question: "",
        answer: "",
        key: "",
        semanticKeys: [],
        preference: 0
      });
      index += 1;
      continue;
    }

    const block: string[] = [line];
    let nextIndex = index + 1;
    while (nextIndex < lines.length && !/^Q[.:]\s*/u.test(lines[nextIndex] ?? "")) {
      block.push(lines[nextIndex] ?? "");
      nextIndex += 1;
    }

    const question = match[2];
    const answer = block
      .slice(1)
      .join("\n")
      .replace(/^A[.:]\s*/u, "")
      .trim();
    const key = normalizeFaqQuestionDedupeKey(question);
    const semanticKeys = createFaqSemanticDedupeKeys(question, locale);
    const preference = scoreFaqSemanticDedupePreference(question, answer, locale);
    const conflictIndexes = selected.flatMap((candidate, selectedIndex) => (
      key && candidate.key === key
      || semanticKeys.length > 0 && hasFaqSemanticDedupeConflict(semanticKeys, candidate.semanticKeys)
    ) ? [selectedIndex] : []);

    if (conflictIndexes.length === 0) {
      selected.push({
        block,
        question,
        answer,
        key,
        semanticKeys,
        preference
      });
    } else {
      changed = true;
      const existingCandidates = conflictIndexes
        .map((selectedIndex) => selected[selectedIndex])
        .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
      const existing = existingCandidates
        .sort((left, right) => right.preference - left.preference)[0];
      if (!existing) {
        index = nextIndex;
        continue;
      }
      const winner = preference > existing.preference
        ? {
          block,
          question,
          answer,
          key,
          semanticKeys,
          preference
        }
        : existing;
      const insertionIndex = Math.min(...conflictIndexes);
      for (const selectedIndex of [...conflictIndexes].sort((left, right) => right - left)) {
        selected.splice(selectedIndex, 1);
      }
      selected.splice(Math.min(insertionIndex, selected.length), 0, winner);
    }
    index = nextIndex;
  }

  const next = selected.flatMap((item) => item.block).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (changed) {
    addRepair(warnings, repairs, {
      field: "content.sections.faq",
      source: "field-contract-validator",
      issue: "FAQ section contained duplicate or overlapping ingredient-benefit and benefit-overview question intent.",
      action: "Removed overlapping FAQ section blocks so public FAQ content stays distinct.",
      before: original.trim(),
      after: next,
      evidence: ["content.sections.faq", "semantic FAQ intent dedupe"]
    }, "Overlapping FAQ section intent was removed during final sentence QA.");
  }

  return next;
}

function removeReviewBasedFaqSectionItems(
  value: string,
  original: string,
  locale: PdpGeoLocale,
  warnings: string[],
  repairs: PdpGeoValidationRepair[]
): string {
  const lines = value.split("\n");
  let changed = false;
  const kept: string[] = [];

  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? "";
    const match = line.match(/^(Q[.:]\s*)(.+)$/u);
    if (!match?.[2]) {
      kept.push(line);
      index += 1;
      continue;
    }

    const block: string[] = [line];
    let nextIndex = index + 1;
    while (nextIndex < lines.length && !/^Q[.:]\s*/u.test(lines[nextIndex] ?? "")) {
      block.push(lines[nextIndex] ?? "");
      nextIndex += 1;
    }

    const answerText = block
      .slice(1)
      .join("\n")
      .replace(/^A[.:]\s*/u, "")
      .trim();
    if (isReviewBasedFaqItem(match[2], answerText, locale)) {
      changed = true;
      index = nextIndex;
      continue;
    }
    const positiveReviewRepair = repairPositiveReviewFaqItem(match[2], answerText, locale);
    if (positiveReviewRepair) {
      kept.push(`${match[1]}${positiveReviewRepair.question}`);
      kept.push(`A. ${positiveReviewRepair.answer}`);
      changed = true;
      index = nextIndex;
      continue;
    }
    const usageReviewLeakRepair = repairKoreanUsageFaqReviewLeak(match[2], answerText);
    if (usageReviewLeakRepair !== answerText) {
      kept.push(line);
      kept.push(`A. ${usageReviewLeakRepair}`);
      changed = true;
      index = nextIndex;
      continue;
    }

    kept.push(...block);
    index = nextIndex;
  }

  const next = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  if (changed) {
    addRepair(warnings, repairs, {
      field: "content.sections.faq",
      source: "field-contract-validator",
      issue: "FAQ section included raw or negative customer review text.",
      action: "Rewrote positive review-intent FAQ blocks and removed negative review-based FAQ blocks.",
      before: original.trim(),
      after: next,
      evidence: ["content.sections.faq", "review-intent FAQ contract", "negative review filter"]
    }, "Review-intent FAQ section blocks were repaired during final sentence QA.");
  }

  return next;
}

function repairFaqAnswerFieldContract(
  question: string,
  answer: string,
  locale: PdpGeoLocale,
  warnings: string[],
  repairs: PdpGeoValidationRepair[]
): string {
  if (locale !== "ko-KR") {
    return answer;
  }

  let next = answer;

  const repairedComparison = repairKoreanComparisonFaqAnswer(question, next);
  if (repairedComparison !== next) {
    addRepair(warnings, repairs, {
      field: "FAQPage.mainEntity.acceptedAnswer.text",
      source: "field-contract-validator",
      issue: "FAQ comparison answer mixed the direct same/different answer with patent identifiers or overlong formula-technology details.",
      action: "Rewrote the FAQ answer so the comparison result is answered first and supporting capsule evidence remains concise.",
      before: next,
      after: repairedComparison,
      evidence: ["FAQPage.mainEntity.name", "FAQPage.mainEntity.acceptedAnswer.text", "answer-ready FAQ contract"]
    }, "FAQ comparison answer was repaired to keep the answer direct and source-scoped.");
    next = repairedComparison;
  }

  const repairedBenefit = repairKoreanBenefitFaqReportStyleAnswer(question, next);
  if (repairedBenefit !== next) {
    addRepair(warnings, repairs, {
      field: "FAQPage.mainEntity.acceptedAnswer.text",
      source: "field-contract-validator",
      issue: "FAQ suitability or benefit answer used report-style metric wording instead of customer-facing effect wording.",
      action: "Rewrote the numeric result clause as a direct effect statement while preserving the source-backed value.",
      before: next,
      after: repairedBenefit,
      evidence: ["FAQPage.mainEntity.name", "FAQPage.mainEntity.acceptedAnswer.text", "benefit FAQ answer contract"]
    }, "FAQ benefit answer was repaired so metric evidence reads as a direct customer-facing effect.");
    next = repairedBenefit;
  }

  const repairedPositiveReviewAnswer = repairPositiveReviewFaqAnswer(question, next, locale);
  if (repairedPositiveReviewAnswer !== next) {
    addRepair(warnings, repairs, {
      field: "FAQPage.mainEntity.acceptedAnswer.text",
      source: "field-contract-validator",
      issue: "FAQ answer mixed raw customer-review language with product-detail or ingredient sentences.",
      action: "Rewrote the answer as a positive review-intent use-feel summary and removed mixed ingredient/technology clauses.",
      before: next,
      after: repairedPositiveReviewAnswer,
      evidence: ["FAQPage.mainEntity.acceptedAnswer.text", "review-intent FAQ contract"]
    }, "Positive review-intent FAQ answer was repaired during final sentence QA.");
    next = repairedPositiveReviewAnswer;
  }

  const repairedReviewRouting = repairFaqAnswerReviewFieldRouting(question, next, locale);
  if (repairedReviewRouting !== next) {
    addRepair(warnings, repairs, {
      field: "FAQPage.mainEntity.acceptedAnswer.text",
      source: "field-contract-validator",
      issue: "FAQ answer mixed customer-review language into a product-detail answer.",
      action: "Removed review-only answer sentences so FAQPage remains grounded in product-detail evidence.",
      before: next,
      after: repairedReviewRouting,
      evidence: ["FAQPage.mainEntity.acceptedAnswer.text", "review-intent FAQ", "answer-ready FAQ contract"]
    }, "Review language was removed from FAQ answer text.");
    next = repairedReviewRouting;
  }

  const repairedUsageReviewLeak = repairKoreanUsageFaqReviewLeak(question, next);
  if (repairedUsageReviewLeak !== next) {
    addRepair(warnings, repairs, {
      field: "FAQPage.mainEntity.acceptedAnswer.text",
      source: "field-contract-validator",
      issue: "FAQ usage or routine answer included raw customer-review expectation text as if it were usage guidance.",
      action: "Removed review-only usage sentences so usage and routine FAQ answers stay grounded in product usage evidence.",
      before: next,
      after: repairedUsageReviewLeak,
      evidence: ["FAQPage.mainEntity.acceptedAnswer.text", "usage FAQ contract", "review-intent FAQ contract"]
    }, "Raw review expectation text was removed from a usage or routine FAQ answer.");
    next = repairedUsageReviewLeak;
  }

  return next;
}

function dedupeFaqMainEntityBySemanticIntent(
  items: Array<Record<string, unknown>>,
  locale: PdpGeoLocale,
  warnings: string[],
  repairs: PdpGeoValidationRepair[]
): Array<Record<string, unknown>> {
  const selected: Array<{
    item: Record<string, unknown>;
    question: string;
    answer: string;
    key: string;
    semanticKeys: string[];
    preference: number;
  }> = [];

  for (const item of items) {
    const question = stringValue(item.name) ?? "";
    const answer = isRecord(item.acceptedAnswer) ? stringValue(item.acceptedAnswer.text) ?? "" : "";
    const key = normalizeFaqQuestionDedupeKey(question);
    if (!key) {
      selected.push({
        item,
        question,
        answer,
        key,
        semanticKeys: [],
        preference: 0
      });
      continue;
    }

    const semanticKeys = createFaqSemanticDedupeKeys(question, locale);
    const preference = scoreFaqSemanticDedupePreference(question, answer, locale);
    const conflictIndexes = selected.flatMap((candidate, index) => (
      candidate.key === key
      || semanticKeys.length > 0 && hasFaqSemanticDedupeConflict(semanticKeys, candidate.semanticKeys)
    ) ? [index] : []);
    if (conflictIndexes.length === 0) {
      selected.push({
        item,
        question,
        answer,
        key,
        semanticKeys,
        preference
      });
      continue;
    }

    const existingCandidates = conflictIndexes
      .map((index) => selected[index])
      .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
    const existing = existingCandidates
      .sort((left, right) => right.preference - left.preference)[0];
    if (!existing) {
      selected.push({
        item,
        question,
        answer,
        key,
        semanticKeys,
        preference
      });
      continue;
    }
    const keepCurrent = preference > existing.preference;
    const current = {
        item,
        question,
        answer,
        key,
        semanticKeys,
        preference
      };
    const winner = keepCurrent ? current : existing;
    const removedItems = keepCurrent
      ? existingCandidates.map((candidate) => candidate.item)
      : [item, ...existingCandidates.filter((candidate) => candidate !== existing).map((candidate) => candidate.item)];
    const insertionIndex = Math.min(...conflictIndexes);
    for (const index of [...conflictIndexes].sort((left, right) => right - left)) {
      selected.splice(index, 1);
    }
    selected.splice(Math.min(insertionIndex, selected.length), 0, winner);
    addRepair(warnings, repairs, {
      field: "FAQPage.mainEntity",
      source: "field-contract-validator",
      issue: "FAQ contained duplicate or overlapping ingredient-benefit and benefit-overview question intent.",
      action: "Kept the more specific answer-ready FAQ question and removed the overlapping FAQ item.",
      before: toJsonValue(removedItems.length === 1 ? removedItems[0] : removedItems),
      after: toJsonValue(winner.item),
      evidence: ["FAQPage.mainEntity.name", "semantic FAQ intent dedupe"]
    }, "Overlapping FAQ question intent was removed during final sentence QA.");
  }

  return selected.map((candidate) => candidate.item);
}

function normalizeFaqQuestionDedupeKey(question: string): string {
  return normalizeKoreanRepairPhrase(question)
    .toLocaleLowerCase()
    .replace(/[?？!.。！？]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function createFaqSemanticDedupeKeys(question: string, locale: PdpGeoLocale): string[] {
  const keys: string[] = [];
  if (isDirectIngredientBenefitFaqQuestion(question, locale)) {
    keys.push("ingredient-benefit-overview");
  }
  if (isGenericBenefitOverviewFaqQuestion(question, locale)) {
    keys.push("benefit-overview");
  }
  if (isIngredientOverviewFaqQuestion(question, locale)) {
    keys.push("ingredient-overview");
  }
  if (isSuitabilityOverviewFaqQuestion(question, locale)) {
    keys.push("suitability-overview");
  }
  return keys;
}

function hasFaqSemanticDedupeConflict(nextKeys: string[], selectedKeys: string[]): boolean {
  return nextKeys.some((nextKey) => selectedKeys.includes(nextKey));
}

function scoreFaqSemanticDedupePreference(question: string, answer: string, locale: PdpGeoLocale): number {
  const combined = `${question} ${answer}`;
  return [
    isDirectIngredientBenefitFaqQuestion(question, locale) ? 40 : 0,
    isGenericBenefitOverviewFaqQuestion(question, locale) ? 20 : 0,
    /(?:성분|기술|ingredient|formula|technology)/i.test(combined) ? 5 : 0,
    /(?:효능|효과|보습|장벽|수분|탄력|주름|benefit|effect|hydration|barrier|firm|wrinkle)/i.test(combined) ? 5 : 0,
    /(?:\d+(?:\.\d+)?\s*%|\d+\s*(?:시간|일|주|명|회|hours?|days?|weeks?|participants?))/.test(answer) ? 4 : 0
  ].reduce((sum, score) => sum + score, 0);
}

function isDirectIngredientBenefitFaqQuestion(question: string, locale: PdpGeoLocale): boolean {
  const text = normalizeKoreanRepairPhrase(question);
  if (locale === "ko-KR") {
    return /(?:주요|핵심)\s*(?:성분|성분\/기술)[^?？.。!！]{0,30}(?:효능|효과)|(?:성분|성분\/기술)[^?？.。!！]{0,30}(?:효능|효과)[^?？.。!！]{0,20}(?:무엇|뭔가요|있나요)/u.test(text);
  }
  return /\b(?:key|main|primary)\s+(?:ingredients?|formula|technolog(?:y|ies))\b[^?!.]{0,60}\b(?:benefits?|effects?)\b|\b(?:ingredients?|formula|technolog(?:y|ies))\b[^?!.]{0,60}\b(?:benefits?|effects?)\b/i.test(text);
}

function isGenericBenefitOverviewFaqQuestion(question: string, locale: PdpGeoLocale): boolean {
  const text = normalizeKoreanRepairPhrase(question);
  if (locale === "ko-KR") {
    return /(?:어떤\s*)?피부\s*고민(?:과|및)?\s*효능|피부\s*고민과\s*효능/u.test(text)
      && !isDirectIngredientBenefitFaqQuestion(text, locale);
  }
  return /\bskin\s+concerns?\s+(?:and|&)\s+(?:benefits?|effects?)\b|\b(?:benefits?|effects?)\s+and\s+skin\s+concerns?\b/i.test(text)
    && !isDirectIngredientBenefitFaqQuestion(text, locale);
}

function isIngredientOverviewFaqQuestion(question: string, locale: PdpGeoLocale): boolean {
  const text = normalizeKoreanRepairPhrase(question);
  if (locale === "ko-KR") {
    return /(?:(?:주요|핵심|강조되는)\s*(?:성분|성분\/기술)|(?:성분|성분\/기술)[^?？.。!！]{0,30}(?:무엇|뭔가요|있나요))/u.test(text);
  }
  if (locale === "ja-JP") {
    return /(?:主な|主要な|強調される)?(?:成分|技術)[^?？。]{0,30}(?:何|どれ)/u.test(text);
  }
  return /\b(?:which|what|key|main|primary|highlighted)\b[^?!.]{0,60}\b(?:ingredients?|formula|technolog(?:y|ies))\b/iu.test(text);
}

function isSuitabilityOverviewFaqQuestion(question: string, locale: PdpGeoLocale): boolean {
  const text = normalizeKoreanRepairPhrase(question);
  if (/(?:신생아|영유아|유아|아기|어린이|임산부|수유부|newborns?|infants?|bab(?:y|ies)|children|pregnan|乳幼児|赤ちゃん|子ども|妊娠)/iu.test(text)) {
    return false;
  }
  if (locale === "ko-KR") {
    return /(?:어떤\s*(?:고객|피부|대상)|누구(?:에게)?|추천\s*(?:대상|고객)|적합|피부\s*타입)/u.test(text);
  }
  if (locale === "ja-JP") {
    return /(?:どんな.*(?:人|肌)|誰|向いて|肌タイプ)/u.test(text);
  }
  return /(?:who\s+is|best\s+suited|suitable\s+for|recommended\s+for|which\s+skin\s+types?|what\s+skin\s+types?)/iu.test(text);
}

function repairKoreanUsageFaqReviewLeak(question: string, answer: string): string {
  if (classifyKoreanQuestionIntent(question) !== "usage") {
    return answer;
  }
  const sentences = splitPublicSentences(answer);
  if (sentences.length === 0) {
    return answer.trim();
  }
  const kept = sentences.filter((sentence) => !isKoreanUsageFaqReviewLeakSentence(sentence));
  if (kept.length === sentences.length) {
    return answer;
  }
  if (kept.length > 0) {
    return kept.join(" ").trim();
  }
  const productName = extractKoreanProductNameFromQuestion(question);
  if (productName && /(?:클렌|세안|폼|워시)/u.test(question)) {
    return `${appendKoreanTopicParticle(productName)} 세안 단계에서 사용한 뒤 토너, 세럼, 크림 등 후속 스킨케어로 이어갈 수 있습니다.`;
  }
  if (productName) {
    return `${appendKoreanTopicParticle(productName)} 상품 상세의 사용 단계에 맞춰 루틴에 포함할 수 있습니다.`;
  }
  return "상품 상세의 사용 단계에 맞춰 루틴에 포함할 수 있습니다.";
}

function isKoreanUsageFaqReviewLeakSentence(value: string): boolean {
  const text = normalizeKoreanRepairPhrase(value);
  if (!text || !/[가-힣]/u.test(text)) {
    return false;
  }
  const hasReviewExpectation = /(?:아직|본격적으로|워낙\s*평|평이\s*좋|기대(?:가|되|하)|사용해\s*보|사용해보|써\s*보|써보|후기|리뷰|좋아요|더라구|더라고|구요|네요|어요)/u.test(text);
  if (hasReviewExpectation && !hasActionableApplicationVerb(text)) {
    return true;
  }
  return /(?:성분\/기술\s*맥락|루틴\s*선택\s*기준을\s*제공|성분\/기술과\s*함께\s*루틴)/u.test(text);
}

function repairFaqAnswerReviewFieldRouting(question: string, answer: string, locale: PdpGeoLocale): string {
  if (isExplicitReviewFaqQuestion(question)) {
    return answer;
  }
  if (isPositiveReviewIntentFaqCandidate(question, answer, locale)) {
    return answer;
  }
  const sentences = splitPublicSentences(answer);
  if (sentences.length === 0) {
    return answer.trim();
  }
  const kept = sentences.filter((sentence) => !isReviewFaqAnswerSentence(sentence, locale));
  if (kept.length === sentences.length) {
    return answer;
  }
  return kept.join(" ").trim();
}

function isReviewFaqAnswerSentence(value: string, locale: PdpGeoLocale): boolean {
  const text = value.trim();
  if (!text) {
    return false;
  }
  if (locale === "ko-KR") {
    return /(?:고객\s*리뷰|대표\s*고객\s*리뷰|리뷰에서는|후기에서는|리뷰\s*표현|후기\s*표현|리뷰의|후기의)/u.test(text);
  }
  return /(?:customer\s+reviews?|representative\s+customer\s+reviews?|reviews?\s+(?:mention|describe|highlight|say)|review\s+language)/iu.test(text);
}

function repairKoreanComparisonFaqAnswer(question: string, answer: string): string {
  if (!isKoreanComparisonQuestion(question) || !isOvermixedKoreanComparisonFaqAnswer(answer)) {
    return answer;
  }

  const target = extractKoreanComparisonQuestionTarget(question) ?? "비교 대상 캡슐";
  const productName = extractKoreanFaqProductNameFromAnswer(answer);
  const productSubject = productName ? `${productName}의 캡슐` : "이 토너의 캡슐";
  const capsuleDescription = extractKoreanCapsuleDescription(answer);
  const supportSentence = capsuleDescription
    ? `${productSubject}은 ${capsuleDescription}로 설명됩니다.`
    : `${productSubject} 정보는 상품 상세의 캡슐 설명을 기준으로 확인됩니다.`;

  if (isKoreanUncertainComparisonAnswer(answer)) {
    return `공개된 상품 정보만으로는 ${target}과 동일하다고 단정하기 어렵습니다. ${supportSentence}`;
  }
  if (isKoreanAffirmativeComparisonAnswer(answer)) {
    const capsuleClause = capsuleDescription ? `${capsuleDescription}로 ` : "";
    return `${productSubject}은 ${target}과 ${capsuleClause}동일하다고 설명됩니다.`;
  }

  return answer;
}

function isKoreanComparisonQuestion(question: string): boolean {
  return /(?:동일|같은|같나요|같습니까|차이|다른|비교)/u.test(question);
}

function isOvermixedKoreanComparisonFaqAnswer(answer: string): boolean {
  const text = answer.trim();
  return /특허\s*출원|특허출원번호|특허\s*성분|KR\d|포뮬러\s*기술|기술과\s*특허/u.test(text)
    && /(?:동일|같은|단정|캡슐)/u.test(text);
}

function isKoreanUncertainComparisonAnswer(answer: string): boolean {
  return /(?:동일하다고\s*)?(?:단정하기는?\s*어렵|단정할\s*근거|확인(?:되지는|되지)\s*않|확인하기\s*어렵|어렵고)/u.test(answer);
}

function isKoreanAffirmativeComparisonAnswer(answer: string): boolean {
  return /(?:동일합니다|동일하다고\s*설명|동일한\s*캡슐|같은\s*캡슐|같습니다)/u.test(answer)
    && !isKoreanUncertainComparisonAnswer(answer);
}

function extractKoreanComparisonQuestionTarget(question: string): string | undefined {
  const contained = question.match(/^(.+?)에\s*함유된\s*캡슐/u);
  if (contained?.[1]) {
    return `${normalizeKoreanRepairPhrase(contained[1])} 캡슐`;
  }
  const beforeSame = question.match(/^(.+?)(?:과|와)\s*(?:동일|같은|차이)/u);
  if (beforeSame?.[1]) {
    return normalizeKoreanRepairPhrase(beforeSame[1])
      .replace(/\s*캡슐$/u, " 캡슐")
      .trim();
  }
  return undefined;
}

function extractKoreanFaqProductNameFromAnswer(answer: string): string | undefined {
  const possessive = answer.match(/([가-힣A-Za-z0-9·®™\s]+?(?:토너|크림|세럼|로션|앰플|에센스))(?:의|은|는)\s*캡슐/u);
  return possessive?.[1] ? normalizeKoreanRepairPhrase(possessive[1]) : undefined;
}

function extractKoreanCapsuleDescription(answer: string): string | undefined {
  const capsule = answer.match(/((?:[가-힣A-Za-z0-9·®™]+\s*){0,5}(?:세라마이드|리피드|지질|retinol|ceramide|lipid)\s*캡슐)/iu)?.[1];
  if (!capsule) {
    return undefined;
  }
  return normalizeKoreanRepairPhrase(capsule)
    .replace(/^(?:캡슐은\s*)+/u, "")
    .replace(/\s*특허\s*출원\s*포뮬러$/u, "")
    .replace(/\s*특허\s*성분$/u, "")
    .trim();
}

function repairKoreanBenefitFaqReportStyleAnswer(question: string, answer: string): string {
  if (!isKoreanBenefitOrSuitabilityFaqQuestion(question) || !hasKoreanReportStyleMetricFaqAnswer(answer)) {
    return answer;
  }

  return answer
    .replace(
      /((?:(?:사용|도포|적용)\s*(?:직후|후|전후)?|\d+(?:\.\d+)?\s*(?:시간|일|주|개월)\s*후|\d+(?:\.\d+)?\s*(?:배|%))[^.。！？]{0,90}?(?:증가|개선|회복|감소|완화|지속|상승|향상)(?:된|한)?)\s*결과가\s*제시됩니다/gu,
      (_match, claim: string) => `${normalizeKoreanRepairPhrase(claim)} 효과가 있습니다`
    );
}

function isKoreanBenefitOrSuitabilityFaqQuestion(question: string): boolean {
  return /[가-힣]/.test(question)
    && (classifyKoreanQuestionIntent(question) === "benefit" || /어떤\s*고객|누구(?:에게)?|피부\s*타입|피부타입|권장/u.test(question));
}

function hasKoreanReportStyleMetricFaqAnswer(answer: string): boolean {
  return /(?:(?:사용|도포|적용)\s*(?:직후|후|전후)?|\d+(?:\.\d+)?\s*(?:시간|일|주|개월)\s*후|\d+(?:\.\d+)?\s*(?:배|%))[^.。！？]{0,90}?(?:증가|개선|회복|감소|완화|지속|상승|향상)(?:된|한)?\s*결과가\s*제시됩니다/u.test(answer);
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

  const positiveReviewRepair = repairPositiveReviewFaqItem(question, answer, locale);
  if (positiveReviewRepair) {
    addRepair(warnings, repairs, {
      field: "FAQPage.mainEntity",
      source: "sentence-qa",
      issue: "FAQ question contained raw customer-review wording instead of a reusable review-intent question.",
      action: "Reframed the FAQ as a positive review-intent question and kept only reusable use-feel signals in the answer.",
      before: { question, answer },
      after: positiveReviewRepair,
      evidence: ["question intent: review", "review-intent FAQ contract"]
    }, "Raw positive review FAQ was reframed during final sentence QA.");
    return positiveReviewRepair;
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

function isRawReviewLikeKoreanFaqQuestion(value: string): boolean {
  const text = normalizeKoreanRepairPhrase(value)
    .replace(/[?？!！.。]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!/[가-힣]/u.test(text)) {
    return false;
  }
  if (hasKoreanReviewMetadataPrefix(text)) {
    return true;
  }

  const hasReviewVoice = /(?:뽀득거리지도|미끌거리지도|무난하게|데일리로\s*사용|트러블\s*올라오지|성분이\s*착해서|약품\s*냄새|약품냄새|냄새|향이|아쉬운|좋아요|좋네요|좋은\s*것\s*같|같아요|같구요|같네요|더라구|더라고|구요|했어요|써봤|구매했|사용중|느낌)$/u.test(text)
    || /(?:뽀득|미끌|촉촉|당김|크리미|거품|순해서|자극없이|데일리|무난|트러블|아쉬운|냄새|향이|좋아요|같아요|느낌)/u.test(text);
  if (!hasReviewVoice) {
    return false;
  }

  const hasQuestionForm = hasKoreanFaqQuestionForm(text);
  const isOverlongReview = text.length >= 55 || text.split(/\s+/).length >= 9;
  const hasMultipleReviewClauses = (text.match(/(?:좋아요|같아요|아쉬운|느낌|냄새|트러블|데일리|무난)/gu) ?? []).length >= 2;

  return !hasQuestionForm || isOverlongReview || hasMultipleReviewClauses;
}

function hasKoreanReviewMetadataPrefix(value: string): boolean {
  const text = value.trim();
  return /^(?:\d(?:\.\d)?\s+){1,2}[A-Za-z0-9_*.-]{2,}\s+20\d{2}[-.]\d{1,2}[-.]\d{1,2}\b/u.test(text)
    || /^(?:평점|별점)?\s*\d(?:\.\d)?\s*(?:\/\s*5)?\s+[A-Za-z0-9_*.-]{2,}\s+20\d{2}[-.]\d{1,2}[-.]\d{1,2}\b/u.test(text);
}

function hasKoreanFaqQuestionForm(value: string): boolean {
  return /(?:인가요|나요|까요|어떤가요|무엇인가요|맞나요|좋나요|괜찮나요|가능한가요|있나요|되나요|하나요|추천할\s*수\s*있나요|사용할\s*수\s*있나요)\s*[?？]?$/u.test(value);
}

function repairPositiveReviewFaqAnswer(question: string, answer: string, locale: PdpGeoLocale): string {
  if (!isPositiveReviewIntentFaqCandidate(question, answer, locale)) {
    return answer;
  }
  if (locale === "ko-KR" && isRawReviewLikeKoreanFaqQuestion(question)) {
    return createKoreanPositiveReviewFaqAnswer(question, answer);
  }
  return answer;
}

function repairPositiveReviewFaqItem(
  question: string,
  answer: string,
  locale: PdpGeoLocale
): { question: string; answer: string } | undefined {
  if (!isPositiveReviewIntentFaqCandidate(question, answer, locale)) {
    return undefined;
  }
  if (locale !== "ko-KR" || !isRawReviewLikeKoreanFaqQuestion(question)) {
    return undefined;
  }
  return {
    question: createKoreanPositiveReviewFaqQuestion(question, answer),
    answer: createKoreanPositiveReviewFaqAnswer(question, answer)
  };
}

function isPositiveReviewIntentFaqCandidate(question: string, answer: string, locale: PdpGeoLocale): boolean {
  if (locale !== "ko-KR") {
    return false;
  }
  const normalizedQuestion = normalizeKoreanRepairPhrase(question);
  const normalizedAnswer = normalizeKoreanRepairPhrase(answer);
  return isRawReviewLikeKoreanFaqQuestion(normalizedQuestion)
    && !isNegativeReviewSignalText(`${normalizedQuestion} ${normalizedAnswer}`);
}

function createKoreanPositiveReviewFaqQuestion(question: string, answer: string): string {
  const productName = extractKoreanProductNameFromFaqText(answer) ?? extractKoreanProductNameFromFaqText(question);
  return productName
    ? `고객 리뷰는 ${productName}의 어떤 사용감을 강조하나요?`
    : "고객 리뷰에서는 어떤 사용감이 반복되나요?";
}

function createKoreanPositiveReviewFaqAnswer(question: string, answer: string): string {
  const productName = extractKoreanProductNameFromFaqText(answer) ?? extractKoreanProductNameFromFaqText(question);
  const subject = productName ? appendKoreanTopicParticle(productName) : "제품은";
  const signals = extractKoreanPositiveReviewUseFeelSignals(`${question} ${answer}`);
  const signalPhrase = formatKoreanListForSentence((signals.length > 0 ? signals : ["긍정적 사용감"]).join(", "));
  return `${subject} 고객 리뷰 기준으로 ${signalPhrase} 같은 긍정적 사용감이 반복됩니다.`;
}

function extractKoreanPositiveReviewUseFeelSignals(value: string): string[] {
  const text = normalizeKoreanRepairPhrase(value);
  const signals = [
    /(?:뽀득거리지도|미끌거리지도|중간인\s*느낌)/u.test(text) ? "균형 잡힌 세정감" : undefined,
    /(?:크리미|거품)/u.test(text) ? "크리미한 사용감" : undefined,
    /(?:촉촉|수분|보습)/u.test(text) ? "세안 후 촉촉함" : undefined,
    /(?:당김\s*없|당김이\s*적|당기지)/u.test(text) ? "세안 후 당김이 적은 사용감" : undefined,
    /(?:데일리|무난)/u.test(text) ? "데일리 사용감" : undefined,
    /(?:순하|자극\s*없|자극없이|민감|건성)/u.test(text) ? "민감·건성 피부 사용 맥락" : undefined,
    /(?:흡수|흡수감)/u.test(text) ? "흡수감" : undefined,
    /(?:부드러)/u.test(text) ? "부드러운 사용감" : undefined
  ].filter((signal): signal is string => typeof signal === "string" && !isNegativeReviewSignalText(signal));
  return Array.from(new Set(signals)).slice(0, 3);
}

function extractKoreanProductNameFromFaqText(value: string): string | undefined {
  const text = normalizeKoreanRepairPhrase(value);
  const match = text.match(/([가-힣A-Za-z0-9·®™\s]{2,}?(?:클렌징폼|폼\s*클렌저|폼클렌저|클렌저|토너|크림|세럼|로션|앰플|에센스|선\s*크림|선크림|쿠션|마스크|팩|샴푸|바디워시|바디로션))(?:은|는|의|을|를|에서|,|\.|\s)/u);
  return match?.[1] ? normalizeKoreanRepairPhrase(match[1]) : undefined;
}

function isReviewBasedFaqItem(question: string, answer: string, locale: PdpGeoLocale): boolean {
  const normalizedQuestion = normalizeKoreanRepairPhrase(question);
  const normalizedAnswer = normalizeKoreanRepairPhrase(answer);
  const combined = `${normalizedQuestion} ${normalizedAnswer}`;
  if (locale === "ko-KR" && isRawReviewLikeKoreanFaqQuestion(normalizedQuestion)) {
    return isNegativeReviewSignalText(combined);
  }
  if (isExplicitReviewFaqQuestion(normalizedQuestion)) {
    return isNegativeReviewSignalText(normalizedAnswer);
  }
  if (isReviewOnlyFaqAnswer(normalizedAnswer) && !hasOfficialProductDetailFaqSignal(normalizedAnswer)) {
    return isNegativeReviewSignalText(normalizedAnswer);
  }
  return false;
}

function isExplicitReviewFaqQuestion(value: string): boolean {
  return /(?:고객\s*리뷰|리뷰|후기|평점|customer\s+reviews?|reviews?\s+(?:highlight|mention|describe)|what\s+do\s+customer\s+reviews|レビュー|口コミ)/iu.test(value);
}

function isReviewOnlyFaqAnswer(value: string): boolean {
  const text = value.trim();
  return /^(?:고객\s*리뷰|대표\s*고객\s*리뷰|리뷰에서는|후기에서는|Customer\s+reviews?|Reviews?|Representative\s+customer\s+reviews?|レビュー|口コミ)/iu.test(text)
    || /(?:고객\s*리뷰|리뷰|후기)\s*(?:표현|기준|에서는|의|에서)|review\s+language|customer\s+review\s+(?:context|language|signals?)/iu.test(text);
}

function hasOfficialProductDetailFaqSignal(value: string): boolean {
  return /(?:성분|기술|포뮬러|전성분|효능|효과|보습|장벽|진정|탄력|주름|미백|자외선|SPF|PA|인체\s*적용|임상|시험|테스트|사용\s*(?:직후|후)|\d+(?:\.\d+)?\s*(?:%|배|시간|일|주|명)|ingredient|formula|technology|benefit|effect|hydration|barrier|clinical|study|test|SPF|PA)/iu.test(value);
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
  return `제품의 성분/효능 정보와 상품 상세 정보를 기준으로 ${lowercaseKoreanSentenceStart(answer)}`;
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

const faqNonAnswerLeadPattern = /(확인하기\s*어렵|확인이\s*어렵|확인되지\s*않|확인할\s*수\s*없|알\s*수\s*없|알기\s*어렵|판단하기\s*어렵|정보만으로는|정보가\s*없|공개되지\s*않|미공개입니다|cannot\s+be\s+(?:confirmed|verified|determined)|is\s+unclear|is\s+not\s+(?:confirmed|specified|available)|no\s+information\s+is\s+available)/i;

/**
 * Public FAQ answers must lead with an answer, not a cannot-confirm
 * statement — answer engines cite standalone answer sentences, and a
 * non-answer lead poisons the whole Q/A as a citation unit.
 * Returns the repaired answer, or undefined when nothing substantive remains.
 */
function repairFaqNonAnswerLead(
  answer: string,
  warnings: string[],
  repairs: PdpGeoValidationRepair[],
  item: Record<string, unknown>
): string | undefined {
  const sentences = answer.split(/(?<=[.。!?？])\s+/).filter(Boolean);
  const lead = sentences[0];
  if (!lead || !faqNonAnswerLeadPattern.test(lead)) {
    return answer;
  }
  const remainder = sentences.slice(1).join(" ").trim();
  if (remainder.length < 20 || faqNonAnswerLeadPattern.test(remainder)) {
    return undefined;
  }
  addRepair(warnings, repairs, {
    field: "FAQPage.mainEntity.acceptedAnswer.text",
    source: "field-contract-validator",
    issue: "FAQ answer opened with a non-answer (cannot-confirm) sentence instead of a supported product fact.",
    action: "Removed the non-answer lead sentence so the answer starts with the citable supported fact.",
    before: answer,
    after: remainder,
    evidence: ["FAQPage.mainEntity.acceptedAnswer.text", "answer-ready FAQ contract"]
  }, "Non-answer FAQ lead sentence was removed during final sentence QA.");
  return remainder;
}

/** Fixes "?."/",." join artifacts without touching decimals or URLs. */
function normalizePunctuationArtifacts(value: string): string {
  return value
    .replace(/([?？!！])\s*\.(?=\s|$)/g, "$1")
    .replace(/,\s*\.\s*$/g, ".")
    .replace(/,\s*\.\s*/g, ", ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Dedupes short comma-separated list values such as "민감 피부, 건조 피부, 민감 피부". */
function dedupeCommaListValue(value: string): string {
  const parts = value.split(/,\s*/);
  if (parts.length < 3 || parts.some((part) => part.trim().length === 0 || part.trim().length > 24 || /[.!?。！？]/.test(part))) {
    return value;
  }
  const seen = new Set<string>();
  const deduped = parts.map((part) => part.trim()).filter((part) => {
    if (seen.has(part)) {
      return false;
    }
    seen.add(part);
    return true;
  });
  return deduped.length === parts.length ? value : deduped.join(", ");
}

function normalizePropertyValueText(
  value: string,
  name: string,
  warnings: string[],
  repairs: PdpGeoValidationRepair[]
): string {
  const next = normalizePunctuationArtifacts(dedupeCommaListValue(value));
  if (next !== value) {
    addRepair(warnings, repairs, {
      field: `Product.additionalProperty.${name}`,
      source: "sentence-qa",
      issue: "PropertyValue contained punctuation join artifacts or duplicated list items.",
      action: "Normalized punctuation and deduplicated the list items in the PropertyValue.",
      before: value,
      after: next,
      evidence: ["PropertyValue.value", "final sentence QA"]
    }, "PropertyValue text was normalized during final sentence QA.");
  }
  return next;
}

function isUsableImageUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url) && !/[.,;:]$/.test(url);
}

const koreanClauseConnectivePattern = /(되었고|되었으며|하였고|했고|이고),\s*/;

/**
 * Removes clauses that are fully redundant with an earlier clause in the same
 * sentence (e.g. "... 사용 7일 후 87.3% 회복되었고, 사용 7일 후 87.3% 회복되었습니다"),
 * then restores a terminal ending on the last kept clause.
 */
function dedupeRedundantMetricClausesWithRepair(
  value: string,
  field: string,
  warnings: string[],
  repairs: PdpGeoValidationRepair[]
): string {
  const sentenceDeduped = dedupeRepeatedPublicSentences(value);
  const next = sentenceDeduped
    .split(/(?<=[.。])\s+/)
    .map((sentence) => /[가-힣]/u.test(sentence) && /\d+(?:\.\d+)?\s*(?:%|％|배)/u.test(sentence)
      ? dedupeRedundantKoreanMetricClausesInSentence(sentence)
      : sentence)
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (next !== value) {
    addRepair(warnings, repairs, {
      field,
      source: "sentence-qa",
      issue: "Description repeated the same public sentence or measured-result clause more than once.",
      action: "Removed the redundant sentence/metric clause and restored the sentence ending.",
      before: value,
      after: next,
      evidence: [field, "final sentence QA"]
    }, "Duplicated metric clause was removed during final sentence QA.");
  }
  return next;
}

function dedupeRepeatedPublicSentences(value: string): string {
  const sentences = splitPublicSentences(value);
  if (sentences.length < 2) {
    return value;
  }
  const seen = new Set<string>();
  const kept = sentences.filter((sentence) => {
    const key = sentence
      .replace(/^㈜/u, "(주)")
      .toLocaleLowerCase()
      .replace(/[.!?。！？]+$/u, "")
      .replace(/\s+/gu, " ")
      .trim();
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  return kept.length === sentences.length ? value : kept.join(" ");
}

function dedupeRedundantKoreanMetricClausesInSentence(sentence: string): string {
  if (!/\d+(?:\.\d+)?\s*(?:%|％|배)/u.test(sentence) || !koreanClauseConnectivePattern.test(sentence)) {
    return sentence;
  }
  const trailing = sentence.match(/[.。]$/)?.[0] ?? "";
  const body = trailing ? sentence.slice(0, -trailing.length) : sentence;
  const parts = body.split(/(되었고|되었으며|하였고|했고|이고),\s*/);
  if (parts.length < 3) {
    return sentence;
  }
  const clauses: Array<{ text: string; connective?: string }> = [];
  for (let index = 0; index < parts.length; index += 2) {
    clauses.push({ text: parts[index] ?? "", connective: parts[index + 1] });
  }
  const kept: Array<{ text: string; connective?: string }> = [];
  const tokenSets: Array<Set<string>> = [];
  for (const clause of clauses) {
    const tokens = koreanClauseCoreTokens(clause.text);
    if (tokens.size > 0 && tokenSets.some((previous) => isTokenSubset(tokens, previous))) {
      continue;
    }
    kept.push(clause);
    tokenSets.push(tokens);
  }
  if (kept.length === clauses.length) {
    return sentence;
  }
  const rejoined = kept.map((clause, index) => {
    if (index < kept.length - 1) {
      return `${clause.text}${clause.connective ?? ""}, `;
    }
    return clause.connective ? `${clause.text}${terminalKoreanEnding(clause.connective)}` : clause.text;
  }).join("");
  return `${rejoined}${trailing || "."}`;
}

function koreanClauseCoreTokens(text: string): Set<string> {
  const tokens = text.match(/\d+(?:\.\d+)?\s*(?:%|％|배)|\d+[가-힣]+|[가-힣]{2,}|[A-Za-z]{3,}/g) ?? [];
  return new Set(tokens
    .map((token) => token.replace(/\s+/g, "").replace(/(되었습니다|되었고|되었으며|하였습니다|했습니다|합니다|됩니다|입니다)$/u, ""))
    .filter((token) => token.length > 0));
}

function isTokenSubset(candidate: Set<string>, reference: Set<string>): boolean {
  for (const token of candidate) {
    if (!reference.has(token)) {
      return false;
    }
  }
  return true;
}

function terminalKoreanEnding(connective: string): string {
  switch (connective) {
    case "되었고":
    case "되었으며":
      return "되었습니다";
    case "하였고":
      return "하였습니다";
    case "했고":
      return "했습니다";
    case "이고":
      return "입니다";
    default:
      return connective;
  }
}

function pruneInvalidSchemaText(
  node: Record<string, unknown>,
  locale: PdpGeoLocale,
  warnings: string[],
  repairs: PdpGeoValidationRepair[]
): Record<string, unknown> {
  if (node["@type"] === "Product" && Array.isArray(node.image)) {
    const originalImages = node.image;
    const filteredImages = originalImages.filter((image) => typeof image !== "string" || isUsableImageUrl(image));
    if (filteredImages.length !== originalImages.length) {
      addRepair(warnings, repairs, {
        field: "Product.image",
        source: "schema-validator",
        issue: "Product.image contained malformed or truncated image URLs.",
        action: "Removed malformed image URLs from Product.image.",
        before: toJsonValue(originalImages.filter((image) => typeof image === "string" && !isUsableImageUrl(image))),
        after: null,
        evidence: ["Product.image", "URL syntax check"]
      }, "Malformed Product.image URL was removed during schema validation.");
      node.image = filteredImages;
    }
  }

  if (node["@type"] === "Product" && Array.isArray(node.additionalProperty)) {
    node.additionalProperty = node.additionalProperty.filter(isRecord).flatMap((item) => {
      const rawName = stringValue(item.name);
      const rawValue = stringValue(item.value);
      const nameRepair = rawName ? repairPropertyValueName(rawName, node, locale) : undefined;
      const name = nameRepair?.name ?? rawName;
      const propertyID = nameRepair?.propertyID ?? stringValue(item.propertyID);
      const contractValue = name === "Usage" && rawValue
        ? repairUsagePropertyValue(rawValue, locale)
        : name === "Functional certification" && rawValue
          ? repairFunctionalCertificationPropertyValue(rawValue, locale)
          : rawValue;
      const value = contractValue && name
        ? normalizePropertyValueText(contractValue, name, warnings, repairs)
        : contractValue;
      if (rawName && nameRepair) {
        addRepair(warnings, repairs, {
          field: "Product.additionalProperty.name",
          source: "field-contract-validator",
          issue: nameRepair.issue,
          action: "Replaced the free-form PropertyValue.name with a stable property name and schema.org propertyID while keeping the customer situation or question in the value.",
          before: toJsonValue(item),
          after: toJsonValue({
            ...item,
            name: nameRepair.name,
            propertyID: nameRepair.propertyID,
            value
          }),
          evidence: ["schema.org PropertyValue.name", "Product.additionalProperty field contract", locale]
        }, "Question-like or situation-like PropertyValue.name was normalized to a stable property label.");
      }
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
      if (name === "Functional certification" && rawValue && value && value !== rawValue) {
        addRepair(warnings, repairs, {
          field: "Product.additionalProperty.Functional certification",
          source: "field-contract-validator",
          issue: "Functional certification PropertyValue mixed certification facts with OCR benefit fragments.",
          action: "Kept only atomic certification or test-completion facts in Functional certification.",
          before: rawValue,
          after: value,
          evidence: ["Product.additionalProperty.Functional certification", "public certification field contract", locale]
        }, "Functional certification PropertyValue was reduced to public certification facts.");
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
        ...(propertyID ? { propertyID } : {}),
        value
      }];
    });
  }

  if (node["@type"] === "Product" && isRecord(node.positiveNotes) && Array.isArray(node.positiveNotes.itemListElement)) {
    const items = node.positiveNotes.itemListElement.filter(isRecord).flatMap((item) => {
      const name = stringValue(item.name);
      if (!name || hasTruncationMarker(name) || isBrokenGeneratedFragment(name) || isLowQualityPositiveNoteName(name, locale)) {
        addRepair(warnings, repairs, {
          field: "Product.positiveNotes.itemListElement",
          source: "sentence-qa",
          issue: "positiveNotes item was blank, truncated, duplicated wording, or contained broken generated fragments.",
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

function repairPropertyValueName(
  name: string,
  product: Record<string, unknown>,
  locale: PdpGeoLocale
): PropertyValueNameRepair | undefined {
  const text = name.replace(/\s+/g, " ").trim();
  if (!text || isStablePropertyValueName(text)) {
    return undefined;
  }
  if (isPropertyValueQuestionName(text, locale)) {
    const direct = isDirectProductPropertyValueQuestion(text, product);
    return {
      name: direct ? "Direct product question" : "Indirect customer question",
      propertyID: direct ? "directProductQuestion" : "indirectCustomerQuestion",
      issue: "PropertyValue.name contained a full customer question instead of the name of a product property."
    };
  }
  if (isCustomerSituationPropertyValueName(text, locale)) {
    return {
      name: "Review-derived recommendation context",
      propertyID: "reviewDerivedRecommendationContext",
      issue: "PropertyValue.name contained a customer situation/search-intent phrase instead of the name of a product property."
    };
  }
  return undefined;
}

function isStablePropertyValueName(name: string): boolean {
  return /^(?:Target customer|Target concern|Customer situation|Recommended use case|Recommended skin type|Key benefit|Key efficacy|Key ingredients|Key ingredients and technologies|Ingredient\/effect detail|Functional certification|Texture and finish|Brand science|Usage|Routine synergy|Customer review context|Review-derived recommendation context|Indirect customer question|Direct product question|Consumer satisfaction|Reported details|Clinical result summary|Variant comparison|Renewal guidance|Gift suitability|Options)$/i.test(name);
}

function isPropertyValueQuestionName(name: string, locale: PdpGeoLocale): boolean {
  return isQuestionLike(name, locale)
    || /^(?:what|which|how|why|when|who|can|should|does|do|is|are)\b.+\?$/i.test(name)
    || /(?:무엇|어떤|어떻게|왜|누구|사용감|효능|성분|제품|선택하면\s+좋나요|추천할\s+수\s+있나요)[^.!。！？]*[?？]$/u.test(name)
    || /(?:どの|何|なぜ|どのよう|おすすめ|選べば|ですか|ますか)[^.!。！？]*[?？]$/u.test(name);
}

function isCustomerSituationPropertyValueName(name: string, locale: PdpGeoLocale): boolean {
  const englishSituation = /^when\s+.{8,120}$/i.test(name)
    || /^(?:if|for)\s+.{8,120}\b(?:skin|shoppers?|customers?|routine|gift|concern|dryness|texture|firmness|sensitivity)\b/i.test(name);
  if (englishSituation) {
    return true;
  }
  if (locale === "ko-KR" || /[가-힣]/u.test(name)) {
    return /(?:^|[\s,])(?:피부|고객|매일|가족|지인|선물|탄력|주름|건조|당김|윤기|광채|피부결|화장|민감|예민)[^.!?。！？]{2,80}(?:때|경우)$/u.test(name)
      || /(?:신경\s*쓰이기\s*시작할\s*때|필요할\s*때|느껴질\s*때|찾을\s*때)$/u.test(name);
  }
  return false;
}

function isDirectProductPropertyValueQuestion(name: string, product: Record<string, unknown>): boolean {
  return collectProductEntityNames(product).some((entity) => containsNormalizedEntity(name, entity));
}

function collectProductEntityNames(product: Record<string, unknown>): string[] {
  const brand = isRecord(product.brand) ? stringValue(product.brand.name) : stringValue(product.brand);
  return uniqueValidationText([
    stringValue(product.name),
    stringValue(product.alternateName),
    brand
  ].filter((value): value is string => Boolean(value)));
}

function containsNormalizedEntity(text: string, entity: string): boolean {
  const haystack = normalizePropertyValueEntityKey(text);
  const needle = normalizePropertyValueEntityKey(entity);
  return needle.length >= 3 && haystack.includes(needle);
}

function normalizePropertyValueEntityKey(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function isInvalidPropertyValue(name: string, value: string, locale: PdpGeoLocale): boolean {
  if (hasUrlOrImageArtifact(value) || hasTruncationMarker(value) || isBrokenGeneratedFragment(value)) {
    return true;
  }
  if (/^Functional certification$/i.test(name) && isLowQualityFunctionalCertificationValue(value, locale)) {
    return true;
  }
  if (/reported details/i.test(name)) {
    return isQuestionLike(value, locale)
      || !hasContextualReportedPropertyValue(value)
      || (value.match(/(?:확인\s*지표|확인\s*근거|reported\s*result)\s*:/gi) ?? []).length > 1;
  }
  if (/^key ingredients$/i.test(name)) {
    return value.split(",").some((item) => {
      const token = item.trim();
      return token.length === 0
        || token.length > 90
        || hasTruncationMarker(token)
        || isQuestionLike(token, locale)
        || /[.。！？?]/.test(token)
        || /(설계|자극|고객님|리뉴얼 전 제품|property value)/i.test(token)
        || isIngredientAttributePropertyToken(token);
    });
  }
  return false;
}

function hasContextualReportedPropertyValue(value: string): boolean {
  const text = value.replace(/\s+/g, " ").trim();
  if (/^(?:확인\s*지표|확인\s*근거|측정\s*결과|시험\s*결과|reported\s*result)?\s*:?\s*[+\-−]?\d+(?:[.,]\d+)?\s*(?:%|％|배|시간|일|주|weeks?|days?|hours?)[.!。]?$/iu.test(text)) {
    return false;
  }
  const hasMetricAndSubject = /(?:%|％|\d+(?:\.\d+)?\s*배|\d+(?:\.\d+)?\s*(?:시간|일|주|weeks?|days?|hours?))/iu.test(text)
    && /(?:잔존|보습|수분|장벽|피부|탄력|주름|피부결|진정|회복|개선|감소|증가|상승|향상|완화|지속|도달|사용|도포|세정|시험|테스트|평가|대상|참여자|리뷰|평점|비교|대비|ex\s*vivo|clinical|study|test|assessment|participant|user|review|rating|retention|hydration|moisture|barrier|wrinkle|firmness|improv|increase|decrease|after|versus|\bvs\.?\b)/iu.test(text);
  const hasEvidenceContext = /(?:인체\s*적용|자가\s*평가|소비자\s*평가|시험|테스트|측정|평가|임상|in\s*vitro|ex\s*vivo|clinical|study|test|assessment|instrumental|survey|home\s+usage|\d+\s*명|\d+\s*(?:women|men|users?|subjects?|participants?)|대상|참여자|사용자|표본|sample|participants?|subjects?|사용\s*(?:직후|전|후)|도포\s*(?:직후|전|후)|\d+(?:\.\d+)?\s*(?:시간|일|주|개월|weeks?|days?|hours?|months?)\s*(?:후|동안)?|비교|대비|versus|\bvs\.?\b|(?:before|after)\s+(?:use|application)|after\s+\d)/iu.test(text);
  return hasMetricAndSubject && hasEvidenceContext;
}

function isIngredientAttributePropertyToken(value: string): boolean {
  return /^(?:흡수력|유지력|지속력|보습력|전달력|침투력|밀착력|발림성|사용감|안정성|수분감|피부결|유분\s*컨트롤|피부\s*장벽|피부장벽|장벽보습|민감\s*피부|민감피부|건조\s*피부|견고한\s*구조|잔존\s*효과|보습\s*캡슐|캡슐\s*제형|비캡슐|연구|효능|효과|개선|완화|진정|absorption|absorbency|retention|persistence|delivery|penetration|spreadability|texture|finish|efficacy|effect|benefit|hydration|moisture|skin\s*barrier|sensitive\s*skin|dry\s*skin|oil\s*control|吸収力|持続力|使用感|保湿力|肌バリア|敏感肌|乾燥肌|効果|効能)$/iu.test(value.trim());
}

function repairFunctionalCertificationPropertyValue(value: string, locale: PdpGeoLocale): string {
  if (locale !== "ko-KR") {
    return value;
  }
  const text = value.replace(/\s+/g, " ").trim();
  const signals = [
    /극민감\s*(?:피부\s*)?테스트\s*완료/u.test(text) ? "극민감 피부 테스트 완료" : undefined,
    /민감\s*피부\s*(?:대상\s*)?(?:피부\s*)?자극\s*테스트\s*완료/u.test(text) ? "민감 피부 자극 테스트 완료" : undefined,
    /피부과\s*테스트\s*완료/u.test(text) ? "피부과 테스트 완료" : undefined,
    /여드름성\s*피부\s*사용\s*적합\s*테스트\s*완료/u.test(text) ? "여드름성 피부 사용 적합 테스트 완료" : undefined,
    /알러지\s*테스트\s*완료/u.test(text) ? "알러지 테스트 완료" : undefined,
    /인체\s*안자극\s*테스트\s*완료/u.test(text) ? "인체 안자극 테스트 완료" : undefined,
    /소아과\s*피부\s*테스트\s*완료/u.test(text) ? "소아과 피부 테스트 완료" : undefined,
    /민감\s*성?\s*피부\s*사용\s*적합\s*테스트\s*완료/u.test(text) ? "민감성 피부 사용 적합 테스트 완료" : undefined,
    /민감\s*피부\s*대상\s*사용성\s*테스트\s*완료/u.test(text) ? "민감 피부 대상 사용성 테스트 완료" : undefined,
    /민감\s*피부\s*대상\s*피부\s*자극\s*테스트\s*완료/u.test(text) ? "민감 피부 대상 피부 자극 테스트 완료" : undefined,
    !/민감\s*피부\s*(?:대상\s*)?(?:피부\s*)?자극\s*테스트\s*완료/u.test(text)
      && /피부\s*자극\s*테스트\s*완료/u.test(text) ? "피부 자극 테스트 완료" : undefined,
    /저자극\s*테스트\s*완료/u.test(text) ? "저자극 테스트 완료" : undefined,
    /안\s*자극\s*대체\s*시험\s*완료/u.test(text) ? "안자극 대체 시험 완료" : undefined,
    /하이포\s*알러지\s*테스트\s*완료/u.test(text) || /하이포알러지\s*테스트\s*완료/u.test(text) ? "하이포알러지 테스트 완료" : undefined,
    /논코메도제닉\s*테스트\s*완료/u.test(text) ? "논코메도제닉 테스트 완료" : undefined
  ].filter((item): item is string => Boolean(item));

  return uniqueValidationText(signals).join(", ") || value;
}

function isLowQualityFunctionalCertificationValue(value: string, locale: PdpGeoLocale): boolean {
  const text = value.replace(/\s+/g, " ").trim();
  if (locale === "ko-KR" && /(?:효와|피부\s*장벽\s*강화|피부\s*보습|피부\s*진정|성분으로|효능어|추천\s*대상)/u.test(text)) {
    return true;
  }
  return text.length > 180 || isRawMetricEvidenceText(text);
}

function isLowQualityPositiveNoteName(value: string, locale: PdpGeoLocale): boolean {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length > 90 || isQuestionLike(text, locale)) {
    return true;
  }
  if (locale === "ko-KR" && /(?:케어\s*케어|성분으로|효능어|성분어|기반\s+.+\s+기반|,\s*[^,]+,\s*[^,]+)/u.test(text)) {
    return true;
  }
  return false;
}

function uniqueValidationText(values: string[]): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const value of values) {
    const key = value.replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(key);
  }
  return results;
}

function repairGeneratedText(
  value: string,
  locale: PdpGeoLocale,
  path: string,
  warnings: string[],
  repairs: PdpGeoValidationRepair[]
): string {
  let next = value
    .replace(/^(?:(?:-{1,2}|=)>|→|⇒|➜|➔)\s*/u, "")
    .replace(/\\"/g, "\"")
    .replace(/\\[rn]/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/([?\uff1f!\uff01])\s*\.(?=\s|$)/g, "$1")
    .replace(/,\s*\.\s*$/g, ".")
    .replace(/,\s*\.\s*/g, ", ")
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
    next = next
      .replace(/(들어가|함유되어|포함되어|배합되어|담겨|기재되어|표기되어)\s*(있는|없는)/gu, "$1 $2")
      .replace(/떠\s*있은/g, "떠 있는")
      .replace(/떠\s*있어야/g, "떠 있어야")
      .replace(/떠\s*있는\s+것이/g, "떠 있는 것이");
    next = repairKoreanReviewQuoteFragments(next);
    next = repairKoreanEvidenceFragments(next, path);
    next = repairKoreanSentenceQuality(next);
    next = repairKoreanParticles(next);
    if (isShortKoreanLabelValue(path, next)) {
      next = stripTrailingKoreanObjectParticle(next);
	    }
	    next = repairKoreanAwkwardSpacing(next);
	    next = repairKoreanScientificTestWording(next);
	    next = repairKoreanPublicEvidencePresentationWording(next, path);
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
  let next = stripLeadingKoreanUsageParticle(stripLeadingUsageStepMarkers(stripLeadingUsageMeasurementLabels(value)));
  const cueIndex = usageRepairCueIndex(next);
  if (cueIndex > 0 && shouldRepairUsageFromCue(next.slice(0, cueIndex))) {
    next = next.slice(cueIndex).trim();
  }

  return normalizeKoreanHowToInstructionText(stripLeadingKoreanUsageParticle(stripLeadingUsageStepMarkers(next
    .replace(/^\d+[.)]?\s+/, "")
    .replace(/^(?:[\p{L}\p{N}™®().,'\s-]{0,100})?(?:사용\s*방법|사용법)\s*\d*[:.]?\s*/iu, "")
    .replace(/^(?:[\p{L}\p{N}™®().,'\s-]{0,100})?(?:how\s*to\s*use|directions?)\s*\d*[:.]?\s*/iu, "")
    .replace(usageMeasurementLeadPattern(), "")
    .replace(/([가-힣])\s*[.。]\s*(?=(?:두드려|흡수|펴\s*바르|펴\s*발라|마사지|문지르|헹구|닦아))/gu, "$1 ")
    .replace(/\s+\d+\s+(?=(?:미온수|물|깨끗|충분|헹구|다음|이후))/gu, " ")
    .replace(/\s+/g, " ")
    .trim())));
}

function splitHowToStepUsageText(value: string, locale: PdpGeoLocale): string[] {
  const normalized = repairHowToStepUsageText(value);
  if (locale !== "ko-KR") {
    return [normalized];
  }
  const split = splitKoreanCompoundHowToStep(normalized);
  return split.length > 0 ? split : [normalized];
}

function splitKoreanCompoundHowToStep(value: string): string[] {
  const text = normalizeKoreanHowToInstructionText(value)
    .replace(/[.。]+$/u, "")
    .replace(/\s+\d+\s+(?=(?:미온수|물|깨끗|충분|헹구|다음|이후))/gu, " ")
    .trim();
  const signatures = koreanHowToActionSignatures(text);
  const splitSignatures = signatures.filter((signature) => signature !== "dispense");
  if (splitSignatures.length <= 1) {
    return [text];
  }
  if (!splitSignatures.includes("foam") && !splitSignatures.includes("rinse")) {
    return [text];
  }

  const steps: string[] = [];
  const foam = createKoreanFoamHowToStep(text);
  const massage = createKoreanMassageHowToStep(text);
  const rinse = createKoreanRinseHowToStep(text);
  const wipe = createKoreanWipeHowToStep(text);
  const apply = createKoreanApplyHowToStep(text);
  const absorb = createKoreanAbsorbHowToStep(text);

  if (foam) {
    steps.push(foam);
  }
  if (massage) {
    steps.push(massage);
  }
  if (rinse) {
    steps.push(rinse);
  }
  if (wipe) {
    steps.push(wipe);
  }
  if (apply) {
    steps.push(apply);
  }
  if (absorb) {
    steps.push(absorb);
  }

  return dedupeUsagePropertySteps(steps).filter((step) => step.length >= 6);
}

function koreanHowToActionSignatures(value: string): string[] {
  const text = value.trim();
  return [
    /(?:덜어|취해|펌핑|적당량의?\s*(?:내용물|제품)?)/u.test(text) ? "dispense" : undefined,
    /거품/u.test(text) ? "foam" : undefined,
    /(?:마사지|문지르)/u.test(text) ? "massage" : undefined,
    /(?:미온수|헹구)/u.test(text) ? "rinse" : undefined,
    /(?:화장솜|닦아?내|닦아냅|피부결을\s*따라\s*닦)/u.test(text) ? "wipe" : undefined,
    /(?:펴\s*바르|펴\s*발라|바릅|바른\s*(?:뒤|후)|도포)/u.test(text) ? "apply" : undefined,
    /(?:흡수|두드려|톡톡)/u.test(text) ? "absorb" : undefined
  ].filter((signature): signature is string => Boolean(signature));
}

function findRedundantKoreanCompoundHowToStepIndexes(values: string[], locale: PdpGeoLocale): Set<number> {
  if (locale !== "ko-KR") {
    return new Set();
  }
  const signaturesByIndex = values.map((value) => koreanHowToActionSignatures(value));
  const redundant = new Set<number>();

  signaturesByIndex.forEach((signatures, index) => {
    if (signatures.length < 3) {
      return;
    }
    const covered = new Set<string>();
    let coveringStepCount = 0;
    signaturesByIndex.forEach((otherSignatures, otherIndex) => {
      if (otherIndex === index || otherSignatures.length === 0 || otherSignatures.length >= signatures.length) {
        return;
      }
      if (!otherSignatures.every((signature) => signatures.includes(signature))) {
        return;
      }
      coveringStepCount += 1;
      otherSignatures.forEach((signature) => covered.add(signature));
    });
    if (coveringStepCount >= 2 && signatures.every((signature) => covered.has(signature))) {
      redundant.add(index);
    }
  });

  return redundant;
}

function createKoreanFoamHowToStep(value: string): string | undefined {
  if (!/거품/u.test(value)) {
    return undefined;
  }
  const amount = /적당량/u.test(value) ? "적당량을 " : "";
  const dispense = /덜어/u.test(value) ? "덜어 " : "";
  const water = /물과\s*함께/u.test(value) ? "물과 함께 " : "";
  return normalizeKoreanHowToInstructionText(`${amount}${dispense}${water}거품을 냅니다`);
}

function createKoreanMassageHowToStep(value: string): string | undefined {
  if (!/(?:마사지|문지르)/u.test(value)) {
    return undefined;
  }
  if (/문지르/u.test(value)) {
    return /마사지/u.test(value) ? "얼굴에 마사지하듯 문지릅니다" : "얼굴에 부드럽게 문지릅니다";
  }
  return /부드럽/u.test(value) ? "얼굴에 부드럽게 마사지합니다" : "얼굴에 마사지합니다";
}

function createKoreanRinseHowToStep(value: string): string | undefined {
  if (!/(?:미온수|헹구)/u.test(value)) {
    return undefined;
  }
  const water = /미온수/u.test(value) ? "미온수로" : "물로";
  const clean = /깨끗하게/u.test(value) ? " 깨끗하게" : /깨끗이/u.test(value) ? " 깨끗이" : "";
  if (/마무리/u.test(value)) {
    return `${water}${clean} 헹구어 마무리해 주세요`;
  }
  return `${water}${clean} 헹굽니다`;
}

function createKoreanWipeHowToStep(value: string): string | undefined {
  if (!/(?:화장솜|닦아?내|닦아냅|피부결을\s*따라\s*닦)/u.test(value)) {
    return undefined;
  }
  const amount = /적당량/u.test(value) ? "적당량을 덜어 " : "";
  const cotton = /화장솜/u.test(value) ? "화장솜에 " : "";
  const texture = /피부결/u.test(value) ? "피부결을 따라 " : "";
  const gentle = /부드럽/u.test(value) ? "부드럽게 " : "";
  return normalizeKoreanHowToInstructionText(`${cotton}${amount}${texture}${gentle}닦아냅니다`);
}

function createKoreanApplyHowToStep(value: string): string | undefined {
  if (!/(?:펴\s*바르|펴\s*발라|바릅|바른\s*(?:뒤|후)|도포)/u.test(value)) {
    return undefined;
  }
  const palm = /손바닥|손에/u.test(value) ? "손바닥에 덜어 " : "";
  const texture = /피부결/u.test(value) ? "피부결을 따라 " : "";
  const gentle = /부드럽/u.test(value) ? "부드럽게 " : "";
  return normalizeKoreanHowToInstructionText(`${palm}${texture}${gentle}펴 바릅니다`);
}

function createKoreanAbsorbHowToStep(value: string): string | undefined {
  if (!/(?:흡수|두드려|톡톡)/u.test(value)) {
    return undefined;
  }
  const tap = /톡톡|두드/u.test(value) ? "가볍게 두드려 " : "";
  return normalizeKoreanHowToInstructionText(`${tap}흡수시켜 줍니다`);
}

function createValidatedHowToStepName(locale: PdpGeoLocale, position: number): string {
  if (locale === "ko-KR") {
    return `${position}단계`;
  }
  if (locale === "ja-JP") {
    return `${position}段階`;
  }
  return `Step ${position}`;
}

function stripLeadingKoreanUsageParticle(value: string): string {
  return value
    .trim()
    .replace(/^(?:은|는|이|가|을|를|의)\s+(?=(?:아침|저녁|매일|데일리|세안|화장솜|손바닥|손에|적당량|얼굴|피부|피부결|토너|제품|내용물|양손|물과|미온수))/u, "")
    .trim();
}

function howToStepDedupeKey(value: string): string {
  return usagePropertyStepKey(normalizeHowToStepSurfaceForDedupe(value));
}

function koreanHowToSemanticDedupeKey(value: string): string | undefined {
  if (!/[가-힣]/.test(value)) {
    return undefined;
  }
  const signatures = koreanHowToActionSignatures(value);
  if (signatures.length === 1) {
    const signature = signatures[0];
    if (signature !== "dispense" && signature !== "foam" && signature !== "massage" && signature !== "rinse" && signature !== "wipe") {
      return undefined;
    }
    return `ko-action:${signature}`;
  }
  if (signatures.includes("foam") && signatures.every((signature) => signature === "dispense" || signature === "foam")) {
    return "ko-action:foam";
  }
  const signatureKey = signatures.join("+");
  if (signatureKey === "apply+absorb" || signatureKey === "dispense+apply+absorb") {
    return `ko-actions:${signatureKey}`;
  }
  return undefined;
}

function normalizeHowToStepSurfaceForDedupe(value: string): string {
  return normalizeKoreanHowToInstructionText(stripLeadingKoreanUsageParticle(value))
    .replace(/닦아내는\s*방식입니다$/u, "닦아냅니다")
    .replace(/닦아내는\s*방법입니다$/u, "닦아냅니다")
    .replace(/흡수시켜\s*줍니다$/u, "흡수시켜 줍니다")
    .replace(/흡수시키는\s*방식입니다$/u, "흡수시켜 줍니다")
    .replace(/흡수시키는\s*방법입니다$/u, "흡수시켜 줍니다")
    .replace(/헹구어\s*냅니다$/u, "헹굽니다")
    .replace(/헹구어\s*마무리해\s*주세요$/u, "헹굽니다")
    .replace(/바르는\s*방식입니다$/u, "바릅니다")
    .replace(/바르는\s*방법입니다$/u, "바릅니다")
    .replace(/사용하는\s*방식입니다$/u, "사용합니다")
    .replace(/사용하는\s*방법입니다$/u, "사용합니다")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeKoreanHowToInstructionText(value: string): string {
  return value
    .replace(/거품\s*내어\s*(?:줍니다|주세요)$/u, "거품을 냅니다")
    .replace(/거품을\s*내어\s*(?:줍니다|주세요)$/u, "거품을 냅니다")
    .replace(/거품\s*내\s*(?:줍니다|주세요)$/u, "거품을 냅니다")
    .replace(/거품을\s*내\s*(?:줍니다|주세요)$/u, "거품을 냅니다")
    .replace(/거품\s*내어$/u, "거품을 냅니다")
    .replace(/거품\s*낸다$/u, "거품을 냅니다")
    .replace(/거품을\s*낸다$/u, "거품을 냅니다")
    .replace(/거품을\s*낸(?:\s*(?:뒤|후|다음))?$/u, "거품을 냅니다")
    .replace(/마사지한다$/u, "마사지합니다")
    .replace(/마사지하고$/u, "마사지합니다")
    .replace(/문지른\s*후$/u, "문지릅니다")
    .replace(/문지른다$/u, "문지릅니다")
    .replace(/헹구는\s*방식(?:이다|입니다)$/u, "헹굽니다")
    .replace(/헹구어\s*낸다$/u, "헹구어 냅니다")
    .replace(/헹구어\s*냅니다$/u, "헹구어 냅니다")
    .replace(/닦아내는\s*것(?:이다|입니다)$/u, "닦아냅니다")
    .replace(/닦아낸다$/u, "닦아냅니다")
    .replace(/흡수시켜\s*줍니다$/u, "흡수시켜 줍니다")
    .replace(/흡수시키는\s*것(?:이다|입니다)$/u, "흡수시켜 줍니다")
    .replace(/흡수시킨다$/u, "흡수시켜 줍니다")
    .replace(/펴\s*바르는\s*것(?:이다|입니다)$/u, "펴 바릅니다")
    .replace(/펴\s*바른다$/u, "펴 바릅니다")
    .replace(/펴\s*발라\s*줍니다$/u, "펴 바릅니다")
    .replace(/펴\s*발라줍니다$/u, "펴 바릅니다")
    .replace(/바르는\s*것(?:이다|입니다)$/u, "바릅니다")
    .replace(/바른다$/u, "바릅니다")
    .replace(/\s+/g, " ")
    .trim();
}

function repairUsagePropertyValue(value: string, locale: PdpGeoLocale): string {
  const steps = dedupeUsagePropertySteps(value
    .split(/\s*;\s*/)
    .flatMap((part) => part.split(/\n+/))
    .map((part) => repairHowToStepUsageText(part))
    .map((part) => part.replace(/[.。]+$/g, "").trim())
    .filter((part) => part.length >= 8 && isActionableUsageText(part)));

  if (steps.length === 0) {
    return "";
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
  const normalized = normalizeHowToStepSurfaceForDedupe(stripLeadingUsageStepMarkers(value));
  const semanticKey = koreanHowToSemanticDedupeKey(normalized);
  if (semanticKey) {
    return semanticKey;
  }
  return normalized
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\b(?:the|a|an|your|this|it|of|serum|cream|toner|product)\b/g, " ")
    .replace(/(?:합니다|하세요|해\s*주세요|해줍니다|줍니다|입니다|다)$/u, "")
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

function repairKoreanPublicEvidencePresentationWording(value: string, path: string): string {
  if (!shouldRepairKoreanPublicEvidencePresentationPath(path) || !/[가-힣]/.test(value) || !hasKoreanQuantifiedReportedSignal(value) || !/(?:제시(?:됩니다|되었습니다|되며|합니다)|나타났습니다)/u.test(value)) {
    return value;
  }

  const sentences = splitPublicSentences(value);
  if (sentences.length === 0) {
    return repairKoreanPublicEvidencePresentationSentence(value);
  }
  return sentences
    .map(repairKoreanPublicEvidencePresentationSentence)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function shouldRepairKoreanPublicEvidencePresentationPath(path: string): boolean {
  if (/acceptedAnswer\.text|content\.sections\.faq|HowTo\.step\.text|step\.\d+\.text/u.test(path)) {
    return false;
  }
  return /(?:description|additionalProperty|positiveNotes|reviewBody|content\.sections\.(?:description|quickFacts|benefits)|value)$/u.test(path)
    || path === "fallbackDescription";
}

function repairKoreanPublicEvidencePresentationSentence(value: string): string {
  if (!hasKoreanQuantifiedReportedSignal(value) || !/(?:제시(?:됩니다|되었습니다|되며|합니다)|나타났습니다)/u.test(value)) {
    return value;
  }
  const text = normalizeKoreanEvidenceResultValue(value);
  const naturalSentence = formatKoreanEvidenceResultSentence(text);
  return naturalSentence ? `${naturalSentence}.` : value;
}

function repairKoreanSentenceQuality(value: string): string {
  return repairKoreanMetaNarrationFrames(value)
    .replace(/설명된다\s+사용법을\s+다룹니다/g, "설명됩니다")
    .replace(/설명됩니다\s+사용법을\s+다룹니다/g, "설명됩니다")
    .replace(/제시된다\s+사용법을\s+다룹니다/g, "설명됩니다")
    .replace(/제시됩니다\s+사용법을\s+다룹니다/g, "설명됩니다")
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
    if (/(?:효과|결과|성과|피부과|소아과|치과|안과|외과|내과|학과|사과)$/u.test(match)) {
      return match;
    }
    if (word.length <= 1 && /[은는이가]/.test(particle)) {
      return match;
    }
    if (/(?:있|없|하|되|같|싶)$/u.test(word) && /[은는]/u.test(particle)) {
      return match;
    }
    if (!isKoreanDomainNounForParticleRepair(word)) {
      return match;
    }
    const replacement = chooseKoreanParticle(word, particle);
    return replacement ? `${word}${replacement}` : match;
  });
}

function isKoreanDomainNounForParticleRepair(value: string): boolean {
  return /(?:수분감|사용감|보습력|흡수력|유지력|피부결|피부\s*장벽|장벽|수분|보습|효능|효과|성분|기술|제품|상품|크림|세럼|토너|로션|앰플|에센스|클렌저|고객|피부|루틴|단계|결과|내용|특징|기준|관리|탄력|진정|주름|광채|윤기|길이|사계절)$/u.test(value);
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
    .replace(/민감피부/g, "민감 피부")
    .replace(/건조피부/g, "건조 피부")
    .replace(/\s+([,.)\]}>])/g, "$1")
    .replace(/([([{<])\s+/g, "$1");
}

function repairKoreanScientificTestWording(value: string): string {
  return value.replace(/([가-힣0-9\s]{2,120}?)\s+([A-Za-z][A-Za-z\s-]{1,40})\s*테스트\s*결과\s*(\d+(?:\.\d+)?\s*%)/gu, (_match, subject: string, method: string, metric: string) => {
    const cleanSubject = subject.replace(/\s+/g, " ").trim();
    const cleanMethod = method.replace(/\s+/g, " ").trim();
    return cleanSubject && cleanMethod ? `${cleanMethod} 테스트에서 ${cleanSubject} ${metric}` : `${cleanMethod || "테스트"} 결과 ${metric}`;
  });
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

function stripTrailingKoreanSubjectParticle(value: string): string {
  return value.replace(/([가-힣]{1,40})(?:이|가)(?=$|[,.)\]\s])/g, "$1");
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
  const visibleEntries = entries.filter(([key, value]) => (key !== "howToUse" && key !== "faq") || value.trim().length > 0);

  const items = visibleEntries.map(([key, value], index) => `
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

function appendKoreanSubjectParticle(value: string): string {
  return `${value}${hasKoreanBatchim(value) ? "이" : "가"}`;
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

function fallback(locale: PdpGeoLocale, values: Record<PdpGeoLocale, string>): string {
  return values[locale] ?? values["en-US"];
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9가-힣ぁ-んァ-ン一-龯]+/gi, "-").replace(/^-+|-+$/g, "") || "product";
}
