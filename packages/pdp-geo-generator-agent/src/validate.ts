import type { JsonObject, PdpGeoContentArtifact, PdpGeoContentSections, PdpGeoLocale, PdpGeoSchemaMarkup } from "./types";

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
}

const allowedGraphTypes = new Set(["WebPage", "Product", "FAQPage", "HowTo", "BreadcrumbList", "Question", "Answer", "HowToStep", "Offer", "AggregateRating", "Review", "Rating", "PropertyValue", "ItemList", "ListItem", "Brand", "Person"]);

/** Validates and repairs generated JSON-LD and simple accordion HTML. */
export function validateAndRepairPdpGeoArtifacts(input: ValidateAndRepairInput): ValidateAndRepairOutput {
  const validationWarnings: string[] = [];
  const locale = input.locale ?? "en-US";
  const fallbackProductName = repairGeneratedText(input.fallbackProductName, locale, "fallbackProductName", validationWarnings);
  const fallbackDescription = repairGeneratedText(input.fallbackDescription, locale, "fallbackDescription", validationWarnings);
  const jsonLd = repairJsonLd(input.schemaMarkup.jsonLd, fallbackProductName, fallbackDescription, locale, validationWarnings);
  const schemaMarkup = {
    jsonLd,
    scriptTag: `<script type="application/ld+json">${escapeScriptJson(JSON.stringify(jsonLd, null, 2))}</script>`
  };
  const sections = repairContentSections(input.content.sections, locale, validationWarnings);
  sanitizeAccordionHtml(input.content.html, validationWarnings);
  const content = {
    ...input.content,
    sections,
    html: createAccordionHtml(sections, locale)
  };

  return {
    schemaMarkup,
    content,
    validationWarnings
  };
}

function repairJsonLd(value: JsonObject, fallbackProductName: string, fallbackDescription: string, locale: PdpGeoLocale, warnings: string[]): JsonObject {
  const root = isRecord(value) ? { ...value } : {};
  if (root["@context"] !== "https://schema.org") {
    root["@context"] = "https://schema.org";
    addWarning(warnings, "JSON-LD @context was repaired to https://schema.org.");
  }

  const rawGraph: unknown[] = Array.isArray(root["@graph"]) ? root["@graph"] : [];
  const graph = rawGraph.filter(isRecord).map((node) => repairGraphNode(node, locale, warnings));
  if (graph.length === 0) {
    graph.push({
      "@type": "Product",
      "@id": `urn:agentic-geo:pdp:${slug(fallbackProductName)}#product`,
      name: fallbackProductName,
      description: fallbackDescription
    });
    addWarning(warnings, "JSON-LD @graph was missing and a minimal Product node was added.");
  }

  const product = graph.find((node) => node["@type"] === "Product");
  if (!product) {
    graph.push({
      "@type": "Product",
      "@id": `urn:agentic-geo:pdp:${slug(fallbackProductName)}#product`,
      name: fallbackProductName,
      description: fallbackDescription
    });
    addWarning(warnings, "JSON-LD Product node was missing and was added.");
  } else {
    if (typeof product.name !== "string" || product.name.trim().length === 0) {
      product.name = fallbackProductName;
      addWarning(warnings, "Product.name was missing and was repaired.");
    }
    if (typeof product.description !== "string" || product.description.trim().length === 0) {
      product.description = fallbackDescription;
      addWarning(warnings, "Product.description was missing and was repaired.");
    }
  }

  return cleanJson({
    ...root,
    "@graph": graph
  }) as JsonObject;
}

function repairGraphNode(node: Record<string, unknown>, locale: PdpGeoLocale, warnings: string[]): Record<string, unknown> {
  const type = node["@type"];
  if (typeof type === "string" && !allowedGraphTypes.has(type)) {
    addWarning(warnings, `Unsupported schema.org node type "${type}" was kept for compatibility but flagged.`);
  }

  if (node["@type"] === "FAQPage" && Array.isArray(node.mainEntity)) {
    node.mainEntity = node.mainEntity.filter(isRecord).flatMap((item) => {
      const name = stringValue(item.name);
      const acceptedAnswer = isRecord(item.acceptedAnswer) ? item.acceptedAnswer : undefined;
      const answer = stringValue(acceptedAnswer?.text);
      if (!name || !answer) {
        addWarning(warnings, "Invalid FAQ question without answer was removed.");
        return [];
      }
      const repairedQuestion = repairGeneratedText(name, locale, "FAQPage.mainEntity.name", warnings);
      const repairedAnswer = repairGeneratedText(answer, locale, "FAQPage.mainEntity.acceptedAnswer.text", warnings);
      const aligned = repairFaqQuestionAnswerAlignment(repairedQuestion, repairedAnswer, locale, warnings);

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
    node.step = node.step.filter(isRecord).flatMap((item, index) => {
      const text = stringValue(item.text);
      if (!text) {
        addWarning(warnings, "Invalid HowTo step without text was removed.");
        return [];
      }
      return [{
        "@type": "HowToStep",
        position: numberValue(item.position) ?? index + 1,
        name: stringValue(item.name) ? repairGeneratedText(stringValue(item.name) ?? "", locale, "HowTo.step.name", warnings) : undefined,
        text: repairGeneratedText(text, locale, "HowTo.step.text", warnings)
      }];
    });
  }

  const repaired = repairSchemaTextFields(node, locale, warnings);
  return cleanJson(pruneInvalidSchemaText(repaired, locale, warnings));
}

function sanitizeAccordionHtml(html: string, warnings: string[]): string {
  let next = html;
  const before = next;
  next = next.replace(/<script[\s\S]*?<\/script>/gi, "");
  next = next.replace(/\son[a-z]+\s*=\s*["'][^"']*["']/gi, "");
  next = next.replace(/\sstyle\s*=\s*["'][^"']*["']/gi, "");
  next = next.replace(/<(\/?)(?!div\b|button\b|ul\b|li\b|p\b|br\b)([a-z][a-z0-9-]*)([^>]*)>/gi, "");

  if (next !== before) {
    addWarning(warnings, "Generated HTML contained unsafe or unsupported tags/attributes and was sanitized.");
  }
  if (!/class="geo-content-accordion"/.test(next)) {
    addWarning(warnings, "Generated HTML did not include the expected accordion wrapper.");
  }

  return next;
}

function repairContentSections(sections: PdpGeoContentSections, locale: PdpGeoLocale, warnings: string[]): PdpGeoContentSections {
  return {
    productName: repairGeneratedText(sections.productName, locale, "content.sections.productName", warnings),
    description: repairGeneratedText(sections.description, locale, "content.sections.description", warnings),
    quickFacts: repairGeneratedText(sections.quickFacts, locale, "content.sections.quickFacts", warnings),
    benefits: repairGeneratedText(sections.benefits, locale, "content.sections.benefits", warnings),
    ingredients: repairGeneratedText(sections.ingredients, locale, "content.sections.ingredients", warnings),
    howToUse: repairGeneratedText(sections.howToUse, locale, "content.sections.howToUse", warnings),
    faq: repairGeneratedText(sections.faq, locale, "content.sections.faq", warnings)
  };
}

function repairFaqQuestionAnswerAlignment(question: string, answer: string, locale: PdpGeoLocale, warnings: string[]): { question: string; answer: string } {
  if (locale !== "ko-KR") {
    return { question, answer };
  }

  const intent = classifyKoreanQuestionIntent(question);
  if (intent === "evidence" && !isKoreanEvidenceAnswer(answer) && isKoreanProductContextAnswer(answer)) {
    const productName = extractKoreanProductNameFromQuestion(question);
    addWarning(warnings, "FAQ question/answer intent mismatch was repaired during final sentence QA.");
    return {
      question: productName
        ? `${productName}의 성분, 효능, 사용감은 어떤 정보로 정리되나요?`
        : "상품의 성분, 효능, 사용감은 어떤 정보로 정리되나요?",
      answer: ensureKoreanFaqAnswerSourceContext(answer)
    };
  }

  if (intent === "review" && !/리뷰|후기|사용감|만족|체감|피부결|촉촉|보습력|흡수감/.test(answer) && isKoreanProductContextAnswer(answer)) {
    const productName = extractKoreanProductNameFromQuestion(question);
    addWarning(warnings, "FAQ review question/answer intent mismatch was repaired during final sentence QA.");
    return {
      question: productName
        ? `${productName}의 성분과 효능은 어떤 제품 정보로 설명되나요?`
        : "상품의 성분과 효능은 어떤 제품 정보로 설명되나요?",
      answer
    };
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
  return `상품 상세의 성분/효능 정보와 고객 리뷰 표현을 기준으로 ${lowercaseKoreanSentenceStart(answer)}`;
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

function repairSchemaTextFields<T>(value: T, locale: PdpGeoLocale, warnings: string[], path: string[] = []): T {
  if (Array.isArray(value)) {
    return value.map((item, index) => repairSchemaTextFields(item, locale, warnings, [...path, String(index)])) as T;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      repairSchemaTextFields(item, locale, warnings, [...path, key])
    ]);
    return Object.fromEntries(entries) as T;
  }
  if (typeof value === "string" && shouldRepairSchemaString(path, value)) {
    return repairGeneratedText(value, locale, path.join("."), warnings) as T;
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

function pruneInvalidSchemaText(node: Record<string, unknown>, locale: PdpGeoLocale, warnings: string[]): Record<string, unknown> {
  if (node["@type"] === "Product" && Array.isArray(node.additionalProperty)) {
    node.additionalProperty = node.additionalProperty.filter(isRecord).flatMap((item) => {
      const name = stringValue(item.name);
      const value = stringValue(item.value);
      if (!name || !value || isInvalidPropertyValue(name, value, locale)) {
        addWarning(warnings, "Invalid or awkward PropertyValue text was removed during final sentence QA.");
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
        addWarning(warnings, "Invalid positiveNotes item was removed during final sentence QA.");
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
  if (/key ingredients/i.test(name)) {
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

function repairGeneratedText(value: string, locale: PdpGeoLocale, path: string, warnings: string[]): string {
  let next = value
    .replace(/\\"/g, "\"")
    .replace(/\\[rn]/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/\s+([,.!?。！？])/g, "$1")
    .replace(/([.。！？?])(?=\S)/g, "$1 ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .trim();

  if (locale === "ko-KR") {
    next = repairKoreanReviewQuoteFragments(next);
    next = repairKoreanEvidenceFragments(next);
    next = repairKoreanSentenceQuality(next);
    next = repairKoreanParticles(next);
    if (isShortKoreanLabelValue(path, next)) {
      next = stripTrailingKoreanObjectParticle(next);
    }
    next = repairKoreanAwkwardSpacing(next);
  }
  if (locale === "en-US" || locale === "en-GB") {
    next = repairEnglishSentenceQuality(next);
  }

  next = removeUrlArtifactSentences(next);
  next = removeTruncatedFragments(next);
  next = removeDanglingGeneratedFragments(next);
  next = normalizeRepeatedPunctuation(next).trim();

  if (next !== value.trim()) {
    addWarning(warnings, `Final sentence QA repaired generated text at ${path}.`);
  }

  return next;
}

function repairEnglishSentenceQuality(value: string): string {
  return value
    .replace(/The ingredient context of ([^.]+?) anchors the ([^.]+?) around benefit terms such as ([^.]+?), texture language, and use-feel comparison/gi, "$1 appears with $3 in the $2 for formula, texture, and routine comparison")
    .replace(/(.+?) gives (.+?) ingredient context for (.+?) care, routine fit, and comparison-led product discovery/gi, "$1 helps $2 understand the formula behind $3 care and everyday routine fit")
    .replace(/(.+?) builds a product discovery context around (.+?), blending benefit terms, ingredient terms, texture, and use-feel language/gi, "$1 brings together $2, texture, and comfort details that shoppers look for in a skin-care routine")
    .replace(/Product detail context adds/gi, "Product details add")
    .replace(/Product detail context organises/gi, "Product details pair")
    .replace(/\bProduct detail context\b/g, "Product details")
    .replace(/\bproduct detail context\b/g, "product details")
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
    .replace(/\s{2,}/g, " ")
    .trim();
}

function repairKoreanEvidenceFragments(value: string): string {
  return value
    .replace(/확인\s*(?:가능한\s*)?정보로\s*고객 리뷰 표현:\s*([^.!?。！？\n]+?)(?:을|를)\s*포함합니다/g, (_match, phrase: string) => {
      const cleanPhrase = phrase.trim().replace(/\s*,\s*/g, ", ");
      return `고객 리뷰의 ${cleanPhrase} 표현은 사용감과 케어 포인트를 보완합니다`;
    })
    .replace(/확인된\s*(?:결과\/정보|상품 정보|정보)?(?:로|는)?\s*[^.。!?]*?(?:인가요|나요|까요)\??(?:을|를)?\s*(?:참고할 수 있습니다|포함합니다|확인할 수 있습니다|입니다)?[.。]?/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
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
  return value
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
    .replace(/([.。！？])(?=\S)/g, "$1 ")
    .replace(/\s{2,}/g, " ")
    .trim();
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
  return /(?:,|및|또는|그리고|으로|로|을|를|은|는|이|가|과|와|with|and|or|such as|including)$/i.test(value.trim());
}

function normalizeRepeatedPunctuation(value: string): string {
  return value
    .replace(/([.!?。！？])\1{1,}/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n");
}

function isQuestionLike(value: string, locale: PdpGeoLocale): boolean {
  const text = value.trim();
  if (/[?？]$/.test(text)) {
    return true;
  }
  return locale === "ko-KR" && /(인가요|나요|까요|무엇인가요|어떤가요)\s*[?？]?$/.test(text);
}

function isBrokenGeneratedFragment(value: string): boolean {
  const text = value.trim();
  const openParens = (text.match(/\(/g) ?? []).length;
  const closeParens = (text.match(/\)/g) ?? []).length;
  return openParens !== closeParens
    || /(property value|Evidence signal|Review signals|technology signals|main benefit signal|리뉴얼 전 제품|고객님들이 만족하셨던 속성)/i.test(text);
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
