const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
  console.log("Tarayıcı başlatılıyor...");
  const browser = await puppeteer.launch({ 
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    protocolTimeout: 900000 // 15 dakika süre sınırı
  });
  const page = await browser.newPage();
  
  // Betikten gelen konsol loglarını GitHub ekranında görelim
  page.on('console', msg => console.log('Sayfa Logu:', msg.text()));
  
  // Eğer bir alert (uyarı) açılırsa loglara yaz ve otomatik kapat
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
  await page.goto('https://gazeteoksijen.com/', { waitUntil: 'networkidle2' });

  console.log("Betik sayfaya enjekte ediliyor...");
  const userscript = fs.readFileSync('./oksiyen.user.js', 'utf8');
  await page.evaluate(userscript);

  console.log("Seyrüsefer başlatılıyor...");
  await page.waitForSelector('#oxyMasterBar button');
  await page.evaluate(() => {
    document.querySelector('#oxyMasterBar button').click(); // İlk buton: Seyrüsefer
  });

  console.log("Makaleler çekiliyor, seçim ekranı bekleniyor...");
  try {
    // Seçim ekranının gelmesini bekle (Maksimum 10 dakika)
    await page.waitForSelector('#oxySelectionOverlay', { timeout: 600000 }); 
  } catch (e) {
    console.log("HATA: Seçim ekranı 10 dakika içinde açılmadı!");
    console.log("Olası nedenler: Çerezlerin süresi dolmuş olabilir, site yavaşladı veya Seyrüsefer hiç makale bulamadı.");
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
