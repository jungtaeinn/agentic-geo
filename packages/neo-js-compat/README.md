# neo-js-compat

`neo-js-compat` is the small, dependency-free Python compatibility layer shared by the migrated agents. It preserves observable JavaScript behavior at wire boundaries so a Python implementation does not accidentally change serialized output, numeric formatting, UTF-16 slicing, whitespace handling, or stable keys.

## How it affects results

| Helper group | Preserved behavior | Why agents use it |
| --- | --- | --- |
| JSON and hashes | Compact/pretty JSON bytes, result hashes, and stable serialization ordering. | Wire payloads and snapshot keys remain comparable to the prior contract. |
| Numbers | JavaScript-style parsing, rounding, fixed decimals, and number-to-string formatting. | Scores, labels, and diagnostic text do not drift through Python formatting differences. |
| Strings | JavaScript whitespace, trim, and template-string semantics. | Input cleanup and generated text handling retain boundary behavior. |
| UTF-16 and keys | Code-unit length/slicing, replacement text, FNV-1a variants, and embedding snapshot keys. | Non-BMP text and deterministic cache/snapshot identities remain compatible. |

This package changes representation semantics only. It does not fetch sources, invoke a provider, generate content, validate GEO quality, or decide whether a product claim is supported.

It emits no process Progress events and owns no `diagnostics` fields. The caller that uses a helper remains responsible for evidence provenance, quality gates, user-facing progress, and any warning/reporting contract.

## Configuration and timing

There is no provider, endpoint, credential, page fetch, or model request configuration in this package. The 900-second model-stage floor and short page-fetch limits belong to the extractor/generator layers that call these helpers; `neo-js-compat` adds neither network work nor a timeout policy. Keep the package dependency-free and do not add secret-bearing configuration to it.

## Test

```bash
uv run --package neo-js-compat pytest packages/neo-js-compat/tests -q
uv run ruff check packages/neo-js-compat
```

Tests compare compatibility behavior deterministically and require no live service.
