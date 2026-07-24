// db.js — IndexedDB 圖片儲存（F2 實作）
// 公開 API 見 docs/CONTRACTS.md：openDb / putImage / getImage / deleteImage / listImages / clearImages
// IndexedDB 不可用時（如瀏覽器私密模式）優雅降級：openDb 失敗不擋 init，
// putImage reject 帶明確錯誤訊息，其餘讀寫安靜降級（getImage→null、listImages→[]、delete/clear→no-op）。
import { DB_NAME, DB_IMAGE_STORE } from './config.js';
import { uuid } from './dom.js';

let dbPromise = null;
let unavailable = false;

export function openDb() {
  if (unavailable) return Promise.reject(new Error('IndexedDB 不可用'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch (e) {
      unavailable = true;
      dbPromise = null;
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      const database = req.result;
      if (!database.objectStoreNames.contains(DB_IMAGE_STORE)) {
        database.createObjectStore(DB_IMAGE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { unavailable = true; dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

// 開一筆交易，fn(store) 回傳的 request 之 result 於交易 complete 後 resolve。
function runTx(mode, fn) {
  return openDb().then((database) => new Promise((resolve, reject) => {
    let result;
    const t = database.transaction(DB_IMAGE_STORE, mode);
    const store = t.objectStore(DB_IMAGE_STORE);
    const req = fn(store);
    if (req) req.onsuccess = () => { result = req.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export async function putImage(blob) {
  const id = uuid();
  await putImageWithId(id, blob);
  return id;
}

// 內部用：以指定 id 寫入（匯入還原時保留原 uuid，讓 overlay 的 'idb:<uuid>' 引用仍能解析）。
// 非 CONTRACTS 公開合約，僅 store.js 使用。
export async function putImageWithId(id, blob) {
  try {
    await runTx('readwrite', (store) => store.put(
      { blob, type: blob.type, addedAt: new Date().toISOString() }, id,
    ));
  } catch (e) {
    throw new Error('圖片無法儲存（可能為瀏覽器私密模式或儲存空間不足）');
  }
  return id;
}

export async function getImage(id) {
  try {
    const rec = await runTx('readonly', (store) => store.get(id));
    return rec ? rec.blob : null;
  } catch (e) {
    return null;
  }
}

export async function deleteImage(id) {
  try {
    await runTx('readwrite', (store) => store.delete(id));
  } catch (e) { /* 降級：忽略 */ }
}

export async function listImages() {
  try {
    return await runTx('readonly', (store) => store.getAllKeys());
  } catch (e) {
    return [];
  }
}

export async function clearImages() {
  try {
    await runTx('readwrite', (store) => store.clear());
  } catch (e) { /* 降級：忽略 */ }
}
