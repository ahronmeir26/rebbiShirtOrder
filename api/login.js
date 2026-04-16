const { handleHttpRequest } = require("../src/ivr");

module.exports = async function handler(req, res) {
  const search = new URL(String(req.url || "/api/login"), "http://localhost").search;
  req.url = `/login${search}`;
  await handleHttpRequest(req, res);
};
