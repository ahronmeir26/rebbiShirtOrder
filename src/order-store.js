const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "..", "data");
const ordersFile = path.join(dataDir, "orders.json");
const ORDER_BLOB_PREFIX = "ivr-orders/";

let cachedBlobSdk;

function ensureDataStore() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (!fs.existsSync(ordersFile)) {
    fs.writeFileSync(ordersFile, "[]\n", "utf8");
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

module.exports = {
  ensureDataStore,
  loadOrders,
  saveOrder
};
