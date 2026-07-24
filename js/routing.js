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
    + '?overview=simplified&geometries=geojson&steps=false';
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

/** 中止某路線在途的道路規劃請求;切回直線或刪除路線時呼叫,避免晚到的回應把幾何寫回。 */
export function abortRoute(routeId) {
  inflight.get(routeId)?.abort();
  inflight.delete(routeId);
}

/** 路線為非直線模式時,依目前 waypoints 重算道路幾何並存回 store(失敗退回直線顯示)。 */
export async function recomputeIfRouted(routeId) {
  const r = (store.getRoutes() || []).find((x) => x.id === routeId);
  if (!r || !r.mode || r.mode === 'straight' || (r.waypoints || []).length < 2) return;
  const startMode = r.mode; // 發起時的模式;await 後若已切換或路線已不存在則丟棄本次結果
  inflight.get(routeId)?.abort();
  const ctl = new AbortController();
  inflight.set(routeId, ctl);
  try {
    const res = await fetchRoadRoute(r.waypoints, startMode, ctl.signal);
    // await 期間路線可能被刪除或切模式;重讀 store 確認仍為發起時的模式才寫回(競態防護)
    const cur = (store.getRoutes() || []).find((x) => x.id === routeId);
    if (!cur || cur.mode !== startMode) return;
    store.updateRoute(routeId, {
      geometry: res.geometry, road_distance: res.distance, road_duration: res.duration,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    console.warn('[routing] 規劃失敗', e);
    // 失敗退回直線前同樣確認路線仍存在且仍為非直線模式,避免覆蓋已切換的狀態
    const cur = (store.getRoutes() || []).find((x) => x.id === routeId);
    if (!cur || !cur.mode || cur.mode === 'straight') return;
    store.updateRoute(routeId, { geometry: null, road_distance: null, road_duration: null });
    toast('沿道路規劃失敗,已改顯示直線(路徑服務可能暫時無法使用)');
  } finally {
    if (inflight.get(routeId) === ctl) inflight.delete(routeId);
  }
}
