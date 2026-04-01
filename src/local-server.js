const http = require("http");
const fs = require("fs");
const path = require("path");
const { handleHttpRequest } = require("./ivr");
const { ensureDataStore } = require("./order-store");
const { handleTransfersRequest } = require("./transfers");

loadLocalEnvFile();

const PORT = Number(process.env.PORT || 3000);

ensureDataStore();

function normalizePathname(pathname) {
  if (pathname === "/rso") {
    return "/";
  }

  if (pathname.startsWith("/rso/")) {
    return pathname.slice("/rso".length) || "/";
  }

  return pathname;
}

const server = http.createServer((req, res) => {
  const current = new URL(req.url, "http://localhost");
  const pathname = normalizePathname(current.pathname);
  if (pathname === "/transfers" || pathname === "/transfers/" || pathname === "/api/transfers") {
    req.url = pathname + current.search;
    return handleTransfersRequest(req, res);
  }

  return handleHttpRequest(req, res);
});

server.listen(PORT, () => {
  console.log(`IVR dev server listening on http://localhost:${PORT}`);
});

function loadLocalEnvFile() {
  const candidates = [".env.local", ".env"];

  for (const filename of candidates) {
    const filePath = path.join(__dirname, "..", filename);

    if (!fs.existsSync(filePath)) {
      continue;
    }

    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separator = trimmed.indexOf("=");
      if (separator === -1) {
        continue;
      }

      const key = trimmed.slice(0, separator).trim();
      if (!key || process.env[key]) {
        continue;
      }

      let value = trimmed.slice(separator + 1).trim();
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
    }
  }
}
