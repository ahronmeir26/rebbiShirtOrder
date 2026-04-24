const { handleHttpRequest } = require("../src/ivr");

module.exports = async function handler(req, res) {
  req.url = req.method === "POST" ? "/api/orders/refund" : "/orders";
  await handleHttpRequest(req, res);
};
