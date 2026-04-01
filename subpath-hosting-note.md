# Subpath Hosting Request

Use this wording when asking for the same setup on another app:

“Mount this app under `/someprefix` on my main domain. I want all pages, assets, API routes, and redirects to work under that prefix, without creating root-level routes on my main site. The direct Vercel domain should still work normally.”

Short version:

“Add base-path support for `/someprefix` and configure rewrites for `/someprefix/:path*`.”

Useful terms:

- Mount under `/someprefix`
- Base-path support
- Subpath hosting
- Rewrite `/someprefix/:path*` to the app
- Keep the direct Vercel domain working too
