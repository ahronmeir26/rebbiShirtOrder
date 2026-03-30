const { handleHttpRequest } = require("../../../src/ivr");

module.exports = async function handler(req, res) {
  req.url = buildRequestUrl(req);
  await handleHttpRequest(req, res);
};

function buildRequestUrl(req) {
  const current = new URL(String(req.url || "/api/twilio/cart/play"), "http://localhost");
  const search = new URLSearchParams(current.search);
  search.delete("route");
  search.delete("...route");

  const queryString = search.toString();
  return queryString ? `/api/twilio/cart/play?${queryString}` : "/api/twilio/cart/play";
}
