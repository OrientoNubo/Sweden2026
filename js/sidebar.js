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
  return CATEGORIES[cat] || { zh: cat || '其他', glyph: '📍', color: '#888' };
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
    'aria-label': '指派日期',
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

  const name = p.name?.zh || p.name?.local || '(未命名)';
  const item = el('div', {
    class: 'list-item' + (p.id === state.selectedId ? ' active' : ''),
    dataset: { id: p.id },
    tabindex: '0',
    role: 'button',
    'aria-label': `查看「${name}」詳情`,
    onclick: () => select(p.id),
    // 列主體為單一可聚焦點(Enter/Space 開啟詳情);li-actions 內按鈕自帶 tab 與鍵盤啟用。
    // e.target !== currentTarget 時放行給內層按鈕自理,避免其鍵盤事件冒泡到此重複觸發。
    onkeydown: (e) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(p.id); }
    },
  },
    thumb(p),
    el('div', { class: 'li-body' },
      el('div', { class: 'li-title' }, name),
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

function computeShown() {
  const all = store.getPois();
  const shown = applyFilters(all).sort((a, b) =>
    (a.tier - b.tier) || (a.name?.zh || '').localeCompare(b.name?.zh || '', 'zh-Hant'));
  return { all, shown };
}

function updateCount(shownLen, allLen) {
  const countEl = $('#poi-count');
  if (countEl) countEl.textContent = `顯示 ${shownLen} / 共 ${allLen}`;
}

function render() {
  const listEl = $('#poi-list');
  if (!listEl) return;

  const scrollTop = listEl.scrollTop;
  const { all, shown } = computeShown();

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

  updateCount(shown.length, all.length);
}

/** 增量更新:僅當篩選後的成員與排序完全不變時,就地重建受影響的 [data-id] 列
 *  (收藏星、狀態、日期 select 值等一次到位),避免每次 mutation 重建整份列表。
 *  回傳 true=已增量處理;false=成員/順序有變動,需交回 render() 全量重繪。 */
function patchRows(ids) {
  const listEl = $('#poi-list');
  if (!listEl) return false;

  const { all, shown } = computeShown();
  const domRows = $$('.list-item', listEl);
  if (domRows.length !== shown.length) return false;         // 成員數變動 → 全量
  for (let i = 0; i < shown.length; i++) {
    if (domRows[i].dataset.id !== shown[i].id) return false;  // 順序變動 → 全量
  }

  const byId = new Map(shown.map((p) => [p.id, p]));
  for (const id of ids) {
    const p = byId.get(id);
    if (!p) continue;                        // 非本列表項目(如 route/settings 的 id)
    const old = listEl.querySelector(`.list-item[data-id="${CSS.escape(id)}"]`);
    if (old) old.replaceWith(listItem(p));   // listItem 依 state.selectedId 自帶 active
  }
  updateCount(shown.length, all.length);
  return true;
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
    // ARIA tabs 模式(index.html 不可改,一律 JS 補上)
    tabs.setAttribute('role', 'tablist');
    const tabBtns = $$('#sidebar-tabs button');
    tabBtns.forEach((b) => {
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(b.classList.contains('active')));
    });
    tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-tab]');
      if (!btn) return;
      const tab = btn.dataset.tab;
      if (tab === state.activeTab) return;
      state.activeTab = tab;
      tabBtns.forEach((b) => {
        const on = b === btn;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', String(on));
      });
      ['pois', 'days', 'routes', 'trash'].forEach((t) => {
        const pane = document.getElementById(`tab-${t}`);
        if (pane) pane.classList.toggle('active', t === tab);
      });
      emit('tab:changed', tab);
    });
  }

  // ---- 手機漢堡 + 背景遮罩 ----
  const burger = $('#btn-sidebar');
  if (burger) burger.addEventListener('click', () => document.body.classList.toggle('sidebar-open'));

  // 手機側欄背景遮罩(桌機由 CSS 隱藏);點擊或 Esc 關閉。比照 detail-scrim 為真實元素。
  const scrim = el('div', { class: 'sidebar-scrim', 'aria-hidden': 'true', onclick: closeSidebar });
  document.body.appendChild(scrim);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !document.body.classList.contains('sidebar-open')) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) { t.blur(); return; }
    closeSidebar();
  });

  // ---- 重繪觸發 ----
  on('pois:ready', render);
  // overlay:changed 帶 ids 且非成員變動類(custom/import/reset)→ 嘗試增量更新;失敗才全量重繪
  on('overlay:changed', (payload) => {
    const ids = payload && payload.ids;
    const type = payload && payload.type;
    if (Array.isArray(ids) && ids.length && type !== 'custom' && type !== 'import' && type !== 'reset') {
      if (patchRows(ids)) return;
    }
    render();
  });
  on('filter:changed', render);

  // ---- 選取高亮(非列表來源才捲動) ----
  on('select', ({ id, source }) => {
    if (source === 'list') { highlight(id, false); return; }
    highlight(id, true);
  });

  // 詳情面板關閉時,若觸發列已因重繪移除,焦點退回此容器(見 detail.js)。
  // tabindex=-1:僅接受程式化 focus,不進 Tab 序。
  const poiList = $('#poi-list');
  if (poiList) poiList.tabIndex = -1;

  render();
}
