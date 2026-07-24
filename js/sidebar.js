// sidebar.js — 左欄:tabs + 景點列表(F3 擁有)
// 合約見 docs/CONTRACTS.md。
import { state, emit, on } from './state.js';
import { $, $$, el, toast } from './dom.js';
import { CATEGORIES, TRIP_DAYS, dayLabel, fmtStay } from './config.js';
import { ICON, iconEl } from './icons.js';
import * as store from './store.js';
import { applyFilters } from './filters.js';

const isMobile = () => window.matchMedia('(max-width: 768px)').matches;
function closeSidebar() { document.body.classList.remove('sidebar-open'); }

function catInfo(cat) {
  return CATEGORIES[cat] || { zh: cat || '其他', glyph: '📍', color: '#888888' };
}

function thumb(p) {
  const img = p._images && p._images[0];
  // 效能:列表僅直接顯示 http(s) 縮圖(lazy);idb 上傳圖以分類色塊代替(詳情面板才載入)。
  if (img && /^https?:/.test(img)) {
    return el('div', { class: 'li-thumb' },
      el('img', { src: img, loading: 'lazy', alt: '', referrerpolicy: 'no-referrer' }));
  }
  const c = catInfo(p.category);
  return el('div', { class: 'li-thumb', style: { background: c.color } }, c.glyph);
}

function daySelect(p) {
  const sel = el('select', {
    class: p._day ? 'assigned' : '',
    title: '指派日期',
    onclick: (e) => e.stopPropagation(),
    onchange: (e) => { e.stopPropagation(); store.assignToDay(p.id, sel.value || null); },
  }, el('option', { value: '' }, '未指派'),
    ...TRIP_DAYS.map((d) => el('option', { value: d }, dayLabel(d))));
  sel.value = p._day || '';
  return sel;
}

function listItem(p) {
  const c = catInfo(p.category);
  const fav = p._status === 'favorite';
  const stay = fmtStay(p.stay_min, p.stay_max);
  const subParts = [
    p.city, c.zh,
    p.tier ? `Tier ${p.tier}` : null,
    stay ? `停留 ${stay}` : null,
  ].filter(Boolean);

  const favBtn = el('button', {
    class: 'btn-icon' + (fav ? ' on' : ''),
    title: fav ? '取消收藏' : '收藏',
    'aria-label': fav ? '取消收藏' : '收藏',
    onclick: (e) => { e.stopPropagation(); store.setStatus(p.id, fav ? null : 'favorite'); },
  }, iconEl(fav ? ICON.starFill : ICON.starOutline, fav ? 'ico-fav' : undefined));

  const delBtn = el('button', {
    class: 'btn-icon',
    title: '移入回收站',
    'aria-label': '移入回收站',
    onclick: (e) => {
      e.stopPropagation();
      store.setStatus(p.id, 'deleted');
      toast('已移至回收站', { actionLabel: '復原', onAction: () => store.setStatus(p.id, null) });
    },
  }, iconEl(ICON.trash));

  const locateBtn = el('button', {
    class: 'btn-icon',
    title: '在地圖定位',
    'aria-label': '在地圖定位',
    onclick: (e) => { e.stopPropagation(); select(p.id); },
  }, iconEl(ICON.locate));

  const item = el('div', {
    class: 'list-item' + (p.id === state.selectedId ? ' active' : ''),
    dataset: { id: p.id },
    onclick: () => select(p.id),
  },
    thumb(p),
    el('div', { class: 'li-body' },
      el('div', { class: 'li-title' }, p.name?.zh || p.name?.local || '(未命名)'),
      el('div', { class: 'li-sub' }, subParts.join(' · ')),
    ),
    el('div', { class: 'li-actions' }, favBtn, delBtn, locateBtn, daySelect(p)),
  );
  return item;
}

/** 由列表發出選取:寫 selectedId、emit、手機關閉側欄 */
function select(id) {
  state.selectedId = id;
  emit('select', { id, source: 'list' });
  if (isMobile()) closeSidebar();
}

function render() {
  const listEl = $('#poi-list');
  const countEl = $('#poi-count');
  if (!listEl) return;

  const scrollTop = listEl.scrollTop;
  const all = store.getPois();
  const shown = applyFilters(all).sort((a, b) =>
    (a.tier - b.tier) || (a.name?.zh || '').localeCompare(b.name?.zh || '', 'zh-Hant'));

  const frag = document.createDocumentFragment();
  if (shown.length === 0) {
    frag.append(el('div', { class: 'muted', style: { padding: '24px 16px', textAlign: 'center' } },
      '沒有符合條件的景點'));
  } else {
    for (const p of shown) frag.append(listItem(p));
  }
  listEl.textContent = '';
  listEl.append(frag);
  listEl.scrollTop = scrollTop;

  if (countEl) countEl.textContent = `顯示 ${shown.length} / 共 ${all.length}`;
}

/** 高亮某項(doScroll 時捲入視野) */
function highlight(id, doScroll) {
  const listEl = $('#poi-list');
  if (!listEl) return;
  $$('.list-item', listEl).forEach((n) => n.classList.toggle('active', n.dataset.id === id));
  if (doScroll && id) {
    const node = listEl.querySelector(`.list-item[data-id="${CSS.escape(id)}"]`);
    if (node) node.scrollIntoView({ block: 'nearest' });
  }
}

export function init() {
  // ---- Tab 切換 ----
  const tabs = $('#sidebar-tabs');
  if (tabs) {
    tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-tab]');
      if (!btn) return;
      const tab = btn.dataset.tab;
      if (tab === state.activeTab) return;
      state.activeTab = tab;
      $$('#sidebar-tabs button').forEach((b) => b.classList.toggle('active', b === btn));
      ['pois', 'days', 'routes', 'trash'].forEach((t) => {
        const pane = document.getElementById(`tab-${t}`);
        if (pane) pane.classList.toggle('active', t === tab);
      });
      emit('tab:changed', tab);
    });
  }

  // ---- 手機漢堡 ----
  const burger = $('#btn-sidebar');
  if (burger) burger.addEventListener('click', () => document.body.classList.toggle('sidebar-open'));

  // ---- 重繪觸發 ----
  on('pois:ready', render);
  on('overlay:changed', render);
  on('filter:changed', render);

  // ---- 選取高亮(非列表來源才捲動) ----
  on('select', ({ id, source }) => {
    if (source === 'list') { highlight(id, false); return; }
    highlight(id, true);
  });

  render();
}
