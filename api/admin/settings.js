const { handleHttpRequest } = require("../../src/ivr");

module.exports = async function handler(req, res) {
  const search = new URL(String(req.url || "/api/admin/settings"), "http://localhost").search;
  req.url = `/api/admin/settings${search}`;
  await handleHttpRequest(req, res);
};
