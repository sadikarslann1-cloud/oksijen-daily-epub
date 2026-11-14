const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

// Stealth eklentisini etkinleştir
puppeteer.use(StealthPlugin());

(async () => {
  console.log("Tarayıcı başlatılıyor (Stealth modu)...");
  const browser = await puppeteer.launch({ 
    headless: 'new',
    args: [
      '--no-sandbox', 
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ],
    protocolTimeout: 900000 // 15 dakika
  });
  const page = await browser.newPage();
  
  // Ekstra güvenlik için gerçekçi bir User-Agent ayarla
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // Konsol ve hata loglarını yakala
  page.on('console', msg => console.log('Sayfa Logu:', msg.text()));
  page.on('dialog', async dialog => {
    console.log('Sayfa Uyarısı:', dialog.message());
    await dialog.dismiss();
  });

  console.log("Çerezler yükleniyor...");
  try {
    const cookies = JSON.parse(process.env.OKSIJEN_COOKIES);
    await page.setCookie(...cookies);
  } catch (e) {
    console.error("Çerezler yüklenirken hata oluştu. JSON formatını kontrol edin.", e);
    process.exit(1);
  }

  console.log("Oksijen sitesine gidiliyor...");
  try {
    await page.goto('https://gazeteoksijen.com/', { waitUntil: 'networkidle2', timeout: 60000 });
  } catch (e) {
    console.log("Sayfa yüklenirken hata oluştu. Devam ediliyor...");
  }

  console.log("Betik sayfaya enjekte ediliyor...");
  const userscript = fs.readFileSync('./oksiyen.user.js', 'utf8');
  await page.evaluate(userscript);

  console.log("Seyrüsefer başlatılıyor...");
  await page.waitForSelector('#oxyMasterBar button', { timeout: 30000 });
  await page.evaluate(() => {
    document.querySelector('#oxyMasterBar button').click(); // İlk buton: Seyrüsefer
  });

  console.log("Makaleler çekiliyor, seçim ekranı bekleniyor...");
  try {
    await page.waitForSelector('#oxySelectionOverlay', { timeout: 600000 }); 
  } catch (e) {
    console.log("HATA: Seçim ekranı 10 dakika içinde açılmadı!");
    console.log("Olası nedenler: 403 engeli devam ediyor, çerezler geçersiz veya site yapısı değişti.");
    await browser.close();
    return;
  }

  console.log("Seçim ekranı geldi, Drive'a Gönder butonuna basılıyor...");
  await page.evaluate(() => {
    document.getElementById('btnDrive').click();
  });

  console.log("Drive'a yükleniyor, işlemin bitmesi bekleniyor...");
  await new Promise(r => setTimeout(r, 30000)); 

  console.log("İşlem tamamlandı, tarayıcı kapatılıyor.");
  await browser.close();
})();
