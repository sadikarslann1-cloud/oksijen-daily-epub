/**
 * T24 Günlük EPUB Üretici — v1.5
 * - 4 kategori: Son Dakika, Gündem, Ekonomi, Dünya
 * - Kategoriye göre gruplu sıralama
 * - Kitap içi İçindekiler + kategori ayraçları (renkli)
 * - T24 kırmızı kapak
 * - 12 saat filtre, max 20/kategori, min 300 kr
 * - Duplicate engelle, URL query temizle
 * - Paywall atla
 * - Drive yükleme 3 deneme retry
 */

const JSZip = require('jszip');
const cheerio = require('cheerio');

// ==========================================
// AYARLAR
// ==========================================
const BASE = 'https://t24.com.tr';

const CATEGORIES = [
    { name: 'Son Dakika', slug: 'son-dakika', color: '#e74c3c' },
    { name: 'Gündem',     slug: 'gundem',     color: '#2c3e50' },
    { name: 'Ekonomi',    slug: 'ekonomi',    color: '#27ae60' },
    { name: 'Dünya',      slug: 'dunya',      color: '#3498db' }
];

const HOURS_LOOKBACK = 12;
const MAX_PER_CATEGORY = 20;
const MIN_ARTICLE_LENGTH = 300;
const FETCH_DELAY_MS = 400;
const REQUEST_TIMEOUT_MS = 15000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const APPS_SCRIPT_URL = process.env.OXY_SCRIPT_URL;
if (!APPS_SCRIPT_URL) {
    console.error('❌ OXY_SCRIPT_URL ortam değişkeni tanımlı değil!');
    process.exit(1);
}

// ==========================================
// YARDIMCILAR
// ==========================================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function norm(text) {
    return String(text || '')
        .replace(/\u00A0/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\r/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function htmlEscape(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function safeFileName(s) {
    return String(s || 'T24')
        .replace(/[\\/:*?"<>|]+/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 120);
}

function cleanUrl(url) {
    try {
        const u = new URL(url);
        u.search = '';
        u.hash = '';
        return u.href;
    } catch (e) {
        return url;
    }
}

function wrapText(items, maxChars) {
    const lines = [];
    let current = '';
    for (const item of items) {
        const candidate = current ? current + ' · ' + item : item;
        if (candidate.length > maxChars) {
            if (current) lines.push(current);
            current = item;
        } else {
            current = candidate;
        }
    }
    if (current) lines.push(current);
    return lines;
}

async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            ...options,
            signal: controller.signal,
            headers: {
                'User-Agent': USER_AGENT,
                'Accept-Language': 'tr,en;q=0.9',
                ...(options.headers || {})
            }
        });
        clearTimeout(timer);
        return res;
    } catch (e) {
        clearTimeout(timer);
        throw e;
    }
}

// ==========================================
// İÇERİK TEMİZLEME KURALLARI
// ==========================================
const STOP_MARKERS = ['t24. tüm hakları saklıdır.'];

const BAD_LINE_PATTERNS = [
    /^yazar:/i, /^tarih:/i, /^kaynak:/i, /^güncelleme:/i,
    /^e-posta gönder$/i, /^linki kopyala$/i,
    /^facebook$/i, /^twitter$/i, /^whatsapp$/i, /^linkedin$/i,
    /^instagram$/i, /^youtube$/i, /^x$/i, /paylaş$/i,
    /^\d{1,2}\s+[a-zçğıöşü]+\s+\d{4}/i,
    /^t24 yazarı$/i, /^t24 haftalık yazarı$/i, /^konuk yazar$/i,
    /dünya basınında bugün/i, /editörün seçtikleri arşivi/i,
    /^BU HABERİ, T24 ABONELERİNİN DE SAĞLADIĞI KATKIYLA OKUYORSUNUZ\.?$/i,
    /^T24'E ABONE OL,?\s*$/i,
    /^BAĞIMSIZ GAZETECİLİĞİ DESTEKLE!?\s*$/i,
    /^ABONE OL\s*$/i,
    /^Zaten abone misiniz\? Üye girişi yapın\.?\s*$/i
];

const JUNK_SELECTORS = [
    'script', 'style', 'noscript', 'iframe', 'svg', 'video', 'audio',
    'form', 'button', 'nav', 'footer', 'aside', 'table',
    '.article-tags', '.share', '.social', '.related', '.comments',
    '.advertisement', '.ads', '[class*="banner"]', '[class*="reklam"]',
    '.t24-subscription-callout', '.t24-subscription-callout-login',
    '[class*="subscription-callout"]', '[class*="abone-ol"]', '[class*="abone"]',
    '.main-menu-slider', '.consent-modal', '.story-header',
    '.story-share', '.story-footer'
];

const PAYWALL_SELECTORS = [
    '.t24-article-paywall',
    '.t24-article-paywall-cta-top',
    '[class*="paywall"]'
];

function isStopLine(line) {
    const lower = line.toLowerCase();
    return STOP_MARKERS.some(m => lower.startsWith(m));
}

function isBadLine(line, title) {
    const raw = line.trim();
    if (!raw || raw.length < 10) return true;
    if (isStopLine(raw)) return true;
    if (BAD_LINE_PATTERNS.some(re => re.test(raw))) return true;
    if (title && raw === title.trim()) return true;
    return false;
}

function cleanParagraphs(lines, title) {
    const out = [];
    const seen = new Set();
    for (const line of lines) {
        const cleaned = norm(line);
        if (!cleaned || cleaned.length < 10) continue;
        if (isStopLine(cleaned)) break;
        if (isBadLine(cleaned, title)) continue;
        const key = cleaned.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(cleaned);
    }
    return out;
}

// ==========================================
// LİNK FİLTRE
// ==========================================
function t24LinkFilter(href) {
    if (!href || !href.includes('t24.com.tr')) return false;
    if (!href.match(/,\d{5,}$/)) return false;
    const isMain = href === 'https://t24.com.tr/' ||
        CATEGORIES.some(c => href.endsWith('/' + c.slug));
    return !isMain;
}

// ==========================================
// KATEGORİ LİNK TARAMA
// ==========================================
async function fetchCategoryLinks(slug) {
    const url = `${BASE}/${slug}`;
    log(`📂 Kategori taranıyor: ${slug}`);
    try {
        const res = await fetchWithTimeout(url);
        if (!res.ok) { log(`   ⚠️ HTTP ${res.status}`); return []; }
        const html = await res.text();
        const $ = cheerio.load(html);

        const links = [];
        const seen = new Set();
        $('a').each((_, el) => {
            const $el = $(el);
            let href = $el.attr('href');
            if (!href || href.startsWith('javascript')) return;
            try { href = new URL(href, BASE).href; } catch { return; }
            href = cleanUrl(href);

            if (!t24LinkFilter(href)) return;
            if (seen.has(href)) return;
            seen.add(href);

            let title = norm($el.text());
            if (!title) {
                const img = $el.find('img').first();
                if (img.length && img.attr('alt')) title = norm(img.attr('alt'));
            }
            if (title.length < 15) return;

            links.push({ url: href, title: title.substring(0, 200) });
        });

        log(`   ✅ ${links.length} link bulundu`);
        return links;
    } catch (e) {
        log(`   ❌ Hata: ${e.message}`);
        return [];
    }
}

// ==========================================
// MAKALE İÇERİK ÇIKARMA (Hibrit)
// ==========================================
function extractArticleContent($, title) {
    // 1. Container adayları (öncelikli → yedek → son çare)
    let $container = $('section.haberdetay').first();
    if (!$container.length) $container = $('.story-content').first();
    if (!$container.length) $container = $('body');

    // 2. Junk temizle
    JUNK_SELECTORS.forEach(sel => {
        try { $container.find(sel).remove(); } catch (e) {}
    });

    // 3. Paragrafları topla
    const rawTexts = [];
    $container.find('p, h2, h3, h4, blockquote, li').each((_, el) => {
        const text = norm($(el).text());
        if (text.length > 10) rawTexts.push(text);
    });

    // 4. Fallback: paragraf az ise text node'ları kullan
    if (rawTexts.length < 3) {
        const raw = norm($container.text());
        raw.split(/\n+/).forEach(p => {
            if (p.length > 20) rawTexts.push(p);
        });
    }

    return cleanParagraphs(rawTexts, title).filter(p => p.length > 15);
}

async function fetchArticle(url, title, catObj) {
    try {
        const res = await fetchWithTimeout(url);
        if (!res.ok) return null;
        const html = await res.text();
        const $ = cheerio.load(html);

        // Paywall kontrolü
        for (const sel of PAYWALL_SELECTORS) {
            if ($(sel).length > 0) return null;
        }

        // Tarih
        let publishedAt = null;
        const metaDate = $('meta[property="article:published_time"]').attr('content');
        if (metaDate) publishedAt = new Date(metaDate);
        if (!publishedAt || isNaN(publishedAt.getTime())) return null;

        // Başlık (og:title öncelikli)
        const ogTitle = $('meta[property="og:title"]').attr('content');
        const finalTitle = norm(ogTitle) || title;

        // İçerik
        const content = extractArticleContent($, finalTitle);
        if (!content || content.length === 0) return null;

        // Min uzunluk
        const totalLength = content.join(' ').length;
        if (totalLength < MIN_ARTICLE_LENGTH) return null;

        // Tarih/saat formatı
        const trDate = publishedAt.toLocaleDateString('tr-TR', {
            day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Istanbul'
        });
        const trTime = publishedAt.toLocaleTimeString('tr-TR', {
            hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Istanbul'
        });

        return {
            url,
            title: finalTitle,
            content,
            catName: catObj.name,
            catColor: catObj.color,
            source: 'T24',
            publishDateStr: `${trDate} · ${trTime}`,
            fullDateObj: publishedAt
        };
    } catch (e) {
        log(`   ⚠️ Makale hata: ${e.message}`);
        return null;
    }
}

// ==========================================
// ANA TARAMA
// ==========================================
async function scrapeAll() {
    const grouped = [];
    const seenUrls = new Set(); // Kategoriler arası duplicate
    const cutoff = new Date(Date.now() - HOURS_LOOKBACK * 3600000);

    for (const cat of CATEGORIES) {
        const links = await fetchCategoryLinks(cat.slug);
        log(`📝 ${cat.name}: ${links.length} link taranıyor...`);

        const catArticles = [];
        for (let i = 0; i < links.length; i++) {
            const { url, title } = links[i];
            if (seenUrls.has(url)) continue;
            seenUrls.add(url);

            const article = await fetchArticle(url, title, cat);
            if (!article) { await sleep(FETCH_DELAY_MS); continue; }
            if (article.fullDateObj < cutoff) { await sleep(50); continue; }

            catArticles.push(article);
            log(`   ✓ ${catArticles.length}. [${cat.name}] ${article.title.substring(0, 60)}`);
            await sleep(FETCH_DELAY_MS);

            if (catArticles.length >= MAX_PER_CATEGORY) {
                log(`   ⏹️ ${cat.name}: ${MAX_PER_CATEGORY} makale sınırına ulaşıldı`);
                break;
            }
        }

        catArticles.sort((a, b) => b.fullDateObj - a.fullDateObj);
        log(`✅ ${cat.name}: ${catArticles.length} makale alındı`);
        grouped.push({ cat, articles: catArticles });
    }
    return grouped;
}

// ==========================================
// EPUB ÜRETİMİ
// ==========================================
async function buildEpub(grouped, displayDate, displayHour) {
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.folder('META-INF').file('container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

    const oebps = zip.folder('OEBPS');
    const today = new Date().toISOString().split('T')[0];
    const totalArticles = grouped.reduce((sum, g) => sum + g.articles.length, 0);
    const activeCats = grouped.filter(g => g.articles.length > 0);
    const catNames = activeCats.map(g => g.cat.name);

    // ============ KAPAK ============
    const coverLines = wrapText(catNames, 42);
    const coverSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 800" width="100%" height="100%">
  <rect width="600" height="800" fill="#e74c3c"/>
  <rect width="500" height="650" x="50" y="75" fill="#ffffff" rx="10"/>
  <text x="300" y="240" font-family="Arial,sans-serif" font-size="110" font-weight="900" fill="#e74c3c" text-anchor="middle">T24</text>
  <line x1="200" y1="290" x2="400" y2="290" stroke="#e74c3c" stroke-width="3"/>
  ${coverLines.map((line, i) =>
    `<text x="300" y="${350 + i * 32}" font-family="Arial,sans-serif" font-size="18" fill="#333333" text-anchor="middle">${htmlEscape(line)}</text>`
  ).join('\n  ')}
  <text x="300" y="530" font-family="Arial,sans-serif" font-size="26" font-weight="bold" fill="#111111" text-anchor="middle">${totalArticles} makale</text>
  <text x="300" y="620" font-family="Arial,sans-serif" font-size="20" fill="#666666" text-anchor="middle">${htmlEscape(displayDate)}</text>
  <text x="300" y="655" font-family="Arial,sans-serif" font-size="16" fill="#999999" text-anchor="middle">${htmlEscape(displayHour)}</text>
</svg>`;

    oebps.file('cover.svg', coverSvg);
    oebps.file('cover.xhtml', `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Kapak</title><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;text-align:center;height:100%;">
  <img src="cover.svg" alt="Kapak" style="max-width:100%;max-height:100%;"/>
</body></html>`);

    // ============ KİTAP İÇİ İÇİNDEKİLER ============
    const tocItemsHtml = activeCats.map((g, i) => {
        const catFile = `cat${i + 1}.xhtml`;
        return `<li style="margin: 14px 0; list-style: none;">
      <a href="${catFile}" style="text-decoration: none; color: #333; display: flex; align-items: center; padding: 10px 14px; background: #f8f8f8; border-radius: 6px; border-left: 4px solid ${g.cat.color};">
        <b style="flex: 1; font-size: 1.05em;">${htmlEscape(g.cat.name)}</b>
        <span style="color: #888; font-size: 0.9em;">${g.articles.length} makale →</span>
      </a>
    </li>`;
    }).join('\n');

    oebps.file('toc.xhtml', `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>İçindekiler</title><meta charset="utf-8"/>
<style>
  body { font-family: sans-serif; padding: 40px 20px; }
  h1 { text-align: center; color: #333; padding-bottom: 20px; border-bottom: 2px solid #eee; }
  ul { padding: 0; max-width: 500px; margin: 30px auto; }
</style>
</head>
<body>
  <h1>İçindekiler</h1>
  <ul>${tocItemsHtml}</ul>
</body></html>`);

    // ============ MANIFEST / SPINE / NAVMAP ============
    let manifest = `
<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
<item id="cover-image" href="cover.svg" media-type="image/svg+xml"/>
<item id="toc-page" href="toc.xhtml" media-type="application/xhtml+xml"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`;

    let spine = `
<itemref idref="cover"/>
<itemref idref="toc-page"/>`;

    let navMap = `
<navPoint id="nav-toc" playOrder="1">
  <navLabel><text>İçindekiler</text></navLabel>
  <content src="toc.xhtml"/>
</navPoint>`;

    let playOrder = 2;
    let itemCounter = 0;

    // ============ KATEGORİ AYRAÇLARI + MAKALELER ============
    activeCats.forEach((g, gi) => {
        const catId = `cat${gi + 1}`;
        const catFile = `cat${gi + 1}.xhtml`;

        const catHtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${htmlEscape(g.cat.name)}</title><meta charset="utf-8"/>
<style>
  body { margin: 0; padding: 0; }
  .divider { background: ${g.cat.color}; color: white; min-height: 95vh; padding: 100px 40px 40px; text-align: center; box-sizing: border-box; }
  .cat-name { color: white; font-size: 2.8em; margin: 30px 0 20px 0; letter-spacing: 3px; font-weight: 900; }
  .count { font-size: 1.3em; margin: 20px 0; opacity: 0.95; }
  .sep { width: 80px; margin: 60px auto; border: none; border-top: 2px solid rgba(255,255,255,0.8); }
  .meta { font-size: 0.95em; opacity: 0.85; margin-top: 60px; }
</style>
</head>
<body>
  <div class="divider">
    <h1 class="cat-name">${htmlEscape(g.cat.name.toUpperCase())}</h1>
    <p class="count">${g.articles.length} makale</p>
    <hr class="sep"/>
    <p class="meta">${htmlEscape(displayDate)} · ${htmlEscape(displayHour)}</p>
  </div>
</body></html>`;

        oebps.file(catFile, catHtml);
        manifest += `\n<item id="${catId}" href="${catFile}" media-type="application/xhtml+xml"/>`;
        spine += `\n<itemref idref="${catId}"/>`;

        let catNavPoints = '';

        g.articles.forEach((art) => {
            itemCounter++;
            const itemId = `item${itemCounter}`;
            const itemFile = `item${itemCounter}.xhtml`;

            const bodyHtml = art.content.map(p => `<p>${htmlEscape(p)}</p>`).join('\n');
            const catLine = `<p class="cat-label" style="color:${g.cat.color};">T24 · ${htmlEscape(g.cat.name)}</p>`;
            const dateLine = `<p class="date-label">${htmlEscape(art.publishDateStr)}</p>`;

            const xhtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${htmlEscape(art.title)}</title><meta charset="utf-8"/>
<style>
  body { font-family: serif; line-height: 1.6; padding: 20px; }
  h1 { font-size: 1.5em; margin: 0 0 12px 0; }
  .cat-label { font-size: 0.85em; font-weight: bold; margin: 0 0 4px 0; }
  .date-label { font-size: 0.8em; color: #888; margin: 0 0 18px 0; }
  hr { border: none; border-top: 1px solid #ddd; margin: 18px 0; }
  p { margin: 0 0 1em 0; text-align: justify; }
</style>
</head>
<body>
  <h1>${htmlEscape(art.title)}</h1>
  ${catLine}
  ${dateLine}
  <hr/>
  ${bodyHtml}
</body></html>`;

            oebps.file(itemFile, xhtml);
            manifest += `\n<item id="${itemId}" href="${itemFile}" media-type="application/xhtml+xml"/>`;
            spine += `\n<itemref idref="${itemId}"/>`;

            catNavPoints += `
    <navPoint id="nav-${itemId}" playOrder="${playOrder++}">
      <navLabel><text>${htmlEscape(art.title)}</text></navLabel>
      <content src="${itemFile}"/>
    </navPoint>`;
        });

        navMap += `
<navPoint id="nav-${catId}" playOrder="${playOrder++}">
  <navLabel><text>${htmlEscape(g.cat.name)} (${g.articles.length})</text></navLabel>
  <content src="${catFile}"/>${catNavPoints}
</navPoint>`;
    });

    const dcTitle = `T24 — ${catNames.join(', ')} (${displayDate} ${displayHour})`;

    oebps.file('content.opf', `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:opf="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${htmlEscape(dcTitle)}</dc:title>
    <dc:creator opf:role="aut" opf:file-as="T24">T24</dc:creator>
    <dc:publisher>T24</dc:publisher>
    <dc:language>tr</dc:language>
    <dc:date>${today}</dc:date>
    <dc:identifier id="BookId">t24-${Date.now()}</dc:identifier>
    <meta name="cover" content="cover-image"/>
  </metadata>
  <manifest>${manifest}
  </manifest>
  <spine toc="ncx">${spine}
  </spine>
</package>`);

    oebps.file('toc.ncx', `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <docTitle><text>${htmlEscape(dcTitle)}</text></docTitle>
  <navMap>${navMap}
  </navMap>
</ncx>`);

    const base64 = await zip.generateAsync({ type: 'base64' });
    return base64;
}

// ==========================================
// DRIVE YÜKLEME (3 RETRY)
// ==========================================
async function uploadToDrive(base64, fileName) {
    log(`☁️ Drive'a yükleniyor: ${fileName}`);

    const maxAttempts = 3;
    const delays = [5000, 15000, 30000];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            log(`   Deneme ${attempt}/${maxAttempts}...`);
            const res = await fetch(APPS_SCRIPT_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: base64, filename: fileName })
            });
            log(`   ✓ HTTP ${res.status}`);
            if (res.ok) {
                const text = await res.text();
                log(`   Cevap: ${text.substring(0, 200)}`);
                return true;
            }
            if (attempt < maxAttempts) {
                const wait = delays[attempt - 1];
                log(`   ⚠️ HTTP ${res.status} — ${wait / 1000} sn sonra tekrar denenecek...`);
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

// ==========================================
// ANA AKIŞ
// ==========================================
async function main() {
    log('🚀 T24 Günlük EPUB v1.5 başladı');
    const startTime = Date.now();

    const grouped = await scrapeAll();
    const totalArticles = grouped.reduce((sum, g) => sum + g.articles.length, 0);
    if (totalArticles === 0) {
        log('❌ Hiç makale bulunamadı, çıkılıyor.');
        process.exit(1);
    }
    log(`📚 Toplam ${totalArticles} makale toplandı`);
    grouped.forEach(g => log(`   • ${g.cat.name}: ${g.articles.length}`));

    const now = new Date();
    const dateStr = now.toLocaleDateString('tr-TR', {
        day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Istanbul'
    });
    const hourUTC = now.getUTCHours();
    const minuteUTC = now.getUTCMinutes();
    const hourTR = (hourUTC + 3) % 24;
    const hourSafe = String(hourTR).padStart(2, '0');
    const minuteSafe = String(minuteUTC).padStart(2, '0');
    const displayHour = `${hourSafe}:${minuteSafe} TR`;
    const fileDate = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Istanbul' });

    log('📦 EPUB üretiliyor...');
    const base64 = await buildEpub(grouped, dateStr, displayHour);
    const sizeMB = (base64.length * 0.75 / 1024 / 1024).toFixed(2);
    log(`   ✓ EPUB hazır (~${sizeMB} MB)`);

    const catPart = CATEGORIES.map(c => safeFileName(c.name).replace(/\s+/g, '')).join('-');
    const fileName = `T24_${catPart}_${fileDate}_${hourSafe}-${minuteSafe}.epub`;

    const ok = await uploadToDrive(base64, fileName);

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    if (ok) {
        log(`✅ TAMAM — ${fileName} — ${duration}s`);
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
