// io.js — 匯出 / 匯入備份（F2 實作）
// 綁定 toolbar 的 #btn-export / #btn-import / #file-import。
import { $, toast } from './dom.js';
import * as store from './store.js';

const SIZE_CONFIRM_BYTES = 20 * 1024 * 1024; // 含圖片且超過此體積先確認
const MAX_IMPORT_BYTES = 80 * 1024 * 1024;   // 匯入檔上限，超過直接拒絕（避免大檔解析卡死分頁）

export function init() {
  const btnExport = $('#btn-export');
  const btnImport = $('#btn-import');
  const fileInput = $('#file-import');

  if (btnExport) btnExport.addEventListener('click', onExport);
  if (btnImport && fileInput) {
    btnImport.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', onImportFile);
  }
}

function todayStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

async function onExport() {
  try {
    const data = await store.exportAll();
    const json = JSON.stringify(data);
    const bytes = new Blob([json]).size;
    const hasImages = data.images && Object.keys(data.images).length > 0;
    if (hasImages && bytes > SIZE_CONFIRM_BYTES) {
      const mb = (bytes / (1024 * 1024)).toFixed(1);
      if (!confirm(`備份含圖片，體積約 ${mb} MB，檔案較大。仍要下載嗎？`)) return;
    }
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `sweden2026-backup-${todayStamp()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('已匯出備份');
  } catch (e) {
    console.error('[io] 匯出失敗', e);
    toast('匯出失敗');
  }
}

async function onImportFile(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // 重置，讓同一檔可再次選取
  if (!file) return;

  if (file.size > MAX_IMPORT_BYTES) {
    const mb = (MAX_IMPORT_BYTES / (1024 * 1024)).toFixed(0);
    toast(`匯入失敗：檔案過大（上限 ${mb} MB）`);
    return;
  }

  let obj;
  try {
    obj = JSON.parse(await file.text());
  } catch (err) {
    toast('匯入失敗：無法解析 JSON');
    return;
  }
  if (!obj || obj.app !== 'sweden2026') {
    toast('匯入失敗：非 Sweden2026 備份檔');
    return;
  }
  // overlay 主體必須是非空 object：帶對 sentinel 但缺 overlay 的檔會讓匯入清空全部資料，須先擋下。
  if (!obj.overlay || typeof obj.overlay !== 'object' || Array.isArray(obj.overlay)
      || Object.keys(obj.overlay).length === 0) {
    toast('匯入失敗：備份檔缺少資料主體');
    return;
  }
  if (!confirm('將覆蓋目前所有本地資料，確定？')) return;

  try {
    // importAll 為原子操作，回傳 {ok, staleBase}：ok=false（如 quota 落盤失敗）舊資料不動；
    // staleBase=true 表備份的 baseVersion 與現行資料版本不同，少數標註可能已失效。
    const res = await store.importAll(obj);
    if (res.ok) {
      toast(res.staleBase
        ? '匯入完成（備份來自較舊資料版本，少數標註可能已失效）'
        : '匯入完成');
    } else {
      toast('匯入失敗：本地儲存空間不足，資料未變更');
    }
  } catch (err) {
    console.error('[io] 匯入失敗', err);
    toast('匯入失敗');
  }
}
