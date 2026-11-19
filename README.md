# BerLoader

YouTube, Instagram, TikTok, X ve Pinterest'ten video, ses ve görsel indiren Windows masaüstü uygulaması. Kişisel kullanım için yazdım; video kurgusu yaparken ihtiyaç duyduğum şekilde tasarlandı.

## Neler yapıyor

- **Platform seçimi zorunlu:** İndirmeden önce platformu seçersin; bağlantı başka bir platformunsa uyarır.
- **Gerçek kalite listesi:** Bağlantıyı yapıştırınca başlık, süre ve videonun gerçekten sunduğu kaliteler görünür. Eski bir videoda en fazla 720p, 8K destekleyen bir videoda 8K seçeneği çıkar; boş seçenek yoktur.
- **Video, ses, görsel:** MP4, MP3, M4A, WAV ve görsel olarak indirir. YouTube'da "Görsel" seçeneği kapak resmini indirir.
- **Kurgu programı uyumu:** Videolar H.264 + AAC MP4 olarak çıkar ve doğrulanır; Premiere, After Effects ve CapCut'ta sorunsuz açılır.
- **Keserek indir (YouTube):** Önizlemede giriş ve çıkış noktasını kare kare seçersin (‹ › ya da ← →, Shift ile 1 sn, I / O tuşları). Tek seferliktir; açık unutulmaz. Biten bir videodan makas düğmesiyle yeni bir bölüm kesebilirsin.
- **Çoklu gönderiler:** Instagram, TikTok ve X'te birden çok fotoğraf/video olan gönderilerde istediklerini seçersin.
- **Oynatma listeleri:** YouTube listelerini sorarak toplu indirir.
- **Sıralı kuyruk:** İndirmeler sırayla yapılır. Her satırda bağlantıyı kopyalama düğmesi vardır. Biten işler 24 saat sonra listeden kalkar (dosyalara dokunulmaz).
- **Hesap girişi:** Instagram, X, TikTok ve Pinterest için uygulama içinden giriş yapılır; oturum yalnızca bu bilgisayarda kalır.
- **Kendini güncelleyen motorlar:** yt-dlp, gallery-dl, deno ve ffmpeg arka planda güncellenir. Uygulamanın kendisi de GitHub Releases üzerinden güncellenir.

## Kurulum

1. [Releases](../../releases/latest) sayfasından `BerLoader-Setup-<sürüm>.exe` dosyasını indir.
2. Çalıştır ve kurulumu tamamla.
3. İlk açılışta indirme motorları kendiliğinden iner (internet gerekir).

Sonraki sürümler uygulama içinden gelir: hazır olunca üstte "Yeniden başlat" düğmesi çıkar. Ayarlar > Genel > "Güncellemeleri denetle" ile elle de bakabilirsin.

## Kullanım

1. Platformu seç.
2. Bağlantıyı yapıştır; biçimi ve (MP4 için) kaliteyi seç.
3. Bir bölüm istiyorsan **Keserek indir**'e bas.
4. **İndir**. İşlem kuyruğa eklenir; biten dosyayı "Aç" ya da klasör düğmesiyle bulursun.

Bir şey çalışmazsa Ayarlar > Gelişmiş > Tanılama > "Tanılama bilgisini kopyala" ile sürümleri ve son günlük satırlarını alabilirsin. Bağlantı içerir; çerez ve şifre içermez.

## Geliştirme

Gereken: Node.js 20 veya üstü.

```
npm install
npm test        # birim testleri
npm start       # uygulamayı geliştirme modunda aç
npm run dist    # dist/ klasöründe Windows kurulum dosyasını üret
```

Klasör yapısı ve yayın akışının ayrıntıları için [KURULUM.md](KURULUM.md) dosyasına bak.

### Sürüm yayınlama

1. `package.json` içindeki `version` değerini artır.
2. `git add -A`, `git commit`, `git push`
3. `git tag vX.Y.Z` ve `git push --tags`

Etiket `package.json` sürümüyle aynı olmalı. GitHub Actions kurulum dosyasını derler ve tek bir release olarak yayınlar.

## Önemli not

Bu uygulama yalnızca kendi içeriğini ya da indirme hakkın olan içerikleri indirmek içindir. İndirdiğin içeriklerin telif hakkı ve platformların kullanım koşulları senin sorumluluğundadır.

## Lisans

Tüm hakları saklıdır. Kişisel kullanım için hazırlanmıştır. Arayüz yazı tipi Geist, SIL Open Font License ile dağıtılır (`renderer/fonts/Geist-OFL.txt`).
