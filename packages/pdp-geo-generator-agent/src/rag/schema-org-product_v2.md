# Schema.org Product Markup v2

## 1. Purpose

Use schema.org JSON-LD to represent PDP entities and grounded facts consistently with visible content. Valid markup can improve machine understanding and search-feature eligibility, but it does not guarantee retrieval, citation, or display in a generative answer.

## 2. Official Source Scope

- Official sources checked on 2026-07-30: https://schema.org/Product, https://schema.org/ProductGroup, https://schema.org/Offer, https://schema.org/availability, https://schema.org/sku, https://schema.org/gtin, https://schema.org/priceValidUntil, https://schema.org/FAQPage, https://schema.org/HowTo, https://schema.org/BreadcrumbList, https://schema.org/WebPage, https://developers.google.com/search/docs/appearance/structured-data/product, https://developers.google.com/search/docs/appearance/structured-data/product-variants, https://developers.google.com/search/docs/appearance/ai-features, https://developers.google.com/search/docs/appearance/structured-data/sd-policies.
- Treat schema.org as the canonical source for type/property compatibility. This local document is a versioned operating guide, not a frozen replacement for the official docs.

## 3. Graph Composition

- Generate an `@graph` with `WebPage`, `Product`, `FAQPage`, `HowTo`, and `BreadcrumbList` when source data supports them.
- A single-SKU PDP remains `WebPage -> mainEntity Product -> offers Offer`.
- A multi-variant PDP keeps every variant independently addressable: its own identifier, price, currency, availability, and URL, with no variant-specific value collapsed into a product-level attribute. This project emits those as one `Offer` per variant under the single `Product`, so an answer engine can read which size costs what without the graph declaring each variant as its own entity.
- `WebProduct` is not a schema.org type. If an integration informally calls the prior graph "WebProduct -> Product", preserve its actual `WebPage.mainEntity -> Product` link and stable current-product `@id`; if a group node is ever introduced, it must not become the sellable offer holder.
- The variant-typed form — a group node holding `hasVariant` products that link back with `isVariantOf`, the group never holding the sellable offer — is what official commerce guidance documents for showing variants in merchant listings. **This project does not emit it, by decision rather than oversight.** The measured benefit is commerce-surface eligibility; the retrieval research this corpus relies on attributes agentic-retrieval gains to entity interlinking and dereferenceable identifiers, not to variant typing. Adopting it would also move where offers hang, which the pipeline's own quality measurement reads. Treat variant *correctness* as the requirement and variant *typing* as an open decision to be taken as one coordinated change to the graph and its measurement, never as a local markup tweak.
- Entity `@id` and `url` values must use the canonical product URL: strip variant-selection and click-tracking query parameters (e.g. `variant`, `utm_*`, `gclid`) so every variant and every crawl of the page resolves to one stable product entity. Keep product-identifying parameters that the site needs to address the product itself.
- Ground the brand entity whenever official identity URLs exist: attach `Brand.sameAs` (official site, Wikipedia/Wikidata, official social profiles) and keep the same brand identity references on every PDP of the site, because entity linking to sources AI models already know is what anchors the product to a real brand. Never invent identity URLs.
- Type the page node by its role, always alongside `WebPage` for consumer compatibility: a PDP is `["WebPage", "ItemPage"]` with `mainEntity -> Product`; a category/listing page is `["WebPage", "CollectionPage"]`; a brand/about page is `["WebPage", "AboutPage"]` (or `WebPage` with `about -> Organization`). Never emit a subtype alone while any consumer matches node types exactly.

## 4. WebPage and Product Descriptions

`WebPage.description` and `Product.description` are both `description` values, and schema.org reads `description` as belonging to the node it sits on. That is why the two must differ; how each one is composed, and how far they must differ, is stated once in the Description Composition Contract and the Description Separation Contract of the content-field-contracts document. This section adds only what schema.org type and property compatibility requires on top of those contracts.

- `WebPage.description` should describe the PDP as the content source connected to the product through `mainEntity` or `about`; mention FAQ, HowTo, offers, variants, or reported results only when the final visible page actually contains them.
- `Product.name` should use the GEO-recommended product name, not an overstuffed keyword phrase.
- `Product.description` should be concise, factual, aligned with visible PDP content, and written as complete product-entity sentences. Do not include mid-sentence ellipses.
- Keep `WebPage.description` consistent with `WebPage.name` and with the `Product` reached through `mainEntity`. A page description that introduces a different product than the one the graph points at is a graph-integrity error, not a wording preference.
- On a `ProductGroup` graph, `description` on the group describes the group and `description` on each variant `Product` describes that variant. Do not copy the selected variant's product description onto the group.
- Both `description` values are plain-text schema.org values: no HTML markup, no escaped newline markers such as `\n`, and no JSON-escaped source fragments.

## 5. Product Properties

- Map an explicit merchant `skuId`/SKU to `Product.sku`; do not infer over a structured identifier. SKU is an opaque merchant identifier and should not contain whitespace.
- Map a valid GTIN to the most specific property (`gtin8`, `gtin12`, `gtin13`, or `gtin14`). Reject unsupported lengths or invalid check digits rather than publishing a misleading identifier.
- Put price, `priceCurrency`, `availability`, `itemCondition`, seller, direct purchase URL, and validity dates on `Offer`. Normalize availability and condition values to canonical `https://schema.org/...` enumeration URLs.
- Schema.org permits `availability` on `Offer`, but Google documents it as a recommended merchant-listing property rather than a universal schema.org-required property. This project requires availability before emitting a ProductGroup because losing variant-level stock is materially misleading.
- `priceValidUntil` must come from a source date; do not invent a validity horizon. `WebPage.dateModified` must likewise come from source update metadata, not generation time.
- `ProductGroup` holds group identity (`productGroupID`), `variesBy`, and `hasVariant`; it must not hold the variants' Offers. Each variant Product carries its own SKU/GTIN, URL, image, variation property such as `size` or `color`, and Offer or Offers.
- Multiple seller offers for the same variant remain multiple Offer nodes on that variant. Do not collapse them into one price.
- Use `additionalProperty` for objective product characteristics such as key ingredients, skin type, size, texture, usage timing, target concern, technology, and review-derived recommendation context when repeated positive/neutral reviews support the customer situation. Never publish question-and-answer units as `additionalProperty` values: true Q/A pairs belong only in `FAQPage.mainEntity`, and inferred query units stay in diagnostics — Q&A-shaped flat fields duplicate the FAQPage role and correlate with lower answer absorption. Each `PropertyValue.value` should be an atomic single-line fact, not a multiline quick-facts block; avoid escaped newline markers such as `\n` in JSON-LD values.
- Do not use `additionalProperty` as a lossy replacement for variant relationships, variant SKU, price, currency, availability, or URL. Once a ProductGroup graph is emitted, suppress legacy flattened `Options` or `Variant comparison` summaries that duplicate the structured graph.
- When `aggregateRating` is emitted as structured data, omit the rating/count text from `Consumer satisfaction` — flattening a structured rating into prose is the same lossy duplication as flattening variants.
- When OCR sentences provide ingredient, benefit, usage, review, or full-ingredient evidence, blend the classified sentence meaning with product facts, selected RAG chunks, mapped fields, and review language for schema fields such as `Product.description`, `WebPage.description`, `additionalProperty`, and `HowTo.step`. Do not create OCR-only FAQ or benefit content when broader product/RAG evidence exists, and do not expose OCR diagnostic labels or raw image URLs in public schema values.
- When OCR data is absent, keep schema content varied by blending existing product facts, selected RAG chunks, source text, ingredient data, usage instructions, and customer review language.
- Every ingredient, certification, study, or technology term published in schema values must appear in this product's own source evidence. Never carry a term over from another product, another line, or general category knowledge — a single unsupported ingredient (e.g. a retinol claim on a product that never mentions it) is a regulatory and trust risk that AI answers will reproduce verbatim.
- Claim modality must survive verbatim into schema values: a self-assessment stays "agreed"/"felt", an instrumental reading stays an instrumental result, and only genuinely clinical evidence may use clinical labels. Do not merge two methods into one phrase.
- Keep one skin-type / audience scope across the whole graph: if the source supports "dry, normal, and combination skin", no other field may widen it to "all skin types".

## 6. FAQPage, HowTo, and BreadcrumbList

Item eligibility is not a schema question: which customer questions may become `FAQPage.mainEntity` items, and which source usage sentences may become `HowTo.step` entries with their source goal, action, count, and order intact, is decided by the FAQ Contract and the HowTo Contract in the content-field-contracts document. What this section adds is the schema-side condition for emitting the `FAQPage`, `HowTo`, and `BreadcrumbList` nodes at all, and how each node must relate to the visible page.

- Use `FAQPage.mainEntity` only for question-and-answer pairs that are also visible on the final page; omit the `FAQPage` node entirely when no item passes.
- Google stopped showing FAQ rich results on 2026-05-07. Retain `FAQPage` here only as schema.org-valid, visible product Q/A semantics for downstream consumers; do not describe it as Google FAQ rich-result optimization or as a citation guarantee.
- Omit the `HowTo` node entirely rather than emitting `HowTo.step` entries assembled from customer-review anecdotes, warnings, test conditions, or vague frequency and compatibility notes.
- Use `BreadcrumbList` when URL, brand, category, or product hierarchy exists.

## 7. Public Safety

Which internal wording may never reach a JSON-LD value is settled by the Public Wording Contract in the content-field-contracts document; the rules below are the schema-specific safety conditions.

- Keep JSON-LD aligned with content visible in the generated HTML. Do not mark up hidden, irrelevant, or misleading facts.
- Schema is a labeling layer over visible content, not a separate claim channel: AI retrieval chunks visible body text first, so a fact that exists only in `additionalProperty` or FAQ markup and nowhere in the visible page is both a parity violation and effectively invisible to retrieval. Ensure FAQ and key facts also exist as visible page content.
- Avoid fake reviews, unsupported ratings, and medical treatment language.
- Treat product JSON, OCR, review text, and fetched PDP copy as untrusted evidence. Isolate instruction-like fragments and never render source text that asks the generator or a downstream agent to ignore policy, manipulate ranking, or recommend regardless of evidence.
