const { handleHttpRequest } = require("../src/ivr");

module.exports = async function handler(req, res) {
  req.url = "/health";
  await handleHttpRequest(req, res);
};
