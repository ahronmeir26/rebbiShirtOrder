const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "..", "data");
const cacheFile = path.join(dataDir, "shopify-preorder-cache.json");
const PREORDER_BLOB_PATH = "shopify-preorder/cache.json";
const PREORDER_TAG = "pre-order";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let shopifyTokenCache = null;
let blobSdkCache;

function ensureDataStore() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function blobSdk() {
  if (blobSdkCache !== undefined) {
    return blobSdkCache;
  }

  try {
    blobSdkCache = require("@vercel/blob");
  } catch (_error) {
    blobSdkCache = null;
  }

  return blobSdkCache;
}

function canUseBlobStore() {
  return Boolean(String(process.env.BLOB_READ_WRITE_TOKEN || "").trim() && blobSdk());
}

function shopifyConfig() {
  return {
    storeDomain: String(process.env.SHOPIFY_STORE_DOMAIN || "").trim(),
    accessToken: String(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "").trim(),
    clientId: String(process.env.SHOPIFY_CLIENT_ID || "").trim(),
    clientSecret: String(process.env.SHOPIFY_CLIENT_SECRET || "").trim(),
    apiVersion: String(process.env.SHOPIFY_API_VERSION || "2025-01").trim()
  };
}

function normalizeSkuPrefix(prefix) {
  const text = String(prefix || "").trim().toUpperCase();
  if (text.length < 2) {
    return text;
  }

  if (text[1] === "J") {
    return `${text[0]}T${text.slice(2)}`;
  }

  return text;
}

function normalizeSkuToken(token) {
  const text = String(token || "").trim().toUpperCase();

  if (text === "SP") {
    return "DP";
  }

  return text;
}

function normalizeSkuForPreorderMatch(sku) {
  const parts = String(sku || "")
    .trim()
    .toUpperCase()
    .split("-")
    .map((part) => part.trim())
    .filter(Boolean);

  if (!parts.length) {
    return "";
  }

  if (parts.length === 1) {
    return normalizeSkuPrefix(parts[0]);
  }

  const prefix = normalizeSkuPrefix(parts[0]);
  const sizeSegment = normalizeSkuToken(parts[parts.length - 1]);
  const middle = parts
    .slice(1, -1)
    .map(normalizeSkuToken)
    .sort((left, right) => left.localeCompare(right));

  return [prefix, ...middle, sizeSegment].join("-");
}

function buildLookup(cache) {
  const byExactSku = new Map();
  const byNormalizedSku = new Map();

  for (const entry of Array.isArray(cache.entries) ? cache.entries : []) {
    const sku = String(entry.sku || "").trim().toUpperCase();
    const normalizedSku = String(entry.normalizedSku || "").trim().toUpperCase();

    if (!sku || !normalizedSku) {
      continue;
    }

    if (!byExactSku.has(sku)) {
      byExactSku.set(sku, entry);
    }

    if (!byNormalizedSku.has(normalizedSku)) {
      byNormalizedSku.set(normalizedSku, entry);
    }
  }

  return {
    ...cache,
    byExactSku,
    byNormalizedSku
  };
}

function isFresh(cache) {
  const refreshedAtMs = Date.parse(String(cache?.refreshedAt || ""));
  return Number.isFinite(refreshedAtMs) && Date.now() - refreshedAtMs < CACHE_TTL_MS;
}

function hasRequiredEntryFields(cache) {
  const entries = Array.isArray(cache?.entries) ? cache.entries : [];
  if (!entries.length) {
    return false;
  }

  return entries.every(
    (entry) =>
      String(entry?.sku || "").trim() &&
      String(entry?.normalizedSku || "").trim() &&
      String(entry?.variantId || "").trim() &&
      Number.isFinite(Number(entry?.unitPrice))
  );
}

function configError() {
  return "Missing Shopify configuration. Set SHOPIFY_STORE_DOMAIN with either SHOPIFY_ADMIN_ACCESS_TOKEN or SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET.";
}

async function resolveShopifyAccessToken() {
  const { storeDomain, accessToken, clientId, clientSecret } = shopifyConfig();

  if (!storeDomain) {
    return "";
  }

  if (accessToken) {
    return accessToken;
  }

  if (!clientId || !clientSecret) {
    return "";
  }

  if (shopifyTokenCache && shopifyTokenCache.storeDomain === storeDomain && Date.now() < shopifyTokenCache.expiresAt) {
    return shopifyTokenCache.accessToken;
  }

  const response = await fetch(`https://${storeDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret
    }).toString()
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify token exchange failed with ${response.status}: ${text.slice(0, 200)}`);
  }

  const payload = await response.json();
  const resolvedAccessToken = String(payload.access_token || "").trim();
  const expiresInSeconds = Math.max(0, Number(payload.expires_in || 0));

  if (!resolvedAccessToken) {
    throw new Error("Shopify token exchange succeeded but no access_token was returned.");
  }

  shopifyTokenCache = {
    storeDomain,
    accessToken: resolvedAccessToken,
    expiresAt: Date.now() + Math.max(60, expiresInSeconds - 60) * 1000
  };

  return resolvedAccessToken;
}

async function fetchGraphqlJson(query, variables) {
  const { storeDomain, apiVersion, clientId, clientSecret } = shopifyConfig();
  const accessToken = await resolveShopifyAccessToken();

  if (!storeDomain || (!accessToken && !(clientId && clientSecret))) {
    throw new Error(configError());
  }

  if (!accessToken) {
    throw new Error(configError());
  }

  const response = await fetch(`https://${storeDomain}/admin/api/${apiVersion}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken
    },
    body: JSON.stringify({ query, variables })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify GraphQL request failed with ${response.status}: ${text.slice(0, 200)}`);
  }

  const payload = await response.json();
  if (Array.isArray(payload.errors) && payload.errors.length) {
    throw new Error(`Shopify GraphQL error: ${payload.errors[0].message}`);
  }

  return payload.data || {};
}

async function fetchPreorderEntries() {
  const query = `
    query PreorderProducts($first: Int!, $after: String, $search: String!) {
      products(first: $first, after: $after, query: $search, sortKey: TITLE) {
        pageInfo { hasNextPage endCursor }
        nodes {
          title
          variants(first: 250) {
            nodes {
              id
              price
              sku
            }
          }
        }
      }
    }
  `;

  const entries = [];
  let after = null;

  do {
    const data = await fetchGraphqlJson(query, {
      first: 100,
      after,
      search: `tag:${PREORDER_TAG}`
    });

    const products = data.products || {};
    for (const product of Array.isArray(products.nodes) ? products.nodes : []) {
      for (const variant of Array.isArray(product.variants?.nodes) ? product.variants.nodes : []) {
        const sku = String(variant.sku || "").trim().toUpperCase();
        if (!sku) {
          continue;
        }

        entries.push({
          variantId: String(variant.id || "").trim(),
          unitPrice: Number(variant.price || 0),
          sku,
          normalizedSku: normalizeSkuForPreorderMatch(sku)
        });
      }
    }

    after = products.pageInfo?.hasNextPage ? products.pageInfo.endCursor : null;
  } while (after);

  return entries;
}

function loadCacheFromFile() {
  try {
    ensureDataStore();
    return JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  } catch (_error) {
    return null;
  }
}

function saveCacheToFile(cache) {
  ensureDataStore();
  fs.writeFileSync(cacheFile, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

async function loadCacheFromBlob() {
  const { get } = blobSdk();

  try {
    const file = await get(PREORDER_BLOB_PATH, { access: "private" });
    if (!file || file.statusCode !== 200 || !file.blob?.downloadUrl) {
      return null;
    }

    const response = await fetch(file.blob.downloadUrl, {
      headers: {
        Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`
      }
    });

    if (!response.ok) {
      return null;
    }

    return JSON.parse(await response.text());
  } catch (_error) {
    return null;
  }
}

async function saveCacheToBlob(cache) {
  const { put } = blobSdk();
  await put(PREORDER_BLOB_PATH, JSON.stringify(cache, null, 2), {
    access: "private",
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: "application/json"
  });
}

async function loadCachedPreorderData() {
  if (canUseBlobStore()) {
    return loadCacheFromBlob();
  }

  return loadCacheFromFile();
}

async function saveCachedPreorderData(cache) {
  if (canUseBlobStore()) {
    await saveCacheToBlob(cache);
    return;
  }

  saveCacheToFile(cache);
}

async function refreshPreorderCache() {
  const entries = await fetchPreorderEntries();
  const refreshedAt = new Date().toISOString();
  const cache = {
    tag: PREORDER_TAG,
    refreshedAt,
    skuCount: entries.length,
    entries
  };

  await saveCachedPreorderData(cache);
  return buildLookup(cache);
}

async function getPreorderCache() {
  const cached = await loadCachedPreorderData();

  if (cached && isFresh(cached) && hasRequiredEntryFields(cached)) {
    return buildLookup(cached);
  }

  try {
    return await refreshPreorderCache();
  } catch (error) {
    if (cached) {
      return buildLookup(cached);
    }

    throw error;
  }
}

async function findMatchingPreorderSku(sku) {
  const cache = await getPreorderCache();
  const exactSku = String(sku || "").trim().toUpperCase();
  const normalizedSku = normalizeSkuForPreorderMatch(exactSku);

  if (!exactSku || !normalizedSku) {
    return null;
  }

  return cache.byExactSku.get(exactSku) || cache.byNormalizedSku.get(normalizedSku) || null;
}

module.exports = {
  findMatchingPreorderSku,
  getPreorderCache,
  normalizeSkuForPreorderMatch
};
