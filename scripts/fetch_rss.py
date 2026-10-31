#!/usr/bin/env python3
"""
Oksijen + NYT RSS arşivleyici.
- Birden fazla feed URL'sini dener (fallback).
- Kategori link/tag filtresi uygular.
- Markdown dosyaları + deduplicated JSON üretir.
"""

import feedparser
import json
import html
import re
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

BASE_DIR     = Path(__file__).resolve().parent.parent
ARSIV_DIR    = BASE_DIR / "arsiv"
DATA_DIR     = BASE_DIR / "data"
DB_PATH      = DATA_DIR / "articles.json"
INDEX_PATH   = BASE_DIR / "INDEX.md"
MAX_AGE_DAYS = 3   # feed'de daha eski tarihli haber varsa atla

FEEDS = [
    {
        "name": "oksijen-turkiye",
        "urls": [
            "https://gazeteoksijen.com/export/rss",
            "https://gazeteoksijen.com/rss",
            "https://gazeteoksijen.com/feed",
        ],
        "path_filter": ["/turkiye/"],
        "cat_filter":  ["türkiye", "turkiye"],
    },
    {
        "name": "oksijen-dunya",
        "urls": [
            "https://gazeteoksijen.com/export/rss",
            "https://gazeteoksijen.com/rss",
            "https://gazeteoksijen.com/feed",
        ],
        "path_filter": ["/dunya/"],
        "cat_filter":  ["dünya", "dunya", "world"],
    },
    {
        "name": "nyt-world",
        "urls": [
            "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
        ],
        "path_filter": [],
        "cat_filter":  [],
    },
]

# ---------- Yardımcılar ----------

def clean_html(text: str) -> str:
    if not text:
        return ""
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()

def entry_datetime(entry):
    for field in ("published_parsed", "updated_parsed"):
        val = entry.get(field)
        if val:
            return datetime(*val[:6], tzinfo=timezone.utc)
    return None

def entry_matches(entry, cfg) -> bool:
    link = (entry.get("link") or "").lower()
    for p in cfg["path_filter"]:
        if p in link:
            return True
    cats = [t.get("term", "").lower() for t in entry.get("tags", [])]
    for c in cats:
        for f in cfg["cat_filter"]:
            if f in c:
                return True
    # filtresi olmayan feed → her şey geçerli
    return not cfg["path_filter"] and not cfg["cat_filter"]

# ---------- Feed çekme ----------

def fetch_feed(cfg):
    feed = None
    for url in cfg["urls"]:
        try:
            candidate = feedparser.parse(url)
            if candidate.entries:
                print(f"✅ {cfg['name']}: {url} → {len(candidate.entries)} entry")
                feed = candidate
                break
            print(f"⚠️ {cfg['name']}: {url} → 0 entry, sonraki deneniyor")
        except Exception as e:
            print(f"⚠️ {cfg['name']}: {url} hata → {e}")
    if feed is None:
        print(f"❌ {cfg['name']}: hiçbir feed çalışmadı")
        return []

    cutoff = datetime.now(timezone.utc) - timedelta(days=MAX_AGE_DAYS)
    articles = []
    for entry in feed.entries:
        if not entry_matches(entry, cfg):
            continue
        dt = entry_datetime(entry)
        if dt and dt < cutoff:
            continue

        link = entry.get("link", "").strip()
        if not link:
            continue

        articles.append({
            "source":         cfg["name"],
            "title":          clean_html(entry.get("title", "")),
            "link":           link,
            "author":         clean_html(entry.get("author", "")),
            "published":      dt.isoformat() if dt else None,
            "published_date": dt.strftime("%Y-%m-%d") if dt else datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "summary":        clean_html(entry.get("summary", ""))[:500],
        })
    return articles

# ---------- Markdown yazımı ----------

def write_markdown(source_name: str, day: str, articles):
    target = ARSIV_DIR / day / f"{source_name}.md"
    target.parent.mkdir(parents=True, exist_ok=True)

    lines = [
        f"# {source_name} — {day}",
        f"_{len(articles)} haber_",
        "",
    ]
    for a in articles:
        title = a["title"].replace("[", "\\[").replace("]", "\\]")
        lines.append(f"## [{title}]({a['link']})")
        meta = []
        if a.get("author"):
            meta.append(f"👤 {a['author']}")
        if a.get("published"):
            meta.append(f"🕒 {a['published'][:16].replace('T', ' ')} UTC")
        if meta:
            lines.append(" · ".join(meta))
        if a.get("summary"):
            summary = a["summary"][:280].replace("\n", " ")
            lines.append(f"\n> {summary}")
        lines.append("")
    target.write_text("\n".join(lines), encoding="utf-8")
    print(f"📝 {target} ({len(articles)} haber)")

# ---------- JSON DB (dedupe) ----------

def update_db(all_articles):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    existing = []
    if DB_PATH.exists():
        try:
            existing = json.loads(DB_PATH.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"⚠️ DB okunamadı, sıfırlanıyor: {e}")
            existing = []

    by_link = {a["link"]: a for a in existing}
    new_count = 0
    for a in all_articles:
        if a["link"] not in by_link:
            by_link[a["link"]] = a
            new_count += 1

    merged = sorted(
        by_link.values(),
        key=lambda x: x.get("published") or "",
        reverse=True,
    )
    DB_PATH.write_text(
        json.dumps(merged, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"💾 DB: {len(merged)} toplam haber ({new_count} yeni)")

# ---------- Index ----------

def update_index():
    if not ARSIV_DIR.exists():
        return
    days = sorted([d.name for d in ARSIV_DIR.iterdir() if d.is_dir()], reverse=True)
    lines = ["# Arşiv Index", "", f"Toplam **{len(days)}** gün.", ""]
    for d in days[:60]:
        links = []
        for f in sorted((ARSIV_DIR / d).glob("*.md")):
            links.append(f"[{f.stem}](arsiv/{d}/{f.name})")
        lines.append(f"- **{d}** — " + " · ".join(links))
    INDEX_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"📇 {INDEX_PATH} güncellendi")

# ---------- Ana akış ----------

def main():
    all_articles = []
    by_day_source = {}   # (source, day) → [articles]

    for cfg in FEEDS:
        articles = fetch_feed(cfg)
        all_articles.extend(articles)
        for a in articles:
            key = (cfg["name"], a["published_date"])
            by_day_source.setdefault(key, []).append(a)

    if not all_articles:
        print("⚠️ Hiç makale toplanamadı.")
        return 1

    for (source, day), arts in by_day_source.items():
        # aynı gün içinde link bazlı dedupe
        uniq = {a["link"]: a for a in arts}.values()
        write_markdown(source, day, list(uniq))

    update_db(all_articles)
    update_index()

    print(f"\n🎯 Bitti. Toplam çekilen: {len(all_articles)} haber")
    return 0

if __name__ == "__main__":
    sys.exit(main())scripts/fetch_rss.py
