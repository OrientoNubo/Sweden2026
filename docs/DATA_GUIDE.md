# DATA_GUIDE.md — POI 資料撰寫合約(research agent 必讀)

你的任務:為指定區塊產出 `data/pois/{region}.json`,供「刪去法選景點」的行程網站使用。
使用者會瀏覽**所有**點並刪掉不想去的——所以你要「過量供給」:在密度規則允許下,大小景點都收,並在 `desc` 裡誠實寫出「為何值得去/有什麼缺點」,給使用者刪除線索。

## 輸出格式

```json
{
  "region": "se-malmo",
  "version": "2026-07-25",
  "pois": [ { …見下… } ]
}
```

一筆 POI(全部欄位都要出現;無資料的選填欄位填 `null`):

```json
{
  "id": "se-malmo-malmohus-slott",
  "name": { "zh": "馬爾默胡斯城堡", "local": "Malmöhus slott", "en": "Malmö Castle" },
  "lat": 55.60417, "lng": 12.98639,
  "coord_source": "wikipedia-en",
  "country": "SE", "region": "se-malmo", "city": "Malmö",
  "category": "castle", "tier": 2,
  "desc": "北歐現存最古老的文藝復興城堡,現為馬爾默博物館的一部分,涵蓋歷史、水族與美術展區。堡體與護城河散步免費,展覽對非瑞典語旅客標示較少。建議停留 1.5–2 小時。",
  "stay_min": 90, "stay_max": 120,
  "url": "https://malmo.se/museer",
  "wikipedia": "https://en.wikipedia.org/wiki/Malm%C3%B6_Castle",
  "image_file": "Malmohus 2015.jpg",
  "hours": "10:00–17:00(週一休)", "cost": "成人 40 SEK", "transit": "Malmö C 步行 15 分",
  "sep_note": null
}
```

## 欄位規則

- **`id`** = `{region}-{name.local 的 kebab-case slug}`(去除變音符:ö→o、å→a、æ→ae、ø→o)。全 repo 唯一、永不改動。
- **`name.zh`**:zh Wikipedia 有條目 → 用條目標題(臺灣正體 variant);無 → 合理音譯或意譯。`name.local` 必填(瑞典文/丹麥文原名)。
- **`lat`/`lng`**:5 位小數。**座標反幻覺協定(最重要)**:
  - **禁止憑記憶/推測寫座標。**唯一合法來源(依 pilot 實測的可靠度排序):
    1. **Wikidata P625(主力)**:很多 sv/en 條目沒有 {{coord}} tag,GeoData 查不到,但 Wikidata 幾乎都有。批次做法:
       `.../w/api.php?action=query&prop=pageprops&ppprop=wikibase_item&format=json&formatversion=2&titles=A|B|...` 取得 Q-id,再
       `https://www.wikidata.org/w/api.php?action=wbgetentities&props=claims&ids=Q1|Q2|...&format=json` 讀 P625
    2. MediaWiki GeoData API(有 {{coord}} 的條目才有,一次最多 50 條):
       `.../w/api.php?action=query&prop=coordinates&format=json&formatversion=2&titles=A|B|...`
    3. OSM/Nominatim(無 Wikipedia 條目的小點):`https://nominatim.openstreetmap.org/search?q=...&format=json&limit=3`
  - **所有 API 一律 shell out 用 `curl`**:本環境 Python urllib 無法出網(DNS fail);**WebFetch 不可用於 JSON API**(摘要模型會靜默遺漏欄位),WebFetch 只用於讀 Wikivoyage/旅遊局等敘述性網頁。
  - `coord_source` 據實填:`wikipedia-en|wikipedia-sv|wikipedia-da|wikipedia-zh|wikidata|osm|official`。
  - 寫完後自查:每筆座標必須落在你的區塊 bbox 內(見下表);落在外面 = 你抄錯或 lat/lng 對調。
- **`category`**(單選):`castle`(城堡宮殿要塞)、`church`(教堂修道院)、`museum`(博物館美術館)、`oldtown`(老城/街區/廣場)、`landmark`(現代建築地標/觀景塔)、`nature`(自然/國家公園/健行)、`route`(景觀公路/長程步道/景觀環道:整條路線用單一代表性錨點,desc 說明全程)、`park`(城市公園/植物園)、`coast`(海灘/燈塔/港灣/海岸)、`history`(史前遺跡/維京/軍事遺跡)、`themepark`(樂園/動物園/親子)、`market`(市場/美食街區/fika)、`experience`(遊船/浴場/特殊體驗)、`transport`(機場/樞紐車站/渡輪港)。
- **`tier`**:1=國際級地標(此生必看等級)、2=主要景點(該城市值得專程)、3=小眾/順路(散步順訪、在地人去處)。
- **`desc`**:繁體中文 2–4 句,**必含三要素**:(1) 是什麼;(2) 為何值得去——或誠實的缺點(「門票貴」「展品少」「觀光化嚴重」這類刪除線索特別有價值);(3) 大約停留時間。技術名詞、店名保留原文。
- **`stay_min`/`stay_max`**:建議停留分鐘數。
- **`image_file`**:**只填 Wikimedia Commons 檔名**(不含 `File:` 前綴,如 `Malmohus 2015.jpg`;**底線一律轉成空格**)。批次取法:`prop=pageimages&piprop=name&titles=A|B|...` 一次拿多條目的 infobox 主圖檔名。**必須人工過濾**:消歧義頁會回 `Disambig grey.svg` 之類;部分條目 lead image 張冠李戴(拿到明顯不對的圖名時改用 Commons 搜尋 `action=query&list=search&srnamespace=6&srsearch=名稱` 校正,或填 null)。找不到合適圖片填 `null`,**禁止**填其他網站的 URL。目標覆蓋率 ≥85%。
- **分類邊界統一規則**(pilot 定案):購物中心(如 Emporia)→ `landmark`;清真寺/猶太會堂等非教堂宗教場所 → `landmark`;莊園(herrgård)以庭園為參觀重點 → `park`、以建築為主 → `castle`;廣場兼常設市集:市集功能為主 → `market`,歷史建築景觀為主 → `oldtown`。
- **`sep_note`**:僅在 9 月上中旬有實質影響時填(季節性關閉、船班減班、9 月活動),否則 `null`。
- **`hours`/`cost`/`transit`**:簡短純文字,不確定就填 `null`,禁止編造。

## 區塊 bbox 與邊界歸屬

| region | bbox(latMin, latMax, lngMin, lngMax) |
|---|---|
| se-malmo | 55.45, 55.66, 12.80, 13.45 |
| se-lund-nw | 55.60, 56.35, 12.40, 13.50 |
| se-skane-se | 55.30, 56.10, 12.75, 14.40 |
| se-gbg-west | 56.30, 59.00, 10.90, 13.30 |
| se-sthlm-core | 59.25, 59.40, 17.90, 18.20 |
| se-sthlm-region | 58.80, 60.10, 16.40, 19.20 |
| se-smaland-gotland | 56.10, 58.60, 13.30, 19.15 |
| se-ostergotland | 58.05, 58.80, 14.55, 17.60 |
| se-north | 59.00, 68.60, 11.90, 24.20 |
| dk-cph-core | 55.64, 55.73, 12.52, 12.65 |
| dk-cph-greater | 55.55, 55.82, 12.30, 12.70 |
| dk-nzealand | 55.60, 56.15, 11.90, 12.70 |
| dk-szealand | 54.90, 55.60, 11.60, 12.60 |
| dk-bornholm | 54.95, 55.35, 14.60, 15.25 |
| dk-funen-jutland | 54.75, 57.80, 8.00, 11.00 |

邊界歸屬(避免跨區重複收錄):
- Øresund 大橋(觀景點)→ `se-malmo`;Malmö Airport(MMX/Sturup)→ `se-malmo`
- CPH 機場(Kastrup)、Dragør → `dk-cph-greater`;København H → `dk-cph-core`
- Louisiana 美術館(Humlebæk)、Helsingør/Kronborg → `dk-nzealand`;Helsingborg(瑞典側)與 HH 渡輪 → `se-lund-nw`
- Ven 島 → `se-lund-nw`;Drottningholm、Uppsala → `se-sthlm-region`(**不是** core)
- Gränna/Jönköping/Vättern 東岸 → `se-smaland-gotland`;Dalarna → `se-north`
- Bjäre 半島(Båstad/Torekov/Hovs hallar)與 Laholm → `se-gbg-west`;Hässleholm/Markaryd/Ljungby/Värnamo → `se-smaland-gotland`
- Östergötland 全郡(Linköping/Norrköping/Söderköping/Omberg/Rökstenen/Tåkern)+ Sörmland 海岸(Nyköping/Stendörren/Kolmården)→ `se-ostergotland`;Vadstena 既有歸屬不變

## 資料來源與工作流(建議順序)

1. 讀該區 **Wikivoyage(en)** 城市/地區條目的 See/Do 清單 → 決定候選(依 tier 密度規則裁量)。
2. 日歸圈區塊(Skåne、哥本哈根)另用官方旅遊局(visitsweden.com、visitdenmark.com、visitskane.com、malmotown.com、visitcopenhagen.dk)與 WebSearch 補小眾點。
3. 用 GeoData API **批次**取座標(50 條/次),逐筆記 `coord_source`。
4. 查 zh Wikipedia 定 `name.zh`;從 en/sv/da Wikipedia infobox 取 `image_file`、官網、`wikipedia` 連結。
5. 寫 JSON、跑自檢(下節),存檔到 `data/pois/{region}.json`。

## 交付前自檢(必做)

```bash
python3 - <<'EOF'
import json, sys
d = json.load(open('data/pois/REGION.json'))
BBOX = (LAT_MIN, LAT_MAX, LNG_MIN, LNG_MAX)  # 換成你的區塊值
ids = set()
for p in d['pois']:
    assert p['id'] not in ids, f"dup id {p['id']}"; ids.add(p['id'])
    assert BBOX[0] <= p['lat'] <= BBOX[1] and BBOX[2] <= p['lng'] <= BBOX[3], f"bbox fail {p['id']} {p['lat']},{p['lng']}"
    assert p['coord_source'] and len(p['desc']) >= 20
print(f"OK: {len(d['pois'])} pois")
EOF
```

## 譯名 style guide(節選)

哥本哈根(København)、馬爾默(Malmö)、隆德(Lund)、赫爾辛堡(Helsingborg)、赫爾辛格(Helsingør)、于斯塔德(Ystad)、哥德堡(Göteborg)、斯德哥爾摩(Stockholm)、烏普薩拉(Uppsala)、奧胡斯(Aarhus)、歐登塞(Odense)、菲因島(Fyn)、日德蘭(Jylland)、西蘭島(Sjælland)、波恩霍姆(Bornholm)、厄勒海峽(Øresund)、斯科訥(Skåne)、哥特蘭(Gotland)、厄蘭島(Öland)、羅斯基勒(Roskilde)。
