/**
 * Oksijen Günlük EPUB Üretici — v2.2
 * - 7 kategori (Türkiye, Dünya, Ekonomi, Bilim ve Teknoloji, Sağlık, Spor, Seyahat)
 * - Kategoriye göre gruplu sıralama
 * - Kitap içi "İçindekiler" sayfası + kategori ayraç sayfaları
 * - Renkli kapak + makale sayısı
 * - İki seviyeli TOC menüsü
 * - Drive yükleme için 3 denemeli retry mekanizması
 */

const JSZip = require('jszip');
const cheerio = require('cheerio');

// ==========================================
// AYARLAR
// ==========================================
const BASE = 'https://gazeteoksijen.com';

const CATEGORIES = [
    { name: 'Türkiye',             slug: 'turkiye',            color: '#2c7be5' },
    { name: 'Dünya',               slug: 'dunya',              color: '#e67e22' },
    { name: 'Ekonomi',             slug: 'ekonomi',            color: '#27ae60' },
    { name: 'Bilim ve Teknoloji',  slug: 'bilim-ve-teknoloji', color: '#8e44ad' },
    { name: 'Sağlık',              slug: 'saglik',             color: '#e74c3c' },
    { name: 'Spor',                slug: 'spor',               color: '#f39c12' },
    { name: 'Seyahat',             slug: 'seyahat',            color: '#16a085' }
];

const HOURS_LOOKBACK = 12;
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

function safeFileName(s) {
    return String(s || 'Oksijen')
        .replace(/[\\/:*?"<>|]+/g, ' ')
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
        .replace(/\u00A0/g, ' ').replace(/[ \t]+/g, ' ')
        .replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
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

        $('*').each((_, el) => {
            const $el = $(el);
            if ($el.children().length === 0 && $el.text().trim() === 'Editörün Seçtikleri') {
                $el.parent().parent().attr('data-ignore-links', 'true');
            }
        });

        const links = [];
        const seen = new Set();
        $('a').each((_, el) => {
            const $el = $(el);
            if ($el.closest('[data-ignore-links="true"]').length > 0) return;

            let href = $el.attr('href');
            if (!href || href.startsWith('javascript')) return;
            try { href = new URL(href, BASE).href; } catch { return; }

            if (!href.includes('gazeteoksijen.com')) return;
            if (!href.match(new RegExp(`/${slug}/.+\\-\\d{5,}$`))) return;
            if (seen.has(href)) return;
            seen.add(href);

            const title = $el.text().trim();
            if (title.length < 20) return;

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
// MAKALE İÇERİK ÇIKARMA
// ==========================================
function extractArticleContent($) {
    $('script, style, noscript, iframe, svg, header, footer, nav').remove();
    $('.paywall-notice, .article-share, .related-news, .ads-container, [class*="reklam"], [id*="ad-"]').remove();

    const selectors = [
        'main article', 'article .content', '.article-content',
        '.news-detail-text', '[itemprop="articleBody"]'
    ];
    let container = null;
    for (const sel of selectors) {
        const found = $(sel).first();
        if (found.length && found.text().length > 200) { container = found; break; }
    }
    if (!container || !container.length) container = $('main article').first();
    if (!container.length) container = $('article').first();
    if (!container.length) return [];

    const paragraphs = [];
    container.find('p, h2, h3, blockquote, li').each((_, el) => {
        const text = norm($(el).text());
        if (text.length > 10) paragraphs.push(text);
    });
    if (paragraphs.length === 0) {
        const raw = norm(container.text());
        raw.split(/\n+/).forEach(p => { if (p.length > 20) paragraphs.push(p); });
    }
    return paragraphs.filter(p => p.length > 15);
}

async function fetchArticle(url, title, catObj) {
    try {
        const res = await fetchWithTimeout(url);
        if (!res.ok) return null;
        const html = await res.text();
        const $ = cheerio.load(html);

        let publishedAt = null;
        const metaDate = $('meta[property="article:published_time"]').attr('content');
        if (metaDate) publishedAt = new Date(metaDate);

        const ogTitle = $('meta[property="og:title"]').attr('content');
        const finalTitle = norm(ogTitle) || title;

        const content = extractArticleContent($);
        if (!content || content.length === 0) return null;

        let author = norm($('meta[name="author"]').attr('content')) || '';

        return {
            url,
            title: finalTitle,
            content,
            author,
            catName: catObj.name,
            source: 'Oksijen',
            publishDateStr: publishedAt ? publishedAt.toISOString().split('T')[0] : '',
            fullDateObj: publishedAt || new Date()
        };
    } catch (e) {
        log(`   ⚠️ Makale hata: ${e.message}`);
        return null;
    }
}

// ==========================================
// ANA TARAMA (kategoriye göre gruplu)
// ==========================================
async function scrapeAll() {
    const grouped = [];
    const seenUrls = new Set();
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

    // ==========================================
    // KAPAK
    // ==========================================
    const coverLines = wrapText(catNames, 42);
    const coverSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 800" width="100%" height="100%">
  <rect width="600" height="800" fill="#ffffff"/>
  <text x="300" y="180" font-family="Arial,sans-serif" font-size="64" font-weight="900" fill="#111111" text-anchor="middle">OKSİJEN</text>
  <line x1="200" y1="220" x2="400" y2="220" stroke="#333" stroke-width="2"/>
  ${coverLines.map((line, i) => 
    `<text x="300" y="${300 + i * 35}" font-family="Arial,sans-serif" font-size="18" fill="#333333" text-anchor="middle">${htmlEscape(line)}</text>`
  ).join('\n  ')}
  <text x="300" y="500" font-family="Arial,sans-serif" font-size="26" font-weight="bold" fill="#111111" text-anchor="middle">${totalArticles} makale</text>
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

    // ==========================================
    // KİTAP İÇİ İÇİNDEKİLER SAYFASI
    // ==========================================
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

    // ==========================================
    // MANIFEST, SPINE, NAVMAP
    // ==========================================
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

    // ==========================================
    // KATEGORİ AYRAÇLARI + MAKALELER
    // ==========================================
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
            const authorHtml = art.author ? `<p class="author">${htmlEscape(art.author)}</p>` : '';
            const catLine = `<p class="cat-label">Oksijen · ${htmlEscape(g.cat.name)}</p>`;

            const xhtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${htmlEscape(art.title)}</title><meta charset="utf-8"/>
<style>
  body { font-family: serif; line-height: 1.6; padding: 20px; }
  h1 { font-size: 1.5em; margin: 0 0 12px 0; }
  .author { font-style: italic; margin: 0 0 6px 0; color: #333; }
  .cat-label { font-size: 0.85em; color: #888; font-style: italic; margin: 0 0 18px 0; }
  hr { border: none; border-top: 1px solid #ddd; margin: 18px 0; }
  p { margin: 0 0 1em 0; text-align: justify; }
</style>
</head>
<body>
  <h1>${htmlEscape(art.title)}</h1>
  ${authorHtml}
  ${catLine}
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

    const dcTitle = `Oksijen — ${catNames.join(', ')} (${displayDate} ${displayHour})`;

    oebps.file('content.opf', `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:opf="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${htmlEscape(dcTitle)}</dc:title>
    <dc:creator opf:role="aut" opf:file-as="Oksijen">Oksijen</dc:creator>
    <dc:publisher>Oksijen</dc:publisher>
    <dc:language>tr</dc:language>
    <dc:date>${today}</dc:date>
    <dc:identifier id="BookId">oxy-${Date.now()}</dc:identifier>
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
// DRIVE YÜKLEME (3 Denemeli Retry)
// ==========================================
async function uploadToDrive(base64, fileName) {
    log(`☁️ Drive'a yükleniyor: ${fileName}`);

    const maxAttempts = 3;
    const delays = [5000, 15000, 30000]; // 5 sn, 15 sn, 30 sn

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
    log('🚀 Oksijen Günlük EPUB v2.2 başladı');
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
