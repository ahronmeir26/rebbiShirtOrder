import { next } from "@vercel/functions";
import auth from "./src/admin-auth.js";

const { ADMIN_COOKIE_NAME, buildMountedPath, parseCookieHeader, sanitizeNextPath, verifyAdminSessionCookieValue } = auth;

export default function middleware(request) {
  const url = new URL(request.url);
  const cookies = parseCookieHeader(request.headers.get("cookie") || "");

  if (verifyAdminSessionCookieValue(cookies[ADMIN_COOKIE_NAME])) {
    return next();
  }

  const loginPath = buildMountedPath(url.pathname, "/login");
  const nextPath = sanitizeNextPath(`${url.pathname}${url.search}`, "/");
  const destination = new URL(`${loginPath}?next=${encodeURIComponent(nextPath)}`, request.url);
  return Response.redirect(destination, 303);
}

export const config = {
  runtime: "nodejs",
  matcher: [
    "/",
    "/index.html",
    "/testivr",
    "/testivr/:path*",
    "/transfers",
    "/transfers/:path*",
    "/rso",
    "/rso/",
    "/rso/index.html",
    "/rso/testivr",
    "/rso/testivr/:path*",
    "/rso/transfers",
    "/rso/transfers/:path*"
  ]
};
