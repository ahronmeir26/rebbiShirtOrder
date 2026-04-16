const { handleHttpRequest } = require("../src/ivr");

module.exports = async function handler(req, res) {
  const search = new URL(String(req.url || "/api/logout"), "http://localhost").search;
  req.url = `/logout${search}`;
  await handleHttpRequest(req, res);
};
