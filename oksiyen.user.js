// ==UserScript==
// @name         Oksijen Master
// @namespace    http://tampermonkey.net/
// @version      4.5
// @description  Oksijen EPUB — Seyrüsefer (Türkiye+Dünya+NYT, her birinden son 20) + Yazarlar + Gelişmiş.
// @author       Claude & Gemini
// @match        *://gazeteoksijen.com/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzNAvMkiwjWKWDEVMVV15a629b-cKrfNkliuZEHDmiDke_DIxBqoaoDCLWjCiHp3b5h/exec";
    const REQUEST_POLICY = { concurrency: 2, minDelayMs: 800, maxDelayMs: 1500 };
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    const randomDelay = () => randomInt(REQUEST_POLICY.minDelayMs, REQUEST_POLICY.maxDelayMs);

    let CANCELLED = false;

    const IFRAME_FIRST_CATS = new Set(['financial-times', 'the-economist']);
    const IFRAME_RENDER_WAIT = 4500;
    const IFRAME_STABLE_TIMEOUT = 12000;
    const IFRAME_TIMEOUT = 30000;
    const NINJA_IFRAME_TIMEOUT = 30000;

    // Seyrüsefer ayarları
    const SEYR_CATS = ['turkiye', 'dunya', 'new-york-times'];
    const SEYR_PER_CAT = 20;
    const SEYR_CANDIDATES_PER_CAT = 30; // en yeni 20'yi seçmek için tampon

    const CATS = [
        { name: "Türkiye", slug: "turkiye" },
        { name: "Dünya", slug: "dunya" },
        { name: "Ekonomi", slug: "ekonomi" },
        { name: "Yazarlar (Ninja)", slug: "yazarlar", special: true },
        { name: "Future Forum", slug: "future-forum" },
        { name: "O2", slug: "o2" },
        { name: "New York Times", slug: "new-york-times" },
        { name: "Financial Times", slug: "financial-times" },
        { name: "The Economist", slug: "the-economist" },
        { name: "Project Syndicate", slug: "project-syndicate" },
        { name: "goodFOOD", slug: "goodfood" },
        { name: "Bilim ve Teknoloji", slug: "bilim-ve-teknoloji" },
        { name: "Oksijen Nefes", slug: "oksijen-nefes" },
        { name: "Sağlık", slug: "saglik" },
        { name: "Spor", slug: "spor" },
        { name: "Seyahat", slug: "seyahat" }
    ];

    const MONTHS = {
        "ocak": 0, "şubat": 1, "subat": 1, "mart": 2, "nisan": 3, "mayıs": 4, "mayis": 4,
        "haziran": 5, "temmuz": 6, "ağustos": 7, "agustos": 7, "eylül": 8, "eylul": 8,
        "ekim": 9, "kasım": 10, "kasim": 10, "aralık": 11, "aralik": 11
    };

    // ---------- YARDIMCILAR ----------
    function norm(text) {
        return String(text || '').replace(/\u00A0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
    }
    function htmlEscape(text) {
        return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function safeFileName(s) {
        let out = String(s || 'Oksijen').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
        const enc = new TextEncoder();
        while (enc.encode(out).length > 180 && out.length > 0) out = out.slice(0, -1);
        return out.trim();
    }
    function parseTRDate(text) {
        if (!text) return null;
        let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
        if (m) return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
        const t = norm(text).toLowerCase();
        m = t.match(/^(\d{1,2})\s+([a-zçğıöşü]+)\s+(20\d{2})$/i);
        if (m) {
            const d = parseInt(m[1], 10);
            const mon = MONTHS[m[2]];
            const y = parseInt(m[3], 10);
            if (!isNaN(d) && mon !== undefined && !isNaN(y)) return new Date(y, mon, d);
        }
        m = t.match(/^(\d{1,2})\.(\d{1,2})\.(20\d{2})$/);
        if (m) return new Date(parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10));
        return null;
    }
    function cmp(a, b, op) {
        if (!a || !b) return false;
        const aa = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
        const bb = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
        if (op === "=") return aa === bb;
        if (op === ">=") return aa >= bb;
        if (op === "<=") return aa <= bb;
        return false;
    }

    // ==========================================
    // STANDART EXTRACT
    // ==========================================
    async function fetchDocument(url) {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return new DOMParser().parseFromString(await res.text(), 'text/html');
    }
    function extractStandardArticle(doc, title) {
        const clone = doc.cloneNode(true);
        clone.querySelectorAll(['script', 'style', 'noscript', 'iframe', 'svg', 'header', 'footer', 'nav', '.paywall-notice', '.article-share', '.related-news', '.ads-container', '[class*="reklam"]', '[id*="ad-"]'].join(',')).forEach(el => el.remove());
        let paragraphs = [];
        const selectors = ['.article-content', '.news-detail-text', 'article .content', '[itemprop="articleBody"]', 'main article', 'article'];
        let container = null;
        let bestLen = 0;
        for (const sel of selectors) {
            const el = clone.querySelector(sel);
            if (!el) continue;
            const len = (el.textContent || '').length;
            if (len > bestLen && len > 100) {
                container = el;
                bestLen = len;
                if (len > 200) break;
            }
        }
        if (container) {
            const pNodes = Array.from(container.querySelectorAll('p, h2, h3, blockquote, li'));
            if (pNodes.length > 0) paragraphs = pNodes.map(n => norm(n.textContent || '')).filter(t => t.length > 10);
            else paragraphs = (container.textContent || '').split(/\n+/).map(p => norm(p)).filter(t => t.length > 15);
        }
        return paragraphs;
    }
    function oxyLinkFilter(href) {
        if (!href || href.startsWith('javascript')) return false;
        if (!href.includes('gazeteoksijen.com')) return false;
        if (href.split('?')[0] === window.location.href.split('?')[0]) return false;
        if (href.length < 35) return false;
        return true;
    }

    // ==========================================
    // ORTAK IFRAME YÜKLEYİCİ
    // ==========================================
    async function waitForStableDoc(doc, minWaitMs, maxWaitMs) {
        const start = Date.now();
        let lastLen = -1;
        let stableCount = 0;
        while (Date.now() - start < maxWaitMs) {
            const len = (doc.body?.textContent || '').length;
            if (len > 500 && len === lastLen) stableCount++;
            else stableCount = 0;
            lastLen = len;
            if (Date.now() - start >= minWaitMs && len > 500 && stableCount >= 2) return true;
            await sleep(400);
        }
        return lastLen > 500;
    }

    function loadAndExtractFromIframe(url, extractor, opts = {}) {
        const renderWaitMs = opts.renderWaitMs || 3000;
        const timeoutMs = opts.timeoutMs || IFRAME_TIMEOUT;
        const stableMs = opts.stableMs || IFRAME_STABLE_TIMEOUT;

        return new Promise((resolve) => {
            const iframe = document.createElement('iframe');
            iframe.style.cssText = 'position:fixed;left:-99999px;top:-99999px;width:1280px;height:3000px;opacity:0;pointer-events:none;';
            iframe.src = url;

            let done = false;
            const finish = (result) => {
                if (done) return;
                done = true;
                try { iframe.remove(); } catch (e) {}
                resolve(result);
            };

            const timeout = setTimeout(() => {
                console.warn('[Oksijen] iframe timeout:', url);
                finish(null);
            }, timeoutMs);

            iframe.onload = async () => {
                try {
                    const doc = iframe.contentDocument || iframe.contentWindow.document;
                    if (!doc || !doc.body) { clearTimeout(timeout); finish(null); return; }
                    await waitForStableDoc(doc, renderWaitMs, renderWaitMs + stableMs);
                    const result = await extractor(doc);
                    clearTimeout(timeout);
                    finish(result);
                } catch (err) {
                    clearTimeout(timeout);
                    finish(null);
                }
            };

            document.body.appendChild(iframe);
        });
    }

    async function extractViaIframe(url, title) {
        return loadAndExtractFromIframe(url, (doc) => {
            const paragraphs = extractStandardArticle(doc, title);
            if (!paragraphs || paragraphs.length === 0) return null;
            const metaDate = doc.querySelector('meta[property="article:published_time"]');
            return {
                paragraphs,
                dateStr: metaDate ? metaDate.content.split('T')[0] : '',
                dateObj: metaDate ? new Date(metaDate.content) : new Date()
            };
        }, { renderWaitMs: IFRAME_RENDER_WAIT, timeoutMs: IFRAME_TIMEOUT });
    }

    // ==========================================
    // HİBRİT EXTRACT
    // ==========================================
    async function oxyExtract(url, title, dateFilter, catSlug) {
        let content = [];
        let articleDateStr = '';
        let fullDateObj = new Date();

        if (IFRAME_FIRST_CATS.has(catSlug)) {
            const r = await extractViaIframe(url, title);
            if (r) {
                content = r.paragraphs || [];
                articleDateStr = r.dateStr || '';
                fullDateObj = r.dateObj || new Date();
            }
        } else {
            try {
                const doc = await fetchDocument(url);
                const metaDate = doc.querySelector('meta[property="article:published_time"]');
                articleDateStr = metaDate ? metaDate.content.split('T')[0] : '';
                fullDateObj = metaDate ? new Date(metaDate.content) : new Date();
                content = extractStandardArticle(doc, title);

                if (content.join(' ').length < 500) {
                    console.log('[Oksijen] fetch kısa, iframe fallback:', url);
                    const r = await extractViaIframe(url, title);
                    if (r && r.paragraphs && r.paragraphs.length > 0) {
                        content = r.paragraphs;
                        if (r.dateStr) articleDateStr = r.dateStr;
                        if (r.dateObj) fullDateObj = r.dateObj;
                    }
                }
            } catch (e) {
                console.warn('[Oksijen] fetch hata, iframe deneniyor:', e.message);
                const r = await extractViaIframe(url, title);
                if (r) {
                    content = r.paragraphs || [];
                    articleDateStr = r.dateStr || '';
                    fullDateObj = r.dateObj || new Date();
                }
            }
        }

        if (dateFilter && articleDateStr !== dateFilter) return null;
        if (!content || content.length === 0) return null;
        return { url, title, content, publishDateStr: articleDateStr, fullDateObj };
    }

    // ==========================================
    // YAZARLAR NINJA
    // ==========================================
    function getAuthorCards() {
        const links = [...document.querySelectorAll('a[href*="/yazarlar/"]')].filter(a => {
            const href = a.getAttribute("href") || "";
            return href !== "/yazarlar" && !/\/yazarlar\/?$/.test(href);
        });
        const cards = [];
        const seen = new Set();
        for (const a of links) {
            const href = a.href;
            if (!href || seen.has(href)) continue;
            let card = a.closest("div");
            while (card && card.parentElement && norm(card.innerText).length < 25) card = card.parentElement;
            if (!card) continue;
            const text = norm(card.innerText);
            const dateMatch = text.match(/\b\d{1,2}\s+[A-Za-zÇĞİIÖŞÜçğıiöşü]+\s+20\d{2}\b/);
            if (!dateMatch) continue;
            const dateText = norm(dateMatch[0]);
            const dateObj = parseTRDate(dateText);
            if (!dateObj) continue;
            const lines = text.split("\n").map(norm).filter(Boolean);
            const name = lines[0] || "";
            const title = lines.length >= 2 ? lines[1] : "";
            seen.add(href);
            cards.push({ id: `art_${cards.length}`, el: card, url: href, text, dateText, dateObj, name, title });
        }
        return cards;
    }
    function cleanNinjaText(text) {
        return norm(String(text || '').replace(/A\+\s*Yazı Boyutunu Büyüt/gi, "").replace(/A-\s*Yazı Boyutunu Küçült/gi, "").replace(/\n{3,}/g, "\n\n"));
    }
    function cleanAuthorName(author) {
        return norm(String(author || '').replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '').replace(/\s{2,}/g, ' '));
    }
    function pickBestContentContainer(doc) {
        const selectors = ["article", "main article", '[itemprop="articleBody"]', '[class*="article-body"]', '[class*="article-content"]', 'main', '[class*="content"]', '[class*="detail"]', '[class*="post"]'];
        let best = null, bestScore = 0;
        for (const sel of selectors) {
            for (const el of doc.querySelectorAll(sel)) {
                if (el.querySelectorAll('nav, aside, footer').length > 0 && el.querySelectorAll('p').length < 5) continue;
                const txt = norm(el.textContent || "");
                const pCount = el.querySelectorAll("p").length;
                const hCount = el.querySelectorAll("h2, h3, blockquote").length;
                const score = txt.length + pCount * 220 + hCount * 120;
                if (score > bestScore) { best = el; bestScore = score; }
            }
        }
        return best || doc.body;
    }
    function getStructuredBlocks(container) {
        let blocks = [...container.querySelectorAll('p, h2, h3, blockquote, li')].map(el => norm(el.textContent || "")).filter(Boolean);
        if (blocks.length < 3) blocks = norm(container.textContent || "").split(/\n+/).map(norm).filter(t => t.length > 20);
        return blocks;
    }
    function stripBeforeMarker(blocks) {
        const markers = [/A-\s*Yazı Boyutunu Küçült/i, /A\+\s*Yazı Boyutunu Büyüt/i];
        const idx = blocks.findIndex(b => markers.some(rx => rx.test(b)));
        return idx >= 0 ? blocks.slice(idx + 1) : blocks;
    }
    function stripCopyrightBlocks(blocks) {
        const markers = ["* Bu haber/yazı", "Bu haber/yazı ve resimlerin eser sahipliğinden doğan tüm hakları", "Haftalık Yayıncılık Anonim Şirketi"];
        let cutIndex = -1;
        for (let i = 0; i < blocks.length; i++) {
            if (markers.some(m => blocks[i].includes(m))) { cutIndex = i; break; }
        }
        return cutIndex > 0 ? blocks.slice(0, cutIndex) : blocks;
    }
    function dedupeConsecutiveBlocks(blocks) {
        const out = [];
        for (const b of blocks) if (!out.length || out[out.length - 1] !== b) out.push(b);
        return out;
    }
    function filterNinjaBlocks(blocks, title, author) {
        const titleLower = String(title || '').toLowerCase().trim();
        const authorLower = String(author || '').toLowerCase().trim();
        const junkPatterns = [
            /^Tüm Yazıları$/i, /^Paylaş$/i, /^A\+\s*Yazı Boyutunu Büyüt$/i, /^A-\s*Yazı Boyutunu Küçült$/i,
            /^\d{1,2}\.\d{1,2}\.\d{4}\s+\d{2}:\d{2}$/, /^\d{1,2}\s+[A-Za-zÇĞİIÖŞÜçğıiöşü]+\s+20\d{2}$/i,
            /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i, /^Kaydet$/i, /^Yazdır$/i, /^Yorumlar$/i,
            /^Diğer Yazarlar$/i, /^Önceki Yazıları$/i, /^Sonraki Yazı$/i, /^Yazarın Diğer Yazıları$/i
        ];
        let out = blocks.filter((line, i) => {
            const clean = cleanNinjaText(line);
            const lower = clean.toLowerCase();
            if (!clean || clean.length < 2) return false;
            if (i === 0 && lower === titleLower) return false;
            if (authorLower && lower === authorLower) return false;
            if (junkPatterns.some(rx => rx.test(clean))) return false;
            return true;
        });
        out = dedupeConsecutiveBlocks(out);
        out = out.filter(line => {
            const clean = cleanNinjaText(line);
            const lower = clean.toLowerCase();
            if (authorLower && lower === authorLower) return false;
            if (/^[A-ZÇĞİIÖŞÜ\s]{5,}$/.test(clean) && clean.length < 40) return false;
            return true;
        });
        out = out.filter(line => {
            const clean = cleanNinjaText(line);
            if (clean.length < 4) return false;
            if (/^[\W_]+$/.test(clean)) return false;
            return true;
        });
        return out;
    }
    function extractNinjaArticle(doc, item) {
        const title = norm(doc.querySelector('meta[property="og:title"]')?.content) || norm(doc.querySelector("h1")?.textContent) || item.title || "";
        let author = norm(doc.querySelector('meta[name="author"]')?.content) || "";
        if (!author) {
            const node = [...doc.querySelectorAll('[class*="author"], .yazar, .writer, [rel="author"]')].find(el => { const t = norm(el.textContent); return t && t.length < 100; });
            if (node) author = norm(node.textContent);
        }
        if (!author) author = item.name || "";
        author = cleanAuthorName(author);
        const pageText = norm(doc.body?.textContent || "");
        const dateMatch = pageText.match(/\b\d{1,2}\.\d{1,2}\.\d{4}\s+\d{2}:\d{2}\b/) || pageText.match(/\b\d{1,2}\s+[A-Za-zÇĞİIÖŞÜçğıiöşü]+\s+20\d{2}\b/);
        const date = dateMatch ? norm(dateMatch[0]) : (item.dateText || "");
        const container = pickBestContentContainer(doc);
        let blocks = getStructuredBlocks(container);
        blocks = stripBeforeMarker(blocks);
        blocks = stripCopyrightBlocks(blocks);
        blocks = blocks.map(cleanNinjaText).filter(Boolean);
        blocks = filterNinjaBlocks(blocks, title, author);
        blocks = blocks.filter(b => b.toLowerCase() !== title.toLowerCase());
        if (!blocks.length) {
            let fb = norm(container.textContent || "");
            if (title) {
                const idx = fb.indexOf(title);
                if (idx >= 0) fb = fb.slice(idx + title.length).trim();
            }
            const markers = ["* Bu haber/yazı", "Bu haber/yazı ve resimlerin eser sahipliğinden doğan tüm hakları", "Haftalık Yayıncılık Anonim Şirketi"];
            let cutIndex = -1;
            for (const m of markers) {
                const i = fb.indexOf(m);
                if (i >= 0 && (cutIndex === -1 || i < cutIndex)) cutIndex = i;
            }
            if (cutIndex > 0) fb = fb.slice(0, cutIndex).trim();
            blocks = fb.split(/\n+/).map(cleanNinjaText).filter(Boolean).filter(t => t.length > 20);
        }
        return { id: item.id, title, author, publishDateStr: date, fullDateObj: item.dateObj || new Date(), url: item.url, content: blocks.filter(b => b && b.trim().length > 0) };
    }
    async function fetchArticleViaIframe(item) {
        const result = await loadAndExtractFromIframe(item.url, (doc) => extractNinjaArticle(doc, item), {
            renderWaitMs: 2000,
            timeoutMs: NINJA_IFRAME_TIMEOUT
        });
        if (!result) return { ...item, content: ["[HATA] İndirilemedi"] };
        return result;
    }

    // ==========================================
    // KATEGORİ SAYFASINDAN LİNK TOPLAMA
    // ==========================================
    async function fetchScrapeCategory(slug, pages, onProgress) {
        const allLinks = [];
        const seen = new Set();
        for (let p = 1; p <= pages; p++) {
            if (CANCELLED) break;
            let url = '/' + slug;
            if (p > 1) url += '?page=' + p;
            if (onProgress) onProgress(`Sayfa ${p}/${pages} çekiliyor...`);
            try {
                const res = await fetch(url, { credentials: 'include' });
                if (!res.ok) { continue; }
                const html = await res.text();
                const doc = new DOMParser().parseFromString(html, 'text/html');

                Array.from(doc.querySelectorAll('*'))
                    .filter(el => el.textContent.trim() === 'Editörün Seçtikleri' && el.children.length === 0)
                    .forEach(label => {
                        if (label.parentElement && label.parentElement.parentElement) {
                            label.parentElement.parentElement.setAttribute('data-ignore-links', 'true');
                        }
                    });

                let addedCount = 0;
                for (const a of doc.querySelectorAll('a')) {
                    if (a.closest('[data-ignore-links="true"]')) continue;
                    let href = a.href;
                    if (!href || href.startsWith('javascript')) continue;
                    if (!href.startsWith('http')) {
                        try { href = new URL(a.getAttribute('href'), window.location.origin).href; }
                        catch (e) { continue; }
                    }
                    if (!href.includes('gazeteoksijen.com')) continue;
                    if (href.split('?')[0] === window.location.href.split('?')[0]) continue;
                    if (href.length < 35) continue;
                    if (seen.has(href)) continue;
                    seen.add(href);
                    let title = (a.textContent || '').trim();
                    if (title.length < 20) continue;
                    allLinks.push({ url: href, title: title.substring(0, 200) });
                    addedCount++;
                }
                if (onProgress) onProgress(`Sayfa ${p}/${pages}: +${addedCount} link`);
            } catch (e) {
                console.warn('[Oksijen] sayfa çekme hata:', e.message);
            }
            await sleep(400);
        }
        return allLinks;
    }

    // ==========================================
    // ÇOKLU KATEGORİ TARAMA (Gelişmiş mod)
    // ==========================================
    async function multiCategoryScan(cats, dateFilter, pagesPerCat, lock) {
        const allArticles = [];
        const seenUrls = new Set();
        const emptyCats = [];

        for (let ci = 0; ci < cats.length; ci++) {
            if (CANCELLED) break;
            const slug = cats[ci];
            const catObj = CATS.find(c => c.slug === slug);
            const catName = catObj ? catObj.name : slug;
            const isIframeFirst = IFRAME_FIRST_CATS.has(slug);
            const lineId = `ikline_${ci}`;
            lock.log(`<span id="${lineId}" style="color:#f1c40f;">⏳ [${ci+1}/${cats.length}] ${catName}${isIframeFirst ? ' (iframe modu)' : ''}</span>`);

            const links = await fetchScrapeCategory(slug, pagesPerCat, (msg) => {
                lock.updateLine(lineId, `<span style="color:#f1c40f;">⏳ [${ci+1}/${cats.length}] ${catName}</span> — <span style="color:#7f8c8d;">${msg}</span>`);
            });
            if (CANCELLED) break;

            const filtered = links.filter(l => oxyLinkFilter(l.url) && !seenUrls.has(l.url));
            filtered.forEach(l => seenUrls.add(l.url));
            lock.updateLine(lineId, `<span style="color:#3498db;">📄 [${ci+1}/${cats.length}] ${catName}</span> — ${filtered.length} link`);

            const valid = [];
            const concurrency = isIframeFirst ? 1 : REQUEST_POLICY.concurrency;

            for (let i = 0; i < filtered.length; i += concurrency) {
                if (CANCELLED) break;
                const chunk = filtered.slice(i, i + concurrency);
                lock.updateLine(lineId, `<span style="color:#3498db;">📄 [${ci+1}/${cats.length}] ${catName}</span> — içerik: ${Math.min(i + chunk.length, filtered.length)}/${filtered.length}`);

                const results = await Promise.all(chunk.map(async (link) => {
                    try {
                        const result = await oxyExtract(link.url, link.title, dateFilter, slug);
                        if (result) {
                            result.catName = catName;
                            result.source = 'Oksijen';
                        }
                        return result;
                    } catch (e) {
                        console.warn('[Oksijen] hata:', e.message);
                        return null;
                    }
                }));

                results.forEach(r => { if (r) valid.push(r); });
                if (i + concurrency < filtered.length) await sleep(randomDelay());
            }

            if (valid.length === 0) emptyCats.push(catName);
            lock.updateLine(lineId, `<span style="color:#2ecc71;">✅ [${ci+1}/${cats.length}] ${catName}</span> — ${valid.length} makale`);
            allArticles.push(...valid);
        }
        return { articles: allArticles, emptyCats };
    }

    // ==========================================
    // SEYRÜSEFER — Türkiye + Dünya + NYT, her birinden en yeni 20
    // ==========================================
    async function runSeyrusefer() {
        if (document.getElementById('ikOverlay')) return;

        const lock = createProgressOverlay(
            '🧭 Seyrüsefer',
            'Türkiye · Dünya · NYT<br>Her birinden en yeni 20 makale (toplam 60 hedef)'
        );

        const allArticles = [];

        for (let ci = 0; ci < SEYR_CATS.length; ci++) {
            if (CANCELLED) break;
            const slug = SEYR_CATS[ci];
            const catObj = CATS.find(c => c.slug === slug);
            const catName = catObj ? catObj.name : slug;
            const lineId = `seyr_${ci}`;

            lock.log(`<span id="${lineId}" style="color:#f1c40f;">⏳ [${ci+1}/${SEYR_CATS.length}] ${catName} taranıyor...</span>`);

            // Kategori sayfasından aday linkleri topla (sayfa 1-2, ilk 30 aday)
            const links = await fetchScrapeCategory(slug, 2, (msg) => {
                lock.updateLine(lineId, `<span style="color:#f1c40f;">⏳ [${ci+1}/${SEYR_CATS.length}] ${catName}</span> — <span style="color:#7f8c8d;">${msg}</span>`);
            });
            if (CANCELLED) break;

            const candidates = links.filter(l => oxyLinkFilter(l.url)).slice(0, SEYR_CANDIDATES_PER_CAT);
            if (candidates.length === 0) {
                lock.updateLine(lineId, `<span style="color:#e67e22;">⚠️ [${ci+1}/${SEYR_CATS.length}] ${catName}</span> — hiç link bulunamadı`);
                continue;
            }

            lock.updateLine(lineId, `<span style="color:#3498db;">📄 [${ci+1}/${SEYR_CATS.length}] ${catName}</span> — ${candidates.length} aday çekiliyor...`);

            // Her adayı çek (tarih + içerik)
            const results = [];
            for (let i = 0; i < candidates.length; i += REQUEST_POLICY.concurrency) {
                if (CANCELLED) break;
                const chunk = candidates.slice(i, i + REQUEST_POLICY.concurrency);
                lock.updateLine(lineId, `<span style="color:#3498db;">📄 [${ci+1}/${SEYR_CATS.length}] ${catName}</span> — ${Math.min(i + chunk.length, candidates.length)}/${candidates.length}`);

                const chunkRes = await Promise.all(chunk.map(async (c) => {
                    try {
                        const r = await oxyExtract(c.url, c.title, null, slug);
                        return r;
                    } catch (e) {
                        return null;
                    }
                }));
                chunkRes.forEach(r => { if (r) results.push(r); });
                if (i + REQUEST_POLICY.concurrency < candidates.length) await sleep(randomDelay());
            }
            if (CANCELLED) break;

            // Tarihe göre yeniden eskiye sırala, ilk 20'yi al
            results.sort((a, b) => (b.fullDateObj?.getTime() || 0) - (a.fullDateObj?.getTime() || 0));
            const top = results.slice(0, SEYR_PER_CAT);
            top.forEach(a => { a.catName = catName; a.source = 'Oksijen'; });
            allArticles.push(...top);

            const note = results.length < SEYR_PER_CAT
                ? ` <span style="color:#e67e22;">(sadece ${results.length} bulundu)</span>`
                : '';
            lock.updateLine(lineId, `<span style="color:#2ecc71;">✅ [${ci+1}/${SEYR_CATS.length}] ${catName}</span> — ${top.length} makale${note}`);
        }

        lock.close();
        if (CANCELLED) return;

        if (allArticles.length === 0) {
            alert('Seyrüsefer: Hiç makale bulunamadı. Site yapısı değişmiş veya ağ sorunu olabilir.');
            return;
        }

        allArticles.forEach((a, i) => a.originalIndex = i);
        const today = new Date().toISOString().split('T')[0];
        const epubName = buildEpubName('', 'Oksijen', ['Seyrüsefer'], today);
        showSelectionUI(allArticles, epubName, `Seyrüsefer · ${allArticles.length} makale`, true);
    }

    // ==========================================
    // İLERLEME OVERLAY
    // ==========================================
    function createProgressOverlay(title, subtitle) {
        const existing = document.getElementById('ikOverlay');
        if (existing) existing.remove();

        const ov = document.createElement('div');
        ov.id = 'ikOverlay';
        ov.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;
            background:rgba(20,25,40,0.97);color:white;z-index:9999999;
            display:flex;flex-direction:column;align-items:center;justify-content:center;
            font-family:sans-serif;padding:20px;box-sizing:border-box;`;
        ov.innerHTML = `
            <h1 style="margin:0;color:#0056b3;font-size:24px;">${title}</h1>
            <p style="margin:8px 0 20px;color:#bbb;font-size:14px;text-align:center;">${subtitle}</p>
            <div id="ikProgressList" style="max-width:640px;width:100%;background:#000;border-radius:8px;
                 padding:16px;font-family:monospace;font-size:13px;color:#7f8c8d;
                 min-height:100px;max-height:340px;overflow-y:auto;line-height:1.6;"></div>
            <div style="margin-top:20px;">
                <button id="ikCancelBtn" style="padding:10px 20px;background:#e74c3c;color:white;border:none;
                        border-radius:6px;cursor:pointer;font-weight:bold;">✖ Vazgeç</button>
            </div>
        `;
        document.body.appendChild(ov);
        CANCELLED = false;
        document.getElementById('ikCancelBtn').onclick = () => {
            CANCELLED = true;
            ov.remove();
        };
        return {
            log(html) {
                const list = document.getElementById('ikProgressList');
                if (list) { list.innerHTML += html + '<br>'; list.scrollTop = list.scrollHeight; }
            },
            updateLine(lineId, html) {
                const line = document.getElementById(lineId);
                if (line) line.innerHTML = html;
            },
            close() { if (ov.parentNode) ov.remove(); }
        };
    }

    // ==========================================
    // DOSYA ADI
    // ==========================================
    function buildEpubName(prefix, source, catNames, fileDate) {
        const cleanCats = catNames.map(n => safeFileName(n).replace(/\s+/g, ''));
        let catPart;
        if (cleanCats.length === 0) catPart = 'Secim';
        else if (cleanCats.length === 1) catPart = cleanCats[0];
        else if (cleanCats.length <= 4) catPart = cleanCats.join('-');
        else if (cleanCats.length >= 8) catPart = 'TumKategoriler';
        else catPart = cleanCats.slice(0, 3).join('-') + `-ve${cleanCats.length - 3}daha`;
        const pfx = prefix ? safeFileName(prefix).replace(/\s+/g, '') + '_' : '';
        let name = `${pfx}${source}_${catPart}_${fileDate}.epub`;
        const enc = new TextEncoder();
        while (enc.encode(name).length > 250 && name.length > 30) {
            const ext = '.epub';
            const base = name.slice(0, -ext.length);
            name = base.slice(0, -1) + ext;
        }
        return name;
    }

    // ==========================================
    // ANA TETİK — 3 butonlu bar
    // ==========================================
    function createMainTrigger() {
        if (document.getElementById('oxyMasterBar')) return;

        const bar = document.createElement('div');
        bar.id = 'oxyMasterBar';
        bar.style.cssText = `position:fixed;bottom:30px;left:20px;display:flex;gap:8px;
            z-index:999999;flex-wrap:wrap;font-family:sans-serif;`;

        const baseBtnStyle = `border:none;border-radius:24px;padding:12px 20px;font-size:15px;
            color:#fff;font-family:sans-serif;box-shadow:0 4px 12px rgba(0,0,0,0.3);
            cursor:pointer;font-weight:normal;`;

        const seyrBtn = document.createElement('button');
        seyrBtn.innerHTML = '🧭 <b>Seyrüsefer</b>';
        seyrBtn.title = 'Türkiye · Dünya · NYT — her birinden en yeni 20';
        seyrBtn.style.cssText = baseBtnStyle + 'background-color:#0056b3;';
        seyrBtn.onclick = () => runSeyrusefer().catch(err => console.error('[Seyrüsefer]', err));

        const yazBtn = document.createElement('button');
        yazBtn.innerHTML = '✍️ <b>Yazarlar</b>';
        yazBtn.title = 'Seçtiğin yazarların yazılarını çek (Ninja)';
        yazBtn.style.cssText = baseBtnStyle + 'background-color:#2ecc71;';
        yazBtn.onclick = () => {
            sessionStorage.setItem('OXY_NINJA_RUN', 'true');
            sessionStorage.setItem('OXY_NINJA_SCROLLS', '4');
            sessionStorage.setItem('OXY_NINJA_DATE', '');
            sessionStorage.setItem('OXY_NINJA_PREFIX', '');
            window.location.href = '/yazarlar';
        };

        const gelBtn = document.createElement('button');
        gelBtn.innerHTML = '⚙️ <b>Gelişmiş</b>';
        gelBtn.title = 'Kategori, tarih, sayfa — hepsi elle';
        gelBtn.style.cssText = baseBtnStyle + 'background-color:#7f8c8d;';
        gelBtn.onclick = () => openPanel();

        bar.appendChild(seyrBtn);
        bar.appendChild(yazBtn);
        bar.appendChild(gelBtn);
        document.body.appendChild(bar);
    }

    // ==========================================
    // GELİŞMİŞ PANEL
    // ==========================================
    function openPanel() {
        if (document.getElementById('oxyPanelOverlay')) return;

        const overlay = document.createElement('div');
        overlay.id = 'oxyPanelOverlay';
        overlay.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;
            background:rgba(0,0,0,0.85);z-index:9999999;display:flex;align-items:center;justify-content:center;`;
        const panel = document.createElement('div');
        panel.style.cssText = `background:#fff;border-radius:12px;width:540px;max-width:95%;
            padding:24px;font-family:sans-serif;box-shadow:0 20px 40px rgba(0,0,0,0.4);max-height:92vh;overflow-y:auto;`;

        panel.innerHTML = `
            <h2 style="margin-top:0;color:#0056b3;border-bottom:2px solid #0056b3;padding-bottom:10px;">⚙️ Gelişmiş — Kategori Seçimi</h2>

            <div id="ikWarnYazarlar" style="display:none;background:#fef5e7;border-left:4px solid #e67e22;padding:10px 14px;border-radius:6px;margin-bottom:12px;font-size:13px;color:#7a5c1a;">
                ⚠️ <b>Yazarlar (Ninja) modu seçildi.</b> Bu kategori diğerleriyle birleştirilemez. Diğer checkbox'lar devre dışı bırakıldı.
            </div>

            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <div style="font-weight:bold;color:#555;">Kategoriler (${CATS.length})</div>
                <div>
                    <button id="btnAll" type="button" style="padding:4px 10px;border:1px solid #ccc;background:#fff;border-radius:4px;cursor:pointer;font-size:12px;">Tümünü Seç</button>
                    <button id="btnNone" type="button" style="padding:4px 10px;border:1px solid #ccc;background:#fff;border-radius:4px;cursor:pointer;font-size:12px;">Temizle</button>
                </div>
            </div>
            <div style="border:1px solid #ddd;border-radius:6px;padding:10px;max-height:280px;overflow-y:auto;background:#fafafa;margin-bottom:16px;">
                ${CATS.map(c => `
                    <label id="lbl_${c.slug}" style="display:block;padding:6px 8px;cursor:pointer;border-radius:4px;">
                        <input type="checkbox" class="cat-check" data-slug="${c.slug}" data-special="${c.special ? '1' : '0'}" value="${c.slug}" style="margin-right:8px;"> ${c.name}${IFRAME_FIRST_CATS.has(c.slug) ? ' <span style="font-size:10px;color:#888;">(iframe)</span>' : ''}
                    </label>
                `).join('')}
            </div>

            <div style="display:flex;gap:14px;margin-bottom:14px;">
                <div style="flex:1;">
                    <label style="display:block;font-weight:bold;color:#555;margin-bottom:5px;">📅 Tarih (boş = tümü):</label>
                    <input type="date" id="ikDate" style="width:100%;padding:10px;border-radius:6px;border:1px solid #ccc;color:#333;box-sizing:border-box;">
                </div>
                <div style="flex:1;">
                    <label id="ikScrollsLabel" style="display:block;font-weight:bold;color:#555;margin-bottom:5px;">📄 Sayfa sayısı (kategori başına):</label>
                    <input type="number" id="ikScrolls" value="2" min="1" max="20" style="width:100%;padding:10px;border-radius:6px;border:1px solid #ccc;color:#333;box-sizing:border-box;">
                </div>
            </div>

            <div style="margin-bottom:16px;">
                <label style="display:block;font-weight:bold;color:#555;margin-bottom:5px;">📛 Dosya adı öneki (opsiyonel):</label>
                <input type="text" id="ikPrefix" placeholder="Örn: Arsivim (boş = otomatik)" style="width:100%;padding:10px;border-radius:6px;border:1px solid #ccc;color:#333;box-sizing:border-box;">
            </div>

            <div id="ikSummary" style="background:#f8f9fa;border-left:4px solid #0056b3;padding:10px 14px;border-radius:6px;margin-bottom:20px;font-size:13px;color:#555;">
                Hiçbir kategori seçilmedi.
            </div>

            <div style="display:flex;gap:10px;">
                <button id="ikCancel" style="flex:1;padding:12px;border:none;background:#95a5a6;color:white;border-radius:6px;cursor:pointer;font-weight:bold;">İptal</button>
                <button id="ikStart"  style="flex:2;padding:12px;border:none;background:#0056b3;color:white;border-radius:6px;cursor:pointer;font-weight:bold;">🚀 EPUB Üret</button>
            </div>
        `;
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        const allCheckboxes = Array.from(panel.querySelectorAll('.cat-check'));
        const yazarlarCb = allCheckboxes.find(cb => cb.dataset.special === '1');

        const applySpecialState = () => {
            const yazarlarChecked = yazarlarCb && yazarlarCb.checked;
            const warn = document.getElementById('ikWarnYazarlar');
            allCheckboxes.forEach(cb => {
                if (cb === yazarlarCb) return;
                const lbl = cb.closest('label');
                if (yazarlarChecked) {
                    cb.disabled = true;
                    cb.checked = false;
                    if (lbl) { lbl.style.opacity = '0.4'; lbl.style.cursor = 'not-allowed'; }
                } else {
                    cb.disabled = false;
                    if (lbl) { lbl.style.opacity = '1'; lbl.style.cursor = 'pointer'; }
                }
            });
            warn.style.display = yazarlarChecked ? 'block' : 'none';
        };

        const updateSummary = () => {
            applySpecialState();
            const checked = allCheckboxes.filter(cb => cb.checked).map(cb => cb.value);
            const isNinja = checked.length === 1 && checked[0] === 'yazarlar';

            const scrollsLabelEl = document.getElementById('ikScrollsLabel');
            if (scrollsLabelEl) {
                scrollsLabelEl.textContent = isNinja ? '📜 Kaydırma sayısı (Ninja):' : '📄 Sayfa sayısı (kategori başına):';
            }

            const el = document.getElementById('ikSummary');
            if (checked.length === 0) {
                el.innerHTML = 'Hiçbir kategori seçilmedi.';
                el.style.borderLeftColor = '#e74c3c';
            } else {
                const catNames = checked.map(s => { const c = CATS.find(x => x.slug === s); return c ? c.name : s; });
                const today = new Date().toISOString().split('T')[0];
                const exampleName = buildEpubName('', 'Oksijen', catNames, today);
                const hasIframeCat = checked.some(s => IFRAME_FIRST_CATS.has(s));
                let notes = [];
                if (isNinja) notes.push('Ninja modu');
                if (hasIframeCat) notes.push('iframe modu (yavaş olabilir)');
                const noteStr = notes.length ? ' (' + notes.join(' + ') + ')' : '';
                el.innerHTML = `📊 Seçili: <b>${checked.length}</b> kategori${noteStr}<br>📄 Örnek: <code style="background:#fff;padding:2px 4px;border-radius:3px;font-size:11px;">${htmlEscape(exampleName)}</code>`;
                el.style.borderLeftColor = '#0056b3';
            }
        };
        allCheckboxes.forEach(cb => cb.addEventListener('change', updateSummary));

        document.getElementById('btnAll').onclick = () => {
            allCheckboxes.forEach(cb => { if (!cb.disabled) cb.checked = true; });
            updateSummary();
        };
        document.getElementById('btnNone').onclick = () => {
            allCheckboxes.forEach(cb => cb.checked = false);
            updateSummary();
        };
        document.getElementById('ikCancel').onclick = () => overlay.remove();

        document.getElementById('ikStart').onclick = () => {
            const checked = allCheckboxes.filter(cb => cb.checked).map(cb => cb.value);
            if (checked.length === 0) { alert('En az 1 kategori seçin!'); return; }
            const date = document.getElementById('ikDate').value || '';
            const pages = parseInt(document.getElementById('ikScrolls').value, 10) || 2;
            const prefix = document.getElementById('ikPrefix').value.trim();
            overlay.remove();

            const isNinja = checked.length === 1 && checked[0] === 'yazarlar';
            if (isNinja) {
                sessionStorage.setItem('OXY_NINJA_RUN', 'true');
                sessionStorage.setItem('OXY_NINJA_SCROLLS', String(pages));
                sessionStorage.setItem('OXY_NINJA_DATE', date);
                sessionStorage.setItem('OXY_NINJA_PREFIX', prefix);
                window.location.href = '/yazarlar';
            } else {
                runScan(checked, date, pages, prefix);
            }
        };
        updateSummary();
    }

    // ==========================================
    // GELİŞMİŞ TARAMA
    // ==========================================
    async function runScan(cats, date, pages, prefix) {
        const catNames = cats.map(s => { const c = CATS.find(x => x.slug === s); return c ? c.name : s; });
        const hasIframeCat = cats.some(s => IFRAME_FIRST_CATS.has(s));
        const lock = createProgressOverlay('📰 Oksijen Taranıyor', `${catNames.join(', ')}<br>Tarih: ${date || 'Tümü'} · Sayfa: ${pages}${hasIframeCat ? '<br><span style="color:#f39c12;">⚠️ FT/Economist için iframe modu — biraz yavaş olabilir</span>' : ''}`);
        let articles = [];
        let emptyCats = [];
        try {
            const scanResult = await multiCategoryScan(cats, date, pages, lock);
            articles = scanResult.articles || [];
            emptyCats = scanResult.emptyCats || [];
        } catch (e) { console.error('[Oksijen] tarama hata:', e); }
        lock.close();
        if (CANCELLED) return;
        if (articles.length === 0) {
            const catList = emptyCats.length ? `\n\nBoş dönen kategoriler: ${emptyCats.join(', ')}` : '';
            alert(`Hiç makale bulunamadı.${catList}\n\nOlası nedenler:\n• Tarih filtresi çok dar olabilir\n• Kategori sayfası boş veya yapısı değişmiş olabilir\n• Ağ veya oturum sorunu (konsolu kontrol edin: F12)`);
            return;
        }
        articles.forEach((a, i) => a.originalIndex = i);
        articles.sort((a, b) => (b.fullDateObj?.getTime() || 0) - (a.fullDateObj?.getTime() || 0));
        const epubName = buildEpubName(prefix, 'Oksijen', catNames, date || 'Tum_Yazilar');
        showSelectionUI(articles, epubName, date || 'Tüm Yazılar', false);
    }

    // ==========================================
    // NINJA MODU
    // ==========================================
    async function runNinjaMode() {
        const scrolls = parseInt(sessionStorage.getItem('OXY_NINJA_SCROLLS'), 10) || 4;
        const date = sessionStorage.getItem('OXY_NINJA_DATE') || '';
        const prefix = sessionStorage.getItem('OXY_NINJA_PREFIX') || '';
        sessionStorage.removeItem('OXY_NINJA_RUN');
        sessionStorage.removeItem('OXY_NINJA_SCROLLS');
        sessionStorage.removeItem('OXY_NINJA_DATE');
        sessionStorage.removeItem('OXY_NINJA_PREFIX');

        let lastH = document.body.scrollHeight;
        for (let i = 0; i < scrolls; i++) {
            window.scrollTo(0, document.body.scrollHeight);
            await sleep(1200);
            const nh = document.body.scrollHeight;
            if (nh === lastH) break;
            lastH = nh;
        }

        const cards = getAuthorCards();
        if (cards.length === 0) {
            alert("Bu sayfada yazar kartı bulunamadı. Sayfayı kaydırıp tekrar deneyin.");
            return;
        }
        showAuthorFilterUI(cards, date, prefix);
    }

    function showAuthorFilterUI(allCards, presetDate, presetPrefix) {
        const authors = [...new Set(allCards.map(c => c.name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'tr'));
        let filteredCards = [...allCards];

        const overlay = document.createElement('div');
        overlay.id = 'oxyAuthorFilterOverlay';
        overlay.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,40,80,0.90);z-index:9999999;display:flex;align-items:center;justify-content:center;`;
        const panel = document.createElement('div');
        panel.style.cssText = `background:#fff;border-radius:12px;width:460px;padding:24px;font-family:sans-serif;box-shadow:0 20px 40px rgba(0,0,0,0.5);display:flex;flex-direction:column;gap:15px;`;

        panel.innerHTML = `
            <h2 style="margin:0;color:#0056b3;border-bottom:2px solid #eee;padding-bottom:10px;">✍️ Yazarlar Filtre Ekranı</h2>
            <div style="background:#f8f9fa;padding:15px;border-radius:8px;border:1px solid #ddd;">
                <label style="display:block;font-weight:bold;color:#333;margin-bottom:5px;">Tarih ve Kural:</label>
                <div style="display:flex;gap:10px;margin-bottom:15px;">
                    <input type="date" id="fltDate" value="${presetDate || ''}" style="flex:2;padding:10px;border-radius:6px;border:1px solid #ccc;box-sizing:border-box;">
                    <select id="fltOp" style="flex:1;padding:10px;border-radius:6px;border:1px solid #ccc;font-weight:bold;">
                        <option value="=">=</option><option value=">=">&gt;=</option><option value="<=">&lt;=</option>
                    </select>
                </div>
                <label style="display:block;font-weight:bold;color:#333;margin-bottom:5px;">Yazar:</label>
                <select id="fltAuthor" style="width:100%;padding:10px;border-radius:6px;border:1px solid #ccc;">
                    <option value="">Tüm yazarlar</option>
                    ${authors.map(a => `<option value="${htmlEscape(a)}">${htmlEscape(a)}</option>`).join('')}
                </select>
            </div>
            <div id="fltStatus" style="text-align:center;font-weight:bold;color:#e67e22;">${allCards.length} yazar yazısı bulundu.</div>
            <div style="display:flex;gap:10px;">
                <button id="btnFltApply" style="flex:1;padding:12px;background:#f39c12;color:white;border:none;border-radius:6px;cursor:pointer;font-weight:bold;">Filtrele</button>
                <button id="btnFltReset" style="flex:1;padding:12px;background:#95a5a6;color:white;border:none;border-radius:6px;cursor:pointer;font-weight:bold;">Temizle</button>
            </div>
            <button id="btnFltFetch" style="width:100%;padding:14px;background:#2ecc71;color:white;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:16px;">🚀 Yazıları Çek (Ninja)</button>
            <button id="btnFltCancel" style="width:100%;padding:10px;background:transparent;color:#7f8c8d;border:none;cursor:pointer;text-decoration:underline;">İptal</button>
        `;
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        const updateCount = () => {
            document.getElementById('fltStatus').innerText = `${filteredCards.length} yazı çekilecek.`;
        };

        document.getElementById('btnFltApply').onclick = () => {
            const dVal = document.getElementById('fltDate').value;
            const op = document.getElementById('fltOp').value;
            const aVal = document.getElementById('fltAuthor').value;
            const targetDate = dVal ? parseTRDate(dVal) : null;
            filteredCards = allCards.filter(c => {
                const dateOk = targetDate ? cmp(c.dateObj, targetDate, op) : true;
                const authorOk = aVal ? c.name === aVal : true;
                return dateOk && authorOk;
            });
            updateCount();
        };
        document.getElementById('btnFltReset').onclick = () => {
            document.getElementById('fltDate').value = '';
            document.getElementById('fltOp').value = '=';
            document.getElementById('fltAuthor').value = '';
            filteredCards = [...allCards];
            updateCount();
        };
        document.getElementById('btnFltCancel').onclick = () => overlay.remove();

        document.getElementById('btnFltFetch').onclick = async () => {
            if (filteredCards.length === 0) { alert("Çekilecek yazı yok!"); return; }
            const finalDate = document.getElementById('fltDate')?.value || presetDate || '';

            document.getElementById('fltStatus').innerHTML = `<span style="color:#2ecc71;">İndiriliyor...</span>`;
            document.getElementById('btnFltFetch').disabled = true;
            const results = [];
            for (let i = 0; i < filteredCards.length; i += REQUEST_POLICY.concurrency) {
                const chunk = filteredCards.slice(i, i + REQUEST_POLICY.concurrency);
                document.getElementById('fltStatus').innerText = `Çekiliyor: ${Math.min(i + chunk.length, filteredCards.length)}/${filteredCards.length}`;
                const chunkRes = await Promise.all(chunk.map(item => fetchArticleViaIframe(item)));
                results.push(...chunkRes);
                if (i + REQUEST_POLICY.concurrency < filteredCards.length) await sleep(randomDelay());
            }
            overlay.remove();
            results.forEach((a, i) => { a.originalIndex = i; a.catName = 'Yazarlar'; a.source = 'Oksijen'; });
            const fileDate = finalDate || 'Tum_Yazilar';
            const epubName = buildEpubName(presetPrefix || '', 'Oksijen', ['Yazarlar'], fileDate);
            showSelectionUI(results, epubName, finalDate || 'Özel Seçim', false);
        };
    }

    // ==========================================
    // SEÇİM EKRANI
    // ==========================================
    function showSelectionUI(articles, epubFileName, displayDate, groupByCategory) {
        if (document.getElementById('oxySelectionOverlay')) return;

        articles.forEach((art, idx) => { art.id = 'art_' + idx; art.isSelected = true; });

        const overlay = document.createElement('div');
        overlay.id = 'oxySelectionOverlay';
        overlay.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;
            background:rgba(0,0,0,0.85);z-index:9999999;display:flex;align-items:center;justify-content:center;`;
        const panel = document.createElement('div');
        panel.style.cssText = `background:#fff;border-radius:12px;width:90%;max-width:960px;height:88vh;
            display:flex;flex-direction:column;font-family:sans-serif;box-shadow:0 20px 40px rgba(0,0,0,0.5);overflow:hidden;`;

        const header = document.createElement('div');
        header.style.cssText = `padding:20px;background:#f8f9fa;border-bottom:1px solid #ddd;display:flex;flex-direction:column;gap:12px;`;
        header.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;">
                <h2 style="margin:0;color:#0056b3;">📑 ${groupByCategory ? '🧭 Seyrüsefer' : 'Makale Seçim Ekranı'} (${displayDate})</h2>
                <span id="selectedCountSpan" style="font-weight:bold;color:#fff;background:#0056b3;padding:5px 12px;border-radius:6px;">Seçili: ${articles.length}</span>
            </div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
                <input type="text" id="liveSearchAuthor" placeholder="👤 Yazar ara" style="flex:1;min-width:150px;padding:10px;border-radius:6px;border:1px solid #ccc;font-size:14px;color:#333;">
                <input type="text" id="liveSearchTitle" placeholder="🔍 Başlık ara..." style="flex:2;min-width:200px;padding:10px;border-radius:6px;border:1px solid #ccc;font-size:14px;color:#333;">
            </div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
                <button id="btnSortDesc" style="padding:10px;background:#fff;color:#333;border:1px solid #ccc;border-radius:6px;cursor:pointer;font-weight:bold;flex:1;">⬇️ Yeniden Eskiye</button>
                <button id="btnSortAsc" style="padding:10px;background:#fff;color:#333;border:1px solid #ccc;border-radius:6px;cursor:pointer;font-weight:bold;flex:1;">⬆️ Eskiden Yeniye</button>
            </div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
                <button id="btnSelectAll" style="padding:8px 12px;background:#fff;color:#333;border:1px solid #ccc;border-radius:6px;cursor:pointer;font-weight:bold;flex:1;">Tümünü Seç</button>
                <button id="btnSelectVisible" style="padding:8px 12px;background:#fff;color:#333;border:1px solid #ccc;border-radius:6px;cursor:pointer;font-weight:bold;flex:1;">Görünenleri Seç</button>
                <button id="btnDeselectAll" style="padding:8px 12px;background:#fff;color:#333;border:1px solid #ccc;border-radius:6px;cursor:pointer;font-weight:bold;flex:1;">Seçimi Kaldır</button>
            </div>
        `;

        const listDiv = document.createElement('div');
        listDiv.style.cssText = `flex:1;overflow-y:auto;padding:15px;background:#fff;`;

        const footer = document.createElement('div');
        footer.style.cssText = `padding:20px;background:#f8f9fa;border-top:1px solid #ddd;display:flex;justify-content:flex-end;gap:12px;flex-wrap:wrap;`;
        footer.innerHTML = `
            <button id="btnCancel" style="padding:12px 24px;background:#95a5a6;color:white;border:none;border-radius:6px;cursor:pointer;font-weight:bold;">İptal</button>
            <button id="btnDrive" style="padding:12px 24px;background:#f39c12;color:white;border:none;border-radius:6px;cursor:pointer;font-weight:bold;">☁️ Drive'a Gönder</button>
            <button id="btnEpub" style="padding:12px 24px;background:#2ecc71;color:white;border:none;border-radius:6px;cursor:pointer;font-weight:bold;">💾 EPUB İndir</button>
        `;

        panel.appendChild(header);
        panel.appendChild(listDiv);
        panel.appendChild(footer);
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        const searchAuthor = panel.querySelector('#liveSearchAuthor');
        const searchTitle = panel.querySelector('#liveSearchTitle');

        const updateCounter = () => {
            document.getElementById('selectedCountSpan').innerText = `Seçili: ${articles.filter(a => a.isSelected).length}`;
        };

        const applySearch = () => {
            const aQuery = searchAuthor.value.toLowerCase().trim();
            const tQuery = searchTitle.value.toLowerCase().trim();
            const noFilter = !aQuery && !tQuery;
            articles.forEach(art => {
                const itemEl = document.getElementById(`item_${art.id}`);
                if (!itemEl) return;
                if (noFilter) {
                    itemEl.style.display = 'flex';
                    itemEl.style.background = 'transparent';
                    return;
                }
                const matchA = !aQuery || (art.author && art.author.toLowerCase().includes(aQuery));
                const matchT = !tQuery || (art.title && art.title.toLowerCase().includes(tQuery));
                if (matchA && matchT) {
                    itemEl.style.display = 'flex';
                    itemEl.style.background = '#e8f6f3';
                } else {
                    itemEl.style.display = 'none';
                    itemEl.style.background = 'transparent';
                }
            });
        };

        const sortArticles = (order) => {
            if (groupByCategory) {
                const catOrder = ['Türkiye', 'Dünya', 'New York Times'];
                articles.sort((a, b) => {
                    const ca = catOrder.indexOf(a.catName);
                    const cb = catOrder.indexOf(b.catName);
                    if (ca !== cb) return (ca === -1 ? 99 : ca) - (cb === -1 ? 99 : cb);
                    const at = a.fullDateObj?.getTime() || 0;
                    const bt = b.fullDateObj?.getTime() || 0;
                    return order === 'desc' ? bt - at : at - bt;
                });
            } else {
                articles.sort((a, b) => {
                    const at = a.fullDateObj ? a.fullDateObj.getTime() : 0;
                    const bt = b.fullDateObj ? b.fullDateObj.getTime() : 0;
                    const timeDiff = bt - at;
                    if (order === 'desc') return timeDiff === 0 ? a.originalIndex - b.originalIndex : timeDiff;
                    return timeDiff === 0 ? a.originalIndex - b.originalIndex : -timeDiff;
                });
            }
            renderList();
        };

        const renderList = () => {
            listDiv.innerHTML = '';
            let lastCat = null;
            articles.forEach((art) => {
                if (groupByCategory && art.catName !== lastCat) {
                    listDiv.insertAdjacentHTML('beforeend', `
                        <div style="padding:12px 0 8px;margin-top:${lastCat ? '16px' : '0'};border-top:${lastCat ? '2px solid #0056b3' : 'none'};font-weight:bold;color:#0056b3;font-size:15px;">
                            ${htmlEscape(art.catName || 'Diğer')}
                        </div>
                    `);
                    lastCat = art.catName;
                }
                const articleDate = art.publishDateStr || (art.fullDateObj ? art.fullDateObj.toISOString().split('T')[0] : '');
                const authorTag = art.author ? `<span style="color:#e67e22;font-weight:bold;">${htmlEscape(art.author)}</span> | ` : '';
                const catBadge = (!groupByCategory && art.catName) ? `<span style="font-size:11px;color:#666;background:#f0f0f0;padding:2px 6px;border-radius:4px;margin-right:6px;">${htmlEscape(art.catName)}</span>` : '';
                listDiv.insertAdjacentHTML('beforeend', `
                    <div id="item_${art.id}" style="display:flex;align-items:flex-start;padding:12px;border-bottom:1px solid #eee;gap:12px;border-radius:6px;">
                        <input type="checkbox" id="cb_${art.id}" class="art-checkbox" ${art.isSelected ? 'checked' : ''} style="width:20px;height:20px;margin-top:2px;cursor:pointer;">
                        <label for="cb_${art.id}" style="cursor:pointer;flex:1;">
                            <div style="font-weight:bold;color:#111;margin-bottom:5px;font-size:15px;">${catBadge}${htmlEscape(art.title)}</div>
                            <div style="font-size:12px;color:#7f8c8d;">
                                ${authorTag}Tarih: <b>${htmlEscape(articleDate)}</b> &nbsp;|&nbsp;
                                <a href="${htmlEscape(art.url)}" target="_blank" style="color:#0056b3;text-decoration:none;" onclick="event.stopPropagation();">Kaynağa Git 🔗</a>
                            </div>
                        </label>
                    </div>
                `);
            });
            document.querySelectorAll('.art-checkbox').forEach(cb => {
                cb.addEventListener('change', (e) => {
                    const found = articles.find(a => a.id === e.target.id.replace('cb_', ''));
                    if (found) found.isSelected = e.target.checked;
                    updateCounter();
                });
            });
            if (searchAuthor.value.trim() || searchTitle.value.trim()) applySearch();
        };

        searchAuthor.addEventListener('input', applySearch);
        searchTitle.addEventListener('input', applySearch);

        panel.querySelector('#btnSortDesc').onclick = () => sortArticles('desc');
        panel.querySelector('#btnSortAsc').onclick = () => sortArticles('asc');
        panel.querySelector('#btnSelectAll').onclick = () => {
            articles.forEach(art => art.isSelected = true);
            renderList();
            updateCounter();
        };
        panel.querySelector('#btnSelectVisible').onclick = () => {
            articles.forEach(art => {
                const itemEl = document.getElementById(`item_${art.id}`);
                if (itemEl && itemEl.style.display !== 'none') {
                    art.isSelected = true;
                    const cb = document.getElementById(`cb_${art.id}`);
                    if (cb) cb.checked = true;
                }
            });
            updateCounter();
        };
        panel.querySelector('#btnDeselectAll').onclick = () => {
            articles.forEach(art => art.isSelected = false);
            renderList();
            updateCounter();
        };
        panel.querySelector('#btnCancel').onclick = () => overlay.remove();

        const processExport = (mode) => {
            const selected = articles.filter(art => art.isSelected);
            if (selected.length === 0) { alert("En az bir makale seçin!"); return; }
            overlay.remove();
            generateEpub(selected, epubFileName, displayDate, mode);
        };
        panel.querySelector('#btnEpub').onclick = () => processExport('epub');
        panel.querySelector('#btnDrive').onclick = () => processExport('drive');

        sortArticles('desc');
    }

    // ==========================================
    // EPUB
    // ==========================================
    async function generateEpub(articles, epubFileName, displayDate, mode) {
        const lockScreen = document.createElement('div');
        lockScreen.id = 'ikOverlay';
        lockScreen.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;
            background:rgba(0,86,179,0.95);z-index:9999999;display:flex;flex-direction:column;
            align-items:center;justify-content:center;color:white;font-family:sans-serif;text-align:center;padding:20px;box-sizing:border-box;`;
        lockScreen.innerHTML = `<h1>📦 EPUB Paketleniyor</h1><p>${articles.length} makale...</p><h2 id="exportStatus" style="color:#f1c40f;">Bekleyin...</h2>`;
        document.body.appendChild(lockScreen);
        await sleep(500);

        try {
            const zip = new JSZip();
            zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
            zip.folder('META-INF').file('container.xml', `<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
            const oebps = zip.folder('OEBPS');
            const today = new Date().toISOString().split('T')[0];

            const catNamesList = [...new Set(articles.map(a => a.catName).filter(Boolean))];
            const dcTitle = `Oksijen — ${catNamesList.join(', ') || 'Seçki'} (${displayDate})`;

            const coverSvg = `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 800" width="100%" height="100%"><rect width="600" height="800" fill="#ffffff"/><text x="300" y="230" font-family="Arial,sans-serif" font-size="56" font-weight="700" fill="#111111" text-anchor="middle">OKSİJEN</text><text x="300" y="340" font-family="Arial,sans-serif" font-size="20" font-weight="400" fill="#333333" text-anchor="middle">${htmlEscape(catNamesList.slice(0, 3).join(', ').toUpperCase())}</text><text x="300" y="420" font-family="Arial,sans-serif" font-size="20" fill="#666666" text-anchor="middle">${htmlEscape(displayDate)}</text></svg>`;
            oebps.file('cover.svg', coverSvg);
            oebps.file('cover.xhtml', `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Kapak</title><meta charset="utf-8"/></head><body style="margin:0;padding:0;text-align:center;height:100%;"><img src="cover.svg" alt="Kapak" style="max-width:100%;max-height:100%;"/></body></html>`);

            let manifest = `\n<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>\n<item id="cover-image" href="cover.svg" media-type="image/svg+xml"/>\n<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`;
            let spine = '\n<itemref idref="cover"/>';
            let navMap = '';

            articles.forEach((art, idx) => {
                const artId = `item${idx + 1}`;
                const artFile = `${artId}.xhtml`;
                const rawContent = Array.isArray(art.content) ? art.content : String(art.content || '').split(/\n{2,}|\n/).map(p => p.trim()).filter(Boolean);
                const contentArr = rawContent.filter(p => p.length > 3);
                const bodyHtml = contentArr.map(p => `<p>${htmlEscape(p)}</p>`).join('\n');
                const authorHtml = art.author ? `<p class="author">${htmlEscape(art.author)}</p>` : '';
                const catLine = art.catName ? `<p style="font-size:0.85em;color:#555;font-style:italic;">Oksijen · ${htmlEscape(art.catName)}</p>` : '';
                const xhtml = `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${htmlEscape(art.title)}</title><meta charset="utf-8"/><style>body{margin:0;padding:0;font-family:serif;line-height:1.5;}h1{font-size:1.4em;margin:0 0 0.8em 0;font-weight:bold;}.author{margin:0 0 1.2em 0;font-style:italic;}p{margin:0 0 1em 0;text-align:justify;}</style></head><body><h1>${htmlEscape(art.title)}</h1>${authorHtml}${catLine}${bodyHtml}</body></html>`;
                oebps.file(artFile, xhtml);
                manifest += `\n<item id="${artId}" href="${artFile}" media-type="application/xhtml+xml"/>`;
                spine += `\n<itemref idref="${artId}"/>`;
                navMap += `\n<navPoint id="nav-${idx+1}" playOrder="${idx+1}"><navLabel><text>${htmlEscape(art.title)}</text></navLabel><content src="${artFile}"/></navPoint>`;
            });

            oebps.file('content.opf', `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" xmlns:opf="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${htmlEscape(dcTitle)}</dc:title><dc:creator opf:role="aut" opf:file-as="Oksijen">Oksijen</dc:creator><dc:publisher>Oksijen</dc:publisher><dc:language>tr</dc:language><dc:date>${today}</dc:date><dc:identifier id="BookId">oxy-${Date.now()}</dc:identifier><meta name="cover" content="cover-image"/></metadata><manifest>${manifest}</manifest><spine toc="ncx">${spine}</spine></package>`);
            oebps.file('toc.ncx', `<?xml version="1.0" encoding="UTF-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><docTitle><text>${htmlEscape(dcTitle)}</text></docTitle><navMap>${navMap}</navMap></ncx>`);

            const epubBlob = await zip.generateAsync({ type: 'blob' });
            const statusLabel = document.getElementById('exportStatus');

            if (mode === 'epub') {
                statusLabel.innerText = "İndiriliyor...";
                const link = document.createElement('a');
                link.href = URL.createObjectURL(epubBlob);
                link.download = epubFileName;
                link.click();
                setTimeout(() => { URL.revokeObjectURL(link.href); lockScreen.remove(); }, 2000);
            } else if (mode === 'drive') {
                statusLabel.innerText = "☁️ Drive'a yedekleniyor...";
                const reader = new FileReader();
                reader.onloadend = async () => {
                    try {
                        await fetch(GOOGLE_SCRIPT_URL, {
                            method: 'POST', mode: 'no-cors',
                            body: JSON.stringify({ content: reader.result.split(',')[1], filename: epubFileName })
                        });
                        lockScreen.innerHTML = `
                            <h1 style="color:#2ecc71;">✅ Yükleme İsteği Gönderildi</h1>
                            <p style="color:#ddd;font-size:15px;max-width:400px;">Drive'a yükleme arka planda işleniyor olabilir. Doğrulamak için birkaç saniye sonra Drive klasörünüzü yenileyin.</p>
                        `;
                    } catch (e) {
                        lockScreen.innerHTML = `<h1 style="color:#f1c40f;">⚠️ Drive bağlantı sorunu</h1><p style="color:#ddd;">İnternet bağlantınızı kontrol edin.</p>`;
                    }
                    setTimeout(() => lockScreen.remove(), 5000);
                };
                reader.readAsDataURL(epubBlob);
            }
        } catch (error) {
            console.error(error);
            lockScreen.innerHTML = '<h1 style="color:#e74c3c;">❌ Kritik Hata</h1>';
            setTimeout(() => lockScreen.remove(), 3000);
        }
    }

    // ==========================================
    // BOOTSTRAP
    // ==========================================
    if (sessionStorage.getItem('OXY_NINJA_RUN') === 'true') {
        runNinjaMode().catch(err => console.error('[Ninja] hata:', err));
    } else {
        createMainTrigger();
    }

})();
