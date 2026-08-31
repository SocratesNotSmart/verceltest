// IndexedDB persistence so downloaded zones survive a reload and keep working
// with no mobile data — the situation you are actually in when you are driving
// into an Italian old town.

import { bboxContains, bboxIntersects } from './geo.js';

const DB_NAME = 'ztl-radar';
const DB_VERSION = 1;
const ZONES = 'zones';
const COVERAGE = 'coverage';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ZONES)) db.createObjectStore(ZONES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(COVERAGE)) db.createObjectStore(COVERAGE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveZones(zones) {
  const db = await openDb();
  const transaction = db.transaction(ZONES, 'readwrite');
  const store = transaction.objectStore(ZONES);
  for (const zone of zones) store.put(zone);
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(zones.length);
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function loadZones() {
  const db = await openDb();
  return wrap(tx(db, ZONES, 'readonly').getAll());
}

export async function saveCoverage(bbox) {
  const db = await openDb();
  const entry = { id: bbox.map((n) => n.toFixed(3)).join(','), bbox, ts: Date.now() };
  await wrap(tx(db, COVERAGE, 'readwrite').put(entry));
  return entry;
}

export async function loadCoverage() {
  const db = await openDb();
  return wrap(tx(db, COVERAGE, 'readonly').getAll());
}

export async function clearAll() {
  const db = await openDb();
  await wrap(tx(db, ZONES, 'readwrite').clear());
  await wrap(tx(db, COVERAGE, 'readwrite').clear());
}

// Is this point inside an area we have already downloaded? `margin` keeps us
// from trusting the very edge of a downloaded box, where zones just outside it
// would be missing.
export function isCovered(coverage, point, margin = 0.02) {
  return coverage.some((c) => bboxContains(c.bbox, point, -margin));
}

export function coverageIntersecting(coverage, bbox) {
  return coverage.filter((c) => bboxIntersects(c.bbox, bbox));
}
