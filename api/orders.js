const { handleHttpRequest } = require("../src/ivr");

module.exports = async function handler(req, res) {
  const current = new URL(String(req.url || "/api/orders"), "http://localhost");

  if (req.method === "POST") {
    const route = current.searchParams.get("route");
    if (route === "shopify-refund") {
      req.url = "/api/orders/shopify-refund";
    } else if (route === "shopify-refund-action") {
      req.url = "/api/shopify/refund-action";
    } else {
      req.url = "/api/orders/refund";
    }
  } else if (current.searchParams.get("route") === "shopify-refund-page") {
    current.searchParams.delete("route");
    req.url = `/shopify/refund${current.search}`;
  } else {
    req.url = "/orders";
  }

  await handleHttpRequest(req, res);
};
