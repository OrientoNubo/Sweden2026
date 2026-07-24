#!/usr/bin/env python3
"""驗證 data/pois/*.json 並重建 data/manifest.json。

用法:
  python3 scripts/validate_pois.py                 # 驗證(排除 sample.json,若有其他分片)
  python3 scripts/validate_pois.py --check-images  # 另抽查 Wikimedia 圖片連結
  python3 scripts/validate_pois.py --write-manifest
"""
import json
import re
import sys
import unicodedata
import urllib.parse
import urllib.request
from math import asin, cos, radians, sin, sqrt
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
POIS_DIR = ROOT / "data" / "pois"
MANIFEST = ROOT / "data" / "manifest.json"

CATEGORIES = {"castle", "church", "museum", "oldtown", "landmark", "nature", "park",
              "coast", "history", "themepark", "market", "experience", "transport"}
COORD_SOURCES = {"wikipedia-en", "wikipedia-sv", "wikipedia-da", "wikipedia-zh",
                 "wikidata", "osm", "official"}
REQUIRED = ["id", "name", "lat", "lng", "coord_source", "country", "region", "city",
            "category", "tier", "desc", "stay_min", "stay_max"]

# latMin, latMax, lngMin, lngMax(與 docs/DATA_GUIDE.md 一致)
REGION_BBOX = {
    "se-malmo":           (55.45, 55.66, 12.80, 13.45),
    "se-lund-nw":         (55.60, 56.35, 12.40, 13.50),
    "se-skane-se":        (55.30, 56.10, 12.75, 14.40),
    "se-gbg-west":        (56.30, 59.00, 10.90, 13.30),
    "se-sthlm-core":      (59.25, 59.40, 17.90, 18.20),
    "se-sthlm-region":    (58.80, 60.10, 16.40, 19.20),
    "se-smaland-gotland": (56.10, 58.60, 13.30, 19.15),
    "se-ostergotland":    (58.05, 58.80, 14.55, 17.60),
    "se-north":           (59.00, 68.60, 11.90, 24.20),
    "dk-cph-core":        (55.64, 55.73, 12.52, 12.65),
    "dk-cph-greater":     (55.55, 55.82, 12.30, 12.70),
    "dk-nzealand":        (55.60, 56.15, 11.90, 12.70),
    "dk-szealand":        (54.90, 55.60, 11.60, 12.60),
    "dk-bornholm":        (54.95, 55.35, 14.60, 15.25),
    "dk-funen-jutland":   (54.75, 57.80, 8.00, 11.00),
}
COUNTRY_BBOX = {"SE": (55.33, 69.07, 10.95, 24.20), "DK": (54.55, 57.76, 8.00, 15.20)}


def haversine_m(a, b):
    lat1, lng1, lat2, lng2 = map(radians, (a[0], a[1], b[0], b[1]))
    h = sin((lat2 - lat1) / 2) ** 2 + cos(lat1) * cos(lat2) * sin((lng2 - lng1) / 2) ** 2
    return 2 * 6371000 * asin(sqrt(h))


def norm_name(s):
    s = unicodedata.normalize("NFKD", s.lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", "", s)


def check_image(file_name, timeout=15):
    url = ("https://commons.wikimedia.org/w/index.php?title=Special:Redirect/file/"
           + urllib.parse.quote(file_name) + "&width=120")
    req = urllib.request.Request(url, method="HEAD",
                                 headers={"User-Agent": "Sweden2026-validator/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return 200 <= resp.status < 400
    except Exception:
        return False


def main():
    check_images = "--check-images" in sys.argv
    write_manifest = "--write-manifest" in sys.argv

    shard_files = sorted(POIS_DIR.glob("*.json"))
    real_shards = [f for f in shard_files if f.name != "sample.json"]
    if real_shards:
        shard_files = real_shards  # 有正式資料時排除 sample

    errors, warnings = [], []
    all_pois, ids = [], set()

    for path in shard_files:
        try:
            shard = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            errors.append(f"{path.name}: JSON 解析失敗 — {e}")
            continue
        for p in shard.get("pois", []):
            label = f"{path.name}:{p.get('id', '?')}"
            missing = [k for k in REQUIRED if p.get(k) in (None, "")]
            if missing:
                errors.append(f"{label}: 缺欄位 {missing}")
                continue
            if p["id"] in ids:
                errors.append(f"{label}: id 重複")
            ids.add(p["id"])
            if p["category"] not in CATEGORIES:
                errors.append(f"{label}: 非法 category {p['category']}")
            if p["coord_source"] not in COORD_SOURCES:
                errors.append(f"{label}: 非法 coord_source {p['coord_source']}")
            if p["tier"] not in (1, 2, 3):
                errors.append(f"{label}: 非法 tier {p['tier']}")
            if not p["name"].get("zh") or not p["name"].get("local"):
                errors.append(f"{label}: name.zh / name.local 必填")
            if len(p.get("desc", "")) < 20:
                warnings.append(f"{label}: desc 過短")
            bbox = REGION_BBOX.get(p["region"])
            if bbox:
                if not (bbox[0] <= p["lat"] <= bbox[1] and bbox[2] <= p["lng"] <= bbox[3]):
                    errors.append(f"{label}: 座標 ({p['lat']},{p['lng']}) 落在 {p['region']} bbox 外")
            else:
                warnings.append(f"{label}: 未知 region {p['region']},僅檢查國家 bbox")
            cb = COUNTRY_BBOX[p["country"]]
            if not (cb[0] <= p["lat"] <= cb[1] and cb[2] <= p["lng"] <= cb[3]):
                errors.append(f"{label}: 座標落在 {p['country']} 國家 bbox 外")
            all_pois.append((path.name, p))

    # 鄰近去重:名稱正規化相同 或 (名稱相近 且 距離 <150m)
    for i in range(len(all_pois)):
        for j in range(i + 1, len(all_pois)):
            fa, a = all_pois[i]
            fb, b = all_pois[j]
            na, nb = norm_name(a["name"]["local"]), norm_name(b["name"]["local"])
            if not na or not nb:
                continue
            same_name = na == nb or (len(na) > 6 and (na in nb or nb in na))
            if same_name and haversine_m((a["lat"], a["lng"]), (b["lat"], b["lng"])) < 150:
                warnings.append(f"疑似重複:{fa}:{a['id']} ↔ {fb}:{b['id']}")

    if check_images:
        by_file = {}
        for fname, p in all_pois:
            if p.get("image_file"):
                by_file.setdefault(fname, []).append(p)
        for fname, plist in by_file.items():
            for p in plist[:5]:
                if not check_image(p["image_file"]):
                    warnings.append(f"{fname}:{p['id']}: 圖片連結失效 {p['image_file']}")

    if write_manifest:
        files = [f"pois/{f.name}" for f in shard_files]
        version = max((json.loads(f.read_text(encoding='utf-8')).get("version", "")
                       for f in shard_files), default="")
        MANIFEST.write_text(json.dumps({"version": version, "files": files},
                                       ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"manifest.json 已重建:{len(files)} 檔,version={version}")

    print(f"共 {len(all_pois)} 筆 POI,{len(shard_files)} 個分片")
    for w in warnings:
        print(f"  [warn] {w}")
    for e in errors:
        print(f"  [ERROR] {e}")
    print(f"結果:{len(errors)} errors, {len(warnings)} warnings")
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
