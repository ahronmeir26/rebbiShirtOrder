const { handleHttpRequest } = require("../../../../src/ivr");

module.exports = async function handler(req, res) {
  const current = new URL(String(req.url || "/api/twilio/voice"), "http://localhost");
  const segments = [
    req.query?.section,
    req.query?.step,
    req.query?.action
  ]
    .map((segment) => String(segment || "").trim())
    .filter(Boolean);
  const pathname = segments.length ? `/api/twilio/${segments.join("/")}` : "/api/twilio/voice";
  const search = new URLSearchParams(current.search);
  search.delete("route");
  search.delete("...route");
  search.delete("section");
  search.delete("step");
  search.delete("action");
  req.url = search.toString() ? `${pathname}?${search.toString()}` : pathname;
  await handleHttpRequest(req, res);
};
