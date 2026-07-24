// mapview.js — 地圖核心:底圖、marker/cluster、行程圖層、自訂路線、互動(合約見 docs/CONTRACTS.md)
import { state, on, emit } from './state.js';
import * as store from './store.js';
import { debounce, escapeHtml, toast } from './dom.js';
import { BASE_LAYERS, MAP_CENTER, MAP_ZOOM, dayColor, CATEGORIES, ROUTE_COLORS } from './config.js';
import { routeDistance, fmtDistance, fmtDuration } from './geo.js';
import { buildIcon, buildFavoriteIcon, clusterIcon } from './markers.js';
import { bindPopupEvents } from './popup.js';
import { ICON } from './icons.js';

const L = window.L;

const TOOLTIP_ZOOM = 14;       // 此縮放以上開 permanent tooltip(對齊 disableClusteringAtZoom)
const TOOLTIP_MAX = 150;       // 視窗內 tooltip 超過此數只留 tier 1–2
const FLY_MIN_ZOOM = 14;       // select 定位時的最小縮放
const STAR_COLOR = '#f5b301';  // = tokens --star,淺/深主題皆可讀(circleMarker canvas 不能用 var())
const DEFAULT_ROUTE_COLOR = ROUTE_COLORS[1]; // 藍;F4 建立路線通常已帶色,此為 fallback

let map = null;
let clusterGroup = null;       // 整理模式(非收藏點)
let favoriteLayer = null;      // 整理模式:收藏點恆顯層(不 cluster)
let itineraryLayer = null;     // 行程模式(marker+polyline+favorite dots)
let routeLayer = null;         // 自訂路線
const markerById = new Map();  // 目前模式下 id -> 主要 marker(供 flyTo/選取高亮/focus)
const routeLines = new Map();  // routeId -> polyline
const baseKeyByName = {};      // 圖層顯示名 -> BASE_LAYERS 的 key
const baseLayerObjs = {};      // BASE_LAYERS 的 key -> L.tileLayer 實例
let layersCtl = null;
let userPickedBase = false;    // 使用者本 session 是否手動換過底圖
let autoSwitching = false;     // 自動聯動底圖中,避免 baselayerchange 誤判為手動
let hiddenDrawRouteId = null;  // 繪製中、暫時隱藏的常規路線
let lastSelected = null;
let placeChipPopup = null;     // 新增景點確認 chip
let locateMarker = null;       // 定位結果 marker
const legendItems = [];        // 分類圖例的按鈕(供 active 狀態同步)
let legendEl = null;           // 圖例容器(供 mode 切換停用/恢復)

const isDesktop = () => window.matchMedia('(min-width: 769px)').matches;
const prefersReducedMotion = () =>
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const poiLabel = (poi) => poi.name?.zh || poi.name?.local || poi.name?.en || '';
const cssVar = (name, fallback) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

// 尊重減少動態偏好:reduced-motion 時瞬移(不做飛行動畫)
function panTo(latlng, zoom) {
  if (prefersReducedMotion()) map.setView(latlng, zoom, { animate: false });
  else map.flyTo(latlng, zoom);
}

// ── 篩選 predicate(對 state.filters;規則以 CONTRACTS 為準,為 curate 模式唯一真值來源) ──
function textMatch(poi, q) {
  const s = (q || '').trim().toLowerCase();
  if (!s) return true;
  const hay = [poi.name?.zh, poi.name?.local, poi.name?.en, poi.city]
    .filter(Boolean).join(' ').toLowerCase();
  return hay.includes(s);
}

function passesFilter(poi) {
  const f = state.filters;
  switch (f.status) {
    case 'favorite': if (poi._status !== 'favorite') return false; break;
    case 'undecided': if (poi._status === 'deleted' || poi._status === 'favorite') return false; break;
    case 'all': break;
    case 'active':
    default: if (poi._status === 'deleted') return false; break;
  }
  if (f.country && poi.country !== f.country) return false;
  if (f.region && poi.region !== f.region) return false;
  if (f.city && poi.city !== f.city) return false;
  if (f.categories?.length && !f.categories.includes(poi.category)) return false;
  if (f.tiers?.length && !f.tiers.includes(poi.tier)) return false;
  if (!textMatch(poi, f.q)) return false;
  return true;
}

// ── marker 建立與互動 ──
// 桌機/手機統一:marker click 只發 select（不再左鍵開 popup;popup 模組保留給路線/其他用途）
function bindMarkerInteractions(marker, poi) {
  marker._poi = poi;
  marker.on('click', () => {
    if (state.uiMode === 'draw') return;
    state.selectedId = poi.id;
    emit('select', { id: poi.id, source: 'map' });
  });
}

function makePoiMarker(poi, mode) {
  // title/alt:給滑鼠 hover 原生提示與螢幕閱讀器可讀名稱(divIcon 無 <img>,alt 由 Leaflet 掛在容器上)
  const label = poiLabel(poi);
  const m = L.marker([poi.lat, poi.lng], {
    icon: buildIcon(poi, { mode }), title: label, alt: label, keyboard: true,
  });
  bindMarkerInteractions(m, poi);
  return m;
}

function makeFavoriteMarker(poi) {
  // zIndexOffset:1000 → 恆顯星形永遠疊在 cluster 泡泡之上(低 zoom 兩者重疊時,
  // Leaflet 的 pane z-index = 螢幕 y + offset;重疊點 y 差僅 ~icon 尺寸,offset 1000 必勝)
  const label = poiLabel(poi);
  const m = L.marker([poi.lat, poi.lng], {
    icon: buildFavoriteIcon(poi), zIndexOffset: 1000, title: label, alt: label, keyboard: true,
  });
  m._fav = true;
  bindMarkerInteractions(m, poi);
  return m;
}

// ── 圖層渲染 ──
function clearItinerary() {
  if (itineraryLayer) {
    itineraryLayer.clearLayers();
    if (map.hasLayer(itineraryLayer)) map.removeLayer(itineraryLayer);
  }
}

function renderCurate() {
  clearItinerary();
  markerById.clear();
  clusterGroup.clearLayers();
  favoriteLayer.clearLayers();
  const clustered = [];
  for (const poi of store.getPois()) {
    if (!passesFilter(poi)) continue;
    if (poi._status === 'favorite') {
      // 收藏點:不進 cluster,任何 zoom 恆顯
      const m = makeFavoriteMarker(poi);
      m.addTo(favoriteLayer);
      markerById.set(poi.id, m);
    } else {
      const m = makePoiMarker(poi, 'curate');
      clustered.push(m);
      markerById.set(poi.id, m);
    }
  }
  clusterGroup.addLayers(clustered);
  if (!map.hasLayer(clusterGroup)) map.addLayer(clusterGroup);
  if (!map.hasLayer(favoriteLayer)) map.addLayer(favoriteLayer);
}

// ── 增量更新(僅 curate 模式):只重建/搬移受影響的單一 marker,避免整批重繪 ──
function removeCurateMarker(m) {
  if (m._fav) favoriteLayer.removeLayer(m);
  else clusterGroup.removeLayer(m);
}
function addCurateMarker(poi) {
  if (poi._status === 'favorite') {
    const m = makeFavoriteMarker(poi);
    m.addTo(favoriteLayer);
    markerById.set(poi.id, m);
  } else {
    const m = makePoiMarker(poi, 'curate');
    clusterGroup.addLayer(m);
    markerById.set(poi.id, m);
  }
}
// 依 store 最新資料把單一 id 的 marker 對齊到應有狀態(顯示/隱藏、收藏星形↔一般 pin、圖示/名稱)
function reconcileCurate(id, type) {
  const poi = store.getPoi(id);
  const existing = markerById.get(id);
  const shouldShow = !!poi && passesFilter(poi);
  if (!shouldShow) {
    if (existing) { removeCurateMarker(existing); markerById.delete(id); }
    return;
  }
  const wantFav = poi._status === 'favorite';
  // patch / 備註:座標與型別未變 → 原地更新圖示與(已顯示的)tooltip 文字;
  // custom(可能改座標/分類)與收藏切換(型別變)→ 重建以確保 cluster 位置與圖層正確。
  if (type !== 'custom' && existing && (!!existing._fav === wantFav)) {
    existing._poi = poi;
    existing.setIcon(iconForMarker(existing));
    if (existing.getTooltip && existing.getTooltip()) {
      existing.setTooltipContent(escapeHtml(poi.name?.zh || poi.name?.local || ''));
    }
    return;
  }
  if (existing) { removeCurateMarker(existing); markerById.delete(id); }
  addCurateMarker(poi);
}

function renderItinerary() {
  if (map.hasLayer(clusterGroup)) map.removeLayer(clusterGroup);
  if (map.hasLayer(favoriteLayer)) map.removeLayer(favoriteLayer);
  clusterGroup.clearLayers();
  favoriteLayer.clearLayers();
  itineraryLayer.clearLayers();
  markerById.clear();

  const pois = store.getPois();
  const byDay = new Map();
  for (const poi of pois) {
    if (!poi._day || poi._status === 'deleted') continue;
    if (state.dayVisibility[poi._day] === false) continue;
    if (!byDay.has(poi._day)) byDay.set(poi._day, []);
    byDay.get(poi._day).push(poi);
  }
  for (const [day, arr] of byDay) {
    arr.sort((a, b) => (a._order ?? 0) - (b._order ?? 0));
    if (arr.length >= 2) {
      L.polyline(arr.map((p) => [p.lat, p.lng]), {
        color: dayColor(day), dashArray: '6 6', weight: 3, opacity: 0.9,
      }).addTo(itineraryLayer);
    }
    for (const poi of arr) {
      const m = makePoiMarker(poi, 'itinerary');
      m.addTo(itineraryLayer);
      markerById.set(poi.id, m);
    }
  }
  // favorite 未排程點:半透明小圓點(可點;白描邊 + 金填充於淺/深主題皆可讀)
  for (const poi of pois) {
    if (poi._day || poi._status !== 'favorite') continue;
    const dot = L.circleMarker([poi.lat, poi.lng], {
      radius: 5, weight: 1, color: '#fff', fillColor: STAR_COLOR, fillOpacity: 0.6, opacity: 0.7,
    });
    dot._noTip = true;
    bindMarkerInteractions(dot, poi);
    dot.addTo(itineraryLayer);
    if (!markerById.has(poi.id)) markerById.set(poi.id, dot);
  }
  if (!map.hasLayer(itineraryLayer)) map.addLayer(itineraryLayer);
}

function renderPois() {
  if (state.viewMode === 'itinerary') renderItinerary();
  else renderCurate();
  lastSelected = state.selectedId;
  updateTooltipsDebounced();
}

function renderRoutes() {
  routeLayer.clearLayers();
  routeLines.clear();
  for (const r of store.getRoutes()) {
    if (r.visible === false) continue;
    if (hiddenDrawRouteId && r.id === hiddenDrawRouteId) continue;
    if (!r.waypoints || r.waypoints.length < 2) continue;
    const routed = r.mode && r.mode !== 'straight'
      && Array.isArray(r.geometry) && r.geometry.length > 1;
    const line = L.polyline(routed ? r.geometry : r.waypoints, {
      color: r.color || DEFAULT_ROUTE_COLOR, weight: 4, opacity: 0.85,
    });
    line.on('click', (e) => {
      if (state.uiMode === 'draw') return;
      const info = routed
        ? `${fmtDistance(r.road_distance)} · 約 ${fmtDuration(r.road_duration)}`
        : fmtDistance(routeDistance(r.waypoints));
      L.popup({ className: 'route-pop-wrap' })
        .setLatLng(e.latlng)
        .setContent(
          `<div class="route-pop"><b>${escapeHtml(r.name || '自訂路線')}</b>` +
          `<span class="muted">${escapeHtml(info)}</span></div>`)
        .openOn(map);
    });
    line.addTo(routeLayer);
    routeLines.set(r.id, line);
  }
}

// ── permanent tooltip(zoom≥14;視窗內超過上限時只顯示 tier 1–2) ──
function updateTooltips() {
  if (!map) return;
  const z = map.getZoom();
  const markers = [...markerById.values()].filter((m) => !m._noTip && typeof m.bindTooltip === 'function');
  if (z < TOOLTIP_ZOOM) {
    for (const m of markers) if (m.getTooltip && m.getTooltip()) m.unbindTooltip();
    return;
  }
  const bounds = map.getBounds();
  const inView = markers.filter((m) => bounds.contains(m.getLatLng()));
  const tierLimit = inView.length > TOOLTIP_MAX ? 2 : Infinity;
  for (const m of markers) {
    const poi = m._poi;
    const wants = bounds.contains(m.getLatLng()) && (poi?.tier ?? 99) <= tierLimit;
    const has = m.getTooltip && m.getTooltip();
    if (wants && !has) {
      m.bindTooltip(escapeHtml(poi.name?.zh || poi.name?.local || ''), {
        permanent: true, direction: 'top', className: 'poi-tip', opacity: 1,
      });
    } else if (!wants && has) {
      m.unbindTooltip();
    }
  }
}
const updateTooltipsDebounced = debounce(updateTooltips, 160);

// ── 選取高亮:只更新受影響的兩個 marker 圖示 ──
function iconForMarker(m) {
  return m._fav ? buildFavoriteIcon(m._poi) : buildIcon(m._poi, { mode: state.viewMode });
}
function refreshSelection() {
  const cur = state.selectedId;
  if (cur === lastSelected) return;
  for (const id of [lastSelected, cur]) {
    if (!id) continue;
    const m = markerById.get(id);
    if (m && m._poi && typeof m.setIcon === 'function') {
      m.setIcon(iconForMarker(m));
    }
  }
  lastSelected = cur;
}

// ── select 定位(不再開 popup) ──
function focusPoi(id) {
  const m = markerById.get(id);
  if (!m) return;
  const targetZoom = Math.max(map.getZoom(), FLY_MIN_ZOOM);
  // cluster 內的點:交給 markercluster 展開定位(單段動畫,不再二次 setView)。
  // reduced-motion 時走 panTo 的瞬移分支(targetZoom≥14=disableClusteringAtZoom,直接可見)。
  if (!prefersReducedMotion() && state.viewMode === 'curate' && clusterGroup.hasLayer(m)) {
    clusterGroup.zoomToShowLayer(m);
    return;
  }
  panTo(m.getLatLng(), targetZoom);
}

// ── 底圖 + 主題聯動 ──
function switchBaseLayer(key) {
  const layer = baseLayerObjs[key];
  if (!layer || map.hasLayer(layer)) return;
  autoSwitching = true;
  for (const [k, lyr] of Object.entries(baseLayerObjs)) {
    if (k !== key && map.hasLayer(lyr)) map.removeLayer(lyr);
  }
  layer.addTo(map);
  autoSwitching = false;
}

function setupBaseLayers() {
  const layers = {};
  let storeKey = store.getSetting('baseLayer', 'carto-voyager');
  if (!BASE_LAYERS[storeKey]) storeKey = 'carto-voyager';

  // 初始:dark 主題 + store 為淺色層 → 初始即用 carto-dark(但不覆寫 store)
  const initialDark = document.documentElement.dataset.theme === 'dark';
  const initialKey = (initialDark && storeKey !== 'carto-dark') ? 'carto-dark' : storeKey;

  for (const [key, cfg] of Object.entries(BASE_LAYERS)) {
    const lyr = L.tileLayer(cfg.url, cfg.options);
    layers[cfg.name] = lyr;
    baseLayerObjs[key] = lyr;
    baseKeyByName[cfg.name] = key;
  }
  baseLayerObjs[initialKey].addTo(map);

  // 國境線 overlay:兩國完整 OSM admin 邊界(陸界 + 領海界線;與底圖同源,
  // 界線走海上 12 海里線而非海岸線,不會與底圖海岸錯位)
  const bordersLayer = L.layerGroup();
  layersCtl = L.control.layers(layers, { '國境線': bordersLayer }, { position: 'topright' }).addTo(map);
  fetch('./data/borders.json')
    .then((r) => r.json())
    .then((gj) => {
      L.geoJSON(gj, {
        interactive: false,
        attribution: '國界 &copy; EuroGeographics',
        style: (f) => ({
          color: f.properties.iso === 'DK' ? '#c8102e' : '#005293', // 國旗色,固定
          weight: 2, dashArray: '8 6', opacity: 0.7, fill: false,
        }),
      }).addTo(bordersLayer);
      if (store.getSetting('showBorders', true)) bordersLayer.addTo(map);
    })
    .catch((e) => console.warn('[mapview] 國境線載入失敗', e));
  map.on('overlayadd', (e) => { if (e.layer === bordersLayer) store.setSetting('showBorders', true); });
  map.on('overlayremove', (e) => { if (e.layer === bordersLayer) store.setSetting('showBorders', false); });

  map.on('baselayerchange', (e) => {
    const key = baseKeyByName[e.name];
    if (!key) return;
    if (autoSwitching) return;        // 主題聯動的自動切換:不記錄、不視為手動
    userPickedBase = true;
    store.setSetting('baseLayer', key);
  });
}

// ── 分類圖例 control(左下;點某分類 → toggle state.filters.categories) ──
function onLegendClick(catKey) {
  if (state.viewMode === 'itinerary') return;   // 行程模式:分類篩選無意義,停用
  const cats = state.filters.categories;
  const i = cats.indexOf(catKey);
  if (i >= 0) cats.splice(i, 1);   // 再點取消
  else cats.push(catKey);
  emit('filter:changed');
  updateLegendActive();
}
function updateLegendActive() {
  const cats = state.filters.categories || [];
  for (const btn of legendItems) {
    btn.classList.toggle('is-active', cats.includes(btn.dataset.cat));
  }
}
// 行程模式:分類篩選不適用 → 整體標記為停用(CSS 淡化 + 阻擋點擊)
function updateLegendMode() {
  if (legendEl) legendEl.classList.toggle('is-disabled', state.viewMode === 'itinerary');
}
function addLegendControl() {
  const Legend = L.Control.extend({
    options: { position: 'bottomleft' },
    onAdd() {
      const c = L.DomUtil.create('div', 'map-legend');
      legendEl = c;
      if (!isDesktop()) c.classList.add('is-collapsed'); // 手機預設收合

      const toggle = L.DomUtil.create('button', 'legend-toggle', c);
      toggle.type = 'button';
      toggle.textContent = '分類圖例';
      toggle.setAttribute('aria-expanded', String(isDesktop()));

      const body = L.DomUtil.create('div', 'legend-body', c);
      legendItems.length = 0;
      for (const [key, cfg] of Object.entries(CATEGORIES)) {
        const item = L.DomUtil.create('button', 'legend-item', body);
        item.type = 'button';
        item.dataset.cat = key;
        const dot = L.DomUtil.create('span', 'legend-dot', item);
        dot.style.setProperty('--c', cfg.color);
        const label = document.createElement('span');
        label.textContent = cfg.zh;
        item.appendChild(label);
        L.DomEvent.on(item, 'click', (ev) => { L.DomEvent.stop(ev); onLegendClick(key); });
        legendItems.push(item);
      }

      L.DomEvent.on(toggle, 'click', (ev) => {
        L.DomEvent.stop(ev);
        const collapsed = c.classList.toggle('is-collapsed');
        toggle.setAttribute('aria-expanded', String(!collapsed));
      });

      L.DomEvent.disableClickPropagation(c);
      L.DomEvent.disableScrollPropagation(c);
      updateLegendActive();
      updateLegendMode();
      return c;
    },
  });
  new Legend().addTo(map);
}

// ── 定位鈕 + 縮放至可見點鈕(左上,zoom 之下) ──
function locateUser() {
  if (!navigator.geolocation) { toast('此裝置不支援定位功能'); return; }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const ll = [pos.coords.latitude, pos.coords.longitude];
      if (locateMarker) map.removeLayer(locateMarker);
      locateMarker = L.circleMarker(ll, {
        radius: 8, weight: 3, color: '#fff',
        fillColor: cssVar('--primary', '#328a97'), fillOpacity: 0.95,
      }).addTo(map);
      panTo(ll, Math.max(map.getZoom(), 13));
    },
    (err) => {
      toast(err.code === err.PERMISSION_DENIED ? '定位權限被拒絕，請於瀏覽器開啟' : '無法取得您的位置');
    },
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 },
  );
}
function fitToVisible() {
  const pts = [];
  for (const m of markerById.values()) {
    if (typeof m.getLatLng === 'function') pts.push(m.getLatLng());
  }
  if (!pts.length) { toast('目前沒有可顯示的景點'); return; }
  map.fitBounds(L.latLngBounds(pts), { padding: [48, 48], maxZoom: 15, animate: !prefersReducedMotion() });
}
function addMapTools() {
  const mkBtn = (svg, title, handler) => {
    const a = document.createElement('a');
    a.href = '#';
    a.className = 'map-tool-btn';
    a.title = title;
    a.setAttribute('role', 'button');
    a.setAttribute('aria-label', title);
    a.innerHTML = svg;
    L.DomEvent.on(a, 'click', (ev) => { L.DomEvent.stop(ev); handler(); });
    return a;
  };
  const Tools = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const bar = L.DomUtil.create('div', 'leaflet-bar map-tools');
      bar.appendChild(mkBtn(ICON.locate, '定位我的位置', locateUser));
      bar.appendChild(mkBtn(ICON.fit, '縮放至目前可見的景點', fitToVisible));
      L.DomEvent.disableClickPropagation(bar);
      return bar;
    },
  });
  new Tools().addTo(map);
}

// ── 雙擊 / 長按:開確認 chip,點按鈕才真正新增(防誤觸) ──
// 關閉路徑統一:closePlaceChip 只負責觸發關閉並解除 movestart;placeChipPopup 一律由
// popupclose 事件歸零(涵蓋手動關、autoClose、closeOnClick 等所有路徑,避免殘留 stale 參照)。
function onPlaceChipMovestart() { closePlaceChip(); }
function closePlaceChip() {
  map.off('movestart', onPlaceChipMovestart);
  if (placeChipPopup) map.closePopup(placeChipPopup);
}
function openPlaceChip(latlng) {
  closePlaceChip();
  const popup = L.popup({
    className: 'place-chip-wrap',
    closeButton: false,
    autoClose: true,
    closeOnClick: true,
    autoPan: false,
    offset: [0, -6],
  })
    .setLatLng(latlng)
    .setContent(
      `<button type="button" class="place-chip-btn">${ICON.plus}<span>在此新增景點</span></button>`)
    .openOn(map);
  placeChipPopup = popup;
  const elm = popup.getElement();
  const btn = elm && elm.querySelector('.place-chip-btn');
  if (btn) {
    L.DomEvent.on(btn, 'click', (ev) => {
      L.DomEvent.stop(ev);
      closePlaceChip();
      emit('custom:place', { lat: latlng.lat, lng: latlng.lng });
    });
  }
  map.on('movestart', onPlaceChipMovestart);   // 地圖 move 自動關(具名 handler,關閉時 off)
}

// 繪製模式的 cluster 點擊行為切換:進入停用、離開恢復(冪等,可安全重入)
function setClusterDrawMode(drawing) {
  clusterGroup.options.zoomToBoundsOnClick = !drawing;
  clusterGroup.options.spiderfyOnMaxZoom = !drawing;
}

// ── 入口 ──
export function init() {
  const mapEl = document.getElementById('map');
  if (!mapEl) { console.error('[mapview] #map 不存在'); return; }

  map = L.map(mapEl, { center: MAP_CENTER, zoom: MAP_ZOOM, zoomControl: true });
  map.doubleClickZoom.disable();
  map.attributionControl.setPrefix(
    '<a href="https://leafletjs.com" title="Leaflet">Leaflet</a>');

  setupBaseLayers();

  clusterGroup = L.markerClusterGroup({
    chunkedLoading: true,
    maxClusterRadius: 50,
    disableClusteringAtZoom: 14,
    spiderfyOnMaxZoom: true,
    iconCreateFunction: clusterIcon,
    // 分批載入完成後再更新 tooltip(避免後段 chunk 尚未進 cluster 就綁 tooltip)
    chunkProgress: (processed, total) => { if (processed >= total) updateTooltipsDebounced(); },
    // zoomToBoundsOnClick 預設 true;draw 模式改於執行期切 options(vendor 點擊時動態讀)
  });
  favoriteLayer = L.layerGroup();
  itineraryLayer = L.layerGroup();
  routeLayer = L.layerGroup().addTo(map);

  bindPopupEvents(map);
  addLegendControl();
  addMapTools();

  // place chip 任何關閉路徑(手動 / autoClose / closeOnClick)都在此歸零並解除 movestart
  map.on('popupclose', (e) => {
    if (e.popup !== placeChipPopup) return;
    map.off('movestart', onPlaceChipMovestart);
    placeChipPopup = null;
  });

  // 地圖互動:雙擊 / 長按(contextmenu)→ 確認 chip
  const placeHandler = (e) => {
    if (state.uiMode === 'draw') return;
    openPlaceChip(e.latlng);
  };
  map.on('dblclick', placeHandler);
  map.on('contextmenu', placeHandler);

  map.on('zoomend', updateTooltipsDebounced);
  map.on('moveend', updateTooltipsDebounced);
  clusterGroup.on('animationend', updateTooltipsDebounced);

  // detail 面板開合 → 地圖尺寸失效重算(立即一次 + 過場結束再一次)
  window.addEventListener('detailtoggle', () => {
    if (!map) return;
    map.invalidateSize();
    setTimeout(() => { if (map) map.invalidateSize(); }, 320); // 蓋過 #detail-panel 的 .28s 過場
  });

  // 主題切換 → 底圖聯動(使用者手動選過就不再自動聯動)
  window.addEventListener('themechange', (e) => {
    if (userPickedBase) return;
    const theme = e.detail?.theme;
    if (theme === 'dark') {
      switchBaseLayer('carto-dark');
    } else if (theme === 'light') {
      let key = store.getSetting('baseLayer', 'carto-voyager');
      if (!BASE_LAYERS[key]) key = 'carto-voyager';
      switchBaseLayer(key);
    }
  });

  // ── 事件匯流排 ──
  on('pois:ready', () => { renderPois(); renderRoutes(); });
  // 依變更型別做最小重繪:route 只重畫路線;import/reset 全量;settings/daynote 不動 marker;
  // curate 模式下 itinerary 變更不影響 marker,小量 status/patch/custom 走增量,其餘保守全量。
  on('overlay:changed', (payload = {}) => {
    const { type, ids } = payload;
    if (type === 'route') { renderRoutes(); return; }
    if (type === 'import' || type === 'reset') { renderPois(); renderRoutes(); return; }
    if (type === 'settings' || type === 'daynote') return;   // 不影響任何 marker

    if (state.viewMode === 'curate') {
      if (type === 'itinerary') return;                      // curate marker 不依賴 _day/_order
      if (Array.isArray(ids) && ids.length
          && (type === 'status' || type === 'patch' || type === 'custom')) {
        for (const id of ids) reconcileCurate(id, type);     // 增量:只動受影響的 marker
        updateTooltipsDebounced();
        return;
      }
      renderPois();                                          // 拿不準 → 保守全量
      return;
    }
    renderPois();                                            // itinerary 模式:序號/連線牽連廣,全量
  });
  on('filter:changed', () => { renderPois(); updateLegendActive(); });
  on('mode:changed', () => { renderPois(); updateLegendMode(); });
  on('day:visibility', () => { if (state.viewMode === 'itinerary') renderPois(); });

  on('select', ({ id, source } = {}) => {
    refreshSelection();
    if (source === 'map' || id == null) return;
    focusPoi(id);
  });

  // 繪製模式:隱藏 / 恢復被編輯的常規路線、切 crosshair 游標,並停用 cluster 點擊縮放/spiderfy
  on('draw:start', ({ routeId } = {}) => {
    document.body.classList.add('map-draw');
    hiddenDrawRouteId = routeId ?? null;
    setClusterDrawMode(true);
    closePlaceChip();
    renderRoutes();
  });
  on('draw:end', () => {
    document.body.classList.remove('map-draw');
    hiddenDrawRouteId = null;
    setClusterDrawMode(false);   // 無條件恢復,避免異常退出後 cluster 點擊卡死
    renderRoutes();
  });

  // 'pois:ready' 在 app.boot() 於 mapview.init() 之前已 emit,故此處主動首繪
  renderPois();
  renderRoutes();
}

/** 供 F4 routedraw.js 取用 Leaflet map 實例 */
export function getMap() { return map; }
