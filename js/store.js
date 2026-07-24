// store.js — 資料層核心（F2 實作）
// API 簽名見 docs/CONTRACTS.md。負責：載入 base 分片 + localStorage overlay，
// 合併成 effective POIs（state.pois），並提供所有使用者資料的 mutation。
// 每個 mutation：改 overlay → rebuild() → debounce 存 localStorage → emit('overlay:changed',{type,ids})。
import { state, emit } from './state.js';
import { STORAGE_KEY, commonsImg, ROUTE_COLORS } from './config.js';
import { debounce, toast, uuid } from './dom.js';
import * as db from './db.js';

let manifestVersion = '';
let base = [];        // base POIs（分片原始資料）
let overlay = null;   // 使用者 overlay（持久化到 localStorage）

// ---------- overlay 骨架 / 正規化 ----------

function emptyOverlay() {
  return {
    version: 1,
    baseVersion: manifestVersion,
    updatedAt: new Date().toISOString(),
    poiState: {},      // id -> {status, note, patch:{name_zh?,desc?}, extraImages:[], hiddenInTrash?}
    customPois: [],
    itinerary: {},     // day -> [id,…]
    dayNotes: {},      // day -> text
    routes: [],
    settings: {},
  };
}

function normalizeOverlay(obj) {
  const skel = emptyOverlay();
  if (!obj || typeof obj !== 'object') return skel;
  return {
    version: obj.version || 1,
    baseVersion: obj.baseVersion || manifestVersion,
    updatedAt: obj.updatedAt || skel.updatedAt,
    poiState: (obj.poiState && typeof obj.poiState === 'object') ? obj.poiState : {},
    customPois: Array.isArray(obj.customPois) ? obj.customPois : [],
    itinerary: (obj.itinerary && typeof obj.itinerary === 'object') ? obj.itinerary : {},
    dayNotes: (obj.dayNotes && typeof obj.dayNotes === 'object') ? obj.dayNotes : {},
    routes: Array.isArray(obj.routes) ? obj.routes : [],
    settings: (obj.settings && typeof obj.settings === 'object') ? obj.settings : {},
  };
}

function loadOverlay() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyOverlay();
    return normalizeOverlay(JSON.parse(raw));
  } catch (e) {
    console.warn('[store] overlay 解析失敗，改用空 overlay', e);
    return emptyOverlay();
  }
}

// ---------- init ----------

export async function init() {
  // IndexedDB 優雅降級：開啟失敗不擋 init（圖片功能停用，其餘照常）
  try { await db.openDb(); } catch (e) { console.warn('[store] IndexedDB 不可用，圖片功能停用', e); }

  const manifest = await (await fetch('./data/manifest.json')).json();
  manifestVersion = manifest.version;
  const shards = await Promise.all(
    manifest.files.map((f) => fetch(`./data/${f}`).then((r) => r.json())),
  );
  base = shards.flatMap((s) => s.pois);

  overlay = loadOverlay();
  rebuild();
  window.addEventListener('storage', onStorageEvent);
  emit('pois:ready');
}

function onStorageEvent(e) {
  // 只在其他分頁改動同一把 key 時觸發（同分頁的寫入不會派發 storage 事件）
  if (e.key === STORAGE_KEY) {
    toast('其他分頁已修改資料，請重新整理');
  }
}

// ---------- 合併：base + overlay → state.pois ----------

function rebuild() {
  const dayOf = {};
  const orderOf = {};
  for (const [day, ids] of Object.entries(overlay.itinerary)) {
    if (!Array.isArray(ids)) continue;
    ids.forEach((id, i) => { dayOf[id] = day; orderOf[id] = i; });
  }

  const result = [];
  for (const p of base) result.push(effectivePoi(p, overlay.poiState[p.id], false, dayOf, orderOf));
  for (const c of overlay.customPois) result.push(effectivePoi(c, overlay.poiState[c.id], true, dayOf, orderOf));
  // overlay 中引用了不存在 POI 的 id（孤兒）不會被任何 POI 取用，自然被忽略。
  state.pois = result;
}

function effectivePoi(src, ps, isCustom, dayOf, orderOf) {
  ps = ps || {};
  const patch = ps.patch || {};

  const name = { ...src.name };
  if (patch.name_zh != null) name.zh = patch.name_zh;

  const images = [];
  if (src.image_file) images.push(commonsImg(src.image_file));
  if (Array.isArray(ps.extraImages)) images.push(...ps.extraImages);

  return {
    ...src,
    name,
    desc: patch.desc != null ? patch.desc : src.desc,
    _status: ps.status ?? null,
    _note: ps.note ?? '',
    _day: dayOf[src.id] ?? null,
    _order: orderOf[src.id] ?? 0,
    _custom: isCustom,
    _images: images,
  };
}

// ---------- 持久化 ----------

function saveNow() {
  if (!overlay) return;
  overlay.updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overlay));
  } catch (e) {
    if (e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014)) {
      toast('本地儲存空間已滿，請盡快「匯出」備份後再繼續');
    } else {
      console.error('[store] 儲存失敗', e);
      toast('資料儲存失敗，請嘗試匯出備份');
    }
  }
}

const scheduleSave = debounce(saveNow, 300);

function commit(type, ids) {
  rebuild();
  scheduleSave();
  emit('overlay:changed', ids != null ? { type, ids } : { type });
}

function ensurePoiState(id) {
  if (!overlay.poiState[id]) overlay.poiState[id] = {};
  return overlay.poiState[id];
}

function cleanupPoiState(id) {
  const ps = overlay.poiState[id];
  if (ps && Object.keys(ps).length === 0) delete overlay.poiState[id];
}

// ---------- 讀取 ----------

export function getPois() { return state.pois; }
export function getPoi(id) { return state.pois.find((p) => p.id === id) ?? null; }

// ---------- 狀態 / 備註 ----------

export function setStatus(id, status) {
  const ps = ensurePoiState(id);
  if (status == null) delete ps.status;
  else ps.status = status;
  if (status !== 'deleted') delete ps.hiddenInTrash; // 離開刪除狀態時清除回收站隱藏旗標
  cleanupPoiState(id);
  commit('status', [id]);
}

export function setNote(id, text) {
  const ps = ensurePoiState(id);
  if (text) ps.note = text;
  else delete ps.note;
  cleanupPoiState(id);
  commit('status', [id]);
}

export function patchPoi(id, patch) {
  const ps = ensurePoiState(id);
  const p = ps.patch || {};
  if ('name_zh' in patch) {
    if (patch.name_zh == null || patch.name_zh === '') delete p.name_zh;
    else p.name_zh = patch.name_zh;
  }
  if ('desc' in patch) {
    if (patch.desc == null) delete p.desc;
    else p.desc = patch.desc;
  }
  if (Object.keys(p).length) ps.patch = p;
  else delete ps.patch;
  cleanupPoiState(id);
  commit('patch', [id]);
}

// ---------- 自訂點 ----------

export function addCustomPoi({ lat, lng, name_zh, category, desc, day } = {}) {
  const id = `custom-${uuid()}`;
  overlay.customPois.push({
    id,
    name: { zh: name_zh || '未命名地點', local: '', en: null },
    lat, lng,
    category: category || 'landmark',
    tier: 2,
    desc: desc || '',
    coord_source: 'official',
    country: 'SE',
    region: 'custom',
    city: '',
    stay_min: 60,
    stay_max: 60,
    image_file: null,
    url: null,
    wikipedia: null,
    hours: null,
    cost: null,
    transit: null,
    sep_note: null,
    createdAt: new Date().toISOString(),
  });
  if (day) {
    if (!Array.isArray(overlay.itinerary[day])) overlay.itinerary[day] = [];
    overlay.itinerary[day].push(id);
  }
  commit('custom', [id]);
  return id;
}

export function updateCustomPoi(id, fields = {}) {
  const c = overlay.customPois.find((x) => x.id === id);
  if (!c) return;
  if (fields.name_zh != null) c.name.zh = fields.name_zh;
  if (fields.category != null) c.category = fields.category;
  if (fields.desc != null) c.desc = fields.desc;
  if (fields.lat != null) c.lat = fields.lat;
  if (fields.lng != null) c.lng = fields.lng;
  commit('custom', [id]);
}

// ---------- 圖片引用（實體 blob 由 db.js 管理）----------

export function addImage(id, ref) {
  const ps = ensurePoiState(id);
  if (!Array.isArray(ps.extraImages)) ps.extraImages = [];
  if (!ps.extraImages.includes(ref)) ps.extraImages.push(ref);
  commit('patch', [id]);
}

export function removeImage(id, ref) {
  const ps = overlay.poiState[id];
  if (!ps || !Array.isArray(ps.extraImages)) return;
  ps.extraImages = ps.extraImages.filter((r) => r !== ref);
  if (ps.extraImages.length === 0) delete ps.extraImages;
  if (typeof ref === 'string' && ref.startsWith('idb:')) {
    db.deleteImage(ref.slice(4)).catch(() => {});
  }
  cleanupPoiState(id);
  commit('patch', [id]);
}

// ---------- 行程指派 / 排序 ----------

function removeFromItinerary(id) {
  for (const [day, ids] of Object.entries(overlay.itinerary)) {
    const idx = ids.indexOf(id);
    if (idx >= 0) {
      ids.splice(idx, 1);
      if (ids.length === 0) delete overlay.itinerary[day];
    }
  }
}

export function assignToDay(id, day) {
  removeFromItinerary(id);
  if (day != null) {
    if (!Array.isArray(overlay.itinerary[day])) overlay.itinerary[day] = [];
    overlay.itinerary[day].push(id);
  }
  commit('itinerary', [id]);
}

export function reorderDay(day, orderedIds) {
  if (Array.isArray(orderedIds) && orderedIds.length) overlay.itinerary[day] = [...orderedIds];
  else delete overlay.itinerary[day];
  commit('itinerary', orderedIds);
}

export function setDayNote(day, text) {
  if (text) overlay.dayNotes[day] = text;
  else delete overlay.dayNotes[day];
  commit('daynote');
}

export function getDayNote(day) {
  return overlay.dayNotes[day] || '';
}

export function getItinerary() {
  // 過濾掉已不存在的 POI id，避免上層渲染幽靈項目
  const valid = new Set(state.pois.map((p) => p.id));
  const out = {};
  for (const [day, ids] of Object.entries(overlay.itinerary)) {
    const filtered = ids.filter((id) => valid.has(id));
    if (filtered.length) out[day] = filtered;
  }
  return out;
}

// ---------- 路線 ----------

export function addRoute({ name, color, note, day, waypoints } = {}) {
  const id = `route-${uuid()}`;
  overlay.routes.push({
    id,
    name: name || '未命名路線',
    color: color || ROUTE_COLORS[overlay.routes.length % ROUTE_COLORS.length],
    note: note || '',
    day: day ?? null,
    visible: true,
    waypoints: Array.isArray(waypoints) ? waypoints.map((w) => [...w]) : [],
    createdAt: new Date().toISOString(),
  });
  commit('route', [id]);
  return id;
}

export function updateRoute(id, fields = {}) {
  const r = overlay.routes.find((x) => x.id === id);
  if (!r) return;
  for (const k of ['name', 'color', 'note', 'day', 'visible', 'waypoints']) {
    if (k in fields) r[k] = fields[k];
  }
  commit('route', [id]);
}

export function deleteRoute(id) {
  overlay.routes = overlay.routes.filter((r) => r.id !== id);
  commit('route', [id]);
}

export function getRoutes() {
  return overlay.routes.map((r) => ({
    ...r,
    waypoints: Array.isArray(r.waypoints) ? r.waypoints.map((w) => [...w]) : [],
  }));
}

// ---------- 回收站 ----------

export function restoreFromTrash(id) {
  const ps = overlay.poiState[id];
  if (!ps) return;
  delete ps.status;         // 回到 active
  delete ps.hiddenInTrash;
  cleanupPoiState(id);
  commit('status', [id]);
}

export function purgeFromTrash(id) {
  const isCustom = typeof id === 'string' && id.startsWith('custom-');
  if (isCustom) {
    const idx = overlay.customPois.findIndex((c) => c.id === id);
    if (idx >= 0) overlay.customPois.splice(idx, 1);
    const ps = overlay.poiState[id];
    if (ps && Array.isArray(ps.extraImages)) {
      for (const ref of ps.extraImages) {
        if (typeof ref === 'string' && ref.startsWith('idb:')) db.deleteImage(ref.slice(4)).catch(() => {});
      }
    }
    delete overlay.poiState[id];
    removeFromItinerary(id);
    commit('custom', [id]);
  } else {
    // base 點無法真的移除，改標記為回收站隱藏（status 維持 deleted）
    const ps = ensurePoiState(id);
    ps.hiddenInTrash = true;
    commit('status', [id]);
  }
}

export function getTrash() {
  return state.pois.filter((p) => p._status === 'deleted' && !isHiddenInTrash(p.id));
}

function isHiddenInTrash(id) {
  const ps = overlay && overlay.poiState[id];
  return !!(ps && ps.hiddenInTrash);
}

// ---------- 設定 ----------

export function getSetting(k, def) {
  return overlay && (k in overlay.settings) ? overlay.settings[k] : def;
}

export function setSetting(k, v) {
  overlay.settings[k] = v;
  commit('settings', [k]);
}

// ---------- 匯出 / 匯入 / 重置 ----------

function collectIdbRefs() {
  const set = new Set();
  for (const ps of Object.values(overlay.poiState)) {
    if (ps && Array.isArray(ps.extraImages)) {
      for (const ref of ps.extraImages) {
        if (typeof ref === 'string' && ref.startsWith('idb:')) set.add(ref.slice(4));
      }
    }
  }
  return set;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const meta = dataUrl.slice(0, comma);
  const b64 = dataUrl.slice(comma + 1);
  const mime = (meta.match(/data:(.*?)(;base64)?$/) || [])[1] || 'application/octet-stream';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

export async function exportAll() {
  const images = {};
  for (const id of collectIdbRefs()) {
    try {
      const blob = await db.getImage(id);
      if (!blob) continue;
      images[id] = { type: blob.type, dataUrl: await blobToDataUrl(blob) };
    } catch (e) {
      console.warn('[store] 匯出圖片失敗', id, e);
    }
  }
  return {
    app: 'sweden2026',
    exportVersion: 1,
    exportedAt: new Date().toISOString(),
    overlay: JSON.parse(JSON.stringify(overlay)),
    images,
  };
}

export async function importAll(obj) {
  if (!obj || obj.app !== 'sweden2026') {
    toast('匯入失敗：檔案格式不符');
    return;
  }
  // 圖片：清空舊庫後寫回，保留原 uuid 以維持 'idb:<uuid>' 引用
  try { await db.clearImages(); } catch (e) { /* 降級忽略 */ }
  if (obj.images && typeof obj.images === 'object') {
    for (const [id, img] of Object.entries(obj.images)) {
      if (!img || typeof img.dataUrl !== 'string') continue;
      try {
        await db.putImageWithId(id, dataUrlToBlob(img.dataUrl));
      } catch (e) {
        console.warn('[store] 匯入圖片失敗', id, e);
      }
    }
  }
  overlay = normalizeOverlay(obj.overlay);
  rebuild();
  saveNow();
  emit('overlay:changed', { type: 'import' });
}

export function resetAll() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* 忽略 */ }
  db.clearImages().catch(() => {});
  overlay = emptyOverlay();
  rebuild();
  emit('overlay:changed', { type: 'reset' });
}
