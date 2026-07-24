// popup.js — 地圖 marker 迷你卡 HTML 與事件委派(合約見 docs/CONTRACTS.md)
// 左鍵開卡片已於 F1 改版廢用;模組保留給路線 / 其他 popup 情境使用。
import { state, emit } from './state.js';
import * as store from './store.js';
import { escapeHtml, toast } from './dom.js';
import { CATEGORIES, TIER_LABELS, fmtStay } from './config.js';
import { ICON } from './icons.js';

/**
 * 產生 marker 迷你卡 HTML。所有文字經 escapeHtml,避免 XSS。
 * 圖片:_images[0](已由 config.commonsImg 組好);idb: 開頭者於此略過,交由詳情面板處理。
 */
export function buildPopupHtml(poi) {
  const cat = CATEGORIES[poi.category] || { color: '#888', glyph: '📍', zh: '' };
  const img = (poi._images || []).find((u) => u && !u.startsWith('idb:'));
  const color = escapeHtml(cat.color || '#888');
  const media = img
    ? `<div class="pp-media" style="background:${color}">` +
      `<img src="${escapeHtml(img)}" alt="" loading="lazy" onerror="this.remove()"></div>`
    : `<div class="pp-media pp-media-ph" style="background:${color}">` +
      `<span>${cat.glyph || '📍'}</span></div>`;

  const zh = escapeHtml(poi.name?.zh || poi.name?.local || '未命名');
  const local = poi.name?.local && poi.name.local !== poi.name?.zh
    ? `<span class="pp-local">${escapeHtml(poi.name.local)}</span>` : '';
  const catChip = cat.zh
    ? `<span class="chip pp-chip" style="--c:${color}">${cat.glyph || ''} ${escapeHtml(cat.zh)}</span>` : '';
  const tier = TIER_LABELS[poi.tier]
    ? `<span class="pp-tier">${escapeHtml(TIER_LABELS[poi.tier])}</span>` : '';
  const stay = fmtStay(poi.stay_min, poi.stay_max);
  const stayEl = stay ? `<span class="pp-stay">${escapeHtml(stay)}</span>` : '';

  const isFav = poi._status === 'favorite';
  const favIcon = isFav ? ICON.starFill : ICON.star;
  const favLabel = isFav ? '取消收藏' : '收藏';
  const favCls = isFav ? ' is-on' : '';

  return (
    `<div class="poi-popup" data-id="${escapeHtml(poi.id)}">` +
      media +
      `<div class="pp-body">` +
        `<div class="pp-title">${zh}${local}</div>` +
        `<div class="pp-meta">${catChip}${tier}${stayEl}</div>` +
      `</div>` +
      `<div class="pp-actions">` +
        `<button type="button" class="btn pp-btn" data-act="detail">詳情</button>` +
        `<button type="button" class="btn pp-btn pp-fav${favCls}" data-act="fav">${favIcon}<span>${favLabel}</span></button>` +
        `<button type="button" class="btn pp-btn pp-del" data-act="del">${ICON.trash}<span>刪除</span></button>` +
      `</div>` +
    `</div>`
  );
}

/** 以事件委派綁定 popup 內的三鍵;popup 每次開啟都是新 DOM,故於 popupopen 綁定不會洩漏 */
export function bindPopupEvents(map) {
  map.on('popupopen', (e) => {
    const elRoot = e.popup.getElement && e.popup.getElement();
    const root = elRoot && elRoot.querySelector('.poi-popup');
    if (!root) return;
    const id = root.dataset.id;
    root.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-act]');
      if (!btn) return;
      ev.stopPropagation();
      const act = btn.dataset.act;
      if (act === 'detail') {
        state.selectedId = id;
        emit('select', { id, source: 'map' });
      } else if (act === 'fav') {
        const p = store.getPoi(id);
        store.setStatus(id, p && p._status === 'favorite' ? null : 'favorite');
      } else if (act === 'del') {
        store.setStatus(id, 'deleted');
        map.closePopup();
        // 補清選取:避免詳情/清單依 selectedId 重開已刪 POI
        state.selectedId = null;
        emit('select', { id: null, source: 'map' });
        toast('已移入回收站');
      }
    });
  });
}
