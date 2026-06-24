# FAQ Extraction v1

## 1. Purpose

Extract FAQ content only when both question and answer are available.

## 2. Source Priority

1. Accept explicit FAQPage JSON-LD first.
2. Accept DOM sections with question-style headings and nearby answer text.
3. Accept hidden accordion/tab FAQ content when the answer is product-specific and source-backed.

## 3. Pairing Rules

- Extract FAQ content only when both question and answer are available.
- Keep each answer short and factual.
- Preserve enough source wording for downstream GEO agents to reconstruct answer-ready FAQ.

## 4. Rejection Rules

- Avoid turning marketing slogans into FAQs.
- Do not invent answers from headings alone.
- Do not convert shipping, return, exchange, coupon, or legal policy copy into product FAQ unless the product source explicitly frames it as product-specific decision support.
