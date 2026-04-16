const { handleHttpRequest } = require("../../src/ivr");

module.exports = async function handler(req, res) {
  const search = new URL(String(req.url || "/api/testivr/settings"), "http://localhost").search;
  req.url = `/api/testivr/settings${search}`;
  await handleHttpRequest(req, res);
};
