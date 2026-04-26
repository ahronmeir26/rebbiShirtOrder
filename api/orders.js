const { handleHttpRequest } = require("../src/ivr");

module.exports = async function handler(req, res) {
  const current = new URL(String(req.url || "/api/orders"), "http://localhost");
  const route = current.searchParams.get("route");

  if (req.method === "POST") {
    if (route === "shopify-refund") {
      req.url = "/api/orders/shopify-refund";
    } else if (route === "shopify-refund-action") {
      req.url = "/api/shopify/refund-action";
    } else if (route === "caller-discounts-clear") {
      current.searchParams.delete("route");
      req.url = `/api/admin/caller-discounts/clear${current.search}`;
    } else if (route === "cancel") {
      current.searchParams.delete("route");
      req.url = `/api/orders/cancel${current.search}`;
    } else {
      req.url = `/api/orders/refund${current.search}`;
    }
  } else if (route === "shopify-refund-action") {
    req.url = "/api/shopify/refund-action";
  } else if (route === "caller-discounts") {
    current.searchParams.delete("route");
    req.url = `/api/admin/caller-discounts${current.search}`;
  } else if (route === "shopify-refund-page") {
    current.searchParams.delete("route");
    req.url = `/shopify/refund${current.search}`;
  } else if (route === "shopify-debug-json") {
    current.searchParams.delete("route");
    req.url = `/api/shopify/debug${current.search}`;
  } else if (route === "shopify-debug") {
    current.searchParams.delete("route");
    req.url = `/shopify/debug${current.search}`;
  } else {
    req.url = `/orders${current.search}`;
  }

  await handleHttpRequest(req, res);
};
