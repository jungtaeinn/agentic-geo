/**
 * @fileoverview 콘텐츠 플래닝(계획 수립) 단계의 프롬프트 모듈.
 * 프롬프트 본문은 createPlanningPrompt에, 프롬프트에 실을 근거·가이드·규칙을
 * 고르는 선별 헬퍼는 그 아래에 있습니다. 계획 결과의 해석·적용은 content-planner.ts 담당.
 */
import { inferPdpEvidenceRoles } from "../normalize";
import type {
  PdpGeoAtomicEvidence,
  PdpGeoContentPlanningRequest,
  PdpGeoEvidenceRole
} from "../types";

/**
 * 콘텐츠 플래닝용 system/user 프롬프트 쌍을 만듭니다.
 *
 * 무엇을 하는가:
 * - 정규화된 상품 근거 원장(evidence ledger)과 RAG 가이드(BestPractice/GEO/CEP/
 *   E-E-A-T), 정책 규칙을 모델에 주고, "어떤 공개 문안(설명·FAQ·HowTo·CEP)을
 *   어떤 근거 ID로 쓸 수 있는지"를 정한 콘텐츠 계획(plan) JSON을 돌려받습니다.
 * - 모든 사실 문장은 근거 ID 인용이 강제되며, 근거가 부족한 필드는
 *   include=false와 omitReason으로 계획에서 제외됩니다.
 *
 * 구성:
 * - system: 근거 인용 규칙, Product/WebPage description 작성 순서(arc), FAQ·HowTo·
 *   CEP 자격 조건 등 필드별 작성 규칙.
 * - user: 아래 select* 헬퍼로 선별한 근거 원장·RAG 가이드·정책 제약 JSON.
 *
 * @param request 상품, 근거 원장, RAG 청크, 정책 규칙, 교정 피드백
 * @param maxEvidenceItems user 페이로드에 실을 근거 항목 상한
 * @param maxRagChunks user 페이로드에 실을 RAG 가이드 청크 상한
 * @returns system(작성 규칙) / user(선별된 근거·가이드 JSON) 프롬프트 쌍
 */
export function createPlanningPrompt(request: PdpGeoContentPlanningRequest, maxEvidenceItems: number, maxRagChunks: number): { system: string; user: string } {
  const selectedGuidance = selectPlanningRagChunks(request.ragChunks, maxRagChunks);
  return {
    system: [
      "You are an evidence-bound PDP content and schema applicability planner.",
      "Return only the requested strict JSON object in the target locale.",
      "Every factual public-copy clause must cite one or more valid evidenceIds. Cite only the smallest relevant set, normally one to three IDs per clause; never attach the entire ledger. Never invent a product fact, audience, ingredient-benefit causal link, metric, certification, comparison, or buying situation.",
      "Before drafting, classify every cited atom by evidence role and relationship scope. Identity identifies the product; audience names an explicitly supported customer; ingredient names composition; benefit/effect names an outcome; usage names a customer action; metric names a measured result; review names attributed experience; commerce names offer/variant facts; source is supporting text whose role must still be inferred from the sentence itself. A valid evidence ID is not permission to use that atom for an unrelated role.",
      "The ledger role is the atom's primary job. When semanticRoles or relationship is present, use it to preserve a multi-role sentence or an explicit ingredient-outcome/shared-study relationship; never manufacture a relationship from atoms that merely appear near each other.",
      "relationship=named-technology-definition marks an atom that states what a named formula or technology is made of or how it works, not merely its name. Realize it as a sentence that explains the technology, and prefer it over repeating the name in a list. When the same evidence also states the constraint the technology answers — a property of the ingredient that makes the plain form impossible — lead with that constraint so the explanation reads as a cause and its resolution, then continue to the supported outcome or measurement. Every stage of that chain must be an explicitly stated fact from the cited evidence; when the constraint is absent, state the definition alone and do not invent a reason for it.",
      "Separate source assertions, source-backed synthesis, and query hypotheses. Public descriptions, FAQ questions/answers, HowTo, and cep entries may contain only source assertions or synthesis whose every component is supported by cited product evidence. General category knowledge and plausible search associations are not product facts.",
      // contract: content-field-contracts §Description Composition Contract
      "Product.description is the primary answer-ready GEO entity summary and may be materially more detailed than WebPage.description. `Product.description` must be composed as a six-part buyer-answer narrative: product introduction/type + target customer and concern/CEP + ingredient or technology composition + supported finished-product benefit/effect + source-stated research or related-article citation + attributed positive or neutral review keywords last. Treat the six-part order as a reasoning arc grounded in CEP and E-E-A-T, never as a list of six field summaries: let the supported CEP determine sentence boundaries, transitions, and clause grouping, and state only explicit ingredient-to-benefit relations. Source-stated dates, publisher/title, findings, and numbers must be parsed into natural prose; never change a value and never invent missing metadata. An efficacy-evidence block may include multiple outcomes only when the product source groups them under the same study or footnote. Exact completed safety tests may stay in the benefit/evidence portion, but never imply universal safety. Exclude package size, price, award percentage, rating, and review count from efficacy measurements. Skip any stage whose evidence is missing and let the remaining stages close ranks; never pad a missing stage with category generalities, never reorder proof before the need it proves, and never promote educational category facts into the product's composition.",
      "Treat a technology as named only when the cited evidence contains a complete technology, process, or formula name. A dependent predicate fragment captured from the end of a relationship clause is not a technology name and must be omitted or rewritten from the full relationship evidence. Do not force composition and formula structure together with a mechanical conjunction; use complete clauses and connect them only when the grammar and evidence relationship support it.",
      "Never paste OCR bullets, check marks, footnote symbols, chart labels, or detached number sequences into a description. Reconstruct supported study atoms into natural result-led prose: keep each value attached to its timing or comparison label, state shared institution/date/population/method context once, and distinguish finished-product results from ingredient-only or in-vitro evidence.",
      "Integrate completed safety tests as bounded testing scope relevant to product choice, not as a meta note that test information can be referenced. Close review-backed description copy by directly attributing the supported evaluation or experience to customers; avoid passive report wording that merely says keywords were mentioned.",
      "Treat that Product.description order as one CEP-led explanation, not a sequence of independent field summaries. When evidence supports the relationship, connect the customer's concrete concern to why the product type is relevant, connect formula structure to only its explicitly stated role, and connect finished-product study results to the supported decision context. Use natural transitions and combine adjacent clauses when doing so preserves claim scope. Do not infer causality merely to improve flow. Metric claims sharing one evidenceGroup, institution, period, population, method, and outcome family should become one study sentence with the shared context stated once and every timing paired with its value.",
      // contract: content-field-contracts §Description Composition Contract
      "Ground each arc stage in its E-E-A-T role. Each stage answers the buyer's next natural question: what is this (identity) -> is it for me (CEP: situation, need, constraint) -> what is it made of (expertise: composition and named technology) -> what does it do for that need (supported outcome) -> why should I believe it (authoritativeness: cited research, measured results with preserved scope) -> what do people like me experience (experience: attributed review language). Preserved modality and caveats carry trust. Connect the stages with natural target-locale transitions that reuse the buyer's concern as the through-line; a reader should not be able to see field boundaries in the finished prose. Realize the arc in the grammar and cadence of the target locale (Korean, English, or Japanese alike) rather than translating one fixed sentence frame, because the arc is locale-independent reasoning.",
      // contract: content-field-contracts §Description Separation Contract
      "Do not reuse the same description for `WebPage.description` and `Product.description`. Both descriptions must follow introduction -> target customer -> composition -> benefit/effect -> research/article citation -> attributed review keywords, but WebPage is a compact page/brand/scope summary and Product is the detailed product-entity narrative. When the source supports them, routine timing, completed safety tests, and a matched option/price may join the page summary. Express target, unlinked composition, and finished-product benefit as parallel predicates under the same product subject so they read as one CEP-led explanation; do not isolate them as field-summary sentences and do not add an ingredient-to-benefit causal connector. Omit HowTo actions and preserve measured values.",
      "For WebPage.description in every locale, introduce the exact product page and source-backed brand in a natural product-first opening sentence; avoid tautological page framings such as the Korean '[brand]의 [product] 상품 페이지는 [type] 상품을 소개합니다' or the English 'This [product] product page introduces a [type] product'. Use page wording only in that opening. Later clauses should flow through the supported customer concern, formula, effect, routine, proof, safety scope, offer, and review without repeated page-narration such as '페이지 본문에서는', '페이지에서 확인할 수 있는', 'on this page', or 'the page also shows'.",
      "Generate, do not copy, the sentence structure of the target locale from the cited CEP and evidence — this applies equally to Korean and English output. Express supported routine timing with the product as subject but omit HowTo actions; join multiple measurements under one shared-study framing (Korean '같은 시험', English 'in the same study') only when their evidenceGroup matches; keep option and price together; close with two to four positive attributed review experience terms. Vary syntax naturally across sentences and repeat the exact product name only when it improves entity clarity.",
      "FAQ must be about this specific product. Exclude category education and general-knowledge questions whose answer would remain essentially unchanged for another product, such as what the skin barrier is or does. A question that defines this product's own named formula or technology is not category education and is allowed when the cited evidence accounts for it; the test is whether the answer changes when the product changes, not whether the question takes the shape of a definition. Natural interrogative wrappers and target-locale inflection do not need to appear verbatim in evidence, but every factual premise in the question and every answer clause must be supported by the cited product evidence.",
      // contract: content-field-contracts §FAQ Contract
      "Build FAQ backwards from natural recommendation/comparison queries and answers forwards from cited product evidence. Prefer concern + skin type/category, ingredient + supported role, source-backed CEP, or attributed use-feel. Cooling plus a water-cream formula may support a hot-condition or after-sweating refreshing-feel question, but never sweat control, heat treatment, or another physiological effect. Product-specific questions must name the exact product instead of using a deictic subject that only points at the product, such as 이 제품, 이 크림, this product, or this cream. Seasonal, gift, and life-stage contexts require matching current-product evidence. FAQ has no target or minimum count, and must never be padded toward one; zero questions is valid when the source does not support a useful, direct answer. Select only the distinct customer intents that materially help a buying or usage decision; schema presence and question volume are not citation guarantees. Build suitability answers as target/concern -> finished-product benefit -> most relevant result as proof -> explicitly linked ingredient role -> bounded recommendation -> individual-results qualifier. State qualifiers directly to the customer (for example, '개인 차가 있을 수 있습니다' or 'Individual results may vary'); never narrate that a disclaimer, caveat, condition, or note is attached. Keep unlinked ingredient and finished-product effects separate. Reviews cannot prove efficacy or suitability.",
      "For a benefits FAQ, use natural customer wording rather than an internal audit phrase. In Korean, ask '[상품명]의 주요 효능·효과는 무엇이며, 공개된 인체적용시험 결과는 어떻게 나타났나요?' only when finished-product human-application evidence exists; otherwise ask only the benefits question. In English, use the exact source method: say 'clinical study' only for clinical evidence, 'instrumental assessment' for instrumental evidence, or the neutral 'reported assessment results' when the method label is broader. Never ask 'what product evidence supports them?'. A PDP-reported study is not necessarily published or peer-reviewed, so reserve those terms for an actual bibliographic citation.",
      "Order FAQ by buyer priority. Item 1 is target-customer suitability in one CEP chain; item 2 is target need -> selected core formula -> explicit ingredient roles -> finished-product benefit. Never paste study fields or full ingredient/effect inventories. Then add only distinct, evidenced usage, texture, test, variant, comparison, renewal, or review questions.",
      "A CEP is a source-backed buying/use situation, need, or constraint—not a keyword slogan. In each cep item, use situation for the supported target customer/occasion, need for the concrete concern and desired outcome, and constraint for a supported selection condition or an explicit ingredient/technology-to-outcome reason. Leave constraint empty when the source does not explicitly support that relation. Cite evidence for every component, and never infer a causal, suitability, ingredient-benefit, or routine relationship merely because two facts co-occur. Seasonal/weather contexts, time-of-day, events, gifting, travel, life stage, and other general category associations require explicit current-product evidence for that same context. If such an association is useful for later search research but not evidenced, omit it from cep and all public fields and add a warning prefixed QUERY_HYPOTHESIS_ONLY; the warning is diagnostic and must not be copied into public content.",
      "Use FAQ to express a small set of semantically distinct generative-search surfaces from the strongest supported CEP paths: suitability/target customer, concern-to-effect, ingredient or technology role, official measurement, routine, and review experience. Vary natural target-locale wording and keywords across distinct intents, but do not create synonymous questions that lead to the same answer or use query variety to add unsupported facts.",
      // contract: content-field-contracts §HowTo Contract
      "Create HowTo only when the source supplies a concrete goal and at least one direct source action, and do not change its structure. One application instruction must become exactly one step; multiple steps require an explicitly ordered source sequence and must preserve its original count/order. Do not split one instruction into synthetic steps or combine unordered notes into a procedure. A frequency note, warning, amount, routine position, test condition, compatibility note, formula technology, measured outcome, or customer-review usage anecdote must never become a step without a direct product instruction.",
      // contract: content-field-contracts §Evidence Routing Contract — the
      // "keep each evidence type in its matching public field" clause only. The
      // rest of this item (value preservation, locale politeness and speech
      // level, synonym resolution, Korean source endings) is prompt-side
      // guidance with no contract counterpart.
      "Preserve product names, ingredient names, numbers, units, populations, time frames, and caveats exactly when those facts are used. Use complete, natural, consistently polite target-locale sentences; do not mix language or speech-level frames. Resolve synonymous skin-type and concern terms into one target-locale expression instead of emitting duplicates in multiple languages. Keep ingredient, benefit/effect, usage, review, certification, and measured-result evidence in their matching public fields. In Korean descriptions, never copy a source ending such as '~표기되어 있다' into otherwise polite '~합니다/~됩니다' copy.",
      "When support is insufficient set include/eligible=false, return empty text/steps, and explain omitReason. Confidence is evidence confidence, not stylistic confidence.",
      "RAG guidance is policy context only and can never be cited as product evidence.",
      "Use the active best-practice guidance as the public-copy style benchmark: transfer its level of confidence, customer-facing clarity, sentence cadence, evidence density, and way of connecting CEP, composition, effect, proof, and experience. Locale and matched brand guidance refine that voice. Never copy a best-practice example, placeholder, product fact, or exact sentence frame; generate new prose from the current product evidence.",
      "When candidatePlan is present, act as an evidence-entailment auditor: check every factual clause against only its cited evidence IDs, preserve claim modality and caveats, remove any added benefit/ingredient/audience/metric/CEP, and return the corrected full plan. Translation is allowed only when the cited fact has the same meaning."
    ].join("\n"),
    user: JSON.stringify({
      targetLocale: request.locale,
      market: request.market,
      productName: request.product.name,
      requestedSchemaTargets: request.hints?.schemaTargets ?? [],
      correctiveFeedback: request.planningFeedback ?? [],
      candidatePlan: request.candidatePlan,
      evidenceLedger: selectPlanningEvidence(request.evidenceLedger, Math.max(1, maxEvidenceItems)).map((item) => ({
        id: item.id,
        role: item.role,
        ...planningEvidenceAnalysis(item),
        text: truncate(item.text, 900),
        sourcePath: item.sourcePath,
        confidence: item.confidence
      })),
      bestPracticeToneGuidance: selectToneGuidanceChunks(request.ragChunks, maxToneGuidanceChunks)
        .map((chunk) => ({
          source: chunk.source,
          title: chunk.title,
          fieldTargets: chunk.fieldTargets,
          text: truncate(chunk.text, 500)
        })),
      toneApplicationPolicy: "Transfer BestPractice voice, cadence, transitions, and evidence density. Do not copy examples or facts.",
      // BestPractice is carried by the tone slot above, in longer excerpts. It
      // used to appear here as well, truncated to 240 characters — the same
      // chunk twice, the second copy cut mid-sentence, which is a poor way to
      // show a model what cadence to transfer.
      taskGuidance: selectedGuidance.filter((chunk) => chunk.kind !== "best-practice").map((chunk) => ({
        source: chunk.source,
        title: chunk.title,
        // Contextual header for the generation model: a chunk cut mid-document
        // (e.g. "3.7.1 Plan Coverage") is self-explanatory only with its parent
        // heading trail (Anthropic contextual-retrieval, generation side).
        headingPath: typeof chunk.metadata?.headingPath === "string" ? chunk.metadata.headingPath : undefined,
        kind: chunk.kind,
        intents: chunk.intents,
        fieldTargets: chunk.fieldTargets,
        text: truncate(chunk.text, 650)
      })),
      policyConstraints: selectPlanningPolicyRules(request.policyRules ?? []).map((rule) =>
        `${rule.severity === "critical" ? "C" : "G"}:${truncate(rule.text, 110)}`
      )
    })
  };
}

/**
 * 근거 한 건의 다중 역할(semanticRoles)과 명시적 관계(성분→효과, 동일 시험군,
 * 명명된 기술의 정의)를 추론해 프롬프트 페이로드에 힌트로 싣습니다.
 * 근거 텍스트 자체는 바꾸지 않습니다.
 */
function planningEvidenceAnalysis(item: PdpGeoAtomicEvidence): {
  semanticRoles?: string[];
  relationship?: "ingredient-outcome" | "shared-measurement-group" | "named-technology-definition";
} {
  const inference = inferPdpEvidenceRoles(item.text);
  const semanticRoles = uniqueText(inference.roles.filter((role) => role !== "source"));
  const hasEvidenceGroup = item.role === "metric" && /(?:^|;\s*)evidenceGroup=[^;]+/u.test(item.text);
  return {
    semanticRoles: semanticRoles.length > 1 ? semanticRoles : undefined,
    relationship: inference.canLinkIngredientToOutcome
      ? "ingredient-outcome"
      : hasEvidenceGroup
        ? "shared-measurement-group"
        : definesNamedTechnology(item.text)
          ? "named-technology-definition"
          : undefined
  };
}

/**
 * True when an atom does not merely name a formula or technology but says what
 * it is made of or how it works.
 *
 * Such an atom arrives as a noun phrase ("물에 녹지 않는 세라마이드를 캡슐 형태로
 * 워터에 띄워놓은 하이드로겔 플로팅 포뮬러 기술"), so pasting it into prose reads
 * as a label rather than an explanation, and the planner has no way to tell it
 * apart from the bare name of the same technology. Marking it lets the planner
 * realize it as a sentence — the definitional evidence unit the research cards
 * record as an absorption signal — instead of adding another list item.
 *
 * The head noun set identifies what KIND of thing is named; the length check is
 * what separates a definition from a name, and it is the modifying clause, not
 * any particular verb, that decides.
 */
function definesNamedTechnology(text: string): boolean {
  const value = cleanText(text);
  const head = value.match(/(?:기술|포뮬러|공법|처방|technology|formula|complex)/iu);
  if (!head) {
    return false;
  }
  const index = head.index ?? 0;
  const before = value.slice(0, index).trim();
  const after = value.slice(index + head[0].length).trim();
  // Korean puts the modifier before the head noun and English after it, so a
  // definition carries substantive text on one side or the other; a bare name
  // ("하이드로겔 플로팅 포뮬러") carries neither.
  return before.length >= 16 || after.length >= 16;
}

/**
 * Voice samples carried in the tone slot.
 *
 * The BestPractice corpus is ~33,000 characters across 48 chunks with a median
 * length of 704, and the planner used to see exactly one of them — about 1.5%
 * of the document, and the same chunk was repeated in taskGuidance truncated to
 * 240 characters, which cuts mid-sentence. A model asked to transfer cadence
 * and evidence density needs more than one fragment, and distinct sections show
 * more of the register than one section shown twice. The chunks come from the
 * full retrieved set rather than the five-chunk task slice, because the tone
 * slot is not competing for the same budget.
 */
const maxToneGuidanceChunks = 3;

function selectToneGuidanceChunks(
  chunks: PdpGeoContentPlanningRequest["ragChunks"],
  limit: number
): PdpGeoContentPlanningRequest["ragChunks"] {
  const selected: PdpGeoContentPlanningRequest["ragChunks"] = [];
  const seenSections = new Set<string>();
  for (const chunk of chunks) {
    if (chunk.kind !== "best-practice" || selected.length >= limit) {
      continue;
    }
    // Distinct sections only: two chunks split out of one long section repeat
    // the same register and spend the slot twice.
    const section = `${chunk.source}:${chunk.title ?? chunk.id}`;
    if (seenSections.has(section)) {
      continue;
    }
    seenSections.add(section);
    selected.push(chunk);
  }
  return selected;
}

/**
 * 프롬프트에 실을 RAG 가이드 청크를 상한(limit) 안에서 고릅니다.
 * BestPractice/GEO/CEP/E-E-A-T 각 계열 1개를 먼저 확보한 뒤 검색 점수 순으로 채웁니다.
 */
function selectPlanningRagChunks(
  chunks: PdpGeoContentPlanningRequest["ragChunks"],
  limit: number
): PdpGeoContentPlanningRequest["ragChunks"] {
  const cappedLimit = Math.max(0, limit);
  if (cappedLimit === 0) {
    return [];
  }
  const selected: PdpGeoContentPlanningRequest["ragChunks"] = [];
  const selectedIds = new Set<string>();
  const add = (chunk: PdpGeoContentPlanningRequest["ragChunks"][number] | undefined, protectedFamily = false) => {
    if (!chunk || (!protectedFamily && selected.length >= cappedLimit) || selectedIds.has(chunk.id)) {
      return;
    }
    selected.push(chunk);
    selectedIds.add(chunk.id);
  };

  // Field contracts decide what each field may contain, and GEO/CEP/E-E-A-T
  // control exposure, customer context, and claim safety. Reserve each family
  // before filling the remaining budget in retrieval-score order.
  //
  // BestPractice is not reserved here: it governs voice rather than task rules
  // and is carried by the tone slot, which draws from the full retrieved set.
  // Holding a slot for a chunk this payload no longer renders would spend the
  // budget on nothing.
  //
  // The evidence cards are reserved alongside geo-research for the reason
  // coverageRagKindOrder already states: geo-research defers every research
  // number and its provenance to the cards, so the referrer without its
  // canonical source leaves those claims unbacked. Retrieval gives the cards a
  // coverage seat; without a reserved slot here the five families above filled
  // the whole budget and the cards never reached the planner at all — the one
  // document whose subject is what earns a citation.
  for (const kind of ["field-contracts", "geo-research", "evidence-cards", "cep", "eeat"] as const) {
    add(chunks.find((chunk) => chunk.kind === kind), true);
  }
  for (const chunk of chunks) {
    add(chunk);
  }
  return selected;
}

/** 정책 규칙을 critical 우선, 그다음 priority 내림차순으로 정렬합니다. */
function selectPlanningPolicyRules(rules: NonNullable<PdpGeoContentPlanningRequest["policyRules"]>) {
  return rules
    .slice()
    .sort((left, right) =>
      Number(right.severity === "critical") - Number(left.severity === "critical")
      || right.priority - left.priority
    );
}

/**
 * 프롬프트에 실을 근거를 상한(limit) 안에서 고릅니다.
 * 역할 우선순위·구체성·신뢰도로 순위를 매기되, 역할별 커버리지 쿼터를 먼저 채워
 * 특정 역할(예: source)이 리뷰·사용법·가격 근거를 밀어내지 못하게 합니다.
 */
function selectPlanningEvidence(evidence: PdpGeoAtomicEvidence[], limit: number): PdpGeoAtomicEvidence[] {
  const rolePriority: Record<PdpGeoEvidenceRole, number> = {
    identity: 100,
    description: 98,
    metric: 96,
    benefit: 94,
    effect: 94,
    ingredient: 93,
    audience: 92,
    usage: 92,
    faq: 90,
    source: 88,
    commerce: 72,
    review: 68
  };
  const ranked = evidence
    .map((item, index) => ({ item, index }))
    .sort((left, right) =>
      rolePriority[right.item.role] - rolePriority[left.item.role]
      || planningEvidenceSpecificity(right.item) - planningEvidenceSpecificity(left.item)
      || right.item.confidence - left.item.confidence
      || left.index - right.index
    );
  const byRole = new Map<PdpGeoEvidenceRole, Array<{ item: PdpGeoAtomicEvidence; index: number }>>();
  for (const candidate of ranked) {
    const bucket = byRole.get(candidate.item.role) ?? [];
    bucket.push(candidate);
    byRole.set(candidate.item.role, bucket);
  }

  // Reserve a balanced set before filling by global priority. The previous
  // priority-only slice could spend every remaining slot on generic `source`
  // atoms and hide reviews, offer facts, audience, or usage from the planner
  // even though the ledger contained them. Quotas are coverage budgets, not
  // content requirements: absent roles consume no space.
  const coverageTargets: Partial<Record<PdpGeoEvidenceRole, number>> = {
    identity: 2,
    description: 1,
    audience: 4,
    ingredient: 10,
    benefit: 6,
    effect: 6,
    metric: 16,
    source: 18,
    usage: 8,
    faq: 6,
    commerce: 3,
    review: 8
  };
  const coverageOrder: PdpGeoEvidenceRole[] = [
    "identity",
    "description",
    "audience",
    "ingredient",
    "benefit",
    "effect",
    "metric",
    "source",
    "usage",
    "faq",
    "commerce",
    "review"
  ];
  const selected: Array<{ item: PdpGeoAtomicEvidence; index: number }> = [];
  const selectedIds = new Set<string>();
  const addCandidate = (candidate: { item: PdpGeoAtomicEvidence; index: number } | undefined) => {
    if (!candidate || selected.length >= limit || selectedIds.has(candidate.item.id)) return;
    selected.push(candidate);
    selectedIds.add(candidate.item.id);
  };
  const maxRounds = Math.max(...Object.values(coverageTargets));
  for (let round = 0; round < maxRounds && selected.length < limit; round += 1) {
    for (const role of coverageOrder) {
      if (round >= (coverageTargets[role] ?? 0)) continue;
      addCandidate(byRole.get(role)?.[round]);
      if (selected.length >= limit) break;
    }
  }
  for (const candidate of ranked) {
    addCandidate(candidate);
    if (selected.length >= limit) break;
  }
  return selected
    .sort((left, right) => left.index - right.index)
    .map(({ item }) => item);
}

/** 근거의 출처 경로(sourcePath)로 구체성 점수를 매깁니다(구조화된 사실일수록 높음). */
function planningEvidenceSpecificity(item: PdpGeoAtomicEvidence): number {
  if (/semanticFacts\.metricClaims|semanticFacts\.ingredientBenefitLinks|semanticFacts\.citations/u.test(item.sourcePath)) return 5;
  if (/semanticFacts\./u.test(item.sourcePath)) return 4;
  if (/reviews\.keywords/u.test(item.sourcePath)) return 3;
  if (/reviews\.items/u.test(item.sourcePath)) return 2;
  if (/sourceTexts/u.test(item.sourcePath)) return item.text.length <= 320 ? 1 : 0;
  return 2;
}

// content-planner.ts의 동명 헬퍼와 동일한 구현입니다(프롬프트 모듈은 파이프라인
// 모듈을 역참조하지 않도록 사본을 둡니다). 수정 시 두 곳을 함께 확인하세요.
function uniqueText(values: string[]): string[] {
  return [...new Set(values.map(cleanText).filter(Boolean))];
}

function cleanText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ").replace(/\s+/g, " ").trim();
}

function truncate(value: string, max: number): string {
  const text = cleanText(value);
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trim()}…`;
}
