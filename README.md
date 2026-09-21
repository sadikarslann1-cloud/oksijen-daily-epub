# Oksijen Günlük EPUB

Her sabah 06:00'da (TR) otomatik olarak Oksijen'den **Türkiye + Dünya + Ekonomi**
kategorilerinin son 30 saatteki makalelerini çeker, tek bir EPUB üretir ve
Google Drive'a yükler.

## Kurulum (15 dakika)

### 1. GitHub Repo Oluştur

1. [github.com/new](https://github.com/new) adresine git
2. **Repository name**: `oksijen-daily-epub`
3. **Private** seç (önemli — Secret'lar gizli kalsın)
4. **Create repository**

### 2. Dosyaları Yükle

**Yöntem A: Web UI (kolay)**
1. Repo sayfasında **"Add file → Upload files"**
2. Şu 5 dosyayı sürükle-bırak:
   - `index.js`
   - `package.json`
   - `.gitignore`
   - `README.md`
   - `.github/workflows/daily.yml` (klasör yapısını koruman gerekir)
3. **Commit changes**

**Yöntem B: Git (ileri seviye)**
```bash
git clone https://github.com/KULLANICI/oksijen-daily-epub.git
cd oksijen-daily-epub
# dosyaları kopyala
git add .
git commit -m "İlk kurulum"
git push
