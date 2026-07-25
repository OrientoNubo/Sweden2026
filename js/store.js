// store.js — 資料層核心（F2 實作）
// API 簽名見 docs/CONTRACTS.md。負責：載入 base 分片 + localStorage overlay，
// 合併成 effective POIs（state.pois），並提供所有使用者資料的 mutation。
// 每個 mutation：改 overlay → rebuild() → debounce 存 localStorage → emit('overlay:changed',{type,ids})。
import { state, emit } from './state.js';
import { STORAGE_KEY, commonsImg, ROUTE_COLORS } from './config.js';
import { toast, uuid } from './dom.js';
import * as db from './db.js';

let manifestVersion = '';
let base = [];        // base POIs（分片原始資料）
let overlay = null;   // 使用者 overlay（持久化到 localStorage）

// 原型污染防護：任何來自 JSON 的鍵若命中這些名字一律丟棄，避免污染 Object.prototype。
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// poiState.status 合法列舉（null = active，不落盤）。其餘值於正規化時丟棄。
const VALID_STATUS = new Set(['favorite', 'deleted']);

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

// 只保留 value 為陣列的 day 條目，避免匯入/損毀資料讓下游（rebuild/getItinerary/
// removeFromItinerary）在非陣列上呼叫陣列方法而崩潰。同時丟棄原型污染鍵與非字串 id。
function sanitizeItinerary(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const [day, ids] of Object.entries(obj)) {
    if (DANGEROUS_KEYS.has(day)) continue;
    if (Array.isArray(ids)) out[day] = ids.filter((id) => typeof id === 'string');
  }
  return out;
}

function sanitizeDayNotes(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const [day, text] of Object.entries(obj)) {
    if (DANGEROUS_KEYS.has(day)) continue;
    if (typeof text === 'string' && text) out[day] = text;
  }
  return out;
}

function sanitizeSettings(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (DANGEROUS_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

// poiState 逐點型別 coercion：status 走列舉、note 需字串、patch.name_zh 需非空字串、
// extraImages 需字串陣列。無效欄位一律丟棄；清空後的空殼不保留（等同 cleanupPoiState）。
function sanitizePoiState(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [id, ps] of Object.entries(obj)) {
    if (DANGEROUS_KEYS.has(id)) continue;
    if (!ps || typeof ps !== 'object') continue;
    const clean = {};
    if (typeof ps.status === 'string' && VALID_STATUS.has(ps.status)) clean.status = ps.status;
    if (typeof ps.note === 'string' && ps.note) clean.note = ps.note;
    if (ps.patch && typeof ps.patch === 'object') {
      const patch = {};
      if (typeof ps.patch.name_zh === 'string' && ps.patch.name_zh !== '') patch.name_zh = ps.patch.name_zh;
      if (typeof ps.patch.desc === 'string') patch.desc = ps.patch.desc;
      if (Object.keys(patch).length) clean.patch = patch;
    }
    if (Array.isArray(ps.extraImages)) {
      const imgs = ps.extraImages.filter((r) => typeof r === 'string');
      if (imgs.length) clean.extraImages = imgs;
    }
    if (ps.hiddenInTrash === true) clean.hiddenInTrash = true;
    if (Object.keys(clean).length) out[id] = clean;
  }
  return out;
}

function normalizeOverlay(obj) {
  const skel = emptyOverlay();
  if (!obj || typeof obj !== 'object') return skel;
  return {
    version: obj.version || 1,
    baseVersion: obj.baseVersion || manifestVersion,
    updatedAt: obj.updatedAt || skel.updatedAt,
    poiState: sanitizePoiState(obj.poiState),
    // 濾掉 null / 非物件元素、缺 id 與原型污染鍵，否則 rebuild(effectivePoi 讀 c.id)
    // 與 getRoutes(讀 r.waypoints)會崩潰或污染原型。
    customPois: Array.isArray(obj.customPois)
      ? obj.customPois.filter((c) => c && typeof c === 'object'
          && typeof c.id === 'string' && !DANGEROUS_KEYS.has(c.id))
      : [],
    itinerary: sanitizeItinerary(obj.itinerary),
    dayNotes: sanitizeDayNotes(obj.dayNotes),
    routes: Array.isArray(obj.routes) ? obj.routes.filter((r) => r && typeof r === 'object') : [],
    settings: sanitizeSettings(obj.settings),
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

  // SW 離線時 fetch 可能回 503（帶 {error:'offline'} JSON）或某 shard 未進快取，
  // 不檢查 res.ok 會讓錯誤 JSON 進入 flatMap，對 undefined pois 崩潰整站。逐一檢查後拋錯，
  // 交由上層（main.js）以「離線且無快取」的友善畫面接手，而非白屏。
  const manifestRes = await fetch('./data/manifest.json');
  if (!manifestRes.ok) throw new Error(`manifest 載入失敗（HTTP ${manifestRes.status}）`);
  const manifest = await manifestRes.json();
  manifestVersion = manifest.version;
  const shards = await Promise.all(
    manifest.files.map(async (f) => {
      const res = await fetch(`./data/${f}`);
      if (!res.ok) throw new Error(`分片 ${f} 載入失敗（HTTP ${res.status}）`);
      return res.json();
    }),
  );
  // 雙保險：即便某 shard 意外通過 res.ok 卻非正常分片（如被 200 包裝的錯誤 JSON），
  // 過濾掉無 pois 陣列的物件，避免 flatMap 對 undefined 展開而崩潰。
  base = shards.filter((s) => s && Array.isArray(s.pois)).flatMap((s) => s.pois);

  overlay = loadOverlay();
  rebuild();
  window.addEventListener('storage', onStorageEvent);
  emit('pois:ready');
}

function onStorageEvent(e) {
  // 只在其他分頁改動同一把 key 時觸發（同分頁的寫入不會派發 storage 事件）。
  // 採即時同步：先取消本分頁尚未落盤的排程存檔，避免它稍後用「舊 overlay」整包覆寫
  // 他分頁剛寫入的新資料；再重載他分頁的 overlay、rebuild，並廣播 external 讓 UI 重新同步。
  if (e.key !== STORAGE_KEY) return;
  cancelScheduledSave();
  overlay = loadOverlay();          // e.newValue 為 null（removeItem/reset）時→空 overlay，同步 reset
  rebuild();
  emit('overlay:changed', { type: 'external' });
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

let quotaToastShown = false; // quota toast 節流：成功寫入前不重複提示

// 回傳是否成功寫入 localStorage。quota/例外 → false（呼叫端如 importAll 可據此保留舊資料）。
function saveNow() {
  if (!overlay) return false;
  overlay.updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overlay));
    quotaToastShown = false;
    return true;
  } catch (e) {
    if (e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014)) {
      if (!quotaToastShown) {
        toast('本地儲存空間已滿，請盡快「匯出」備份後再繼續');
        quotaToastShown = true;
      }
    } else {
      console.error('[store] 儲存失敗', e);
      toast('資料儲存失敗，請嘗試匯出備份');
    }
    return false;
  }
}

// 本地 debounce（取代 dom.js 的版本，額外提供 cancel）：跨分頁同步時需丟棄未落盤的排程存檔。
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 300);
}
function cancelScheduledSave() {
  if (saveTimer != null) { clearTimeout(saveTimer); saveTimer = null; }
}

// 深淺相等：primitives 走 ===，陣列/物件走 JSON 比對（供 R1-10 早退判斷用）。
// 只用於「值相同 → 早退免全站重繪」；最壞情況（鍵序不同）僅多一次無害 commit，絕不漏更新。
function valueEquals(a, b) {
  if (a === b) return true;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; }
  }
  return false;
}

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
  const next = status ?? null;
  const cur = overlay.poiState[id]?.status ?? null;
  if (next === cur) return; // 值未變 → 免全站重繪（cur 非 deleted 時 hiddenInTrash 必不存在，無漏清問題）
  const ps = ensurePoiState(id);
  if (status == null) delete ps.status;
  else ps.status = status;
  if (status !== 'deleted') delete ps.hiddenInTrash; // 離開刪除狀態時清除回收站隱藏旗標
  cleanupPoiState(id);
  commit('status', [id]);
}

export function setNote(id, text) {
  const cur = overlay.poiState[id]?.note ?? '';
  if ((text || '') === cur) return; // 值未變（含空↔空）→ 早退，杜絕 blur 觸發的無謂重繪
  const ps = ensurePoiState(id);
  if (text) ps.note = text;
  else delete ps.note;
  cleanupPoiState(id);
  commit('status', [id]);
}

export function patchPoi(id, patch) {
  const cur = overlay.poiState[id]?.patch || {};
  const p = { ...cur };
  if ('name_zh' in patch) {
    if (patch.name_zh == null || patch.name_zh === '') delete p.name_zh;
    else p.name_zh = patch.name_zh;
  }
  if ('desc' in patch) {
    if (patch.desc == null) delete p.desc;
    else p.desc = patch.desc;
  }
  if (valueEquals(cur, p)) return; // patch 無實質變更 → 早退，免全站重繪
  const ps = ensurePoiState(id);
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
    name: { zh: name_zh || '未命名景點', local: '', en: null },
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
  let changed = false;
  if (fields.name_zh != null && c.name.zh !== fields.name_zh) { c.name.zh = fields.name_zh; changed = true; }
  if (fields.category != null && c.category !== fields.category) { c.category = fields.category; changed = true; }
  if (fields.desc != null && c.desc !== fields.desc) { c.desc = fields.desc; changed = true; }
  if (fields.lat != null && c.lat !== fields.lat) { c.lat = fields.lat; changed = true; }
  if (fields.lng != null && c.lng !== fields.lng) { c.lng = fields.lng; changed = true; }
  if (!changed) return; // 無欄位實際變更 → 早退
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
  const cur = overlay.dayNotes[day] ?? '';
  if ((text || '') === cur) return; // 值未變 → 早退，杜絕 blur 觸發的無謂重繪
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
    mode: 'straight',      // 'straight' | 'foot' | 'bike' | 'car'
    geometry: null,        // 非直線模式時的道路幾何快取 [[lat,lng],…]
    road_distance: null,   // 公尺
    road_duration: null,   // 秒
    waypoints: Array.isArray(waypoints) ? waypoints.map((w) => [...w]) : [],
    createdAt: new Date().toISOString(),
  });
  commit('route', [id]);
  return id;
}

export function updateRoute(id, fields = {}) {
  const r = overlay.routes.find((x) => x.id === id);
  if (!r) return;
  let changed = false;
  for (const k of ['name', 'color', 'note', 'day', 'visible', 'waypoints',
                   'mode', 'geometry', 'road_distance', 'road_duration']) {
    if (!(k in fields)) continue;
    if (!valueEquals(r[k], fields[k])) { r[k] = fields[k]; changed = true; }
  }
  if (!changed) return; // 無欄位實際變更 → 早退，免整站重繪（如 blur 未改動的名稱欄）
  commit('route', [id]);
}

export function deleteRoute(id) {
  overlay.routes = overlay.routes.filter((r) => r.id !== id);
  commit('route', [id]);
}

export function getRoutes() {
  // 填預設再展開 r：匯入舊/不完整備份時，缺的欄位(mode/visible/geometry…)有合理值，
  // 下游(F4 routes/routedraw)不會讀到 undefined。真實值一律以 r 為準。
  return overlay.routes.map((r) => ({
    name: '未命名路線',
    color: ROUTE_COLORS[0],
    note: '',
    day: null,
    visible: true,
    mode: 'straight',
    geometry: null,
    road_distance: null,
    road_duration: null,
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
  if (valueEquals(overlay.settings[k], v)) return; // 值未變 → 早退
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
  const refIds = collectIdbRefs();
  for (const id of refIds) {
    try {
      const blob = await db.getImage(id);
      if (!blob) continue;
      images[id] = { type: blob.type, dataUrl: await blobToDataUrl(blob) };
    } catch (e) {
      console.warn('[store] 匯出圖片失敗', id, e);
    }
  }
  // IndexedDB 不可用或個別圖片取不到時，會靜默匯出殘缺備份。統計 overlay 的 idb: 引用數
  // 與實際打包成功數，缺口>0 時提示使用者（僅提示，匯出照常進行）。
  const missing = refIds.size - Object.keys(images).length;
  if (missing > 0) toast(`${missing} 張圖片未含入備份（圖片庫不可用）`);
  return {
    app: 'sweden2026',
    exportVersion: 1,
    exportedAt: new Date().toISOString(),
    overlay: JSON.parse(JSON.stringify(overlay)),
    images,
  };
}

// 從所有 poiState.extraImages 移除指向 idSet 的 'idb:<id>' 引用（清掉還原不了的破圖引用）。
// 回傳是否有任何引用被移除。清空後的空 extraImages / 空殼 poiState 一併收斂。
function stripIdbRefs(idSet) {
  if (!idSet.size) return false;
  let removed = false;
  for (const [id, ps] of Object.entries(overlay.poiState)) {
    if (!ps || !Array.isArray(ps.extraImages)) continue;
    const kept = ps.extraImages.filter((ref) => {
      const hit = typeof ref === 'string' && ref.startsWith('idb:') && idSet.has(ref.slice(4));
      if (hit) removed = true;
      return !hit;
    });
    if (kept.length === ps.extraImages.length) continue;
    if (kept.length) ps.extraImages = kept;
    else {
      delete ps.extraImages;
      if (Object.keys(ps).length === 0) delete overlay.poiState[id];
    }
  }
  return removed;
}

// 原子匯入：先驗證 overlay 主體存在、正規化並嘗試把新 overlay 落盤；若失敗（如 quota）→
// 完全還原舊 overlay，既有圖片庫也不動，回傳 false 讓 io.js 顯示失敗。落盤成功後才清空並
// 寫回圖片、rebuild。回傳 true=成功、false=失敗（含格式不符 / 缺資料主體）。
export async function importAll(obj) {
  if (!obj || obj.app !== 'sweden2026') {
    toast('匯入失敗：檔案格式不符');
    return { ok: false };
  }
  // P1：overlay 主體必須是非空 object。缺失 / 非物件 / 空殼時直接失敗，否則 normalizeOverlay
  // 會回傳空 skeleton，讓後續 saveNow 成功→clearImages 把資料全清卻誤報「匯入完成」。
  if (!obj.overlay || typeof obj.overlay !== 'object' || Array.isArray(obj.overlay)
      || Object.keys(obj.overlay).length === 0) {
    toast('匯入失敗：備份檔缺少資料主體');
    return { ok: false };
  }
  // 備份 baseVersion 與現行資料版本不同 → 標記 stale(僅 baseVersion 存在且不等):匯入照常
  // 成功,由 io.js 改用一次性「少數標註可能已失效」提醒。version 可能為 string/number,轉字串比對。
  const rawBaseVersion = obj.overlay.baseVersion;
  const staleBase = !!manifestVersion && rawBaseVersion != null && rawBaseVersion !== ''
    && String(rawBaseVersion) !== String(manifestVersion);
  const newOverlay = normalizeOverlay(obj.overlay);

  // 先把新 overlay 落盤（saveNow 讀 module-level overlay）；失敗則還原，舊資料與圖片零損。
  cancelScheduledSave();
  const prevOverlay = overlay;
  overlay = newOverlay;
  if (!saveNow()) {
    overlay = prevOverlay;
    return { ok: false };
  }

  // 落盤成功 → 圖片：清空舊庫後寫回，保留原 uuid 以維持 'idb:<uuid>' 引用。
  let imageFailCount = 0;
  const corruptImageIds = new Set(); // dataUrl 損壞而跳過的圖片 id（其 idb: 引用之後清掉）
  try { await db.clearImages(); } catch (e) { /* 降級忽略 */ }
  if (obj.images && typeof obj.images === 'object') {
    for (const [id, img] of Object.entries(obj.images)) {
      if (!img || typeof img.dataUrl !== 'string') { corruptImageIds.add(id); continue; }
      try {
        await db.putImageWithId(id, dataUrlToBlob(img.dataUrl));
      } catch (e) {
        imageFailCount++;
        console.warn('[store] 匯入圖片失敗', id, e);
      }
    }
  }
  // 損壞圖片（dataUrl 非字串，資料本身不可還原）→ 清掉 overlay 對應的 idb: 引用避免永久破圖。
  // 只變小的 overlay 不會新觸發 quota；重存為 best-effort。寫入失敗（imageFailCount，多屬環境
  // 限制而非資料損壞）則保留引用，讓使用者在正常環境重匯可還原。
  if (stripIdbRefs(corruptImageIds)) saveNow();
  rebuild();
  emit('overlay:changed', { type: 'import' });
  if (imageFailCount > 0) toast(`${imageFailCount} 張圖片未能還原（瀏覽器限制）`);
  return { ok: true, staleBase };
}

export function resetAll() {
  cancelScheduledSave(); // 丟棄未落盤的排程存檔，避免它稍後把舊 overlay 又寫回
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* 忽略 */ }
  db.clearImages().catch(() => {});
  overlay = emptyOverlay();
  quotaToastShown = false;
  rebuild();
  emit('overlay:changed', { type: 'reset' });
}
