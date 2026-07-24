// config.js — 全域常數(Phase 0 凍結)

export const TRIP_DAYS = [
  '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07',
  '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11',
  '2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15',
];

// 與 css/tokens.css 的 --day-N 一致
export const DAY_COLORS = [
  '#e6194b', '#f58231', '#d9a400', '#3cb44b',
  '#00a86b', '#17a2b8', '#4363d8', '#7b5be6',
  '#911eb4', '#f032e6', '#a0522d', '#556b2f',
];

const WEEKDAYS_ZH = ['日', '一', '二', '三', '四', '五', '六'];

/** '2026-09-04' -> '9/4(五)' */
export function dayLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const wd = WEEKDAYS_ZH[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}/${d}(${wd})`;
}

export function dayColor(iso) {
  const i = TRIP_DAYS.indexOf(iso);
  return i >= 0 ? DAY_COLORS[i] : '#888888';
}

export const CATEGORIES = {
  castle:    { zh: '城堡宮殿', glyph: '🏰', color: '#8e44ad' },
  church:    { zh: '教堂',     glyph: '⛪', color: '#7f8c8d' },
  museum:    { zh: '博物館',   glyph: '🏛️', color: '#c0392b' },
  oldtown:   { zh: '老城街區', glyph: '🏘️', color: '#d35400' },
  landmark:  { zh: '現代地標', glyph: '🗼', color: '#2c3e50' },
  nature:    { zh: '自然景觀', glyph: '🏞️', color: '#27ae60' },
  park:      { zh: '公園花園', glyph: '🌳', color: '#16a085' },
  coast:     { zh: '海岸燈塔', glyph: '🌊', color: '#2980b9' },
  history:   { zh: '歷史遺跡', glyph: '🗿', color: '#795548' },
  themepark: { zh: '樂園親子', glyph: '🎡', color: '#e91e63' },
  market:    { zh: '市場美食', glyph: '🍽️', color: '#f39c12' },
  experience:{ zh: '體驗活動', glyph: '🎯', color: '#00838f' },
  transport: { zh: '交通樞紐', glyph: '🚉', color: '#455a64' },
};

export const TIER_LABELS = { 1: '地標必看', 2: '主要景點', 3: '小眾順路' };

export const COUNTRY_LABELS = { SE: '瑞典', DK: '丹麥' };

export const BASE_LAYERS = {
  'carto-voyager': {
    name: '街道(預設)',
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    options: {
      maxZoom: 20, subdomains: 'abcd',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    },
  },
  'carto-positron': {
    name: '淺色',
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}{r}.png',
    options: {
      maxZoom: 20, subdomains: 'abcd',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    },
  },
  'osm': {
    name: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  },
};

export const ROUTE_COLORS = [
  '#e6194b', '#4363d8', '#3cb44b', '#f58231', '#911eb4', '#17a2b8',
  '#f032e6', '#a0522d', '#556b2f', '#7b5be6', '#d9a400', '#00a86b',
];

export const MAP_CENTER = [55.605, 13.0]; // Malmö
export const MAP_ZOOM = 9;

export const STORAGE_KEY = 'sweden2026:userdata:v1';
export const DB_NAME = 'sweden2026';
export const DB_IMAGE_STORE = 'images';

/** Wikimedia Commons 檔名 → 穩定縮圖 URL(官方允許的 hotlink 格式) */
export function commonsImg(file, width = 480) {
  return `https://commons.wikimedia.org/w/index.php?title=Special:Redirect/file/${encodeURIComponent(file)}&width=${width}`;
}

/** Commons 檔案描述頁(attribution 連結) */
export function commonsPage(file) {
  return `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file)}`;
}
