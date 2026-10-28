# BerLoader – Kurulum, Derleme ve Güncelleme Rehberi (v1.1)

## Mimari

| Katman | Teknoloji | Görev |
|---|---|---|
| Kabuk | **Electron** | Pencere, `Setup.exe`, otomatik uygulama güncellemesi |
| Video motoru | **yt-dlp** + **deno** | YouTube, X, TikTok, Instagram videoları (deno: YouTube JS çözücüsü) |
| Görsel motoru | **gallery-dl** (Codeberg, yedek: GitHub `gdl-org/builds`) | Instagram/TikTok/X/Pinterest görselleri, çoklu gönderiler |
| Dönüştürme | **ffmpeg** (`ffmpeg-static`) | Birleştirme, H.264 + AAC uyumluluğu |
| Kurulum paketi | **electron-builder (NSIS)** | `BerLoader-Setup-x.y.z.exe` |
| Uygulama güncellemesi | **electron-updater** + GitHub Releases | Uygulama kendini günceller |

### Motorlar neden ayrı güncellenir?
yt-dlp ve gallery-dl platformlar değiştikçe sık güncellenir. BerLoader bunları uygulamaya gömmez; `%APPDATA%\BerLoader\engine` içine indirir, SHA-256 / `--version` ile doğrular, açılışta ve 6 saatte bir günceller. Bir indirme "çıkarılamadı / 403" gibi hatayla düşerse motoru güncelleyip **bir kez otomatik tekrar dener**. Yani uygulamayı yeniden kurmadan yıllarca çalışır.

### Düzenleme programı uyumu (After Effects, Premiere, CapCut)
- Tüm videolar sonunda **H.264 (High, yuv420p) + AAC, `.mp4`** olur. Kaynak zaten uyumluysa kayıpsız kap değişimi, değilse CRF 16 ile yüksek kaliteli dönüştürme yapılır.
- Çıktı ffmpeg ile **yeniden denetlenir**; uyumsuzsa indirme "hata" olarak işaretlenir, sessizce bozuk dosya bırakmaz.
- Listede her videonun altında gerçek değer görünür: `H.264 · AAC · 2560×1440 · 30 fps · Adobe/CapCut uyumlu ✓`.
- Ayarlar'dan "Adobe ve CapCut uyumu" kapatılırsa ham dosya bırakılır.
- 4K VP9/AV1 → H.264 dönüştürmesi CPU ile yapılır ve uzun sürebilir; 2K çok daha hızlıdır.

---

## 1) Gereken programlar
1. **Node.js LTS** (https://nodejs.org)
2. **Git** ve bir **GitHub hesabı** (güncelleme yayını için)

## 2) İlk kurulum

```powershell
npm install --save-dev --save-exact electron
npm install --save-dev electron-builder
npm install electron-updater ffmpeg-static adm-zip
npm test
npm start
```

İlk açılışta motorlar indirilir (altta "Motorlar…" yazar).

> **Önemli:** Bu komutlardan sonra oluşan **`package-lock.json` dosyasını silme ve GitHub'a yükle.** Otomatik yayın (`npm ci`) buna ihtiyaç duyar.

## 3) Kullanım
1. **Önce platformu seç** (YouTube, Instagram, TikTok, X, Pinterest). Seçmeden indirilemez; yapıştırdığın bağlantı seçtiğin platformla uyuşmazsa uyarır.
2. Bağlantıyı yapıştır, biçimi seç (MP4 / MP3 / M4A / WAV / **Görsel**), **İndir**.
3. Çoklu gönderilerde (kaydırmalı Instagram, TikTok foto, X, Pinterest) küçük resim paneli açılır; istediklerini seç. "Görsel" biçiminde yalnızca fotoğraflar listelenir.
4. Her satırda platform rozeti ve "YouTube'dan indiriliyor %43" gibi durum görünür.
5. Oynatma listesi bağlantısında "tamamını indir?" sorulur; **Hayır** hiçbir şey indirmez. Listeden alınan tek video bağlantısı yalnızca o videoyu indirir.

### Kuyruk ve liste temizliği (v1.2)
- İndirmeler **sırayla** yapılır: biri bitmeden sıradaki başlamaz. İstersen Ayarlar → "Aynı anda indirilecek sayısı" ile artırabilirsin.
- Biten işler **24 saat sonra** listeden otomatik kalkar (indirilen dosyalar silinmez). Ayarlar'dan kapatılabilir.
- **YouTube kapak resmi:** platform YouTube iken biçim olarak "Görsel (kapak resmi)" seç; en yüksek çözünürlüklü JPG iner.

### Instagram / X / TikTok girişi
Bu platformlar çoğu içerik için giriş ister: **Ayarlar → Hesaplar → Giriş yap**. Açılan pencereye normal giriş yaparsın; şifre saklanmaz, yalnızca oturum çerezi bu bilgisayarda tutulur. (YouTube için giriş sunulmaz; Google gömülü girişi engeller. Gerekirse Ayarlar → Gelişmiş çerez.)

## 4) Dosya yapısı
```
berloader/
├─ package.json  main.js  preload.js
├─ src/  platform.js args.js engine.js accounts.js downloader.js store.js logger.js
├─ renderer/  index.html style.css renderer.js assets/logo.png
├─ build/  icon.ico icon.png installerSidebar.bmp installerHeader.bmp logo.svg
├─ test/run-tests.js
└─ .github/  workflows/release.yml  dependabot.yml
```

## 5) Logo ve kurulum görselleri
Hepsi çizilip `build/` içine konmuştur (B harfi + yükleme halkası). Değiştirmek istersen **aynı adla** üstüne yaz: `icon.ico` (16–256 px), `icon.png` (512), `renderer/assets/logo.png`, `installerSidebar.bmp` (164×314, 24 bit), `installerHeader.bmp` (150×57, 24 bit). `logo.svg` düzenlenebilir kaynaktır.

## 6) Kurulum dosyasını üretme
```powershell
npm run dist
```
Çıktı: `dist\BerLoader-Setup-1.1.0.exe` (kullanıcı bazlı kurulum, yönetici izni gerekmez).
"Cannot create symbolic link" hatasında Windows'ta **Geliştirici Modu**'nu aç. İmzasız dosyada SmartScreen çıkarsa: Ek bilgi → Yine de çalıştır.

## 7) Yıllarca güncellenebilir yapı (yayın akışı)

**Bir kerelik hazırlık**
1. GitHub'da `berloader` adlı **public** depo aç.
2. `package.json` içinde `GITHUB_KULLANICI_ADIN` yerine kendi kullanıcı adını yaz.
3. Projeyi (package-lock.json dahil) depoya yükle.
4. Depo → Settings → Actions → General → *Workflow permissions* → **Read and write** seç.

**Her yeni sürümde (token gerekmez)**
```powershell
# 1. package.json'daki "version" değerini artır (örn. 1.1.1)
git add -A
git commit -m "v1.1.1"
git tag v1.1.1
git push
git push --tags
```
GitHub Actions testleri çalıştırır, etiketle `package.json` sürümü aynı mı diye bakar, kurulumu üretir ve Releases'e yükler. Kurulu uygulamalar açılışta ve 4 saatte bir kontrol eder, yeni sürümü indirir ve "Yeniden başlat" düğmesi çıkar.

**Elle yayın (alternatif):** `GH_TOKEN` (repo yetkili) ayarla ve `npm run release`.

**Uzun ömür için kurallar**
- Depoyu silme / adını ya da sahibini değiştirme; `package.json`'daki `owner/repo` ile aynı kalmalı.
- Eski sürümlerin güncelleme alabilmesi için sürüm numarasını hep **artır**, Release'leri silme.
- `.github/dependabot.yml` aylık olarak Electron/paket güncellemesi için PR açar. Merge etmeden önce `npm test` ve `npm start` ile dene, sonra yeni sürüm yayınla. Electron güvenlik yamaları için bunu ihmal etme.
- Motorlar (yt-dlp, gallery-dl, deno) uygulama güncellemesi **gerektirmeden** kendini yeniler. Bir site bozulursa: Ayarlar → yt-dlp kanalı **Nightly** → "Motorları şimdi güncelle".

## 8) Sorun giderme
**Ayarlar → Tanılama → "Tanılama bilgisini kopyala"** sürümleri, durumu ve son günlük satırlarını (çerez/şifre içermez) panoya alır; sorun bildirirken yapıştır. Günlükler: `%APPDATA%\BerLoader\logs\berloader.log`.

| Belirti | Çözüm |
|---|---|
| "Motor hatası" | `github.com` / `codeberg.org` erişimi engelli olabilir; Ayarlar → Motorları şimdi güncelle |
| "ffmpeg H.264 kodlayıcısı yok" | `npm install ffmpeg-static` ile yeniden kur ve tekrar derle |
| Instagram/X/TikTok "giriş gerekli" | Ayarlar → Hesaplar'dan giriş yap |
| Disk uyarısı | İndirme klasöründe en az 500 MB boş yer gerekir |
| Bir site çalışmıyor | Nightly kanalı + motor güncelle |

Veriler (`ayarlar`, geçmiş, motorlar, günlükler) `%APPDATA%\BerLoader` içindedir; kaldırınca silinmez.
