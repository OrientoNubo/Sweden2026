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

function bindModeToggle() {
  const box = $('#mode-toggle');
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn || state.uiMode === 'draw') return;
    const mode = btn.dataset.mode;
    if (mode === state.viewMode) return;
    state.viewMode = mode;
    $$('#mode-toggle button').forEach((b) => b.classList.toggle('active', b === btn));
    emit('mode:changed', mode);
  });
}

async function boot() {
  try {
    await store.init();          // emit 'pois:ready'
  } catch (e) {
    console.error(e);
    toast('資料載入失敗,請重新整理頁面');
    return;
  }
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

boot();
