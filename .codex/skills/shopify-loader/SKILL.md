---
name: shopify-loader
description: Load Shopify data for this project using the Admin API. Use when Codex needs to fetch orders, products, customers, or other Shopify resources, especially for new site endpoints like /transfers that should read directly from Shopify with store domain, admin token, and API version environment variables.
---

# Shopify Loader

Use this skill for Shopify Admin API work in this repo.

Read [references/shopify.md](references/shopify.md) for:

- required environment variables
- recommended request shape for Shopify Admin API
- unfulfilled order loading for `/transfers`
- inventory-by-location loading for `/transfers`
- stock tab and Lakewood/PIO filter behavior
- pagination and failure handling guidance

## Rules

1. Keep Shopify integration isolated from the IVR flow unless the user explicitly asks to connect them.
2. Prefer server-side fetches with `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ADMIN_ACCESS_TOKEN`, and `SHOPIFY_API_VERSION`.
3. Return normalized JSON from API routes and render UI pages separately.
4. For missing credentials, return a clear non-crashing response that explains what env vars are missing.
5. When extending `/transfers`, preserve the split between the `Orders` tab and the inventory-aware `Stock` tab instead of mixing stock logic into the default order view.
