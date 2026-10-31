const cheerio = require('cheerio'); // HTML parse etmek için (yüklü değilse: npm install cheerio)

// Ortam değişkenleri kontrolü
const APPS_SCRIPT_URL = process.env.OXY_SCRIPT_URL;
if (!APPS_SCRIPT_URL) {
  console.error('❌ OXY_SCRIPT_URL ortam değişkeni tanımlı değil!');
  process.exit(1);
}

// Bot korumasını atlatmak için gerçek bir Chrome tarayıcısını taklit eden başlıklar
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1'
};

// Gelişmiş Getirme Fonksiyonu (Önce Fetch dener, 403 alırsa Playwright'a geçer)
async function fetchHTML(url) {
  try {
    const response = await fetch(url, { headers: BROWSER_HEADERS });
    
    if (response.status === 403) {
      throw new Error('HTTP 403 - Bot koruması engelledi');
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } catch (error) {
    console.log(`⚠️ Standart istek başarısız oldu (${error.message}). Playwright (Gizli Tarayıcı) devreye giriyor...`);
    
    // EĞER PLAYWRIGHT KULLANACAKSANIZ BURASI ÇALIŞIR
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: BROWSER_HEADERS['User-Agent'],
      locale: 'tr-TR'
    });
    const page = await context.newPage();
    
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const html = await page.content();
    await browser.close();
    
    return html;
  }
}

// Ana İşlem Fonksiyonu
async function main() {
  console.log('🚀 Oksijen Günlük EPUB v2.2 başladı (403 Bypass aktif)');
  
  const categories = ['turkiye', 'dunya', 'ekonomi'];
  const allArticles = [];

  for (const category of categories) {
    console.log(`📂 Kategori taranıyor: ${category}`);
    const categoryUrl = `https://gazeteoksijen.com/${category}`; // URL yapısını kendi sitenize göre kontrol edin
    
    try {
      const html = await fetchHTML(categoryUrl);
      const $ = cheerio.load(html);
      
      // NOT: Aşağıdaki 'a' etiketi seçicisini sitenin gerçek yapısına göre güncellemelisiniz.
      // Örnek olarak sayfadaki haber linklerini topluyoruz.
      const links = [];
      $('a').each((i, el) => {
        const href = $(el).attr('href');
        // Sadece haber detay linklerini filtreleyin (örneğin /haber/ içerenler)
        if (href && href.includes('/haber/') && !links.includes(href)) {
          links.push(href);
        }
      });

      console.log(`🔗 ${category.charAt(0).toUpperCase() + category.slice(1)}: ${links.length} link bulundu.`);
      
      // Sadece ilk 5 haberi çekelim (test için)
      for (const link of links.slice(0, 5)) {
        const articleUrl = link.startsWith('http') ? link : `https://gazeteoksijen.com${link}`;
        try {
          const articleHtml = await fetchHTML(articleUrl);
          const $$ = cheerio.load(articleHtml);
          
          const title = $$('h1').first().text().trim();
          // Makale gövdesini sitenin yapısına göre seçin (örnek: .article-content veya p etiketleri)
          let content = '';
          $$('p').each((i, el) => {
             content += $$(el).text().trim() + '\n\n';
          });

          if (title && content) {
            allArticles.push({ category, title, content, url: articleUrl });
            console.log(`✅ Makale alındı: ${title}`);
          }
        } catch (err) {
          console.log(`⚠️ Makale alınamadı: ${articleUrl} - ${err.message}`);
        }
      }
    } catch (error) {
      console.log(`❌ ${category} kategorisi taranamadı: ${error.message}`);
    }
  }

  console.log(`📊 Toplam ${allArticles.length} makale toplandı.`);

  if (allArticles.length === 0) {
    console.error('❌ Hiçbir makale alınamadı, işlem durduruluyor.');
    process.exit(1);
  }

  // =====================================================================
  // BURAYA KENDİ EPUB OLUŞTURMA VE GOOGLE DRIVE'A YÜKLEME KODUNUZU EKLEYİN
  // =====================================================================
  
  // Örnek:
  // await generateEpub(allArticles);
  // await uploadToDrive(epubBuffer, APPS_SCRIPT_URL);
  
  console.log('✅ İşlem başarıyla tamamlandı.');
}

main().catch(err => {
  console.error('💥 Kritik Hata:', err);
  process.exit(1);
});
