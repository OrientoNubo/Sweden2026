// routes.js — 「路線」tab(F4)
// 渲染 #route-list;繪製新路線委由 routedraw。合約見 docs/CONTRACTS.md。
import { $, el, toast } from './dom.js';
import { state, on } from './state.js';
import { TRIP_DAYS, dayLabel, ROUTE_COLORS } from './config.js';
import { ICON, iconEl } from './icons.js';
import * as store from './store.js';
import * as gmaps from './gmaps.js';
import * as routedraw from './routedraw.js';
import * as routing from './routing.js';
import { routeDistance, fmtDistance, fmtDuration, boundsOf } from './geo.js';

export function init() {
  const btn = $('#btn-new-route');
  if (btn) btn.addEventListener('click', () => {
    if (state.uiMode === 'draw') return;
    routedraw.startNew();
  });
  on('pois:ready', render);
  on('overlay:changed', (p) => { if (!p || ['route', 'import', 'reset'].includes(p.type)) render(); });
  on('tab:changed', (tab) => { if (tab === 'routes') render(); });
  render(); // app 於 store.init() 後才呼叫本 init,需主動首渲染
}

// mapview 由 F1 並行開發;dynamic import 避免其尚未 export getMap 時連結失敗
async function getMapSafe() {
  try {
    const mod = await import('./mapview.js');
    return typeof mod.getMap === 'function' ? mod.getMap() : null;
  } catch {
    return null;
  }
}

function render() {
  const root = $('#route-list');
  if (!root) return;
  closePopover();
  root.replaceChildren();
  const routes = store.getRoutes() || [];
  if (!routes.length) {
    root.append(el('div', { class: 'muted small pad' },
      '尚無路線。點上方「＋ 繪製新路線」開始在地圖上描繪。'));
    return;
  }
  routes.forEach((r) => root.append(routeRow(r)));
}

function routeRow(r) {
  const wp = r.waypoints || [];
  const routed = r.mode && r.mode !== 'straight' && Array.isArray(r.geometry) && r.geometry.length > 1;
  const dist = routed
    ? `${fmtDistance(r.road_distance)} · 約 ${fmtDuration(r.road_duration)}`
    : fmtDistance(routeDistance(wp));
  const visible = r.visible !== false;

  const row = el('div', { class: 'route-item', dataset: { id: r.id } });
  row.addEventListener('click', () => focusRoute(r));

  // 色塊(點開 swatch popover)
  const swatch = el('button', {
    class: 'route-swatch', title: '變更顏色',
    onclick: (e) => { e.stopPropagation(); openColorPopover(swatch, r); },
  });
  swatch.style.background = r.color || ROUTE_COLORS[0];

  // 名稱(雙擊 inline 改名)
  const name = el('div', { class: 'route-name', title: '雙擊改名' }, r.name || '未命名路線');
  name.addEventListener('dblclick', (e) => { e.stopPropagation(); beginRename(name, r); });

  const meta = el('div', { class: 'route-meta muted small' }, `${dist} · ${wp.length} 點`);
  const top = el('div', { class: 'route-top' }, swatch, name, meta);

  // 路徑模式(直線/沿道路)
  const modeSel = el('select', {
    class: 'route-day route-mode', title: '路徑模式',
    onclick: (e) => e.stopPropagation(),
    onchange: (e) => setRouteMode(r, e.target.value),
  });
  Object.entries(routing.MODE_LABELS).forEach(([k, label]) => {
    const o = el('option', { value: k }, label);
    if ((r.mode || 'straight') === k) o.selected = true;
    modeSel.append(o);
  });

  // 所屬日期
  const daySel = el('select', {
    class: 'route-day',
    onclick: (e) => e.stopPropagation(),
    onchange: (e) => store.updateRoute(r.id, { day: e.target.value || null }),
  });
  daySel.append(el('option', { value: '' }, '無日期'));
  TRIP_DAYS.forEach((d) => {
    const o = el('option', { value: d }, dayLabel(d));
    if (r.day === d) o.selected = true;
    daySel.append(o);
  });

  const visBtn = el('button', {
    class: 'btn-icon', title: visible ? '隱藏路線' : '顯示路線',
    'aria-label': visible ? '隱藏路線' : '顯示路線',
    onclick: (e) => { e.stopPropagation(); store.updateRoute(r.id, { visible: !visible }); },
  }, iconEl(visible ? ICON.eye : ICON.eyeOff));

  const editBtn = el('button', {
    class: 'btn-icon', title: '編輯節點', 'aria-label': '編輯節點',
    onclick: (e) => { e.stopPropagation(); if (state.uiMode === 'draw') return; routedraw.startEdit(r.id); },
  }, iconEl(ICON.edit));

  const mapsBtn = el('button', {
    class: 'btn-icon', title: '在 Google Maps 開啟', 'aria-label': '在 Google Maps 開啟',
    onclick: (e) => { e.stopPropagation(); openInMaps(r); },
  }, iconEl(ICON.gmaps));

  const delBtn = el('button', {
    class: 'btn-icon danger', title: '刪除路線', 'aria-label': '刪除路線',
    onclick: (e) => { e.stopPropagation(); deleteRouteWithUndo(r); },
  }, iconEl(ICON.trash));

  const bottom = el('div', { class: 'route-bottom' },
    modeSel, daySel, el('div', { class: 'route-actions' }, visBtn, editBtn, mapsBtn, delBtn));

  row.append(top, bottom);
  return row;
}

// ---- 路徑模式切換 ----
function setRouteMode(r, mode) {
  if (mode === 'straight') {
    store.updateRoute(r.id, { mode, geometry: null, road_distance: null, road_duration: null });
    return;
  }
  store.updateRoute(r.id, { mode });
  toast('沿道路規劃中…');
  routing.recomputeIfRouted(r.id);
}

// ---- 刪除路線(可復原) ----
// store 無還原 API,故先完整快照路線物件,undo 時以 addRoute + updateRoute 重建
// (id 會不同,但名稱/顏色/日期/節點/模式/道路快取/顯示狀態皆還原)。
function deleteRouteWithUndo(r) {
  const snap = {
    name: r.name, color: r.color, note: r.note, day: r.day,
    visible: r.visible !== false, mode: r.mode || 'straight',
    geometry: r.geometry ?? null,
    road_distance: r.road_distance ?? null,
    road_duration: r.road_duration ?? null,
    waypoints: (r.waypoints || []).map((w) => [...w]),
  };
  store.deleteRoute(r.id);
  toast('已刪除路線', {
    actionLabel: '復原',
    onAction: () => {
      const id = store.addRoute({
        name: snap.name, color: snap.color, note: snap.note,
        day: snap.day, waypoints: snap.waypoints,
      });
      store.updateRoute(id, {
        visible: snap.visible, mode: snap.mode, geometry: snap.geometry,
        road_distance: snap.road_distance, road_duration: snap.road_duration,
      });
    },
  });
}

// ---- 點路線項 → fitBounds ----
async function focusRoute(r) {
  const routed = r.mode && r.mode !== 'straight' && Array.isArray(r.geometry) && r.geometry.length > 1;
  const pts = routed ? r.geometry : (r.waypoints || []);
  if (!pts.length) return;
  const map = await getMapSafe();
  if (!map) return;
  const b = boundsOf(pts);
  if (b) map.fitBounds(b, { padding: [40, 40] });
}

// ---- Google Maps ----
function openInMaps(r) {
  const wp = r.waypoints || [];
  if (wp.length < 2) { toast('路線至少需 2 點才能在 Google Maps 開啟'); return; }
  const urls = gmaps.multiStopUrl(wp, { travelmode: 'transit' });
  openSegmentsSequential(urls);
}

// 超過 Google Maps 單段上限(>9 waypoints)時 multiStopUrl 會回多段。
// 同步連續 window.open 多個分頁會被彈窗攔截(只有第 1 個在使用者手勢內成功),
// 故改為一次只開一段:先開第 1 段,其餘用 toast 行內按鈕逐段引導 —— 每次點擊
// 「開下一段」都是新的使用者手勢,window.open 不會被攔截。
function openSegmentsSequential(urls, i = 0) {
  if (!urls.length || i >= urls.length) return;
  window.open(urls[i], '_blank', 'noopener');
  const total = urls.length;
  if (total === 1) return; // 單段:維持原本靜默行為
  const opened = i + 1;
  if (opened < total) {
    toast(`已開啟第 ${opened}/${total} 段`, {
      actionLabel: '開下一段',
      duration: 8000, // 給使用者足夠時間點擊,否則 toast 會先自動消失
      onAction: () => openSegmentsSequential(urls, opened),
    });
  } else {
    toast(`已開啟第 ${opened}/${total} 段(全部完成)`);
  }
}

// ---- inline 改名 ----
function beginRename(nameEl, r) {
  let canceled = false;
  const input = el('input', { class: 'route-rename', type: 'text', value: r.name || '' });
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') input.blur();
    else if (e.key === 'Escape') { canceled = true; render(); }
  });
  input.addEventListener('blur', () => {
    if (canceled) return;
    const v = input.value.trim();
    store.updateRoute(r.id, { name: v || r.name || '未命名路線' });
  });
  nameEl.replaceWith(input);
  input.focus();
  input.select();
}

// ---- 顏色 swatch popover ----
let openPop = null;

function closePopover() {
  if (openPop) { openPop.remove(); openPop = null; }
  document.removeEventListener('click', closePopover);
}

function openColorPopover(anchor, r) {
  closePopover();
  const pop = el('div', { class: 'color-popover' });
  ROUTE_COLORS.forEach((c) => {
    const cell = el('button', {
      class: 'color-cell' + (c === r.color ? ' active' : ''), title: c,
      onclick: (e) => { e.stopPropagation(); store.updateRoute(r.id, { color: c }); closePopover(); },
    });
    cell.style.background = c;
    pop.append(cell);
  });
  document.body.append(pop);
  const rect = anchor.getBoundingClientRect();
  pop.style.left = `${rect.left}px`;
  pop.style.top = `${rect.bottom + 4}px`;
  openPop = pop;
  // 下一個 tick 起監聽外點關閉(避免本次 click 立即觸發)
  setTimeout(() => document.addEventListener('click', closePopover), 0);
}
