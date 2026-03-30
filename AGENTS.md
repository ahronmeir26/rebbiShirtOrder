# Repository Instructions

- After changing application code, restart the local dev server with `npm run dev` so the latest behavior is available for testing.
- When relevant, mention whether the running dev server reflects the newest code or needs a restart.
- When the user says to remember a repo-specific workflow or preference, add it to `AGENTS.md`.
- Do not commit or push changes unless the user explicitly asks.
- When the user says `commit`, commit the current changes locally without pushing.
- When the user says `deploy`, commit the current changes and push them to `origin`.
- When implementing features in this repo, make sure the behavior works in both local dev and Vercel environments.
- When running the local dev server for this repo, also run ngrok so Twilio can reach the local app.
- When the issue is clearly Vercel-only, do not treat restarting the local dev server as meaningful verification.
- For Twilio routes on Vercel, do not assume nested paths are covered automatically; add or verify explicit Vercel route wrappers for nested endpoints like `/api/twilio/order/...` or `/api/twilio/cart/...` so production routing matches local routing.
- When loading data from Shopify in this repo, reference the local skill at `.codex/skills/shopify-loader/SKILL.md`.
- When new Shopify-specific implementation details are learned, add them to the Shopify loader skill or its references.
- When Shopify API access patterns, queries, filters, scopes, locations, or payload shapes change, update the Shopify loader skill and references in the same task.
