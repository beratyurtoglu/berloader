'use strict';
// Saf (yan etkisiz) yardımcılar: komut satırı argümanları, çıktı ayrıştırma, hata metinleri.
// Electron'a bağımlı değildir, bu yüzden test/ klasöründe doğrudan sınanabilir.

const path = require('path');

const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', 'flv']);
// Adobe ve CapCut'ın sorun çıkarabildiği görsel biçimleri PNG'ye çevrilir.
const IMAGE_CONVERT_EXT = new Set(['webp', 'avif']);

function sanitizeName(s, max = 80) {
  const clean = String(s || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f%]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, max)
    .trim();
  return clean || 'BerLoader';
}

// Öncelik: uygulamanın hesap oturumu (cookieFile) > elle seçilen cookies.txt > tarayıcı çerezi.
function cookieArgs(settings, cookieFile) {
  if (cookieFile) return ['--cookies', cookieFile];
  if (settings.cookiesFile) return ['--cookies', settings.cookiesFile];
  if (settings.cookiesBrowser && settings.cookiesBrowser !== 'none') {
    return ['--cookies-from-browser', settings.cookiesBrowser];
  }
  return [];
}

// yt-dlp ilerleme satırı şablonu. Dosya adı en sona konur (içinde '|' olabilir diye).
const PROGRESS_TEMPLATE =
  'download:BLP|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s' +
  '|%(progress.speed)s|%(progress.eta)s|%(info.requested_formats.1.format_id|none)s|%(progress.filename)s';

function ytdlpFormatArgs(job) {
  if (job.format === 'mp4') {
    // Önce en yüksek çözünürlük, sonra fps, sonra mümkünse H.264 (Adobe/CapCut dostu).
    // Seçilen kalite bir "üst sınırdır": video 2K ise 4K seçmek 2K indirir.
    // AV1 en son çare: dönüştürürken çözmesi yavaş ve her ffmpeg derlemesinde yok; VP9 tercih edilir.
    const cap = job.quality === 'best' ? 'res' : `res:${job.quality}`;
    return [
      '-f',
      'bv*[vcodec!*=av01]+ba/bv*+ba/b',
      '-S',
      `${cap},fps,vcodec:h264,acodec:aac`,
      '--merge-output-format',
      'mkv'
    ];
  }
  if (job.format === 'm4a') {
    return ['-f', 'ba[ext=m4a]/ba/b', '-x', '--audio-format', 'm4a', '--audio-quality', '0', '--embed-metadata'];
  }
  return ['-f', 'ba/b', '-x', '--audio-format', job.format, '--audio-quality', '0', '--embed-metadata'];
}

// ctx: { settings, ffmpegPath, denoPath, outDir, cookieFile }
function buildYtdlpArgs(job, ctx) {
  const { settings, ffmpegPath, denoPath, outDir, cookieFile } = ctx;
  const prefix = job.prefix ? sanitizeName(job.prefix, 12) + ' - ' : '';
  // Bölüm indirmede ad farklı olmalı; yoksa daha önce inen tam video "zaten indirilmiş" sayılır.
  const tag = job.section ? ` (${sectionTag(job.section)})` : '';
  const template = path.join(outDir, `${prefix}%(title).100s [%(id)s]${tag}.%(ext)s`);
  const args = [
    '--ignore-config',
    '--no-colors',
    '--newline',
    '--no-warnings',
    '--no-playlist',
    '--windows-filenames',
    '--no-mtime',
    '--concurrent-fragments', '4',
    '--retries', '10',
    '--fragment-retries', '10',
    '--socket-timeout', '30'
  ];
  if (ffmpegPath) args.push('--ffmpeg-location', ffmpegPath);
  if (denoPath) args.push('--js-runtimes', `deno:${denoPath}`);
  if (settings.youtubeRemoteSolver) args.push('--remote-components', 'ejs:github');
  args.push(...cookieArgs(settings, cookieFile));
  args.push(...ytdlpFormatArgs(job));
  if (job.section) {
    const s = job.section;
    args.push('--download-sections', `*${s.start || 0}-${s.end == null ? 'inf' : s.end}`);
    if (job.format === 'mp4') args.push('--force-keyframes-at-cuts'); // kesim noktası tam istenen yerde olsun
  }
  args.push('--progress', '--progress-template', PROGRESS_TEMPLATE);
  args.push('--print', 'after_move:BLFILE|%(filepath)s');
  // Windows'ta konsol çıktısı UTF-8 olmayabilir (Türkçe karakterli başlıklar bozulur); dosyaya UTF-8 yazılır.
  if (ctx.printFile) args.push('--print-to-file', 'after_move:%(filepath)s', ctx.printFile);
  args.push('-o', template, '--', job.url);
  return args;
}

// [1,2,3,5,7,8] -> "1-3,5,7-8"
function compressRanges(list) {
  const nums = [...new Set(list.map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < nums.length; ) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(j > i ? `${nums[i]}-${nums[j]}` : String(nums[i]));
    i = j + 1;
  }
  return out.join(',');
}

// "1:30", "01:02:03", "90", "1:30.5" -> saniye. Boş metin -> null. Geçersiz -> NaN.
function parseTimecode(text) {
  const s = String(text == null ? '' : text).trim().replace(',', '.');
  if (!s) return null;
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(s)) return NaN;
  const parts = s.split(':').map(Number);
  if (parts.length > 1 && parts.slice(1).some((n) => n >= 60)) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

// 90 -> "1:30", 3725 -> "1:02:05", 90.5 -> "1:30.5"
function formatTimecode(sec) {
  const total = Math.max(0, Number(sec) || 0);
  const whole = Math.floor(total);
  const frac = total - whole;
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const sPart = String(s).padStart(2, '0') + (frac > 0.0005 ? String(Number(frac.toFixed(2))).slice(1) : '');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sPart}` : `${m}:${sPart}`;
}

// Dosya adında kullanılabilir bölüm etiketi: { start: 30, end: 105 } -> "0.30-1.45"
function sectionTag(section) {
  if (!section) return '';
  const f = (n) => formatTimecode(n).replace(/:/g, '.');
  return `${f(section.start || 0)}-${section.end == null ? 'son' : f(section.end)}`;
}

// ctx: { settings, outDir, cookieFile }
function buildGalleryArgs(job, ctx) {
  const args = ['--config-ignore', '-D', ctx.outDir, '--http-timeout', '30', '-R', '4'];
  if (job.platform === 'instagram') args.push('--sleep-request', '1.0-2.0'); // Instagram hız sınırına takılmamak için
  if (job.selection && job.selection.length) args.push('--range', compressRanges(job.selection));
  args.push(...cookieArgs(ctx.settings, ctx.cookieFile));
  args.push('--', job.url);
  return args;
}

function buildGalleryListArgs(url, settings, resolve, cookieFile) {
  return ['--config-ignore', '--http-timeout', '30', resolve ? '-J' : '-j', ...cookieArgs(settings, cookieFile), '--', url];
}

function buildYtdlpInfoArgs(url, ctx, noPlaylist) {
  const { settings, denoPath, cookieFile } = ctx;
  const args = ['--ignore-config', '--no-colors', '--no-warnings', '-J', '--flat-playlist', '--socket-timeout', '30'];
  if (noPlaylist) args.push('--no-playlist');
  if (denoPath) args.push('--js-runtimes', `deno:${denoPath}`);
  if (settings.youtubeRemoteSolver) args.push('--remote-components', 'ejs:github');
  args.push(...cookieArgs(settings, cookieFile));
  args.push('--', url);
  return args;
}

// Kırpma önizlemesi için küçük (en fazla 480p), ses+görüntü içeren tek akış adresi.
function buildYtdlpPreviewArgs(url, ctx) {
  const { settings, denoPath, cookieFile } = ctx;
  const args = ['--ignore-config', '--no-colors', '--no-warnings', '--no-playlist', '--socket-timeout', '20', '-g'];
  args.push('-f', '18/best[height<=480][vcodec!=none][acodec!=none]/best[height<=480][vcodec!=none]');
  if (denoPath) args.push('--js-runtimes', `deno:${denoPath}`);
  if (settings.youtubeRemoteSolver) args.push('--remote-components', 'ejs:github');
  args.push(...cookieArgs(settings, cookieFile));
  args.push('--', url);
  return args;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// "BLP|..." satırını ayrıştırır. Başka satırlar için null döner.
function parseProgressLine(line) {
  if (!line.startsWith('BLP|')) return null;
  const parts = line.split('|');
  return {
    downloaded: num(parts[1]),
    total: num(parts[2]) || num(parts[3]),
    speed: num(parts[4]),
    eta: num(parts[5]),
    streams: parts[6] && parts[6] !== 'none' && parts[6] !== 'NA' ? 2 : 1,
    filename: parts.slice(7).join('|')
  };
}

// "[download] C:\...\video.mkv has already been downloaded" satırından dosya yolu.
function parseAlreadyDownloaded(line) {
  const m = String(line).match(/^\[download\]\s+(.+?)\s+has already been downloaded/i);
  return m ? m[1] : null;
}

function extFromUrl(url) {
  try {
    const p = new URL(url).pathname;
    const m = p.match(/\.([a-z0-9]{2,5})$/i);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

// gallery-dl -j çıktısı: [[2,{dizin meta}], [3,"url",{meta}], ...]
function parseGalleryJson(text) {
  let arr;
  try {
    arr = JSON.parse(text);
  } catch {
    return { items: [], meta: null };
  }
  if (!Array.isArray(arr)) return { items: [], meta: null };
  const items = [];
  let dirMeta = null;
  let firstMeta = null;
  for (const m of arr) {
    if (!Array.isArray(m)) continue;
    if (m[0] === 2) {
      dirMeta = m[1] || null;
    } else if (m[0] === 3) {
      const url = String(m[1] || '');
      const meta = m[2] || {};
      if (!firstMeta) firstMeta = meta;
      const ext = String(meta.extension || extFromUrl(url) || '').toLowerCase();
      const isVideo = VIDEO_EXT.has(ext) || url.startsWith('ytdl:') || meta.type === 'video';
      items.push({
        index: items.length + 1,
        type: isVideo ? 'video' : 'image',
        ext,
        url,
        thumb: meta.display_url || meta.thumbnail || (isVideo ? null : url)
      });
    }
  }
  return { items, meta: dirMeta || firstMeta };
}

function galleryTitle(meta, fallbackHost) {
  if (meta) {
    for (const k of ['title', 'description', 'caption', 'content', 'desc', 'fulltext']) {
      const v = meta[k];
      if (typeof v === 'string' && v.trim()) return v.trim().replace(/\s+/g, ' ').slice(0, 90);
    }
    const user =
      (typeof meta.username === 'string' && meta.username) ||
      (meta.user && meta.user.name) ||
      (meta.author && meta.author.name) ||
      '';
    const id = meta.post_shortcode || meta.pin_id || meta.id || meta.tweet_id || '';
    if (user || id) return [user, id].filter(Boolean).join(' · ');
  }
  return fallbackHost || 'Görseller';
}

// İndirilen galeri dosyaları için okunur adlar: "Instagram - başlık - 02.jpg".
// selection (1 tabanlı sıra numaraları) dosya sayısıyla eşleşiyorsa özgün numaralar korunur.
function galleryFileNames(files, selection, platformLabel, title) {
  const total = files.length;
  const useSel = Array.isArray(selection) && selection.length === total;
  const maxNum = useSel ? Math.max(...selection) : total;
  const pad = Math.max(2, String(maxNum).length);
  const base = `${platformLabel} - ${sanitizeName(title, 50)}`;
  return files.map((f, i) => {
    const ext = path.extname(f).toLowerCase();
    if (total === 1) return `${base}${ext}`;
    const n = useSel ? selection[i] : i + 1;
    return `${base} - ${String(n).padStart(pad, '0')}${ext}`;
  });
}

// ffmpeg -i çıktısından codec, çözünürlük ve kare hızı bilgisi.
function parseFfmpegProbe(stderr) {
  const lines = String(stderr).split(/\r?\n/);
  let video = null;
  let audio = null;
  let pixfmt = null;
  let width = null;
  let height = null;
  let fps = null;
  for (const l of lines) {
    if (!video) {
      const v = l.match(/Stream #\d+:\d+.*?: Video: ([a-z0-9_]+)(.*)/i);
      if (v && !/attached pic/i.test(l)) {
        video = v[1].toLowerCase();
        const px = v[2].match(/,\s*(yuv\w+|nv\d+|gbr\w+|rgb\w+|gray\w*)/i);
        pixfmt = px ? px[1].toLowerCase() : null;
        const wh = v[2].match(/,\s*(\d{2,5})x(\d{2,5})[\s,[]/);
        if (wh) {
          width = Number(wh[1]);
          height = Number(wh[2]);
        }
        const f = v[2].match(/(\d+(?:\.\d+)?)\s+fps/);
        if (f) fps = Number(f[1]);
      }
    }
    if (!audio) {
      const a = l.match(/Stream #\d+:\d+.*?: Audio: ([a-z0-9_]+)/i);
      if (a) audio = a[1].toLowerCase();
    }
  }
  const d = String(stderr).match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null;
  return { video, audio, pixfmt, width, height, fps, duration };
}

// Düzenleme yazılımları için güvenli çıktı: H.264 (8 bit 4:2:0) + AAC, MP4 kabı.
function planCompat(probe) {
  const videoOk = !probe.video || (probe.video === 'h264' && (!probe.pixfmt || probe.pixfmt === 'yuv420p'));
  const audioOk = !probe.audio || probe.audio === 'aac';
  return { videoOk, audioOk, needsEncode: !videoOk || !audioOk };
}

function buildFfmpegArgs(input, output, plan, probe) {
  const args = ['-hide_banner', '-y', '-i', input, '-map', '0:v:0?', '-map', '0:a:0?'];
  if (probe.video) {
    if (plan.videoOk) {
      args.push('-c:v', 'copy');
    } else {
      args.push(
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '16',
        '-profile:v', 'high',
        '-pix_fmt', 'yuv420p',
        // H.264 4:2:0 çift sayılı çözünürlük ister; zaten çiftse hiçbir şey değişmez.
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2'
      );
    }
  }
  if (probe.audio) {
    if (plan.audioOk) args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-b:a', '256k', '-ar', '48000');
  }
  args.push('-movflags', '+faststart', '-sn', '-dn', output);
  return args;
}

// Bitmiş dosya gerçekten MP4 + H.264 (yuv420p) + AAC mi?
function checkEditorReady(probe, ext) {
  const problems = [];
  if (String(ext).toLowerCase() !== '.mp4') problems.push('kap');
  if (!probe.video) problems.push('görüntü yok');
  else if (!(probe.video === 'h264' && (!probe.pixfmt || probe.pixfmt === 'yuv420p'))) problems.push('video kodeği');
  if (probe.audio && probe.audio !== 'aac') problems.push('ses kodeği');
  return { ok: problems.length === 0, problems };
}

const CODEC_NAMES = {
  h264: 'H.264', hevc: 'HEVC', vp9: 'VP9', vp8: 'VP8', av1: 'AV1', mpeg4: 'MPEG-4', prores: 'ProRes',
  aac: 'AAC', opus: 'Opus', mp3: 'MP3', vorbis: 'Vorbis', flac: 'FLAC', pcm_s16le: 'WAV'
};

// "H.264 · AAC · 2560×1440 · 30 fps"
function describeProbe(probe) {
  const parts = [];
  if (probe.video) parts.push(CODEC_NAMES[probe.video] || probe.video.toUpperCase());
  if (probe.audio) parts.push(CODEC_NAMES[probe.audio] || probe.audio.toUpperCase());
  if (probe.width && probe.height) parts.push(`${probe.width}×${probe.height}`);
  if (probe.fps) parts.push(`${Number(probe.fps.toFixed(2))} fps`);
  return parts.join(' · ');
}

// Ham hata metnini Türkçe, anlaşılır bir mesaja çevirir.
function friendlyError(raw) {
  const text = String(raw || '').trim();
  const rules = [
    [/sign in to confirm|not a bot|confirm you.re not a bot/i, 'YouTube giriş doğrulaması istiyor. Biraz bekleyip tekrar dene; sürerse Ayarlar > Gelişmiş çerez bölümünden Firefox seç.'],
    [/login required|log in|logged-in|requires login|authentication|checkpoint_required|rate-limit reached or login required|redirect to login|\b(401|403)\b.*(instagram|twitter|tiktok)/i, 'Bu içerik giriş gerektiriyor. Ayarlar > Hesaplar bölümünden ilgili platforma giriş yap.'],
    [/private video|this video is private|is private/i, 'Bu içerik gizli.'],
    [/video unavailable|has been removed|no longer available|not available in your country|geo/i, 'İçerik kullanılamıyor (silinmiş ya da bölge kısıtlı).'],
    [/http error 429|too many requests|rate.?limit/i, 'Platform çok fazla istek nedeniyle geçici olarak engelledi. Biraz bekleyip tekrar dene.'],
    [/no video could be found|no video formats|there is no video/i, 'Bu bağlantıda video bulunamadı.'],
    [/unsupported url/i, 'Bu bağlantı desteklenmiyor.'],
    [/libx264|encoder.*not found|unknown encoder/i, 'ffmpeg H.264 kodlayıcısı bulunamadı. Uygulamayı yeniden kur (ffmpeg-static).'],
    [/decoder.*not found|av1/i, 'Video kodeği çözülemedi (AV1). Kaliteyi bir kademe düşürüp tekrar dene.'],
    [/ffmpeg|ffprobe/i, 'Dönüştürme aracı (ffmpeg) çalışmadı: ' + text.slice(0, 160)],
    [/unable to download|getaddrinfo|network|timed out|connection/i, 'Ağ hatası. İnternet bağlantını kontrol edip tekrar dene.']
  ];
  for (const [re, msg] of rules) if (re.test(text)) return msg;
  return text.replace(/^ERROR:\s*/i, '').slice(0, 300) || 'Bilinmeyen hata.';
}

// Motor güncellemesiyle çözülme ihtimali olan hatalar.
function isEngineBreakage(raw) {
  return /unable to extract|nsig|signature|n challenge|player response|js runtime|http error 403|requested format is not available|no video formats found|unexpected response|failed to parse|extractor error|please report this issue/i.test(
    String(raw || '')
  );
}

module.exports = {
  parseTimecode,
  formatTimecode,
  sectionTag,
  VIDEO_EXT,
  IMAGE_CONVERT_EXT,
  sanitizeName,
  cookieArgs,
  compressRanges,
  PROGRESS_TEMPLATE,
  ytdlpFormatArgs,
  buildYtdlpArgs,
  buildGalleryArgs,
  buildGalleryListArgs,
  buildYtdlpInfoArgs,
  buildYtdlpPreviewArgs,
  parseProgressLine,
  parseAlreadyDownloaded,
  parseGalleryJson,
  galleryTitle,
  galleryFileNames,
  parseFfmpegProbe,
  planCompat,
  buildFfmpegArgs,
  checkEditorReady,
  describeProbe,
  friendlyError,
  isEngineBreakage
};
