// filters.js — 篩選列 UI + 純函式 applyFilters(F3 擁有)
// 合約見 docs/CONTRACTS.md:state.filters 由本模組寫入,變更後 emit('filter:changed')。
import { state, emit, on } from './state.js';
import { $, el, debounce } from './dom.js';
import { CATEGORIES, TIER_LABELS, COUNTRY_LABELS } from './config.js';
import * as store from './store.js';

const STATUS_OPTIONS = [
  { v: 'active', label: '未刪除' },
  { v: 'favorite', label: '已收藏' },
  { v: 'undecided', label: '未決定' },
  { v: 'all', label: '全部' },
];

let citySelect = null;
let catsExpanded = false; // 分類 chips 展開狀態(跨 render 保存)

/** 依目前選定國家彙整城市清單 */
function citiesForCountry(country) {
  const set = new Set();
  for (const p of store.getPois()) {
    if (p._status === 'deleted') continue;
    if (country && p.country !== country) continue;
    if (p.city) set.add(p.city);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function rebuildCities() {
  if (!citySelect) return;
  const cur = state.filters.city;
  const cities = citiesForCountry(state.filters.country);
  citySelect.textContent = '';
  citySelect.append(el('option', { value: '' }, '全部城市'));
  for (const c of cities) citySelect.append(el('option', { value: c }, c));
  // 若原選城市已不在清單則清掉
  if (cur && !cities.includes(cur)) state.filters.city = null;
  citySelect.value = state.filters.city || '';
}

function chip(label, { on: isOn, color, glyph, onClick }) {
  // 中性 chip(國家/tier/狀態)無分類色 → 選中時用主色高亮
  const c = color || 'var(--primary)';
  // 自訂屬性 --c 需以字串 style 傳入(el 會 setAttribute,物件 Object.assign 無法設定 custom property)
  const attrs = { class: 'chip toggle' + (isOn ? ' on' : ''), onclick: onClick, style: `--c:${c}` };
  const kids = [];
  if (glyph) kids.push(el('span', { class: 'chip-glyph' }, glyph));
  kids.push(label);
  return el('button', attrs, ...kids);
}

export function init() {
  const bar = $('#filter-bar');
  if (!bar) return;

  const render = () => {
    const f = state.filters;
    bar.textContent = '';

    // ---- 國家 ----
    const countryGroup = el('div', { class: 'filter-group' },
      el('span', { class: 'filter-label' }, '國家'),
      chip('全部', { on: f.country == null, onClick: () => setCountry(null) }),
      chip(COUNTRY_LABELS.SE, { on: f.country === 'SE', onClick: () => setCountry('SE') }),
      chip(COUNTRY_LABELS.DK, { on: f.country === 'DK', onClick: () => setCountry('DK') }),
    );

    // ---- 分類(13 類,可摺疊) ----
    const cats = el('div', { class: 'filter-cats' + (catsExpanded ? '' : ' collapsed') });
    for (const [key, c] of Object.entries(CATEGORIES)) {
      cats.append(chip(c.zh, {
        on: f.categories.includes(key),
        color: c.color,
        glyph: c.glyph,
        onClick: () => toggleIn('categories', key),
      }));
    }
    const moreBtn = el('button', { class: 'filter-more' }, catsExpanded ? '收合分類 ▴' : '展開分類 ▾');
    moreBtn.addEventListener('click', () => {
      catsExpanded = !catsExpanded;
      cats.classList.toggle('collapsed', !catsExpanded);
      moreBtn.textContent = catsExpanded ? '收合分類 ▴' : '展開分類 ▾';
    });
    const catGroup = el('div', { class: 'filter-group', style: { display: 'block' } },
      el('div', { style: { marginBottom: '6px' } },
        el('span', { class: 'filter-label' }, '分類')),
      cats, moreBtn,
    );

    // ---- 等級 ----
    const tierGroup = el('div', { class: 'filter-group' },
      el('span', { class: 'filter-label' }, '等級'),
      ...[1, 2, 3].map((t) => chip(`${t} ${TIER_LABELS[t]}`, {
        on: f.tiers.includes(t),
        onClick: () => toggleIn('tiers', t),
      })),
    );

    // ---- 狀態 + 城市 + 清除 ----
    const statusSel = el('select', { class: 'filter-select' },
      ...STATUS_OPTIONS.map((o) => el('option', { value: o.v }, o.label)));
    statusSel.value = f.status;
    statusSel.addEventListener('change', () => {
      state.filters.status = statusSel.value;
      changed();
    });

    citySelect = el('select', { class: 'filter-select' });
    citySelect.addEventListener('change', () => {
      state.filters.city = citySelect.value || null;
      changed();
    });

    const clearBtn = el('button', { class: 'filter-clear', onclick: clearAll }, '清除篩選');

    const bottomGroup = el('div', { class: 'filter-row' },
      el('span', { class: 'filter-label' }, '狀態'), statusSel,
      el('span', { class: 'filter-label' }, '城市'), citySelect,
      clearBtn,
    );

    bar.append(countryGroup, catGroup, tierGroup, bottomGroup);
    rebuildCities();
  };

  // ---- 事件處理 ----
  function setCountry(v) {
    state.filters.country = v;
    // 城市清單依國家過濾,重建並校正
    rebuildCities();
    changed(true);
  }
  function toggleIn(field, value) {
    const arr = state.filters[field];
    const i = arr.indexOf(value);
    if (i >= 0) arr.splice(i, 1); else arr.push(value);
    changed(true);
  }
  function clearAll() {
    Object.assign(state.filters, {
      q: '', country: null, region: null, city: null,
      categories: [], tiers: [], status: 'active',
    });
    const si = $('#search-input');
    if (si) si.value = '';
    render();
    emit('filter:changed');
  }
  // rerender=true 時重繪 chips 以更新 on 狀態
  function changed(rerender) {
    if (rerender) render();
    emit('filter:changed');
  }

  render();

  // 搜尋框(debounce 250ms)
  const si = $('#search-input');
  if (si) {
    si.value = state.filters.q || '';
    const onInput = debounce(() => {
      state.filters.q = si.value.trim();
      emit('filter:changed');
    }, 250);
    si.addEventListener('input', onInput);
  }

  // 資料變更時更新城市清單(新增自訂點/匯入/重設可能帶入新城市)
  on('pois:ready', rebuildCities);
  on('overlay:changed', (p) => {
    if (p && ['custom', 'import', 'reset'].includes(p.type)) rebuildCities();
  });
}

/** 純函式:依 state.filters 篩選 POI 陣列 */
export function applyFilters(pois) {
  const f = state.filters;
  const q = (f.q || '').trim().toLowerCase();
  return pois.filter((p) => {
    // 狀態
    switch (f.status) {
      case 'favorite': if (p._status !== 'favorite') return false; break;
      case 'undecided': if (p._status === 'deleted' || p._status === 'favorite') return false; break;
      case 'all': break;
      case 'active':
      default: if (p._status === 'deleted') return false; break;
    }
    if (f.country && p.country !== f.country) return false;
    if (f.region && p.region !== f.region) return false;
    if (f.city && p.city !== f.city) return false;
    if (f.categories.length && !f.categories.includes(p.category)) return false;
    if (f.tiers.length && !f.tiers.includes(p.tier)) return false;
    if (q) {
      const hay = [p.name?.zh, p.name?.local, p.name?.en, p.city]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
