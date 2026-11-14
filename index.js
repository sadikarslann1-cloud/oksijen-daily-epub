const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
  console.log("Tarayıcı başlatılıyor...");
  const browser = await puppeteer.launch({ 
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'] 
  });
  const page = await browser.newPage();
  
  console.log("Çerezler yükleniyor...");
  const cookies = JSON.parse(process.env.OKSIJEN_COOKIES);
  await page.setCookie(...cookies);

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
  // Seçim ekranının gelmesini bekle (Maksimum 10 dakika)
  await page.waitForSelector('#oxySelectionOverlay', { timeout: 600000 }); 

  console.log("Seçim ekranı geldi, Drive'a Gönder butonuna basılıyor...");
  await page.evaluate(() => {
    document.getElementById('btnDrive').click();
  });

  console.log("Drive'a yükleniyor, işlemin bitmesi bekleniyor...");
  // Yükleme işleminin tamamlanması için 30 saniye bekle
  await new Promise(r => setTimeout(r, 30000)); 

  console.log("İşlem tamamlandı, tarayıcı kapatılıyor.");
  await browser.close();
})();
