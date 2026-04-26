const crypto = require("crypto");

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

function shopifyApiVersionNumber() {
  const match = shopifyConfig().apiVersion.match(/^(\d{4})-(\d{2})$/);
  if (!match) {
    return 0;
  }

  return Number(match[1]) * 100 + Number(match[2]);
}

function supportsRefundCreateIdempotency() {
  return shopifyApiVersionNumber() >= 202601;
}

function shopifyIdempotencyKey(...parts) {
  return crypto
    .createHash("sha256")
    .update(parts.map((part) => String(part || "")).join("|"), "utf8")
    .digest("hex");
}

function refundCreateMutation(operationName, selection) {
  const withIdempotency = supportsRefundCreateIdempotency();
  return {
    query: `
      mutation ${operationName}($input: RefundInput!${withIdempotency ? ", $idempotencyKey: String!" : ""}) {
        refundCreate(input: $input)${withIdempotency ? " @idempotent(key: $idempotencyKey)" : ""} {
${selection}
        }
      }
    `,
    withIdempotency
  };
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

function comparablePhoneDigits(value) {
  const digits = normalizePhoneDigits(value);
  if (digits.length === 11 && digits.startsWith("1")) {
    return digits.slice(1);
  }

  return digits;
}

function phoneMatches(left, right) {
  const leftDigits = comparablePhoneDigits(left);
  const rightDigits = comparablePhoneDigits(right);
  return Boolean(leftDigits && rightDigits && leftDigits === rightDigits);
}

function addressPhoneMatches(address, lookupPhone) {
  return phoneMatches(address?.phone, lookupPhone);
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
  const customerPhone = String(node.defaultPhoneNumber?.phoneNumber || "").trim() || undefined;
  const exactPhoneMatch = phoneMatches(customerPhone, lookupPhone) || addresses.some((address) => addressPhoneMatches(address, lookupPhone));

  return {
    id: String(node.id || "").trim(),
    displayName: String(node.displayName || [node.firstName, node.lastName].filter(Boolean).join(" ") || "").trim(),
    firstName: String(node.firstName || "").trim() || undefined,
    lastName: String(node.lastName || "").trim() || undefined,
    phone: customerPhone,
    lookupPhone,
    exactPhoneMatch,
    defaultAddress,
    addresses
  };
}

function orderPhoneMatches(order, lookupPhone) {
  return Boolean(
    phoneMatches(order?.phone, lookupPhone) ||
      phoneMatches(order?.customer?.defaultPhoneNumber?.phoneNumber, lookupPhone) ||
      addressPhoneMatches(order?.shippingAddress, lookupPhone) ||
      addressPhoneMatches(order?.billingAddress, lookupPhone)
  );
}

function orderAddressSelection(order, lookupPhone) {
  if (!orderPhoneMatches(order, lookupPhone)) {
    return null;
  }

  const shippingAddress = normalizeCustomerAddress(order?.shippingAddress);
  if (shippingAddress) {
    return {
      address: shippingAddress,
      source: "recent-order-shipping",
      orderId: String(order.id || "").trim(),
      orderName: String(order.name || "").trim()
    };
  }

  const billingAddress = normalizeCustomerAddress(order?.billingAddress);
  if (billingAddress) {
    return {
      address: billingAddress,
      source: "recent-order-billing",
      orderId: String(order.id || "").trim(),
      orderName: String(order.name || "").trim()
    };
  }

  return null;
}

async function findRecentOrderAddressByPhone(lookupPhone) {
  const query = `
    query RecentOrderAddressByPhone($query: String!) {
      orders(first: 5, query: $query, sortKey: UPDATED_AT, reverse: true) {
        nodes {
          id
          name
          phone
          customer {
            defaultPhoneNumber {
              phoneNumber
            }
          }
          shippingAddress {
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
          billingAddress {
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
  const orders = Array.isArray(data.orders?.nodes) ? data.orders.nodes : [];

  for (const order of orders) {
    const selected = orderAddressSelection(order, lookupPhone);
    if (selected) {
      return selected;
    }
  }

  return null;
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
  const customerWithAddress = normalized.find((customer) => customer.exactPhoneMatch && customer.defaultAddress);
  if (customerWithAddress) {
    return {
      ...customerWithAddress,
      addressSource: "customer"
    };
  }

  let recentOrderAddress = null;
  try {
    recentOrderAddress = await findRecentOrderAddressByPhone(lookupPhone);
  } catch (error) {
    if (!/Access denied/i.test(String(error?.message || ""))) {
      throw error;
    }
  }

  if (recentOrderAddress?.address) {
    return {
      ...(normalized[0] || {
        id: "",
        displayName: "",
        lookupPhone,
        addresses: []
      }),
      lookupPhone,
      defaultAddress: recentOrderAddress.address,
      addressSource: recentOrderAddress.source,
      sourceOrder: {
        id: recentOrderAddress.orderId,
        name: recentOrderAddress.orderName
      }
    };
  }

  return normalized.find((customer) => customer.exactPhoneMatch) || null;
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
  const shopifyCustomerId = String(shippingAddress?.customer?.id || "").trim();
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
  if (shopifyCustomerId) {
    customAttributes.push({ key: "shopify_customer_id", value: shopifyCustomerId });
  }
  if (shippingAddress?.verificationStatus) {
    customAttributes.push({ key: "shipping_address_verification", value: String(shippingAddress.verificationStatus).slice(0, 255) });
  }
  if (shippingAddress?.formattedAddress) {
    customAttributes.push({ key: "verified_shipping_address", value: String(shippingAddress.formattedAddress).slice(0, 255) });
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
        shippingAddress?.verificationStatus ? `Shipping address verification: ${shippingAddress.verificationStatus}` : "",
        addressLines.length ? `Shipping address:\n${addressLines.join("\n")}` : "",
        shippingAddress?.formattedAddress ? `Verified formatted address: ${shippingAddress.formattedAddress}` : "",
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
      ...(shopifyCustomerId ? { purchasingEntity: { customerId: shopifyCustomerId } } : {}),
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

function shopifyRouteError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeShopifyOrderNumber(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  const compact = raw.replace(/\s+/g, "");
  if (/^\d+$/.test(compact)) {
    return `#${compact}`;
  }

  if (/^#?\d+$/.test(compact)) {
    return compact.startsWith("#") ? compact : `#${compact}`;
  }

  if (!/^[#A-Za-z0-9][#A-Za-z0-9._-]{0,63}$/.test(compact)) {
    return "";
  }

  return compact;
}

function normalizeRefundRequest(refund) {
  if (refund == null || refund === "") {
    return { type: "full" };
  }

  if (typeof refund !== "object" || Array.isArray(refund)) {
    throw shopifyRouteError("Refund payload must be an object.", 400);
  }

  const type = String(refund.type || "full").trim().toLowerCase();
  if (type !== "full") {
    throw shopifyRouteError("Only full Shopify refunds are currently supported by this route.", 400);
  }

  return { type };
}

function refundLineItemsForFullOrder(order) {
  return (Array.isArray(order?.lineItems?.nodes) ? order.lineItems.nodes : [])
    .map((lineItem) => ({
      lineItemId: lineItem.id,
      quantity: Math.max(0, Number(lineItem.refundableQuantity ?? 0))
    }))
    .filter((lineItem) => lineItem.lineItemId && lineItem.quantity > 0);
}

async function findShopifyOrderByNumber(orderNumber) {
  const normalizedOrderNumber = normalizeShopifyOrderNumber(orderNumber);
  if (!normalizedOrderNumber) {
    throw shopifyRouteError("Enter a valid Shopify order number, such as #1234 or 1234.", 400);
  }

  const query = `
    query OrderByName($query: String!) {
      orders(first: 2, query: $query) {
        nodes {
          id
          name
          cancelledAt
          displayFinancialStatus
          totalPriceSet {
            presentmentMoney {
              amount
              currencyCode
            }
          }
          lineItems(first: 100) {
            nodes {
              id
              quantity
              refundableQuantity
            }
          }
        }
      }
    }
  `;

  const data = await fetchGraphqlJson(query, { query: `name:${normalizedOrderNumber}` });
  const matches = Array.isArray(data.orders?.nodes) ? data.orders.nodes : [];
  const exactMatches = matches.filter((order) => String(order?.name || "").trim() === normalizedOrderNumber);
  const usableMatches = exactMatches.length ? exactMatches : matches;

  if (!usableMatches.length) {
    throw shopifyRouteError(`Shopify order ${normalizedOrderNumber} was not found.`, 404);
  }

  if (usableMatches.length > 1) {
    throw shopifyRouteError(`Shopify order ${normalizedOrderNumber} matched more than one order.`, 409);
  }

  return usableMatches[0];
}

function normalizeShopifyOrderGid(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  if (/^gid:\/\/shopify\/Order\/\d+$/.test(raw)) {
    return raw;
  }

  const match = raw.match(/\d+/);
  return match ? `gid://shopify/Order/${match[0]}` : "";
}

async function findShopifyOrderById(orderId) {
  const normalizedOrderId = normalizeShopifyOrderGid(orderId);
  if (!normalizedOrderId) {
    throw shopifyRouteError("Enter a valid Shopify order ID.", 400);
  }

  const query = `
    query OrderById($id: ID!) {
      order: node(id: $id) {
        ... on Order {
          id
          name
          cancelledAt
          displayFinancialStatus
          totalPriceSet {
            presentmentMoney {
              amount
              currencyCode
            }
          }
          lineItems(first: 100) {
            nodes {
              id
              quantity
              refundableQuantity
            }
          }
        }
      }
    }
  `;

  const data = await fetchGraphqlJson(query, { id: normalizedOrderId });
  if (!data.order?.id) {
    throw shopifyRouteError("Shopify order was not found.", 404);
  }

  return data.order;
}

async function findShopifyOrderByReference({ orderNumber, orderId } = {}) {
  if (String(orderId || "").trim()) {
    return findShopifyOrderById(orderId);
  }

  return findShopifyOrderByNumber(orderNumber);
}

function refundableQuantityForOrder(order) {
  return refundLineItemsForFullOrder(order).reduce((sum, lineItem) => sum + lineItem.quantity, 0);
}

async function getShopifyOrderRefundPreview({ orderNumber, orderId } = {}) {
  const order = await findShopifyOrderByReference({ orderNumber, orderId });
  const totalPrice = order.totalPriceSet?.presentmentMoney || {};

  return {
    order: {
      id: order.id,
      name: order.name,
      cancelledAt: order.cancelledAt,
      financialStatus: order.displayFinancialStatus,
      totalPrice: Number(totalPrice.amount || 0),
      currencyCode: String(totalPrice.currencyCode || ""),
      refundableQuantity: refundableQuantityForOrder(order)
    }
  };
}

async function refundShopifyOrderByReference({ orderNumber, orderId, notify = false, note, refund } = {}) {
  const refundRequest = normalizeRefundRequest(refund);
  const order = await findShopifyOrderByReference({ orderNumber, orderId });
  const refundLineItems = refundRequest.type === "full" ? refundLineItemsForFullOrder(order) : [];

  if (!refundLineItems.length) {
    throw shopifyRouteError(`Shopify order ${order.name || orderNumber} has no refundable line items.`, 409);
  }

  const mutation = refundCreateMutation("RefundShopifyOrder", `
        refund {
          id
          note
          totalRefundedSet {
            presentmentMoney {
              amount
              currencyCode
            }
          }
          transactions(first: 10) {
            edges {
              node {
                id
                kind
                status
                gateway
                amountSet {
                  presentmentMoney {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
        order {
          id
          name
          displayFinancialStatus
        }
        userErrors {
          field
          message
        }
  `);

  const variables = {
    input: {
      orderId: order.id,
      refundLineItems,
      shipping: { fullRefund: true },
      transactions: [],
      notify: Boolean(notify),
      note: String(note || `Full refund requested through secure backend route for ${order.name}.`).trim()
    }
  };
  if (mutation.withIdempotency) {
    variables.idempotencyKey = shopifyIdempotencyKey("refund-shopify-order", order.id, refundRequest.type, variables.input.note, variables.input.notify);
  }

  const data = await fetchGraphqlJson(mutation.query, variables);
  const result = data.refundCreate || {};
  const errors = Array.isArray(result.userErrors) ? result.userErrors.filter((entry) => entry?.message) : [];
  if (errors.length) {
    throw shopifyRouteError(errors.map((entry) => entry.message).join("; "), 400);
  }

  if (!result.refund?.id) {
    throw new Error("Shopify refundCreate returned no refund.");
  }

  return {
    refund: {
      id: result.refund.id,
      note: result.refund.note,
      totalRefunded: Number(result.refund.totalRefundedSet?.presentmentMoney?.amount || 0),
      currencyCode: String(result.refund.totalRefundedSet?.presentmentMoney?.currencyCode || ""),
      transactions: (Array.isArray(result.refund.transactions?.edges) ? result.refund.transactions.edges : [])
        .map((edge) => edge?.node)
        .filter(Boolean)
        .map((transaction) => ({
          id: transaction.id,
          kind: transaction.kind,
          status: transaction.status,
          gateway: transaction.gateway,
          amount: Number(transaction.amountSet?.presentmentMoney?.amount || 0),
          currencyCode: String(transaction.amountSet?.presentmentMoney?.currencyCode || "")
        }))
    },
    order: {
      id: result.order?.id || order.id,
      name: result.order?.name || order.name,
      financialStatus: result.order?.displayFinancialStatus || order.displayFinancialStatus,
      refundStatus: result.order?.displayFinancialStatus || order.displayFinancialStatus
    }
  };
}

async function refundShopifyOrderByNumber({ orderNumber, notify = false, note, refund } = {}) {
  return refundShopifyOrderByReference({ orderNumber, notify, note, refund });
}

async function loadOrderRefundDetails(orderId) {
  const query = `
    query OrderRefundDetails($id: ID!) {
      order(id: $id) {
        id
        name
        cancelledAt
        displayFinancialStatus
        displayRefundStatus
        lineItems(first: 100) {
          nodes {
            id
            quantity
            refundableQuantity
          }
        }
      }
    }
  `;

  const data = await fetchGraphqlJson(query, { id: orderId });
  if (!data.order?.id) {
    throw new Error("Shopify order lookup returned no order.");
  }

  return data.order;
}

async function createManualShopifyRefundRecord(orderRecord, refund) {
  const orderId = String(orderRecord?.shopifyOrder?.id || "").trim();
  if (!orderId) {
    throw new Error("Missing Shopify order ID.");
  }

  const refundDetails = await loadOrderRefundDetails(orderId);
  const amount = toMoneyAmount(refund?.amount || orderRecord?.totalPrice || 0);
  if (amount <= 0) {
    throw new Error("Missing Shopify refund amount.");
  }

  const refundLineItems = (Array.isArray(refundDetails.lineItems?.nodes) ? refundDetails.lineItems.nodes : [])
    .map((lineItem) => ({
      lineItemId: lineItem.id,
      quantity: Math.max(0, Number(lineItem.refundableQuantity ?? lineItem.quantity ?? 0))
    }))
    .filter((lineItem) => lineItem.lineItemId && lineItem.quantity > 0);
  const shippingAmount = toMoneyAmount(orderRecord?.shippingPrice || 0);
  const mutation = refundCreateMutation("CreateManualRefundRecord", `
        refund {
          id
          note
          totalRefundedSet {
            presentmentMoney {
              amount
              currencyCode
            }
          }
        }
        order {
          id
          name
          displayFinancialStatus
          displayRefundStatus
        }
        userErrors {
          field
          message
        }
  `);

  const variables = {
    input: {
      orderId,
      note: `Stripe refund ${String(refund?.stripeRefundId || "").trim() || "created"} processed outside Shopify for IVR order ${orderRecord.id || ""}.`,
      ...(refundLineItems.length ? { refundLineItems } : {}),
      ...(shippingAmount > 0 ? { shipping: { amount: String(shippingAmount) } } : {}),
      transactions: [
        {
          orderId,
          gateway: "manual",
          kind: "REFUND",
          amount: String(amount)
        }
      ]
    }
  };
  if (mutation.withIdempotency) {
    variables.idempotencyKey = shopifyIdempotencyKey("manual-stripe-refund", orderId, orderRecord.id, refund?.stripeRefundId, amount);
  }

  const data = await fetchGraphqlJson(mutation.query, variables);
  const result = data.refundCreate || {};
  const errors = Array.isArray(result.userErrors) ? result.userErrors.filter((entry) => entry?.message) : [];
  if (errors.length) {
    throw new Error(errors.map((entry) => entry.message).join("; "));
  }

  if (!result.refund?.id) {
    throw new Error("Shopify refund record returned no refund.");
  }

  return {
    id: result.refund.id,
    note: result.refund.note,
    totalRefunded: Number(result.refund.totalRefundedSet?.presentmentMoney?.amount || amount),
    currencyCode: String(result.refund.totalRefundedSet?.presentmentMoney?.currencyCode || refund?.currency || "USD"),
    orderId: result.order?.id || orderId,
    orderName: result.order?.name || orderRecord.shopifyOrder?.name,
    financialStatus: result.order?.displayFinancialStatus,
    refundStatus: result.order?.displayRefundStatus,
    stripeRefundId: String(refund?.stripeRefundId || "").trim(),
    markedAt: new Date().toISOString()
  };
}

async function closeShopifyOrder(orderId) {
  const normalizedOrderId = String(orderId || "").trim();
  if (!normalizedOrderId) {
    throw new Error("Missing Shopify order ID.");
  }

  const query = `
    mutation CloseOrder($input: OrderCloseInput!) {
      orderClose(input: $input) {
        order {
          id
          closed
          closedAt
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const data = await fetchGraphqlJson(query, {
    input: {
      id: normalizedOrderId
    }
  });
  const result = data.orderClose || {};
  const errors = Array.isArray(result.userErrors) ? result.userErrors.filter((entry) => entry?.message) : [];
  if (errors.length) {
    throw new Error(errors.map((entry) => entry.message).join("; "));
  }

  return {
    orderId: result.order?.id || normalizedOrderId,
    closed: Boolean(result.order?.closed),
    closedAt: result.order?.closedAt || new Date().toISOString()
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForShopifyJob(jobId) {
  const normalizedJobId = String(jobId || "").trim();
  if (!normalizedJobId) {
    return false;
  }

  const query = `
    query JobStatus($id: ID!) {
      job(id: $id) {
        id
        done
      }
    }
  `;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const data = await fetchGraphqlJson(query, { id: normalizedJobId });
    if (data.job?.done) {
      return true;
    }

    await sleep(500);
  }

  return false;
}

async function cancelShopifyOrderWithoutRefund(orderRecord, refundRecord, options = {}) {
  const orderId = String(orderRecord?.shopifyOrder?.id || "").trim();
  if (!orderId) {
    throw new Error("Missing Shopify order ID.");
  }

  const query = `
    mutation CancelRefundedOrder(
      $orderId: ID!
      $refundMethod: OrderCancelRefundMethodInput!
      $restock: Boolean!
      $reason: OrderCancelReason!
      $staffNote: String
    ) {
      orderCancel(
        orderId: $orderId
        refundMethod: $refundMethod
        restock: $restock
        reason: $reason
        staffNote: $staffNote
      ) {
        job {
          id
          done
        }
        orderCancelUserErrors {
          field
          message
          code
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const data = await fetchGraphqlJson(query, {
    orderId,
    refundMethod: {
      originalPaymentMethodsRefund: false
    },
    restock: true,
    reason: "CUSTOMER",
    staffNote: String(options.staffNote || "").trim() || `Canceled after external Stripe refund ${String(refundRecord?.stripeRefundId || "").trim() || "created"}.`
  });
  const result = data.orderCancel || {};
  const errors = [
    ...(Array.isArray(result.orderCancelUserErrors) ? result.orderCancelUserErrors : []),
    ...(Array.isArray(result.userErrors) ? result.userErrors : [])
  ].filter((entry) => entry?.message);
  if (errors.length) {
    throw new Error(errors.map((entry) => entry.message).join("; "));
  }

  const cancellation = {
    jobId: result.job?.id,
    done: Boolean(result.job?.done),
    cancelledAt: new Date().toISOString()
  };

  if (cancellation.jobId && !cancellation.done) {
    cancellation.done = await waitForShopifyJob(cancellation.jobId);
  }

  try {
    cancellation.close = await closeShopifyOrder(orderId);
  } catch (error) {
    cancellation.closeError = String(error?.message || "Shopify order close failed.");
  }

  return cancellation;
}

async function cancelShopifyOrderByRecord(orderRecord) {
  return cancelShopifyOrderWithoutRefund(orderRecord, null, {
    staffNote: `Canceled from IVR dashboard without issuing a Stripe refund for order ${String(orderRecord?.id || "").trim() || "unknown"}.`
  });
}

async function cancelAndMarkShopifyOrderRefunded(orderRecord, refund) {
  const refundRecord = await createManualShopifyRefundRecord(orderRecord, refund);
  const cancellation = await cancelShopifyOrderWithoutRefund(orderRecord, refundRecord);

  return {
    ...refundRecord,
    cancellation
  };
}

module.exports = {
  cancelAndMarkShopifyOrderRefunded,
  cancelShopifyOrderByRecord,
  completeDraftOrder,
  createDraftOrder,
  createManualShopifyRefundRecord,
  findCustomerByPhone,
  formatAddressLines,
  getShopifyOrderRefundPreview,
  normalizeCustomerAddress,
  normalizePhoneForShopify,
  lookupDiscountCode,
  refundShopifyOrderByReference,
  refundShopifyOrderByNumber,
  toMoneyAmount
};
