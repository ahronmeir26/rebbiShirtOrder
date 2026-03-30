const { handleHttpRequest } = require("../../../src/ivr");

module.exports = async function handler(req, res) {
  req.url = buildRequestUrl(req);
  await handleHttpRequest(req, res);
};

function buildRequestUrl(req) {
  const current = new URL(String(req.url || "/api/twilio/voice"), "http://localhost");
  const section = String(req.query?.section || "").trim();
  const step = String(req.query?.step || "").trim();
  const search = new URLSearchParams(current.search);
  search.delete("section");
  search.delete("step");
  search.delete("route");
  search.delete("...route");

  const segments = [section, step].filter(Boolean);
  const pathname = segments.length ? `/api/twilio/${segments.join("/")}` : "/api/twilio/voice";
  const queryString = search.toString();
  return queryString ? `${pathname}?${queryString}` : pathname;
}
