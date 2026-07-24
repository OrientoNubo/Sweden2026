// markers.js — 純函式:產生 POI marker / cluster 的 L.divIcon(合約見 docs/CONTRACTS.md)
import { state } from './state.js';
import { CATEGORIES, dayColor } from './config.js';
import { escapeHtml } from './dom.js';
import { ICON } from './icons.js';

const L = window.L;

const ICON_SIZE = 30;
const FAV_SIZE = 36;           // 收藏星形略大於一般 pin

/**
 * 依 POI 與情境產生 marker 圖示。
 * ctx.mode: 'curate'(預設,分類色圓+glyph) | 'itinerary'(day 色圓+序號)
 */
export function buildIcon(poi, ctx = {}) {
  const selected = poi.id === state.selectedId;
  const selCls = selected ? ' mk-sel' : '';

  if (ctx.mode === 'itinerary') {
    const color = dayColor(poi._day);
    const n = (poi._order ?? 0) + 1;
    const html = `<div class="mk mk-day${selCls}" style="--mk:${escapeHtml(color)}">${n}</div>`;
    return L.divIcon({
      html,
      className: 'mk-wrap',
      iconSize: [ICON_SIZE, ICON_SIZE],
      iconAnchor: [ICON_SIZE / 2, ICON_SIZE / 2],
      popupAnchor: [0, -ICON_SIZE / 2 - 4],
      tooltipAnchor: [0, -ICON_SIZE / 2 - 4],
    });
  }

  const cat = CATEGORIES[poi.category] || { color: '#888', glyph: '📍' };
  const customCls = poi._custom ? ' mk-custom' : '';
  const star = poi._status === 'favorite' ? '<span class="mk-star">⭐</span>' : '';
  const html =
    `<div class="mk mk-poi${selCls}${customCls}" style="--mk:${escapeHtml(cat.color)}">` +
    `<span class="mk-glyph">${cat.glyph || '📍'}</span>${star}</div>`;
  return L.divIcon({
    html,
    className: 'mk-wrap',
    iconSize: [ICON_SIZE, ICON_SIZE],
    iconAnchor: [ICON_SIZE / 2, ICON_SIZE / 2],
    popupAnchor: [0, -ICON_SIZE / 2 - 4],
    tooltipAnchor: [0, -ICON_SIZE / 2 - 4],
  });
}

/**
 * 收藏(_status==='favorite')恆顯星形 marker。
 * 金色填充(--star)+ 描邊(CSS paint-order)確保淺/深主題皆可讀;點擊行為與一般 marker 相同。
 */
export function buildFavoriteIcon(poi) {
  const selected = poi.id === state.selectedId;
  const selCls = selected ? ' mk-sel' : '';
  const html = `<div class="mk-fav${selCls}">${ICON.starFill}</div>`;
  return L.divIcon({
    html,
    className: 'mk-wrap',
    iconSize: [FAV_SIZE, FAV_SIZE],
    iconAnchor: [FAV_SIZE / 2, FAV_SIZE / 2],
    popupAnchor: [0, -FAV_SIZE / 2 - 4],
    tooltipAnchor: [0, -FAV_SIZE / 2 - 4],
  });
}

/** markerClusterGroup 的 iconCreateFunction:數量分級的數字圓 */
export function clusterIcon(cluster) {
  const n = cluster.getChildCount();
  let size = 'sm';
  if (n >= 100) size = 'lg';
  else if (n >= 25) size = 'md';
  const label = n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
  return L.divIcon({
    html: `<div class="cl cl-${size}"><span>${label}</span></div>`,
    className: 'cl-wrap',
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  });
}
