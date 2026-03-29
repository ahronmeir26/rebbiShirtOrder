---
name: shirt-sku-rules
description: Decode and compose shirt SKUs from the store's custom parser rules. Use when Codex needs to explain what a shirt SKU means, infer a SKU prefix from spoken attributes, or map product filters like mens, twill, spread, extra slim, white, size, sleeve, cuff, and color to SKU segments.
---

# Shirt SKU Rules

Use this skill when working with the store's custom shirt SKU scheme. Interpret user phrases into SKU components, or decode an existing SKU into plain-English product attributes.

Read [references/sku-rules.md](references/sku-rules.md) for:

- segment-by-segment decoding rules
- default behaviors such as white when no `CNT...` segment exists
- size and sleeve parsing rules from the last SKU segment
- optional flags such as `FC`, `PKT`, `ROL`, `CLN`, `DP`, `STRETCH`, and `SS`
- worked examples

## Workflow

1. Break the SKU into its fixed prefix and optional hyphen-delimited flags.
2. Decode the first four characters as `category`, `fabric`, `collar`, and `fit`.
3. Decode optional flags and color segments.
4. Parse the last segment for neck size and sleeve length.
5. If the request is phrased in plain English, build the matching SKU prefix first, then note which details still require size, sleeve, or option flags.

## Output Rules

- State when an answer is exact versus partial.
- Treat missing `CNT...` color segments as white.
- Treat `SS` as short sleeve and override normal sleeve-length parsing.
- Mention when the parser treats a value as inferred rather than explicit.

## Quick Example

`mens twill spread extra slim white shirt` maps to the prefix `MTSE`.
