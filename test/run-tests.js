'use strict';
// Çalıştırma: npm test   (Electron gerekmez; saf mantık sınanır)
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'berloader-test-'));
const Module = require('module');

// accounts.js ve engine.js 'electron' ister; testte yerine küçük bir taklit konur.
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'electron') {
    return { app: { getPath: () => TMP, getName: () => 'BerLoader' }, net: {}, session: {}, BrowserWindow: class {} };
  }
  return origLoad.call(this, req, ...rest);
};

const P = require('../src/platform');
const A = require('../src/args');
const { toNetscape, domainMatches, browserUserAgent } = require('../src/accounts');
const { parseEncoders } = require('../src/engine');
const { Settings } = require('../src/store');

let passed = 0;
function t(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  ', name);
  } catch (e) {
    console.error('  FAIL', name, '\n      ', e.message);
    process.exitCode = 1;
  }
}

// ---- platform ----
t('extractUrl: paylaşım metninden bağlantı çıkarır', () => {
  assert.strictEqual(P.extractUrl('Bak şuna https://youtu.be/abc123, harika'), 'https://youtu.be/abc123');
  assert.strictEqual(P.extractUrl('www.tiktok.com/@a/video/1'), 'https://www.tiktok.com/@a/video/1');
  assert.strictEqual(P.extractUrl('merhaba dünya'), null);
});

t('detect: platformlar', () => {
  const cases = {
    'https://www.youtube.com/watch?v=x': 'youtube',
    'https://youtu.be/x': 'youtube',
    'https://music.youtube.com/watch?v=x': 'youtube',
    'https://www.instagram.com/p/abc/': 'instagram',
    'https://vm.tiktok.com/abc/': 'tiktok',
    'https://x.com/a/status/1': 'x',
    'https://twitter.com/a/status/1': 'x',
    'https://t.co/abc': 'x',
    'https://tr.pinterest.com/pin/1/': 'pinterest',
    'https://pin.it/abc': 'pinterest',
    'https://example.com/v': 'other'
  };
  for (const [u, p] of Object.entries(cases)) assert.strictEqual(P.detect(u).platform, p, u);
});

t('checkPlatformMatch: platform seçimi zorunlu, uyuşmazlık engellenir', () => {
  assert.ok(/Önce/.test(P.checkPlatformMatch(null, 'youtube')));
  assert.strictEqual(P.checkPlatformMatch('instagram', 'instagram'), null);
  const m = P.checkPlatformMatch('youtube', 'instagram');
  assert.ok(m.includes('Instagram') && m.includes('YouTube'), m);
  assert.ok(/benzemiyor/.test(P.checkPlatformMatch('x', 'other')));
});

t('PLATFORM_FROM: Türkçe ekler', () => {
  assert.strictEqual(P.PLATFORM_FROM.youtube, "YouTube'dan");
  assert.strictEqual(P.PLATFORM_FROM.tiktok, "TikTok'tan");
  assert.strictEqual(P.PLATFORM_FROM.x, "X'ten");
  assert.ok(P.IMAGE_PLATFORMS.includes('pinterest') && !P.IMAGE_PLATFORMS.includes('youtube'));
});

t('youtubeKind: video+liste -> yalnızca video; saf liste -> liste', () => {
  const k = (s) => P.youtubeKind(new URL(s));
  assert.strictEqual(k('https://www.youtube.com/watch?v=AAA&list=PLx&index=3'), 'video');
  assert.strictEqual(k('https://www.youtube.com/watch?v=WePmBZppnq4&list=RDWePmBZppnq4&start_radio=1'), 'video');
  assert.strictEqual(k('https://youtu.be/AAA?list=PLx'), 'video');
  assert.strictEqual(k('https://www.youtube.com/shorts/AAA'), 'video');
  assert.strictEqual(k('https://www.youtube.com/playlist?list=PLx'), 'playlist');
  assert.strictEqual(k('https://www.youtube.com/@kanal/videos'), 'playlist');
});

t('cleanYoutubeVideoUrl: liste parametrelerini atar', () => {
  assert.strictEqual(
    P.cleanYoutubeVideoUrl(new URL('https://www.youtube.com/watch?v=AAA&list=PLx&index=3')),
    'https://www.youtube.com/watch?v=AAA'
  );
  assert.strictEqual(P.cleanYoutubeVideoUrl(new URL('https://youtu.be/AAA?list=PLx')), 'https://youtu.be/AAA');
});

t('youtubeVideoId: kapak indirme için kimlik çıkarır', () => {
  const id = (s) => P.youtubeVideoId(s);
  assert.strictEqual(id('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx'), 'dQw4w9WgXcQ');
  assert.strictEqual(id('https://youtu.be/dQw4w9WgXcQ?si=abc'), 'dQw4w9WgXcQ');
  assert.strictEqual(id('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.strictEqual(id('https://www.youtube.com/playlist?list=PLx'), null);
  assert.strictEqual(id('bozuk'), null);
});

t('Settings: varsayılan sıralı indirme; eski kurulumdaki "2" ayarı 1e çevrilir', () => {
  fs.writeFileSync(path.join(TMP, 'settings.json'), JSON.stringify({ concurrent: 2, format: 'mp3' }));
  const s = new Settings();
  assert.strictEqual(s.data.concurrent, 1);
  assert.strictEqual(s.data.format, 'mp3'); // diğer ayarlar korunur
  assert.strictEqual(s.data.autoClearDone, true);
  s.patch({ concurrent: 3 }); // kullanıcı bilerek değiştirirse saygı duyulur
  assert.strictEqual(s.data.concurrent, 3);
  s.patch({ settingsVersion: 1 });
  assert.strictEqual(s.data.settingsVersion, 2); // sürüm alanı dışarıdan değiştirilemez
  fs.rmSync(path.join(TMP, 'settings.json'), { force: true });
});

// ---- args ----
const base = {
  settings: { cookiesBrowser: 'none', cookiesFile: '', youtubeRemoteSolver: true },
  ffmpegPath: 'C:\\ff\\ffmpeg.exe',
  denoPath: 'C:\\e\\deno.exe',
  outDir: 'C:\\out'
};

t('buildYtdlpArgs: en yüksek kalite, AV1 son çare', () => {
  const a = A.buildYtdlpArgs({ url: 'https://youtu.be/x', format: 'mp4', quality: 'best' }, base);
  assert.ok(a.includes('--no-playlist'));
  assert.strictEqual(a[a.indexOf('-S') + 1], 'res,fps,vcodec:h264,acodec:aac');
  assert.strictEqual(a[a.indexOf('-f') + 1], 'bv*[vcodec!*=av01]+ba/bv*+ba/b');
  assert.strictEqual(a[a.indexOf('--merge-output-format') + 1], 'mkv');
  assert.strictEqual(a[a.length - 1], 'https://youtu.be/x');
  assert.strictEqual(a[a.length - 2], '--');
  assert.strictEqual(a[a.indexOf('--js-runtimes') + 1], 'deno:C:\\e\\deno.exe');
});

t('buildYtdlpArgs: kalite üst sınır olarak uygulanır', () => {
  const a = A.buildYtdlpArgs({ url: 'u', format: 'mp4', quality: '1440' }, base);
  assert.strictEqual(a[a.indexOf('-S') + 1], 'res:1440,fps,vcodec:h264,acodec:aac');
});

t('buildYtdlpArgs: ses biçimleri', () => {
  for (const f of ['mp3', 'm4a', 'wav']) {
    const a = A.buildYtdlpArgs({ url: 'u', format: f, quality: 'best' }, base);
    assert.ok(a.includes('-x'));
    assert.strictEqual(a[a.indexOf('--audio-format') + 1], f);
  }
  const m4a = A.buildYtdlpArgs({ url: 'u', format: 'm4a', quality: 'best' }, base);
  assert.strictEqual(m4a[m4a.indexOf('-f') + 1], 'ba[ext=m4a]/ba/b');
});

t('cookieArgs: öncelik hesap oturumu > cookies.txt > tarayıcı', () => {
  assert.deepStrictEqual(A.cookieArgs({ cookiesBrowser: 'edge', cookiesFile: 'C:\\c.txt' }, 'C:\\acc.txt'), ['--cookies', 'C:\\acc.txt']);
  assert.deepStrictEqual(A.cookieArgs({ cookiesBrowser: 'edge', cookiesFile: 'C:\\c.txt' }), ['--cookies', 'C:\\c.txt']);
  assert.deepStrictEqual(A.cookieArgs({ cookiesBrowser: 'firefox', cookiesFile: '' }), ['--cookies-from-browser', 'firefox']);
  assert.deepStrictEqual(A.cookieArgs({ cookiesBrowser: 'none', cookiesFile: '' }), []);
});

t('buildYtdlpArgs: liste öneki ve hesap çerezi', () => {
  const a = A.buildYtdlpArgs({ url: 'u', format: 'mp4', quality: 'best', prefix: '07' }, { ...base, cookieFile: 'C:\\t\\cookies-1.txt' });
  assert.strictEqual(a[a.indexOf('--cookies') + 1], 'C:\\t\\cookies-1.txt');
  const out = a[a.indexOf('-o') + 1];
  assert.ok(out.includes('07 - %(title).100s [%(id)s].%(ext)s'), out);
});

t('parseProgressLine / parseAlreadyDownloaded', () => {
  const p = A.parseProgressLine('BLP|1048576|2097152|NA|524288.5|2|none|C:\\out\\a|b.f137.mp4');
  assert.strictEqual(p.downloaded, 1048576);
  assert.strictEqual(p.total, 2097152);
  assert.strictEqual(p.speed, 524288.5);
  assert.strictEqual(p.streams, 1);
  assert.strictEqual(p.filename, 'C:\\out\\a|b.f137.mp4');
  const q = A.parseProgressLine('BLP|10|NA|2000|NA|NA|251|x.mp4');
  assert.strictEqual(q.total, 2000);
  assert.strictEqual(q.streams, 2);
  assert.strictEqual(A.parseProgressLine('[download] foo'), null);
  assert.strictEqual(A.parseAlreadyDownloaded('[download] C:\\o\\Video [abc].mkv has already been downloaded'), 'C:\\o\\Video [abc].mkv');
  assert.strictEqual(A.parseAlreadyDownloaded('[download] 10%'), null);
});

t('compressRanges / buildGalleryArgs', () => {
  assert.strictEqual(A.compressRanges([1, 2, 3, 5, 7, 8]), '1-3,5,7-8');
  assert.strictEqual(A.compressRanges([4]), '4');
  const g = A.buildGalleryArgs({ url: 'u', platform: 'tiktok', selection: [1, 3] }, { settings: base.settings, outDir: 'C:\\o' });
  assert.deepStrictEqual(g.slice(0, 7), ['--config-ignore', '-D', 'C:\\o', '--http-timeout', '30', '-R', '4']);
  assert.strictEqual(g[g.indexOf('--range') + 1], '1,3');
  assert.ok(!g.includes('--sleep-request'));
  const ig = A.buildGalleryArgs({ url: 'u', platform: 'instagram', selection: [2] }, { settings: base.settings, outDir: 'C:\\o', cookieFile: 'C:\\c.txt' });
  assert.ok(ig.includes('--sleep-request'));
  assert.strictEqual(ig[ig.indexOf('--cookies') + 1], 'C:\\c.txt');
  assert.deepStrictEqual(ig.slice(-2), ['--', 'u']);
});

t('parseGalleryJson: Instagram benzeri çıktı', () => {
  const json = JSON.stringify([
    [2, { username: 'abc', post_shortcode: 'XYZ', description: 'Güzel bir gün' }],
    [3, 'https://cdn.example/a.jpg?x=1', { extension: 'jpg', num: 1 }],
    [3, 'https://cdn.example/b.mp4', { extension: 'mp4', num: 2, display_url: 'https://cdn.example/b.jpg' }]
  ]);
  const r = A.parseGalleryJson(json);
  assert.strictEqual(r.items.length, 2);
  assert.strictEqual(r.items[0].type, 'image');
  assert.strictEqual(r.items[1].type, 'video');
  assert.strictEqual(r.items[1].thumb, 'https://cdn.example/b.jpg');
  assert.strictEqual(A.galleryTitle(r.meta, 'Instagram'), 'Güzel bir gün');
  assert.deepStrictEqual(A.parseGalleryJson('bozuk').items, []);
});

t('galleryFileNames: okunur adlar, özgün numaralar korunur', () => {
  assert.deepStrictEqual(A.galleryFileNames(['C:\\o\\123.jpg'], [3], 'Instagram', 'Güzel: bir/gün'), ['Instagram - Güzel_ bir_gün.jpg']);
  const n = A.galleryFileNames(['a.jpg', 'b.PNG', 'c.mp4'], [2, 4, 9], 'X', 'Tweet');
  assert.deepStrictEqual(n, ['X - Tweet - 02.jpg', 'X - Tweet - 04.png', 'X - Tweet - 09.mp4']);
  // seçim sayısı dosya sayısıyla uyuşmuyorsa sırayla numaralanır
  assert.deepStrictEqual(A.galleryFileNames(['a.jpg', 'b.jpg'], [1, 2, 3], 'Pinterest', 'Pin'), ['Pinterest - Pin - 01.jpg', 'Pinterest - Pin - 02.jpg']);
});

t('parseFfmpegProbe + planCompat + buildFfmpegArgs', () => {
  const vp9 = `Input #0, matroska,webm, from 'a.mkv':
  Duration: 00:03:21.45, start: 0.000000, bitrate: 8000 kb/s
  Stream #0:0: Video: vp9 (Profile 0), yuv420p(tv), 2560x1440, 30 fps, 30 tbr, 1k tbn
  Stream #0:1: Audio: opus, 48000 Hz, stereo, fltp`;
  const p = A.parseFfmpegProbe(vp9);
  assert.strictEqual(p.video, 'vp9');
  assert.strictEqual(p.audio, 'opus');
  assert.strictEqual(p.width, 2560);
  assert.strictEqual(p.height, 1440);
  assert.strictEqual(p.fps, 30);
  assert.strictEqual(Math.round(p.duration), 201);
  const plan = A.planCompat(p);
  assert.ok(plan.needsEncode && !plan.videoOk && !plan.audioOk);
  const args = A.buildFfmpegArgs('a.mkv', 'a.mp4', plan, p);
  const joined = args.join(' ');
  assert.ok(joined.includes('-c:v libx264') && joined.includes('-pix_fmt yuv420p') && joined.includes('-profile:v high'));
  assert.ok(joined.includes('scale=trunc(iw/2)*2:trunc(ih/2)*2'));
  assert.ok(joined.includes('-c:a aac') && joined.includes('-movflags +faststart'));

  const ok = A.parseFfmpegProbe(`  Stream #0:0: Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 29.97 fps
  Stream #0:1: Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo
  Stream #0:2: Video: mjpeg, yuvj420p, 500x500 (attached pic)`);
  assert.strictEqual(ok.video, 'h264');
  assert.strictEqual(ok.width, 1920);
  assert.strictEqual(ok.fps, 29.97);
  const planOk = A.planCompat(ok);
  assert.ok(!planOk.needsEncode);
  const copyArgs = A.buildFfmpegArgs('a.mkv', 'a.mp4', planOk, ok).join(' ');
  assert.ok(copyArgs.includes('-c:v copy') && !copyArgs.includes('-vf'));

  const hi10 = A.parseFfmpegProbe('  Stream #0:0: Video: h264 (High 10), yuv420p10le(tv), 1920x1080\n  Stream #0:1: Audio: aac, 44100 Hz');
  assert.ok(A.planCompat(hi10).needsEncode);
});

t('checkEditorReady + describeProbe: doğrulama', () => {
  const good = { video: 'h264', audio: 'aac', pixfmt: 'yuv420p', width: 2560, height: 1440, fps: 30 };
  assert.deepStrictEqual(A.checkEditorReady(good, '.mp4'), { ok: true, problems: [] });
  assert.ok(!A.checkEditorReady(good, '.mkv').ok);
  assert.ok(!A.checkEditorReady({ ...good, video: 'vp9' }, '.mp4').ok);
  assert.ok(!A.checkEditorReady({ ...good, audio: 'opus' }, '.mp4').ok);
  assert.ok(!A.checkEditorReady({ ...good, pixfmt: 'yuv420p10le' }, '.mp4').ok);
  assert.ok(A.checkEditorReady({ ...good, audio: null }, '.mp4').ok); // sessiz video de olur
  assert.ok(!A.checkEditorReady({ audio: 'aac' }, '.mp4').ok); // görüntü yoksa uyumlu sayılmaz
  assert.strictEqual(A.describeProbe(good), 'H.264 · AAC · 2560×1440 · 30 fps');
  assert.strictEqual(A.describeProbe({ ...good, fps: 59.94 }), 'H.264 · AAC · 2560×1440 · 59.94 fps');
});

t('friendlyError + isEngineBreakage', () => {
  assert.ok(/çerez/i.test(A.friendlyError("ERROR: Sign in to confirm you're not a bot")));
  assert.ok(/Hesaplar/.test(A.friendlyError('ERROR: [Instagram] login required')));
  assert.ok(/gizli/i.test(A.friendlyError('ERROR: Private video')));
  assert.ok(/libx264|H\.264 kodlayıcısı/.test(A.friendlyError('Unknown encoder libx264')));
  assert.ok(A.isEngineBreakage('ERROR: Unable to extract player response'));
  assert.ok(A.isEngineBreakage('HTTP Error 403: Forbidden'));
  assert.ok(!A.isEngineBreakage('ERROR: Private video'));
});

t('parseTimecode / formatTimecode / sectionTag', () => {
  assert.strictEqual(A.parseTimecode('1:30'), 90);
  assert.strictEqual(A.parseTimecode('01:02:03'), 3723);
  assert.strictEqual(A.parseTimecode('90'), 90);
  assert.strictEqual(A.parseTimecode('1:30,5'), 90.5);
  assert.strictEqual(A.parseTimecode('  '), null);
  assert.ok(Number.isNaN(A.parseTimecode('1:75')));
  assert.ok(Number.isNaN(A.parseTimecode('abc')));
  assert.ok(Number.isNaN(A.parseTimecode('-5')));
  assert.strictEqual(A.formatTimecode(90), '1:30');
  assert.strictEqual(A.formatTimecode(3725), '1:02:05');
  assert.strictEqual(A.formatTimecode(90.5), '1:30.5');
  assert.strictEqual(A.sectionTag({ start: 30, end: 105 }), '0.30-1.45');
  assert.strictEqual(A.sectionTag({ start: 0, end: null }), '0.00-son');
  assert.ok(!/[:<>"/\\|?*]/.test(A.sectionTag({ start: 3725, end: null })));
});

t('buildYtdlpArgs: bölüm indirme', () => {
  const v = A.buildYtdlpArgs({ url: 'u', format: 'mp4', quality: 'best', section: { start: 30, end: 105 } }, base);
  assert.strictEqual(v[v.indexOf('--download-sections') + 1], '*30-105');
  assert.ok(v.includes('--force-keyframes-at-cuts'));
  assert.ok(v[v.indexOf('-o') + 1].includes('[%(id)s] (0.30-1.45).%(ext)s'));
  const open = A.buildYtdlpArgs({ url: 'u', format: 'mp3', quality: 'best', section: { start: 60, end: null } }, base);
  assert.strictEqual(open[open.indexOf('--download-sections') + 1], '*60-inf');
  assert.ok(!open.includes('--force-keyframes-at-cuts')); // ses için gerekmez
  const none = A.buildYtdlpArgs({ url: 'u', format: 'mp4', quality: 'best' }, base);
  assert.ok(!none.includes('--download-sections'));
  assert.ok(none[none.indexOf('-o') + 1].endsWith('[%(id)s].%(ext)s'));
});

t('buildYtdlpPreviewArgs: küçük, ses+görüntülü tek akış', () => {
  const a = A.buildYtdlpPreviewArgs('https://www.youtube.com/watch?v=abcdefghijk', base);
  assert.ok(a.includes('-g') && a.includes('--no-playlist'));
  assert.ok(a[a.indexOf('-f') + 1].startsWith('18/'));
  assert.ok(a[a.indexOf('-f') + 1].includes('height<=480'));
  assert.strictEqual(a[a.length - 1], 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.strictEqual(a[a.length - 2], '--');
});

t('sanitizeName', () => {
  assert.strictEqual(A.sanitizeName('a<b>:"c/d\\e|f?g*h%'), 'a_b___c_d_e_f_g_h_');
  assert.strictEqual(A.sanitizeName('  ... '), 'BerLoader');
  assert.ok(path.basename(A.sanitizeName('x'.repeat(200), 80)).length <= 80);
});

// ---- accounts (çerez dosyası) ----
t('toNetscape: yt-dlp ve gallery-dl için cookies.txt', () => {
  const txt = toNetscape(
    [
      { name: 'sessionid', value: 'abc', domain: '.instagram.com', path: '/', secure: true, httpOnly: true, expirationDate: 1900000000.5 },
      { name: 'csrftoken', value: 'x\ty\n', domain: 'www.instagram.com', path: '/', secure: false, httpOnly: false },
      { name: '', value: 'boş', domain: '.x.com' }
    ],
    1000
  );
  const lines = txt.trim().split('\n');
  assert.strictEqual(lines[0], '# Netscape HTTP Cookie File');
  assert.strictEqual(lines[3], '#HttpOnly_.instagram.com\tTRUE\t/\tTRUE\t1900000000\tsessionid\tabc');
  assert.strictEqual(lines[4], 'www.instagram.com\tFALSE\t/\tFALSE\t' + (1000 + 30 * 86400) + '\tcsrftoken\txy');
  assert.strictEqual(lines.length, 5); // adı olmayan çerez atlandı
});

t('domainMatches / browserUserAgent', () => {
  assert.ok(domainMatches('.instagram.com', ['instagram.com']));
  assert.ok(domainMatches('www.x.com', ['x.com', 'twitter.com']));
  assert.ok(!domainMatches('notinstagram.com', ['instagram.com']));
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) berloader/1.1.0 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36';
  const clean = browserUserAgent(ua);
  assert.ok(!/Electron|berloader/i.test(clean) && clean.includes('Chrome/130'), clean);
});

t('parseEncoders: ffmpeg kodlayıcı denetimi', () => {
  const ok = parseEncoders(' V....D libx264              libx264 H.264 / AVC\n A....D aac                 AAC (Advanced Audio Coding)');
  assert.deepStrictEqual(ok, { x264: true, aac: true, ok: true });
  assert.strictEqual(parseEncoders(' A....D aac  AAC').ok, false);
  assert.strictEqual(parseEncoders('').ok, false);
});

console.log(`\n${passed} test geçti.`);
