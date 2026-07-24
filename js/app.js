// app.js — 入口與模組接線(Phase 0 凍結;僅整合階段可調)
import { state, on, emit } from './state.js';
import { $, $$, toast } from './dom.js';
import * as store from './store.js';
import * as mapview from './mapview.js';
import * as sidebar from './sidebar.js';
import * as filters from './filters.js';
import * as detail from './detail.js';
import * as itinerary from './itinerary.js';
import * as routes from './routes.js';
import * as routedraw from './routedraw.js';
import * as trash from './trash.js';
import * as io from './io.js';
import { initTheme } from './theme.js';

function bindModeToggle() {
  const box = $('#mode-toggle');
  const btns = $$('#mode-toggle button');
  // 初始 aria-pressed 對齊 active 態(切換時同步)
  btns.forEach((b) => b.setAttribute('aria-pressed', String(b.classList.contains('active'))));
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn || state.uiMode === 'draw') return;
    const mode = btn.dataset.mode;
    if (mode === state.viewMode) return;
    state.viewMode = mode;
    btns.forEach((b) => {
      const active = b === btn;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
    emit('mode:changed', mode);
  });
}

// PWA:註冊 Service Worker(feature-detect,失敗靜默 warn)。
// 偵測到新版 SW 安裝完成(且已有 controller = 是「更新」而非首裝)時提示重新整理。
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          toast('已更新到新版本，重新整理後生效');
        }
      });
    });
  }).catch((e) => console.warn('[sw] 註冊失敗', e));
}

async function boot() {
  try {
    await store.init();          // emit 'pois:ready'
  } catch (e) {
    console.error(e);
    toast('資料載入失敗，請重新整理頁面');
    return;
  }
  initTheme();
  mapview.init();
  filters.init();
  sidebar.init();
  detail.init();
  itinerary.init();
  routes.init();
  routedraw.init();
  trash.init();
  io.init();
  bindModeToggle();
  emit('app:ready');
}

// boot 完成後(成功或已處理的失敗皆會 resolve)再註冊 SW,避免與首屏關鍵資源載入競爭。
boot().finally(registerServiceWorker);
