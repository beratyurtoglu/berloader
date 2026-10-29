BerLoader

YouTube, Instagram, TikTok, X ve Pinterest'ten video, ses ve görsel indiren, Windows için masaüstü uygulaması. Kişisel kullanım için yazdım.

Neler yapıyor
Platform seçimi zorunlu: İndirmeden önce platformu seçersin, bağlantı başka bir platformunsa uyarır.
Video, ses, görsel: MP4, MP3, M4A, WAV ve görsel olarak indirir. YouTube'da "Görsel" seçeneği kapak resmini indirir.
Düzenleme programı uyumu: Videolar H.264 + AAC MP4 olarak çıkar; Premiere, After Effects ve CapCut'ta sorunsuz açılır. Dosya doğrulanır.
Bölüm indirme (YouTube): Önizleme açılır, sol ve sağ sürgüyle başlangıç ve bitişi seçersin. Kuyrukta "Başka bölüm seç" ile aynı videodan yeni bir parça indirebilirsin.
Çoklu gönderiler: Instagram, TikTok ve X'te birden çok fotoğraf/video olan gönderilerde istediklerini seçersin.
Oynatma listeleri: YouTube listelerini sorarak toplu indirir.
Sıralı kuyruk: İndirmeler sırayla yapılır. Biten işler 24 saat sonra listeden kaldırılır (dosyalara dokunulmaz).
Hesap girişi: Instagram, X, TikTok ve Pinterest için uygulama içinden giriş yapılır; çerezler yalnızca bilgisayarında kalır.
Kendini güncelleyen motorlar: yt-dlp, gallery-dl, deno ve ffmpeg otomatik güncellenir. Uygulamanın kendisi de GitHub Releases üzerinden güncellenir.
Kurulum
Releases sayfasından BerLoader-Setup-<sürüm>.exe dosyasını indir.
Çalıştır ve kurulumu tamamla.
İlk açılışta motorlar kendiliğinden iner (internet gerekir).

Güncellemeler sonrasında uygulama içinden gelir. Ayarlar > Uygulama bölümünde sürümü görebilir, "Güncellemeleri denetle"ye basabilirsin.

Kullanım
Platformu seç.
Bağlantıyı yapıştır, biçimi (ve MP4 için kaliteyi) seç.
İndir'e bas. İşlem kuyruğa eklenir.
Biten dosyayı listeden "Aç" ya da "Klasörde göster" ile bul.

Bir şey çalışmazsa Ayarlar > Tanılama > "Tanılama bilgisini kopyala" ile sürümleri ve son günlük satırlarını alabilirsin. Bağlantı, çerez ve şifre içermez.

Geliştirme

Gereken: Node.js 20 veya üstü.

npm install
npm test        # birim testleri
npm start       # uygulamayı geliştirme modunda aç
npm run dist    # dist/ klasöründe Windows kurulum dosyasını üret

Klasör yapısı ve yayın akışının ayrıntıları için KURULUM.md dosyasına bak.

Sürüm yayınlama
package.json içindeki version değerini artır.
git add -A, git commit, git push
git tag vX.Y.Z ve git push --tags

Etiket package.json sürümüyle aynı olmalı. GitHub Actions kurulum dosyasını derler ve tek bir release olarak yayınlar.

Önemli not

Bu uygulama yalnızca kendi içeriğini ya da indirme hakkın olan içerikleri indirmek içindir. İndirdiğin içeriklerin telif hakkı ve platformların kullanım koşulları senin sorumluluğundadır.

Lisans

Tüm hakları saklıdır. Kişisel kullanım için hazırlanmıştır.
