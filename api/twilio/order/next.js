const { createTwilioRouteHandler } = require("../../../src/vercel-twilio-route");

module.exports = createTwilioRouteHandler("/api/twilio/order/next");
