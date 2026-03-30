const { handleHttpRequest } = require("../../../src/ivr");

module.exports = async function handler(req, res) {
  req.url = buildRequestUrl(req);
  await handleHttpRequest(req, res);
};

function buildRequestUrl(req) {
  const current = new URL(String(req.url || "/api/twilio/order/current"), "http://localhost");
  const step = String(req.query?.step || "current").trim();
  const search = new URLSearchParams(current.search);
  search.delete("step");

  const queryString = search.toString();
  const pathname = `/api/twilio/order/${step}`;
  return queryString ? `${pathname}?${queryString}` : pathname;
}
