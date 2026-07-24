// itinerary.js — 「行程」tab(F4)
// 渲染 #day-list:每天一張卡(POI 可排序 / 跨天拖曳)+ 未排程收藏區。
// 合約見 docs/CONTRACTS.md。
import { $, el, toast } from './dom.js';
import { state, on, emit } from './state.js';
import { TRIP_DAYS, dayLabel, dayColor } from './config.js';
import * as store from './store.js';
import * as gmaps from './gmaps.js';
import { routeDistance, fmtDistance } from './geo.js';

let sortables = [];

export function init() {
  on('pois:ready', render);
  on('overlay:changed', render);
  on('tab:changed', (tab) => { if (tab === 'days') render(); });
  render(); // app 於 store.init() 後才呼叫本 init,pois:ready 已錯過,需主動首渲染
}

// ---- SortableJS 實例管理(重渲染前務必 destroy,避免洩漏/重複綁定) ----
function destroySortables() {
  for (const s of sortables) { try { s.destroy(); } catch { /* noop */ } }
  sortables = [];
}

function poiName(p) {
  return p?.name?.zh || p?.name?.local || p?.name?.en || '(未命名)';
}

// ---- 主渲染 ----
function render() {
  const root = $('#day-list');
  if (!root) return;
  destroySortables();
  root.replaceChildren();

  const itin = store.getItinerary() || {};
  for (const day of TRIP_DAYS) {
    root.append(dayCard(day, itin[day] || []));
  }
  root.append(unscheduledSection());
}

// ---- 單日卡 ----
function eccvPhase(day) {
  if (day >= '2026-09-08' && day <= '2026-09-09') return 'Workshops';
  if (day >= '2026-09-10' && day <= '2026-09-12') return 'Main';
  return null;
}

function dayCard(day, ids) {
  const pois = ids.map((id) => store.getPoi(id)).filter(Boolean);
  const color = dayColor(day);
  const visible = state.dayVisibility[day] !== false;
  const coords = pois.map((p) => [p.lat, p.lng]);
  const totalDist = coords.length >= 2 ? routeDistance(coords) : 0;

  const card = el('div', { class: 'day-card' });
  card.style.setProperty('--day-c', color);
  if (!visible) card.classList.add('day-dimmed');

  // 標頭
  const phase = eccvPhase(day);
  const title = el('div', { class: 'day-title' },
    el('span', { class: 'day-name' }, dayLabel(day)),
    phase ? el('span', { class: 'eccv-badge', title: `ECCV 2026 · ${phase}` }, `ECCV·${phase}`) : null,
  );
  const meta = el('div', { class: 'day-meta muted' },
    `${pois.length} 個景點` + (totalDist ? ` · 直線 ${fmtDistance(totalDist)}` : ''));

  const eyeBtn = el('button', {
    class: 'btn-icon day-eye', title: visible ? '隱藏此日' : '顯示此日',
    onclick: () => toggleDay(day, card, eyeBtn),
  }, visible ? '👁' : '🙈');

  const head = el('div', { class: 'day-head' },
    el('span', { class: 'day-swatch' }),
    el('div', { class: 'day-head-main' }, title, meta),
    eyeBtn,
  );

  // 當日備註
  const note = el('textarea', {
    class: 'day-note', rows: '1', placeholder: '當日備註…',
    onblur: (e) => store.setDayNote(day, e.target.value),
  });
  note.value = store.getDayNote(day) || '';

  // POI 排序清單
  const list = el('div', { class: 'day-pois', dataset: { day } });
  pois.forEach((p, i) => list.append(poiRow(day, p, i, color)));
  if (!pois.length) list.append(el('div', { class: 'day-empty muted small' }, '拖曳景點到這裡,或用下方「未排程收藏」指派'));

  card.append(head, note, list);
  const mapsLink = dayMapsLink(coords);
  if (mapsLink) card.append(mapsLink);
  attachSortable(list);
  return card;
}

function toggleDay(day, card, btn) {
  const now = state.dayVisibility[day] !== false;
  const next = !now;
  state.dayVisibility[day] = next;
  card.classList.toggle('day-dimmed', !next);
  btn.textContent = next ? '👁' : '🙈';
  btn.title = next ? '隱藏此日' : '顯示此日';
  emit('day:visibility', { day, visible: next });
}

function poiRow(day, p, i, color) {
  const num = el('span', { class: 'itin-num' }, String(i + 1));
  num.style.background = color;

  const body = el('div', { class: 'itin-body', onclick: () => emit('select', { id: p.id, source: 'list' }) },
    el('div', { class: 'itin-name' }, poiName(p)),
    el('div', { class: 'itin-sub muted small' }, [p.city, p.region].filter(Boolean).join(' · ')),
  );

  const rm = el('button', {
    class: 'btn-icon', title: '移出此日',
    onclick: (e) => { e.stopPropagation(); store.assignToDay(p.id, null); },
  }, '✕');

  return el('div', { class: 'itin-item', dataset: { id: p.id } }, num, body, rm);
}

function dayMapsLink(coords) {
  if (coords.length < 2) return null;
  const urls = gmaps.multiStopUrl(coords, { travelmode: 'transit' });
  if (urls.length === 1) {
    return el('button', {
      class: 'btn day-maps-btn', onclick: () => window.open(urls[0], '_blank', 'noopener'),
    }, '🗺 在 Google Maps 開啟此日路線');
  }
  const wrap = el('div', { class: 'day-maps-multi' },
    el('div', { class: 'muted small' }, `🗺 此日路線超過上限,分 ${urls.length} 段開啟:`));
  urls.forEach((u, i) => wrap.append(
    el('button', { class: 'btn btn-sm', onclick: () => window.open(u, '_blank', 'noopener') }, `第 ${i + 1} 段`)));
  return wrap;
}

// ---- SortableJS:每天一個實例,跨天同 group ----
function attachSortable(listEl) {
  if (!window.Sortable) return;
  const s = new window.Sortable(listEl, {
    group: 'itinerary',
    animation: 150,
    ghostClass: 'sortable-ghost',
    draggable: '.itin-item',
    onEnd: onSortEnd,
  });
  sortables.push(s);
}

function idsOf(container) {
  return [...container.querySelectorAll('.itin-item')].map((c) => c.dataset.id).filter(Boolean);
}

function onSortEnd(evt) {
  const fromDay = evt.from.dataset.day;
  const toDay = evt.to.dataset.day;
  const id = evt.item.dataset.id;
  if (!id || !fromDay || !toDay) return;
  const toIds = idsOf(evt.to);
  const fromIds = idsOf(evt.from);
  // 脫離 Sortable 的 onEnd 同步堆疊後再改資料(store 會 emit overlay:changed → 觸發 render 重建)
  queueMicrotask(() => {
    if (fromDay === toDay) {
      store.reorderDay(toDay, toIds);
    } else {
      store.assignToDay(id, toDay);   // 跨天:先歸日
      store.reorderDay(toDay, toIds); // 再對兩天各自重排
      store.reorderDay(fromDay, fromIds);
    }
  });
}

// ---- 未排程收藏(把收藏撿進日程的主要入口) ----
function unscheduledSection() {
  const favs = store.getPois().filter((p) => p._status === 'favorite' && !p._day);
  const sec = el('div', { class: 'unscheduled' });
  sec.append(el('div', { class: 'unscheduled-head' },
    el('span', {}, '未排程收藏'),
    el('span', { class: 'badge' }, String(favs.length)),
  ));

  if (!favs.length) {
    sec.append(el('div', { class: 'muted small pad' },
      '把景點加入收藏(★)後會出現在這裡,方便指派到某一天。'));
    return sec;
  }

  const list = el('div', { class: 'unscheduled-list' });
  favs.forEach((p) => list.append(unscheduledRow(p)));
  sec.append(list);
  return sec;
}

function unscheduledRow(p) {
  const body = el('div', { class: 'itin-body', onclick: () => emit('select', { id: p.id, source: 'list' }) },
    el('div', { class: 'itin-name' }, poiName(p)),
    el('div', { class: 'itin-sub muted small' }, [p.city, p.region].filter(Boolean).join(' · ')),
  );

  const sel = el('select', {
    class: 'day-assign',
    onclick: (e) => e.stopPropagation(),
    onchange: (e) => { const v = e.target.value; if (v) { store.assignToDay(p.id, v); toast(`已加入 ${dayLabel(v)}`); } },
  });
  sel.append(el('option', { value: '' }, '指派到…'));
  TRIP_DAYS.forEach((d) => sel.append(el('option', { value: d }, dayLabel(d))));

  return el('div', { class: 'itin-item unsched-item', dataset: { id: p.id } }, body, sel);
}
