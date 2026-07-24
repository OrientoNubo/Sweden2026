// trash.js — 回收站分頁（F2 實作）
// 渲染 #trash-list / #trash-actions，更新 #trash-badge。
// 列表 markup 用 CONTRACTS 共用 class（.list-item/.li-*/.chip/.btn/.btn-icon/.badge）；樣式由 F3 提供。
import { $, el, toast } from './dom.js';
import { on, state } from './state.js';
import { CATEGORIES } from './config.js';
import * as store from './store.js';

export function init() {
  on('pois:ready', render);
  on('overlay:changed', render);
  on('tab:changed', render);
  render();
}

function render() {
  updateBadge();
  renderActions();
  renderList();
}

function updateBadge() {
  const badge = $('#trash-badge');
  if (!badge) return;
  const n = store.getTrash().length;
  badge.textContent = String(n);
  badge.hidden = n === 0;
}

function catChip(category) {
  const cat = CATEGORIES[category];
  if (!cat) return null;
  const chip = el('span', { class: 'chip' }, `${cat.glyph} ${cat.zh}`);
  chip.style.setProperty('--c', cat.color);
  return chip;
}

function renderActions() {
  const box = $('#trash-actions');
  if (!box) return;
  box.textContent = '';
  const items = store.getTrash();
  if (items.length === 0) return;

  box.append(
    el('button', {
      class: 'btn',
      onclick: () => {
        for (const p of [...items]) store.restoreFromTrash(p.id);
        toast('已全部還原');
      },
    }, '全部還原'),
    el('button', {
      class: 'btn',
      onclick: () => {
        if (confirm('清空回收站？所有項目將永久刪除，無法復原。')) {
          for (const p of [...items]) store.purgeFromTrash(p.id);
          toast('已清空回收站');
        }
      },
    }, '清空回收站'),
  );
}

function renderList() {
  const list = $('#trash-list');
  if (!list) return;
  list.textContent = '';
  const items = store.getTrash();
  if (items.length === 0) {
    list.append(el('div', { class: 'muted', style: { padding: '16px' } }, '回收站是空的'));
    return;
  }
  for (const p of items) list.append(trashItem(p));
}

function trashItem(p) {
  return el('div', { class: 'list-item', dataset: { id: p.id } },
    el('div', { class: 'li-body' },
      el('div', { class: 'li-title' }, p.name.zh),
      el('div', { class: 'li-sub' },
        p.city ? el('span', {}, p.city) : null,
        catChip(p.category),
      ),
    ),
    el('div', { class: 'li-actions' },
      el('button', {
        class: 'btn-icon', title: '還原',
        onclick: () => { store.restoreFromTrash(p.id); toast('已還原'); },
      }, '↩'),
      el('button', {
        class: 'btn-icon', title: '永久刪除',
        onclick: () => {
          if (confirm(`永久刪除「${p.name.zh}」？此動作無法復原。`)) {
            store.purgeFromTrash(p.id);
            toast('已永久刪除');
          }
        },
      }, '🗑'),
    ),
  );
}
