const crypto = require("crypto");

const ADMIN_COOKIE_NAME = "admin_session";
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const ROUTE_PREFIXES = ["/rso"];

function authConfig() {
  return {
    username: String(process.env.ADMIN_USERNAME || "admin").trim() || "admin",
    passwordHash: String(process.env.ADMIN_PASSWORD_HASH || "").trim(),
    sessionSecret: String(process.env.ADMIN_SESSION_SECRET || "").trim(),
    sessionTtlMs: Math.max(5 * 60 * 1000, Number(process.env.ADMIN_SESSION_TTL_MS || DEFAULT_SESSION_TTL_MS) || DEFAULT_SESSION_TTL_MS)
  };
}

function isAdminAuthConfigured() {
  const config = authConfig();
  return Boolean(config.passwordHash && config.sessionSecret);
}

function parseCookieHeader(header) {
  const cookies = {};
  const raw = String(header || "").trim();
  if (!raw) {
    return cookies;
  }

  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!key) {
      continue;
    }

    cookies[key] = decodeURIComponent(value);
  }

  return cookies;
}

function mountedPrefixFromRequestUrl(requestUrl) {
  const current = new URL(String(requestUrl || "/"), "http://localhost");
  const pathname = current.pathname;

  for (const prefix of ROUTE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return prefix;
    }
  }

  return "";
}

function buildMountedPath(requestUrl, routePath) {
  return `${mountedPrefixFromRequestUrl(requestUrl)}${routePath}`;
}

function sanitizeNextPath(input, fallback = "/") {
  const value = String(input || "").trim();
  if (!value.startsWith("/") || value.startsWith("//")) {
    return fallback;
  }

  return value;
}

function isHttpsRequest(req) {
  const forwardedProto = String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  if (forwardedProto) {
    return forwardedProto === "https";
  }

  const host = String(req?.headers?.host || "").trim().toLowerCase();
  if (host.startsWith("localhost") || host.startsWith("127.0.0.1")) {
    return false;
  }

  return String(process.env.VERCEL || "").trim() === "1";
}

function appendSetCookieHeader(headers, cookieValue) {
  const next = { ...(headers || {}) };
  const current = next["Set-Cookie"] || next["set-cookie"];

  if (!current) {
    next["Set-Cookie"] = cookieValue;
    return next;
  }

  if (Array.isArray(current)) {
    next["Set-Cookie"] = [...current, cookieValue];
    return next;
  }

  next["Set-Cookie"] = [current, cookieValue];
  return next;
}

function passwordHashFingerprint(passwordHash) {
  return crypto.createHash("sha256").update(String(passwordHash || ""), "utf8").digest("hex").slice(0, 16);
}

function signSessionPayload(payload, sessionSecret) {
  return crypto.createHmac("sha256", sessionSecret).update(payload, "utf8").digest("base64url");
}

function safeCompareText(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function buildAdminSessionToken() {
  const config = authConfig();
  const payload = Buffer.from(
    JSON.stringify({
      sub: config.username,
      exp: Date.now() + config.sessionTtlMs,
      nonce: crypto.randomUUID(),
      v: passwordHashFingerprint(config.passwordHash)
    }),
    "utf8"
  ).toString("base64url");
  const signature = signSessionPayload(payload, config.sessionSecret);
  return `${payload}.${signature}`;
}

function verifyAdminSessionCookieValue(cookieValue) {
  const config = authConfig();
  if (!config.passwordHash || !config.sessionSecret) {
    return false;
  }

  const token = String(cookieValue || "").trim();
  if (!token) {
    return false;
  }

  const separator = token.lastIndexOf(".");
  if (separator <= 0) {
    return false;
  }

  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expectedSignature = signSessionPayload(payload, config.sessionSecret);
  if (!safeCompareText(signature, expectedSignature)) {
    return false;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!safeCompareText(String(decoded.sub || ""), config.username)) {
      return false;
    }

    if (!Number.isFinite(Number(decoded.exp)) || Number(decoded.exp) <= Date.now()) {
      return false;
    }

    return safeCompareText(String(decoded.v || ""), passwordHashFingerprint(config.passwordHash));
  } catch (_error) {
    return false;
  }
}

function isAdminAuthenticated(req) {
  const cookies = parseCookieHeader(req?.headers?.cookie);
  return verifyAdminSessionCookieValue(cookies[ADMIN_COOKIE_NAME]);
}

function buildAdminSessionCookie(req) {
  const config = authConfig();
  const secure = isHttpsRequest(req);
  const maxAge = Math.max(60, Math.floor(config.sessionTtlMs / 1000));
  const parts = [
    `${ADMIN_COOKIE_NAME}=${encodeURIComponent(buildAdminSessionToken())}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`
  ];

  if (secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function buildClearedAdminSessionCookie(req) {
  const secure = isHttpsRequest(req);
  const parts = [
    `${ADMIN_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT"
  ];

  if (secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function verifyAdminPassword(password) {
  const passwordHash = String(authConfig().passwordHash || "").trim();
  const [scheme, saltHex, hashHex] = passwordHash.split(":");
  if (scheme !== "scrypt" || !saltHex || !hashHex) {
    return false;
  }

  try {
    const expected = Buffer.from(hashHex, "hex");
    const derived = crypto.scryptSync(String(password || ""), Buffer.from(saltHex, "hex"), expected.length);
    return crypto.timingSafeEqual(derived, expected);
  } catch (_error) {
    return false;
  }
}

function verifyAdminCredentials(username, password) {
  const config = authConfig();
  return safeCompareText(String(username || "").trim(), config.username) && verifyAdminPassword(password);
}

module.exports = {
  ADMIN_COOKIE_NAME,
  appendSetCookieHeader,
  authConfig,
  buildAdminSessionCookie,
  buildClearedAdminSessionCookie,
  buildMountedPath,
  isAdminAuthConfigured,
  isAdminAuthenticated,
  parseCookieHeader,
  sanitizeNextPath,
  verifyAdminCredentials,
  verifyAdminPassword,
  verifyAdminSessionCookieValue
};
