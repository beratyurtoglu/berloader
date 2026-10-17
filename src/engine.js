'use strict';
// İndirme motorları: yt-dlp, gallery-dl ve deno (YouTube için JS çalıştırıcı).
// Hepsi uygulama içine gömülmez; kullanıcı klasörüne indirilir ve açılışta
// son sürümle karşılaştırılıp otomatik güncellenir.
// Böylece bir site değiştiğinde yeni sürümle uygulama kendini onarır.
//
// Kaynaklar:
//  - yt-dlp:     GitHub (yt-dlp/yt-dlp veya nightly deposu)
//  - gallery-dl: Codeberg (resmi dağıtım). Yedek: GitHub gdl-org/builds (nightly)
//  - deno:       GitHub (denoland/deno)
// ffmpeg ise uygulamayla birlikte gelir (ffmpeg-static); açılışta çalıştığı ve H.264/AAC
// kodlayabildiği denetlenir.

const { app, net } = require('electron');
const { EventEmitter } = require('events');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const UA = 'BerLoader';
const META_TIMEOUT = 25000; // sürüm sorguları için
const IDLE_TIMEOUT = 30000; // indirmede veri akışı bu kadar durursa iptal

const LABELS = { ytdlp: 'yt-dlp', gallerydl: 'gallery-dl', deno: 'deno' };
const FILES = { ytdlp: 'yt-dlp.exe', gallerydl: 'gallery-dl.exe', deno: 'deno.exe' };
// Kurulum sırası: önce video için gerekenler.
const ORDER = ['ytdlp', 'deno', 'gallerydl'];
// Bu motor olmadan uygulama hiçbir şey indiremez. gallery-dl yalnızca görsel işleri için gerekir.
const CRITICAL = ['ytdlp'];

// ffmpeg -encoders çıktısından H.264 ve AAC kodlayıcılarının varlığı.
function parseEncoders(text) {
  const s = String(text || '');
  const x264 = /\sVF[\w.]*\s+libx264\s/.test(s) || /\blibx264\b/.test(s);
  const aac = /\sA[\w.]*\s+aac\s/.test(s) || /\baac\b/.test(s);
  return { x264, aac, ok: x264 && aac };
}

class Engine extends EventEmitter {
  constructor(settings, logger) {
    super();
    this.settings = settings;
    this.log = logger || { info() {}, warn() {}, error() {} };
    this.dir = path.join(app.getPath('userData'), 'engine');
    this.metaFile = path.join(this.dir, 'engine.json');
    this.meta = {};
    this.state = { phase: 'idle', message: '' };
    this.ffmpegInfo = null;
    this._running = null;
    this._ready = null;
    this._initDone = false;
  }

  bin(name) {
    return path.join(this.dir, FILES[name]);
  }

  ffmpegPath() {
    try {
      const p = require('ffmpeg-static');
      return p ? p.replace('app.asar', 'app.asar.unpacked') : null;
    } catch {
      return null;
    }
  }

  ffmpegExists() {
    const p = this.ffmpegPath();
    return !!p && fs.existsSync(p);
  }

  has(name) {
    return fs.existsSync(this.bin(name));
  }

  _emit(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('status', this.status());
  }

  status() {
    const v = (n) => (this.meta[n] && this.has(n) ? this.meta[n].tag : null);
    return {
      phase: this.state.phase,
      message: this.state.message,
      percent: this.state.percent || 0,
      ytdlp: v('ytdlp'),
      ytdlpChannel: this.meta.ytdlp ? this.meta.ytdlp.channel : null,
      gallerydl: v('gallerydl'),
      deno: v('deno'),
      ffmpeg: this.ffmpegExists() ? (this.ffmpegInfo ? (this.ffmpegInfo.ok ? 'ready' : 'broken') : 'checking') : 'missing',
      lastCheck: this.meta.lastCheck || null
    };
  }

  _loadMeta() {
    try {
      this.meta = JSON.parse(fs.readFileSync(this.metaFile, 'utf8'));
    } catch {
      this.meta = {};
    }
  }

  _saveMeta() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.metaFile, JSON.stringify(this.meta, null, 2), 'utf8');
  }

  // Önceki güncellemede kullanımda olduğu için yerine konamayan ".new" dosyalarını uygula.
  _applyPending() {
    for (const key of Object.keys(FILES)) {
      const target = this.bin(key);
      const pending = target + '.new';
      if (fs.existsSync(pending)) {
        try {
          fs.renameSync(pending, target);
        } catch {
          /* hâlâ kullanımda; bir sonraki açılışta tekrar denenir */
        }
      }
    }
    // Yarım kalmış indirme artıkları
    try {
      for (const f of fs.readdirSync(this.dir)) {
        if (/\.(download|extract)(\.exe)?$/i.test(f)) fs.rmSync(path.join(this.dir, f), { force: true });
      }
    } catch {
      /* yoksay */
    }
  }

  // ffmpeg çalışıyor mu, H.264 ve AAC kodlayabiliyor mu?
  checkFfmpeg() {
    return new Promise((resolve) => {
      const p = this.ffmpegPath();
      if (!p || !fs.existsSync(p)) {
        this.ffmpegInfo = { ok: false, x264: false, aac: false, reason: 'bulunamadı' };
        this.emit('status', this.status());
        return resolve(this.ffmpegInfo);
      }
      execFile(p, ['-hide_banner', '-encoders'], { windowsHide: true, timeout: 25000, maxBuffer: 8 * 1024 * 1024 }, (err, so, se) => {
        if (err) this.ffmpegInfo = { ok: false, x264: false, aac: false, reason: err.message };
        else this.ffmpegInfo = parseEncoders(String(so) + String(se));
        this.log.info('ffmpeg denetimi:', this.ffmpegInfo);
        this.emit('status', this.status());
        resolve(this.ffmpegInfo);
      });
    });
  }

  // Uygulama açılışında çağrılır: eksik motorları kurar. Çevrimdışıysa sessizce geçer.
  init() {
    if (!this._ready) {
      this._ready = (async () => {
        fs.mkdirSync(this.dir, { recursive: true });
        this._loadMeta();
        this._applyPending();
        this.checkFfmpeg();
        const missing = ORDER.filter((k) => !this.has(k));
        if (missing.length) await this.update({ only: missing, reason: 'ilk kurulum' });
        else this._emit({ phase: 'idle', message: '' });
      })()
        .catch((e) => {
          this.log.error('Motor başlatma hatası:', e);
          this._emit({ phase: 'error', message: e.message });
        })
        .finally(() => {
          this._initDone = true;
          this.emit('idle');
        });
    }
    return this._ready;
  }

  // Yalnızca istenen motorlar hazır olana dek bekler (hepsini değil). Süre dolarsa mevcut durumu döndürür.
  ensure(keys, timeoutMs = 180000) {
    this.init();
    return new Promise((resolve) => {
      let timer = null;
      const have = () => keys.every((k) => this.has(k));
      const done = (v) => {
        clearTimeout(timer);
        this.off('installed', check);
        this.off('idle', check);
        resolve(v);
      };
      const check = () => {
        if (have()) done(true);
        else if (this._initDone && !this._running) done(false);
      };
      timer = setTimeout(() => done(have()), timeoutMs);
      this.on('installed', check);
      this.on('idle', check);
      check();
    });
  }

  whenReady() {
    return this.init();
  }

  // ---------- Ağ yardımcıları ----------
  // Tüm isteği (gövde dahil) tek bir zaman aşımıyla sarar; takılırsa hata verir, sonsuza dek beklemez.
  async _withTimeout(ms, fn) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    try {
      return await fn(ac.signal);
    } catch (e) {
      if (e && (e.name === 'AbortError' || /aborted/i.test(e.message))) throw new Error('zaman aşımı');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  _json(url) {
    return this._withTimeout(META_TIMEOUT, async (signal) => {
      const res = await net.fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} (${new URL(url).host})`);
      return res.json();
    });
  }

  // GitHub: https://github.com/<repo>/releases/latest -> .../tag/<etiket> (API sınırına takılmaz)
  async _githubLatestTag(repo) {
    try {
      const url = await this._withTimeout(META_TIMEOUT, async (signal) => {
        const res = await net.fetch(`https://github.com/${repo}/releases/latest`, {
          method: 'HEAD',
          headers: { 'User-Agent': UA },
          signal
        });
        return res.url;
      });
      const m = url && url.match(/\/releases\/tag\/([^/?#]+)/);
      if (m) return decodeURIComponent(m[1]);
    } catch {
      /* API yedeğine geç */
    }
    const json = await this._json(`https://api.github.com/repos/${repo}/releases/latest`);
    if (!json.tag_name) throw new Error(`Sürüm bilgisi bulunamadı (${repo})`);
    return json.tag_name;
  }

  // Her motor için { tag, url, sumsUrl?, zip? } döndürür.
  async _resolve(key, channel) {
    if (key === 'ytdlp') {
      const repo = channel === 'nightly' ? 'yt-dlp/yt-dlp-nightly-builds' : 'yt-dlp/yt-dlp';
      const tag = await this._githubLatestTag(repo);
      const base = `https://github.com/${repo}/releases/download/${tag}`;
      return { tag, url: `${base}/yt-dlp.exe`, sumsUrl: `${base}/SHA2-256SUMS` };
    }
    if (key === 'deno') {
      const tag = await this._githubLatestTag('denoland/deno');
      return { tag, url: `https://github.com/denoland/deno/releases/download/${tag}/deno-x86_64-pc-windows-msvc.zip`, zip: true };
    }
    return this._resolveGallerydl();
  }

  // gallery-dl'in Windows .exe dosyası GitHub sürümlerinde yok; resmi dağıtım Codeberg'de.
  async _resolveGallerydl() {
    const errors = [];

    // 1) Codeberg (kararlı sürüm)
    try {
      let rel;
      try {
        rel = await this._json('https://codeberg.org/api/v1/repos/mikf/gallery-dl/releases/latest');
      } catch (e) {
        const list = await this._json('https://codeberg.org/api/v1/repos/mikf/gallery-dl/releases?limit=5');
        rel = (Array.isArray(list) ? list : []).find((r) => !r.draft && !r.prerelease);
        if (!rel) throw e;
      }
      const asset = (rel.assets || []).find((a) => /^gallery-dl\.exe$/i.test(a.name));
      const tag = rel.tag_name;
      if (!tag) throw new Error('etiket yok');
      return {
        tag,
        url: asset ? asset.browser_download_url : `https://codeberg.org/mikf/gallery-dl/releases/download/${tag}/gallery-dl.exe`
      };
    } catch (e) {
      errors.push('Codeberg: ' + e.message);
    }

    // 2) Yedek: GitHub gdl-org/builds (en son commit'ten derlenmiş sürümler)
    try {
      const rel = await this._json('https://api.github.com/repos/gdl-org/builds/releases/latest');
      const exes = (rel.assets || []).filter((a) => /\.exe$/i.test(a.name));
      const asset = exes.find((a) => !/x86|win7|arm/i.test(a.name)) || exes[0];
      if (!asset) throw new Error('.exe dosyası bulunamadı');
      return { tag: `nightly-${rel.tag_name}`, url: asset.browser_download_url };
    } catch (e) {
      errors.push('GitHub builds: ' + e.message);
    }

    throw new Error('Kaynak bulunamadı (' + errors.join('; ') + ')');
  }

  async _download(url, dest, label) {
    const ac = new AbortController();
    let idle = setTimeout(() => ac.abort(), IDLE_TIMEOUT);
    const bump = () => {
      clearTimeout(idle);
      idle = setTimeout(() => ac.abort(), IDLE_TIMEOUT);
    };
    try {
      const res = await net.fetch(url, { headers: { 'User-Agent': UA }, signal: ac.signal });
      if (!res.ok || !res.body) throw new Error(`${label} indirilemedi (HTTP ${res.status}: ${new URL(url).host})`);
      const total = Number(res.headers.get('content-length')) || 0;
      let got = 0;
      let lastEmit = 0;
      const meter = new Transform({
        transform: (chunk, _enc, cb) => {
          bump();
          got += chunk.length;
          const now = Date.now();
          if (total && now - lastEmit > 250) {
            lastEmit = now;
            this._emit({ percent: Math.round((got / total) * 100) });
          }
          cb(null, chunk);
        }
      });
      await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(dest));
    } catch (e) {
      fs.rmSync(dest, { force: true });
      if (e && (e.name === 'AbortError' || /aborted/i.test(e.message))) throw new Error(`${label} indirilirken bağlantı koptu (zaman aşımı)`);
      throw e;
    } finally {
      clearTimeout(idle);
    }
  }

  async _verifyYtdlp(sumsUrl, file) {
    try {
      const text = await this._withTimeout(META_TIMEOUT, async (signal) => {
        const res = await net.fetch(sumsUrl, { headers: { 'User-Agent': UA }, signal });
        return res.ok ? res.text() : null;
      });
      if (!text) return; // özet dosyası yoksa doğrulamayı atla
      const line = text.split(/\r?\n/).find((l) => /\s\*?yt-dlp\.exe\s*$/.test(l));
      if (!line) return;
      const expected = line.trim().split(/\s+/)[0].toLowerCase();
      const hash = crypto.createHash('sha256');
      await pipeline(fs.createReadStream(file), hash);
      if (hash.digest('hex') !== expected) throw new Error('yt-dlp doğrulaması başarısız (özet uyuşmuyor)');
    } catch (e) {
      if (/doğrulaması/.test(e.message)) throw e;
    }
  }

  _runOk(bin, args) {
    return new Promise((resolve, reject) => {
      execFile(bin, args, { windowsHide: true, timeout: 30000 }, (err, stdout) => {
        if (err) reject(new Error(`${path.basename(bin)} çalıştırılamadı: ${err.message}`));
        else resolve(String(stdout).trim());
      });
    });
  }

  async _install(key, info, channel) {
    const label = LABELS[key];
    const target = this.bin(key);
    const tmp = path.join(this.dir, FILES[key] + '.download');
    this._emit({ phase: 'downloading', message: `${label} ${info.tag} indiriliyor`, percent: 0 });
    await this._download(info.url, tmp, label);

    let fresh = tmp;
    if (info.zip) {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(tmp);
      const entry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith('deno.exe'));
      if (!entry) throw new Error('deno.exe arşivde bulunamadı');
      fresh = target + '.extract';
      fs.writeFileSync(fresh, entry.getData());
      fs.rmSync(tmp, { force: true });
    }

    if (key === 'ytdlp' && info.sumsUrl) await this._verifyYtdlp(info.sumsUrl, fresh);

    // Çalıştırılabildiğini doğrula (bozuk indirmeyi yerine koyma)
    const probe = fresh + '.exe';
    fs.renameSync(fresh, probe);
    try {
      await this._runOk(probe, ['--version']);
    } catch (e) {
      fs.rmSync(probe, { force: true });
      throw e;
    }

    // Yerine koy; dosya kullanımdaysa ".new" olarak bırak, sonraki açılışta uygulanır.
    try {
      fs.renameSync(probe, target);
    } catch {
      fs.renameSync(probe, target + '.new');
    }
    this.meta[key] = { tag: info.tag, channel: channel || null };
    this._saveMeta();
    this.log.info(`${label} kuruldu:`, info.tag);
    this.emit('installed', key);
  }

  // Tüm motorları (ya da `only` listesindekileri) son sürüme getirir.
  // Aynı anda tek güncelleme çalışır; ikinci çağrı birinciyi bekler.
  // Bir motorun hata vermesi diğerlerini engellemez.
  update({ only, force = false, reason = '' } = {}) {
    if (this._running) return this._running;
    this._running = (async () => {
      const keys = ORDER.filter((k) => !only || only.includes(k));
      const channel = this.settings.data.engineChannel === 'nightly' ? 'nightly' : 'stable';
      const errors = [];
      this._emit({ phase: 'checking', message: reason ? `Motorlar denetleniyor (${reason})` : 'Motorlar denetleniyor', percent: 0 });
      for (const key of keys) {
        try {
          const ch = key === 'ytdlp' ? channel : null;
          const info = await this._resolve(key, ch);
          const cur = this.meta[key];
          const same = cur && cur.tag === info.tag && (key !== 'ytdlp' || cur.channel === ch) && this.has(key);
          if (!same || force) await this._install(key, info, ch);
        } catch (e) {
          this.log.warn(`${LABELS[key]} güncellenemedi:`, e.message);
          errors.push(`${LABELS[key]}: ${e.message}`);
        }
      }
      this.meta.lastCheck = Date.now();
      this._saveMeta();
      const criticalMissing = CRITICAL.filter((k) => !this.has(k));
      if (errors.length && criticalMissing.length) {
        this._emit({ phase: 'error', message: errors.join(' | '), percent: 0 });
      } else {
        // Kritik olmayan hata (ör. gallery-dl) uygulamayı engellemez; yalnızca bilgi olarak gösterilir.
        this._emit({ phase: 'idle', message: errors.length ? 'Güncellenemeyen: ' + errors.join(' | ') : '', percent: 0 });
      }
    })()
      .catch((e) => {
        this.log.error('Motor güncelleme hatası:', e);
        this._emit({ phase: 'error', message: e.message });
      })
      .finally(() => {
        this._running = null;
        this.emit('idle');
      });
    return this._running;
  }
}

module.exports = { Engine, parseEncoders, ORDER };
