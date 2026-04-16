const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "..", "data");
const ordersFile = path.join(dataDir, "orders.json");
const sessionsFile = path.join(dataDir, "sessions.json");
const appConfigFile = path.join(dataDir, "app-config.json");
const ORDER_BLOB_PREFIX = "ivr-orders/";
const SESSION_BLOB_PREFIX = "ivr-sessions/";
const APP_CONFIG_BLOB_PATH = "ivr-config/app-config.json";

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

  if (!fs.existsSync(appConfigFile)) {
    fs.writeFileSync(appConfigFile, "{}\n", "utf8");
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

function writeTextFileAtomically(filePath, contents) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, contents, "utf8");
  fs.renameSync(tempPath, filePath);
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

async function findSessionByCaller(caller) {
  const normalizedCaller = String(caller || "").trim();
  if (!normalizedCaller) {
    return null;
  }

  if (canUseBlobStore()) {
    return findSessionByCallerInBlob(normalizedCaller);
  }

  return findSessionByCallerInFile(normalizedCaller);
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

async function deleteSessionsByCaller(caller) {
  const normalizedCaller = String(caller || "").trim();
  if (!normalizedCaller) {
    return;
  }

  if (canUseBlobStore()) {
    await deleteSessionsByCallerInBlob(normalizedCaller);
    return;
  }

  deleteSessionsByCallerInFile(normalizedCaller);
}

async function loadAppConfig() {
  if (canUseBlobStore()) {
    return loadAppConfigFromBlob();
  }

  return loadAppConfigFromFile();
}

async function saveAppConfig(config) {
  const normalized = config && typeof config === "object" ? config : {};

  if (canUseBlobStore()) {
    await saveAppConfigToBlob(normalized);
    return;
  }

  saveAppConfigToFile(normalized);
}

function saveOrderToFile(orderRecord) {
  ensureDataStore();
  const existing = JSON.parse(fs.readFileSync(ordersFile, "utf8"));
  const orderId = String(orderRecord?.id || "").trim();
  const existingIndex = orderId ? existing.findIndex((entry) => String(entry?.id || "").trim() === orderId) : -1;

  if (existingIndex >= 0) {
    existing[existingIndex] = orderRecord;
  } else {
    existing.push(orderRecord);
  }

  writeTextFileAtomically(ordersFile, `${JSON.stringify(existing, null, 2)}\n`);
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
  writeTextFileAtomically(sessionsFile, `${JSON.stringify(sessions, null, 2)}\n`);
}

function loadAppConfigFromFile() {
  try {
    ensureDataStore();
    return JSON.parse(fs.readFileSync(appConfigFile, "utf8"));
  } catch (_error) {
    return {};
  }
}

function saveAppConfigToFile(config) {
  ensureDataStore();
  writeTextFileAtomically(appConfigFile, `${JSON.stringify(config, null, 2)}\n`);
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

function findSessionByCallerInFile(caller) {
  let bestKey = "";
  let bestRecord = null;

  try {
    const sessions = readSessionsFromFile();

    for (const [sessionKey, sessionRecord] of Object.entries(sessions)) {
      if (sessionRecord && String(sessionRecord.caller || "").trim() === caller && isPreferredCallerSession(sessionKey, sessionRecord, bestKey, bestRecord)) {
        bestKey = sessionKey;
        bestRecord = sessionRecord;
      }
    }
  } catch (_error) {
    return null;
  }

  return bestRecord;
}

function deleteSessionFromFile(sessionKey) {
  const sessions = readSessionsFromFile();
  delete sessions[sessionKey];
  writeSessionsToFile(sessions);
}

function deleteSessionsByCallerInFile(caller) {
  const sessions = readSessionsFromFile();
  for (const [sessionKey, sessionRecord] of Object.entries(sessions)) {
    if (sessionRecord && String(sessionRecord.caller || "").trim() === caller) {
      delete sessions[sessionKey];
    }
  }
  writeSessionsToFile(sessions);
}

async function saveOrderToBlob(orderRecord) {
  const { put } = blobSdk();
  await put(blobPathnameForOrder(orderRecord), JSON.stringify(orderRecord, null, 2), {
    access: "private",
    allowOverwrite: true,
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

async function findSessionByCallerInBlob(caller) {
  const { list } = blobSdk();
  let cursor;
  let bestPathname = "";
  let bestRecord = null;

  do {
    const page = await list({ prefix: SESSION_BLOB_PREFIX, cursor });
    for (const blob of Array.isArray(page.blobs) ? page.blobs : []) {
      const sessionRecord = await loadSessionFromBlob(blob.pathname.replace(SESSION_BLOB_PREFIX, "").replace(/\.json$/, ""));
      if (sessionRecord && String(sessionRecord.caller || "").trim() === caller && isPreferredCallerSession(blob.pathname, sessionRecord, bestPathname, bestRecord)) {
        bestPathname = blob.pathname;
        bestRecord = sessionRecord;
      }
    }

    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  return bestRecord;
}

function sessionTimestamp(sessionRecord) {
  const value = Date.parse(String(sessionRecord?.updatedAt || sessionRecord?.createdAt || ""));
  return Number.isFinite(value) ? value : 0;
}

function isPhoneSessionKey(sessionKey) {
  return String(sessionKey || "").includes("phone:");
}

function isPreferredCallerSession(candidateKey, candidateRecord, currentBestKey, currentBestRecord) {
  if (!candidateRecord) {
    return false;
  }

  if (!currentBestRecord) {
    return true;
  }

  const candidateTimestamp = sessionTimestamp(candidateRecord);
  const bestTimestamp = sessionTimestamp(currentBestRecord);

  if (candidateTimestamp !== bestTimestamp) {
    return candidateTimestamp > bestTimestamp;
  }

  if (isPhoneSessionKey(candidateKey) !== isPhoneSessionKey(currentBestKey)) {
    return isPhoneSessionKey(candidateKey);
  }

  return false;
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

async function deleteSessionsByCallerInBlob(caller) {
  const { list } = blobSdk();
  let cursor;

  do {
    const page = await list({ prefix: SESSION_BLOB_PREFIX, cursor });
    for (const blob of Array.isArray(page.blobs) ? page.blobs : []) {
      const sessionKey = blob.pathname.replace(SESSION_BLOB_PREFIX, "").replace(/\.json$/, "");
      const sessionRecord = await loadSessionFromBlob(sessionKey);
      if (sessionRecord && String(sessionRecord.caller || "").trim() === caller) {
        await deleteSessionFromBlob(sessionKey);
      }
    }

    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
}

async function loadAppConfigFromBlob() {
  const { get } = blobSdk();

  try {
    const file = await get(APP_CONFIG_BLOB_PATH, { access: "private" });
    if (!file || file.statusCode !== 200 || !file.blob?.downloadUrl) {
      return {};
    }

    const response = await fetch(file.blob.downloadUrl, {
      headers: {
        Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`
      }
    });

    if (!response.ok) {
      return {};
    }

    return JSON.parse(await response.text());
  } catch (_error) {
    return {};
  }
}

async function saveAppConfigToBlob(config) {
  const { put } = blobSdk();
  await put(APP_CONFIG_BLOB_PATH, JSON.stringify(config, null, 2), {
    access: "private",
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: "application/json"
  });
}

module.exports = {
  deleteSession,
  deleteSessionsByCaller,
  ensureDataStore,
  findSessionByCaller,
  loadAppConfig,
  loadSession,
  loadOrders,
  saveAppConfig,
  saveSession,
  saveOrder
};
