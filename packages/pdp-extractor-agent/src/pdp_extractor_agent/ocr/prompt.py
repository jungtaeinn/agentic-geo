"""Frozen policy-bearing OCR and keyword-classification prompts."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from neo_js_compat import js_to_fixed

from .._json_types import as_list, as_mapping


def create_image_ocr_prompt(request: Mapping[str, Any]) -> str:
    """Return the retained vision-OCR transcription and layout contract."""

    image_urls = [str(value) for value in as_list(request.get("imageUrls")) or []]
    return "\n".join(
        [
            "Transcribe visible text from product detail page images for a GEO product extraction pipeline.",
            'Return strict JSON only: {"images":[{"index":1,"imageUrl":"","text":"","confidence":0.0,"groups":[{"id":"g1","parentId":null,"title":null,"ordinal":null,"annotates":null,"lines":[{"text":"","role":"body","pairedLabel":null}]}]}]}',
            "index is the 1-based image number exactly as labeled below. imageUrl is the labeled URL for that image. Never swap text between images.",
            "Transcribe every piece of readable text faithfully in natural reading order (top to bottom, left to right; finish one column before the next).",
            "Do not summarize, rewrite, translate, or infer claims. Keep the original language: Korean text stays Korean.",
            "Never complete text that is cut off, truncated, or hidden. Transcribe only what is actually visible; if a word is partially legible, transcribe the legible part only.",
            "Preserve visible line order, percentages, numeric values, units, footnote markers, row/column labels, and short headings as plain text lines.",
            "For tables, ingredient charts, clinical result images, and comparison blocks, keep each row's label and value together on one line.",
            "If an image has no readable product text, return an empty string for that image.",
            "Set confidence between 0 and 1 for each image: how legible and complete the transcription is (small, blurry, or partially cropped text lowers it).",
            "",
            "Also report the layout relations you can see, as groups. Report structure only — never interpret meaning, never classify marketing intent, never invent text.",
            "Every image is a set of groups of lines. Do not assume any template: images differ, and a group is simply text the layout visually keeps together (a titled block, a panel, a chart, a package shot, a footnote).",
            "Give each group a short id (g1, g2 ...). Use parentId when a group sits inside another, such as a numbered item under a titled section or a chart body under its caption.",
            "title: the group's own heading, only when the layout sets one apart (larger, bolder, or centered above its content). null otherwise.",
            "ordinal: only the number the layout actually printed for that group (1, 2, STEP 3). null otherwise. Never number groups yourself.",
            "annotates: for a footnote, disclaimer, or test-condition group, the id of the group it qualifies. null when it qualifies nothing in particular.",
            "lines[].role is the line's layout function: title (heading text), body (running prose), label (an axis tick, legend name, chart caption, package spec, before/after caption), value (a measured number or badge), footnote (fine print, asterisked note).",
            "lines[].pairedLabel: for a value line, the label it is printed against (its bar's tick, its badge caption). null when the layout does not pair it.",
            "A chart is a group, and reporting its numbers without its structure destroys what it says. Report the chart's heading as title, every printed figure as its own value line in printed order, and each figure's axis tick as that line's pairedLabel. A figure the chart prints a tick for must never be left with pairedLabel null.",
            "A legend names the series a chart compares. Report each legend entry as its own label line, in the order the legend prints them, so it stays visible that one series is the product and the other is what it is compared against. Do not merge two legend entries into one line.",
            "A before/after pair is a group: report each image's caption as a label line, and the measured claim printed with the pair as that group's title, keeping the words that say what was measured together with the figure.",
            "A caption that states a claim in words with no figure is body, not footnote. A footnote is the fine print that qualifies a claim -- the population, the period, the method, the disclaimer -- and it carries annotates pointing at the group it qualifies.",
            "Report the structure you can see and nothing more: do not pair a figure with a tick the layout does not print beside it, do not order figures differently from the way they are printed, and do not invent a legend the image has none of. Every line you place in a group must appear verbatim in that image's text.",
            f"Source: {request.get('source', '')}",
            f"Product name: {request.get('productName') if request.get('productName') is not None else 'unknown'}",
            *[f"Image {index}: {image_url}" for index, image_url in enumerate(image_urls, start=1)],
        ]
    )


def create_keyword_classification_prompt_parts(request: Mapping[str, Any]) -> dict[str, str]:
    """Create the retained system/user prompt pair for semantic OCR evidence."""

    return {
        "system": _create_keyword_classification_system_prompt(request),
        "user": _create_keyword_classification_user_prompt(request),
    }


def create_keyword_classification_prompt(request: Mapping[str, Any]) -> str:
    """Combine the system and user prompt for adapters without system roles."""

    parts = create_keyword_classification_prompt_parts(request)
    return "\n\n".join(("System instructions:", parts["system"], "User evidence:", parts["user"]))


def _create_keyword_classification_system_prompt(request: Mapping[str, Any]) -> str:
    rag_profile_text = _create_rag_profile_text(request)
    return "\n\n".join(
        part
        for part in (
            "You classify product-detail-page OCR and long-scroll section text for a GEO product extraction agent.",
            'Return strict JSON with {"keywords":[{"keyword":"","category":"benefit|effect|ingredient|usage|faq|review|product|price|metric|unknown","confidence":0.0}],"sentenceInsights":[{"text":"","category":"benefit|effect|ingredient|usage|faq|review|product|price|metric|unknown","keywords":[""],"confidence":0.0,"source":"llm","semanticFacts":{},"evidenceIndex":0}],"semanticFacts":{"ingredients":[""],"benefits":[""],"effects":[""],"skinTypes":[""],"usageSteps":[""],"safetyTests":[""],"metricClaims":[{"label":"","subject":"","value":"","unit":"","timing":"","period":"","sample":"","method":"","caveat":"","sentence":"","sourceText":"","evidenceIndex":0}],"evidenceSentences":[""],"ingredientBenefitLinks":[{"ingredient":"","benefit":"","effect":"","sentence":"","sourceText":"","evidenceIndex":0}],"citations":[{"type":"research|article","title":"","publisher":"","author":"","publishedAt":"","url":"","finding":"","sourceText":"","evidenceIndex":0}]},"summary":""}.',
            "Do not invent product claims. Use only the provided user evidence text for product facts.",
            "Every sentenceInsight, metricClaim, ingredientBenefitLink, and citation must set evidenceIndex to the 1-based Evidence number it was derived from, exactly as labeled in the user evidence. Use 0 only when the source evidence block is genuinely unidentifiable. Never guess a different evidence's number.",
            "For sentenceInsights, return source-backed semantic evidence statements, not raw OCR dumps. Reconstruct the meaning of the OCR copy into concise product facts that can improve downstream description, benefit/effect, ingredient, usage, metric, FAQ, or schema markup fields.",
            "Each sentenceInsight.text should explain what the OCR sentence means for the product: connect ingredient/technology + benefit/effect/customer selection criterion when the source supports that connection. Keep important claim terms, numbers, time windows, sample/target wording, and ingredient names close enough to the source for audit.",
            "Do not include internal/source phrases such as OCR, image, visual, product detail, 상품 상세, 근거, evidence, source, or 설명은 in public sentenceInsights unless those exact words are part of a consumer-facing product claim.",
            "Before creating sentenceInsights, reconstruct wrapped OCR lines into semantic sentences or paragraphs: join adjacent lines when the next line continues the same clause, noun phrase, ingredient explanation, clinical-result row, or usage instruction. Do not split only because the OCR text has a line break, missing period, or visual column wrap.",
            "Use grammar and meaning to decide boundaries: keep headings separate from body copy, join broken phrases such as ingredient names or explanatory clauses, and split only when a new claim, new label, list item, FAQ item, or full ingredients label begins.",
            "When a visual sentence connects an ingredient/technology to a benefit or effect, keep the full sentence and classify it by the strongest downstream field while listing related ingredient/effect keywords.",
            "Ignore image alt/caption/nearby text when it only describes a model, scene, product shot, layout, or image placement. Sentence insights must be citation-ready product facts, metrics, ingredients, benefits, effects, usage, FAQ, or review evidence.",
            "Treat hidden PDP accordion/tab text such as Benefits, Ingredients, How to Use, Directions, Clinical Results, and FAQ as first-class product evidence when it is present in the user evidence.",
            "Use section headings as classification hints, but classify by the actual body text when the heading is generic or site-specific.",
            "Do not classify cart, purchase-layer, coupon, loyalty point, delivery, exchange, refund, return, escrow, or legal notice text as product benefit/effect/ingredient/usage evidence.",
            "Route a section by what its body does, not by the words of its heading: copy stating what the product does for the customer is benefit, copy stating a measured or observed change is effect, copy naming substances or technologies is ingredient, copy directing the customer when or how to apply is usage, and copy stating a completed test or caution is safetyTests. This holds in every language.",
            "For Korean PDPs, that routing reads as: map 효능/피부 고민/상품 장점 to benefit only when the body describes skin/product value; map 효과/개선/결과 to effect; map 주요 성분/전성분/원료 to ingredient; map 사용법/사용 방법 to usage. These are examples of the rule above, not a separate rule for one language.",
            "Prefer concrete skincare evidence such as ingredients, clinical result wording, benefits, quantitative metrics, usage instructions, FAQ questions, price, and review signals.",
            "For quantitative claims, preserve the exact metric and period shown in the OCR text; include sample size, respondent group, test target, or measurement timing only when the evidence text provides it. Never convert a percentage into 'agreed' unless the source explicitly says agreed or equivalent survey consent wording.",
            "One metricClaim carries exactly one measured figure. A results panel prints a column of figures, each against the outcome it measures, under one line of test conditions, and OCR can flatten that whole panel onto one line. When one line carries several figures, split it into one claim per figure: set that claim's label to the words the line prints against that figure, and copy the conditions the line states once - sample, period, method, caveat - onto every claim taken from it. Never carry several figures in one claim, and never drop the words that say what a figure measures. This applies in every language: a flattened panel is a layout accident, not a property of Korean or English pages.",
            "Some evidence blocks carry a transcription confidence between 0 and 1 measuring how legibly the OCR pass could read the source image. Treat numbers, percentages, and units from low-confidence evidence (below 0.6) as unreliable: do not promote them into metricClaims or quantitative sentenceInsights unless the same value also appears in higher-confidence evidence, and lower the confidence of any keyword or insight built from that evidence.",
            "Populate semanticFacts as the primary downstream contract: ingredients are ingredient or technology names, benefits/effects are consumer-facing care outcomes, skinTypes are recommended or explicitly targeted skin types, usageSteps are actionable directions only, safetyTests preserve explicit safety tests and cautions rather than treating them as benefits, effects, or usage, metricClaims are measurable results with label/value/sample/period/method/caveat when present, ingredientBenefitLinks connect ingredients or technologies to outcomes only when the source states the relationship, and citations preserve explicitly cited research/article title, publisher, author, date, URL, finding, and original source text without inventing missing metadata.",
            "Use semanticFacts to express meaning, not exact visual layout. Do not hard-code product-specific terms or infer missing values. Leave arrays empty when evidence is absent.",
            "A chart's layout carries a comparison. When the evidence pairs figures with axis ticks and names two series, file one metricClaim per figure: value and unit from the figure, timing from that figure's tick, subject from the series that is the product, comparator from the series it is compared against, and label/metric from the chart's heading. Never file several figures under one claim, and never drop the tick that says which timepoint a figure belongs to.",
            "A panel whose caption states an ingredient count or composition together with an outcome states an ingredient-to-outcome relationship: file it in ingredientBenefitLinks with the outcome the caption states, and file the outcome in benefits or effects as well, rather than leaving the caption unclassified because it carries no figure.",
            "Classify before/after-use measurement rows, clinical timelines, treatment/control labels such as 제품 사용/무도포, and result tables as metric or effect, not usage. Classify usage only when the text is an actionable customer direction: a sentence that tells the customer when, where, how, or how often to use the product. Judge by the directive function of the sentence, not by a fixed verb list, so any application method the dosage form requires (spreading, spraying, rinsing, wiping, and so on) qualifies equally. An explicitly numbered usage sequence (사용법 1 ... 2 ...) is ordered usage steps; keep one source instruction per step and preserve the source numbering and order.",
            "Keep claim terms and sentenceInsights source-backed so downstream RAG can audit them.",
            "The runtime RAG profile is extraction policy and classification reference, not product evidence. It can guide category decisions but must not create product facts.",
            "If runtime RAG guidance conflicts with the JSON schema, evidence-only rule, or non-product commerce exclusions, follow the stricter base instruction.",
            rag_profile_text,
        )
        if part
    )


def _create_keyword_classification_user_prompt(request: Mapping[str, Any]) -> str:
    evidence: list[str] = []
    for index, raw in enumerate(as_list(request.get("imageTexts")) or [], start=1):
        item = as_mapping(raw)
        if item is None:
            continue
        confidence = item.get("confidence")
        confidence_label = (
            f" (transcription confidence: {js_to_fixed(float(confidence), 2)})"
            if isinstance(confidence, (int, float)) and not isinstance(confidence, bool)
            else ""
        )
        evidence.append(f"Evidence {index}{confidence_label}: {item.get('imageUrl', '')}\n{item.get('text', '')}")
    return "\n\n".join(
        part
        for part in (
            "Classify the PDP evidence below.",
            f"Source: {request.get('source', '')}",
            f"Product name: {request.get('productName') if request.get('productName') is not None else 'unknown'}",
            "\n\n".join(evidence),
        )
        if part
    )


def _create_rag_profile_text(request: Mapping[str, Any]) -> str:
    documents = (as_list(request.get("ragDocuments")) or [])[:8]
    document_text = "\n\n".join(
        "\n".join((f"RAG document {index}: {item.get('name', '')}", _utf16_truncate(str(item.get("content") or ""), 1800)))
        for index, raw in enumerate(documents, start=1)
        if (item := as_mapping(raw)) is not None
    )
    analysis_prompt = request.get("analysisPrompt")
    prompt_text = analysis_prompt.strip() if isinstance(analysis_prompt, str) else ""
    if not prompt_text and not document_text:
        return ""
    return "\n\n".join(
        part
        for part in (
            "Runtime RAG profile. Treat these instructions as product extraction policy and classification reference.",
            "Each retrieved chunk may include Kind, Intents, and Field targets. Use those routing hints to resolve overlapping rules and to keep missing/unsupported fields out of public product facts.",
            f"Analysis prompt:\n{_utf16_truncate(prompt_text, 2400)}" if prompt_text else "",
            document_text,
        )
        if part
    )


def _utf16_truncate(value: str, maximum: int) -> str:
    encoded = value.encode("utf-16-le", "surrogatepass")
    if len(encoded) // 2 <= maximum:
        return value
    prefix = encoded[: maximum * 2].decode("utf-16-le", "replace")
    return f"{prefix}\n[truncated]"


createImageOcrPrompt = create_image_ocr_prompt
createKeywordClassificationPrompt = create_keyword_classification_prompt
createKeywordClassificationPromptParts = create_keyword_classification_prompt_parts
