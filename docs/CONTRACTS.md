# CONTRACTS.md — 模組合約(Phase 0 凍結)

所有並行開發的 agent 必須遵守本文件。**不得修改他人負責的檔案;不得更改本文件定義的介面、事件、DOM id。**
如發現合約缺漏,在自己檔案內以最小侵入方式解決,並在完成報告中註明。

## 檔案所有權

| Agent | 擁有(可寫)檔案 |
|---|---|
| F1 地圖核心 | `js/mapview.js`、`js/markers.js`、`js/popup.js`、`css/map.css` |
| F2 資料層 | `js/store.js`、`js/db.js`、`js/io.js`、`js/trash.js` |
| F3 UI 層 | `js/sidebar.js`、`js/filters.js`、`js/detail.js`、`css/layout.css` |
| F4 規劃層 | `js/itinerary.js`、`js/gmaps.js`、`js/routes.js`、`js/routedraw.js`、`js/routing.js`、`css/planner.css` |
| 共用資產 | `js/icons.js`(跨層 inline SVG 圖示庫)、`js/theme.js`(主題切換,由 `app.js` 接線 `initTheme()`) |
| 凍結(僅整合階段可調) | `index.html`、`js/app.js`、`js/config.js`、`js/state.js`、`js/dom.js`、`js/geo.js`、`css/tokens.css` |

## 事件匯流排(js/state.js)

`import { state, on, emit } from './state.js'`

| 事件 | payload | 發出者 | 說明 |
|---|---|---|---|
| `pois:ready` | — | store | base+overlay 首次合併完成,`state.pois` 可用 |
| `overlay:changed` | `{type, ids?}` | store | 任何使用者資料變更後(type: `status`/`patch`/`custom`/`itinerary`/`route`/`daynote`/`settings`/`import`/`reset`);**store 已先重算 `state.pois` 再 emit** |
| `filter:changed` | — | filters | `state.filters` 已更新 |
| `select` | `{id, source}` | mapview/sidebar/其他 | 選中 POI(id 可為 null=取消選取;source: `map`/`list`/`other`)。mapview 收到 source≠map 時 flyTo;sidebar 收到 source≠list 時捲動 highlight;detail 收到 id≠null 時開詳情 |
| `custom:place` | `{lat, lng}` | mapview | 使用者雙擊/長按地圖,要求新增自訂點 → detail 開新增表單 |
| `mode:changed` | `'curate'\|'itinerary'` | app | `state.viewMode` 已更新;mapview 據此切換顯示策略 |
| `tab:changed` | `'pois'\|'days'\|'routes'\|'trash'` | sidebar | `state.activeTab` 已更新 |
| `draw:start` | `{routeId?}` | routedraw | 進入繪製/編輯模式,`state.uiMode='draw'`;mapview/popup 須 guard 停用點擊互動 |
| `draw:end` | — | routedraw | 離開繪製模式,`state.uiMode='normal'` |
| `day:visibility` | `{day, visible}` | itinerary | 行程模式下切某天顯示;mapview 讀 `state.dayVisibility` |
| `app:ready` | — | app | boot 尾端(各模組 init 完成)emit;目前無訂閱者,保留給後續掛載鉤子 |

### window 事件(原生 CustomEvent,非 state bus)

主題與面板開合不走 `js/state.js`,改用 `window.dispatchEvent` / `addEventListener`:

| 事件 | detail | 派發者 | 訂閱者 |
|---|---|---|---|
| `themechange` | `{theme:'light'\|'dark'}` | theme.js | mapview 換底圖(使用者手動選過底圖後不再自動聯動);**首次套用為 silent 不派發**(no-flash script 已設好 `data-theme`) |
| `detailtoggle` | `{open:boolean}` | detail.js | mapview `map.invalidateSize()`(立即一次 + 過場結束再一次) |

### draw 模式的 cluster 點擊攔截(F1;markercluster 版本相依)

`draw:start` 進入繪製模式後,mapview 需停用 markercluster 的 cluster 點擊行為(否則點到 cluster 會 zoomToBounds / spiderfy,干擾路線繪製)。實作(`js/mapview.js` 的 `setClusterDrawMode`)只在執行期切 `clusterGroup.options.zoomToBoundsOnClick` / `spiderfyOnMaxZoom`,**不重建 cluster group**——這依賴 **markercluster 1.5.3** 的 `_zoomOrSpiderfy` 於**點擊當下**才動態讀取這兩個 `options`(已核對 vendor 原始碼)。

**升級 markercluster 前必須回歸測試 draw 模式下的 cluster 點擊**:若新版改為在建構時快取這兩個 flag,執行期切 options 將失效,draw 模式點 cluster 會意外觸發 zoom / spiderfy。

## 中央狀態(js/state.js,唯讀約定:只有標注的 owner 可寫)

```js
state = {
  pois: [],            // effective POIs(store 寫)
  filters: { q:'', country:null, region:null, city:null, categories:[], tiers:[], status:'active' }, // filters 寫
  selectedId: null,    // select 事件的發出者寫
  viewMode: 'curate',  // app 寫
  activeTab: 'pois',   // sidebar 寫
  uiMode: 'normal',    // routedraw 寫('normal'|'draw')
  dayVisibility: {},   // itinerary 寫(day -> bool,缺省視為 true)
}
```

`filters.status`:`'active'`(未刪,預設)/`'favorite'`/`'undecided'`/`'all'`。

## Effective POI 形狀(store.getPois() / state.pois 的元素)

base 欄位(見 docs/DATA_GUIDE.md)⊕ overlay patch,再加上執行期欄位(底線開頭,不落地到 base):

```js
{ id, name:{zh,local,en}, lat, lng, country, region, city, category, tier,
  desc, stay_min, stay_max, url, wikipedia, image_file, hours, cost, transit, sep_note,
  _status: null|'favorite'|'deleted',
  _note: '',            // 使用者備註
  _day: 'YYYY-MM-DD'|null,
  _order: 0,            // 在該日中的順序(無日期時無意義)
  _custom: false,       // 自訂點為 true(自訂點的可編輯欄位=全部)
  _images: ['https://…', 'idb:<uuid>', …]  // 顯示用圖片清單:base 圖(由 config.commonsImg 組 URL)在前,extraImages 在後
}
```

## store.js API(F2 實作;簽名凍結,其他 agent 直接 import 使用)

```js
await init()                       // openDb → fetch manifest+分片 → 載 overlay → 合併 → emit 'pois:ready'
getPois() -> [poi]                 // = state.pois
getPoi(id) -> poi|null
setStatus(id, status)              // null|'favorite'|'deleted'
setNote(id, text)
patchPoi(id, {name_zh?, desc?})    // base 點可覆寫欄位(白名單);custom 點請用 updateCustomPoi
addCustomPoi({lat,lng,name_zh,category?,desc?,day?}) -> id
updateCustomPoi(id, fields)        // fields: {name_zh?,category?,desc?,lat?,lng?}
addImage(id, ref)                  // ref: 'https://…' 或 'idb:<uuid>'(上傳流程:db.putImage 得 uuid 後呼叫此)
removeImage(id, ref)
assignToDay(id, day|null)          // 加入該日末尾/自日程移除
reorderDay(day, orderedIds)        // 整天重排(跨天拖曳=先 assignToDay 再 reorderDay)
setDayNote(day, text) / getDayNote(day)
getItinerary() -> {day: [id,…]}    // 依序
addRoute({name?,color?,note?,day?,waypoints}) -> id
updateRoute(id, fields)            // fields 任意子集:name/color/note/day/visible/waypoints/mode/geometry/road_distance/road_duration
deleteRoute(id)
getRoutes() -> [route]             // {id,name,color,note,day,visible,mode,geometry,road_distance,road_duration,waypoints:[[lat,lng],…],createdAt}
restoreFromTrash(id) / purgeFromTrash(id)  // purge:custom 真刪+清圖;base 點=隱藏(hiddenInTrash)
getTrash() -> [poi]                // _status==='deleted' 且未 hiddenInTrash
getSetting(k, def) / setSetting(k, v)
exportAll() -> Promise<object>     // io.js 內部用
importAll(obj) -> Promise<{ok, staleBase}>  // ok=false 舊資料不動;staleBase=true 表備份 baseVersion 與現行版本不同
resetAll()
```

所有 mutation:更新 overlay → 重算 `state.pois` → debounce 300ms 存 localStorage → `emit('overlay:changed', {type,…})`。

route 的 `mode`(`straight`/`foot`/`bike`/`car`)、`geometry`、`road_distance`、`road_duration` 由 `js/routing.js` 管線維護:非直線模式時依 waypoints 呼叫 FOSSGIS 營運的 OSRM 公共服務(免 API key)取道路幾何與距離時間,再經 `updateRoute` 寫回;失敗則清空這些欄位並退回直線顯示(distance 自行以 waypoints 估算)。大眾運輸不在此管線,由 Google Maps 深連結承接。

## db.js API(F2 實作)

```js
openDb(); putImage(blob) -> uuid; getImage(uuid) -> Blob|null;
deleteImage(uuid); listImages() -> [uuid]; clearImages();
putImageWithId(id, blob) -> id     // 以指定 uuid 寫入(匯入還原時保留原 uuid,讓 overlay 的 'idb:<uuid>' 引用仍能解析);僅 store.js 匯入流程使用
```

## gmaps.js API(F4 實作,純函式)

```js
searchUrl(lat, lng) -> string
dirUrl(destLat, destLng, {travelmode='transit'}) -> string
multiStopUrl(points, {travelmode='transit'}) -> [string]  // points: [[lat,lng],…];waypoints 上限 9,超過自動切段
```

## DOM id(index.html 凍結;各 agent 只在自己的容器內生成內容)

- Toolbar:`#toolbar`、`#mode-toggle`(內含 `button[data-mode="curate"]`、`button[data-mode="itinerary"]`,app.js 綁)、`#theme-btn`(三段主題切換,theme.js 綁)、`#btn-export`、`#btn-import`、`#file-import`(hidden input,io.js 綁)、`#btn-sidebar`(手機漢堡,F3 綁)
- Sidebar:`#sidebar`、`#sidebar-tabs`(`button[data-tab]` ×4 + `#trash-badge`,F3 綁 tab 切換;`.tab-pane` 顯隱由 F3 控)
  - `#tab-pois`:`#search-input`、`#filter-bar`、`#poi-count`、`#poi-list`(F3)
  - `#tab-days`:`#day-list`(F4)
  - `#tab-routes`:`#btn-new-route`、`#route-list`(F4)
  - `#tab-trash`:`#trash-actions`、`#trash-list`(F2)
- 地圖:`#map`(F1);`#draw-banner`(F4:`#draw-hint`、`#draw-distance`、`#btn-draw-undo`、`#btn-draw-done`、`#btn-draw-cancel`)
- 詳情:`#detail-panel`、`#detail-close`、`#detail-content`(F3)
- `#toast`(dom.js 的 `toast()` 使用)

## CSS 約定

- 只寫自己的 css 檔;共用變數一律用 `css/tokens.css` 的 custom properties。
- 共用元件 class 由 F3 在 `layout.css` 定義,其他人直接用:`.list-item`(含 `.li-thumb`、`.li-body`、`.li-title`、`.li-sub`、`.li-actions`)、`.chip`、`.btn`、`.btn-icon`、`.badge`。
- 分類色/日程色:`config.js` 有 `CATEGORIES[k].color` 與 `DAY_COLORS`;需要在 CSS 用時以 inline style 或 `style.setProperty('--c', …)` 傳入。

## 儲存 key

| 儲存 | key | 擁有者 | 說明 |
|---|---|---|---|
| localStorage | `sweden2026:userdata:v1` | store.js | 整包 overlay(刪選/日程/自訂點/路線/設定);每次 mutation debounce 300ms 寫入 |
| localStorage | `sweden2026:theme` | theme.js | 主題偏好 `system`/`light`/`dark`;獨立於 store,不入備份 |
| IndexedDB | DB `sweden2026` / store `images` | db.js | 上傳圖片 blob,key 為 uuid;overlay 以 `idb:<uuid>` 引用 |

## 其他鐵則

- Leaflet 鎖 1.9.4,全域 `L`;SortableJS 全域 `Sortable`。app 程式碼一律 ES modules 相對路徑 import。
- 不新增任何第三方依賴、不使用任何需要 API key 的服務。
- 文案一律繁體中文。
- 若需 git commit:身分 OrientoNubo / d11922023@csie.ntu.edu.tw,訊息純文字,**嚴禁任何 Claude/Anthropic/AI 署名或 trailer**。
