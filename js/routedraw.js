// routedraw.js — 路線繪製 / 編輯引擎(F4)
// 自寫,不依賴任何 Leaflet 外掛。合約見 docs/CONTRACTS.md。
// 對外:init()、startNew()、startEdit(routeId)
import { $, el, toast } from './dom.js';
import { state, emit } from './state.js';
import { ROUTE_COLORS } from './config.js';
import * as store from './store.js';
import { routeDistance, fmtDistance, boundsOf } from './geo.js';

// ---- 內部狀態 ----
let map = null;
let mode = null;            // null | 'new' | 'edit'
let editRouteId = null;
let workColor = ROUTE_COLORS[0];
let points = [];            // 工作中的節點 [[lat,lng],…]
let selectedIdx = null;     // 編輯模式選中的節點索引
let starting = false;       // startNew/startEdit await getMapSafe 期間的重入保護(此時 state.uiMode 尚未切 draw)

let layer = null;           // 所有暫時圖層的容器
let poly = null;
let nodeMarkers = [];
let ghostMarkers = [];
let ghostInsertIdx = null;  // ghost 拖曳中插入的節點索引

const L = () => window.L;

// mapview 由 F1 並行開發;用 dynamic import 避免其尚未 export getMap 時連結整包失敗
async function getMapSafe() {
  try {
    const mod = await import('./mapview.js');
    return typeof mod.getMap === 'function' ? mod.getMap() : null;
  } catch {
    return null;
  }
}

// ---- 對外 API ----
export function init() {
  const undo = $('#btn-draw-undo');
  const done = $('#btn-draw-done');
  const cancel = $('#btn-draw-cancel');
  if (undo) undo.addEventListener('click', onUndo);
  if (done) done.addEventListener('click', onDone);
  if (cancel) cancel.addEventListener('click', onCancel);
  document.addEventListener('keydown', onKeydown);
}

export async function startNew() {
  if (state.uiMode === 'draw' || starting) return;
  starting = true; // 在 await 前同步設旗標,擋住 await 期間的重入
  map = await getMapSafe();
  if (!map) { starting = false; toast('地圖尚未就緒，請稍候再試'); return; }
  mode = 'new';
  editRouteId = null;
  points = [];
  selectedIdx = null;
  workColor = ROUTE_COLORS[store.getRoutes().length % ROUTE_COLORS.length];
  enterDraw({});
  setupLayer();
  bindNewHandlers();
  updateBanner();
  starting = false;
}

export async function startEdit(routeId) {
  if (state.uiMode === 'draw' || starting) return;
  const route = store.getRoutes().find((r) => r.id === routeId);
  if (!route) { toast('找不到此路線'); return; }
  starting = true; // 在 await 前同步設旗標,擋住 await 期間的重入
  map = await getMapSafe();
  if (!map) { starting = false; toast('地圖尚未就緒，請稍候再試'); return; }
  mode = 'edit';
  editRouteId = routeId;
  workColor = route.color || ROUTE_COLORS[0];
  points = (route.waypoints || []).map((p) => [p[0], p[1]]);
  selectedIdx = null;
  enterDraw({ routeId });
  setupLayer();
  bindEditHandlers();
  configureBannerForEdit();
  redrawEdit();
  const b = boundsOf(points);
  if (b) map.fitBounds(b, { padding: [50, 50] });
  updateBanner();
  starting = false;
}

// ---- 進入 / 離開繪製模式 ----
function enterDraw(opts) {
  state.uiMode = 'draw';
  emit('draw:start', opts.routeId ? { routeId: opts.routeId } : {});
  const banner = $('#draw-banner');
  if (banner) banner.hidden = false;
  const wrap = $('#map-wrap');
  if (wrap) wrap.classList.add('map-draw');
}

function exitDraw() {
  teardownLayer();
  unbindHandlers();
  removeDeleteBtn();
  const banner = $('#draw-banner');
  if (banner) banner.hidden = true;
  const wrap = $('#map-wrap');
  if (wrap) wrap.classList.remove('map-draw');
  const hint = $('#draw-hint');
  if (hint) hint.textContent = '點擊地圖加入節點';
  const dist = $('#draw-distance');
  if (dist) dist.textContent = '';
  state.uiMode = 'normal';
  emit('draw:end');
  mode = null;
  editRouteId = null;
  points = [];
  selectedIdx = null;
  ghostInsertIdx = null;
  map = null;
}

// ---- 圖層生命週期 ----
function setupLayer() {
  layer = L().layerGroup().addTo(map);
  poly = null;
  nodeMarkers = [];
  ghostMarkers = [];
}

function teardownLayer() {
  if (layer && map) map.removeLayer(layer);
  layer = null;
  poly = null;
  nodeMarkers = [];
  ghostMarkers = [];
}

// ---- 事件綁定 ----
let clickTimer = null;

function bindNewHandlers() {
  map.on('click', onMapClickNew);
  map.on('dblclick', onMapDblclickNew);
}

function bindEditHandlers() {
  map.on('click', onMapClickEdit);
}

function unbindHandlers() {
  if (!map) return;
  map.off('click', onMapClickNew);
  map.off('dblclick', onMapDblclickNew);
  map.off('click', onMapClickEdit);
  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
}

// ======================================================================
// 新繪模式
// ======================================================================
function onMapClickNew(e) {
  const { lat, lng } = e.latlng;
  addPoint([lat, lng]);
}

function onMapDblclickNew(e) {
  // dblclick 前會先送出兩次 click(已各加一點);移除與 dblclick 座標相近的尾端節點再補最後一點
  const { lat, lng } = e.latlng;
  const px = map.latLngToContainerPoint([lat, lng]);
  while (points.length > 1) {
    const lp = map.latLngToContainerPoint(points[points.length - 1]);
    if (Math.abs(lp.x - px.x) <= 8 && Math.abs(lp.y - px.y) <= 8) points.pop();
    else break;
  }
  points.push([lat, lng]);
  finishNew();
}

function addPoint(latlng) {
  points.push(latlng);
  redrawNew();
  updateBanner();
}

function redrawNew() {
  if (!layer) return;
  if (poly) { layer.removeLayer(poly); poly = null; }
  for (const m of nodeMarkers) layer.removeLayer(m);
  nodeMarkers = [];
  if (points.length >= 2) {
    poly = L().polyline(points, {
      color: workColor, weight: 3, opacity: 0.9, dashArray: '4 8', interactive: false,
    });
    layer.addLayer(poly);
  }
  points.forEach((p) => {
    // 用 divIcon(DOM)取代 circleMarker,節點邊框走主題 token;非互動,點擊穿透到地圖加點
    const m = L().marker(p, { icon: previewIcon(), interactive: false, keyboard: false });
    layer.addLayer(m);
    nodeMarkers.push(m);
  });
}

function finishNew() {
  if (points.length < 2) { toast('請至少放置 2 個節點'); return; }
  const routes = store.getRoutes();
  const color = ROUTE_COLORS[routes.length % ROUTE_COLORS.length];
  const name = `路線 ${routes.length + 1}`;
  store.addRoute({ waypoints: points.slice(), name, color });
  exitDraw();
  switchToRoutesTab();
  toast('路線已建立，可在清單中改名');
}

function switchToRoutesTab() {
  const tabBtn = document.querySelector('#sidebar-tabs [data-tab="routes"]');
  if (tabBtn) tabBtn.click();
}

// ======================================================================
// 編輯模式
// ======================================================================
function onMapClickEdit() {
  if (selectedIdx != null) {
    selectedIdx = null;
    redrawEdit();
    updateDeleteBtn();
    updateBanner();
  }
}

function midpoint(a, b) {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

// workColor 會內插進節點 divIcon 的 inline style(sink);限定為 hex 色碼,避免非法或外來值
// (route.color 可能來自匯入資料)破壞 style 屬性或注入標記。非 hex 一律退回預設色。
function safeColor(c) {
  return (typeof c === 'string'
    && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(c))
    ? c : ROUTE_COLORS[0];
}

function nodeIcon(selected) {
  const size = selected ? 18 : 13;
  // 選中=高對比 --text 邊框;未選=與介面表面同色的 --bg 邊框,外加 --border 細描邊定義輪廓(兩主題皆可讀)
  const border = selected ? 'var(--text)' : 'var(--bg)';
  const html = `<span style="display:block;width:${size}px;height:${size}px;border-radius:50%;`
    + `background:${safeColor(workColor)};border:2px solid ${border};box-shadow:0 0 0 1px var(--border)"></span>`;
  return L().divIcon({ className: 'route-node-icon', html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

function ghostIcon() {
  const s = 11;
  const html = `<span style="display:block;width:${s}px;height:${s}px;border-radius:50%;`
    + `background:${safeColor(workColor)};opacity:.55;border:1px dashed var(--bg)"></span>`;
  return L().divIcon({ className: 'route-ghost-icon', html, iconSize: [s, s], iconAnchor: [s / 2, s / 2] });
}

// 新繪模式的預覽節點(非互動;邊框走主題 token,與編輯模式一致)
function previewIcon() {
  const s = 11;
  const html = `<span style="display:block;width:${s}px;height:${s}px;border-radius:50%;`
    + `background:${safeColor(workColor)};border:2px solid var(--bg);box-shadow:0 0 0 1px var(--border)"></span>`;
  return L().divIcon({ className: 'route-preview-icon', html, iconSize: [s, s], iconAnchor: [s / 2, s / 2] });
}

function redrawEdit() {
  if (!layer) return;
  layer.clearLayers();
  poly = null;
  nodeMarkers = [];
  ghostMarkers = [];

  if (points.length >= 2) {
    poly = L().polyline(points, { color: workColor, weight: 3, opacity: 0.9 });
    layer.addLayer(poly);
  }

  points.forEach((p, i) => {
    const marker = L().marker(p, { draggable: true, icon: nodeIcon(i === selectedIdx), keyboard: false });
    marker.on('drag', (e) => onNodeDrag(i, e));
    marker.on('dragend', onNodeDragEnd);
    marker.on('click', (e) => onNodeClick(i, e));
    layer.addLayer(marker);
    nodeMarkers.push(marker);
  });

  for (let i = 0; i < points.length - 1; i++) {
    const g = L().marker(midpoint(points[i], points[i + 1]), {
      draggable: true, icon: ghostIcon(), opacity: 0.6, keyboard: false,
    });
    g.on('dragstart', () => onGhostDragStart(i));
    g.on('drag', onGhostDrag);
    g.on('dragend', onGhostDragEnd);
    layer.addLayer(g);
    ghostMarkers.push(g);
  }
}

function onNodeDrag(i, e) {
  const ll = e.target.getLatLng();
  points[i] = [ll.lat, ll.lng];
  if (poly) poly.setLatLngs(points);
  if (i - 1 >= 0 && ghostMarkers[i - 1]) ghostMarkers[i - 1].setLatLng(midpoint(points[i - 1], points[i]));
  if (i < ghostMarkers.length && ghostMarkers[i]) ghostMarkers[i].setLatLng(midpoint(points[i], points[i + 1]));
  updateBanner();
}

function onNodeDragEnd() {
  redrawEdit();
  updateBanner();
}

function onNodeClick(i, e) {
  const oe = e.originalEvent;
  if (oe && oe.altKey) { deleteNode(i); return; }
  selectedIdx = (selectedIdx === i) ? null : i;
  redrawEdit();
  updateDeleteBtn();
  updateBanner();
}

function onGhostDragStart(i) {
  const mid = ghostMarkers[i].getLatLng();
  points.splice(i + 1, 0, [mid.lat, mid.lng]);
  ghostInsertIdx = i + 1;
  if (poly) poly.setLatLngs(points);
}

function onGhostDrag(e) {
  if (ghostInsertIdx == null) return;
  const ll = e.target.getLatLng();
  points[ghostInsertIdx] = [ll.lat, ll.lng];
  if (poly) poly.setLatLngs(points);
  updateBanner();
}

function onGhostDragEnd(e) {
  if (ghostInsertIdx == null) { redrawEdit(); return; }
  const ll = e.target.getLatLng();
  points[ghostInsertIdx] = [ll.lat, ll.lng];
  selectedIdx = ghostInsertIdx;
  ghostInsertIdx = null;
  redrawEdit();
  updateDeleteBtn();
  updateBanner();
}

function deleteNode(i) {
  if (points.length <= 2) { toast('路線至少需保留 2 個節點'); return; }
  points.splice(i, 1);
  if (selectedIdx === i) selectedIdx = null;
  else if (selectedIdx != null && selectedIdx > i) selectedIdx -= 1;
  redrawEdit();
  updateDeleteBtn();
  updateBanner();
}

function finishEdit() {
  if (points.length < 2) { toast('路線至少需 2 個節點'); return; }
  const id = editRouteId;
  const route = store.getRoutes().find((r) => r.id === id);
  const routed = !!(route && route.mode && route.mode !== 'straight');
  // routed 路線:連同 waypoints 一起先樂觀清掉舊道路幾何(暫以新節點的直線顯示),
  // 避免重算完成前殘留沿舊節點的道路路徑造成數秒錯位
  const patch = { waypoints: points.slice() };
  if (routed) { patch.geometry = null; patch.road_distance = null; patch.road_duration = null; }
  store.updateRoute(id, patch);
  exitDraw();
  toast('路線已更新');
  // 非直線模式的路線,節點變更後自動沿道路重算
  if (routed) import('./routing.js').then((m) => m.recomputeIfRouted(id)).catch(() => {});
}

function cancelEdit() {
  // 編輯期間不寫入 store,取消即丟棄工作副本(store 仍保有原始快照)
  exitDraw();
  toast('已取消編輯');
}

// ---- banner 動態按鈕(編輯模式的「刪除節點」) ----
function configureBannerForEdit() {
  const undo = $('#btn-draw-undo');
  if (undo) undo.hidden = true;
  addDeleteBtn();
}

function addDeleteBtn() {
  const banner = $('#draw-banner');
  if (!banner || $('#btn-draw-delnode')) return;
  const done = $('#btn-draw-done');
  const btn = el('button', {
    id: 'btn-draw-delnode', class: 'btn', disabled: true,
    onclick: () => { if (selectedIdx != null) deleteNode(selectedIdx); },
  }, '刪除節點');
  banner.insertBefore(btn, done || null);
}

function updateDeleteBtn() {
  const btn = $('#btn-draw-delnode');
  if (btn) btn.disabled = (selectedIdx == null);
}

function removeDeleteBtn() {
  const btn = $('#btn-draw-delnode');
  if (btn) btn.remove();
  const undo = $('#btn-draw-undo');
  if (undo) undo.hidden = false;
}

// ---- banner 文案 / 距離 ----
function updateBanner() {
  const hint = $('#draw-hint');
  const dist = $('#draw-distance');
  if (hint) {
    if (mode === 'new') {
      hint.textContent = `點擊地圖加入節點(${points.length} 點)· 雙擊或 Enter 完成`;
    } else if (mode === 'edit') {
      hint.textContent = selectedIdx != null
        ? `已選節點 #${selectedIdx + 1} · 拖曳可移動、Delete/按鈕刪除`
        : `拖曳節點移動 · 拖中點新增 · 點節點可選取(${points.length} 點)`;
    }
  }
  if (dist) dist.textContent = points.length >= 2 ? fmtDistance(routeDistance(points)) : '';
}

// ---- banner 按鈕 / 鍵盤 ----
function onUndo() {
  if (mode === 'new' && points.length) {
    points.pop();
    redrawNew();
    updateBanner();
  }
}

function onDone() {
  if (mode === 'new') finishNew();
  else if (mode === 'edit') finishEdit();
}

function onCancel() {
  if (mode === 'new') { exitDraw(); toast('已取消繪製'); }
  else if (mode === 'edit') cancelEdit();
}

function onKeydown(e) {
  if (state.uiMode !== 'draw') return;
  const tag = (e.target && e.target.tagName) || '';
  // 排除 BUTTON:banner 上按鈕(完成/取消/刪除節點)聚焦時按 Enter 會觸發原生 click,
  // 若不排除,全域 Enter→onDone 會與按鈕原生點擊重複觸發
  if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(tag) || (e.target && e.target.isContentEditable)) return;
  if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
  else if (e.key === 'Enter') { e.preventDefault(); onDone(); }
  else if (e.key === 'Backspace') {
    e.preventDefault();
    if (mode === 'new') onUndo();
    else if (mode === 'edit' && selectedIdx != null) deleteNode(selectedIdx);
  } else if (e.key === 'Delete' && mode === 'edit' && selectedIdx != null) {
    e.preventDefault();
    deleteNode(selectedIdx);
  }
}
