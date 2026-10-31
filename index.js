/**
 * Oksijen Günlük EPUB Üretici – v3.1 (Playwright + Login + 403/Paywall Bypass)
 * - 4 kategori: Türkiye, Dünya, Ekonomi, New York Times
 * - Playwright ile tek oturumda gerçek tarayıcı + E-posta/Şifre ile abone girişi
 * - Son 12 saat filtresi (workflow_dispatch ile değiştirilebilir)
 * - `.resizable-text` makale gövdesi + JSON-LD / "Haber Giriş" tarih yakalama
 * - Kategoriye göre gruplu, renkli ayraçlı, iki seviyeli TOC menülü EPUB
 * - Google Drive yükleme (3 denemeli retry) + yerel .epub çıktısı
 */

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const cheerio = require('cheerio');
const { chromium } = require('playwright');

// ===================================================
// AYARLAR
// ===================================================
const BASE = 'https://gazeteoksijen.com';

const CATEGORIES = [
  { name: 'Türkiye',        slug: 'turkiye',        color: '#2c7be5' },
  { name: 'Dünya',          slug: 'dunya',          color: '#e67e22' },
  { name: 'Ekonomi',        slug: 'ekonomi',        color: '#27ae60' },
  { name: 'New York Times', slug: 'new-york-times', color: '#111111' }
];

const HOURS_LOOKBACK = parseInt(process.env.HOURS_LOOKBACK || '12', 10);
const PAGES_PER_CAT = parseInt(process.env.PAGES_PER_CAT || '1', 10);
const FETCH_DELAY_MS = 500;
const PAGE_TIMEOUT_MS = 35000;
const RENDER_WAIT_MS = 2000;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Google Apps Script URL (Secrets'ta tanımlı değilse Tampermonkey betiğindeki yedek URL kullanılır)
const DEFAULT_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbw6jPsrW6WbU51-QMaFmQa5KVM5M8YSoLUM075NQunxIC_hV0IEzbAr9GlHBjBYJqhMZA/exec';
const APPS_SCRIPT_URL = (process.env.OXY_SCRIPT_URL || DEFAULT_SCRIPT_URL).trim();

const OXY_EMAIL = (process.env.OXY_EMAIL || '').trim();
const OXY_PASSWORD = (process.env.OXY_PASSWORD || '').trim();

const MONTHS_TR = {
  ocak: 0, şubat: 1, subat: 1, mart: 2, nisan: 3, mayıs: 4, mayis: 4,
  haziran: 5, temmuz: 6, ağustos: 7, agustos: 7, eylül: 8, eylul: 8,
  ekim: 9, kasım: 10, kasim: 10, aralık: 11, aralik: 11
};

// ===================================================
// YARDIMCILAR
// ===================================================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function safeFileName(s) {
  return String(s || 'Oksijen')
    .replace(/[\/\\:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 120);
}

function htmlEscape(text) {
  return String(text || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function norm(text) {
  return String(text || '')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseTurkishDate(rawText) {
  if (!rawText) return null;
  const text = norm(rawText);

  // 1) DD.MM.YYYY HH:mm veya DD.MM.YYYY (Örn: "31.10.2026 23:10")
  let m = text.match(/(\d{1,2})\.(\d{1,2})\.(20\d{2})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (m) {
    const d = String(m[1]).padStart(2, '0');
    const mon = String(m[2]).padStart(2, '0');
    const y = m[3];
    const hh = m[4] ? String(m[4]).padStart(2, '0') : '12';
    const mm = m[5] ? String(m[5]).padStart(2, '0') : '00';
    return new Date(`${y}-${mon}-${d}T${hh}:${mm}:00+03:00`);
  }

  // 2) ISO 8601 (Örn: "2026-10-31T23:22:44+03:00" veya "2026-10-31T23:10:00")
  if (text.includes('-') && /20\d{2}-\d{2}-\d{2}/.test(text)) {
    // Saat dilimi yoksa Türkiye saati (+03:00) olarak yorumla
    const hasTz = /[Z+-]\d{2}:?\d{2}$/.test(text) || text.endsWith('Z');
    const normalizedIso = hasTz
      ? text
      : text.includes('T')
        ? `${text}+03:00`
        : `${text}T12:00:00+03:00`;
    const isoDate = new Date(normalizedIso);
    if (!isNaN(isoDate.getTime())) return isoDate;
  }

  // 3) "1 Kasım 2026 08:30" veya "1 Kasım 2026"
  m = text.toLowerCase().match(/(\d{1,2})\s+([a-zçğıöşü]+)\s+(20\d{2})(?:\s+(\d{1,2}):(\d{2}))?/i);
  if (m) {
    const day = parseInt(m[1], 10);
    const monIdx = MONTHS_TR[m[2].toLowerCase()];
    const year = parseInt(m[3], 10);
    const hh = m[4] ? String(m[4]).padStart(2, '0') : '12';
    const mm = m[5] ? String(m[5]).padStart(2, '0') : '00';
    if (!isNaN(day) && monIdx !== undefined && !isNaN(year)) {
      const monStr = String(monIdx + 1).padStart(2, '0');
      const dayStr = String(day).padStart(2, '0');
      return new Date(`${year}-${monStr}-${dayStr}T${hh}:${mm}:00+03:00`);
    }
  }

  return null;
}

// ===================================================
// PLAYWRIGHT OTURUM AÇMA (LOGIN)
// ===================================================
async function loginToOksijen(page) {
  if (!OXY_EMAIL || !OXY_PASSWORD) {
    log('⚠️ OXY_EMAIL veya OXY_PASSWORD tanımlı değil! Giriş yapılmadan devam ediliyor.');
    return false;
  }

  log(`🔐 Gazete Oksijen hesabına giriş yapılıyor (${OXY_EMAIL.substring(0, 3)}***)...`);
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
    await sleep(2000);

    const loginTrigger = page.locator('a:has-text("Giriş yap"), button:has-text("Giriş yap"), [data-bs-target*="login"], .login-btn').first();
    if (await loginTrigger.count() > 0) {
      await loginTrigger.click({ timeout: 8000 }).catch(() => {});
      await sleep(1200);
    }

    const emailInput = page.locator('.login input[type="email"], input[placeholder*="E-posta"], input[type="email"]').first();
    const passInput = page.locator('.login input[type="password"], input[placeholder*="Şifre"], input[type="password"]').first();

    await emailInput.waitFor({ state: 'visible', timeout: 10000 });
    await emailInput.fill(OXY_EMAIL);
    await sleep(400);
    await passInput.fill(OXY_PASSWORD);
    await sleep(400);

    const submitBtn = page.locator('.login form .submit-button button, .login button[type="submit"], button:has-text("GİRİŞ YAP")').first();
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {}),
      submitBtn.click()
    ]);

    await sleep(2500);
    log('✅ Oksijen oturumu başarıyla açıldı.');
    return true;
  } catch (err) {
    log(`⚠️ Giriş sırasında uyarı (devam ediliyor): ${err.message}`);
    return false;
  }
}

// ===================================================
// KATEGORİ VE MAKALE ÇEKME
// ===================================================
async function fetchCategoryLinks(page, slug) {
  const seen = new Set();
  const links = [];

  for (let p = 1; p <= PAGES_PER_CAT; p++) {
    const url = p === 1 ? `${BASE}/${slug}` : `${BASE}/${slug}?page=${p}`;
    log(`🔗 Kategori taranıyor: ${slug} (Sayfa ${p}/${PAGES_PER_CAT})`);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
      await sleep(1500);

      const html = await page.content();
      const $ = cheerio.load(html);

      $('a[href]').each((_, el) => {
        let href = ($(el).attr('href') || '').trim();
        if (!href || href.startsWith('javascript') || href.startsWith('#')) return;
        if (href.startsWith('/')) href = BASE + href;
        if (!href.startsWith(BASE)) return;

        const clean = href.split('?')[0].split('#')[0];
        if (clean === `${BASE}/${slug}` || clean === BASE) return;

        // Sadece bu kategoriye ait makale linklerini veya sonu haber ID'si (-294567 gibi) ile bitenleri al
        const isCatPath = clean.startsWith(`${BASE}/${slug}/`);
        const endsWithId = /-\d{4,}$/.test(clean);

        if (!isCatPath && !endsWithId) return;
        if (
          clean.includes('/kategori/') ||
          clean.includes('/foto-galeri/') ||
          clean.includes('/yazarlar/') ||
          clean.endsWith('/yazarlar')
        ) {
          return;
        }

        if (!seen.has(clean)) {
          seen.add(clean);
          links.push(clean);
        }
      });
    } catch (err) {
      log(`⚠️ Kategori ${slug} (Sayfa ${p}) hatası: ${err.message}`);
    }
  }

  return links;
}

function cleanCopyrightAndJunk(paragraphs, title) {
  const titleLower = norm(title).toLowerCase();
  const cutMarkers = [
    '* Bu haber/yazı',
    'Bu haber/yazı ve resimlerin eser sahipliğinden doğan tüm hakları',
    'Haftalık Yayıncılık Anonim Şirketi'
  ];
  const junkPatterns = [
    /^Tüm Yazıları$/i,
    /^Paylaş$/i,
    /^A\+\s*Yazı Boyutunu Büyüt$/i,
    /^A-\s*Yazı Boyutunu Küçült$/i,
    /^Kaydet$/i,
    /^Yazdır$/i,
    /^Abone Ol$/i,
    /^Haber Giriş:/i,
    /^Son Güncelleme:/i
  ];

  const out = [];
  for (const raw of paragraphs) {
    const txt = norm(
      String(raw || '')
        .replace(/A\+\s*Yazı Boyutunu Büyüt/gi, '')
        .replace(/A-\s*Yazı Boyutunu Küçült/gi, '')
    );
    if (!txt || txt.length < 10) continue;
    if (cutMarkers.some(m => txt.includes(m))) break;
    if (junkPatterns.some(rx => rx.test(txt))) continue;
    if (out.length === 0 && txt.toLowerCase() === titleLower) continue;
    if (out.length > 0 && out[out.length - 1] === txt) continue;
    out.push(txt);
  }
  return out;
}

function extractArticleContent($, title) {
  const $clone = $.root().clone();
  $clone.find([
    'script', 'style', 'noscript', 'iframe', 'svg', 'header', 'footer', 'nav', 'button',
    '.paywall-notice', '.article-share', '.social-share', '.related-news',
    '.ads-container', '.advertisement', '.ad', '.tags', '[class*="reklam"]', '[id*="ad-"]'
  ].join(',')).remove();

  // Gazete Oksijen makale gövdesi öncelikle .resizable-text içinde yer alır
  const selectors = [
    '.resizable-text',
    '.article-content',
    '.news-detail-text',
    '.news-content',
    '.detail-content',
    'article .content',
    '[itemprop="articleBody"]',
    'main article',
    'article'
  ];

  let $container = null;
  for (const sel of selectors) {
    const candidate = $clone.find(sel).first();
    if (candidate.length > 0 && norm(candidate.text()).length > 120) {
      $container = candidate;
      break;
    }
  }
  if (!$container) $container = $clone.find('body');

  const rawBlocks = [];
  $container.find('p, h2, h3, h4, blockquote, li').each((_, el) => {
    const txt = norm($(el).text());
    if (!txt || txt.length < 10) return;
    const tag = (el.name || 'p').toLowerCase();
    rawBlocks.push({ tag, txt });
  });

  if (rawBlocks.length === 0) {
    const fallbackLines = norm($container.text()).split(/\n+/).map(norm).filter(t => t.length > 15);
    fallbackLines.forEach(txt => rawBlocks.push({ tag: 'p', txt }));
  }

  const cleanedTexts = cleanCopyrightAndJunk(rawBlocks.map(b => b.txt), title);
  const cleanedSet = new Set(cleanedTexts);

  let html = '';
  const used = new Set();
  for (const b of rawBlocks) {
    if (!cleanedSet.has(b.txt)) continue;
    const key = `${b.tag}:${b.txt}`;
    if (used.has(key)) continue;
    used.add(key);

    if (b.tag.startsWith('h')) {
      html += `<${b.tag}>${htmlEscape(b.txt)}</${b.tag}>\n`;
    } else if (b.tag === 'blockquote') {
      html += `<blockquote><p>${htmlEscape(b.txt)}</p></blockquote>\n`;
    } else {
      html += `<p>${htmlEscape(b.txt)}</p>\n`;
    }
  }

  return html.trim();
}

async function fetchArticle(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
    await sleep(RENDER_WAIT_MS);

    const html = await page.content();
    const $ = cheerio.load(html);

    const title =
      norm($('h1').first().text()) ||
      norm($('meta[property="og:title"]').attr('content')) ||
      norm($('title').text());
    if (!title || title.length < 5) return null;

    const summary = norm($('.news-spot, .spot, .lead, .summary, article h2').first().text());
    const author = norm(
      $('meta[name="author"]').attr('content') ||
      $('.author-name, .yazar-adi, .writer, [rel="author"]').first().text() ||
      ''
    );

    // 1) Sayfa içindeki "Haber Giriş: 31.10.2026 23:10" bilgisini yakala (en güvenilir)
    let dateObj = null;
    const bodyText = norm($('body').text());
    const haberGirisMatch = bodyText.match(/Haber\s+Giriş\s*:\s*(\d{1,2}\.\d{1,2}\.20\d{2}(?:\s+\d{1,2}:\d{2})?)/i);
    if (haberGirisMatch) {
      dateObj = parseTurkishDate(haberGirisMatch[1]);
    }

    // 2) Meta etiketlerinden yakala
    if (!dateObj || isNaN(dateObj.getTime())) {
      const metaPublished =
        $('meta[property="article:published_time"]').attr('content') ||
        $('meta[name="datePublished"]').attr('content') ||
        $('time[datetime]').attr('datetime') ||
        '';
      if (metaPublished) {
        dateObj = parseTurkishDate(metaPublished);
      }
    }

    // 3) JSON-LD içinden datePublished yakala (@graph dahil)
    if (!dateObj || isNaN(dateObj.getTime())) {
      $('script[type="application/ld+json"]').each((_, el) => {
        if (dateObj && !isNaN(dateObj.getTime())) return;
        const rawJson = $(el).html() || '';
        const dpMatch = rawJson.match(/"datePublished"\s*:\s*"([^"]+)"/);
        if (dpMatch) {
          const parsed = parseTurkishDate(dpMatch[1]);
          if (parsed && !isNaN(parsed.getTime())) {
            dateObj = parsed;
          }
        }
      });
    }

    // 4) Genel tarih formatı yedeği
    if (!dateObj || isNaN(dateObj.getTime())) {
      const m1 = bodyText.match(/\b(\d{1,2}\.\d{1,2}\.20\d{2}\s+\d{1,2}:\d{2})\b/);
      if (m1) dateObj = parseTurkishDate(m1[1]);
    }

    const contentHtml = extractArticleContent($, title);
    if (!contentHtml || contentHtml.length < 80) {
      log(`  ⚠️ İçerik kısa veya boş (${url.split('/').pop()})`);
      return null;
    }

    return {
      url,
      title,
      summary: summary && summary !== title ? summary : '',
      author,
      date: dateObj,
      contentHtml
    };
  } catch (err) {
    log(`  ⚠️ Makale çekilemedi (${url}): ${err.message}`);
    return null;
  }
}

async function scrapeAll() {
  const cutoff = new Date(Date.now() - HOURS_LOOKBACK * 3600 * 1000);
  log(`⏰ Zaman sınırı: Son ${HOURS_LOOKBACK} saat (${cutoff.toISOString()} sonrası)`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });

  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
    viewport: { width: 1366, height: 900 }
  });

  const page = await context.newPage();

  const result = [];
  const seenUrls = new Set();

  try {
    await loginToOksijen(page);

    for (const cat of CATEGORIES) {
      log(`\n📂 ${cat.name} kategorisi işleniyor...`);
      const links = await fetchCategoryLinks(page, cat.slug);
      log(`  └ ${links.length} aday bağlantı bulundu.`);

      const categoryArticles = [];
      let oldStreak = 0;

      for (const link of links) {
        if (seenUrls.has(link)) continue;
        seenUrls.add(link);

        await sleep(FETCH_DELAY_MS);
        const art = await fetchArticle(page, link);
        if (!art) continue;

        if (art.date && !isNaN(art.date.getTime())) {
          if (art.date < cutoff) {
            oldStreak++;
            log(`  ⏭️ Eski haber atlandı (${art.date.toISOString()}): ${art.title.substring(0, 45)}...`);
            // Üst üste 8 eski habere denk geldiysek bu kategorideki daha eski haberleri taramayı bırak
            if (oldStreak >= 8) {
              log(`  ⏹️ ${cat.name} kategorisinde zaman sınırının altına inildi, sonraki kategoriye geçiliyor.`);
              break;
            }
            continue;
          }
          oldStreak = 0;
        }

        categoryArticles.push(art);
        const dateTag = art.date ? art.date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Istanbul' }) : 'Saat yok';
        log(`  ✅ [${cat.name} - ${dateTag}] ${art.title.substring(0, 55)}...`);
      }

      if (categoryArticles.length > 0) {
        result.push({
          cat,
          articles: categoryArticles
        });
      }
    }
  } finally {
    await browser.close();
  }

  return result;
}

// ===================================================
// EPUB ÜRETİCİ
// ===================================================
async function buildEpub(groupedData, dateStr, hourStr) {
  const zip = new JSZip();

  const totalArticles = groupedData.reduce((sum, g) => sum + g.articles.length, 0);

  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

  const css = `
body { font-family: Georgia, serif; margin: 1.2em; line-height: 1.65; color: #111; }
h1 { font-family: sans-serif; font-size: 1.55em; margin-bottom: 0.35em; line-height: 1.3; }
h2, h3 { font-family: sans-serif; font-size: 1.25em; margin-top: 1.2em; margin-bottom: 0.4em; }
p { margin: 0 0 1em 0; text-align: justify; }
blockquote { margin: 1em 0; padding-left: 1em; border-left: 3px solid #ccc; font-style: italic; }
.summary { font-size: 1.05em; font-weight: bold; color: #333; margin-bottom: 1.3em; border-bottom: 1px solid #ddd; padding-bottom: 0.8em; }
.meta { font-family: sans-serif; font-size: 0.85em; color: #666; margin-bottom: 1em; }
.meta a { color: #2c7be5; text-decoration: none; }

.cover-container { font-family: sans-serif; text-align: center; padding: 3em 1em; }
.cover-title { font-size: 2.8em; font-weight: bold; color: #111; margin-bottom: 0.2em; letter-spacing: -1px; }
.cover-sub { font-size: 1.1em; color: #555; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 2em; }
.cover-badge { display: inline-block; background: #2c7be5; color: #fff; padding: 0.5em 1.2em; border-radius: 20px; font-weight: bold; font-size: 0.9em; margin-bottom: 2em; }
.cover-date { font-size: 1.4em; font-weight: bold; color: #222; margin-bottom: 0.3em; }
.cover-time { font-size: 1em; color: #666; }

.cat-divider { font-family: sans-serif; text-align: center; padding: 5em 1em; }
.cat-divider h1 { font-size: 2.4em; color: #111; border-bottom: 3px solid #2c7be5; display: inline-block; padding-bottom: 0.2em; }
.cat-divider p { text-align: center; color: #666; margin-top: 1em; }

.toc-title { font-family: sans-serif; font-size: 2em; margin-bottom: 1em; border-bottom: 2px solid #2c7be5; padding-bottom: 0.3em; }
.toc-cat { font-family: sans-serif; font-weight: bold; font-size: 1.2em; color: #2c7be5; margin-top: 1.5em; margin-bottom: 0.5em; }
.toc-list { font-family: sans-serif; list-style: none; padding-left: 0; margin: 0; }
.toc-list li { margin-bottom: 0.6em; }
.toc-list a { text-decoration: none; color: #222; font-size: 1em; }
`;
  zip.file('OEBPS/styles.css', css);

  const catSummaryLine = groupedData.map(g => g.cat.name).join(' · ');
  const coverXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="tr">
<head>
  <title>Kapak</title>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
  <div class="cover-container">
    <div class="cover-title">OKSİJEN</div>
    <div class="cover-sub">${htmlEscape(catSummaryLine)}</div>
    <div class="cover-badge">${totalArticles} Makale</div>
    <div class="cover-date">${htmlEscape(dateStr)}</div>
    <div class="cover-time">Saat: ${htmlEscape(hourStr)}</div>
  </div>
</body>
</html>`;
  zip.file('OEBPS/cover.xhtml', coverXhtml);

  let tocListHtml = '';
  groupedData.forEach((g, catIdx) => {
    tocListHtml += `<div class="toc-cat" style="color: ${g.cat.color};">${htmlEscape(g.cat.name)}</div>\n<ul class="toc-list">\n`;
    g.articles.forEach((art, artIdx) => {
      tocListHtml += `  <li><a href="art_${catIdx}_${artIdx}.xhtml">${htmlEscape(art.title)}</a></li>\n`;
    });
    tocListHtml += `</ul>\n`;
  });

  const tocXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="tr">
<head>
  <title>İçindekiler</title>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
  <div class="toc-title">İçindekiler</div>
  ${tocListHtml}
</body>
</html>`;
  zip.file('OEBPS/toc.xhtml', tocXhtml);

  const manifestItems = [
    `<item id="css" href="styles.css" media-type="text/css"/>`,
    `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
    `<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>`,
    `<item id="toc_page" href="toc.xhtml" media-type="application/xhtml+xml"/>`
  ];

  const spineItems = [
    `<itemref idref="cover"/>`,
    `<itemref idref="toc_page"/>`
  ];

  let ncxNavPoints = `
    <navPoint id="navPoint-cover" playOrder="1">
      <navLabel><text>Kapak</text></navLabel>
      <content src="cover.xhtml"/>
    </navPoint>
    <navPoint id="navPoint-toc" playOrder="2">
      <navLabel><text>İçindekiler</text></navLabel>
      <content src="toc.xhtml"/>
    </navPoint>
  `;

  let playOrder = 3;

  groupedData.forEach((g, catIdx) => {
    const catFileId = `cat_${catIdx}`;
    const catFileName = `cat_${catIdx}.xhtml`;

    const catXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="tr">
<head>
  <title>${htmlEscape(g.cat.name)}</title>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
  <div class="cat-divider">
    <h1 style="border-color: ${g.cat.color}">${htmlEscape(g.cat.name)}</h1>
    <p>${g.articles.length} Makale</p>
  </div>
</body>
</html>`;
    zip.file(`OEBPS/${catFileName}`, catXhtml);
    manifestItems.push(`<item id="${catFileId}" href="${catFileName}" media-type="application/xhtml+xml"/>`);
    spineItems.push(`<itemref idref="${catFileId}"/>`);

    let catNcx = `
    <navPoint id="navPoint-${catFileId}" playOrder="${playOrder++}">
      <navLabel><text>📂 ${htmlEscape(g.cat.name)}</text></navLabel>
      <content src="${catFileName}"/>`;

    g.articles.forEach((art, artIdx) => {
      const artFileId = `art_${catIdx}_${artIdx}`;
      const artFileName = `art_${catIdx}_${artIdx}.xhtml`;
      const authorPart = art.author ? ` · <span>${htmlEscape(art.author)}</span>` : '';

      const artXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="tr">
<head>
  <title>${htmlEscape(art.title)}</title>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
  <h1>${htmlEscape(art.title)}</h1>
  <div class="meta">
    <span style="color: ${g.cat.color}; font-weight: bold;">${htmlEscape(g.cat.name)}</span>${authorPart} · 
    <a href="${htmlEscape(art.url)}">Kaynağa Git</a>
  </div>
  ${art.summary ? `<div class="summary">${htmlEscape(art.summary)}</div>` : ''}
  <div class="article-body">
    ${art.contentHtml}
  </div>
</body>
</html>`;
      zip.file(`OEBPS/${artFileName}`, artXhtml);
      manifestItems.push(`<item id="${artFileId}" href="${artFileName}" media-type="application/xhtml+xml"/>`);
      spineItems.push(`<itemref idref="${artFileId}"/>`);

      catNcx += `
      <navPoint id="navPoint-${artFileId}" playOrder="${playOrder++}">
        <navLabel><text>${htmlEscape(art.title)}</text></navLabel>
        <content src="${artFileName}"/>
      </navPoint>`;
    });

    catNcx += `\n    </navPoint>`;
    ncxNavPoints += catNcx;
  });

  const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>Oksijen Günlük – ${htmlEscape(dateStr)}</dc:title>
    <dc:creator opf:role="aut">Gazete Oksijen</dc:creator>
    <dc:language>tr</dc:language>
    <dc:identifier id="BookId">urn:uuid:oksijen-${Date.now()}</dc:identifier>
    <meta name="cover" content="cover"/>
  </metadata>
  <manifest>
    ${manifestItems.join('\n    ')}
  </manifest>
  <spine toc="ncx">
    ${spineItems.join('\n    ')}
  </spine>
  <guide>
    <reference type="cover" title="Kapak" href="cover.xhtml"/>
    <reference type="toc" title="İçindekiler" href="toc.xhtml"/>
  </guide>
</package>`;
  zip.file('OEBPS/content.opf', contentOpf);

  const tocNcx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:oksijen-${Date.now()}"/>
    <meta name="dtb:depth" content="2"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle>
    <text>Oksijen Günlük – ${htmlEscape(dateStr)}</text>
  </docTitle>
  <navMap>
    ${ncxNavPoints}
  </navMap>
</ncx>`;
  zip.file('OEBPS/toc.ncx', tocNcx);

  const base64 = await zip.generateAsync({ type: 'base64' });
  return base64;
}

// ===================================================
// GOOGLE DRIVE YÜKLEME (RETRY İLE)
// ===================================================
async function uploadToDrive(base64Content, fileName) {
  log(`☁️ Google Drive'a yükleniyor: ${fileName}...`);

  const maxAttempts = 3;
  const delays = [5000, 15000, 30000];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      log(`   Deneme ${attempt}/${maxAttempts}...`);

      const res = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: base64Content, filename: fileName })
      });

      log(`   ✓ HTTP ${res.status}`);

      if (res.ok) {
        const text = await res.text();
        log(`   Cevap: ${text.substring(0, 200)}`);
        return true;
      }

      if (attempt < maxAttempts) {
        const wait = delays[attempt - 1];
        log(`   ⚠️ HTTP ${res.status} – ${wait / 1000} sn sonra tekrar denenecek...`);
        await sleep(wait);
      }
    } catch (e) {
      log(`   ⚠️ Deneme ${attempt} hata: ${e.message}`);
      if (attempt < maxAttempts) {
        const wait = delays[attempt - 1];
        log(`   ${wait / 1000} sn sonra tekrar denenecek...`);
        await sleep(wait);
      }
    }
  }

  log(`   ❌ ${maxAttempts} deneme başarısız oldu`);
  return false;
}

// ===================================================
// ANA AKIŞ
// ===================================================
async function main() {
  log('🚀 Oksijen Günlük EPUB v3.1 başladı');
  const startTime = Date.now();

  const grouped = await scrapeAll();
  const totalArticles = grouped.reduce((sum, g) => sum + g.articles.length, 0);
  if (totalArticles === 0) {
    log(`⚠️ Son ${HOURS_LOOKBACK} saat içinde yeni makale bulunamadı.`);
    process.exit(0);
  }

  log(`📚 Toplam ${totalArticles} makale toplandı:`);
  grouped.forEach(g => log(`  • ${g.cat.name}: ${g.articles.length}`));

  const now = new Date();
  const dateStr = now.toLocaleDateString('tr-TR', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Istanbul'
  });
  const hourUTC = now.getUTCHours();
  const hourTR = (hourUTC + 3) % 24;
  const hourSafe = String(hourTR).padStart(2, '0');
  const displayHour = `${hourSafe}:00 TR`;
  const fileDate = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Istanbul' });

  log('📦 EPUB üretiliyor...');
  const base64 = await buildEpub(grouped, dateStr, displayHour);
  const sizeMB = (base64.length * 0.75 / 1024 / 1024).toFixed(2);
  log(`   ✓ EPUB hazır (~${sizeMB} MB)`);

  const catPart = CATEGORIES.map(c => safeFileName(c.name).replace(/\s+/g, '')).join('-');
  const fileName = `Oksijen_${catPart}_${fileDate}_${hourSafe}-00.epub`;

  fs.writeFileSync(path.join(process.cwd(), fileName), Buffer.from(base64, 'base64'));
  log(`💾 Dosya diske kaydedildi: ${fileName}`);

  const ok = await uploadToDrive(base64, fileName);

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  if (ok) {
    log(`✅ TAMAM – ${fileName} – ${duration}s`);
    process.exit(0);
  } else {
    log(`❌ Drive yükleme başarısız`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('💥 Kritik hata:', err);
  process.exit(1);
});
