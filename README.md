# Rebbi Ordering App

This app accepts Twilio voice webhooks and guides callers through an IVR flow for ordering shirts.

The site root `/` shows a live order dashboard that reads from `/api/orders`.

## IVR flow

- Main menu lets callers order shirts, hear the cart, hear store hours, or transfer to a representative.
- Shirt ordering walks through category, style, size, sleeve length, fit, pocket, cuff, and quantity.
- After each item is added, the caller can add another shirt, hear the cart again, place the order, or cancel.
- The cart is read back over the phone with quantities and shirt attributes.
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
2. Set `BASE_URL` in Vercel to your production domain, for example `https://your-app.vercel.app`.
3. Set `REPRESENTATIVE_NUMBER` if you want the transfer option to dial a real number.
4. In Twilio, configure the voice webhook URL as:

```text
https://your-app.vercel.app/api/twilio/voice
```

## Test the webhook locally

```bash
curl -X POST http://localhost:3000/api/twilio/voice \
  -d "CallSid=CA1234567890&From=%2B15555550123"
```

## Notes

- Call sessions are stored in memory, which is acceptable for local development but not durable in serverless production.
- Confirmed orders are written to `data/orders.json` when the filesystem allows it. On Vercel, treat that as best-effort only.
- For production, replace in-memory sessions and file storage with a shared database or Redis.
- For production, add Twilio request signature validation before trusting inbound webhooks.
