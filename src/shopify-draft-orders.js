let shopifyTokenCache = null;
const SHIPPING_FEE = 10;

function shopifyConfig() {
  return {
    storeDomain: String(process.env.SHOPIFY_STORE_DOMAIN || "").trim(),
    accessToken: String(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "").trim(),
    clientId: String(process.env.SHOPIFY_CLIENT_ID || "").trim(),
    clientSecret: String(process.env.SHOPIFY_CLIENT_SECRET || "").trim(),
    apiVersion: String(process.env.SHOPIFY_API_VERSION || "2025-01").trim()
  };
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

function toMoneyAmount(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function normalizePhoneDigits(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function normalizePhoneForShopify(value) {
  const digits = normalizePhoneDigits(value);
  if (!digits) {
    return "";
  }

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  return String(value || "").trim().startsWith("+") ? `+${digits}` : digits;
}

function normalizeCustomerAddress(address) {
  if (!address || typeof address !== "object") {
    return null;
  }

  const normalized = {
    firstName: String(address.firstName || "").trim() || undefined,
    lastName: String(address.lastName || "").trim() || undefined,
    name: String(address.name || "").trim() || undefined,
    company: String(address.company || "").trim() || undefined,
    address1: String(address.address1 || "").trim() || undefined,
    address2: String(address.address2 || "").trim() || undefined,
    city: String(address.city || "").trim() || undefined,
    province: String(address.province || "").trim() || undefined,
    provinceCode: String(address.provinceCode || "").trim() || undefined,
    country: String(address.country || "").trim() || undefined,
    countryCode: String(address.countryCodeV2 || address.countryCode || "").trim() || undefined,
    zip: String(address.zip || "").trim() || undefined,
    phone: String(address.phone || "").trim() || undefined
  };

  if (!normalized.address1) {
    return null;
  }

  return normalized;
}

function addressToDraftOrderInput(address) {
  const normalized = normalizeCustomerAddress(address);
  if (!normalized) {
    return null;
  }

  return {
    firstName: normalized.firstName,
    lastName: normalized.lastName,
    company: normalized.company,
    address1: normalized.address1,
    address2: normalized.address2,
    city: normalized.city,
    province: normalized.provinceCode || normalized.province,
    countryCode: normalized.countryCode,
    zip: normalized.zip,
    phone: normalized.phone
  };
}

function formatAddressLines(address) {
  const normalized = normalizeCustomerAddress(address);
  if (!normalized) {
    return [];
  }

  return [
    normalized.name,
    normalized.company,
    [normalized.address1, normalized.address2].filter(Boolean).join(", "),
    [normalized.city, normalized.provinceCode || normalized.province, normalized.zip].filter(Boolean).join(", "),
    normalized.country
  ].filter(Boolean);
}

function normalizeCustomerNode(node, lookupPhone) {
  if (!node || typeof node !== "object") {
    return null;
  }

  const addresses = Array.isArray(node.addresses) ? node.addresses.map(normalizeCustomerAddress).filter(Boolean) : [];
  const defaultAddress = normalizeCustomerAddress(node.defaultAddress) || addresses[0] || null;

  return {
    id: String(node.id || "").trim(),
    displayName: String(node.displayName || [node.firstName, node.lastName].filter(Boolean).join(" ") || "").trim(),
    firstName: String(node.firstName || "").trim() || undefined,
    lastName: String(node.lastName || "").trim() || undefined,
    phone: String(node.defaultPhoneNumber?.phoneNumber || "").trim() || undefined,
    lookupPhone,
    defaultAddress,
    addresses
  };
}

async function findCustomerByPhone(phone) {
  const lookupPhone = normalizePhoneForShopify(phone);
  if (!lookupPhone) {
    return null;
  }

  const query = `
    query CustomerByPhone($query: String!) {
      customers(first: 5, query: $query, sortKey: UPDATED_AT, reverse: true) {
        nodes {
          id
          firstName
          lastName
          displayName
          defaultPhoneNumber {
            phoneNumber
          }
          defaultAddress {
            id
            firstName
            lastName
            name
            company
            address1
            address2
            city
            province
            provinceCode
            country
            countryCodeV2
            zip
            phone
          }
          addresses {
            id
            firstName
            lastName
            name
            company
            address1
            address2
            city
            province
            provinceCode
            country
            countryCodeV2
            zip
            phone
          }
        }
      }
    }
  `;

  const data = await fetchGraphqlJson(query, { query: `phone:${lookupPhone}` });
  const customers = Array.isArray(data.customers?.nodes) ? data.customers.nodes : [];
  const normalized = customers.map((node) => normalizeCustomerNode(node, lookupPhone)).filter(Boolean);
  return normalized.find((customer) => customer.defaultAddress) || normalized[0] || null;
}

function buildLineItemInput(item) {
  const variantId = String(item.variantId || "").trim();
  if (!variantId) {
    throw new Error(`Missing Shopify variant ID for SKU ${item.sku || "unknown"}.`);
  }

  return {
    variantId,
    quantity: Math.max(1, Number(item.quantity || 0))
  };
}

async function lookupDiscountCode(code) {
  const normalizedCode = String(code || "").trim();
  if (!normalizedCode) {
    return null;
  }

  const query = `
    query DiscountCodeLookup($code: String!) {
      codeDiscountNodeByCode(code: $code) {
        id
        codeDiscount {
          __typename
          ... on DiscountCodeBasic {
            title
            status
          }
          ... on DiscountCodeBxgy {
            title
            status
          }
          ... on DiscountCodeFreeShipping {
            title
            status
          }
          ... on DiscountCodeApp {
            title
            status
          }
        }
      }
    }
  `;

  try {
    const data = await fetchGraphqlJson(query, { code: normalizedCode });
    const node = data.codeDiscountNodeByCode;
    if (!node?.id || !node.codeDiscount) {
      return null;
    }

    return {
      code: normalizedCode,
      id: node.id,
      type: String(node.codeDiscount.__typename || "").trim(),
      title: String(node.codeDiscount.title || "").trim(),
      status: String(node.codeDiscount.status || "").trim()
    };
  } catch (error) {
    if (/Access denied/i.test(String(error.message || ""))) {
      return {
        code: normalizedCode,
        unavailable: true
      };
    }

    throw error;
  }
}

async function createDraftOrder(orderRecord) {
  const phone = String(orderRecord.caller || "").trim();
  const discountCode = String(orderRecord.discountCode || "").trim();
  const shippingAddress = orderRecord.shippingAddress && typeof orderRecord.shippingAddress === "object" ? orderRecord.shippingAddress : null;
  const draftShippingAddress = addressToDraftOrderInput(shippingAddress?.address);
  const addressLines = formatAddressLines(shippingAddress?.address);
  const rawSpokenAddress = String(shippingAddress?.raw || "").trim();
  const lineItems = orderRecord.items.map(buildLineItemInput);
  const query = `
    mutation DraftOrderCreate($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder {
          id
          name
          invoiceUrl
          status
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const customAttributes = [
    { key: "ivr_order_id", value: String(orderRecord.id || "") },
    { key: "caller_phone", value: phone || "unknown" },
    { key: "call_sid", value: String(orderRecord.callSid || "") }
  ];

  if (discountCode) {
    customAttributes.push({ key: "ivr_discount_code", value: discountCode });
  }
  if (shippingAddress?.lookupPhone) {
    customAttributes.push({ key: "shipping_lookup_phone", value: String(shippingAddress.lookupPhone) });
  }
  if (shippingAddress?.linkedCallerPhone) {
    customAttributes.push({ key: "shipping_linked_caller_phone", value: String(shippingAddress.linkedCallerPhone) });
  }
  if (shippingAddress?.source) {
    customAttributes.push({ key: "shipping_address_source", value: String(shippingAddress.source) });
  }
  if (rawSpokenAddress) {
    customAttributes.push({ key: "spoken_shipping_address", value: rawSpokenAddress.slice(0, 255) });
  }

  const data = await fetchGraphqlJson(query, {
    input: {
      tags: ["ivr"],
      note: [
        "Created by IVR.",
        phone ? `Caller phone: ${phone}` : "",
        shippingAddress?.lookupPhone && shippingAddress.lookupPhone !== phone ? `Shipping lookup phone: ${shippingAddress.lookupPhone}` : "",
        addressLines.length ? `Shipping address:\n${addressLines.join("\n")}` : "",
        rawSpokenAddress ? `Spoken shipping address: ${rawSpokenAddress}` : "",
        discountCode ? `Discount code entered: ${discountCode}` : "",
        `Shipping fee: $${SHIPPING_FEE}`
      ]
        .filter(Boolean)
        .join("\n"),
      lineItems,
      shippingLine: {
        title: "Shipping",
        priceWithCurrency: {
          amount: SHIPPING_FEE,
          currencyCode: "USD"
        }
      },
      ...(draftShippingAddress ? { shippingAddress: draftShippingAddress } : {}),
      customAttributes,
      ...(discountCode ? { discountCodes: [discountCode] } : {})
    }
  });

  const result = data.draftOrderCreate || {};
  const errors = Array.isArray(result.userErrors) ? result.userErrors.filter((entry) => entry?.message) : [];
  if (errors.length) {
    throw new Error(errors.map((entry) => entry.message).join("; "));
  }

  if (!result.draftOrder?.id) {
    throw new Error("Shopify draft order creation returned no draft order ID.");
  }

  return result.draftOrder;
}

async function completeDraftOrder(draftOrderId) {
  const normalizedId = String(draftOrderId || "").trim();
  if (!normalizedId) {
    throw new Error("Missing Shopify draft order ID.");
  }

  const query = `
    mutation DraftOrderComplete($id: ID!) {
      draftOrderComplete(id: $id) {
        draftOrder {
          id
          name
          status
          order {
            id
            name
            displayFinancialStatus
            displayFulfillmentStatus
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const data = await fetchGraphqlJson(query, { id: normalizedId });
  const result = data.draftOrderComplete || {};
  const errors = Array.isArray(result.userErrors) ? result.userErrors.filter((entry) => entry?.message) : [];
  if (errors.length) {
    throw new Error(errors.map((entry) => entry.message).join("; "));
  }

  if (!result.draftOrder?.id) {
    throw new Error("Shopify draft order completion returned no draft order ID.");
  }

  if (!result.draftOrder.order?.id) {
    throw new Error("Shopify draft order completion returned no order ID.");
  }

  return result.draftOrder;
}

module.exports = {
  completeDraftOrder,
  createDraftOrder,
  findCustomerByPhone,
  formatAddressLines,
  normalizeCustomerAddress,
  normalizePhoneForShopify,
  lookupDiscountCode,
  toMoneyAmount
};
