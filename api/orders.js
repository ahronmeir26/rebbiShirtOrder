const { handleHttpRequest } = require("../src/ivr");

module.exports = async function handler(req, res) {
  req.url = "/orders";
  await handleHttpRequest(req, res);
};
