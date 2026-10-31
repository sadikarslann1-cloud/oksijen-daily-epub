#!/usr/bin/env python3
import feedparser
import trafilatura
import requests
import json
import re
from datetime import datetime, timezone, timedelta
from pathlib import Path
from ebooklib import epub

# --- AYARLAR ---
BASE_DIR = Path(__file__).resolve().parent.parent
EPUB_DIR = BASE_DIR / "epub_ciktilar"
EPUB_DIR.mkdir(parents=True, exist_ok=True)
BUGUN = datetime.now(timezone.utc).strftime("%Y-%m-%d")

FEEDS = [
    {"name": "Oksijen", "url": "https://gazeteoksijen.com/export/rss", "path": ["/turkiye/", "/dunya/"]},
    {"name": "NYT World", "url": "https://rss.nytimes.com/services/xml/rss/nyt/World.xml", "path": []},
]

HEADERS = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}

def clean_html(text):
    return re.sub(r'<[^>]+>', '', text or '').strip()

def fetch_full_text(url):
    """URL'ye gidip makalenin asıl metnini çeker."""
    try:
        # Cloudflare engeline takılmamak için standart bir tarayıcı gibi davranıyoruz
        response = requests.get(url, headers=HEADERS, timeout=10)
        if response.status_code == 200:
            # trafilatura kullanarak reklamları, menüleri temizle, sadece metni al
            text = trafilatura.extract(response.text, include_comments=False, include_tables=False)
            if text:
                return text.split('\n') # Paragraflara böl
    except Exception as e:
        print(f"⚠️ Metin çekilemedi: {url} ({e})")
    return []

def create_epub(articles, book_title, filename):
    """Çekilen makaleleri EPUB formatına dönüştürür."""
    book = epub.EpubBook()
    book.set_identifier(f"id-{BUGUN}")
    book.set_title(book_title)
    book.set_language('tr')
    book.add_author('Oksijen & NYT')

    chapters = []
    for i, art in enumerate(articles):
        c = epub.EpubHtml(title=art['title'], file_name=f'chap_{i}.xhtml', lang='tr')
        
        # HTML içeriğini oluştur
        html_content = f"<h1>{art['title']}</h1>"
        html_content += f"<p><small>{art['source']} | {art['published_date']}</small></p><hr/>"
        
        if art['content']:
            for p in art['content']:
                html_content += f"<p>{p}</p>"
        else:
            # Metin çekilemediyse RSS özetini göster
            html_content += f"<p><i>(Tam metin çekilemedi, RSS özeti aşağıdadır)</i></p><p>{art['summary']}</p>"
            html_content += f"<p><a href='{art['link']}'>Habere Git</a></p>"

        c.content = html_content
        book.add_item(c)
        chapters.append(c)

    # İçindekiler ve Kitap Yapısı
    book.toc = tuple(chapters)
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())
    book.spine = ['nav'] + chapters
    
    out_path = EPUB_DIR / filename
    epub.write_epub(str(out_path), book, {})
    print(f"📚 EPUB Oluşturuldu: {out_path}")

def main():
    all_articles = []
    
    for feed in FEEDS:
        print(f"🔍 {feed['name']} RSS taranıyor...")
        parsed = feedparser.parse(feed['url'])
        
        for entry in parsed.entries:
            link = entry.get('link', '')
            # Oksijen için kategori filtresi
            if feed['path'] and not any(p in link.lower() for p in feed['path']):
                continue
            
            title = clean_html(entry.get('title', ''))
            print(f"  📄 İndiriliyor: {title[:50]}...")
            
            # Tam metni çek
            content_paragraphs = fetch_full_text(link)
            
            all_articles.append({
                "source": feed['name'],
                "title": title,
                "link": link,
                "published_date": entry.get('published', BUGUN)[:10],
                "summary": clean_html(entry.get('summary', '')),
                "content": content_paragraphs
            })

    if all_articles:
        kitap_adi = f"Günlük Gazete — {BUGUN}"
        dosya_adi = f"Gunluk_Gazete_{BUGUN}.epub"
        create_epub(all_articles, kitap_adi, dosya_adi)
    else:
        print("⚠️ Hiç makale bulunamadı.")

if __name__ == "__main__":
    main()
