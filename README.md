# Rebbi Ordering App

This app accepts Twilio voice webhooks and guides callers through an IVR flow for ordering shirts.

The site root `/` shows a live order dashboard that reads from `/api/orders`.

## IVR flow

- After callers press 1 to order shirts, the IVR asks for a numeric coupon code unless one is already saved for that phone number.
- Shirt ordering walks through category, style, size, sleeve length, fit, pocket, cuff, and quantity.
- After each item is added, the caller can add another shirt, hear the cart again, review the discount code, or place the order.
- The cart is read back over the phone with quantities and shirt attributes, and callers can change quantity or delete items during playback.
- Allowed options are restricted to mens or boys, standard or chassidish, size 14 through 20 including half sizes, sleeve 30 through 37 or short sleeve, fit classic/slim/extra slim/super slim, twill only, pocket yes/no, and cuff button/french or short sleeve.

## Routes

- `POST /api/twilio/voice`
- `POST /api/twilio/menu`
- `POST /api/twilio/order/start`
- `POST /api/twilio/order/category`
- `POST /api/twilio/order/style`
- `POST /api/twilio/order/size`
- `POST /api/twilio/order/sleeve`
- `POST /api/twilio/order/fit`
- `POST /api/twilio/order/pocket`
- `POST /api/twilio/order/cuff`
- `POST /api/twilio/order/quantity`
- `POST /api/twilio/order/next`
- `POST /api/twilio/order/discount-code`
- `POST /api/twilio/order/discount-code/review`
- `POST /api/twilio/order/finalize`
- `POST /api/twilio/cart/play`
- `POST /api/twilio/cart/control`
- `POST /api/twilio/cart/quantity`
- `POST /api/orders/shopify-refund`
- `GET /shopify/refund`
- `POST /api/shopify/refund-action`
- `GET /api/admin/caller-discounts`
- `POST /api/admin/caller-discounts/clear`
- `GET /`
- `GET /api/health`
- `GET /api/orders`

## Local development with ngrok

1. Export local environment variables:

```bash
export PORT=3000
export BASE_URL=https://your-ngrok-subdomain.ngrok-free.app
export REPRESENTATIVE_NUMBER=+15551234567
```

2. Start the local server:

```bash
npm run dev
```

3. In another terminal, expose the app:

```bash
ngrok http 3000
```

4. Update `BASE_URL` to the exact public `ngrok` HTTPS URL and restart the app.

5. Point Twilio voice webhooks to:

```text
https://your-ngrok-subdomain.ngrok-free.app/api/twilio/voice
```

## Vercel deployment

1. Deploy the repo to Vercel.
2. Do not set `BASE_URL` to your local `ngrok` URL in Vercel. On Vercel, the app uses the request host automatically.
3. Optionally set `BASE_URL` in Vercel only if you want to force a specific production domain.
4. Set `REPRESENTATIVE_NUMBER` if you want the transfer option to dial a real number.
5. Attach a Vercel Blob store to the project so `BLOB_READ_WRITE_TOKEN` is available for durable order storage.
6. In Twilio, configure the voice webhook URL as:

```text
https://your-app.vercel.app/api/twilio/voice
```

## Test the webhook locally

```bash
curl -X POST http://localhost:3000/api/twilio/voice \
  -d "CallSid=CA1234567890&From=%2B15555550123"
```

## Shopify refund route

`POST /api/orders/shopify-refund` refunds a Shopify order by order number. It reuses the existing orders API function on Vercel.

Server-to-server callers must set `Authorization: Bearer $SHOPIFY_REFUND_ROUTE_SECRET`. Browser admin callers can use the existing admin session cookie.

```bash
curl -X POST https://your-app.vercel.app/api/orders/shopify-refund \
  -H "Authorization: Bearer $SHOPIFY_REFUND_ROUTE_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"orderNumber":"#1234","notify":false}'
```

## Shopify More Actions refund app

The `extensions/rb-refund-stripe` admin link extension adds `RB refund stripe` to the order details page More actions menu. It opens `/shopify/refund` on this same Vercel app and posts to `/api/shopify/refund-action` after server-side Shopify HMAC verification.

Deploy the extension with Shopify CLI from this repo after connecting it to the Shopify app:

```bash
shopify app deploy
```

The app needs order read/write Admin API access for refunds.

## Notes

- Call sessions are stored in memory, which is acceptable for local development but not durable in serverless production.
- Local development stores orders in `data/orders.json`.
- Vercel production stores orders in Vercel Blob when `BLOB_READ_WRITE_TOKEN` is configured.
- Cart state is cleared after an order is placed or canceled, even though saved orders remain visible in the dashboard.
- In-memory sessions are still acceptable for local development only. For production-grade cart/session recovery across cold starts, replace that with a shared store as well.
- For production, add Twilio request signature validation before trusting inbound webhooks.
