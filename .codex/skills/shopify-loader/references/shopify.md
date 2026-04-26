# Shopify Loader Reference

## Environment variables

- `SHOPIFY_STORE_DOMAIN`
  Example: `your-store.myshopify.com`
- `SHOPIFY_ADMIN_ACCESS_TOKEN`
  Admin API access token for a custom app
- `SHOPIFY_CLIENT_ID`
  App client ID from the Shopify Dev Dashboard
- `SHOPIFY_CLIENT_SECRET`
  App client secret from the Shopify Dev Dashboard
- `SHOPIFY_API_VERSION`
  Example: `2025-01`
- `SHOPIFY_REFUND_ROUTE_SECRET`
  Shared bearer token for server-to-server calls to `POST /api/orders/shopify-refund`

## Recommended pattern

1. Build the Admin API URL with the configured API version.
2. Use a server-side access token only. Do not expose credentials in browser code.
3. Normalize the Shopify response into the shape the UI actually needs.
4. Never crash the page for missing config; return a structured error payload instead.

## Why this implementation mixes REST and GraphQL

The current `/transfers` implementation uses both Admin REST and Admin GraphQL:

- REST Orders API for the initial order list
  - easier bulk pagination for open unfulfilled orders
  - straightforward `fields` filtering
- GraphQL for status and inventory enrichment
  - `Order.displayFulfillmentStatus` is more reliable than REST fulfillment fields for excluding `IN_PROGRESS`
  - `ProductVariant -> inventoryItem -> inventoryLevels` is the practical path for location-aware stock

Use the same split unless there is a strong reason to rewrite the flow fully in GraphQL.

## Auth

- If `SHOPIFY_ADMIN_ACCESS_TOKEN` is available, send it as `X-Shopify-Access-Token`.
- For stores owned by the same organization, `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` can be exchanged at `POST https://{shop}.myshopify.com/admin/oauth/access_token` with `grant_type=client_credentials`.
- Tokens from the client credentials grant expire after 24 hours, so server code should be ready to refresh them.
- A Dev Dashboard app client secret is not itself an Admin API token. It must be exchanged for one first.
- Draft order creation requires `write_draft_orders` or `write_quick_sale`, plus a user/app context that can manage draft orders.
- Completing a draft into a real order uses `draftOrderComplete(id: ...)` after `draftOrderCreate`.
- Discount code lookup with `codeDiscountNodeByCode` requires `read_discounts`.
- Refunding a Shopify order by order number uses Admin GraphQL `orders(query: "name:#1234")` followed by `refundCreate`. The endpoint is `POST /api/orders/shopify-refund`, is protected by the normal admin session cookie or `Authorization: Bearer $SHOPIFY_REFUND_ROUTE_SECRET`, and currently performs full refunds by sending all refundable line items, `shipping: { fullRefund: true }`, and `transactions: []` so Shopify determines the payment allocation. This uses the existing `api/orders.js` Vercel function through a rewrite to stay under the Hobby function limit.
- The Shopify More actions refund app is a UI extension at `extensions/rb-refund-stripe` targeting `admin.order-details.action.render`. It adds `RB refund stripe` on order details, opens as a Shopify Admin action modal, and submits to `POST /api/shopify/refund-action`; the route is hosted by the same Vercel app and reuses `api/orders.js` through rewrites. Modal requests authenticate with Shopify's Admin UI extension bearer/session token, which Shopify attaches to extension backend fetches and the backend verifies with `SHOPIFY_CLIENT_SECRET`/`SHOPIFY_API_SECRET` and `SHOPIFY_CLIENT_ID`; the legacy `/shopify/refund` fallback page still verifies Shopify's signed `hmac` launch query.
- Admin UI extension fetches should use the configured app origin (`shopify.app.toml` `application_url`) instead of a relative URL. Relative paths can resolve inside Shopify's extension sandbox and fail with a browser-level `Load failed` before the Vercel endpoint is reached.
- The refund action endpoint must answer CORS preflight (`OPTIONS`) through the same `api/orders.js` wrapper used by Vercel rewrites; otherwise Shopify Admin sees only `Load failed` and never receives the backend JSON reason.
- The More actions modal should match the selected Shopify order to a saved IVR dashboard order and refund the saved Stripe payment through the same code path as the dashboard refund button. Do not switch this modal back to a plain admin link or to Shopify-only `refundCreate` unless the user explicitly wants that behavior.
- The shared Stripe refund path now records the successful Stripe refund locally, then tries to create a manual Shopify refund record with Admin GraphQL `refundCreate` using all refundable line items, shipping, and a manual `REFUND` transaction for the Stripe refund amount. If Shopify marking fails after Stripe succeeds, save `shopifyRefundMarkError` instead of failing the whole request, so the user does not retry and accidentally double-refund in Stripe.
- For configured Shopify API versions `2026-01` and newer, `refundCreate` should include an `@idempotent(key: ...)` directive. Shopify makes this required in `2026-04`; keep the directive conditional so older configured versions such as `2025-01` still work.
- Dashboard cancellation uses Admin GraphQL `orderCancel` with `refundMethod.originalPaymentMethodsRefund: false`, polls the returned async job with the root `job(id: ...)` query (do not use `node(id:)` for `Job`), then attempts `orderClose` (`OrderCloseInput.id`) to archive/close the canceled order. If closing fails after cancellation succeeds, preserve the cancellation and save the close error on `shopifyCancellation.closeError`.
- Debug the refund app with `GET /shopify/debug` or JSON at `GET /api/shopify/debug`. The debug route is hosted by the same Vercel app through the existing `api/orders.js` wrapper and shows Shopify launch HMAC status, expected extension config, environment presence, and Vercel function count without exposing secret values.
- Refund app scopes should include `read_orders` and `write_orders`.

## Unfulfilled orders

For unfulfilled orders, use the Orders Admin API and request:

- `status=open`
- `fulfillment_status=unshipped`

Select only the needed fields to keep the payload smaller:

- order id / name
- created time
- customer and shipping data
- fulfillment and financial status
- line items and SKUs
- tags and note

Current REST request in this repo:

- Endpoint:
  - `GET https://{store}/admin/api/{apiVersion}/orders.json`
- Query params:
  - `status=open`
  - `fulfillment_status=unfulfilled`
  - `limit=250`
  - `fields=id,name,created_at,email,phone,customer,fulfillment_status,financial_status,display_fulfillment_status,current_total_price,currency,source_name,line_items,shipping_address,tags,note`

Pagination behavior:

- Read the `Link` header from each response
- follow `rel="next"` until exhausted
- merge all `orders` arrays before normalization

Required scopes:

- `read_orders`
- `read_all_orders` if the app must see orders older than Shopify's default recent-order window

Implementation note:

- Even when querying `fulfillment_status=unfulfilled`, Shopify responses can still include orders whose display status is `partial`. Filter those out server-side if the UI should show only fully unfulfilled orders.
- Shopify GraphQL `Order.displayFulfillmentStatus` is a more reliable final filter than the REST order fulfillment fields for excluding admin-side `IN_PROGRESS` orders such as `#330572`.
- Inventory location names visible on inventory levels can differ from the simpler location list returned elsewhere. In this store, `PIO - A . I . S T O N E` appears on inventory levels even though an earlier location list check only surfaced `Lakewood`, `Jackson`, and `Digital Goods`.

Current GraphQL order-status query:

```graphql
query OrderStatuses($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Order {
      id
      legacyResourceId
      displayFulfillmentStatus
      fulfillmentOrders(first: 10) {
        nodes {
          id
          status
          assignedLocation {
            location { name }
          }
        }
      }
    }
  }
}
```

Batching rule in current code:

- batch `Order` IDs in groups of `100`
- send them as `gid://shopify/Order/{id}`
- map `legacyResourceId -> { displayFulfillmentStatus, assignedLocations }`
- keep only orders where status is exactly `UNFULFILLED`

Assigned location rule:

- For this store, the order's fulfillment location is determined from `fulfillmentOrders.nodes[].assignedLocation.location.name`
- `#329634` verified as `assignedLocation = Lakewood` even while its raw tags remained `PIO - A . I . S T O N E`
- Do not use tags as the source of truth for order location when fulfillment-order location is available

## Inventory by location

To show stock by fulfillment location for order items:

1. Load the relevant orders first.
2. Collect unique `variant_id` values from the line items.
3. Query Shopify GraphQL for those `ProductVariant` nodes and read `inventoryItem.inventoryLevels`.
4. Normalize `available` quantities by location name.
5. For this store, track at least:
   - `Lakewood`
   - `PIO - A . I . S T O N E`

Current GraphQL inventory query:

```graphql
query VariantInventory($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on ProductVariant {
      id
      legacyResourceId
      inventoryItem {
        id
        inventoryLevels(first: 20) {
          nodes {
            location { name }
            quantities(names: ["available", "on_hand", "committed", "incoming"]) {
              name
              quantity
            }
          }
        }
      }
    }
        }
      }
```

## Pre-order SKU cache

For IVR pre-order validation in this repo:

1. Treat the Shopify product tag `pre-order` as the source-of-truth tag.
2. Do not check live stock for this flow.
3. Download the tagged product variant SKUs once per day and cache only the minimal lookup data the app needs.
4. Compare the IVR-generated SKU to that local cache instead of shipping the full product listing to the client.

Current implementation notes:

- Query Shopify GraphQL `products` with `query: "tag:pre-order"`.
- Request only product title plus variant `sku`.
- Cache only:
  - `tag`
  - `refreshedAt`
  - `skuCount`
  - `entries[] = { sku, normalizedSku }`
- In this store, the pre-order variants can differ from IVR-built SKUs in two practical ways:
  - segment order can vary, such as `PKT-DP` vs `DP-PKT`
  - some mens pre-order products use `J` in the second prefix position, such as `MJCC...`, while the IVR builds `MTCC...`
- Normalize for matching by:
  - uppercasing
  - mapping prefix position 2 `J -> T`
  - mapping middle token `SP -> DP`
  - sorting the middle SKU segments before comparison
- Live Shopify verification on April 15, 2026 confirmed that boys and short-sleeve preorder shirts are real catalog options, not dead IVR branches:
  - boys preorder variants: `462`
  - boys sizes: `4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 22`
  - boys short-sleeve variants: `156`
  - boys standard preorder variants are cutaway and without pocket
  - boys chassidish preorder variants are pointy and with pocket
  - boys SKU shapes use a separate `SP` middle token with a size-only final segment, for example `BTPC-ROL-SS-PKT-SP-4`
  - mens short-sleeve preorder variants also exist, so do not prune short sleeve from the IVR
- The IVR option menus should filter each next choice against the cached preorder variant SKUs. For example, after a caller selects a neck size/sleeve/fit/pocket combination where french cuff has no matching preorder SKU, the cuff menu should only offer button cuff and should reject french cuff if entered.

Live verification on April 14, 2026:

- `pre-order` matched the actual preorder shirt catalog
- `Availability_Pre Order` and `sd_preorder` were not the source-of-truth tags for this IVR flow
- `draftOrderCreate` is currently blocked by the active token scopes in this repo until Shopify access includes `write_draft_orders`

## IVR draft orders

The IVR confirm step in this repo now creates Shopify draft orders instead of only saving local records.

Current implementation:

- Before payment/final submission, the IVR tries to find a saved address by phone using the Admin GraphQL `customers` query and the `phone:` filter, for example `query: "phone:+18005550100"`.
- Customer lookup requests need customer read access (`read_customers`) and request `defaultPhoneNumber`, `defaultAddress`, and `addresses`; if no customer address exists, fall back to recent order `shippingAddress`, then recent order `billingAddress` using order read access (`read_orders`).
- Because Shopify phone search can return broad results, the IVR must only trust a returned customer/order address when the returned customer phone, order phone, shipping address phone, or billing address phone exactly matches the lookup phone after normalization.
- If a saved address is found, the caller can use it, speak a different address, or try another phone number. Another lookup phone is stored with `linkedCallerPhone` so staff can see which call-in number used it.
- Structured Shopify customer addresses are passed into `draftOrderCreate.shippingAddress`; spoken free-form addresses are stored on the local order record and included in draft order notes/custom attributes for staff review.
- When phone lookup returns an exact Shopify customer match, keep the customer metadata on the session shipping address even if the customer has no saved address. Draft order creation should attach that customer with `DraftOrderInput.purchasingEntity.customerId` rather than the deprecated top-level `customerId`, and may still send an explicit `shippingAddress` when the caller supplies or confirms one.
- match the IVR cart line to a cached preorder Shopify variant
- keep `variantId`, `sku`, and Shopify `price` in the preorder cache
- create a draft order with:
  - variant-backed `lineItems`
  - tag `ivr`
  - note containing the caller phone number
  - `customAttributes` including caller phone, call sid, and local IVR order id
  - optional `discountCodes` when the caller provides one
- optionally complete the draft order into a real Shopify order when the persisted `submitShopifyOrder` setting is enabled
- dashboard refund first refunds the stored Stripe PaymentIntent through Stripe, then creates a manual Shopify refund record with Admin GraphQL `refundCreate`; dashboard cancel cancels with `orderCancel`, `refundMethod.originalPaymentMethodsRefund: false`, and then attempts `orderClose` so the canceled order is archived/closed without sending a second refund through Shopify's original payment methods

Submission toggle behavior:

- default setting comes from `SHOPIFY_SUBMIT_SHOPIFY_ORDER`
- runtime overrides are stored in `data/app-config.json` locally
- on Vercel, runtime overrides are stored in Blob at `ivr-config/app-config.json`
- the `/testivr` page reads and updates this setting through `/api/testivr/settings`

Current pricing approach:

- the IVR subtotal uses the matched Shopify variant prices
- coupon codes are collected immediately after the caller presses 1 to order shirts unless a code is already saved for that caller phone number
- normalize entered coupon codes by keeping digits only
- if `read_discounts` is available, look up the code with `codeDiscountNodeByCode`
- if `read_discounts` is not available, preserve the entered code and still attach it to the draft order for later analysis

Batching rule in current code:

- batch `ProductVariant` IDs in groups of `50`
- send them as `gid://shopify/ProductVariant/{variantId}`
- map `legacyResourceId -> inventory levels by location name`
- normalize only the named locations the UI currently needs

Practical note:

- A useful transfer filter here is: item not available in `Lakewood`, and item available in `PIO - A . I . S T O N E`.
- In the current implementation, expose this stock data on each normalized line item as:
  - `item.stock.lakewood.available`
  - `item.stock.lakewood.onHand`
  - `item.stock.lakewood.committed`
  - `item.stock.pio.available`
  - `item.stock.pio.onHand`
  - `item.stock.pio.committed`
- Also expose `order.isLakewoodTagged` as a boolean derived from the order tags.
- Also expose:
  - `order.assignedLocations`
  - `order.primaryAssignedLocation`

Current normalized `/api/transfers` order shape:

```json
{
  "id": 11226996375915,
  "name": "#330572",
  "createdAt": "2026-03-29T19:23:04-04:00",
  "customerName": "Jennifer Pollock",
  "fulfillmentStatus": "unfulfilled",
  "financialStatus": "authorized",
  "totalPrice": 329.94,
  "currency": "USD",
  "sourceName": "shopify_draft_order",
  "shippingName": "Jennifer Pollock",
  "city": "Atlanta",
  "province": "Georgia",
  "tags": "PIO - A . I . S T O N E",
  "note": "",
  "isLakewoodTagged": false,
  "itemCount": 4,
  "items": [
    {
      "id": 33998789083499,
      "title": "Mens Twill Cutaway Collar Extra Slim Fit French Cuff",
      "variantTitle": "14 32",
      "sku": "MTCE-FC-DP-1432",
      "quantity": 2,
      "variantId": 9001247965220,
      "stock": {
        "lakewood": {
          "available": 142,
          "onHand": 142,
          "committed": 0
        },
        "pio": {
          "available": 0,
          "onHand": 3,
          "committed": 3
        }
      }
    }
  ]
}
```

Implementation details:

- if a variant has no matching inventory node, the normalized stock object should still be safe to read
- missing location quantities normalize to `0`
- `Lakewood` and `PIO - A . I . S T O N E` are keyed in the UI as `lakewood` and `pio`

## Transfers UI behavior

The current `/transfers` page uses two views backed by the same `/api/transfers` payload:

- `Orders` tab
  Shows the compact order cards without inventory detail.
- `Stock` tab
  Shows the same orders filtered down to stock-aware line items with Lakewood and PIO quantity pills.

Current stock filter:

- `Not in stock in Lakewood but in stock at PIO`
- Logic:
  - `order.primaryAssignedLocation === "Lakewood"`
  - `item.stock.lakewood.available <= 0`
  - `item.stock.pio.available > 0`

Verified result during implementation:

- `/api/transfers` returned 30 qualifying orders
- 54 line items had stock data
- 2 line items matched the Lakewood/PIO transfer filter at the time of verification

## Additional GraphQL checks used during implementation

These checks were useful while building and debugging:

- location inventory probe on a real order item
  - confirmed that `PIO - A . I . S T O N E` appears on `inventoryLevels`
- one-off order check for `#330572`
  - GraphQL returned `displayFulfillmentStatus: IN_PROGRESS`
  - REST order filters alone were not enough to exclude it
- location listing query
  - top-level location queries showed `Lakewood`, `Jackson`, and `Digital Goods`
  - inventory-level location data exposed `PIO - A . I . S T O N E`, so do not assume the simpler location list is the whole story

## Pagination

1. Read the `Link` header from Shopify.
2. Follow `rel="next"` links until exhausted.
3. Merge and normalize all pages before returning.

## Security

- Keep tokens in environment variables only.
- Do not expose the Admin API token to browser code.
- For browser pages, fetch through server endpoints such as `/api/transfers`.
