const { handleHttpRequest } = require("../../src/ivr");

module.exports = async function handler(req, res) {
  req.url = req.url || "/api/twilio/voice";
  await handleHttpRequest(req, res);
};
