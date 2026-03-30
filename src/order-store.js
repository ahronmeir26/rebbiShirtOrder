const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "..", "data");
const ordersFile = path.join(dataDir, "orders.json");
const sessionsFile = path.join(dataDir, "sessions.json");
const ORDER_BLOB_PREFIX = "ivr-orders/";
const SESSION_BLOB_PREFIX = "ivr-sessions/";

let cachedBlobSdk;

function ensureDataStore() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (!fs.existsSync(ordersFile)) {
    fs.writeFileSync(ordersFile, "[]\n", "utf8");
  }

  if (!fs.existsSync(sessionsFile)) {
    fs.writeFileSync(sessionsFile, "{}\n", "utf8");
  }
}

function blobSdk() {
  if (cachedBlobSdk !== undefined) {
    return cachedBlobSdk;
  }

  try {
    cachedBlobSdk = require("@vercel/blob");
  } catch (_error) {
    cachedBlobSdk = null;
  }

  return cachedBlobSdk;
}

function canUseBlobStore() {
  return Boolean(String(process.env.BLOB_READ_WRITE_TOKEN || "").trim() && blobSdk());
}

function blobPathnameForOrder(orderRecord) {
  const createdAt = String(orderRecord.createdAt || new Date().toISOString()).replace(/[^\dT]/g, "");
  const safeId = String(orderRecord.id || Date.now()).replace(/[^a-zA-Z0-9_-]/g, "-");
  return `${ORDER_BLOB_PREFIX}${createdAt}-${safeId}.json`;
}

function sortOrdersDescending(orders) {
  return [...orders].sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
}

async function saveOrder(orderRecord) {
  if (canUseBlobStore()) {
    await saveOrderToBlob(orderRecord);
    return;
  }

  saveOrderToFile(orderRecord);
}

async function loadOrders() {
  if (canUseBlobStore()) {
    return loadOrdersFromBlob();
  }

  return loadOrdersFromFile();
}

async function loadSession(sessionKey) {
  if (!sessionKey) {
    return null;
  }

  if (canUseBlobStore()) {
    return loadSessionFromBlob(sessionKey);
  }

  return loadSessionFromFile(sessionKey);
}

async function saveSession(sessionKey, sessionRecord) {
  if (!sessionKey) {
    return;
  }

  if (canUseBlobStore()) {
    await saveSessionToBlob(sessionKey, sessionRecord);
    return;
  }

  saveSessionToFile(sessionKey, sessionRecord);
}

async function deleteSession(sessionKey) {
  if (!sessionKey) {
    return;
  }

  if (canUseBlobStore()) {
    await deleteSessionFromBlob(sessionKey);
    return;
  }

  deleteSessionFromFile(sessionKey);
}

function saveOrderToFile(orderRecord) {
  ensureDataStore();
  const existing = JSON.parse(fs.readFileSync(ordersFile, "utf8"));
  existing.push(orderRecord);
  fs.writeFileSync(ordersFile, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
}

function loadOrdersFromFile() {
  try {
    ensureDataStore();
    return sortOrdersDescending(JSON.parse(fs.readFileSync(ordersFile, "utf8")));
  } catch (_error) {
    return [];
  }
}

function readSessionsFromFile() {
  ensureDataStore();
  return JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
}

function writeSessionsToFile(sessions) {
  ensureDataStore();
  fs.writeFileSync(sessionsFile, `${JSON.stringify(sessions, null, 2)}\n`, "utf8");
}

function loadSessionFromFile(sessionKey) {
  try {
    const sessions = readSessionsFromFile();
    return sessions[sessionKey] || null;
  } catch (_error) {
    return null;
  }
}

function saveSessionToFile(sessionKey, sessionRecord) {
  const sessions = readSessionsFromFile();
  sessions[sessionKey] = sessionRecord;
  writeSessionsToFile(sessions);
}

function deleteSessionFromFile(sessionKey) {
  const sessions = readSessionsFromFile();
  delete sessions[sessionKey];
  writeSessionsToFile(sessions);
}

async function saveOrderToBlob(orderRecord) {
  const { put } = blobSdk();
  await put(blobPathnameForOrder(orderRecord), JSON.stringify(orderRecord, null, 2), {
    access: "private",
    addRandomSuffix: false,
    contentType: "application/json"
  });
}

async function loadOrdersFromBlob() {
  const { list, get } = blobSdk();
  const orders = [];
  let cursor;

  do {
    const page = await list({ prefix: ORDER_BLOB_PREFIX, cursor });
    for (const blob of Array.isArray(page.blobs) ? page.blobs : []) {
      try {
        const file = await get(blob.pathname, { access: "private" });
        if (!file || file.statusCode !== 200 || !file.blob?.downloadUrl) {
          continue;
        }

        const response = await fetch(file.blob.downloadUrl, {
          headers: {
            Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`
          }
        });

        if (!response.ok) {
          continue;
        }

        orders.push(JSON.parse(await response.text()));
      } catch (_error) {
        continue;
      }
    }

    cursor = page.cursor;
    if (!page.hasMore) {
      cursor = undefined;
    }
  } while (cursor);

  return sortOrdersDescending(orders);
}

function blobPathnameForSession(sessionKey) {
  const safeKey = String(sessionKey).replace(/[^a-zA-Z0-9:_-]/g, "-");
  return `${SESSION_BLOB_PREFIX}${safeKey}.json`;
}

async function saveSessionToBlob(sessionKey, sessionRecord) {
  const { put } = blobSdk();
  await put(blobPathnameForSession(sessionKey), JSON.stringify(sessionRecord, null, 2), {
    access: "private",
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: "application/json"
  });
}

async function loadSessionFromBlob(sessionKey) {
  const { get } = blobSdk();

  try {
    const file = await get(blobPathnameForSession(sessionKey), { access: "private" });
    if (!file || file.statusCode !== 200 || !file.blob?.downloadUrl) {
      return null;
    }

    const response = await fetch(file.blob.downloadUrl, {
      headers: {
        Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`
      }
    });

    if (!response.ok) {
      return null;
    }

    return JSON.parse(await response.text());
  } catch (_error) {
    return null;
  }
}

async function deleteSessionFromBlob(sessionKey) {
  const { del } = blobSdk();

  try {
    await del(blobPathnameForSession(sessionKey), {
      token: process.env.BLOB_READ_WRITE_TOKEN
    });
  } catch (_error) {
    // Best-effort cleanup.
  }
}

module.exports = {
  deleteSession,
  ensureDataStore,
  loadSession,
  loadOrders,
  saveSession,
  saveOrder
};
