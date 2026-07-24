// geo.js — 地理計算工具(Phase 0 凍結)

const R = 6371000; // 地球半徑(公尺)

/** 兩點距離(公尺);a、b 為 [lat, lng] */
export function haversine(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** 折線累計距離(公尺);waypoints: [[lat,lng], …] */
export function routeDistance(waypoints) {
  let d = 0;
  for (let i = 1; i < waypoints.length; i++) d += haversine(waypoints[i - 1], waypoints[i]);
  return d;
}

/** 公尺 → '850 m' / '12.3 km' */
export function fmtDistance(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

/** 一組 [lat,lng] 的 L.latLngBounds;空陣列回傳 null */
export function boundsOf(points) {
  if (!points.length) return null;
  return window.L.latLngBounds(points.map((p) => window.L.latLng(p[0], p[1])));
}
