# vendor/

本地化的第三方函式庫(pinned versions)。**Leaflet 鎖 1.9.4** — 2.x 改為純 ESM 並移除全域 `L`,
Leaflet.markercluster 等外掛不相容,請勿升級。

| 函式庫 | 版本 | 用途 |
|---|---|---|
| Leaflet | 1.9.4 | 地圖核心 |
| Leaflet.markercluster | 1.5.3 | Marker 聚合 |
| SortableJS | 1.15.6 | 行程拖曳排序 |

重新下載:

```bash
cd vendor
curl -fsSL -o leaflet/leaflet.js  https://unpkg.com/leaflet@1.9.4/dist/leaflet.js
curl -fsSL -o leaflet/leaflet.css https://unpkg.com/leaflet@1.9.4/dist/leaflet.css
for f in layers.png layers-2x.png marker-icon.png marker-icon-2x.png marker-shadow.png; do
  curl -fsSL -o leaflet/images/$f https://unpkg.com/leaflet@1.9.4/dist/images/$f
done
curl -fsSL -o leaflet.markercluster/leaflet.markercluster.js  https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js
curl -fsSL -o leaflet.markercluster/MarkerCluster.css         https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css
curl -fsSL -o leaflet.markercluster/MarkerCluster.Default.css https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css
curl -fsSL -o sortablejs/Sortable.min.js https://unpkg.com/sortablejs@1.15.6/Sortable.min.js
```
