// mapview.js — 地圖核心:底圖、marker/cluster、行程圖層、自訂路線、互動(合約見 docs/CONTRACTS.md)
import { state, on, emit } from './state.js';
import * as store from './store.js';
import { debounce, escapeHtml } from './dom.js';
import { BASE_LAYERS, MAP_CENTER, MAP_ZOOM, dayColor } from './config.js';
import { routeDistance, fmtDistance, fmtDuration } from './geo.js';
import { buildIcon, clusterIcon } from './markers.js';
import { buildPopupHtml, bindPopupEvents } from './popup.js';

const L = window.L;

const TOOLTIP_ZOOM = 13;       // 此縮放以上開 permanent tooltip
const TOOLTIP_MAX = 150;       // 視窗內 tooltip 超過此數只留 tier 1–2
const FLY_MIN_ZOOM = 14;       // select 定位時的最小縮放
const STAR_COLOR = '#f5b301';

const POPUP_OPTS = {
  className: 'poi-popup-wrap',
  maxWidth: 280,
  minWidth: 240,
  autoPanPadding: [24, 24],
  closeButton: true,
};

let map = null;
let clusterGroup = null;       // 整理模式
let itineraryLayer = null;     // 行程模式(marker+polyline+favorite dots)
let routeLayer = null;         // 自訂路線
const markerById = new Map();  // 目前模式下 id -> 主要 marker(供 flyTo/openPopup/選取高亮)
const routeLines = new Map();  // routeId -> polyline
const baseKeyByName = {};      // 圖層顯示名 -> BASE_LAYERS 的 key
let hiddenDrawRouteId = null;  // 繪製中、暫時隱藏的常規路線
let lastSelected = null;

const isDesktop = () => window.matchMedia('(min-width: 769px)').matches;

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
function openMarkerPopup(marker) {
  if (!isDesktop() || !marker._poi) return;
  const html = buildPopupHtml(marker._poi);
  if (marker.getPopup()) marker.setPopupContent(html);
  else marker.bindPopup(html, POPUP_OPTS);
  marker.openPopup();
}

function bindMarkerInteractions(marker, poi) {
  marker._poi = poi;
  marker.on('click', () => {
    if (state.uiMode === 'draw') return;
    if (isDesktop()) {
      openMarkerPopup(marker);
    } else {
      state.selectedId = poi.id;
      emit('select', { id: poi.id, source: 'map' });
    }
  });
}

function makePoiMarker(poi, mode) {
  const m = L.marker([poi.lat, poi.lng], { icon: buildIcon(poi, { mode }) });
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
  const markers = [];
  for (const poi of store.getPois()) {
    if (!passesFilter(poi)) continue;
    const m = makePoiMarker(poi, 'curate');
    markers.push(m);
    markerById.set(poi.id, m);
  }
  clusterGroup.addLayers(markers);
  if (!map.hasLayer(clusterGroup)) map.addLayer(clusterGroup);
}

function renderItinerary() {
  if (map.hasLayer(clusterGroup)) map.removeLayer(clusterGroup);
  clusterGroup.clearLayers();
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
  // favorite 未排程點:半透明小圓點(可點)
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
  updateTooltips();
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
      color: r.color || '#4363d8', weight: 4, opacity: 0.85,
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

// ── permanent tooltip(zoom≥13;視窗內超過上限時只顯示 tier 1–2) ──
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
function refreshSelection() {
  const cur = state.selectedId;
  if (cur === lastSelected) return;
  for (const id of [lastSelected, cur]) {
    if (!id) continue;
    const m = markerById.get(id);
    if (m && m._poi && typeof m.setIcon === 'function') {
      m.setIcon(buildIcon(m._poi, { mode: state.viewMode }));
    }
  }
  lastSelected = cur;
}

// ── select 定位 ──
function focusPoi(id, openPop) {
  const m = markerById.get(id);
  if (!m) return;
  const targetZoom = Math.max(map.getZoom(), FLY_MIN_ZOOM);
  if (state.viewMode === 'curate' && clusterGroup.hasLayer(m)) {
    clusterGroup.zoomToShowLayer(m, () => {
      map.setView(m.getLatLng(), Math.max(map.getZoom(), FLY_MIN_ZOOM), { animate: true });
      if (openPop) openMarkerPopup(m);
    });
  } else {
    map.flyTo(m.getLatLng(), targetZoom);
    if (openPop) map.once('moveend', () => openMarkerPopup(m));
  }
}

// ── 底圖 ──
function setupBaseLayers() {
  const layers = {};
  let currentKey = store.getSetting('baseLayer', 'carto-voyager');
  if (!BASE_LAYERS[currentKey]) currentKey = 'carto-voyager';
  for (const [key, cfg] of Object.entries(BASE_LAYERS)) {
    layers[cfg.name] = L.tileLayer(cfg.url, cfg.options);
    baseKeyByName[cfg.name] = key;
  }
  layers[BASE_LAYERS[currentKey].name].addTo(map);
  L.control.layers(layers, {}, { position: 'topright' }).addTo(map);
  map.on('baselayerchange', (e) => {
    const key = baseKeyByName[e.name];
    if (key) store.setSetting('baseLayer', key);
  });
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
    disableClusteringAtZoom: 13,
    spiderfyOnMaxZoom: true,
    zoomToBoundsOnClick: false, // draw 模式需攔截 cluster 點擊,改由下方手動處理
    iconCreateFunction: clusterIcon,
  });
  clusterGroup.on('clusterclick', (e) => {
    if (state.uiMode === 'draw') return;
    e.layer.zoomToBounds({ padding: [20, 20] });
  });
  itineraryLayer = L.layerGroup();
  routeLayer = L.layerGroup().addTo(map);

  bindPopupEvents(map);

  // 地圖互動:雙擊 / 長按(contextmenu)新增自訂點
  const placeHandler = (e) => {
    if (state.uiMode === 'draw') return;
    emit('custom:place', { lat: e.latlng.lat, lng: e.latlng.lng });
  };
  map.on('dblclick', placeHandler);
  map.on('contextmenu', placeHandler);

  map.on('zoomend', updateTooltipsDebounced);
  map.on('moveend', updateTooltipsDebounced);
  clusterGroup.on('animationend', updateTooltipsDebounced);

  // ── 事件匯流排 ──
  on('pois:ready', () => { renderPois(); renderRoutes(); });
  on('overlay:changed', ({ type } = {}) => {
    if (type === 'route') { renderRoutes(); return; }
    renderPois();
    if (type === 'import' || type === 'reset') renderRoutes();
  });
  on('filter:changed', () => renderPois());
  on('mode:changed', () => renderPois());
  on('day:visibility', () => { if (state.viewMode === 'itinerary') renderPois(); });

  on('select', ({ id, source } = {}) => {
    refreshSelection();
    if (source === 'map' || id == null) return;
    focusPoi(id, isDesktop());
  });

  // 繪製模式:隱藏 / 恢復被編輯的常規路線,並切換 crosshair 游標
  on('draw:start', ({ routeId } = {}) => {
    document.body.classList.add('map-draw');
    hiddenDrawRouteId = routeId ?? null;
    renderRoutes();
  });
  on('draw:end', () => {
    document.body.classList.remove('map-draw');
    hiddenDrawRouteId = null;
    renderRoutes();
  });

  // 'pois:ready' 在 app.boot() 於 mapview.init() 之前已 emit,故此處主動首繪
  renderPois();
  renderRoutes();
}

/** 供 F4 routedraw.js 取用 Leaflet map 實例 */
export function getMap() { return map; }
