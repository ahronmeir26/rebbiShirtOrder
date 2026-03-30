const { handleHttpRequest } = require("../../src/ivr");

module.exports = async function handler(req, res) {
  console.log(
    `[twilio-debug] vercel-entry ${JSON.stringify({
      url: req.url,
      route: req.query?.route,
      queryKeys: req.query ? Object.keys(req.query) : [],
      bodyType: typeof req.body
    })}`
  );
  req.url = buildRequestUrl(req);
  await handleHttpRequest(req, res);
};

function buildRequestUrl(req) {
  const currentUrl = String(req.url || "");
  const current = new URL(currentUrl || "/api/twilio/voice", "http://localhost");
  const routeSegments = Array.isArray(req.query?.route)
    ? req.query.route
    : req.query?.route
      ? [req.query.route]
      : [];

  if (routeSegments.length === 0) {
    return currentUrl || "/api/twilio/voice";
  }

  const search = new URLSearchParams(current.search);
  search.delete("route");

  const queryString = search.toString();
  const pathname = `/api/twilio/${routeSegments.join("/")}`;
  return queryString ? `${pathname}?${queryString}` : pathname;
}
