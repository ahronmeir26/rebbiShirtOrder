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

## Recommended pattern

1. Build the Admin API URL with the configured API version.
2. Use a server-side access token only. Do not expose credentials in browser code.
3. Normalize the Shopify response into the shape the UI actually needs.
4. Never crash the page for missing config; return a structured error payload instead.

## Auth

- If `SHOPIFY_ADMIN_ACCESS_TOKEN` is available, send it as `X-Shopify-Access-Token`.
- For stores owned by the same organization, `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` can be exchanged at `POST https://{shop}.myshopify.com/admin/oauth/access_token` with `grant_type=client_credentials`.
- Tokens from the client credentials grant expire after 24 hours, so server code should be ready to refresh them.
- A Dev Dashboard app client secret is not itself an Admin API token. It must be exchanged for one first.

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

Required scopes:

- `read_orders`
- `read_all_orders` if the app must see orders older than Shopify's default recent-order window

Implementation note:

- Even when querying `fulfillment_status=unfulfilled`, Shopify responses can still include orders whose display status is `partial`. Filter those out server-side if the UI should show only fully unfulfilled orders.
- Shopify GraphQL `Order.displayFulfillmentStatus` is a more reliable final filter than the REST order fulfillment fields for excluding admin-side `IN_PROGRESS` orders such as `#330572`.
- Inventory location names visible on inventory levels can differ from the simpler location list returned elsewhere. In this store, `PIO - A . I . S T O N E` appears on inventory levels even though an earlier location list check only surfaced `Lakewood`, `Jackson`, and `Digital Goods`.

## Inventory by location

To show stock by fulfillment location for order items:

1. Load the relevant orders first.
2. Collect unique `variant_id` values from the line items.
3. Query Shopify GraphQL for those `ProductVariant` nodes and read `inventoryItem.inventoryLevels`.
4. Normalize `available` quantities by location name.
5. For this store, track at least:
   - `Lakewood`
   - `PIO - A . I . S T O N E`

Practical note:

- A useful transfer filter here is: order tagged `Lakewood`, item not available in `Lakewood`, and item available in `PIO - A . I . S T O N E`.

## Pagination

1. Read the `Link` header from Shopify.
2. Follow `rel="next"` links until exhausted.
3. Merge and normalize all pages before returning.

## Security

- Keep tokens in environment variables only.
- Do not expose the Admin API token to browser code.
- For browser pages, fetch through server endpoints such as `/api/transfers`.
