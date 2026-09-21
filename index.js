/**
 * Oksijen Günlük EPUB Üretici
 * GitHub Actions üzerinde çalışır.
 * Her gün Türkiye / Dünya / Ekonomi kategorilerinden son makaleleri çeker,
 * EPUB üretir ve Apps Script üzerinden Google Drive'a yükler.
 */

const JSZip = require('jszip');
const cheerio = require('cheerio');

// ==========================================
// AYARLAR
// ==========================================
const BASE = 'https://gazeteoksijen.com';
const CATEGORIES = [
    { name: 'Türkiye', slug: 'turkiye' },
    { name: 'Dünya', slug: 'dunya' },
    { name: 'Ekonomi', slug: 'ekonomi' }
];
const HOURS_LOOKBACK = 30;          // Son kaç saatteki makaleler alınsın
const FETCH_DELAY_MS = 400;         // İstekler arası bekleme
const REQUEST_TIMEOUT_MS = 15000;   // Tek istek için timeout
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const APPS_SCRIPT_URL = process.env.OXY_SCRIPT_URL;
if (!APPS_SCRIPT_URL) {
    console.error('❌ OXY_SCRIPT_URL ortam değişkeni tanımlı değil!');
    process.exit(1);
}

// ==========================================
// YARDIMCI FONKSİYONLAR
// ==========================================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

function safeFileName(s) {
    return String(s || 'Oksijen')
        .replace(/[\\/:*?"<>|]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 120);
}

function htmlEscape(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function norm(text) {
    return String(text || '')
        .replace(/\u00A0/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\r/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
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
        if (!res.ok) {
            log(`   ⚠️ HTTP ${res.status}`);
            return [];
        }
        const html = await res.text();
        const $ = cheerio.load(html);

        // "Editörün Seçtikleri" bloğunu atla
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
            try {
                href = new URL(href, BASE).href;
            } catch { return; }

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
function extractArticleContent($, title) {
    // Gürültüyü temizle
    $('script, style, noscript, iframe, svg, header, footer, nav').remove();
    $('.paywall-notice, .article-share, .related-news, .ads-container, [class*="reklam"], [id*="ad-"]').remove();

    // Container adayları
    const selectors = [
        'main article',
        'article .content',
        '.article-content',
        '.news-detail-text',
        '[itemprop="articleBody"]'
    ];

    let container = null;
    for (const sel of selectors) {
        const found = $(sel).first();
        if (found.length && found.text().length > 200) {
            container = found;
            break;
        }
    }
    if (!container) container = $('main article').first();
    if (!container.length) container = $('article').first();
    if (!container.length) return [];

    // Paragrafları topla
    const paragraphs = [];
    container.find('p, h2, h3, blockquote, li').each((_, el) => {
        const text = norm($(el).text());
        if (text.length > 10) paragraphs.push(text);
    });

    // Fallback: yoksa container text'ini böl
    if (paragraphs.length === 0) {
        const raw = norm(container.text());
        raw.split(/\n+/).forEach(p => {
            if (p.length > 20) paragraphs.push(p);
        });
    }

    return paragraphs.filter(p => p.length > 15);
}

async function fetchArticle(url, title, catName) {
    try {
        const res = await fetchWithTimeout(url);
        if (!res.ok) return null;
        const html = await res.text();
        const $ = cheerio.load(html);

        // Tarih
        let publishedAt = null;
        const metaDate = $('meta[property="article:published_time"]').attr('content');
        if (metaDate) publishedAt = new Date(metaDate);

        // Başlık (og:title'dan daha güvenli)
        const ogTitle = $('meta[property="og:title"]').attr('content');
        const finalTitle = norm(ogTitle) || title;

        // İçerik
        const content = extractArticleContent($, finalTitle);
        if (!content || content.length === 0) return null;

        // Yazar
        let author = norm($('meta[name="author"]').attr('content')) || '';

        return {
            url,
            title: finalTitle,
            content,
            author,
            catName,
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
// ANA TARAMA
// ==========================================
async function scrapeAll() {
    const allArticles = [];
    const seenUrls = new Set();
    const cutoff = new Date(Date.now() - HOURS_LOOKBACK * 3600000);

    for (const cat of CATEGORIES) {
        const links = await fetchCategoryLinks(cat.slug);
        log(`📝 ${cat.name}: ${links.length} link taranıyor...`);

        let catCount = 0;
        for (let i = 0; i < links.length; i++) {
            const { url, title } = links[i];
            if (seenUrls.has(url)) continue;
            seenUrls.add(url);

            const article = await fetchArticle(url, title, cat.name);
            if (!article) { await sleep(FETCH_DELAY_MS); continue; }

            // Tarih filtresi
            if (article.fullDateObj < cutoff) {
                await sleep(50);
                continue;
            }

            allArticles.push(article);
            catCount++;
            log(`   ✓ ${catCount}. [${cat.name}] ${article.title.substring(0, 60)}`);
            await sleep(FETCH_DELAY_MS);
        }
        log(`✅ ${cat.name}: ${catCount} makale alındı`);
    }

    return allArticles;
}

// ==========================================
// EPUB ÜRETİMİ
// ==========================================
async function buildEpub(articles) {
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

    const catNamesList = [...new Set(articles.map(a => a.catName).filter(Boolean))];
    const dcTitle = `Oksijen — ${catNamesList.join(', ')} (${today})`;

    // Kapak
    const coverSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 800" width="100%" height="100%">
  <rect width="600" height="800" fill="#ffffff"/>
  <text x="300" y="230" font-family="Arial,sans-serif" font-size="56" font-weight="700" fill="#111111" text-anchor="middle">OKSİJEN</text>
  <text x="300" y="340" font-family="Arial,sans-serif" font-size="20" fill="#333" text-anchor="middle">${htmlEscape(catNamesList.join(', ').toUpperCase())}</text>
  <text x="300" y="420" font-family="Arial,sans-serif" font-size="20" fill="#666" text-anchor="middle">${today}</text>
</svg>`;

    oebps.file('cover.svg', coverSvg);
    oebps.file('cover.xhtml', `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Kapak</title><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;text-align:center;height:100%;">
  <img src="cover.svg" alt="Kapak" style="max-width:100%;max-height:100%;"/>
</body></html>`);

    let manifest = `
<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
<item id="cover-image" href="cover.svg" media-type="image/svg+xml"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`;

    let spine = `\n<itemref idref="cover"/>`;
    let navMap = '';

    articles.forEach((art, idx) => {
        const artId = `item${idx + 1}`;
        const artFile = `${artId}.xhtml`;
        const bodyHtml = art.content.map(p => `<p>${htmlEscape(p)}</p>`).join('\n');
        const authorHtml = art.author ? `<p class="author">${htmlEscape(art.author)}</p>` : '';
        const catLine = `<p class="source" style="font-size:0.85em;color:#555;font-style:italic;">Oksijen · ${htmlEscape(art.catName || '')}</p>`;

        const xhtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>${htmlEscape(art.title)}</title>
  <meta charset="utf-8"/>
  <style>
    body { margin:0; padding:0; font-family:serif; line-height:1.5; }
    h1 { font-size:1.4em; margin:0 0 0.8em 0; font-weight:bold; }
    .author { margin:0 0 1.2em 0; font-style:italic; }
    p { margin:0 0 1em 0; text-align:justify; }
  </style>
</head>
<body>
  <h1>${htmlEscape(art.title)}</h1>
  ${authorHtml}
  ${catLine}
  ${bodyHtml}
</body>
</html>`;

        oebps.file(artFile, xhtml);
        manifest += `\n<item id="${artId}" href="${artFile}" media-type="application/xhtml+xml"/>`;
        spine += `\n<itemref idref="${artId}"/>`;
        navMap += `\n<navPoint id="nav-${idx + 1}" playOrder="${idx + 1}"><navLabel><text>${htmlEscape(art.title)}</text></navLabel><content src="${artFile}"/></navPoint>`;
    });

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
// DRIVE'A YÜKLEME
// ==========================================
async function uploadToDrive(base64, fileName) {
    log(`☁️ Drive'a yükleniyor: ${fileName}`);
    try {
        const res = await fetch(APPS_SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: base64, filename: fileName })
        });
        log(`   ✓ HTTP ${res.status}`);
        const text = await res.text();
        log(`   Cevap: ${text.substring(0, 200)}`);
        return res.ok;
    } catch (e) {
        log(`   ❌ Yükleme hatası: ${e.message}`);
        return false;
    }
}

// ==========================================
// ANA AKIŞ
// ==========================================
async function main() {
    log('🚀 Oksijen Günlük EPUB başladı');
    const startTime = Date.now();

    const articles = await scrapeAll();
    if (articles.length === 0) {
        log('❌ Hiç makale bulunamadı, çıkılıyor.');
        process.exit(1);
    }
    log(`📚 Toplam ${articles.length} makale toplandı`);

    // Tarihe göre sırala (yeni → eski)
    articles.sort((a, b) => b.fullDateObj - a.fullDateObj);

    log('📦 EPUB üretiliyor...');
    const base64 = await buildEpub(articles);
    const sizeMB = (base64.length * 0.75 / 1024 / 1024).toFixed(2);
    log(`   ✓ EPUB hazır (~${sizeMB} MB)`);

    const today = new Date().toLocaleDateString('sv-SE');
    const catPart = CATEGORIES.map(c => safeFileName(c.name).replace(/\s+/g, '')).join('-');
    const fileName = `Oksijen_${catPart}_${today}.epub`;

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
