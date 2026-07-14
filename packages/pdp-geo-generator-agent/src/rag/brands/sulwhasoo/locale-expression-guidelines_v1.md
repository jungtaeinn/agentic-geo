# Sulwhasoo Locale Expression Guidelines v1

This brand-scoped locale guide extends the default `locale-expression-guidelines_v1.md` for Sulwhasoo PDP GEO generation. Use it only when the normalized product brand, hint, or product name maps to Sulwhasoo / 설화수. When active, it replaces the default locale expression guide; general schema, E-E-A-T, CEP, GEO research, official-docs, best-practice, and terminology guidance still apply.

## Brand-Specific Locale Overlay

- `ko-KR`: Prefer refined premium skincare language such as 인삼 과학, 피부 생명력, 탄력, 윤기, 리추얼, 고급스러운 사용감, 피부 균형 when supported. Avoid 과도한 한방 치료, 회춘, 영구 개선, 의학적 효능 unless the source explicitly supports a compliant claim.
- `ja-JP`: Prefer elegant, benefit-oriented wording such as 高麗人参, ハリ, つや, 肌の生命感, 上質な使い心地, スキンケアリチュアル when supported. Avoid 治療, 若返り, 永久的改善, 医薬品-like claims.
- `en-US`: Prefer premium but clear wording such as Korean ginseng science, skin longevity, radiance, firmness, refined ritual, nourishing texture, visible vitality when supported. Avoid rejuvenation as guaranteed age reversal, cure, clinical certainty, and exaggerated heritage claims.
- `en-GB`: Prefer polished premium wording such as Korean ginseng science, radiance, firmness, refined ritual, skin resilience, and nourishing texture when supported.

Sulwhasoo's current US output contract is `en-US`:

- Use official US product and ingredient names where the source provides them. Keep the tone refined but concrete enough that a sentence can answer a customer question without surrounding copy.
- Prefer `[Exact product name] includes ...` for the primary composition statement rather than `The formula includes ...`, because the exact entity should remain clear when a generative engine extracts the sentence.
- State `X supports Y` only when the current product source explicitly links X and Y. Otherwise use separate composition and finished-product benefit sentences.
- Write study context as fluent prose, for example `In a clinical study conducted by [institution] from September 15, 2025 to October 14, 2025 involving [population], [metric] was measured at [value] before use, [value] immediately after use, and [value] 12 hours after use.` Preserve dates, population qualifiers, values, units, and time points.
- Use `reported clinical study results` for valid finished-product PDP evidence. Reserve `published`, `publication`, and `peer-reviewed` for an actual research citation with matching bibliographic support.
- In product-specific FAQ, name the exact product. Prefer `What are the main benefits of [Product name], and what do the reported clinical study results show?` only when finished-product clinical evidence exists; otherwise ask the benefits question without an evidence clause. Avoid `what product evidence supports them?`.
- In FAQ answers, use the most relevant clinical outcome as support for the customer-facing benefit instead of appending raw institution/date/population/method/result fields. Prefer direct product and recommendation voice over `is described as`, `is explained as`, or other observer wording.

## Base Locale Expression Model

## 1. Purpose

Use locale and market rules to choose natural PDP wording.

## 2. Locale Rules

- `ko-KR`: Prefer concise PDP commerce language. Use 보습, 수분감, 탄력, 피부 장벽, 피부결, 사용감, 흡수감 when supported. Avoid 치료, 완치, 의학적 효능 unless explicitly regulated evidence is present.
- `ja-JP`: Prefer softer, benefit-oriented wording. Use 保湿, うるおい, ハリ, キメ, 肌なじみ, 敏感肌にも使いやすい when supported. Avoid 治療, 完治, 医薬品-like claims unless source data permits.
- `en-US`: Prefer clear benefit wording. Use hydration, moisture, firming, skin barrier, even-looking tone, lightweight feel, rich texture when supported. Avoid cure, treat disease, guaranteed results, and overclaiming.
- `en-GB`: Prefer moisturising, skin barrier support, even-looking tone, and routine-friendly phrasing when supported.

## 3. Cross-Locale Guardrails

- Keep product names readable. Do not overload names with every benefit keyword.
- Keep FAQ questions in the customer's likely search language for the target locale.
- Apply preferred terms after source-backed content is composed, then remove avoided medical or exaggerated terms.
