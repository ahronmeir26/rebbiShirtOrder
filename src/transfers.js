const fs = require("fs");
const path = require("path");

const transfersPageFile = path.join(__dirname, "..", "transfers", "index.html");
let shopifyTokenCache = null;
const LAKEWOOD_LOCATION = "Lakewood";
const PIO_LOCATION = "PIO - A . I . S T O N E";
const ROUTE_PREFIXES = ["/rso"];

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function html(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
  res.end(payload);
}

function normalizeMountedPath(pathname) {
  for (const prefix of ROUTE_PREFIXES) {
    if (pathname === prefix) {
      return "/";
    }

    if (pathname.startsWith(`${prefix}/`)) {
      return pathname.slice(prefix.length) || "/";
    }
  }

  return pathname;
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

function missingConfigError() {
  return "Missing Shopify configuration. Set SHOPIFY_STORE_DOMAIN with either SHOPIFY_ADMIN_ACCESS_TOKEN or SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET.";
}

function extractNextLink(linkHeader) {
  if (!linkHeader) {
    return "";
  }

  const match = linkHeader
    .split(",")
    .map((part) => part.trim())
    .find((part) => /rel="next"/.test(part));

  if (!match) {
    return "";
  }

  const urlMatch = match.match(/<([^>]+)>/);
  return urlMatch ? urlMatch[1] : "";
}

function isTransferEligibleOrder(order) {
  const status = String(order.display_fulfillment_status || order.fulfillment_status || "")
    .trim()
    .toLowerCase();

  return status === "unfulfilled" || status === "unshipped" || status === "";
}

async function fetchGraphqlJson(storeDomain, apiVersion, accessToken, query, variables) {
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

async function fetchOrderDisplayStatuses(storeDomain, apiVersion, accessToken, orderIds) {
  const statuses = new Map();
  const query = `
    query OrderStatuses($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Order {
          id
          legacyResourceId
          displayFulfillmentStatus
          fulfillmentOrders(first: 10) {
            nodes {
              id
              status
              assignedLocation {
                location {
                  name
                }
              }
            }
          }
        }
      }
    }
  `;

  for (let index = 0; index < orderIds.length; index += 100) {
    const batch = orderIds.slice(index, index + 100).map((id) => `gid://shopify/Order/${id}`);
    const data = await fetchGraphqlJson(storeDomain, apiVersion, accessToken, query, { ids: batch });
    const nodes = Array.isArray(data.nodes) ? data.nodes : [];

    for (const node of nodes) {
      if (!node || !node.legacyResourceId) {
        continue;
      }

      statuses.set(String(node.legacyResourceId), {
        displayFulfillmentStatus: String(node.displayFulfillmentStatus || "").trim().toUpperCase(),
        assignedLocations: Array.from(
          new Set(
            (Array.isArray(node.fulfillmentOrders?.nodes) ? node.fulfillmentOrders.nodes : [])
              .map((fulfillmentOrder) => String(fulfillmentOrder.assignedLocation?.location?.name || "").trim())
              .filter(Boolean)
          )
        )
      });
    }
  }

  return statuses;
}

async function fetchVariantInventoryByLocation(storeDomain, apiVersion, accessToken, variantIds) {
  const inventoryByVariantId = new Map();
  const query = `
    query VariantInventory($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          legacyResourceId
          inventoryItem {
            id
            inventoryLevels(first: 20) {
              nodes {
                location { name }
                quantities(names: ["available", "on_hand", "committed", "incoming"]) {
                  name
                  quantity
                }
              }
            }
          }
        }
      }
    }
  `;

  for (let index = 0; index < variantIds.length; index += 50) {
    const batch = variantIds.slice(index, index + 50).map((id) => `gid://shopify/ProductVariant/${id}`);
    const data = await fetchGraphqlJson(storeDomain, apiVersion, accessToken, query, { ids: batch });
    const nodes = Array.isArray(data.nodes) ? data.nodes : [];

    for (const node of nodes) {
      if (!node || !node.legacyResourceId) {
        continue;
      }

      const inventoryLevels = Array.isArray(node.inventoryItem?.inventoryLevels?.nodes)
        ? node.inventoryItem.inventoryLevels.nodes
        : [];

      const levels = {};
      for (const level of inventoryLevels) {
        const locationName = String(level.location?.name || "").trim();
        if (!locationName) {
          continue;
        }

        const quantities = {};
        for (const quantity of Array.isArray(level.quantities) ? level.quantities : []) {
          quantities[quantity.name] = Number(quantity.quantity || 0);
        }

        levels[locationName] = quantities;
      }

      inventoryByVariantId.set(String(node.legacyResourceId), levels);
    }
  }

  return inventoryByVariantId;
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

async function fetchAllOrders(url, accessToken) {
  const collected = [];
  let nextUrl = url.toString();

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json"
      }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Shopify request failed with ${response.status}: ${text.slice(0, 200)}`);
    }

    const data = await response.json();
    if (Array.isArray(data.orders)) {
      collected.push(...data.orders);
    }

    nextUrl = extractNextLink(response.headers.get("link"));
  }

  return collected;
}

async function fetchShopifyOrders() {
  const { storeDomain, clientId, clientSecret, apiVersion } = shopifyConfig();
  const accessToken = await resolveShopifyAccessToken();

  if (!storeDomain || (!accessToken && !(clientId && clientSecret))) {
    return {
      configured: false,
      orders: [],
      error: missingConfigError()
    };
  }

  if (!accessToken) {
    return {
      configured: false,
      orders: [],
      error: missingConfigError()
    };
  }

  const url = new URL(`https://${storeDomain}/admin/api/${apiVersion}/orders.json`);
  url.searchParams.set("status", "open");
  url.searchParams.set("fulfillment_status", "unfulfilled");
  url.searchParams.set("limit", "250");
  url.searchParams.set(
    "fields",
    [
      "id",
      "name",
      "created_at",
      "email",
      "phone",
      "customer",
      "fulfillment_status",
      "financial_status",
      "display_fulfillment_status",
      "current_total_price",
      "currency",
      "source_name",
      "line_items",
      "shipping_address",
      "tags",
      "note"
    ].join(",")
  );

  const restOrders = (await fetchAllOrders(url, accessToken)).filter(isTransferEligibleOrder);
  const displayStatuses = await fetchOrderDisplayStatuses(
    storeDomain,
    apiVersion,
    accessToken,
    restOrders.map((order) => order.id)
  );

  const orders = restOrders.filter((order) => {
    const graphqlData = displayStatuses.get(String(order.id));
    const graphqlStatus = graphqlData?.displayFulfillmentStatus;
    if (!graphqlData) {
      return true;
    }

    return graphqlStatus === "UNFULFILLED";
  });

  const variantIds = Array.from(
    new Set(
      orders.flatMap((order) =>
        (Array.isArray(order.line_items) ? order.line_items : [])
          .map((item) => item.variant_id)
          .filter(Boolean)
          .map(String)
      )
    )
  );
  const inventoryByVariantId = await fetchVariantInventoryByLocation(storeDomain, apiVersion, accessToken, variantIds);

  return {
    configured: true,
    orders: orders.map((order) => ({
      id: order.id,
      name: order.name,
      createdAt: order.created_at,
      email: order.email,
      phone: order.phone,
      customerName: [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(" "),
      fulfillmentStatus:
        displayStatuses.get(String(order.id))?.displayFulfillmentStatus?.toLowerCase().replace(/_/g, " ") ||
        order.display_fulfillment_status ||
        order.fulfillment_status ||
        "unfulfilled",
      financialStatus: order.financial_status || "unknown",
      totalPrice: Number(order.current_total_price || 0),
      currency: order.currency || "USD",
      sourceName: order.source_name || "",
      shippingName: order.shipping_address?.name || "",
      city: order.shipping_address?.city || "",
      province: order.shipping_address?.province || "",
      tags: order.tags || "",
      note: order.note || "",
      assignedLocations: displayStatuses.get(String(order.id))?.assignedLocations || [],
      primaryAssignedLocation: displayStatuses.get(String(order.id))?.assignedLocations?.[0] || "",
      isLakewoodTagged: String(order.tags || "")
        .split(",")
        .map((tag) => tag.trim().toLowerCase())
        .includes("lakewood"),
      itemCount: Array.isArray(order.line_items)
        ? order.line_items.reduce((sum, item) => sum + Number(item.quantity || 0), 0)
        : 0,
      items: Array.isArray(order.line_items)
        ? order.line_items.map((item) => ({
            id: item.id,
            title: item.title,
            variantTitle: item.variant_title,
            sku: item.sku,
            quantity: item.quantity,
            variantId: item.variant_id || null,
            stock: normalizeStockLevels(inventoryByVariantId.get(String(item.variant_id || "")))
          }))
        : []
    }))
  };
}

function normalizeStockLevels(levels) {
  const lakewood = levels?.[LAKEWOOD_LOCATION] || {};
  const pio = levels?.[PIO_LOCATION] || {};

  return {
    lakewood: {
      available: Number(lakewood.available || 0),
      onHand: Number(lakewood.on_hand || 0),
      committed: Number(lakewood.committed || 0)
    },
    pio: {
      available: Number(pio.available || 0),
      onHand: Number(pio.on_hand || 0),
      committed: Number(pio.committed || 0)
    }
  };
}

async function handleTransfersRequest(req, res) {
  try {
    const pathname = normalizeMountedPath(new URL(req.url, "http://localhost").pathname);

    if (req.method === "GET" && (pathname === "/transfers" || pathname === "/transfers/")) {
      html(res, 200, fs.readFileSync(transfersPageFile, "utf8"));
      return;
    }

    if (req.method === "GET" && pathname === "/api/transfers") {
      const payload = await fetchShopifyOrders();
      json(res, 200, payload);
      return;
    }

    json(res, 404, { error: "Not found" });
  } catch (error) {
    json(res, 500, {
      configured: false,
      orders: [],
      error: error.message
    });
  }
}

module.exports = {
  handleTransfersRequest
};
