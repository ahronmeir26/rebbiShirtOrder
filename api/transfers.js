const { handleTransfersRequest } = require("../src/transfers");

module.exports = async function handler(req, res) {
  req.url = "/api/transfers";
  await handleTransfersRequest(req, res);
};
