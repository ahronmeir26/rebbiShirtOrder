import { next } from "@vercel/functions";
import crypto from "crypto";
import auth from "./src/admin-auth.js";

const { ADMIN_COOKIE_NAME, buildMountedPath, parseCookieHeader, sanitizeNextPath, verifyAdminSessionCookieValue } = auth;

function timingSafeTextEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function shopifyHmacMessageFromSearch(searchParams) {
  const params = new URLSearchParams(searchParams);
  params.delete("hmac");
  params.delete("signature");
  return Array.from(params.entries())
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey)
    )
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function isValidShopifyLaunch(url) {
  const secret = String(process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET || "").trim();
  const hmac = String(url.searchParams.get("hmac") || "").trim();
  if (!secret || !hmac) {
    return false;
  }

  const expected = crypto.createHmac("sha256", secret).update(shopifyHmacMessageFromSearch(url.searchParams), "utf8").digest("hex");
  return timingSafeTextEqual(hmac, expected);
}

export default function middleware(request) {
  const url = new URL(request.url);
  const cookies = parseCookieHeader(request.headers.get("cookie") || "");

  if (verifyAdminSessionCookieValue(cookies[ADMIN_COOKIE_NAME])) {
    return next();
  }

  if (isValidShopifyLaunch(url)) {
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
