const { handleHttpRequest } = require("../../src/ivr");

module.exports = async function handler(req, res) {
  req.url = "/api/orders/refund";
  await handleHttpRequest(req, res);
};
