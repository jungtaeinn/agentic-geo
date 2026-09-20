# Content Field Contracts v1

This document is the canonical statement of the field contracts that govern generated PDP schema and PDP content. Every rule below is the authoritative wording for its contract; the other corpus documents explain the same contracts from their own perspective (schema compatibility, E-E-A-T, CEP, GEO research, orchestration) and must not restate them in competing words.

Read this document as field contracts, not as tone or style guidance. Tone, cadence, locale wording, and brand voice stay with the BestPractice, locale, and brand documents.

## Description Composition Contract

- `Product.description` must be composed as a six-part buyer-answer narrative: product introduction/type + target customer and concern/CEP + ingredient or technology composition + supported finished-product benefit/effect + source-stated research or related-article citation + attributed positive or neutral review keywords last.
- Source-stated dates, publisher/title, findings, and numbers must be parsed into natural prose; never change a value and never invent missing metadata.
- Treat the six-part order as a reasoning arc grounded in CEP and E-E-A-T, never as a list of six field summaries.
- Each stage answers the buyer's next natural question: what is this (identity) -> is it for me (CEP: situation, need, constraint) -> what is it made of (expertise: composition and named technology) -> what does it do for that need (supported outcome) -> why should I believe it (authoritativeness: cited research, measured results with preserved scope) -> what do people like me experience (experience: attributed review language).
- Connect the stages with natural target-locale transitions that reuse the buyer's concern as the through-line; a reader should not be able to see field boundaries in the finished prose.
- Realize the arc in the grammar and cadence of the target locale (Korean, English, or Japanese alike) rather than translating one fixed sentence frame, because the arc is locale-independent reasoning.
- Skip any stage whose evidence is missing and let the remaining stages close ranks; never pad a missing stage with category generalities, and never reorder proof before the need it proves.
- A named formula or technology answers the composition stage only when the copy says what it is made of or how it works. Where the source supplies that account, realize it as a sentence; a name repeated into a list leaves the stage unanswered.
- Where the source also states the property that makes the plain form of an ingredient unusable, open the composition stage with that property and resolve it with the named technology, then continue to the supported outcome. Both halves have to be stated facts; without the property, give the account of the technology on its own.
- Each sentence answers the question the sentence before it raises, so the arc reads as one explanation a buyer is walked through rather than as six answers set side by side.
- Where the source states why the concern arises, open the target-customer stage with that stated mechanism instead of restating the symptom. A reader whose own question is adjacent to the concern finds their answer in the mechanism, and one sentence then covers a family of questions instead of one.
- Where the source itself contrasts this product's form with the ordinary form of the same thing, state that contrast in the composition stage: a difference the source draws is a fact only this product's page can supply. Never introduce a comparison the source does not make, and never characterize a competing product.
- Usage context belongs in Usage/HowTo and must not interrupt the `Product.description` order.

If another document restates or contradicts this contract, this document takes precedence.

## Description Separation Contract

- Do not reuse the same description for `WebPage.description` and `Product.description`.
- Both descriptions must follow introduction -> target customer -> composition -> benefit/effect -> research/article citation -> attributed review keywords, but WebPage is a compact page/brand/scope summary and Product is the detailed product-entity narrative.
- Describe the PDP as a page or content resource in `WebPage.description` and the product entity itself in `Product.description`, because schema.org treats `description` as the description of the item being marked up.
- Do not use page-level wording such as "product page" inside `Product.description`; reserve page/resource language for `WebPage.description`.
- Keep detailed methods, disclosures, caveats, ungrouped certifications, and raw metric strings in dedicated properties or evidence FAQ rather than report-style sentences; exact completed safety tests may stay in the benefit/evidence block.
- When the source states a purchasable option and its price, name both in the `WebPage.description` prose. A price a reader can see in the sentence is one of the on-page conditions that decides whether a page is cited at all, and the structured `Offer` does not stand in for it, because what an answer quotes is prose.

If another document restates or contradicts this contract, this document takes precedence.

## FAQ Contract

- FAQ has no target or minimum count, and must never be padded toward one. Zero questions is valid when the source does not support a useful, direct answer.
- Select only the distinct customer intents that materially help a buying or usage decision; schema presence and question volume are not citation guarantees.
- Never publish a FAQ answer that opens with a non-answer declaring that the fact is unknown, undisclosed, or impossible to confirm, because answer engines cite standalone answer sentences and a cannot-confirm lead makes the whole Q/A uncitable.
- When evidence cannot answer the asked comparison, answer the underlying intent with this product's supported fact; when no supported fact exists, drop the question entirely.
- Product-specific questions must name the exact product instead of using a deictic subject that only points at the product.
- Ask each question in the words a buyer would use to ask it, colloquial phrasing included. A term that exists only in a specification sheet or in an internal classification is not what anyone types, and the first thing an answer engine matches between a query and a page is the wording of the topic itself.
- The opening sentence of an answer must be a complete answer to the question, able to stand alone with nothing before or after it; the sentences that follow qualify or support it. An answer engine lifts a single sentence, so an opening that only leads up to the answer is quoted without the answer.
- Prefer the specific over the general in the question and in the answer alike. A stated figure, condition, or population is the kind of thing an answer cites; a statement that would read the same for a competing product leaves nothing to cite.
- A question that defines this product's own named formula or technology is product-specific and belongs here when the source accounts for it. What is excluded is the category definition whose answer would read the same for any competing product; the test is whether the answer changes when the product changes, not whether the question takes the shape of a definition.

If another document restates or contradicts this contract, this document takes precedence.

## HowTo Contract

- Create HowTo only when the source supplies a concrete goal and at least one direct source action, and do not change its structure.
- One application instruction must become exactly one step; multiple steps require an explicitly ordered source sequence and must preserve its original count/order.
- A frequency note, warning, amount, routine position, test condition, compatibility note, formula technology, measured outcome, or customer-review usage anecdote must never become a step without a direct product instruction.
- Remove source labels such as "How to use", but do not split, merge, or invent actions or add benefits, ingredients, or texture claims.

If another document restates or contradicts this contract, this document takes precedence.

## Schema Safety Contract

- Product highlights, benefit statements, and review-backed positive points must be routed into `Product.description`, `additionalProperty`, and visible benefit sections.
- Do not emit `positiveNotes` on merchant PDP markup — pros/cons structured data is eligible only on editorial review pages, and self-serving merchant pros markup is ineligible.
- `PropertyValue.name` must be a stable property label such as `Target concern`, `Customer review context`, or `Review-derived recommendation context`; do not put a full customer situation phrase or full question in `name`.

If another document restates or contradicts this contract, this document takes precedence.

## Public Wording Contract

- Internal terms that name the generation pipeline or the evidence system must never appear in public schema values or public PDP content.
- Do not expose internal labels such as "evidence signal", "review signals", "main benefit signal", "ingredient signal", "technology signals", "GEO", "RAG", "schema optimization", "citation optimization", "GEO-ready", "PDP name", or "for generative engines" inside public schema/content.
- Keep diagnostic terms in diagnostics only. Do not place diagnostic labels in `WebPage.description`, `Product.description`, `additionalProperty.value`, `FAQPage.mainEntity`, or `HowTo.step`.

If another document restates or contradicts this contract, this document takes precedence.

## Evidence Routing Contract

- If a benefit appears only in review language, it must be phrased as customer-reported experience instead of an objective product effect.
- If a metric, award, dermatologist test, clinical result, or certification has weak support, it must be omitted from public schema/content and the omission must be reported in diagnostics.
- If one OCR string contains multiple independent timings/outcomes plus a shared footnote, it is not an atomic metric; separate evidence atoms must be inferred for each measured endpoint, and the raw string must be retained only as provenance.
- A public efficacy sentence may combine atoms only when their evidence group explicitly shares the institution, dates, population/sample, method, and baseline/comparator.
- Do not extend that shared study context to nearby depth, delivery, layer, formulation-retention, rating, or review values without an explicit source link.
- Each OCR sentence must be classified by intent before generation as ingredient or technology, benefit or effect, usage or routine, or customer/customer review language.
- A clinical or consumer-test metric requires the exact metric, sample, period, method, and caveat as stated in the product source; do not report the metric without them.

If another document restates or contradicts this contract, this document takes precedence.
