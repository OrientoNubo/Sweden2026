// dom.js — DOM 小工具(Phase 0 凍結)

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** el('div', {class:'x', onclick:fn, dataset:{id:'1'}}, child1, 'text') */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k in node && typeof v === 'boolean') node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
  ));
}

/** safeUrl(u) — 僅放行 http(s) 絕對網址,其餘(javascript:、data: 等)回傳 '#' */
export function safeUrl(u) {
  return /^https?:\/\//i.test(String(u ?? '')) ? String(u) : '#';
}

let toastTimer = null;
/** toast(msg) | toast(msg, ms) | toast(msg, {actionLabel, onAction, duration})
 *  帶 action 時顯示一顆行內按鈕,點擊執行 onAction 並關閉。無 action 行為與舊版相同。 */
export function toast(msg, opts) {
  const t = $('#toast');
  if (!t) return;
  const o = typeof opts === 'number' ? { duration: opts } : (opts || {});
  const { actionLabel, onAction, duration = 2400 } = o;

  clearTimeout(toastTimer);
  t.replaceChildren(document.createTextNode(msg));

  if (actionLabel && typeof onAction === 'function') {
    const btn = el('button', {
      class: 'toast-action',
      type: 'button',
      onclick: () => { clearTimeout(toastTimer); t.hidden = true; onAction(); },
    }, actionLabel);
    t.append(btn);
  }
  t.hidden = false;
  toastTimer = setTimeout(() => { t.hidden = true; }, duration);
}

export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function uuid() {
  return (crypto.randomUUID ? crypto.randomUUID()
    : 'xxxx-4xxx-yxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      }) + Date.now().toString(16));
}
