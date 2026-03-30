const fs = require("fs");
const path = require("path");
const { deleteSession, loadOrders, loadSession, saveOrder, saveSession } = require("./order-store");

const dashboardFile = path.join(__dirname, "..", "index.html");
const testIvrFile = path.join(__dirname, "..", "testivr", "index.html");
const logoFile = path.join(__dirname, "..", "logo-aistone.png");
const pricingFile = path.join(__dirname, "..", "pricing.json");
const DEFAULT_VOICE = process.env.TTS_VOICE || "Google.en-US-Standard-C";
const DEFAULT_LANGUAGE = process.env.TTS_LANGUAGE || "en-US";

const categories = {
  1: { id: "mens", name: "mens" },
  2: { id: "boys", name: "boys" }
};

const styles = {
  1: { id: "standard", name: "standard" },
  2: { id: "chassidish", name: "khosseedish" }
};

const collars = {
  1: { id: "spread", name: "spread", skuCode: "S" },
  2: { id: "cutaway", name: "cutaway", skuCode: "C" },
  3: { id: "extra-cutaway", name: "extra cutaway", skuCode: "V" },
  4: { id: "button", name: "button", skuCode: "B" }
};

const sizes = {
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

const sleeves = {
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

const fits = {
  1: { id: "classic", name: "classic" },
  2: { id: "slim", name: "slim" },
  3: { id: "extra-slim", name: "extra slim" },
  4: { id: "super-slim", name: "super slim" }
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

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function buildBaseUrl(req, envBaseUrl) {
  const isVercelRuntime = String(process.env.VERCEL || "").toLowerCase() === "1";
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000")
    .split(",")[0]
    .trim();

  if (isVercelRuntime && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }

  const configured = String(envBaseUrl || "").trim().replace(/\/$/, "");
  if (configured) {
    return configured;
  }

  return `${forwardedProto}://${forwardedHost}`;
}

function isVercelRuntime() {
  return String(process.env.VERCEL || "").toLowerCase() === "1";
}

function buildTwilioRouteUrl(baseUrl, routePath) {
  if (!isVercelRuntime()) {
    return `${baseUrl}${routePath}`;
  }

  const routeUrl = new URL(routePath, "http://localhost");
  const route = routeUrl.pathname.replace(/^\/api\/twilio\/?/, "");
  const params = new URLSearchParams(routeUrl.search);
  params.set("...route", route || "voice");
  return `${baseUrl}/api/twilio/${route || "voice"}?${params.toString()}`;
}

function twiml(parts) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${parts.join("")}</Response>`;
}

function say(text, voice = DEFAULT_VOICE, language = DEFAULT_LANGUAGE) {
  return `<Say voice="${voice}" language="${language}">${escapeXml(text)}</Say>`;
}

function gather(baseUrl, { action, prompt, numDigits, hints, finishOnKey = "#", timeout, input = "dtmf speech" }) {
  const digitAttr = numDigits ? ` numDigits="${numDigits}"` : "";
  const hintsAttr = hints ? ` hints="${escapeXml(hints)}"` : "";
  const finishAttr = finishOnKey ? ` finishOnKey="${escapeXml(finishOnKey)}"` : "";
  const timeoutAttr = timeout ? ` timeout="${timeout}"` : "";
  const actionUrl = buildTwilioRouteUrl(baseUrl, action);

  return [
    `<Gather input="${escapeXml(input)}" method="POST" action="${escapeXml(actionUrl)}"${digitAttr}${finishAttr}${hintsAttr}${timeoutAttr}>`,
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

  if (current.pathname !== "/api/twilio/[...route]") {
    return current.pathname;
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

async function getSession(callSid, from) {
  const key = sessionKeyForCaller(callSid, from);

  if (callSid && String(from || "").trim()) {
    callSidSessionKeys.set(callSid, key);
  }

  if (!sessions.has(key)) {
    const stored =
      (await loadSession(key)) || {
        createdAt: new Date().toISOString(),
        cart: []
      };
    sessions.set(key, stored);
  }

  return { key, session: sessions.get(key) };
}

function loadPricing() {
  try {
    return JSON.parse(fs.readFileSync(pricingFile, "utf8"));
  } catch (_error) {
    return {
      categoryBase: {},
      collarAdjustment: {},
      fitAdjustment: {},
      pocketAdjustment: {},
      cuffAdjustment: {},
      sleeveAdjustment: {},
      dpAdjustment: 0
    };
  }
}

function priceNumber(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function calculateUnitPrice(item) {
  const pricing = loadPricing();

  return (
    priceNumber(pricing.categoryBase?.[item.category]) +
    priceNumber(pricing.collarAdjustment?.[item.collar]) +
    priceNumber(pricing.fitAdjustment?.[item.fit]) +
    priceNumber(pricing.pocketAdjustment?.[item.pocket]) +
    priceNumber(pricing.cuffAdjustment?.[item.cuff]) +
    priceNumber(pricing.sleeveAdjustment?.[item.sleeve]) +
    priceNumber(pricing.dpAdjustment)
  );
}

function calculateLineTotal(item) {
  return calculateUnitPrice(item) * Number(item.quantity || 0);
}

function calculateOrderTotal(items) {
  return items.reduce((sum, item) => sum + calculateLineTotal(item), 0);
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
  if (!item || !item.style) {
    return item;
  }

  if (item.style.id === "chassidish" || item.style.name === "chassidish") {
    item.collar = { ...CHASSIDISH_COLLAR };
  }

  return item;
}

async function clearSession(callSid, from) {
  const key = sessionKeyForCaller(callSid, from);
  sessions.delete(key);
  await deleteSession(key);

  if (callSid) {
    callSidSessionKeys.delete(callSid);
  }
}

async function persistSessionState(key, session) {
  sessions.set(key, session);
  await saveSession(key, session);
}

function skuCategoryCode(category) {
  return category === "mens" ? "M" : "B";
}

function skuCollarCode(collar) {
  const mapping = {
    spread: "S",
    cutaway: "C",
    "extra cutaway": "V",
    button: "B",
    pointy: "P"
  };
  return mapping[collar] || "S";
}

function skuFitCode(fit) {
  const mapping = {
    classic: "C",
    slim: "S",
    "extra slim": "E",
    "super slim": "X"
  };
  return mapping[fit] || "C";
}

function skuSizeSegment(size, sleeve) {
  const isHalf = String(size).includes(".5");
  const whole = String(size).replace(".5", "");

  if (sleeve === "short sleeve") {
    return `${whole}${isHalf ? "H" : ""}`;
  }

  return `${whole}${isHalf ? "H" : ""}${sleeve}`;
}

function buildSku(item) {
  const prefix = `${skuCategoryCode(item.category)}T${skuCollarCode(item.collar)}${skuFitCode(item.fit)}`;
  const segments = ["DP"];

  if (item.style === "chassidish") {
    segments.push("ROL");
  }
  if (item.cuff === "french cuff") {
    segments.push("FC");
  }
  if (item.pocket === "with pocket") {
    segments.push("PKT");
  }
  if (item.sleeve === "short sleeve") {
    segments.push("SS");
  }

  segments.push(skuSizeSegment(item.size, item.sleeve));
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
  return `Item ${index + 1}. Quantity ${item.quantity}, ${item.category} ${item.style} shirt, size ${item.size}, sleeve ${item.sleeve}, ${item.fit}, ${item.pocket}, ${item.cuff}, fabric twill, line total ${calculateLineTotal(item)} dollars.`;
}

function formatCartForSpeech(cart) {
  if (cart.length === 0) {
    return "Your cart is empty.";
  }

  return cart.map(formatCartLine).join(" ");
}

function formatCartPlaybackLine(item, index, totalItems) {
  return [
    `Item ${index + 1} of ${totalItems}.`,
    `Quantity ${item.quantity}.`,
    `${item.category} ${item.style} shirt.`,
    `Collar ${item.collar}.`,
    `Size ${item.size}.`,
    `Sleeve ${item.sleeve}.`,
    `Fit ${item.fit}.`,
    `${item.pocket}.`,
    `${item.cuff}.`,
    `Fabric twill.`,
    `Line total ${calculateLineTotal(item)} dollars.`
  ].join(" ");
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

function file(res, statusCode, contentType, payload) {
  res.writeHead(statusCode, { "Content-Type": contentType });
  res.end(payload);
}

function notFound(res) {
  json(res, 404, { error: "Not found" });
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
    cutaway: "2",
    "3": "3",
    three: "3",
    "extra cutaway": "3",
    "4": "4",
    four: "4",
    button: "4"
  });
}

function normalizeFitSelection(input) {
  return normalizeSimpleSelection(input, {
    "1": "1",
    one: "1",
    classic: "1",
    "2": "2",
    two: "2",
    slim: "2",
    "3": "3",
    three: "3",
    "extra slim": "3",
    "4": "4",
    four: "4",
    "super slim": "4"
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
    replay: "1",
    repeat: "1",
    previous: "1",
    back: "1",
    "3": "3",
    three: "3",
    skip: "3",
    next: "3"
  });
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
        "Welcome to Rebbi shirt ordering. Press 1 to order shirts. Press 2 to hear what is in your cart. Press 3 for store hours. Press 4 to speak with a representative."
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
      hints: "standard, khosseedish",
      prompt: `You selected ${categoryName}. Press 1 for standard shirts. Press 2 for khosseedish shirts. Press star to go back.`
    }),
    say("We did not receive a style selection."),
    redirect(baseUrl, withPendingState("/api/twilio/order/current", pendingItem))
  ]);
}

function sizeMenuResponse(baseUrl, pendingItem) {
  return twiml([
    gather(baseUrl, {
      action: withPendingState("/api/twilio/order/size", pendingItem),
      finishOnKey: "#",
      timeout: 3,
      input: "dtmf",
      hints: "14, 14.5, 15, 15.5, 16, 16.5, 17, 17.5, 18, 18.5, 19, 19.5, 20",
      prompt:
        "Enter neck size between 14 and 20. For a half size, enter the size without the decimal, like 145 for 14 and a half. Then press pound, or press star to go back."
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
      hints: "spread, cutaway, extra cutaway, button",
      prompt: "Press 1 for spread. Press 2 for cutaway. Press 3 for extra cutaway. Press 4 for button. Press star to go back."
    }),
    say("We did not receive a collar selection."),
    redirect(baseUrl, withPendingState("/api/twilio/order/current", pendingItem))
  ]);
}

function sleeveMenuResponse(baseUrl, sizeName, pendingItem) {
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

function fitMenuResponse(baseUrl, sleeveName, pendingItem) {
  return twiml([
    gather(baseUrl, {
      action: withPendingState("/api/twilio/order/fit", pendingItem),
      input: "dtmf",
      numDigits: 1,
      hints: "classic, slim, extra slim, super slim",
      prompt: `You selected sleeve ${sleeveName}. Press 1 for classic. Press 2 for slim. Press 3 for extra slim. Press 4 for super slim. Press star to go back.`
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
  if (sleeveName === "short sleeve") {
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
  const encodedState = encodePendingItem(pendingItem);
  return twiml([
    gather(baseUrl, {
      action: `/api/twilio/order/quantity?state=${encodedState}`,
      input: "dtmf",
      finishOnKey: "#",
      timeout: 3,
      prompt: `You selected ${itemDescription}. Enter the quantity, then press pound, or press star to go back.`
    }),
    say("We did not receive a quantity."),
    redirect(baseUrl, "/api/twilio/order/current")
  ]);
}

function postAddMenuResponse(baseUrl, session, addedItem) {
  const totalUnits = cartQuantity(session.cart);
  const totalPrice = calculateOrderTotal(session.cart);
  const addedDescription = addedItem
    ? `You added quantity ${addedItem.quantity}, ${addedItem.category} ${addedItem.style} shirt, size ${addedItem.size}, sleeve ${addedItem.sleeve}, ${addedItem.fit}, ${addedItem.pocket}, ${addedItem.cuff}.`
    : "That item has been added to your cart.";
  return twiml([
    say(addedDescription),
    gather(baseUrl, {
      action: "/api/twilio/order/next",
      input: "dtmf",
      numDigits: 1,
      hints: "add another, hear cart, confirm",
      prompt: `Your current total is ${totalPrice} dollars. You currently have ${totalUnits} shirts in your cart. Press 1 to add another shirt. Press 2 to play your cart again. Press 3 to place this order.`
    }),
    say("We did not receive a valid selection."),
    redirect(baseUrl, "/api/twilio/order/summary")
  ]);
}

function cartReturnPath(context) {
  return context === "postadd" ? "/api/twilio/order/summary" : "/api/twilio/voice";
}

function buildCartPlaybackRoute(context, index, phase, announce = false) {
  const params = new URLSearchParams({
    context,
    index: String(index),
    phase
  });

  if (announce) {
    params.set("announce", "1");
  }

  return `/api/twilio/cart/play?${params.toString()}`;
}

function cartPlaybackResponse(baseUrl, session, context, index, phase, announce) {
  if (!session.cart.length) {
    return twiml([say("Your cart is empty."), redirect(baseUrl, cartReturnPath(context))]);
  }

  const safeIndex = Math.max(0, Math.min(index, session.cart.length - 1));
  const item = session.cart[safeIndex];
  const parts = [];

  if (announce) {
    parts.push(say("While listening to the cart, press 1 to replay the item. Press 3 to skip to the next item."));
    parts.push(pause(1));
  }

  if (phase === "intro") {
    parts.push(
      gather(baseUrl, {
        action: `/api/twilio/cart/control?context=${encodeURIComponent(context)}&index=${safeIndex}&phase=intro`,
        input: "dtmf",
        numDigits: 1,
        timeout: 1,
        hints: "replay, previous, skip, next",
        prompt: `Item ${safeIndex + 1}.`
      })
    );
    parts.push(redirect(baseUrl, buildCartPlaybackRoute(context, safeIndex, "detail")));
    return twiml(parts);
  }

  parts.push(
    gather(baseUrl, {
      action: `/api/twilio/cart/control?context=${encodeURIComponent(context)}&index=${safeIndex}&phase=detail`,
      input: "dtmf",
      numDigits: 1,
      timeout: 1,
      hints: "replay, previous, skip, next",
      prompt: formatCartPlaybackLine(item, safeIndex, session.cart.length)
    })
  );

  if (safeIndex < session.cart.length - 1) {
    parts.push(pause(1));
    parts.push(redirect(baseUrl, buildCartPlaybackRoute(context, safeIndex + 1, "intro")));
  } else {
    parts.push(say("End of cart."));
    parts.push(redirect(baseUrl, cartReturnPath(context)));
  }

  return twiml(parts);
}

function cartControlResponse(baseUrl, session, context, index, phase, selection) {
  if (!session.cart.length) {
    return twiml([say("Your cart is empty."), redirect(baseUrl, cartReturnPath(context))]);
  }

  const safeIndex = Math.max(0, Math.min(index, session.cart.length - 1));

  if (selection === "1") {
    const targetIndex = phase === "intro" ? Math.max(safeIndex - 1, 0) : safeIndex;
    return twiml([redirect(baseUrl, buildCartPlaybackRoute(context, targetIndex, "intro"))]);
  }

  if (selection === "3") {
    if (safeIndex >= session.cart.length - 1) {
      return twiml([say("End of cart."), redirect(baseUrl, cartReturnPath(context))]);
    }

    return twiml([redirect(baseUrl, buildCartPlaybackRoute(context, safeIndex + 1, "intro"))]);
  }

  return twiml([redirect(baseUrl, buildCartPlaybackRoute(context, safeIndex, phase))]);
}

function invalidSelectionResponse(baseUrl, message, fallbackPath) {
  return twiml([say(message), redirect(baseUrl, fallbackPath)]);
}

function normalizeSizeInput(input) {
  const text = String(input || "").trim().toLowerCase();
  const compact = text.replace(/[^\d.]/g, "");
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

function describePendingItem(item) {
  return `a ${item.category.name} ${item.style.name} ${item.collar.name} twill shirt, size ${item.size.name}, sleeve ${item.sleeve.name}, ${item.fit.name}, ${item.pocket.name}, ${item.cuff.name}`;
}

function currentOrderMenuResponse(baseUrl, session) {
  const item = ensurePendingItemDefaults(session.pendingItem || {});

  if (!item.category) {
    return categoryMenuResponse(baseUrl);
  }

  if (!item.style) {
    return styleMenuResponse(baseUrl, item);
  }

  if (!item.collar) {
    return collarMenuResponse(baseUrl, item);
  }

  if (!item.size) {
    return sizeMenuResponse(baseUrl, item);
  }

  if (!item.sleeve) {
    return sleeveMenuResponse(baseUrl, item.size.name, item);
  }

  if (!item.fit) {
    return fitMenuResponse(baseUrl, item.sleeve.name, item);
  }

  if (!item.pocket) {
    return pocketMenuResponse(baseUrl, item);
  }

  if (!item.cuff && item.sleeve.id !== "short-sleeve") {
    return cuffMenuResponse(baseUrl, item.sleeve.name, item);
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

  if (item.cuff) {
    delete item.cuff;
    if (item.sleeve && item.sleeve.id === "short-sleeve") {
      return pocketMenuResponse(baseUrl, item);
    }
    return cuffMenuResponse(baseUrl, item.sleeve.name, item);
  }

  if (item.pocket) {
    delete item.pocket;
    return pocketMenuResponse(baseUrl, item);
  }

  if (item.fit) {
    delete item.fit;
    return fitMenuResponse(baseUrl, item.sleeve.name, item);
  }

  if (item.sleeve) {
    delete item.sleeve;
    return sleeveMenuResponse(baseUrl, item.size.name, item);
  }

  if (item.collar) {
    delete item.collar;
    if (item.style && item.style.id === "chassidish") {
      return styleMenuResponse(baseUrl, item);
    }
    return collarMenuResponse(baseUrl, item);
  }

  if (item.size) {
    delete item.size;
    return sizeMenuResponse(baseUrl, item);
  }

  if (item.style) {
    delete item.style;
    return styleMenuResponse(baseUrl, item);
  }

  if (item.category) {
    delete session.pendingItem;
    return categoryMenuResponse(baseUrl);
  }

  return categoryMenuResponse(baseUrl);
}

async function handleVoiceWebhook(req, res, baseUrl) {
  const form = await parseFormBody(req);
  await getSession(form.CallSid, form.From);
  xml(res, 200, mainMenuResponse(baseUrl));
}

async function handleMainMenu(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { session } = await getSession(form.CallSid, form.From);
  const selection = normalizeMainSelection(form.Digits || form.SpeechResult);

  if (selection === "1") {
    xml(res, 200, categoryMenuResponse(baseUrl));
    return;
  }

  if (selection === "2") {
    xml(res, 200, cartPlaybackResponse(baseUrl, session, "voice", 0, "intro", true));
    return;
  }

  if (selection === "3") {
    xml(
      res,
      200,
      twiml([
        say("Our ordering desk is open Sunday through Thursday from 9 A M to 6 P M, and Friday from 9 A M to 1 P M."),
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
  xml(res, 200, categoryMenuResponse(baseUrl));
}

async function handlePostAddSummary(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { key, session } = await getSession(form.CallSid, form.From);
  await persistSessionState(key, session);
  xml(res, 200, postAddMenuResponse(baseUrl, session));
}

async function handleTestReset(req, res) {
  const form = await parseFormBody(req);
  await clearSession(form.CallSid, form.From);
  json(res, 200, { ok: true });
}

async function handleCartPlayback(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { session } = await getSession(form.CallSid, form.From);
  const current = new URL(req.url, "http://localhost");
  const context = current.searchParams.get("context") === "postadd" ? "postadd" : "voice";
  const index = Number(current.searchParams.get("index") || 0);
  const phase = current.searchParams.get("phase") === "detail" ? "detail" : "intro";
  const announce = current.searchParams.get("announce") === "1";

  xml(res, 200, cartPlaybackResponse(baseUrl, session, context, index, phase, announce));
}

async function handleCartControl(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { session } = await getSession(form.CallSid, form.From);
  const current = new URL(req.url, "http://localhost");
  const context = current.searchParams.get("context") === "postadd" ? "postadd" : "voice";
  const index = Number(current.searchParams.get("index") || 0);
  const phase = current.searchParams.get("phase") === "detail" ? "detail" : "intro";
  const selection = normalizeCartPlaybackSelection(form.Digits || form.SpeechResult);

  xml(res, 200, cartControlResponse(baseUrl, session, context, index, phase, selection));
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
  await persistSessionState(key, session);
  xml(res, 200, goToPreviousOrderMenu(baseUrl, session));
}

function wantsPreviousMenu(form) {
  return String(form.Digits || "").trim() === "*";
}

async function restartOrderFlow(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { key, session } = await getSession(form.CallSid, form.From);
  delete session.pendingItem;
  await persistSessionState(key, session);
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
    xml(res, 200, goToPreviousOrderMenu(baseUrl, session));
    return;
  }

  const selection = normalizeStyleSelection(form.Digits || form.SpeechResult);
  const style = styles[selection];

  if (!session.pendingItem || !session.pendingItem.category) {
    xml(res, 200, invalidSelectionResponse(baseUrl, "Invalid entry. Try again.", "/api/twilio/order/current"));
    return;
  }

  if (!style) {
    xml(res, 200, invalidSelectionResponse(baseUrl, "Invalid entry. Try again.", "/api/twilio/order/current"));
    return;
  }

  session.pendingItem.style = style;

  if (style.id === "chassidish") {
    session.pendingItem.collar = { ...CHASSIDISH_COLLAR };
    await persistSessionState(key, session);
    xml(res, 200, sizeMenuResponse(baseUrl, session.pendingItem));
    return;
  }

  delete session.pendingItem.collar;
  await persistSessionState(key, session);
  xml(res, 200, collarMenuResponse(baseUrl, session.pendingItem));
}

async function handleCollarSelection(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { key, session } = await getSession(form.CallSid, form.From);
  pendingItemFromRequest(req, session);
  ensurePendingItemDefaults(session.pendingItem);

  if (wantsPreviousMenu(form)) {
    xml(res, 200, goToPreviousOrderMenu(baseUrl, session));
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
    xml(res, 200, invalidSelectionResponse(baseUrl, "Invalid entry. Try again.", "/api/twilio/order/current"));
    return;
  }

  session.pendingItem.collar = collar;
  await persistSessionState(key, session);
  xml(res, 200, sizeMenuResponse(baseUrl, session.pendingItem));
}

async function handleSizeSelection(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { key, session } = await getSession(form.CallSid, form.From);
  pendingItemFromRequest(req, session);
  ensurePendingItemDefaults(session.pendingItem);

  if (wantsPreviousMenu(form)) {
    xml(res, 200, goToPreviousOrderMenu(baseUrl, session));
    return;
  }

  const sizeName = normalizeSizeInput(form.Digits || form.SpeechResult);
  const size = Object.values(sizes).find((entry) => entry.id === sizeName);

  if (!session.pendingItem || !session.pendingItem.category || !session.pendingItem.style || !session.pendingItem.collar) {
    xml(res, 200, invalidSelectionResponse(baseUrl, "Invalid entry. Try again.", "/api/twilio/order/current"));
    return;
  }

  if (!size) {
    xml(res, 200, invalidSelectionResponse(baseUrl, "Invalid entry. Try again.", "/api/twilio/order/current"));
    return;
  }

  session.pendingItem.size = size;
  await persistSessionState(key, session);
  xml(res, 200, sleeveMenuResponse(baseUrl, size.name, session.pendingItem));
}

async function handleSleeveSelection(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { key, session } = await getSession(form.CallSid, form.From);
  pendingItemFromRequest(req, session);
  ensurePendingItemDefaults(session.pendingItem);

  if (wantsPreviousMenu(form)) {
    xml(res, 200, goToPreviousOrderMenu(baseUrl, session));
    return;
  }

  const sleeveInput = String(form.Digits || form.SpeechResult || "").replace(/[^\d]/g, "");
  const sleeve = sleeves[sleeveInput];

  if (!session.pendingItem || !session.pendingItem.size) {
    xml(res, 200, invalidSelectionResponse(baseUrl, "Invalid entry. Try again.", "/api/twilio/order/current"));
    return;
  }

  if (!sleeve) {
    xml(res, 200, invalidSelectionResponse(baseUrl, "Invalid entry. Try again.", "/api/twilio/order/current"));
    return;
  }

  session.pendingItem.sleeve = sleeve;
  await persistSessionState(key, session);
  xml(res, 200, fitMenuResponse(baseUrl, sleeve.name, session.pendingItem));
}

async function handleFitSelection(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { key, session } = await getSession(form.CallSid, form.From);
  pendingItemFromRequest(req, session);
  ensurePendingItemDefaults(session.pendingItem);

  if (wantsPreviousMenu(form)) {
    xml(res, 200, goToPreviousOrderMenu(baseUrl, session));
    return;
  }

  const selection = normalizeFitSelection(form.Digits || form.SpeechResult);
  const fit = fits[selection];

  if (!session.pendingItem || !session.pendingItem.sleeve) {
    xml(res, 200, invalidSelectionResponse(baseUrl, "Invalid entry. Try again.", "/api/twilio/order/current"));
    return;
  }

  if (!fit) {
    xml(res, 200, invalidSelectionResponse(baseUrl, "Invalid entry. Try again.", "/api/twilio/order/current"));
    return;
  }

  session.pendingItem.fit = fit;
  await persistSessionState(key, session);
  xml(res, 200, pocketMenuResponse(baseUrl, session.pendingItem));
}

async function handlePocketSelection(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { key, session } = await getSession(form.CallSid, form.From);
  pendingItemFromRequest(req, session);
  ensurePendingItemDefaults(session.pendingItem);

  if (wantsPreviousMenu(form)) {
    xml(res, 200, goToPreviousOrderMenu(baseUrl, session));
    return;
  }

  const selection = normalizePocketSelection(form.Digits || form.SpeechResult);
  const pocket = pockets[selection];

  if (!session.pendingItem || !session.pendingItem.fit) {
    xml(res, 200, invalidSelectionResponse(baseUrl, "Invalid entry. Try again.", "/api/twilio/order/current"));
    return;
  }

  if (!pocket) {
    xml(res, 200, invalidSelectionResponse(baseUrl, "Invalid entry. Try again.", "/api/twilio/order/current"));
    return;
  }

  session.pendingItem.pocket = pocket;

  if (session.pendingItem.sleeve && session.pendingItem.sleeve.id === "short-sleeve") {
    session.pendingItem.cuff = { id: "short-sleeve", name: "short sleeve" };
    await persistSessionState(key, session);
    xml(res, 200, cuffMenuResponse(baseUrl, session.pendingItem.sleeve.name, session.pendingItem));
    return;
  }

  await persistSessionState(key, session);
  xml(res, 200, cuffMenuResponse(baseUrl, session.pendingItem.sleeve.name, session.pendingItem));
}

async function handleCuffSelection(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { key, session } = await getSession(form.CallSid, form.From);
  ensurePendingItemDefaults(session.pendingItem);

  if (wantsPreviousMenu(form)) {
    xml(res, 200, goToPreviousOrderMenu(baseUrl, session));
    return;
  }

  const selection = normalizeCuffSelection(form.Digits || form.SpeechResult);
  const cuff = cuffs[selection];

  if (!session.pendingItem || !session.pendingItem.pocket) {
    xml(res, 200, invalidSelectionResponse(baseUrl, "Invalid entry. Try again.", "/api/twilio/order/current"));
    return;
  }

  if (!cuff) {
    xml(res, 200, invalidSelectionResponse(baseUrl, "Invalid entry. Try again.", "/api/twilio/order/current"));
    return;
  }

  session.pendingItem.cuff = cuff;
  await persistSessionState(key, session);
  xml(res, 200, quantityMenuResponse(baseUrl, describePendingItem(session.pendingItem), session.pendingItem));
}

async function handleQuantitySelection(req, res, baseUrl) {
  const form = await parseFormBody(req);
  const { key, session } = await getSession(form.CallSid, form.From);
  const stateParam = new URL(req.url, "http://localhost").searchParams.get("state");

  if (wantsPreviousMenu(form)) {
    xml(res, 200, goToPreviousOrderMenu(baseUrl, session));
    return;
  }

  const pendingItem = ensurePendingItemDefaults(session.pendingItem || decodePendingItem(stateParam));

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
        redirect(baseUrl, "/api/twilio/order/current")
      ])
    );
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
    sku: buildSku({
      category: pendingItem.category.name,
      style: pendingItem.style.name,
      collar: pendingItem.collar.name,
      size: pendingItem.size.id,
      sleeve: pendingItem.sleeve.name,
      fit: pendingItem.fit.name,
      pocket: pendingItem.pocket.name,
      cuff: pendingItem.cuff.name
    })
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

  const selection = normalizePostAddSelection(form.Digits || form.SpeechResult);

  if (selection === "1") {
    xml(res, 200, categoryMenuResponse(baseUrl));
    return;
  }

  if (selection === "2") {
    xml(res, 200, cartPlaybackResponse(baseUrl, session, "postadd", 0, "intro", true));
    return;
  }

  if (selection === "3") {
    const orderRecord = {
      id: `${key}-${Date.now()}`,
      callSid: form.CallSid || key,
      caller: form.From || "unknown",
      createdAt: new Date().toISOString(),
      items: session.cart.map(normalizeStoredItem),
      totalQuantity: cartQuantity(session.cart),
      totalPrice: calculateOrderTotal(session.cart)
    };

    try {
      await saveOrder(orderRecord);
    } catch (_error) {
      // Order persistence should not block the caller's IVR flow.
    }

    await clearSession(form.CallSid || key, form.From);
    xml(
      res,
      200,
      twiml([
        say("Thank you. Your shirt order has been placed. A team member will follow up if needed."),
        hangup()
      ])
    );
    return;
  }

  xml(res, 200, invalidSelectionResponse(baseUrl, "Invalid entry. Try again.", "/api/twilio/order/next"));
}

async function routeRequest(req, res, pathname, baseUrl) {
  if (pathname.startsWith("/api/twilio")) {
    logTwilioDebug("route", summarizeTwilioRequest(req, pathname));
  }

  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    html(res, 200, fs.readFileSync(dashboardFile, "utf8"));
    return;
  }

  if (req.method === "GET" && (pathname === "/testivr" || pathname === "/testivr/index.html")) {
    html(res, 200, fs.readFileSync(testIvrFile, "utf8"));
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

  if (req.method === "POST" && pathname === "/api/twilio/cart/play") {
    return handleCartPlayback(req, res, baseUrl);
  }

  if (req.method === "POST" && pathname === "/api/twilio/cart/control") {
    return handleCartControl(req, res, baseUrl);
  }

  notFound(res);
}

async function handleHttpRequest(req, res, options = {}) {
  try {
    const pathname = resolvePathname(req);
    attachTwilioResponseLogging(res, pathname);
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
