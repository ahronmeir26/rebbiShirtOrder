const http = require("http");
const { handleHttpRequest, ensureDataStore } = require("./ivr");

const PORT = Number(process.env.PORT || 3000);

ensureDataStore();

const server = http.createServer((req, res) => handleHttpRequest(req, res));

server.listen(PORT, () => {
  console.log(`IVR dev server listening on http://localhost:${PORT}`);
});
