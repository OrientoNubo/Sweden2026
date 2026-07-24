// state.js — 中央狀態 + 迷你事件匯流排(Phase 0 凍結)
// 事件清單與寫入權見 docs/CONTRACTS.md

export const state = {
  pois: [],
  filters: { q: '', country: null, region: null, city: null, categories: [], tiers: [], status: 'active' },
  selectedId: null,
  viewMode: 'curate',   // 'curate' | 'itinerary'
  activeTab: 'pois',    // 'pois' | 'days' | 'routes' | 'trash'
  uiMode: 'normal',     // 'normal' | 'draw'
  dayVisibility: {},    // day -> bool(缺省視為 true)
};

const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

export function emit(event, payload) {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of [...set]) {   // 快照迭代:回呼內 on()/off() 不影響本輪派發
    try { fn(payload); }
    catch (e) { console.error(`[state] listener for "${event}" threw`, e); }
  }
}
