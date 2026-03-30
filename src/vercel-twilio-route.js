const { handleHttpRequest } = require("./ivr");

function createTwilioRouteHandler(pathname) {
  return async function handler(req, res) {
    req.url = buildRequestUrl(req, pathname);
    await handleHttpRequest(req, res);
  };
}

function buildRequestUrl(req, pathname) {
  const current = new URL(String(req.url || pathname), "http://localhost");
  const search = new URLSearchParams(current.search);
  search.delete("route");
  search.delete("...route");
  search.delete("section");
  search.delete("step");

  const queryString = search.toString();
  return queryString ? `${pathname}?${queryString}` : pathname;
}

module.exports = {
  createTwilioRouteHandler
};
