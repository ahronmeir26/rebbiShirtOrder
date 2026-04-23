const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  deleteSession,
  deleteSessionsByCaller,
  findSessionByCaller,
  loadAppConfig,
  loadOrders,
  loadSession,
  saveAppConfig,
  saveOrder,
  saveSession
} = require("./order-store");
const {
  appendSetCookieHeader,
  authConfig,
  buildAdminSessionCookie,
  buildClearedAdminSessionCookie,
  buildMountedPath,
  isAdminAuthConfigured,
  isAdminAuthenticated,
  sanitizeNextPath,
  verifyAdminCredentials
} = require("./admin-auth");
const { findMatchingPreorderSku, getPreorderCache } = require("./preorder-cache");
const {
  completeDraftOrder,
  createDraftOrder,
  lookupDiscountCode,
  toMoneyAmount
} = require("./shopify-draft-orders");

const dashboardFile = path.join(__dirname, "..", "index.html");
const testIvrFile = path.join(__dirname, "..", "testivr", "index.html");
const logoFile = path.join(__dirname, "..", "logo-aistone.png");
const DEFAULT_VOICE = process.env.TTS_VOICE || "Google.en-US-Standard-C";
const DEFAULT_LANGUAGE = process.env.TTS_LANGUAGE || "en-US";
const ROUTE_PREFIXES = ["/rso"];
const UNIT_PRICE_BY_CATEGORY = {
  mens: 25,
  boys: 20
};
const SHIPPING_FEE = 10;
const DEFAULT_SUBMIT_SHOPIFY_ORDER = /^(1|true|yes|on)$/i.test(String(process.env.SHOPIFY_SUBMIT_SHOPIFY_ORDER || "").trim());
const DEFAULT_TWILIO_PAY_CONNECTOR = String(process.env.TWILIO_PAY_CONNECTOR || "Stripe_Connector").trim() || "Stripe_Connector";
const PENNY_CC_CHARGE_AMOUNT = 0.01;

const categories = {
  1: { id: "mens", name: "mens" },
  2: { id: "boys", name: "boys" }
};

const styles = {
  1: { id: "standard", name: "standard" },
  2: { id: "chassidish", name: "khoss seedish" }
};

const collars = {
  1: { id: "spread", name: "spread", skuCode: "S" },
  2: { id: "cutaway", name: "cutaway", skuCode: "C" }
};

const mensSizes = {
  1: { id: "14", name: "14" },
  2: { id: "14.5", name: "14 and a half" },
  3: { id: "15", name: "15" },
  4: { id: "15.5", name: "15 and a half" },
  5: { id: "16", name: "16" },
  6: { id: "16.5", name: "16 and a half" },
  7: { id: "17", name: "17" },
  8: { id: "17.5", name: "17 and a half" },
  9: { id: "18", name: "18" },
  10: { id: "18.5", name: "18 and a half" },
  11: { id: "19", name: "19" },
  12: { id: "19.5", name: "19 and a half" },
  13: { id: "20", name: "20" }
};

const boysSizes = {
  4: { id: "4", name: "4" },
  5: { id: "5", name: "5" },
  6: { id: "6", name: "6" },
  7: { id: "7", name: "7" },
  8: { id: "8", name: "8" },
  9: { id: "9", name: "9" },
  10: { id: "10", name: "10" },
  12: { id: "12", name: "12" },
  14: { id: "14", name: "14" },
  16: { id: "16", name: "16" },
  18: { id: "18", name: "18" },
  20: { id: "20", name: "20" },
  22: { id: "22", name: "22" }
};

const mensSleeves = {
  30: { id: "30", name: "30" },
  31: { id: "31", name: "31" },
  32: { id: "32", name: "32" },
  33: { id: "33", name: "33" },
  34: { id: "34", name: "34" },
  35: { id: "35", name: "35" },
  36: { id: "36", name: "36" },
  37: { id: "37", name: "37" },
  0: { id: "short-sleeve", name: "short sleeve" }
};

const boysSleeves = {
  1: { id: "long-sleeve", name: "long sleeve" },
  2: { id: "short-sleeve", name: "short sleeve" }
};

const fits = {
  1: { id: "classic", name: "classic" },
  2: { id: "slim", name: "slim" },
  3: { id: "extra-slim", name: "extra slim" },
  4: { id: "super-slim", name: "super slim" },
  5: { id: "husky", name: "husky" },
  6: { id: "traditional", name: "traditional" }
};

const pockets = {
  1: { id: "yes", name: "with pocket", value: true },
  2: { id: "no", name: "without pocket", value: false }
};

const cuffs = {
  1: { id: "button", name: "button cuff" },
  2: { id: "french", name: "french cuff" }
};

const sessions = new Map();
const callSidSessionKeys = new Map();
const CHASSIDISH_COLLAR = { id: "pointy", name: "pointy", skuCode: "P" };
const BOYS_STANDARD_COLLAR = { id: "cutaway", name: "cutaway", skuCode: "C" };
const SHORT_SLEEVE_CUFF = { id: "short-sleeve", name: "short sleeve" };
const DEFAULT_SELECTION_TIMEOUT = 7;
const CART_PLAYBACK_TIMEOUT = 2;

function cloneOption(option) {
  return option && typeof option === "object" ? { ...option } : option;
}

function rawOptionValue(value) {
  if (value && typeof value === "object") {
    return value.id || value.name || "";
  }

  return value;
}

function normalizeOptionKey(value) {
  return String(rawOptionValue(value) || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

function categoryId(value) {
  const key = normalizeOptionKey(value);
  if (key === "men") {
    return "mens";
  }
  if (key === "boy") {
    return "boys";
  }
  return key;
}

function styleId(value) {
  const key = normalizeOptionKey(value);
  if (["khoss-seedish", "chassidish", "chossidish", "chasidish"].includes(key)) {
    return "chassidish";
  }
  return key;
}

function collarId(value) {
  const key = normalizeOptionKey(value);
  if (key === "standard") {
    return "spread";
  }
  return key;
}

function fitId(value) {
  return normalizeOptionKey(value).replaceAll("-", " ");
}

function pocketId(value) {
  const key = normalizeOptionKey(value);
  if (key === "yes" || key === "with-pocket") {
    return "with-pocket";
  }
  if (key === "no" || key === "without-pocket") {
    return "without-pocket";
  }
  return key;
}

function cuffId(value) {
  const key = normalizeOptionKey(value);
  if (key === "button" || key === "button-cuff") {
    return "button";
  }
  if (key === "french" || key === "french-cuff") {
    return "french";
  }
  if (key === "short-sleeve" || key === "short-sleeve-cuff") {
    return "short-sleeve";
  }
  return key;
}

function sleeveId(value) {
  const key = normalizeOptionKey(value);
  if (key === "short" || key === "short-sleeve") {
    return "short-sleeve";
  }
  if (key === "long" || key === "long-sleeve") {
    return "long-sleeve";
  }
  return key;
}

function sizeId(value) {
  return String(rawOptionValue(value) || "").trim();
}

function isBoysItem(item) {
  return categoryId(item?.category) === "boys";
}

function isChassidishItem(item) {
  return styleId(item?.style) === "chassidish";
}

function isShortSleeveItem(item) {
  return sleeveId(item?.sleeve) === "short-sleeve";
}

function getSizeCatalog(item) {
  return isBoysItem(item) ? boysSizes : mensSizes;
}

function getSleeveCatalog(item) {
  return isBoysItem(item) ? boysSleeves : mensSleeves;
}

function requiresCollarSelection(item) {
  return Boolean(item?.style) && !isBoysItem(item) && !isChassidishItem(item);
}

function requiresPocketSelection(item) {
  return Boolean(item?.fit) && !isBoysItem(item);
}

function requiresCuffSelection(item) {
  if (!item?.fit || isShortSleeveItem(item)) {
    return false;
  }

  return !(isBoysItem(item) && isChassidishItem(item));
}

function orderSelectionSteps(item) {
  const steps = ["category"];

  if (!item?.category) {
    return steps;
  }

  steps.push("style");
  if (!item.style) {
    return steps;
  }

  if (requiresCollarSelection(item)) {
    steps.push("collar");
  }

  steps.push("size");
  if (!item.size) {
    return steps;
  }

  steps.push("sleeve");
  if (!item.sleeve) {
    return steps;
  }

  steps.push("fit");
  if (!item.fit) {
    return steps;
  }

  if (requiresPocketSelection(item)) {
    steps.push("pocket");
  }

  if (requiresCuffSelection(item)) {
    steps.push("cuff");
  }

  return steps;
}

function isOrderStepComplete(item, step) {
  return Boolean(item?.[step]);
}

function clearPendingItemFromStep(item, step) {
  const steps = ["category", "style", "collar", "size", "sleeve", "fit", "pocket", "cuff"];
  const index = steps.indexOf(step);
  if (index === -1) {
    return;
  }

  for (const field of steps.slice(index)) {
    delete item[field];
  }
}

function sanitizeSession(session) {
  const source = session && typeof session === "object" ? session : {};
  return {
    createdAt: source.createdAt || new Date().toISOString(),
    updatedAt: source.updatedAt || source.createdAt || new Date().toISOString(),
    caller: String(source.caller || "").trim(),
    lastCallSid: String(source.lastCallSid || "").trim(),
    discountCodeEntryComplete: Boolean(source.discountCodeEntryComplete),
    discountCodePromptCallSid: String(source.discountCodePromptCallSid || "").trim(),
    discountCode: source.discountCode && typeof source.discountCode === "object" ? source.discountCode : undefined,
    pendingCheckout: source.pendingCheckout && typeof source.pendingCheckout === "object" ? source.pendingCheckout : undefined,
    pendingItem: source.pendingItem && typeof source.pendingItem === "object" ? source.pendingItem : undefined,
    cart: Array.isArray(source.cart) ? source.cart : []
  };
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function normalizeMountedPath(pathname) {
  for (const prefix of ROUTE_PREFIXES) {
    if (pathname === prefix) {
      return { pathname: "/", routePrefix: prefix };
    }

    if (pathname.startsWith(`${prefix}/`)) {
      return {
        pathname: pathname.slice(prefix.length) || "/",
        routePrefix: prefix
      };
    }
  }

  return { pathname, routePrefix: "" };
}

function buildBaseUrl(req, envBaseUrl) {
  const isVercelRuntime = String(process.env.VERCEL || "").toLowerCase() === "1";
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000")
    .split(",")[0]
    .trim();
  const current = new URL(String(req.url || "/"), "http://localhost");
  const { routePrefix } = normalizeMountedPath(current.pathname);

  if (isVercelRuntime && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}${routePrefix}`;
  }

  const configured = String(envBaseUrl || "").trim().replace(/\/$/, "");
  if (configured) {
    return `${configured}${routePrefix}`;
  }

  return `${forwardedProto}://${forwardedHost}${routePrefix}`;
}

function isVercelRuntime() {
  return String(process.env.VERCEL || "").toLowerCase() === "1";
}

function buildTwilioRouteUrl(baseUrl, routePath) {
  return `${baseUrl}${routePath}`;
}

function twiml(parts) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${parts.join("")}</Response>`;
}

function twimlBody(document) {
  return String(document)
    .replace(/^<\?xml[^>]*\?>/, "")
    .replace(/^<Response>/, "")
    .replace(/<\/Response>\s*$/, "");
}

function say(text, voice = DEFAULT_VOICE, language = DEFAULT_LANGUAGE) {
  return `<Say voice="${voice}" language="${language}">${escapeXml(text)}</Say>`;
}

function gather(
  baseUrl,
  { action, prompt, numDigits, hints, finishOnKey = "#", timeout = DEFAULT_SELECTION_TIMEOUT, speechTimeout, enhanced, input = "dtmf speech" }
) {
  const digitAttr = numDigits ? ` numDigits="${numDigits}"` : "";
  const hintsAttr = hints ? ` hints="${escapeXml(hints)}"` : "";
  const finishAttr = finishOnKey ? ` finishOnKey="${escapeXml(finishOnKey)}"` : "";
  const timeoutAttr = Number.isFinite(timeout) && timeout > 0 ? ` timeout="${timeout}"` : "";
  const speechTimeoutAttr = speechTimeout ? ` speechTimeout="${escapeXml(String(speechTimeout))}"` : "";
  const enhancedAttr = enhanced ? ` enhanced="true"` : "";
  const actionUrl = buildTwilioRouteUrl(baseUrl, action);

  return [
    `<Gather input="${escapeXml(input)}" method="POST" action="${escapeXml(actionUrl)}"${digitAttr}${finishAttr}${hintsAttr}${timeoutAttr}${speechTimeoutAttr}${enhancedAttr}>`,
    say(prompt),
    "</Gather>"
  ].join("");
}

function redirect(baseUrl, routePath) {
  return `<Redirect method="POST">${escapeXml(buildTwilioRouteUrl(baseUrl, routePath))}</Redirect>`;
}

function hangup() {
  return "<Hangup/>";
}

function pay(baseUrl, { action, amount, paymentConnector, description, statusCallback }) {
  const attrs = [
    `action="${escapeXml(buildTwilioRouteUrl(baseUrl, action))}"`,
    `chargeAmount="${escapeXml(formatChargeAmount(amount))}"`,
    'currency="usd"',
    'paymentMethod="credit-card"',
    'input="dtmf"',
    `paymentConnector="${escapeXml(paymentConnector || DEFAULT_TWILIO_PAY_CONNECTOR)}"`,
    'maxAttempts="3"'
  ];

  if (description) {
    attrs.push(`description="${escapeXml(description)}"`);
  }

  if (statusCallback) {
    attrs.push(`statusCallback="${escapeXml(buildTwilioRouteUrl(baseUrl, statusCallback))}"`);
  }

  return `<Pay ${attrs.join(" ")} />`;
}

function pause(length = 1) {
  return `<Pause length="${length}"/>`;
}

function parseFormBody(req) {
  if (req.body && typeof req.body === "object") {
    return Promise.resolve(req.body);
  }

  if (typeof req.body === "string") {
    const params = new URLSearchParams(req.body);
    const data = {};
    for (const [key, value] of params.entries()) {
      data[key] = value;
    }
    return Promise.resolve(data);
  }

  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      const params = new URLSearchParams(body);
      const data = {};
      for (const [key, value] of params.entries()) {
        data[key] = value;
      }
      resolve(data);
    });

    req.on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return "\"[unserializable]\"";
  }
}

function summarizeTwilioRequest(req, pathname) {
  const query =
    req.query && typeof req.query === "object"
      ? Object.fromEntries(Object.entries(req.query).map(([key, value]) => [key, Array.isArray(value) ? value : String(value)]))
      : undefined;
  const body =
    req.body && typeof req.body === "object"
      ? {
          CallSid: req.body.CallSid,
          Digits: req.body.Digits,
          From: req.body.From,
          SpeechResult: req.body.SpeechResult,
          route: req.body.route
        }
      : req.body;

  return {
    method: req.method,
    url: req.url,
    pathname,
    query,
    bodyType: typeof req.body,
    body
  };
}

function logTwilioDebug(event, details) {
  console.log(`[twilio-debug] ${event} ${safeJson(details)}`);
}

function attachTwilioResponseLogging(res, pathname) {
  if (!pathname.startsWith("/api/twilio") || res.__twilioLoggingAttached) {
    return;
  }

  res.__twilioLoggingAttached = true;

  const originalWriteHead = typeof res.writeHead === "function" ? res.writeHead.bind(res) : null;
  const originalEnd = typeof res.end === "function" ? res.end.bind(res) : null;

  res.writeHead = function patchedWriteHead(statusCode, headers) {
    res.__twilioStatusCode = statusCode;
    res.__twilioHeaders = headers;
    return originalWriteHead ? originalWriteHead(statusCode, headers) : res;
  };

  res.end = function patchedEnd(payload, ...args) {
    const text = payload == null ? "" : Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload);
    logTwilioDebug("response", {
      pathname,
      statusCode: res.__twilioStatusCode,
      contentType: res.__twilioHeaders?.["Content-Type"] || res.__twilioHeaders?.["content-type"],
      body: text
    });
    return originalEnd ? originalEnd(payload, ...args) : undefined;
  };
}

function getTwilioRouteParam(req, current) {
  return req.query?.route || req.query?.["...route"] || current.searchParams.getAll("route") || current.searchParams.getAll("...route");
}

function resolvePathname(req) {
  const current = new URL(String(req.url || "/"), "http://localhost");
  const normalized = normalizeMountedPath(current.pathname);

  if (normalized.pathname !== "/api/twilio/[...route]") {
    return normalized.pathname;
  }

  const routeParam = getTwilioRouteParam(req, current);
  const routeSegments = Array.isArray(routeParam) ? routeParam : routeParam ? [routeParam] : [];

  if (routeSegments.length === 0) {
    return current.pathname;
  }

  const flattened = routeSegments.flatMap((segment) => String(segment).split("/").filter(Boolean));
  return `/api/twilio/${flattened.join("/")}`;
}

function sessionKeyForCaller(callSid, from) {
  const caller = String(from || "").trim();

  if (caller) {
    return `phone:${caller}`;
  }

  if (callSid && callSidSessionKeys.has(callSid)) {
    return callSidSessionKeys.get(callSid);
  }

  return callSid || `local-${Date.now()}`;
}

async function loadPreferredSessionRecord(sessionKey) {
  if (!sessionKey) {
    return null;
  }

  return pickPreferredSession(await loadSession(sessionKey), sessions.get(sessionKey));
}

async function getSession(callSid, from) {
  const caller = String(from || "").trim();
  const normalizedCallSid = String(callSid || "").trim();
  const directKey = sessionKeyForCaller(normalizedCallSid, caller);
  let key = directKey;

  if (normalizedCallSid && caller) {
    callSidSessionKeys.set(normalizedCallSid, key);
  }

  // Rehydrate from persistent storage on every request so warm Vercel instances do not serve stale cart state.
  // Prefer the freshest record across the canonical key and the current call key so an older empty
  // phone session does not override a newer in-progress call session on Vercel.
  let stored = await loadPreferredSessionRecord(key);
  const storedByCall = await loadPreferredSessionRecord(normalizedCallSid);

  if (caller) {
    stored = pickPreferredSession(stored, storedByCall);
    if (storedByCall) {
      key = `phone:${caller}`;
    }
  } else if (storedByCall) {
    stored = storedByCall;
    key = storedByCall.caller ? `phone:${String(storedByCall.caller).trim()}` : normalizedCallSid;
  }

  let hasPrimarySession = stored && typeof stored === "object";

  // An empty cart is valid state. Only fall back when the primary session record is actually missing.
  if (!hasPrimarySession && caller) {
    const storedByCaller = await findSessionByCaller(caller);
    if (storedByCaller) {
      stored = storedByCaller;
      key = `phone:${caller}`;
      hasPrimarySession = true;
    }
  }

  if (!stored && normalizedCallSid && caller) {
    const legacyByCall = storedByCall;
    if (legacyByCall && Array.isArray(legacyByCall.cart) && legacyByCall.cart.length) {
      stored = legacyByCall;
      key = `phone:${caller}`;
    }
  }

  if (!stored && normalizedCallSid && !caller) {
    if (storedByCall) {
      stored = storedByCall;
      if (storedByCall.caller) {
        key = `phone:${String(storedByCall.caller).trim()}`;
      } else {
        key = normalizedCallSid;
      }
    }
  }

  const normalized = sanitizeSession(stored);
  if (caller) {
    normalized.caller = caller;
  }
  if (normalizedCallSid) {
    normalized.lastCallSid = normalizedCallSid;
    callSidSessionKeys.set(normalizedCallSid, key);
  }
  sessions.set(key, normalized);

  return { key, session: normalized };
}

function sessionTimestamp(session) {
  const value = Date.parse(String(session?.updatedAt || session?.createdAt || ""));
  return Number.isFinite(value) ? value : 0;
}

function pickPreferredSession(primary, secondary) {
  const left = primary && typeof primary === "object" ? primary : null;
  const right = secondary && typeof secondary === "object" ? secondary : null;

  if (!left) {
    return right;
  }

  if (!right) {
    return left;
  }

  return sessionTimestamp(right) > sessionTimestamp(left) ? right : left;
}

function calculateUnitPrice(item) {
  return toMoneyAmount(UNIT_PRICE_BY_CATEGORY[item.category] || item.unitPrice || 0);
}

function calculateLineTotal(item) {
  return calculateUnitPrice(item) * Number(item.quantity || 0);
}

function calculateOrderTotal(items) {
  const subtotal = items.reduce((sum, item) => sum + calculateLineTotal(item), 0);
  return subtotal + (items.length ? SHIPPING_FEE : 0);
}

function formatChargeAmount(value) {
  return toMoneyAmount(value).toFixed(2);
}

function isTruthySetting(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function buildPreparedCheckout(items, session, pricing) {
  return {
    items: items.map(normalizeStoredItem),
    totalQuantity: cartQuantity(items),
    preDiscountTotalPrice: calculateOrderTotal(items),
    totalPrice: toMoneyAmount(pricing?.totalPrice || 0),
    subtotalPrice: toMoneyAmount(pricing?.subtotalPrice || 0),
    shippingPrice: toMoneyAmount(pricing?.shippingPrice || SHIPPING_FEE),
    discountAmount: toMoneyAmount(pricing?.discountAmount || 0),
    currencyCode: String(pricing?.currencyCode || "USD").trim() || "USD",
    discountCode: String(session.discountCode?.code || "").trim() || undefined,
    preparedAt: new Date().toISOString()
  };
}

function buildPaymentCollectionConfig(preparedCheckout, runtimeConfig) {
  const totalPrice = toMoneyAmount(preparedCheckout?.totalPrice || 0);

  if (totalPrice <= 0) {
    return {
      mode: "zero-total",
      shouldCollectCard: false,
      chargeAmount: 0
    };
  }

  if (runtimeConfig?.skipCreditCardPayment) {
    return {
      mode: "skip-card",
      shouldCollectCard: false,
      chargeAmount: 0
    };
  }

  if (runtimeConfig?.chargeCreditCardOneCent) {
    return {
      mode: "one-cent-card",
      shouldCollectCard: true,
      chargeAmount: PENNY_CC_CHARGE_AMOUNT
    };
  }

  return {
    mode: "full-card",
    shouldCollectCard: true,
    chargeAmount: totalPrice
  };
}

function paymentPromptResponse(baseUrl, preparedCheckout) {
  const chargeAmount = formatChargeAmount(preparedCheckout.paymentChargeAmount || preparedCheckout.totalPrice);
  return twiml([
    say(`We will now collect your payment of ${chargeAmount} dollars.`),
    pay(baseUrl, {
      action: "/api/twilio/order/payment/complete",
      amount: preparedCheckout.paymentChargeAmount || preparedCheckout.totalPrice,
      paymentConnector: DEFAULT_TWILIO_PAY_CONNECTOR,
      description: `Rebbi Shirt Order ${preparedCheckout.totalQuantity} item${preparedCheckout.totalQuantity === 1 ? "" : "s"}`,
      statusCallback: "/api/twilio/order/payment/status"
    })
  ]);
}

function buildPaymentSummary(form, preparedCheckout) {
  return {
    result: String(form.Result || "").trim() || "unknown",
    mode: String(preparedCheckout?.paymentMode || "full-card").trim() || "full-card",
    amount: toMoneyAmount((preparedCheckout?.paymentChargeAmount ?? preparedCheckout?.totalPrice) || 0),
    orderAmount: toMoneyAmount(preparedCheckout?.totalPrice || 0),
    currency: String(preparedCheckout?.currencyCode || "USD").trim() || "USD",
    connector: DEFAULT_TWILIO_PAY_CONNECTOR,
    confirmationCode: String(form.PaymentConfirmationCode || "").trim() || undefined,
    method: String(form.PaymentMethod || "").trim() || "credit-card",
    cardType: String(form.PaymentCardType || "").trim() || undefined,
    cardNumber: String(form.PaymentCardNumber || "").trim() || undefined,
    expirationDate: String(form.ExpirationDate || "").trim() || undefined
  };
}

function buildSkippedPaymentSummary(preparedCheckout, reason) {
  return {
    result: "skipped",
    mode: String(preparedCheckout?.paymentMode || reason || "skipped").trim() || "skipped",
    reason,
    amount: 0,
    orderAmount: toMoneyAmount(preparedCheckout?.totalPrice || 0),
    currency: String(preparedCheckout?.currencyCode || "USD").trim() || "USD",
    connector: DEFAULT_TWILIO_PAY_CONNECTOR,
    method: "credit-card"
  };
}

function paymentWasApproved(payment) {
  return String(payment?.result || "").trim().toLowerCase() === "success";
}

function paymentWasSkipped(payment) {
  return String(payment?.result || "").trim().toLowerCase() === "skipped";
}

function draftOrderFailureMessage(payment) {
  if (paymentWasApproved(payment)) {
    return "Your payment was approved, but we could not create your Shopify draft order. Please contact the store so we can finish the order.";
  }

  if (paymentWasSkipped(payment)) {
    return "We skipped the card charge, but could not create your Shopify draft order. Please contact the store so we can finish the order.";
  }

  return "We could not create your draft order right now. Please try again in a few minutes.";
}

function shopifyOrderFailureMessage(payment) {
  if (paymentWasApproved(payment)) {
    return "Your payment was approved, but we could not finish the Shopify order right now. Please contact the store so we can complete it.";
  }

  if (paymentWasSkipped(payment)) {
    return "We skipped the card charge, but we could not finish the Shopify order right now. Please contact the store so we can complete it.";
  }

  return "Your draft order was created, but we could not submit the order right now. Please try again in a few minutes.";
}

function orderSuccessMessage(shouldSubmitShopifyOrder, payment) {
  const orderLabel = shouldSubmitShopifyOrder ? "shirt order" : "shirt draft order";

  if (paymentWasSkipped(payment)) {
    if (String(payment?.reason || "").trim() === "zero-total") {
      return `Thank you. Your ${orderLabel} has been created.`;
    }

    return `Thank you. Card payment was skipped and your ${orderLabel} has been created.`;
  }

  return `Thank you. Your payment was received and your ${orderLabel} has been created.`;
}

async function submitPreparedOrder({ key, form, session, preparedCheckout, shouldSubmitShopifyOrder, payment }) {
  const orderRecord = {
    id: `${key}-${Date.now()}`,
    callSid: form.CallSid || key,
    caller: form.From || session.caller || "unknown",
    createdAt: new Date().toISOString(),
    items: preparedCheckout.items,
    totalQuantity: preparedCheckout.totalQuantity,
    totalPrice: preparedCheckout.totalPrice,
    subtotalPrice: preparedCheckout.subtotalPrice,
    preDiscountTotalPrice: preparedCheckout.preDiscountTotalPrice,
    shippingPrice: preparedCheckout.shippingPrice,
    discountAmount: preparedCheckout.discountAmount,
    currencyCode: preparedCheckout.currencyCode,
    discountCode: preparedCheckout.discountCode,
    discountCodeLookup: session.discountCode,
    payment: payment && typeof payment === "object" ? payment : undefined
  };

  await saveOrder(orderRecord);

  let draftOrder;
  try {
    draftOrder = await createDraftOrder(orderRecord);
    orderRecord.shopifyDraftOrder = {
      id: draftOrder.id,
      name: draftOrder.name,
      invoiceUrl: draftOrder.invoiceUrl,
      status: draftOrder.status
    };
    await saveOrder(orderRecord);
  } catch (error) {
    orderRecord.shopifyDraftOrderError = String(error?.message || "").trim() || "Unknown Shopify draft order error.";
    await saveOrder(orderRecord);
    return {
      ok: false,
      orderRecord,
      message: draftOrderFailureMessage(payment)
    };
  }

  if (shouldSubmitShopifyOrder) {
    try {
      const completedDraft = await completeDraftOrder(draftOrder.id);
      orderRecord.shopifyDraftOrder = {
        ...orderRecord.shopifyDraftOrder,
        status: completedDraft.status
      };
      orderRecord.shopifyOrder = {
        id: completedDraft.order.id,
        name: completedDraft.order.name,
        financialStatus: completedDraft.order.displayFinancialStatus,
        fulfillmentStatus: completedDraft.order.displayFulfillmentStatus
      };
    } catch (error) {
      orderRecord.shopifyOrderError = String(error?.message || "").trim() || "Unknown Shopify order completion error.";
      await saveOrder(orderRecord);
      return {
        ok: false,
        orderRecord,
        message: shopifyOrderFailureMessage(payment)
      };
    }
  }

  await saveOrder(orderRecord);
  return {
    ok: true,
    orderRecord,
    message: orderSuccessMessage(shouldSubmitShopifyOrder, payment)
  };
}

function normalizeRuntimeConfig(config) {
  const source = config && typeof config === "object" ? config : {};
  const skipCreditCardPayment = typeof source.skipCreditCardPayment === "boolean" ? source.skipCreditCardPayment : false;
  const chargeCreditCardOneCent =
    !skipCreditCardPayment && typeof source.chargeCreditCardOneCent === "boolean" ? source.chargeCreditCardOneCent : false;

  return {
    submitShopifyOrder:
      typeof source.submitShopifyOrder === "boolean" ? source.submitShopifyOrder : DEFAULT_SUBMIT_SHOPIFY_ORDER,
    skipCreditCardPayment,
    chargeCreditCardOneCent
  };
}

async function getRuntimeConfig() {
  return normalizeRuntimeConfig(await loadAppConfig());
}

async function updateRuntimeConfig(patch) {
  const current = normalizeRuntimeConfig(await loadAppConfig());
  const next = normalizeRuntimeConfig({
    ...current,
    ...(patch && typeof patch === "object" ? patch : {})
  });
  await saveAppConfig({
    ...next,
    updatedAt: new Date().toISOString()
  });
  return next;
}

function encodePendingItem(item) {
  return Buffer.from(JSON.stringify(item), "utf8").toString("base64url");
}

function decodePendingItem(encoded) {
  if (!encoded) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch (_error) {
    return null;
  }
}

function withPendingState(routePath, pendingItem) {
  if (!pendingItem) {
    return routePath;
  }

  const separator = routePath.includes("?") ? "&" : "?";
  return `${routePath}${separator}state=${encodePendingItem(pendingItem)}`;
}

function pendingItemFromRequest(req, session) {
  if (session.pendingItem) {
    return session.pendingItem;
  }

  const stateParam = new URL(req.url, "http://localhost").searchParams.get("state");
  const decoded = decodePendingItem(stateParam);

  if (decoded) {
    session.pendingItem = decoded;
  }

  return decoded;
}

function ensurePendingItemDefaults(item) {
  if (!item || !item.style || !item.category) {
    return item;
  }

  if (isBoysItem(item)) {
    item.collar = cloneOption(isChassidishItem(item) ? CHASSIDISH_COLLAR : BOYS_STANDARD_COLLAR);
    item.pocket = cloneOption(isChassidishItem(item) ? pockets[1] : pockets[2]);
  } else if (isChassidishItem(item)) {
    item.collar = cloneOption(CHASSIDISH_COLLAR);
  } else if (item.collar && collarId(item.collar) === "spread") {
    item.collar = cloneOption(collars[1]);
  }

  if (isShortSleeveItem(item)) {
    item.cuff = cloneOption(SHORT_SLEEVE_CUFF);
  } else if (item.sleeve && isBoysItem(item) && isChassidishItem(item)) {
    item.cuff = cloneOption(cuffs[1]);
  } else if (item.cuff && cuffId(item.cuff) === "short-sleeve") {
    delete item.cuff;
  }

  return item;
}

async function clearSession(callSid, from) {
  const key = sessionKeyForCaller(callSid, from);
  const caller = String(from || "").trim();
  const phoneKey = caller ? `phone:${caller}` : null;
  const callKey = callSid ? String(callSid).trim() : null;

  sessions.delete(key);
  if (phoneKey) {
    sessions.delete(phoneKey);
    await deleteSession(phoneKey);
  }
  if (callKey) {
    sessions.delete(callKey);
    await deleteSession(callKey);
  }
  if (key !== phoneKey && key !== callKey) {
    await deleteSession(key);
  }

  if (caller) {
    await deleteSessionsByCaller(caller);

    for (const [sessionKey, sessionRecord] of sessions.entries()) {
      if (sessionRecord && String(sessionRecord.caller || "").trim() === caller) {
        sessions.delete(sessionKey);
      }
    }
  }

  if (callSid) {
    callSidSessionKeys.delete(callSid);
  }
}

async function resetSessionState(callSid, from) {
  const caller = String(from || "").trim();
  const callKey = callSid ? String(callSid).trim() : "";

  await clearSession(callSid, from);

  const canonicalKey = caller ? `phone:${caller}` : callKey;
  if (!canonicalKey) {
    return;
  }

  const emptySession = sanitizeSession({
    caller,
    lastCallSid: callKey,
    updatedAt: new Date().toISOString(),
    cart: []
  });

  sessions.set(canonicalKey, emptySession);
  await saveSession(canonicalKey, emptySession);

  if (callKey) {
    callSidSessionKeys.set(callKey, canonicalKey);
  }
}

async function persistSessionState(key, session) {
  const sanitized = sanitizeSession({
    ...(session && typeof session === "object" ? session : {}),
    updatedAt: new Date().toISOString()
  });
  const phoneKey = sanitized.caller ? `phone:${sanitized.caller}` : null;
  const callKey = sanitized.lastCallSid || null;

  sessions.set(key, sanitized);
  await saveSession(key, sanitized);

  if (phoneKey && phoneKey !== key) {
    sessions.set(phoneKey, sanitized);
    await saveSession(phoneKey, sanitized);
  }

  if (callKey && callKey !== key && callKey !== phoneKey) {
    sessions.set(callKey, sanitized);
    await saveSession(callKey, sanitized);
  }
}

function skuCategoryCode(category) {
  return categoryId(category) === "mens" ? "M" : "B";
}

function skuCollarCode(collar) {
  const mapping = {
    spread: "S",
    cutaway: "C",
    pointy: "P"
  };
  return mapping[collarId(collar)] || "S";
}

function skuFitCode(fit) {
  const mapping = {
    classic: "C",
    traditional: "C",
    slim: "S",
    "extra slim": "E",
    "super slim": "X",
    husky: "H"
  };
  return mapping[fitId(fit)] || "C";
}

function skuSizeSegment(size, sleeve, category) {
  if (categoryId(category) === "boys") {
    return sizeId(size);
  }

  const isHalf = String(size).includes(".5");
  const whole = String(size).replace(".5", "");

  if (sleeveId(sleeve) === "short-sleeve") {
    return `${whole}${isHalf ? "H" : ""}`;
  }

  return `${whole}${isHalf ? "H" : ""}${String(rawOptionValue(sleeve) || "").trim()}`;
}

function buildSku(item) {
  const prefix = `${skuCategoryCode(item.category)}T${skuCollarCode(item.collar)}${skuFitCode(item.fit)}`;
  const segments = ["DP"];

  if (isChassidishItem(item)) {
    segments.push("ROL");
  }
  if (cuffId(item.cuff) === "french") {
    segments.push("FC");
  }
  if (pocketId(item.pocket) === "with-pocket") {
    segments.push("PKT");
  }
  if (isShortSleeveItem(item)) {
    segments.push("SS");
  }

  segments.push(skuSizeSegment(item.size, item.sleeve, item.category));
  return [prefix, ...segments].join("-");
}

function normalizeStoredItem(item) {
  const normalized = { ...item };

  if (normalized.collar === "standard") {
    normalized.collar = "spread";
  }

  if (!normalized.sku) {
    normalized.sku = buildSku(normalized);
  }

  normalized.unitPrice = calculateUnitPrice(normalized);
  normalized.lineTotal = calculateLineTotal(normalized);

  return normalized;
}

function formatCartLine(item, index) {
  return `Item ${index + 1}. Quantity ${item.quantity}, ${itemSpeechParts(item).join(", ")}, fabric twill, line total ${calculateLineTotal(item)} dollars.`;
}

function formatCartForSpeech(cart) {
  if (cart.length === 0) {
    return "Your cart is empty.";
  }

  return cart.map(formatCartLine).join(" ");
}

function formatCartPlaybackLine(item, index, totalItems) {
  const parts = [
    `Item ${index + 1} of ${totalItems},`,
    `quantity ${item.quantity},`,
    `${item.category} ${item.style} shirt,`,
    `collar ${item.collar},`,
    `size ${item.size},`,
    `sleeve ${item.sleeve},`,
    `fit ${item.fit},`
  ];

  if (!isBoysItem(item)) {
    parts.push(`${String(item.pocket || "").replace(/\.$/, "")},`);
  }

  parts.push(
    `${String(item.cuff || "").replace(/\.$/, "")},`,
    `fabric twill,`,
    `Line total ${calculateLineTotal(item)} dollars.`
  );

  return parts.join(" ");
}

function cartQuantity(cart) {
  return cart.reduce((sum, item) => sum + item.quantity, 0);
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function xml(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "text/xml; charset=utf-8" });
  res.end(payload);
}

function html(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
  res.end(payload);
}

function htmlWithHeaders(res, statusCode, headers, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    ...(headers || {})
  });
  res.end(payload);
}

function htmlNoCache(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Pragma: "no-cache",
    Expires: "0"
  });
  res.end(payload);
}

function file(res, statusCode, contentType, payload) {
  res.writeHead(statusCode, { "Content-Type": contentType });
  res.end(payload);
}

function redirectResponse(res, location, headers = {}) {
  res.writeHead(303, {
    Location: location,
    "Cache-Control": "no-store",
    ...headers
  });
  res.end("");
}

function notFound(res) {
  json(res, 404, { error: "Not found" });
}

function isAdminPagePath(pathname) {
  return pathname === "/" || pathname === "/index.html" || pathname === "/orders" || pathname === "/testivr" || pathname === "/testivr/index.html";
}

function isProtectedAdminApiPath(pathname) {
  return (
    pathname === "/api/orders" ||
    pathname === "/api/admin/settings" ||
    pathname === "/api/testivr/settings" ||
    pathname === "/api/twilio/test/reset"
  );
}

function isPublicAssetPath(pathname) {
  return pathname === "/logo-aistone.png" || pathname === "/health" || pathname === "/api/health";
}

function loginPathForRequest(req) {
  return buildMountedPath(req.url, "/login");
}

function logoutPathForRequest(req) {
  return buildMountedPath(req.url, "/logout");
}

function nextPathForRequest(req, fallback = "/") {
  const current = new URL(String(req.url || fallback), "http://localhost");
  return sanitizeNextPath(`${current.pathname}${current.search}`, fallback);
}

function redirectToLogin(res, req) {
  const loginPath = loginPathForRequest(req);
  const nextPath = nextPathForRequest(req, "/");
  const separator = loginPath.includes("?") ? "&" : "?";
  redirectResponse(res, `${loginPath}${separator}next=${encodeURIComponent(nextPath)}`);
}

function unauthorizedAdminApi(res) {
  res.writeHead(401, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify({ error: "Unauthorized" }, null, 2));
}

function authMisconfiguredResponse(res, isApi) {
  if (isApi) {
    res.writeHead(503, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(JSON.stringify({ error: "Admin authentication is not configured." }, null, 2));
    return;
  }

  htmlWithHeaders(
    res,
    503,
    {
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin"
    },
    renderLoginPage({ error: "Admin authentication is not configured." })
  );
}

function shouldEnforceAdminAuth(pathname) {
  return isAdminPagePath(pathname) || isProtectedAdminApiPath(pathname);
}

function renderLoginPage({ error = "", nextPath = "/", logout = false, username = "" } = {}) {
  const configuredUsername = escapeXml(authConfig().username);
  const safeMessage = escapeXml(error);
  const safeNextPath = escapeXml(sanitizeNextPath(nextPath, "/"));
  const safeUsername = escapeXml(String(username || "").trim());
  const notice = logout ? "<p class=\"notice\">You have been signed out.</p>" : "";
  const errorMarkup = safeMessage ? `<p class="error">${safeMessage}</p>` : "";

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Admin Login</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f3eee7;
        --panel: #fffdf8;
        --ink: #1d1c18;
        --muted: #6a6258;
        --accent: #8a5a12;
        --border: rgba(29, 28, 24, 0.12);
        --error: #a11b1b;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        background:
          radial-gradient(circle at top left, rgba(138, 90, 18, 0.14), transparent 32%),
          linear-gradient(160deg, #f6f1e9 0%, var(--bg) 55%, #ede4d8 100%);
        color: var(--ink);
        font-family: Georgia, "Times New Roman", serif;
      }
      .card {
        width: min(420px, 100%);
        padding: 32px 28px;
        border-radius: 20px;
        background: var(--panel);
        border: 1px solid var(--border);
        box-shadow: 0 24px 64px rgba(29, 28, 24, 0.12);
      }
      h1 {
        margin: 0 0 10px;
        font-size: 1.9rem;
      }
      p {
        margin: 0 0 18px;
        line-height: 1.5;
        color: var(--muted);
      }
      .notice, .error {
        padding: 12px 14px;
        border-radius: 12px;
        margin-bottom: 16px;
        font-size: 0.96rem;
      }
      .notice {
        background: rgba(138, 90, 18, 0.08);
        color: var(--ink);
      }
      .error {
        background: rgba(161, 27, 27, 0.08);
        color: var(--error);
      }
      label {
        display: block;
        margin-bottom: 10px;
        font-weight: 600;
      }
      input {
        width: 100%;
        padding: 14px 15px;
        border-radius: 12px;
        border: 1px solid var(--border);
        background: white;
        font: inherit;
        margin-bottom: 18px;
      }
      button {
        width: 100%;
        border: 0;
        border-radius: 999px;
        padding: 14px 18px;
        font: inherit;
        font-weight: 700;
        color: white;
        background: linear-gradient(135deg, #8a5a12 0%, #b3751d 100%);
        cursor: pointer;
      }
      .footnote {
        margin-top: 16px;
        font-size: 0.88rem;
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>Admin Login</h1>
      <p>Sign in to access the order dashboard, IVR test page, and transfer tools.</p>
      ${notice}
      ${errorMarkup}
      <form method="POST" action="/login" autocomplete="off">
        <input type="hidden" name="next" value="${safeNextPath}" />
        <label for="username">Username</label>
        <input id="username" name="username" type="text" value="${safeUsername}" autocomplete="username" required />
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required />
        <button type="submit">Sign In</button>
      </form>
      <p class="footnote">This session uses an HttpOnly signed cookie and expires automatically.</p>
    </main>
  </body>
</html>`;
}

function normalizeMainSelection(input) {
  const text = String(input || "").trim().toLowerCase();
  const mapping = {
    "1": "1",
    one: "1",
    order: "1",
    shirts: "1",
    "place an order": "1",
    "2": "2",
    two: "2",
    cart: "2",
    review: "2",
    "hear cart": "2",
    "3": "3",
    three: "3",
    hours: "3",
    "store hours": "3",
    "4": "4",
    four: "4",
    representative: "4",
    agent: "4"
  };
  return mapping[text] || text;
}

function normalizeSimpleSelection(input, synonyms) {
  const text = String(input || "").trim().toLowerCase();
  return synonyms[text] || text;
}

function normalizeCategorySelection(input) {
  return normalizeSimpleSelection(input, {
    "1": "1",
    one: "1",
    mens: "1",
    men: "1",
    "2": "2",
    two: "2",
    boys: "2",
    boy: "2"
  });
}

function normalizeStyleSelection(input) {
  return normalizeSimpleSelection(input, {
    "1": "1",
    one: "1",
    standard: "1",
    spread: "1",
    cutaway: "1",
    "2": "2",
    two: "2",
    chassidish: "2",
    pointy: "2",
    "pointy collar": "2"
  });
}

function normalizeCollarSelection(input) {
  return normalizeSimpleSelection(input, {
    "1": "1",
    one: "1",
    spread: "1",
    "2": "2",
    two: "2",
    cutaway: "2"
  });
}

function normalizeFitSelection(input) {
  return normalizeSimpleSelection(input, {
    "1": "1",
    one: "1",
    "super slim": "1",
    "2": "2",
    two: "2",
    "extra slim": "2",
    "3": "3",
    three: "3",
    slim: "3",
    "4": "4",
    four: "4",
    classic: "4",
    "5": "5",
    five: "5",
    traditional: "5",
    "6": "6",
    six: "6",
    husky: "6"
  });
}

function normalizePocketSelection(input) {
  return normalizeSimpleSelection(input, {
    "1": "1",
    one: "1",
    yes: "1",
    pocket: "1",
    "with pocket": "1",
    "2": "2",
    two: "2",
    no: "2",
    "without pocket": "2"
  });
}

function normalizeCuffSelection(input) {
  return normalizeSimpleSelection(input, {
    "1": "1",
    one: "1",
    button: "1",
    "button cuff": "1",
    "2": "2",
    two: "2",
    french: "2",
    "french cuff": "2"
  });
}

function normalizePostAddSelection(input) {
  return normalizeSimpleSelection(input, {
    "1": "1",
    one: "1",
    add: "1",
    "add another": "1",
    "2": "2",
    two: "2",
    cart: "2",
    review: "2",
    "hear cart": "2",
    "3": "3",
    three: "3",
    confirm: "3",
    place: "3",
    "place order": "3"
  });
}

function normalizeCartPlaybackSelection(input) {
  return normalizeSimpleSelection(input, {
    "1": "1",
    one: "1",
    previous: "1",
    back: "1",
    "3": "3",
    three: "3",
    skip: "3",
    next: "3",
    "5": "5",
    five: "5",
    delete: "5",
    remove: "5",
    "7": "7",
    seven: "7",
    quantity: "7",
    change: "7",
    update: "7"
  });
}

function isRepeatPromptSubmission(form) {
  const digits = typeof form?.Digits === "string" ? form.Digits.trim() : "";
  const speech = typeof form?.SpeechResult === "string" ? form.SpeechResult.trim() : "";

  if (speech) {
    return false;
  }

  if (digits === "#") {
    return true;
  }

  return Object.prototype.hasOwnProperty.call(form || {}, "Digits") && digits === "";
}

function discountCodeContextTarget(context) {
  return context === "intro" ? "/api/twilio/voice" : "/api/twilio/order/finalize";
}

function itemSpeechParts(item) {
  const parts = [
    `${item.category} ${item.style} shirt`,
    `size ${item.size}`,
    `sleeve ${item.sleeve}`,
    item.fit
  ];

  if (!isBoysItem(item)) {
    parts.push(item.pocket);
  }

  parts.push(item.cuff);
  return parts.filter(Boolean);
}

function describePendingItem(item) {
  const parts = [
    `${item.category.name} ${item.style.name} ${item.collar.name} twill shirt`,
    `size ${item.size.name}`,
    `sleeve ${item.sleeve.name}`,
    item.fit.name
  ];

  if (!isBoysItem(item)) {
    parts.push(item.pocket?.name);
  }

  parts.push(item.cuff.name);
  return `a ${parts.filter(Boolean).join(", ")}`;
}

function isDevServerBaseUrl(baseUrl) {
  return baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1") || baseUrl.includes("ngrok");
}

function mainMenuResponse(baseUrl) {
  return twiml([
    ...(isDevServerBaseUrl(baseUrl) ? [say("Using dev server.")] : []),
    gather(baseUrl, {
      action: "/api/twilio/menu",
      input: "dtmf",
      numDigits: 1,
      hints: "order shirts, cart, hours, representative",
      prompt:
        "Welcome to Appreciation Initiative shirt ordering. Press 1 to order shirts. Press 2 to hear what is in your cart. Press 3 for store hours. Press 4 to speak with a representative."
    }),
    say("We did not receive a valid selection."),
    redirect(baseUrl, "/api/twilio/voice")
  ]);
}

function categoryMenuResponse(baseUrl) {
  return twiml([
    gather(baseUrl, {
      action: "/api/twilio/order/category",
      input: "dtmf",
      numDigits: 1,
      hints: "mens, boys",
      prompt: "Press 1 for mens. Press 2 for boys. Press star to go back."
    }),
    say("We did not receive a category selection."),
    redirect(baseUrl, "/api/twilio/order/current")
  ]);
}

function styleMenuResponse(baseUrl, pendingItem) {
  const categoryName = pendingItem?.category?.name || "that category";
  return twiml([
    gather(baseUrl, {
      action: withPendingState("/api/twilio/order/style", pendingItem),
      input: "dtmf",
      numDigits: 1,
      hints: "standard, khoss seedish",
      prompt: `You selected ${categoryName}. Press 1 for standard shirts. Press 2 for khoss seedish shirts. Press star to go back.`
    }),
    say("We did not receive a style selection."),
    redirect(baseUrl, withPendingState("/api/twilio/order/current", pendingItem))
  ]);
}

function sizeMenuResponse(baseUrl, pendingItem) {
  if (isBoysItem(pendingItem)) {
    return twiml([
      gather(baseUrl, {
        action: withPendingState("/api/twilio/order/size", pendingItem),
        finishOnKey: "#",
        timeout: DEFAULT_SELECTION_TIMEOUT,
        input: "dtmf",
        hints: "4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 22",
        prompt:
          "Enter the boys size, then press pound. Available sizes are 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, and 22. Press star to go back."
      }),
      say("We did not receive a size."),
      redirect(baseUrl, withPendingState("/api/twilio/order/current", pendingItem))
    ]);
  }

  return twiml([
    gather(baseUrl, {
      action: withPendingState("/api/twilio/order/size", pendingItem),
      finishOnKey: "#",
      timeout: DEFAULT_SELECTION_TIMEOUT,
      input: "dtmf",
      hints: "14, 14.5, 15, 15.5, 16, 16.5, 17, 17.5, 18, 18.5, 19, 19.5, 20",
      prompt:
        "Enter neck size between 14 and 20. For size 14, press 1 then 4. For size 14 and a half, press 1, 4, 5. Use the same pattern for the other sizes. Press star to go back."
    }),
    say("We did not receive a size."),
    redirect(baseUrl, withPendingState("/api/twilio/order/current", pendingItem))
  ]);
}

function collarMenuResponse(baseUrl, pendingItem) {
  return twiml([
    gather(baseUrl, {
      action: withPendingState("/api/twilio/order/collar", pendingItem),
      input: "dtmf",
      numDigits: 1,
      hints: "spread, cutaway",
      prompt: "Press 1 for spread. Press 2 for cutaway. Press star to go back."
    }),
    say("We did not receive a collar selection."),
    redirect(baseUrl, withPendingState("/api/twilio/order/current", pendingItem))
  ]);
}

function sleeveMenuResponse(baseUrl, sizeName, pendingItem) {
  if (isBoysItem(pendingItem)) {
    return twiml([
      gather(baseUrl, {
        action: withPendingState("/api/twilio/order/sleeve", pendingItem),
        input: "dtmf",
        numDigits: 1,
        hints: "long sleeve, short sleeve",
        prompt: `You selected size ${sizeName}. Press 1 for long sleeve. Press 2 for short sleeve. Press star to go back.`
      }),
      say("We did not receive a sleeve selection."),
      redirect(baseUrl, withPendingState("/api/twilio/order/current", pendingItem))
    ]);
  }

  return twiml([
    gather(baseUrl, {
      action: withPendingState("/api/twilio/order/sleeve", pendingItem),
      input: "dtmf",
      numDigits: 2,
      hints: "30, 31, 32, 33, 34, 35, 36, 37, short sleeve",
      prompt: `You selected size ${sizeName}. Enter sleeve size between 30 and 37, or enter 0 for short sleeves. Press star to go back.`
    }),
    say("We did not receive a sleeve selection."),
    redirect(baseUrl, withPendingState("/api/twilio/order/current", pendingItem))
  ]);
}

function availableFitsForItem(pendingItem) {
  if (isBoysItem(pendingItem)) {
    return {
      1: fits[4],
      2: fits[3],
      3: fits[2],
      4: fits[1],
      5: fits[6],
      6: fits[5]
    };
  }

  return {
    1: fits[4],
    2: fits[3],
    3: fits[2],
    4: fits[1]
  };
}

function fitMenuResponse(baseUrl, sleeveName, pendingItem) {
  const isBoys = isBoysItem(pendingItem);
  return twiml([
    gather(baseUrl, {
      action: withPendingState("/api/twilio/order/fit", pendingItem),
      input: "dtmf",
      numDigits: 1,
      hints: isBoys ? "super slim, extra slim, slim, classic, traditional, husky" : "super slim, extra slim, slim, classic",
      prompt: isBoys
        ? `You selected sleeve ${sleeveName}. Press 1 for super slim. Press 2 for extra slim. Press 3 for slim. Press 4 for classic. Press 5 for traditional. Press 6 for husky. Press star to go back.`
        : `You selected sleeve ${sleeveName}. Press 1 for super slim. Press 2 for extra slim. Press 3 for slim. Press 4 for classic. Press star to go back.`
    }),
    say("We did not receive a fit selection."),
    redirect(baseUrl, withPendingState("/api/twilio/order/current", pendingItem))
  ]);
}

function pocketMenuResponse(baseUrl, pendingItem) {
  return twiml([
    gather(baseUrl, {
      action: withPendingState("/api/twilio/order/pocket", pendingItem),
      input: "dtmf",
      numDigits: 1,
      hints: "yes, no, pocket",
      prompt: "Press 1 for with pocket. Press 2 for without pocket. Press star to go back."
    }),
    say("We did not receive a pocket selection."),
    redirect(baseUrl, withPendingState("/api/twilio/order/current", pendingItem))
  ]);
}

function cuffMenuResponse(baseUrl, sleeveName, pendingItem) {
  if (sleeveId(sleeveName) === "short-sleeve") {
    return quantityMenuResponse(baseUrl, describePendingItem(pendingItem), pendingItem);
  }

  return twiml([
    gather(baseUrl, {
      action: withPendingState("/api/twilio/order/cuff", pendingItem),
      input: "dtmf",
      numDigits: 1,
      hints: "button, french",
      prompt: "Press 1 for button cuff. Press 2 for french cuff. Press star to go back."
    }),
    say("We did not receive a cuff selection."),
    redirect(baseUrl, withPendingState("/api/twilio/order/current", pendingItem))
  ]);
}

function quantityMenuResponse(baseUrl, itemDescription, pendingItem) {
  return twiml([
    gather(baseUrl, {
      action: withPendingState("/api/twilio/order/quantity", pendingItem),
      input: "dtmf",
      finishOnKey: "#",
      timeout: DEFAULT_SELECTION_TIMEOUT,
      prompt: `You selected ${itemDescription}. Enter the quantity, then press pound, or press star to go back.`
    }),
    say("We did not receive a quantity."),
    redirect(baseUrl, withPendingState("/api/twilio/order/current", pendingItem))
  ]);
}

function preorderUnavailableResponse(baseUrl, pendingItem) {
  return twiml([
    say("That shirt is not available for pre order. Press star to go back and change the shirt details."),
    redirect(baseUrl, withPendingState("/api/twilio/order/current", pendingItem))
  ]);
}

function normalizeDiscountCodeInput(input) {
  return String(input || "")
    .trim()
    .replace(/[^\d]/g, "");
}

function discountCodeMenuResponse(baseUrl, context = "summary") {
  const action = `/api/twilio/order/discount-code?context=${encodeURIComponent(context)}`;
  return twiml([
    gather(baseUrl, {
      action,
      input: "dtmf",
      finishOnKey: "#",
      timeout: DEFAULT_SELECTION_TIMEOUT + 1,
      hints: "discount code, 0 1 2 3 4 5 6 7 8 9, back, star",
      prompt:
        context === "intro"
          ? "Please enter your numeric discount code now, then press pound. This code is required before you can continue."
          : "Enter your numeric discount code now and press pound. Press pound with no digits to continue, or press star to go back."
    }),
    say("We did not receive a discount code."),
    redirect(baseUrl, action)
  ]);
}

function discountCodeRetryResponse(baseUrl, context = "summary") {
  return twiml([
    gather(baseUrl, {
      action: `/api/twilio/order/discount-code/review?context=${encodeURIComponent(context)}`,
      input: "dtmf",
      numDigits: 1,
      hints: "retry, back",
      prompt: "We could not verify that discount code. Press 1 to try again, or press star to go back."
    }),
    say("We did not receive a valid selection."),
    redirect(baseUrl, `/api/twilio/order/discount-code?context=${encodeURIComponent(context)}`)
  ]);
}

function postAddMenuResponse(baseUrl, session, addedItem) {
  const totalUnits = cartQuantity(session.cart);
  const totalPrice = calculateOrderTotal(session.cart);
  const parts = [];

  if (addedItem) {
    parts.push(
      say(`You added quantity ${addedItem.quantity}, ${itemSpeechParts(addedItem).join(", ")}.`)
    );
  }

  parts.push(
    gather(baseUrl, {
      action: "/api/twilio/order/next",
      input: "dtmf",
      numDigits: 1,
      hints: "add another, hear cart, discount code",
      prompt: `Your total, including 10 dollars shipping, will be ${totalPrice} dollars after discount code is applied. You currently have ${totalUnits} shirts in your cart. Press 1 to add another shirt. Press 2 to play your cart again. Press 3 to review your discount code and place this order.`
    })
  );
  parts.push(say("We did not receive a valid selection."));
  parts.push(redirect(baseUrl, "/api/twilio/order/summary"));

  return twiml(parts);
}

function cartReturnPath(context) {
  return context === "postadd" || context === "summary" ? "/api/twilio/order/summary" : "/api/twilio/voice";
}

function buildCartPlaybackRoute(context, index, announce = false) {
  const params = new URLSearchParams({
    context,
    index: String(index)
  });

  if (announce) {
    params.set("announce", "1");
  }

  return `/api/twilio/cart/play?${params.toString()}`;
}

function cartPlaybackResponse(baseUrl, session, context, index, announce) {
  if (!session.cart.length) {
    return twiml([say("Your cart is empty."), redirect(baseUrl, cartReturnPath(context))]);
  }

  const safeIndex = Math.max(0, Math.min(index, session.cart.length - 1));
  const item = session.cart[safeIndex];
  const parts = [];
  const prompt = announce
    ? `While listening to the cart, press 1 to go to the previous item. Press 3 to skip to the next item. Press 5 to delete this item from your cart. Press 7 to change this item's quantity. ${formatCartPlaybackLine(item, safeIndex, session.cart.length)}`
    : formatCartPlaybackLine(item, safeIndex, session.cart.length);

  parts.push(
    gather(baseUrl, {
      action: `/api/twilio/cart/control?context=${encodeURIComponent(context)}&index=${safeIndex}`,
      input: "dtmf",
      numDigits: 1,
      timeout: CART_PLAYBACK_TIMEOUT,
      hints: "previous, back, skip, next, delete, remove, quantity, change, update",
      prompt
    })
  );

  if (safeIndex < session.cart.length - 1) {
    parts.push(redirect(baseUrl, buildCartPlaybackRoute(context, safeIndex + 1)));
  } else {
    parts.push(say("End of cart."));
    parts.push(redirect(baseUrl, cartReturnPath(context)));
  }

  return twiml(parts);
}

function cartControlResponse(baseUrl, session, context, index, selection) {
  if (!session.cart.length) {
    return twiml([say("Your cart is empty."), redirect(baseUrl, cartReturnPath(context))]);
  }

  const safeIndex = Math.max(0, Math.min(index, session.cart.length - 1));

  if (!selection) {
    if (safeIndex >= session.cart.length - 1) {
      return twiml([say("End of cart."), redirect(baseUrl, cartReturnPath(context))]);
    }

    return twiml([redirect(baseUrl, buildCartPlaybackRoute(context, safeIndex + 1))]);
  }

  if (selection === "1") {
    return twiml([redirect(baseUrl, buildCartPlaybackRoute(context, Math.max(safeIndex - 1, 0)))]);
  }

  if (selection === "3") {
    if (safeIndex >= session.cart.length - 1) {
      return twiml([say("End of cart."), redirect(baseUrl, cartReturnPath(context))]);
    }

    return twiml([redirect(baseUrl, buildCartPlaybackRoute(context, safeIndex + 1))]);
  }

  return twiml([redirect(baseUrl, buildCartPlaybackRoute(context, safeIndex))]);
}

function invalidSelectionResponse(baseUrl, message, fallbackPath) {
  return twiml([say(message), redirect(baseUrl, fallbackPath)]);
}

function normalizeSizeInput(input, pendingItem) {
  const text = String(input || "").trim().toLowerCase();
  const digitWordMap = {
    zero: "0",
    one: "1",
    two: "2",
    three: "3",
    four: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    nine: "9"
  };
  const normalizedWords = Object.entries(digitWordMap).reduce(
    (value, [word, digit]) => value.replace(new RegExp(`\\b${word}\\b`, "g"), digit),
    text
  )
    .replace(/\band a half\b/g, ".5")
    .replace(/\bhalf\b/g, ".5")
    .replace(/\bpoint five\b/g, ".5")
    .replace(/\s+/g, "");
  const compact = normalizedWords.replace(/[^\d.]/g, "");

  if (isBoysItem(pendingItem)) {
    return Object.prototype.hasOwnProperty.call(boysSizes, compact) ? compact : "";
  }

  const mapping = {
    "14": "14",
    "145": "14.5",
    "14.5": "14.5",
    "15": "15",
    "155": "15.5",
    "15.5": "15.5",
    "16": "16",
    "165": "16.5",
    "16.5": "16.5",
    "17": "17",
    "175": "17.5",
    "17.5": "17.5",
    "18": "18",
    "185": "18.5",
    "18.5": "18.5",
    "19": "19",
    "195": "19.5",
    "19.5": "19.5",
    "20": "20"
  };
  return mapping[compact] || "";
}

function orderMenuResponseForStep(step, baseUrl, item) {
  switch (step) {
    case "category":
      return categoryMenuResponse(baseUrl);
    case "style":
      return styleMenuResponse(baseUrl, item);
    case "collar":
      return collarMenuResponse(baseUrl, item);
    case "size":
      return sizeMenuResponse(baseUrl, item);
    case "sleeve":
      return sleeveMenuResponse(baseUrl, item.size.name, item);
    case "fit":
      return fitMenuResponse(baseUrl, item.sleeve.name, item);
    case "pocket":
      return pocketMenuResponse(baseUrl, item);
    case "cuff":
      return cuffMenuResponse(baseUrl, item.sleeve.name, item);
    default:
      return categoryMenuResponse(baseUrl);
  }
}

function currentOrderMenuResponse(baseUrl, session) {
  const item = ensurePendingItemDefaults(session.pendingItem || {});
  const nextStep = orderSelectionSteps(item).find((step) => !isOrderStepComplete(item, step));

  if (nextStep) {
    return orderMenuResponseForStep(nextStep, baseUrl, item);
  }

  if (item.cuff) {
    return quantityMenuResponse(baseUrl, describePendingItem(item), item);
  }

  return categoryMenuResponse(baseUrl);
}

function goToPreviousOrderMenu(baseUrl, session) {
  if (!session.pendingItem) {
    return categoryMenuResponse(baseUrl);
  }

  const item = ensurePendingItemDefaults(session.pendingItem);
  const completedSteps = orderSelectionSteps(item).filter((step) => step !== "category" && isOrderStepComplete(item, step));
  const previousStep = completedSteps[completedSteps.length - 1];

  if (!previousStep) {
    delete session.pendingItem;
    return categoryMenuResponse(baseUrl);
  }

  clearPendingItemFromStep(item, previousStep);
  ensurePendingItemDefaults(item);
  return currentOrderMenuResponse(baseUrl, session);
}

async function handleLoginPage(req, res) {
  if (!isAdminAuthConfigured()) {
    authMisconfiguredResponse(res, false);
    return;
  }

  if (isAdminAuthenticated(req)) {
    const current = new URL(String(req.url || "/login"), "http://localhost");
    redirectResponse(res, sanitizeNextPath(current.searchParams.get("next"), "/"));
    return;
  }

  const current = new URL(String(req.url || "/login"), "http://localhost");
  const nextPath = sanitizeNextPath(current.searchParams.get("next"), "/");
  const logout = current.searchParams.get("logout") === "1";
  htmlWithHeaders(
    res,
    200,
    {
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'"
    },
    renderLoginPage({ nextPath, logout })
  );
}

async function handleLoginSubmit(req, res) {
  const form = await parseFormBody(req);
  req.body = form;

  if (!isAdminAuthConfigured()) {
    authMisconfiguredResponse(res, false);
    return;
  }

  const nextPath = sanitizeNextPath(form.next, "/");
  const username = String(form.username || "").trim();
  const password = String(form.password || "");
  if (!verifyAdminCredentials(username, password)) {
    await sleep(450);
    htmlWithHeaders(
      res,
      401,
      {
        "Cache-Control": "no-store",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "same-origin",
        "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'"
      },
      renderLoginPage({ error: "Invalid username or password.", nextPath, username })
    );
    return;
  }

  redirectResponse(
    res,
    nextPath,
    appendSetCookieHeader({}, buildAdminSessionCookie(req))
  );
}

async function handleLogout(req, res) {
  const loginPath = loginPathForRequest(req);
  const separator = loginPath.includes("?") ? "&" : "?";
  redirectResponse(
    res,
    `${loginPath}${separator}logout=1`,
    appendSetCookieHeader({}, buildClearedAdminSessionCookie(req))
  );
}

async function authorizeRequest(req, res, pathname) {
  if (pathname === "/login" || pathname === "/logout") {
    return true;
  }

  if (isPublicAssetPath(pathname)) {
    return true;
  }

  if (shouldEnforceAdminAuth(pathname)) {
    if (!isAdminAuthConfigured()) {
      authMisconfiguredResponse(res, pathname.startsWith("/api/"));
      return false;
    }

    if (isAdminAuthenticated(req)) {
      return true;
    }

    if (pathname.startsWith("/api/")) {
      unauthorizedAdminApi(res);
      return false;
    }

    redirectToLogin(res, req);
    return false;
  }

  return true;
}

async function handleVoiceWebhook(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { key, session } = await getSession(form.CallSid, form.From);

  if (String(session.discountCodePromptCallSid || "").trim() !== String(form.CallSid || "").trim()) {
    session.discountCodeEntryComplete = true;
    session.discountCodePromptCallSid = String(form.CallSid || "").trim();
    await persistSessionState(key, session);
    xml(res, 200, discountCodeMenuResponse(baseUrl, "intro"));
    return;
  }

  xml(res, 200, mainMenuResponse(baseUrl));
}

async function handleMainMenu(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { session } = await getSession(form.CallSid, form.From);

  if (isRepeatPromptSubmission(form)) {
    xml(res, 200, mainMenuResponse(baseUrl));
    return;
  }

  const selection = normalizeMainSelection(form.Digits || form.SpeechResult);

  if (selection === "1") {
    await warmPreorderCacheForOrderFlow();
    xml(res, 200, categoryMenuResponse(baseUrl));
    return;
  }

  if (selection === "2") {
    if (!session.cart.length) {
      xml(res, 200, twiml([say("Your cart is empty."), redirect(baseUrl, "/api/twilio/voice")]));
      return;
    }

    xml(res, 200, cartPlaybackResponse(baseUrl, session, "summary", 0, true));
    return;
  }

  if (selection === "3") {
    xml(
      res,
      200,
      twiml([
        say("Our ordering desk is open from 10 to 7."),
        redirect(baseUrl, "/api/twilio/voice")
      ])
    );
    return;
  }

  if (selection === "4") {
    xml(
      res,
      200,
      twiml([
        say("Please hold while we connect you."),
        `<Dial>${escapeXml(process.env.REPRESENTATIVE_NUMBER || "+15551234567")}</Dial>`
      ])
    );
    return;
  }

  xml(res, 200, invalidSelectionResponse(baseUrl, "Invalid entry. Try again.", "/api/twilio/voice"));
}

async function handleOrderStart(_req, res, baseUrl) {
  await warmPreorderCacheForOrderFlow();
  xml(res, 200, categoryMenuResponse(baseUrl));
}

async function handlePostAddSummary(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { key, session } = await getSession(form.CallSid, form.From);
  await persistSessionState(key, session);
  xml(res, 200, postAddMenuResponse(baseUrl, session));
}

async function handleDiscountCodeEntry(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { key, session } = await getSession(form.CallSid, form.From);
  const current = new URL(req.url, "http://localhost");
  const context = current.searchParams.get("context") === "intro" ? "intro" : "summary";
  const targetPath = discountCodeContextTarget(context);
  const spoken = String(form.SpeechResult || form.Digits || "").trim();

  if (wantsPreviousMenu(form) || spoken.toLowerCase() === "star") {
    if (context === "intro") {
      xml(res, 200, twiml([say("A discount code is required before you can continue."), twimlBody(discountCodeMenuResponse(baseUrl, context))]));
      return;
    }

    xml(res, 200, postAddMenuResponse(baseUrl, session));
    return;
  }

  if (!spoken) {
    if (context === "intro") {
      await persistSessionState(key, session);
      xml(res, 200, twiml([say("A discount code is required before you can continue."), twimlBody(discountCodeMenuResponse(baseUrl, context))]));
      return;
    }

    await persistSessionState(key, session);
    xml(res, 200, twiml([redirect(baseUrl, targetPath)]));
    return;
  }

  const normalizedCode = normalizeDiscountCodeInput(spoken);
  if (!normalizedCode) {
    delete session.discountCode;
    await persistSessionState(key, session);
    xml(res, 200, twiml([say("Please enter numbers only."), twimlBody(discountCodeMenuResponse(baseUrl, context))]));
    return;
  }

  try {
    const lookup = await lookupDiscountCode(normalizedCode);
    if (lookup && !lookup.unavailable) {
      session.discountCode = {
        code: normalizedCode,
        verified: true,
        title: lookup.title,
        status: lookup.status,
        type: lookup.type
      };
      await persistSessionState(key, session);
      xml(
        res,
        200,
        twiml([
          say(`Discount code ${normalizedCode} was found.`),
          redirect(baseUrl, targetPath)
        ])
      );
      return;
    }

    if (lookup?.unavailable) {
      session.discountCode = {
        code: normalizedCode,
        verified: false,
        lookupUnavailable: true
      };
      await persistSessionState(key, session);
      xml(
        res,
        200,
        twiml([
          say(`I heard ${normalizedCode}. We could not verify it right now, but we will include it on the draft order.`),
          redirect(baseUrl, targetPath)
        ])
      );
      return;
    }

    delete session.discountCode;
    await persistSessionState(key, session);
    if (context === "intro") {
      xml(
        res,
        200,
        twiml([
          say(`I heard ${normalizedCode}. That discount code was not found. Please try again.`),
          twimlBody(discountCodeMenuResponse(baseUrl, context))
        ])
      );
      return;
    }

    xml(res, 200, twiml([say(`I heard ${normalizedCode}. That discount code was not found. Please try again.`), twimlBody(discountCodeMenuResponse(baseUrl, context))]));
  } catch (_error) {
    session.discountCode = {
      code: normalizedCode,
      verified: false,
      lookupError: true
    };
    await persistSessionState(key, session);
    xml(
      res,
      200,
      twiml([
        say(`I heard ${normalizedCode}. We could not verify it right now, but we will include it on the draft order.`),
        redirect(baseUrl, targetPath)
      ])
    );
  }
}

async function handleDiscountCodeReview(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { key, session } = await getSession(form.CallSid, form.From);
  const current = new URL(req.url, "http://localhost");
  const context = current.searchParams.get("context") === "intro" ? "intro" : "summary";

  if (wantsPreviousMenu(form)) {
    xml(res, 200, context === "intro" ? mainMenuResponse(baseUrl) : postAddMenuResponse(baseUrl, session));
    return;
  }

  const selection = normalizeSimpleSelection(form.Digits || form.SpeechResult, {
    "1": "1",
    one: "1",
    retry: "1",
    again: "1"
  });

  if (selection === "1") {
    delete session.discountCode;
    await persistSessionState(key, session);
    xml(res, 200, discountCodeMenuResponse(baseUrl, context));
    return;
  }

  xml(
    res,
    200,
    invalidSelectionResponse(baseUrl, "Invalid entry. Try again.", `/api/twilio/order/discount-code?context=${encodeURIComponent(context)}`)
  );
}

async function handleTestReset(req, res) {
  const form = await parseFormBody(req);
  await resetSessionState(form.CallSid, form.From);
  json(res, 200, { ok: true });
}

async function handleTestSettingsGet(_req, res) {
  const config = await getRuntimeConfig();
  json(res, 200, config);
}

async function handleTestSettingsUpdate(req, res) {
  const form = await parseFormBody(req);
  const submitShopifyOrder = isTruthySetting(form.submitShopifyOrder);
  const skipCreditCardPayment = isTruthySetting(form.skipCreditCardPayment);
  const chargeCreditCardOneCent = !skipCreditCardPayment && isTruthySetting(form.chargeCreditCardOneCent);
  const config = await updateRuntimeConfig({
    submitShopifyOrder,
    skipCreditCardPayment,
    chargeCreditCardOneCent
  });
  json(res, 200, config);
}

async function handleCartPlayback(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { session } = await getSession(form.CallSid, form.From);
  const current = new URL(req.url, "http://localhost");
  const rawContext = current.searchParams.get("context");
  const context = rawContext === "postadd" || rawContext === "summary" ? rawContext : "voice";
  const index = Number(current.searchParams.get("index") || 0);
  const announce = current.searchParams.get("announce") === "1";

  xml(res, 200, cartPlaybackResponse(baseUrl, session, context, index, announce));
}

async function handleCartControl(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { key, session } = await getSession(form.CallSid, form.From);
  const current = new URL(req.url, "http://localhost");
  const rawContext = current.searchParams.get("context");
  const context = rawContext === "postadd" || rawContext === "summary" ? rawContext : "voice";
  const index = Number(current.searchParams.get("index") || 0);
  const selection = normalizeCartPlaybackSelection(form.Digits || form.SpeechResult);

  if (selection === "7") {
    xml(
      res,
      200,
      twiml([redirect(baseUrl, `/api/twilio/cart/quantity?context=${encodeURIComponent(context)}&index=${encodeURIComponent(index)}`)])
    );
    return;
  }

  if (selection === "5") {
    if (!session.cart.length) {
      xml(res, 200, twiml([say("Your cart is empty."), redirect(baseUrl, cartReturnPath(context))]));
      return;
    }

    const safeIndex = Math.max(0, Math.min(index, session.cart.length - 1));
    session.cart.splice(safeIndex, 1);

    if (!session.cart.length) {
      await resetSessionState(form.CallSid, form.From);
      xml(res, 200, twiml([say("Item deleted. Your cart is now empty."), redirect(baseUrl, cartReturnPath(context))]));
      return;
    }

    await persistSessionState(key, session);
    const nextIndex = Math.min(safeIndex, session.cart.length - 1);
    xml(
      res,
      200,
      twiml([say("Item deleted."), redirect(baseUrl, buildCartPlaybackRoute(context, nextIndex))])
    );
    return;
  }

  xml(res, 200, cartControlResponse(baseUrl, session, context, index, selection));
}

function cartQuantityMenuResponse(baseUrl, context, index, item) {
  return twiml([
    gather(baseUrl, {
      action: `/api/twilio/cart/quantity?context=${encodeURIComponent(context)}&index=${encodeURIComponent(index)}`,
      input: "dtmf",
      finishOnKey: "#",
      prompt: `Item ${index + 1} currently has quantity ${item.quantity}. Enter the new quantity, then press pound. Press star to go back.`
    }),
    say("We did not receive a quantity."),
    redirect(baseUrl, buildCartPlaybackRoute(context, index, true))
  ]);
}

async function handleCartQuantity(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { key, session } = await getSession(form.CallSid, form.From);
  const current = new URL(req.url, "http://localhost");
  const rawContext = current.searchParams.get("context");
  const context = rawContext === "postadd" || rawContext === "summary" ? rawContext : "voice";
  const index = Number(current.searchParams.get("index") || 0);

  if (!session.cart.length) {
    xml(res, 200, twiml([say("Your cart is empty."), redirect(baseUrl, cartReturnPath(context))]));
    return;
  }

  const safeIndex = Math.max(0, Math.min(index, session.cart.length - 1));
  const item = session.cart[safeIndex];

  if (wantsPreviousMenu(form)) {
    xml(res, 200, cartPlaybackResponse(baseUrl, session, context, safeIndex, true));
    return;
  }

  if (isRepeatPromptSubmission(form)) {
    xml(res, 200, cartQuantityMenuResponse(baseUrl, context, safeIndex, item));
    return;
  }

  const rawQuantity = String(form.Digits || form.SpeechResult || "").replace(/[^\d]/g, "");
  if (!rawQuantity) {
    xml(res, 200, cartQuantityMenuResponse(baseUrl, context, safeIndex, item));
    return;
  }

  const quantity = Number(rawQuantity);
  if (!quantity || quantity < 1 || quantity > 99) {
    xml(
      res,
      200,
      twiml([
        say("Please enter a quantity between 1 and 99."),
        twimlBody(cartQuantityMenuResponse(baseUrl, context, safeIndex, item))
      ])
    );
    return;
  }

  item.quantity = quantity;
  item.unitPrice = calculateUnitPrice(item);
  item.lineTotal = calculateLineTotal(item);
  await persistSessionState(key, session);
  xml(res, 200, twiml([say(`Quantity updated to ${quantity}.`), redirect(baseUrl, buildCartPlaybackRoute(context, safeIndex, true))]));
}

async function handleCurrentOrderMenu(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { key, session } = await getSession(form.CallSid, form.From);
  pendingItemFromRequest(req, session);
  ensurePendingItemDefaults(session.pendingItem);
  await persistSessionState(key, session);
  xml(res, 200, currentOrderMenuResponse(baseUrl, session));
}

async function handlePreviousOrderMenu(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { key, session } = await getSession(form.CallSid, form.From);
  pendingItemFromRequest(req, session);
  ensurePendingItemDefaults(session.pendingItem);
  const response = goToPreviousOrderMenu(baseUrl, session);
  await persistSessionState(key, session);
  xml(res, 200, response);
}

function wantsPreviousMenu(form) {
  return String(form.Digits || "").trim() === "*";
}

async function respondWithPreviousOrderMenu(res, baseUrl, key, session) {
  const response = goToPreviousOrderMenu(baseUrl, session);
  await persistSessionState(key, session);
  xml(res, 200, response);
}

async function warmPreorderCacheForOrderFlow() {
  try {
    await getPreorderCache();
  } catch (_error) {
    // Preorder availability is checked again before quantity and finalize.
  }
}

async function restartOrderFlow(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { key, session } = await getSession(form.CallSid, form.From);
  delete session.pendingItem;
  await persistSessionState(key, session);
  await warmPreorderCacheForOrderFlow();
  xml(res, 200, categoryMenuResponse(baseUrl));
}

async function handleCategorySelection(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { key, session } = await getSession(form.CallSid, form.From);

  if (wantsPreviousMenu(form)) {
    delete session.pendingItem;
    await persistSessionState(key, session);
    xml(res, 200, mainMenuResponse(baseUrl));
    return;
  }

  if (isRepeatPromptSubmission(form)) {
    xml(res, 200, categoryMenuResponse(baseUrl));
    return;
  }

  const selection = normalizeCategorySelection(form.Digits || form.SpeechResult);
  const category = categories[selection];

  if (!category) {
    xml(res, 200, invalidSelectionResponse(baseUrl, "Invalid entry. Try again.", "/api/twilio/order/current"));
    return;
  }

  session.pendingItem = { category };
  await persistSessionState(key, session);
  xml(res, 200, styleMenuResponse(baseUrl, session.pendingItem));
}

async function handleStyleSelection(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { key, session } = await getSession(form.CallSid, form.From);
  pendingItemFromRequest(req, session);

  if (wantsPreviousMenu(form)) {
    await respondWithPreviousOrderMenu(res, baseUrl, key, session);
    return;
  }

  if (isRepeatPromptSubmission(form)) {
    xml(res, 200, styleMenuResponse(baseUrl, session.pendingItem));
    return;
  }

  const selection = normalizeStyleSelection(form.Digits || form.SpeechResult);
  const style = styles[selection];

  if (!session.pendingItem || !session.pendingItem.category) {
    xml(res, 200, invalidSelectionResponse(baseUrl, "Invalid entry. Try again.", "/api/twilio/order/current"));
    return;
  }

  if (!style) {
    xml(res, 200, twiml([say("Invalid entry. Try again."), twimlBody(styleMenuResponse(baseUrl, session.pendingItem))]));
    return;
  }

  clearPendingItemFromStep(session.pendingItem, "style");
  session.pendingItem.style = style;
  ensurePendingItemDefaults(session.pendingItem);
  await persistSessionState(key, session);

  if (session.pendingItem.collar) {
    xml(res, 200, sizeMenuResponse(baseUrl, session.pendingItem));
    return;
  }

  xml(res, 200, collarMenuResponse(baseUrl, session.pendingItem));
}

async function handleCollarSelection(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { key, session } = await getSession(form.CallSid, form.From);
  pendingItemFromRequest(req, session);
  ensurePendingItemDefaults(session.pendingItem);

  if (wantsPreviousMenu(form)) {
    await respondWithPreviousOrderMenu(res, baseUrl, key, session);
    return;
  }

  if (isRepeatPromptSubmission(form)) {
    xml(res, 200, collarMenuResponse(baseUrl, session.pendingItem));
    return;
  }

  const rawSelection = String(form.Digits || form.SpeechResult || "").trim();
  const selection = normalizeCollarSelection(rawSelection);
  const collar = collars[selection];

  if (!session.pendingItem || !session.pendingItem.style) {
    xml(res, 200, invalidSelectionResponse(baseUrl, "Invalid entry. Try again.", "/api/twilio/order/current"));
    return;
  }

  if (!rawSelection) {
    xml(res, 200, collarMenuResponse(baseUrl, session.pendingItem));
    return;
  }

  if (!collar) {
    xml(res, 200, twiml([say("Invalid entry. Try again."), twimlBody(collarMenuResponse(baseUrl, session.pendingItem))]));
    return;
  }

  clearPendingItemFromStep(session.pendingItem, "collar");
  session.pendingItem.collar = collar;
  ensurePendingItemDefaults(session.pendingItem);
  await persistSessionState(key, session);
  xml(res, 200, sizeMenuResponse(baseUrl, session.pendingItem));
}

async function handleSizeSelection(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { key, session } = await getSession(form.CallSid, form.From);
  pendingItemFromRequest(req, session);
  ensurePendingItemDefaults(session.pendingItem);

  if (wantsPreviousMenu(form)) {
    await respondWithPreviousOrderMenu(res, baseUrl, key, session);
    return;
  }

  if (isRepeatPromptSubmission(form)) {
    xml(res, 200, sizeMenuResponse(baseUrl, session.pendingItem));
    return;
  }

  const rawInput = String(form.Digits || form.SpeechResult || "").trim();
  const sizeName = normalizeSizeInput(rawInput, session.pendingItem);
  const size = Object.values(getSizeCatalog(session.pendingItem)).find((entry) => entry.id === sizeName);

  if (!session.pendingItem || !session.pendingItem.category || !session.pendingItem.style || !session.pendingItem.collar) {
    xml(res, 200, invalidSelectionResponse(baseUrl, "Invalid entry. Try again.", "/api/twilio/order/current"));
    return;
  }

  if (!rawInput) {
    xml(res, 200, sizeMenuResponse(baseUrl, session.pendingItem));
    return;
  }

  if (!size) {
    xml(res, 200, twiml([say("Invalid entry. Try again."), twimlBody(sizeMenuResponse(baseUrl, session.pendingItem))]));
    return;
  }

  clearPendingItemFromStep(session.pendingItem, "size");
  session.pendingItem.size = size;
  ensurePendingItemDefaults(session.pendingItem);
  await persistSessionState(key, session);
  xml(res, 200, sleeveMenuResponse(baseUrl, size.name, session.pendingItem));
}

async function handleSleeveSelection(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { key, session } = await getSession(form.CallSid, form.From);
  pendingItemFromRequest(req, session);
  ensurePendingItemDefaults(session.pendingItem);

  if (wantsPreviousMenu(form)) {
    await respondWithPreviousOrderMenu(res, baseUrl, key, session);
    return;
  }

  if (isRepeatPromptSubmission(form)) {
    xml(res, 200, sleeveMenuResponse(baseUrl, session.pendingItem.size.name, session.pendingItem));
    return;
  }

  let sleeve;
  if (isBoysItem(session.pendingItem)) {
    const selection = normalizeSimpleSelection(form.Digits || form.SpeechResult, {
      "1": "1",
      one: "1",
      long: "1",
      "long sleeve": "1",
      "2": "2",
      two: "2",
      short: "2",
      "short sleeve": "2"
    });
    sleeve = boysSleeves[selection];
  } else {
    const sleeveInput = String(form.Digits || form.SpeechResult || "").replace(/[^\d]/g, "");
    sleeve = mensSleeves[sleeveInput];
  }

  if (!session.pendingItem || !session.pendingItem.size) {
    xml(res, 200, invalidSelectionResponse(baseUrl, "Invalid entry. Try again.", "/api/twilio/order/current"));
    return;
  }

  if (!sleeve) {
    xml(
      res,
      200,
      twiml([say("Invalid entry. Try again."), twimlBody(sleeveMenuResponse(baseUrl, session.pendingItem.size.name, session.pendingItem))])
    );
    return;
  }

  clearPendingItemFromStep(session.pendingItem, "sleeve");
  session.pendingItem.sleeve = sleeve;
  ensurePendingItemDefaults(session.pendingItem);
  await persistSessionState(key, session);
  xml(res, 200, fitMenuResponse(baseUrl, sleeve.name, session.pendingItem));
}

async function handleFitSelection(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { key, session } = await getSession(form.CallSid, form.From);
  pendingItemFromRequest(req, session);
  ensurePendingItemDefaults(session.pendingItem);

  if (wantsPreviousMenu(form)) {
    await respondWithPreviousOrderMenu(res, baseUrl, key, session);
    return;
  }

  if (isRepeatPromptSubmission(form)) {
    xml(res, 200, fitMenuResponse(baseUrl, session.pendingItem.sleeve.name, session.pendingItem));
    return;
  }

  const selection = normalizeFitSelection(form.Digits || form.SpeechResult);
  const fit = availableFitsForItem(session.pendingItem)[selection];

  if (!session.pendingItem || !session.pendingItem.sleeve) {
    xml(res, 200, invalidSelectionResponse(baseUrl, "Invalid entry. Try again.", "/api/twilio/order/current"));
    return;
  }

  if (!fit) {
    xml(
      res,
      200,
      twiml([say("Invalid entry. Try again."), twimlBody(fitMenuResponse(baseUrl, session.pendingItem.sleeve.name, session.pendingItem))])
    );
    return;
  }

  clearPendingItemFromStep(session.pendingItem, "fit");
  session.pendingItem.fit = fit;
  ensurePendingItemDefaults(session.pendingItem);
  await persistSessionState(key, session);
  xml(res, 200, currentOrderMenuResponse(baseUrl, session));
}

async function handlePocketSelection(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { key, session } = await getSession(form.CallSid, form.From);
  pendingItemFromRequest(req, session);
  ensurePendingItemDefaults(session.pendingItem);

  if (wantsPreviousMenu(form)) {
    await respondWithPreviousOrderMenu(res, baseUrl, key, session);
    return;
  }

  if (isRepeatPromptSubmission(form)) {
    xml(res, 200, pocketMenuResponse(baseUrl, session.pendingItem));
    return;
  }

  const selection = normalizePocketSelection(form.Digits || form.SpeechResult);
  const pocket = pockets[selection];

  if (!session.pendingItem || !session.pendingItem.fit) {
    xml(res, 200, invalidSelectionResponse(baseUrl, "Invalid entry. Try again.", "/api/twilio/order/current"));
    return;
  }

  if (!pocket) {
    xml(res, 200, twiml([say("Invalid entry. Try again."), twimlBody(pocketMenuResponse(baseUrl, session.pendingItem))]));
    return;
  }

  clearPendingItemFromStep(session.pendingItem, "pocket");
  session.pendingItem.pocket = pocket;
  ensurePendingItemDefaults(session.pendingItem);

  await persistSessionState(key, session);
  if (session.pendingItem.cuff && !requiresCuffSelection(session.pendingItem)) {
    await checkPreorderThenQuantity(res, baseUrl, key, session);
    return;
  }

  xml(res, 200, currentOrderMenuResponse(baseUrl, session));
}

async function handleCuffSelection(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { key, session } = await getSession(form.CallSid, form.From);
  ensurePendingItemDefaults(session.pendingItem);

  if (wantsPreviousMenu(form)) {
    await respondWithPreviousOrderMenu(res, baseUrl, key, session);
    return;
  }

  if (isRepeatPromptSubmission(form)) {
    xml(res, 200, cuffMenuResponse(baseUrl, session.pendingItem.sleeve.name, session.pendingItem));
    return;
  }

  const selection = normalizeCuffSelection(form.Digits || form.SpeechResult);
  const cuff = cuffs[selection];

  if (!session.pendingItem || !session.pendingItem.pocket) {
    xml(res, 200, invalidSelectionResponse(baseUrl, "Invalid entry. Try again.", "/api/twilio/order/current"));
    return;
  }

  if (!cuff) {
    xml(
      res,
      200,
      twiml([say("Invalid entry. Try again."), twimlBody(cuffMenuResponse(baseUrl, session.pendingItem.sleeve.name, session.pendingItem))])
    );
    return;
  }

  clearPendingItemFromStep(session.pendingItem, "cuff");
  session.pendingItem.cuff = cuff;
  ensurePendingItemDefaults(session.pendingItem);
  await persistSessionState(key, session);
  await checkPreorderThenQuantity(res, baseUrl, key, session);
}

async function checkPreorderThenQuantity(res, baseUrl, key, session) {
  const pendingItem = ensurePendingItemDefaults(session.pendingItem);
  const requestedSku = buildSku({
    category: pendingItem.category.name,
    style: pendingItem.style.name,
    collar: pendingItem.collar.name,
    size: pendingItem.size.id,
    sleeve: pendingItem.sleeve.name,
    fit: pendingItem.fit.name,
    pocket: pendingItem.pocket.name,
    cuff: pendingItem.cuff.name
  });

  let matchedPreorderSku;
  try {
    matchedPreorderSku = await findMatchingPreorderSku(requestedSku);
  } catch (_error) {
    xml(
      res,
      200,
      twiml([
        say("We could not verify pre order availability right now. Please try again in a few minutes."),
        redirect(baseUrl, withPendingState("/api/twilio/order/current", pendingItem))
      ])
    );
    return;
  }

  if (!matchedPreorderSku) {
    delete session.pendingItem;
    await persistSessionState(key, session);
    xml(
      res,
      200,
      twiml([
        say("Sorry, that shirt is not available for pre order."),
        redirect(baseUrl, "/api/twilio/order/current")
      ])
    );
    return;
  }

  xml(res, 200, quantityMenuResponse(baseUrl, describePendingItem(pendingItem), pendingItem));
}

async function handleQuantitySelection(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { key, session } = await getSession(form.CallSid, form.From);
  const stateParam = new URL(req.url, "http://localhost").searchParams.get("state");

  if (wantsPreviousMenu(form)) {
    await respondWithPreviousOrderMenu(res, baseUrl, key, session);
    return;
  }

  const pendingItem = ensurePendingItemDefaults(session.pendingItem || decodePendingItem(stateParam));
  session.pendingItem = pendingItem;

  if (isRepeatPromptSubmission(form)) {
    xml(res, 200, quantityMenuResponse(baseUrl, describePendingItem(pendingItem), pendingItem));
    return;
  }

  if (
    !pendingItem ||
    !pendingItem.category ||
    !pendingItem.style ||
    !pendingItem.collar ||
    !pendingItem.size ||
    !pendingItem.sleeve ||
    !pendingItem.fit ||
    !pendingItem.pocket ||
    !pendingItem.cuff
  ) {
    xml(res, 200, invalidSelectionResponse(baseUrl, "Invalid entry. Try again.", "/api/twilio/order/current"));
    return;
  }

  const rawQuantity = String(form.Digits || form.SpeechResult || "").replace(/[^\d]/g, "");
  const quantity = Number(rawQuantity);

  if (!quantity || quantity < 1 || quantity > 99) {
    xml(
      res,
      200,
      twiml([
        say("Please enter a quantity between 1 and 99."),
        redirect(baseUrl, withPendingState("/api/twilio/order/quantity", pendingItem))
      ])
    );
    return;
  }

  const requestedSku = buildSku({
    category: pendingItem.category.name,
    style: pendingItem.style.name,
    collar: pendingItem.collar.name,
    size: pendingItem.size.id,
    sleeve: pendingItem.sleeve.name,
    fit: pendingItem.fit.name,
    pocket: pendingItem.pocket.name,
    cuff: pendingItem.cuff.name
  });

  let matchedPreorderSku;
  try {
    matchedPreorderSku = await findMatchingPreorderSku(requestedSku);
  } catch (_error) {
    xml(
      res,
      200,
      twiml([
        say("We could not verify pre order availability right now. Please try again in a few minutes."),
        redirect(baseUrl, withPendingState("/api/twilio/order/current", pendingItem))
      ])
    );
    return;
  }

  if (!matchedPreorderSku) {
    xml(res, 200, preorderUnavailableResponse(baseUrl, pendingItem));
    return;
  }

  session.cart.push({
    category: pendingItem.category.name,
    style: pendingItem.style.name,
    collar: pendingItem.collar.name,
    fabric: "twill",
    size: pendingItem.size.id,
    sleeve: pendingItem.sleeve.name,
    fit: pendingItem.fit.name,
    pocket: pendingItem.pocket.name,
    cuff: pendingItem.cuff.name,
    quantity,
    sku: matchedPreorderSku.sku,
    variantId: matchedPreorderSku.variantId,
    shopifyUnitPrice: matchedPreorderSku.unitPrice
  });
  const addedItem = session.cart[session.cart.length - 1];
  addedItem.unitPrice = calculateUnitPrice(addedItem);
  addedItem.lineTotal = calculateLineTotal(addedItem);
  delete session.pendingItem;
  await persistSessionState(key, session);

  xml(res, 200, postAddMenuResponse(baseUrl, session, addedItem));
}

async function handlePostAddMenu(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { key, session } = await getSession(form.CallSid, form.From);

  if (wantsPreviousMenu(form)) {
    if (session.cart.length === 0) {
      xml(res, 200, categoryMenuResponse(baseUrl));
      return;
    }

    const lastItem = session.cart.pop();
    session.pendingItem = {
      category: { id: lastItem.category, name: lastItem.category },
      style: { id: lastItem.style, name: lastItem.style },
      collar: { id: lastItem.collar, name: lastItem.collar, skuCode: skuCollarCode(lastItem.collar) },
      size: { id: lastItem.size, name: lastItem.size },
      sleeve: { id: lastItem.sleeve === "short sleeve" ? "short-sleeve" : lastItem.sleeve, name: lastItem.sleeve },
      fit: { id: lastItem.fit, name: lastItem.fit },
      pocket: {
        id: lastItem.pocket === "with pocket" ? "yes" : "no",
        name: lastItem.pocket,
        value: lastItem.pocket === "with pocket"
      },
      cuff: { id: lastItem.cuff, name: lastItem.cuff }
    };
    await persistSessionState(key, session);
    xml(res, 200, quantityMenuResponse(baseUrl, describePendingItem(session.pendingItem), session.pendingItem));
    return;
  }

  if (isRepeatPromptSubmission(form)) {
    xml(res, 200, postAddMenuResponse(baseUrl, session));
    return;
  }

  const selection = normalizePostAddSelection(form.Digits || form.SpeechResult);

  if (selection === "1") {
    xml(res, 200, categoryMenuResponse(baseUrl));
    return;
  }

  if (selection === "2") {
    xml(res, 200, cartPlaybackResponse(baseUrl, session, "postadd", 0, true));
    return;
  }

  if (selection === "3") {
    xml(res, 200, discountCodeMenuResponse(baseUrl, "summary"));
    return;
  }

  xml(res, 200, invalidSelectionResponse(baseUrl, "Invalid entry. Try again.", "/api/twilio/order/next"));
}

async function handleFinalizeOrder(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { key, session } = await getSession(form.CallSid, form.From);
  const runtimeConfig = await getRuntimeConfig();
  const shouldSubmitShopifyOrder = runtimeConfig.submitShopifyOrder;
  const hydratedItems = [];
  const unresolvedItems = [];

  for (const item of session.cart.map(normalizeStoredItem)) {
    if (String(item.variantId || "").trim()) {
      hydratedItems.push(item);
      continue;
    }

    let matchedPreorderSku;
    try {
      matchedPreorderSku = await findMatchingPreorderSku(item.sku);
    } catch (_error) {
      xml(
        res,
        200,
        twiml([
          say("We could not verify pre order availability right now. Please try again in a few minutes."),
          redirect(baseUrl, "/api/twilio/order/summary")
        ])
      );
      return;
    }

    if (!matchedPreorderSku?.variantId) {
      unresolvedItems.push(item);
      continue;
    }

    hydratedItems.push({
      ...item,
      sku: matchedPreorderSku.sku,
      variantId: matchedPreorderSku.variantId,
      shopifyUnitPrice: matchedPreorderSku.unitPrice
    });
  }

  if (unresolvedItems.length) {
    session.cart = session.cart.filter((item) => {
      const sku = String(item.sku || "").trim().toUpperCase();
      return !unresolvedItems.some((stale) => String(stale.sku || "").trim().toUpperCase() === sku);
    });
    await persistSessionState(key, session);
    xml(
      res,
      200,
      twiml([
        say(
          `We removed ${unresolvedItems.length} shirt${unresolvedItems.length === 1 ? "" : "s"} from your cart that ${unresolvedItems.length === 1 ? "is" : "are"} no longer available for pre order. Please review your cart and try again.`
        ),
        redirect(baseUrl, "/api/twilio/order/summary")
      ])
    );
    return;
  }

  if (!hydratedItems.length) {
    xml(
      res,
      200,
      twiml([
        say("Your cart is empty. There is nothing to order."),
        redirect(baseUrl, "/api/twilio/voice")
      ])
    );
    return;
  }

  const subtotalPrice = hydratedItems.reduce((sum, item) => sum + calculateLineTotal(item), 0);
  const preparedCheckout = buildPreparedCheckout(hydratedItems, session, {
    totalPrice: calculateOrderTotal(hydratedItems),
    subtotalPrice,
    shippingPrice: hydratedItems.length ? SHIPPING_FEE : 0,
    discountAmount: 0,
    currencyCode: "USD"
  });
  const paymentCollection = buildPaymentCollectionConfig(preparedCheckout, runtimeConfig);

  session.pendingCheckout = {
    ...preparedCheckout,
    shouldSubmitShopifyOrder,
    paymentMode: paymentCollection.mode,
    paymentChargeAmount: paymentCollection.chargeAmount
  };
  await persistSessionState(key, session);

  if (!paymentCollection.shouldCollectCard) {
    const result = await submitPreparedOrder({
      key,
      form,
      session,
      preparedCheckout: session.pendingCheckout,
      shouldSubmitShopifyOrder,
      payment: buildSkippedPaymentSummary(session.pendingCheckout, paymentCollection.mode === "zero-total" ? "zero-total" : "admin-toggle")
    });
    await resetSessionState(form.CallSid || key, form.From);
    xml(res, 200, twiml([say(result.message), hangup()]));
    return;
  }

  xml(res, 200, paymentPromptResponse(baseUrl, session.pendingCheckout));
}

async function handlePaymentStatus(req, res) {
  const form = await parseFormBody(req);
  logTwilioDebug("payment-status", {
    CallSid: form.CallSid,
    PaymentConfirmationCode: form.PaymentConfirmationCode,
    PaymentError: form.PaymentError,
    PaymentErrorCode: form.PaymentErrorCode,
    Result: form.Result
  });
  res.writeHead(204);
  res.end();
}

async function handlePaymentComplete(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { key, session } = await getSession(form.CallSid, form.From);
  const preparedCheckout = session.pendingCheckout;

  if (!preparedCheckout || !Array.isArray(preparedCheckout.items) || !preparedCheckout.items.length) {
    xml(
      res,
      200,
      twiml([
        say("We could not find a pending payment for this call. Please review your cart and try again."),
        redirect(baseUrl, "/api/twilio/order/summary")
      ])
    );
    return;
  }

  if (String(form.Result || "").trim().toLowerCase() !== "success") {
    await persistSessionState(key, session);
    xml(
      res,
      200,
      twiml([
        say("Your card was not approved. Please enter it again."),
        twimlBody(paymentPromptResponse(baseUrl, preparedCheckout))
      ])
    );
    return;
  }

  const result = await submitPreparedOrder({
    key,
    form,
    session,
    preparedCheckout,
    shouldSubmitShopifyOrder: Boolean(preparedCheckout.shouldSubmitShopifyOrder),
    payment: buildPaymentSummary(form, preparedCheckout)
  });

  await resetSessionState(form.CallSid || key, form.From);
  xml(res, 200, twiml([say(result.message), hangup()]));
}

async function routeRequest(req, res, pathname, baseUrl) {
  if (pathname.startsWith("/api/twilio")) {
    logTwilioDebug("route", summarizeTwilioRequest(req, pathname));
  }

  if (req.method === "GET" && pathname === "/login") {
    return handleLoginPage(req, res);
  }

  if (req.method === "POST" && pathname === "/login") {
    return handleLoginSubmit(req, res);
  }

  if ((req.method === "GET" || req.method === "POST") && pathname === "/logout") {
    return handleLogout(req, res);
  }

  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    htmlNoCache(res, 200, fs.readFileSync(dashboardFile, "utf8"));
    return;
  }

  if (req.method === "GET" && (pathname === "/testivr" || pathname === "/testivr/index.html")) {
    htmlNoCache(res, 200, fs.readFileSync(testIvrFile, "utf8"));
    return;
  }

  if (req.method === "GET" && pathname === "/logo-aistone.png") {
    file(res, 200, "image/png", fs.readFileSync(logoFile));
    return;
  }

  if (req.method === "GET" && (pathname === "/health" || pathname === "/api/health")) {
    json(res, 200, { status: "ok" });
    return;
  }

  if (req.method === "GET" && (pathname === "/orders" || pathname === "/api/orders")) {
    try {
      const orders = (await loadOrders()).map((order) => ({
        ...order,
        items: Array.isArray(order.items) ? order.items.map(normalizeStoredItem) : []
      }));
      json(res, 200, orders);
    } catch (_error) {
      json(res, 200, []);
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/twilio/voice") {
    return handleVoiceWebhook(req, res, baseUrl);
  }

  if (req.method === "POST" && pathname === "/api/twilio/menu") {
    return handleMainMenu(req, res, baseUrl);
  }

  if (req.method === "POST" && pathname === "/api/twilio/order/start") {
    return restartOrderFlow(req, res, baseUrl);
  }

  if (req.method === "POST" && pathname === "/api/twilio/order/current") {
    return handleCurrentOrderMenu(req, res, baseUrl);
  }

  if (req.method === "POST" && pathname === "/api/twilio/order/summary") {
    return handlePostAddSummary(req, res, baseUrl);
  }

  if (req.method === "POST" && pathname === "/api/twilio/test/reset") {
    return handleTestReset(req, res);
  }

  if (req.method === "GET" && (pathname === "/api/admin/settings" || pathname === "/api/testivr/settings")) {
    return handleTestSettingsGet(req, res);
  }

  if (req.method === "POST" && (pathname === "/api/admin/settings" || pathname === "/api/testivr/settings")) {
    return handleTestSettingsUpdate(req, res);
  }

  if (req.method === "POST" && pathname === "/api/twilio/order/back") {
    return handlePreviousOrderMenu(req, res, baseUrl);
  }

  if (req.method === "POST" && pathname === "/api/twilio/order/category") {
    return handleCategorySelection(req, res, baseUrl);
  }

  if (req.method === "POST" && pathname === "/api/twilio/order/style") {
    return handleStyleSelection(req, res, baseUrl);
  }

  if (req.method === "POST" && pathname === "/api/twilio/order/collar") {
    return handleCollarSelection(req, res, baseUrl);
  }

  if (req.method === "POST" && pathname === "/api/twilio/order/size") {
    return handleSizeSelection(req, res, baseUrl);
  }

  if (req.method === "POST" && pathname === "/api/twilio/order/sleeve") {
    return handleSleeveSelection(req, res, baseUrl);
  }

  if (req.method === "POST" && pathname === "/api/twilio/order/fit") {
    return handleFitSelection(req, res, baseUrl);
  }

  if (req.method === "POST" && pathname === "/api/twilio/order/pocket") {
    return handlePocketSelection(req, res, baseUrl);
  }

  if (req.method === "POST" && pathname === "/api/twilio/order/cuff") {
    return handleCuffSelection(req, res, baseUrl);
  }

  if (req.method === "POST" && pathname === "/api/twilio/order/quantity") {
    return handleQuantitySelection(req, res, baseUrl);
  }

  if (req.method === "POST" && pathname === "/api/twilio/order/next") {
    return handlePostAddMenu(req, res, baseUrl);
  }

  if (req.method === "POST" && pathname === "/api/twilio/order/discount-code") {
    return handleDiscountCodeEntry(req, res, baseUrl);
  }

  if (req.method === "POST" && pathname === "/api/twilio/order/discount-code/review") {
    return handleDiscountCodeReview(req, res, baseUrl);
  }

  if (req.method === "POST" && pathname === "/api/twilio/order/finalize") {
    return handleFinalizeOrder(req, res, baseUrl);
  }

  if (req.method === "POST" && pathname === "/api/twilio/order/payment/status") {
    return handlePaymentStatus(req, res);
  }

  if (req.method === "POST" && pathname === "/api/twilio/order/payment/complete") {
    return handlePaymentComplete(req, res, baseUrl);
  }

  if (req.method === "POST" && pathname === "/api/twilio/cart/play") {
    return handleCartPlayback(req, res, baseUrl);
  }

  if (req.method === "POST" && pathname === "/api/twilio/cart/control") {
    return handleCartControl(req, res, baseUrl);
  }

  if (req.method === "POST" && pathname === "/api/twilio/cart/quantity") {
    return handleCartQuantity(req, res, baseUrl);
  }

  notFound(res);
}

async function handleHttpRequest(req, res, options = {}) {
  try {
    const pathname = resolvePathname(req);
    attachTwilioResponseLogging(res, pathname);
    if (!(await authorizeRequest(req, res, pathname))) {
      return;
    }
    const baseUrl = buildBaseUrl(req, options.baseUrl || process.env.BASE_URL);
    await routeRequest(req, res, pathname, baseUrl);
  } catch (error) {
    const pathname = (() => {
      try {
        return resolvePathname(req);
      } catch (_innerError) {
        return "unresolved";
      }
    })();

    logTwilioDebug("error", {
      request: summarizeTwilioRequest(req, pathname),
      error: {
        message: error.message,
        stack: error.stack
      }
    });
    json(res, 500, {
      error: "Internal server error",
      details: error.message
    });
  }
}

module.exports = {
  handleHttpRequest
};
