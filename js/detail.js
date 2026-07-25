// detail.js — 右側詳情面板:檢視 / 編輯 / 新增自訂點(F3 擁有)
// 合約見 docs/CONTRACTS.md。Google Maps URL 直接組,不 import gmaps.js 以免耦合。
import { state, emit, on } from './state.js';
import { $, el, toast, safeUrl } from './dom.js';
import {
  CATEGORIES, TIER_LABELS, COUNTRY_LABELS, TRIP_DAYS, dayLabel, commonsPage, fmtStay,
} from './config.js';
import { ICON, iconEl } from './icons.js';
import * as store from './store.js';
import * as db from './db.js';

let panel, content;
let currentId = null;
let mode = 'view';        // 'view' | 'edit' | 'new'
let objectUrls = [];      // 需要 revoke 的 idb objectURL
let panelOpen = false;    // 面板是否開啟(供 detailtoggle 去重)
let lastTrigger = null;   // 開啟前的觸發元素,關閉時還原焦點
let lastTriggerInList = false; // 觸發元素是否來自景點列表(關閉時列可能已重繪移除,退回列表容器)
let lastImgKey = '';      // 上次解析的圖片指紋(currentId + refs);未變則不重 resolve
let lastUrls = [];        // 上次解析結果(對應 lastImgKey)
let commitingNote = false; // 重繪前 blur 備註提交 setNote,其連鎖的 overlay:changed 交由外層單次重繪(防重入)

function revokeUrls() {
  for (const u of objectUrls) URL.revokeObjectURL(u);
  objectUrls = [];
  lastImgKey = '';
  lastUrls = [];
}

/** 開關狀態變化時派 detailtoggle(供 F1 mapview invalidateSize)+ 切 scrim。
 *  換 POI / 開→開 不重複派(guard 相同狀態)。 */
function setPanelOpen(open) {
  if (open === panelOpen) return;
  panelOpen = open;
  document.body.classList.toggle('detail-open', open);
  window.dispatchEvent(new CustomEvent('detailtoggle', { detail: { open } }));
  if (open) {
    // 記住觸發元素(尚未搶焦點前),再把焦點移到關閉鈕
    const active = document.activeElement;
    lastTrigger = (active && active !== document.body) ? active : null;
    // 觸發元素若來自景點列表,關閉時該列可能已因重繪移除 → 記住以退回列表容器
    lastTriggerInList = !!(lastTrigger && lastTrigger.closest && lastTrigger.closest('#poi-list'));
    const cb = $('#detail-close');
    if (cb) cb.focus({ preventScroll: true });
  } else {
    panel.removeAttribute('role');
    panel.removeAttribute('aria-modal');
    panel.removeAttribute('aria-label');
    if (lastTrigger && document.contains(lastTrigger) && typeof lastTrigger.focus === 'function') {
      lastTrigger.focus({ preventScroll: true });
    } else if (lastTriggerInList) {
      // 觸發列已不存在:退回列表容器(#poi-list tabindex=-1,由 sidebar.js 設定)
      const list = $('#poi-list');
      if (list) list.focus({ preventScroll: true });
    }
    lastTrigger = null;
    lastTriggerInList = false;
  }
}

/** 面板以非 modal dialog 呈現(aria-modal=false:不困住焦點,但輔助技術可辨識為對話框) */
function setDialogAria(label) {
  if (!panel) return;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  if (label) panel.setAttribute('aria-label', label);
}

/** 使用者要求關閉:統一由 select(null) 路徑收斂到 close() */
function requestClose() {
  state.selectedId = null;
  emit('select', { id: null, source: 'other' });
}

/** 清掉手機拖曳殘留的 inline transform,避免下次開啟卡住 */
function resetSheetTransform() {
  if (!panel) return;
  panel.style.transform = '';
  panel.style.transition = '';
}

function close() {
  if (panel) panel.hidden = true;
  currentId = null;
  mode = 'view';
  revokeUrls();
  setPanelOpen(false);
}

function catInfo(cat) {
  return CATEGORIES[cat] || { zh: cat || '其他', glyph: '📍', color: '#888' };
}

/** 把圖片 ref 設到 <img>:https 直接;idb 走 db.getImage → objectURL */
async function setImgSrc(img, ref) {
  if (/^https?:/.test(ref)) { img.src = ref; return; }
  if (ref.startsWith('idb:')) {
    try {
      const blob = await db.getImage(ref.slice(4));
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      objectUrls.push(url);
      img.src = url;
    } catch (e) { console.error('[detail] getImage', e); }
  }
}

/** 解析 _images 為可顯示 URL 陣列(idb 轉 objectURL) */
async function resolveImages(refs) {
  const out = [];
  for (const ref of refs || []) {
    if (/^https?:/.test(ref)) { out.push({ href: ref, base: false }); continue; }
    if (ref.startsWith('idb:')) {
      try {
        const blob = await db.getImage(ref.slice(4));
        if (blob) { const u = URL.createObjectURL(blob); objectUrls.push(u); out.push({ href: u, base: false }); }
      } catch (e) { console.error(e); }
    }
  }
  return out;
}

function gmapsSearch(lat, lng) {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}
function gmapsDir(lat, lng) {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=transit`;
}

// ============================================================
// 檢視卡
// ============================================================
function buildCarousel(p, urls) {
  const wrap = el('div', { class: 'detail-carousel' });
  // base 圖(image_file)排在最前;其連結指向 Commons 描述頁
  const baseFirst = !!p.image_file;
  if (urls.length === 0) {
    const c = catInfo(p.category);
    wrap.append(el('div', { class: 'dc-placeholder', style: { background: c.color } }, c.glyph));
    return wrap;
  }

  let idx = 0;
  const img = el('img', {
    class: 'dc-img', alt: p.name?.zh || '',
    tabindex: '0', role: 'button', 'aria-label': '開啟圖片來源',
  });
  wrap.append(img);

  const update = () => {
    img.src = urls[idx].href;
    dots.forEach((d, i) => d.classList.toggle('on', i === idx));
  };
  const openSource = () => {
    const href = (idx === 0 && baseFirst && p.image_file) ? commonsPage(p.image_file) : urls[idx].href;
    window.open(safeUrl(href), '_blank', 'noopener');
  };
  img.addEventListener('click', openSource);
  img.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSource(); }
  });

  let dots = [];
  if (urls.length > 1) {
    const prev = el('button', { class: 'dc-nav dc-prev', 'aria-label': '上一張',
      onclick: () => { idx = (idx - 1 + urls.length) % urls.length; update(); } }, '‹');
    const next = el('button', { class: 'dc-nav dc-next', 'aria-label': '下一張',
      onclick: () => { idx = (idx + 1) % urls.length; update(); } }, '›');
    const dotWrap = el('div', { class: 'dc-dots' });
    dots = urls.map(() => el('span', { class: 'dc-dot' }));
    dots.forEach((d) => dotWrap.append(d));
    wrap.append(prev, next, dotWrap);
  }
  update();
  return wrap;
}

function metaRow(key, val) {
  if (val == null || val === '') return null;
  return el('div', { class: 'dm-row' },
    el('div', { class: 'dm-key' }, key),
    el('div', { class: 'dm-val' }, val));
}

function detailDaySelect(p) {
  const sel = el('select', {
    class: 'detail-day-select' + (p._day ? ' assigned' : ''),
    'aria-label': '指派日期',
    onchange: () => store.assignToDay(p.id, sel.value || null),
  }, el('option', { value: '' }, '未指派日期'),
    ...TRIP_DAYS.map((d) => el('option', { value: d }, dayLabel(d))));
  sel.value = p._day || '';
  return sel;
}

function buildView(p, urls) {
  const c = catInfo(p.category);
  const fav = p._status === 'favorite';
  const root = el('div', {});
  root.append(buildCarousel(p, urls));

  const body = el('div', { class: 'detail-body' });

  // 標題
  body.append(el('div', { class: 'detail-title' }, p.name?.zh || p.name?.local || '(未命名)'));
  if (p.name?.local) body.append(el('div', { class: 'detail-local' }, p.name.local));
  if (p.name?.en && p.name.en !== p.name?.local) body.append(el('div', { class: 'detail-en' }, p.name.en));

  // chips:國家 / 城市 / 分類 / tier
  const chips = el('div', { class: 'detail-chips' });
  if (p.country) chips.append(el('span', { class: 'chip static' }, COUNTRY_LABELS[p.country] || p.country));
  if (p.city) chips.append(el('span', { class: 'chip static' }, p.city));
  chips.append(el('span', { class: 'chip static', style: `--c:${c.color}` }, `${c.glyph} ${c.zh}`));
  if (p.tier) chips.append(el('span', { class: 'chip static' }, `Tier ${p.tier} · ${TIER_LABELS[p.tier] || ''}`));
  if (p._custom) chips.append(el('span', { class: 'chip static' }, '自訂'));
  body.append(chips);

  // 描述
  if (p.desc) body.append(el('div', { class: 'detail-desc' }, p.desc));

  // meta
  const meta = el('div', { class: 'detail-meta' },
    metaRow('停留', fmtStay(p.stay_min, p.stay_max)),
    metaRow('開放', p.hours),
    metaRow('費用', p.cost),
    metaRow('交通', p.transit),
    metaRow('注意', p.sep_note),
  );
  if (meta.childNodes.length) body.append(meta);

  // 連結
  const links = el('div', { class: 'detail-links' });
  if (p.url) links.append(el('a', { href: safeUrl(p.url), target: '_blank', rel: 'noopener' }, '官方網站 ↗'));
  if (p.wikipedia) links.append(el('a', { href: safeUrl(p.wikipedia), target: '_blank', rel: 'noopener' }, 'Wikipedia ↗'));
  if (p.image_file) links.append(el('a', { href: commonsPage(p.image_file), target: '_blank', rel: 'noopener' }, '圖片來源 ↗'));
  if (links.childNodes.length) body.append(links);

  // 備註
  body.append(el('div', { class: 'detail-section-label' }, '我的備註'));
  const note = el('textarea', { class: 'detail-note', placeholder: '寫點筆記…(離開輸入框自動儲存)' });
  note.value = p._note || '';
  note.addEventListener('blur', () => store.setNote(p.id, note.value));
  body.append(note);

  // 操作列
  const favBtn = el('button', {
    class: 'btn' + (fav ? ' btn-primary' : ''),
    title: fav ? '已收藏,點擊取消收藏' : '收藏',
    'aria-label': fav ? '已收藏,點擊取消收藏' : '收藏',
    onclick: () => store.setStatus(p.id, fav ? null : 'favorite'),
  }, iconEl(fav ? ICON.starFill : ICON.starOutline), fav ? '已收藏' : '收藏');
  const delBtn = el('button', {
    class: 'btn btn-danger', title: '移入回收站', 'aria-label': '移入回收站',
    onclick: () => doDelete(p.id),
  }, iconEl(ICON.trash), '刪除');
  const gmBtn = el('button', {
    class: 'btn', title: '在 Google Maps 開啟', 'aria-label': '在 Google Maps 開啟',
    onclick: () => window.open(gmapsSearch(p.lat, p.lng), '_blank', 'noopener'),
  }, iconEl(ICON.gmaps), '在 Google Maps 開啟');
  const navBtn = el('button', {
    class: 'btn', title: '導航(大眾運輸)', 'aria-label': '導航(大眾運輸)',
    onclick: () => window.open(gmapsDir(p.lat, p.lng), '_blank', 'noopener'),
  }, iconEl(ICON.route), '導航(大眾運輸)');
  const editBtn = el('button', {
    class: 'btn full', title: '編輯', 'aria-label': '編輯',
    onclick: () => renderEdit(p.id),
  }, iconEl(ICON.edit), '編輯');

  body.append(el('div', { class: 'detail-actions' },
    favBtn, delBtn,
    withFull(detailDaySelect(p)),
    gmBtn, navBtn,
    editBtn,
  ));

  root.append(body);
  return root;
}

function withFull(node) {
  return el('div', { class: 'full' }, node);
}

function doDelete(id) {
  requestClose();   // → select(null) → close()
  store.setStatus(id, 'deleted');
  toast('已移至回收站', { actionLabel: '復原', onAction: () => store.setStatus(id, null) });
}

// ============================================================
// 圖片編輯器(編輯 / 新增共用)
// ============================================================
function compressImage(file, maxEdge = 1600, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.naturalWidth, h = img.naturalHeight;
      const scale = Math.min(1, maxEdge / Math.max(w, h));
      w = Math.round(w * scale); h = Math.round(h * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob((b) => b ? resolve(b) : reject(new Error('toBlob 失敗')), 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('圖片載入失敗')); };
    img.src = url;
  });
}

/** refs 為 live 陣列(就地增刪);hooks.onAdd/onRemove 用於即時持久化(編輯模式) */
function buildImageEditor(refs, hooks = {}) {
  const thumbs = el('div', { class: 'img-thumbs' });
  const urlInput = el('input', { type: 'url', placeholder: '貼上圖片網址…' });
  const addUrlBtn = el('button', { class: 'btn', type: 'button' }, '加入');
  const fileInput = el('input', { type: 'file', accept: 'image/*' });

  function draw() {
    thumbs.textContent = '';
    refs.forEach((ref) => {
      const img = el('img', { alt: '' });
      setImgSrc(img, ref);
      const del = el('button', { class: 'img-del', type: 'button', title: '刪除圖片', 'aria-label': '刪除圖片',
        onclick: () => {
          const i = refs.indexOf(ref);
          if (i >= 0) refs.splice(i, 1);
          hooks.onRemove?.(ref);
          draw();
        } }, '✕');
      thumbs.append(el('div', { class: 'img-thumb' }, img, del));
    });
  }

  addUrlBtn.addEventListener('click', () => {
    const u = urlInput.value.trim();
    if (!/^https?:\/\//.test(u)) { toast('請輸入 http(s) 開頭的圖片網址'); return; }
    refs.push(u); hooks.onAdd?.(u); urlInput.value = ''; draw();
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const blob = await compressImage(file);
      const uuid = await db.putImage(blob);
      const ref = 'idb:' + uuid;
      refs.push(ref); hooks.onAdd?.(ref); draw();
    } catch (e) {
      console.error('[detail] 圖片上傳失敗', e);
      toast('圖片上傳失敗，可能是瀏覽器無痕模式限制');
    }
    fileInput.value = '';
  });

  draw();
  return el('div', { class: 'field' },
    el('label', {}, '圖片'),
    thumbs,
    el('div', { class: 'img-add-row' }, urlInput, addUrlBtn),
    el('div', { class: 'img-add-row' }, fileInput),
  );
}

function categorySelect(current) {
  const sel = el('select', {});
  for (const [k, c] of Object.entries(CATEGORIES)) sel.append(el('option', { value: k }, `${c.glyph} ${c.zh}`));
  sel.value = (current && CATEGORIES[current]) ? current : 'landmark';
  return sel;
}

function field(labelText, inputEl, hint) {
  const f = el('div', { class: 'field' }, el('label', {}, labelText), inputEl);
  if (hint) f.append(el('div', { class: 'hint' }, hint));
  return f;
}

// ============================================================
// 編輯模式
// ============================================================
function renderEdit(id) {
  const p = store.getPoi(id);
  if (!p) return;
  mode = 'edit';
  revokeUrls();

  const nameInput = el('input', { type: 'text' }); nameInput.value = p.name?.zh || '';
  const descInput = el('textarea', {}); descInput.value = p.desc || '';

  const form = el('div', { class: 'detail-form' }, el('h3', {}, '編輯景點'));
  form.append(field('中文名稱', nameInput));

  let catSel, latInput, lngInput;
  if (p._custom) {
    catSel = categorySelect(p.category);
    latInput = el('input', { type: 'number', step: 'any' }); latInput.value = p.lat;
    lngInput = el('input', { type: 'number', step: 'any' }); lngInput.value = p.lng;
    form.append(field('分類', catSel));
    form.append(el('div', { class: 'filter-row' },
      field('緯度 lat', latInput), field('經度 lng', lngInput)));
  }
  form.append(field('描述', descInput));

  // 圖片(即時持久化)
  const refs = [...(p._images || [])];
  form.append(buildImageEditor(refs, {
    onAdd: (ref) => store.addImage(id, ref),
    onRemove: (ref) => store.removeImage(id, ref),
  }));

  const save = el('button', { class: 'btn btn-primary', onclick: () => {
    const name_zh = nameInput.value.trim();
    if (!name_zh) { toast('名稱不可空白'); return; }
    if (p._custom) {
      store.updateCustomPoi(id, {
        name_zh, category: catSel.value, desc: descInput.value.trim(),
        lat: Number(latInput.value), lng: Number(lngInput.value),
      });
    } else {
      store.patchPoi(id, { name_zh, desc: descInput.value.trim() });
    }
    toast('已儲存');
    openPoi(id);
  } }, '儲存');
  const cancel = el('button', { class: 'btn', onclick: () => openPoi(id) }, '取消');
  form.append(el('div', { class: 'form-actions' }, cancel, save));

  content.textContent = '';
  content.append(form);
  setDialogAria('編輯景點');
  resetSheetTransform();
  panel.hidden = false;
  setPanelOpen(true);
}

// ============================================================
// 新增自訂點
// ============================================================
function renderNewCustom({ lat, lng }) {
  mode = 'new';
  currentId = null;
  revokeUrls();

  const nameInput = el('input', { type: 'text', placeholder: '必填' });
  const catSel = categorySelect('landmark');
  const descInput = el('textarea', {});
  const latInput = el('input', { type: 'number', step: 'any' }); latInput.value = lat;
  const lngInput = el('input', { type: 'number', step: 'any' }); lngInput.value = lng;
  const daySel = el('select', { 'aria-label': '指派日期' }, el('option', { value: '' }, '未指派日期'),
    ...TRIP_DAYS.map((d) => el('option', { value: d }, dayLabel(d))));

  const staged = [];
  const imgEditor = buildImageEditor(staged); // 延後持久化

  const form = el('div', { class: 'detail-form' },
    el('h3', {}, '新增自訂景點'),
    field('中文名稱 *', nameInput),
    field('分類', catSel),
    el('div', { class: 'filter-row' }, field('緯度 lat', latInput), field('經度 lng', lngInput)),
    field('描述', descInput),
    field('指派日期', daySel),
    imgEditor,
  );

  const create = el('button', { class: 'btn btn-primary', onclick: () => {
    const name_zh = nameInput.value.trim();
    if (!name_zh) { toast('請輸入中文名稱'); return; }
    const id = store.addCustomPoi({
      lat: Number(latInput.value), lng: Number(lngInput.value),
      name_zh, category: catSel.value, desc: descInput.value.trim(),
      day: daySel.value || null,
    });
    for (const ref of staged) if (id) store.addImage(id, ref);
    toast('已新增自訂景點');
    if (id) { state.selectedId = id; emit('select', { id, source: 'other' }); }
    else close();
  } }, '新增');
  const cancel = el('button', { class: 'btn', onclick: () => close() }, '取消');
  form.append(el('div', { class: 'form-actions' }, cancel, create));

  content.textContent = '';
  content.append(form);
  setDialogAria('新增自訂景點');
  resetSheetTransform();
  panel.hidden = false;
  setPanelOpen(true);
}

// ============================================================
// 開啟檢視(async:需解析圖片)
// ============================================================
async function openPoi(id) {
  const p = store.getPoi(id);
  if (!p) { close(); return; }
  currentId = id;
  mode = 'view';
  const prevScroll = (!panel.hidden && content) ? content.scrollTop : 0;

  // 圖片 refs 未變(同一 POI、同一組 refs)則重用上次解析的 objectURL,不重 resolve
  const refs = p._images || [];
  const imgKey = id + '|' + refs.join('\n');
  let urls;
  if (imgKey === lastImgKey) {
    urls = lastUrls;
  } else {
    revokeUrls();
    urls = await resolveImages(refs);
    if (currentId !== id) return; // 期間被切換,放棄
    lastImgKey = imgKey;
    lastUrls = urls;
  }

  content.textContent = '';
  content.append(buildView(p, urls));
  setDialogAria(p.name?.zh || p.name?.local || '景點詳情');
  resetSheetTransform();
  panel.hidden = false;
  setPanelOpen(true);
  content.scrollTop = prevScroll;
}

// ============================================================
// 手機 sheet 下拉手勢(僅 ≤768px 啟用)
// ============================================================
function initSheetGesture(handle) {
  const mq = window.matchMedia('(max-width: 768px)');
  let startY = 0, dy = 0, lastY = 0, lastT = 0, velocity = 0, dragging = false;

  handle.addEventListener('pointerdown', (e) => {
    if (!mq.matches || panel.hidden) return;
    dragging = true;
    startY = lastY = e.clientY;
    lastT = e.timeStamp;
    dy = 0; velocity = 0;
    panel.style.transition = 'none';        // 拖曳期間關過場,跟指
    try { handle.setPointerCapture(e.pointerId); } catch (_) {}
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dy = Math.max(0, e.clientY - startY);   // 只允許向下
    const dt = e.timeStamp - lastT;
    if (dt > 0) velocity = (e.clientY - lastY) / dt;  // px/ms(向下為正)
    lastY = e.clientY; lastT = e.timeStamp;
    panel.style.transform = `translateY(${dy}px)`;
  });

  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
    panel.style.transition = '';            // 恢復 CSS 過場
    const h = panel.getBoundingClientRect().height || 1;
    if (dy > h * 0.25 || velocity > 0.5) {
      // 關閉:先邏輯關閉(hidden 前 inline transform 仍在,面板停在 dy),再動畫滑到底
      requestClose();
      panel.style.transform = 'translateY(100%)';
      setTimeout(() => { panel.style.transform = ''; }, 300);
    } else {
      panel.style.transform = '';           // 彈回原位(CSS 過場)
    }
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

// ============================================================
// init
// ============================================================
export function init() {
  panel = $('#detail-panel');
  content = $('#detail-content');
  if (!panel || !content) return;

  // 手機 sheet 拖曳把手(桌機由 CSS 隱藏);插在面板頂端
  const handle = el('div', { class: 'sheet-handle', 'aria-hidden': 'true' },
    el('span', { class: 'sheet-handle-bar' }));
  panel.insertBefore(handle, panel.firstChild);
  initSheetGesture(handle);

  // 手機背景遮罩(桌機由 CSS 隱藏);點擊關閉 sheet
  const scrim = el('div', { class: 'detail-scrim', 'aria-hidden': 'true', onclick: requestClose });
  document.body.appendChild(scrim);

  const closeBtn = $('#detail-close');
  if (closeBtn) closeBtn.addEventListener('click', requestClose);

  // Escape:面板開啟時關閉;若焦點在輸入框內先 blur(第一下不關,避免搶掉輸入框的 Esc)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || panel.hidden) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
      t.blur();
      return;
    }
    requestClose();
  });

  on('select', ({ id }) => {
    if (id == null) close();
    else openPoi(id);
  });

  on('custom:place', (payload) => {
    if (payload && Number.isFinite(payload.lat) && Number.isFinite(payload.lng)) renderNewCustom(payload);
  });

  // 資料變更時,若正在檢視則同步刷新(編輯/新增中不打斷)。
  // 僅在變更影響目前 POI 時重繪(payload.ids 含 currentId;無 ids 視為全域變更)。
  on('overlay:changed', (payload) => {
    if (panel.hidden || mode !== 'view' || currentId == null) return;
    // blur 提交備註觸發的 overlay:changed(type:'status', ids:[currentId])→ 交由外層本次重繪,不重入
    if (commitingNote) return;
    const ids = payload && payload.ids;
    if (Array.isArray(ids) && !ids.includes(currentId)) return;
    // 無 ids 的整包變更(external/import)會整塊重繪。若焦點在本面板備註輸入框且尚未 blur,
    // 先 blur 讓既有 blur handler 提交輸入(setNote 值未變會早退,不觸發連鎖),避免輸入遺失。
    const active = document.activeElement;
    if (!Array.isArray(ids) && active && content.contains(active)
        && active.classList && active.classList.contains('detail-note')) {
      commitingNote = true;
      try { active.blur(); } finally { commitingNote = false; }
    }
    if (store.getPoi(currentId)) openPoi(currentId);
    else close();
  });
}
