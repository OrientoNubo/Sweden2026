// theme.js — 主題切換(system / light / dark;不走 store.js,直接 localStorage)
import { ICON, iconEl } from './icons.js';

const KEY = 'sweden2026:theme';
const ORDER = ['system', 'light', 'dark'];
const mql = window.matchMedia('(prefers-color-scheme: dark)');

const BTN_INFO = {
  system: { icon: ICON.monitor, title: '主題:跟隨系統' },
  light:  { icon: ICON.sun,     title: '主題:淺色' },
  dark:   { icon: ICON.moon,    title: '主題:深色' },
};

let pref = 'system';   // 使用者偏好:'system'|'light'|'dark'
let resolved = null;   // 實際套用主題:'light'|'dark'

function readPref() {
  const v = localStorage.getItem(KEY);
  return (v === 'light' || v === 'dark' || v === 'system') ? v : 'system';
}

function resolveTheme(p) {
  if (p === 'light' || p === 'dark') return p;
  return mql.matches ? 'dark' : 'light';
}

function updateButton() {
  const btn = document.getElementById('theme-btn');
  if (!btn) return;
  const info = BTN_INFO[pref];
  const svg = iconEl(info.icon);
  if (svg) btn.replaceChildren(svg);
  btn.title = info.title;
  btn.setAttribute('aria-label', info.title);
}

function apply(p, { silent = false, persist = true } = {}) {
  pref = p;
  if (persist) {
    try { localStorage.setItem(KEY, p); } catch (_) { /* 私密模式等寫入失敗:忽略 */ }
  }
  const next = resolveTheme(p);
  document.documentElement.dataset.theme = next;
  const changed = next !== resolved;
  resolved = next;
  updateButton();
  if (changed && !silent) {
    window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: next } }));
  }
}

export function initTheme() {
  // 首次套用不派發事件(no-flash script 已設好 dataset,監聽者尚可能未就緒)
  apply(readPref(), { silent: true, persist: false });

  const btn = document.getElementById('theme-btn');
  if (btn) {
    btn.addEventListener('click', () => {
      const i = ORDER.indexOf(pref);
      apply(ORDER[(i + 1) % ORDER.length]);
    });
  }

  // system 模式下,系統偏好變更即時反映
  const onSystem = () => { if (pref === 'system') apply('system'); };
  if (mql.addEventListener) mql.addEventListener('change', onSystem);
  else if (mql.addListener) mql.addListener(onSystem);
}
