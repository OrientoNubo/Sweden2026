// gmaps.js — Google Maps URL 產生器(純函式,無副作用)
// 採 Google Maps URLs「api=1」格式:https://developers.google.com/maps/documentation/urls/get-started
// 座標一律格式化為 5 位小數字串。

const DIR_BASE = 'https://www.google.com/maps/dir/?';
const SEARCH_BASE = 'https://www.google.com/maps/search/?';

/** 數字 → 5 位小數字串 */
function fmt(n) {
  return Number(n).toFixed(5);
}

/** (lat,lng) → 'lat,lng'(逗號保留字面,Google 接受) */
function pair(lat, lng) {
  return `${fmt(lat)},${fmt(lng)}`;
}

/** 地點搜尋 URL(在地圖上以座標落點) */
export function searchUrl(lat, lng) {
  return `${SEARCH_BASE}api=1&query=${pair(lat, lng)}`;
}

/** 路線導航 URL:目的地 + 交通方式(預設大眾運輸) */
export function dirUrl(destLat, destLng, { travelmode = 'transit' } = {}) {
  return `${DIR_BASE}api=1&destination=${pair(destLat, destLng)}&travelmode=${travelmode}`;
}

/** 單段 dir URL:seg 為 [[lat,lng],…],首=origin、末=destination、中間為 waypoints(≤9) */
function buildSegUrl(seg, travelmode) {
  const origin = pair(seg[0][0], seg[0][1]);
  const destination = pair(seg[seg.length - 1][0], seg[seg.length - 1][1]);
  const parts = [
    'api=1',
    `origin=${origin}`,
    `destination=${destination}`,
    `travelmode=${travelmode}`,
  ];
  const mids = seg.slice(1, -1).map((p) => pair(p[0], p[1]));
  if (mids.length) parts.push(`waypoints=${mids.join('%7C')}`); // '|' → %7C
  return DIR_BASE + parts.join('&');
}

/**
 * 多點路線 URL 陣列。points: [[lat,lng],…]。
 * 一般模式(driving/walking/bicycling):單段最多 11 點,超過自動切段,
 * 相鄰段以共同點銜接(前段末點 = 後段首點)。
 * 大眾運輸(transit):Google 的 transit 不支援 waypoints,帶中途點只會回 origin→destination
 * 並略過中途站,故一律拆成相鄰兩點一段,逐段給正確轉乘路線(沿用既有分段 UI)。
 * 回傳 [url,…];少於 2 點回傳 []。
 */
export function multiStopUrl(points, { travelmode = 'transit' } = {}) {
  const pts = (points || []).filter((p) => Array.isArray(p) && p.length >= 2);
  if (pts.length < 2) return [];
  // 一般模式單段最大點數 = origin + 9 中途點 + destination = 11。
  // 9 是 Google Maps「api=1」dir URL 的 waypoints 中途點上限(逾此多餘點會被忽略),為外部服務限制,勿調高。
  // transit 不支援中途點,故每段僅 2 點(origin→destination);相鄰段重疊 1 點串起整條路線。
  const segMax = travelmode === 'transit' ? 2 : 11;
  const step = segMax - 1; // 相鄰段重疊 1 點
  const urls = [];
  for (let i = 0; i < pts.length - 1; i += step) {
    urls.push(buildSegUrl(pts.slice(i, i + segMax), travelmode));
  }
  return urls;
}
