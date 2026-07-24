# Sweden2026 — ECCV 2026 行程規劃地圖

丹麥+瑞典旅遊行程規劃的互動地圖(2026/9/4–9/15,ECCV 2026 @ Malmö)。
純靜態網站,部署於 GitHub Pages:<https://orientonubo.github.io/Sweden2026/>

## 特色

- **刪去法選景點**:預載兩國 800+ 個大小景點(繁中說明、分類、圖片),刪掉不想去的,留下的就是行程候選;誤刪可從 toast 一鍵復原
- 整理模式(cluster 瀏覽/篩選/搜尋/收藏/回收站,地圖分類圖例即點即篩)與行程模式(9/4–9/15 按日指派、每日一色、順序折線)
- 雙擊(手機長按)地圖新增自訂標注,說明卡可帶圖片(可上傳,存瀏覽器 IndexedDB);一鍵定位到目前所在
- 自由繪製路線:逐點畫線、編輯節點、命名調色;可選直線或沿道路(步行/單車/開車)自動規劃距離時間
- 三段主題切換(淺色/深色/跟隨系統),深色時底圖自動聯動
- 每個點與每日行程都有 Google Maps 深度連結(開啟/導航/多點路線)
- 所有個人資料(刪選、日程、自訂點、圖片)只存在瀏覽器本地,可匯出/匯入 JSON 備份

## 本機開發

```bash
python3 -m http.server 8000   # file:// 下 fetch 會失敗,必須起 http server
# 開 http://localhost:8000
```

資料驗證:`python3 scripts/validate_pois.py --write-manifest`

## 資料與版權

- 底圖:© OpenStreetMap contributors;CARTO basemaps © CARTO
- 景點圖片:Wikimedia Commons(點圖可至原始檔案頁,授權見各檔案頁)
- 景點說明為本專案自撰,座標取自 Wikipedia/Wikidata/OpenStreetMap
- 程式碼授權 MIT
