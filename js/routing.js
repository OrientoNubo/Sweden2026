// routing.js — 沿道路自動路徑規劃(步行/單車/開車)
// 使用 FOSSGIS 營運的 OSRM 公共服務(openstreetmap.org 官網「路線」同款,免 API key)。
// 大眾運輸無免費服務,由各路線的「在 Google Maps 開啟」按鈕承接。
import { toast } from './dom.js';
import * as store from './store.js';

const PROFILES = { foot: 'routed-foot', bike: 'routed-bike', car: 'routed-car' };

export const MODE_LABELS = {
  straight: '─ 直線',
  foot: '🚶 步行',
  bike: '🚴 單車',
  car: '🚗 開車',
};

/** waypoints: [[lat,lng],…] → { geometry:[[lat,lng],…], distance(m), duration(s) } */
export async function fetchRoadRoute(waypoints, mode, signal) {
  const profile = PROFILES[mode];
  if (!profile || waypoints.length < 2) return null;
  const coords = waypoints.map(([lat, lng]) => `${lng.toFixed(6)},${lat.toFixed(6)}`).join(';');
  const url = `https://routing.openstreetmap.de/${profile}/route/v1/driving/${coords}`
    + '?overview=full&geometries=geojson&steps=false';
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`routing HTTP ${res.status}`);
  const data = await res.json();
  const rt = data.routes && data.routes[0];
  if (data.code !== 'Ok' || !rt) throw new Error(`routing failed: ${data.code || 'no route'}`);
  return {
    geometry: rt.geometry.coordinates.map(([lng, lat]) => [
      Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5,
    ]),
    distance: rt.distance,
    duration: rt.duration,
  };
}

const inflight = new Map(); // routeId -> AbortController

/** 路線為非直線模式時,依目前 waypoints 重算道路幾何並存回 store(失敗退回直線顯示)。 */
export async function recomputeIfRouted(routeId) {
  const r = (store.getRoutes() || []).find((x) => x.id === routeId);
  if (!r || !r.mode || r.mode === 'straight' || (r.waypoints || []).length < 2) return;
  inflight.get(routeId)?.abort();
  const ctl = new AbortController();
  inflight.set(routeId, ctl);
  try {
    const res = await fetchRoadRoute(r.waypoints, r.mode, ctl.signal);
    store.updateRoute(routeId, {
      geometry: res.geometry, road_distance: res.distance, road_duration: res.duration,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    console.warn('[routing] 規劃失敗', e);
    store.updateRoute(routeId, { geometry: null, road_distance: null, road_duration: null });
    toast('沿道路規劃失敗,已改顯示直線(路徑服務可能暫時無法使用)');
  } finally {
    if (inflight.get(routeId) === ctl) inflight.delete(routeId);
  }
}
