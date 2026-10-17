'use strict';
// İndirme kuyruğu: çözümleme (analyze), sıraya alma, çalıştırma, dönüştürme, doğrulama.

const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const P = require('./platform');
const A = require('./args');

const TERMINAL = new Set(['done', 'error', 'canceled']);
const RUNNING = ['downloading', 'converting', 'analyzing'];
const MIN_FREE_BYTES = 500 * 1024 * 1024;
const NOLOG = { info() {}, warn() {}, error() {} };

// Bildirilen yol bozuk/eksikse dosyayı klasörde bulur. Önce addaki "[video-id]" ile eşleştirir
// (konsol kodlaması bozulsa da id ASCII'dir), olmazsa since'den sonra değişen en yeni medyayı alır.
function findNewestOutput(dir, since, reported) {
  const media = new Set(['.mp3', '.m4a', '.wav', '.opus', '.aac', '.ogg', '.mp4', '.mkv', '.webm', '.mov', '.m4v']);
  const idm = reported ? String(reported).match(/\[([^\[\]]+)\]\.[A-Za-z0-9]+$/) : null;
  const id = idm ? `[${idm[1]}]` : null;
  let byId = null, byIdT = 0, byTime = null, byTimeT = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const ext = path.extname(name).toLowerCase();
      if (!media.has(ext) || /\.f\d+\./.test(name)) continue;
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (!st.isFile() || st.size === 0) continue;
      const t = Math.max(st.mtimeMs, st.ctimeMs, st.birthtimeMs || 0);
      if (id && name.includes(id) && t > byIdT) { byIdT = t; byId = full; }
      if (t >= since && t > byTimeT) { byTimeT = t; byTime = full; }
    }
  } catch (_) { /* yok say */ }
  return byId || byTime;
}

function listDirTail(dir) {
  try {
    return fs.readdirSync(dir).map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t).slice(0, 5).map((x) => `${x.n} @${new Date(x.t).toISOString()}`);
  } catch (e) { return String(e.message); }
}

function utf8Env() {
  return { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
}

// Satır satır okuma (hem \n hem \r ayırıcı).
function lineSplitter(onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8');
    const parts = buf.split(/\r\n|\n|\r/);
    buf = parts.pop();
    for (const p of parts) if (p) onLine(p);
  };
}

function killTree(proc) {
  if (!proc || proc.killed || !proc.pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* zaten bitti */
    }
  }
}

// Çıktıyı toplayan kısa süreli komut.
function runCapture(bin, args, { timeout = 90000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { windowsHide: true, env: utf8Env() });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      killTree(proc);
      reject(new Error('İşlem zaman aşımına uğradı.'));
    }, timeout);
    proc.stdout.on('data', (d) => (out += d.toString('utf8')));
    proc.stderr.on('data', (d) => (err += d.toString('utf8')));
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

function freeBytes(dir) {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null; // ölçülemiyorsa engelleme
  }
}

function lastLine(text, re) {
  const lines = String(text || '').split(/\r?\n/).filter(Boolean);
  if (re) {
    const hit = [...lines].reverse().find((l) => re.test(l));
    if (hit) return hit;
  }
  return lines.pop() || '';
}

class Downloader extends EventEmitter {
  constructor({ settings, history, engine, accounts, logger, tmpDir }) {
    super();
    this.settings = settings;
    this.history = history;
    this.engine = engine;
    this.accounts = accounts || null;
    this.log = logger || NOLOG;
    this.tmpDir = path.join(tmpDir || os.tmpdir(), 'berloader');
    this.jobs = new Map();
    this.paused = false;
    this._lastEmit = new Map();
    this._restoreHistory();
  }

  // ---------- Durum ----------
  _restoreHistory() {
    for (const j of this.history.list()) {
      if (!TERMINAL.has(j.status)) {
        j.status = 'canceled';
        j.error = 'Uygulama kapandığı için yarım kaldı. Tekrar deneyebilirsin.';
      }
      this.jobs.set(j.id, j);
    }
  }

  // Arayüze ve diske yalnızca düz veri gider; "_" ile başlayan iç alanlar ve süreç nesnesi atılır.
  publicJob(job) {
    const out = {};
    for (const [k, v] of Object.entries(job)) if (!k.startsWith('_') && k !== 'proc') out[k] = v;
    return out;
  }

  list() {
    return [...this.jobs.values()].map((j) => this.publicJob(j));
  }

  hasActive() {
    return [...this.jobs.values()].some((j) => RUNNING.includes(j.status));
  }

  _persist() {
    this.history.set([...this.jobs.values()].map((j) => this.publicJob(j)));
  }

  _emit(job, force = false) {
    const now = Date.now();
    const last = this._lastEmit.get(job.id) || 0;
    if (!force && now - last < 250) return;
    this._lastEmit.set(job.id, now);
    this.emit('job', this.publicJob(job));
  }

  _set(job, patch, force = true) {
    // Aşama değişimi (ör. birleştirme) hız sınırına takılmadan her zaman iletilir.
    const phaseChanged = patch.phase !== undefined && patch.phase !== job.phase;
    Object.assign(job, patch);
    this._emit(job, force || phaseChanged);
    if (TERMINAL.has(job.status)) this._persist();
  }

  // ---------- Hesap çerezleri ----------
  // Uygulamanın giriş oturumundan, iş için geçici bir cookies.txt üretir.
  async _prepareCookies(tag) {
    if (!this.accounts) return { file: null, cleanup() {} };
    const file = path.join(this.tmpDir, `cookies-${tag}.txt`);
    let ok = false;
    try {
      ok = await this.accounts.writeCookieFile(file);
    } catch (e) {
      this.log.warn('Çerez dosyası yazılamadı:', e.message);
    }
    return {
      file: ok ? file : null,
      cleanup() {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          /* yoksay */
        }
      }
    };
  }

  // ---------- Çözümleme ----------
  _ytCtx(cookieFile) {
    return {
      settings: this.settings.data,
      denoPath: this.engine.has('deno') ? this.engine.bin('deno') : null,
      cookieFile
    };
  }

  // opts: { platform: seçili platform (zorunlu), format: 'mp4' | 'mp3' | 'm4a' | 'wav' | 'image' }
  async analyze(raw, opts = {}) {
    const url = P.extractUrl(raw);
    if (!url) throw new Error('Geçerli bir bağlantı bulunamadı.');
    const p = P.detect(url);

    const mismatch = P.checkPlatformMatch(opts.platform, p.platform);
    if (mismatch) throw new Error(mismatch);

    const format = opts.format || this.settings.data.format;
    const imageMode = format === 'image';
    if (imageMode && !P.IMAGE_PLATFORMS.includes(p.platform)) {
      throw new Error('YouTube için görsel indirme yok. Biçim olarak video veya ses seç.');
    }

    // Yalnızca gereken motorları bekler; hepsinin inmesini beklemez.
    const need = imageMode ? ['gallerydl'] : p.platform === 'youtube' ? ['ytdlp', 'deno'] : ['ytdlp'];
    await this.engine.ensure(need);
    if (imageMode && !this.engine.has('gallerydl')) {
      throw new Error('Görsel indirme motoru (gallery-dl) hazır değil. İnternet bağlantını kontrol et; Ayarlar > Motorlar bölümünden güncelleyebilirsin.');
    }
    if (!imageMode && !this.engine.has('ytdlp')) {
      throw new Error('İndirme motoru (yt-dlp) henüz hazır değil. İnternet bağlantını kontrol edip biraz sonra tekrar dene.');
    }

    const cookies = await this._prepareCookies('a-' + crypto.randomUUID().slice(0, 8));
    try {
      return await this._analyze(url, p, format, cookies.file);
    } finally {
      cookies.cleanup();
    }
  }

  async _analyze(url, p, format, cookieFile) {
    const hasGallery = this.engine.has('gallerydl');
    const imageMode = format === 'image';
    const audioMode = ['mp3', 'm4a', 'wav'].includes(format);

    // Yalnızca görsel: gallery-dl, videolar listeden çıkarılır.
    if (imageMode) {
      const g = await this._inspectGallery(url, p, cookieFile);
      if (!g.result) throw new Error(A.friendlyError(g.error) || 'Bu bağlantıda indirilebilir görsel bulunamadı.');
      const items = g.result.items ? g.result.items.filter((i) => i.type === 'image') : [];
      if (g.result.kind === 'video' || !items.length) throw new Error('Bu gönderide görsel yok; yalnızca video içeriyor.');
      return { ...g.result, kind: 'gallery', items };
    }

    // Video/ses: Instagram, TikTok ve Pinterest çoklu gönderi olabilir, önce gallery-dl bakar.
    // Ses isteniyorsa doğrudan yt-dlp kullanılır.
    const galleryFirst = hasGallery && !audioMode && ['instagram', 'tiktok', 'pinterest'].includes(p.platform);
    let galleryError = '';
    if (galleryFirst) {
      const g = await this._inspectGallery(url, p, cookieFile).catch((e) => ({ result: null, error: e.message }));
      if (g.result) return g.result;
      galleryError = g.error || '';
    }
    try {
      return await this._inspectYtdlp(url, p, cookieFile);
    } catch (e) {
      // X gönderisinde video yoksa görseldir.
      if (p.platform === 'x' && /no video|there is no video/i.test(e.message)) {
        if (!hasGallery) throw new Error('Bu gönderide yalnızca görsel var; görsel indirmek için gallery-dl motoru gerekiyor (Ayarlar > Motorlar).');
        const g = await this._inspectGallery(url, p, cookieFile);
        if (g.result) return g.result;
        throw new Error(A.friendlyError(g.error || e.message));
      }
      throw new Error(A.friendlyError(galleryError || e.message));
    }
  }

  async _inspectYtdlp(rawUrl, p, cookieFile) {
    let url = rawUrl;
    let noPlaylist = false;
    if (p.platform === 'youtube' && p.url) {
      if (P.youtubeKind(p.url) === 'video') {
        url = P.cleanYoutubeVideoUrl(p.url);
        noPlaylist = true;
      }
    }
    const args = A.buildYtdlpInfoArgs(url, this._ytCtx(cookieFile), noPlaylist);
    const { code, out, err } = await runCapture(this.engine.bin('ytdlp'), args, { timeout: 120000 });
    if (code !== 0 || !out.trim()) {
      this.log.warn('yt-dlp çözümleme hatası:', p.platform, lastLine(err));
      throw new Error(lastLine(err, /ERROR/i) || 'Bağlantı çözümlenemedi.');
    }
    let info;
    try {
      info = JSON.parse(out);
    } catch {
      throw new Error('Bağlantı çözümlenemedi (beklenmeyen yanıt).');
    }

    if (info._type === 'playlist' || (Array.isArray(info.entries) && !noPlaylist)) {
      let entries = info.entries || [];
      entries = entries.flatMap((e) => (e && e.entries ? e.entries : [e])).filter(Boolean);
      if (entries.length === 0) throw new Error('Listede video bulunamadı.');
      // YouTube dışında tek elemanlı "liste" aslında tek videodur (ör. X gönderisi).
      if (entries.length === 1 && p.platform !== 'youtube') {
        return this._videoResult(url, p, entries[0]);
      }
      return {
        kind: 'playlist',
        platform: p.platform,
        url,
        title: info.title || 'Oynatma listesi',
        count: entries.length,
        entries: entries.map((e, i) => ({
          index: i + 1,
          id: e.id,
          title: e.title || `Video ${i + 1}`,
          duration: e.duration || null,
          url: e.url && /^https?:/.test(e.url) ? e.url : p.platform === 'youtube' ? `https://www.youtube.com/watch?v=${e.id}` : e.url
        }))
      };
    }
    return this._videoResult(url, p, info);
  }

  _videoResult(url, p, info) {
    const heights = (info.formats || []).map((f) => f.height).filter(Boolean);
    const thumb = info.thumbnail || (info.thumbnails && info.thumbnails.length ? info.thumbnails[info.thumbnails.length - 1].url : null);
    return {
      kind: 'video',
      route: 'ytdlp',
      platform: p.platform,
      url,
      title: info.title || url,
      thumbnail: thumb || null,
      duration: info.duration || null,
      maxHeight: heights.length ? Math.max(...heights) : null
    };
  }

  // Dönüş: { result, error }. result yoksa error nedenini taşır.
  async _inspectGallery(url, p, cookieFile) {
    const bin = this.engine.bin('gallerydl');
    let lastErr = '';
    const run = async (resolve) => {
      const r = await runCapture(bin, A.buildGalleryListArgs(url, this.settings.data, resolve, cookieFile), { timeout: 120000 });
      if (r.err && r.err.trim()) lastErr = lastLine(r.err, /error|login|private|not found/i);
      return A.parseGalleryJson(r.out);
    };
    let parsed = await run(false);
    if (!parsed.items.length) parsed = await run(true);
    if (!parsed.items.length) {
      this.log.warn('gallery-dl boş döndü:', p.platform, lastErr);
      return { result: null, error: lastErr };
    }

    const title = A.galleryTitle(parsed.meta, P.PLATFORM_LABELS[p.platform]);
    const items = parsed.items;
    if (items.length === 1 && items[0].type === 'video') {
      return {
        result: {
          kind: 'video',
          route: 'ytdlp',
          galleryFallback: true,
          platform: p.platform,
          url,
          title,
          thumbnail: items[0].thumb || null,
          duration: null,
          maxHeight: null
        }
      };
    }
    return {
      result: {
        kind: 'gallery',
        route: 'gallery',
        platform: p.platform,
        url,
        title,
        items: items.map((i) => ({ index: i.index, type: i.type, ext: i.ext, thumb: i.thumb }))
      }
    };
  }

  // ---------- Kuyruğa alma ----------
  // payload: { route, url, platform, title, thumbnail, format, quality, selection?, subdir?, prefix?, galleryFallback? }
  // ya da { batch: [payload, ...] }
  enqueue(payload) {
    const s = this.settings.data;
    const list = Array.isArray(payload.batch) ? payload.batch : [payload];
    const created = [];
    for (const p of list) {
      const job = {
        id: crypto.randomUUID(),
        route: p.route || 'ytdlp',
        url: p.url,
        platform: p.platform || 'other',
        title: p.title || p.url,
        thumbnail: p.thumbnail || null,
        format: p.format || s.format,
        quality: p.quality || s.quality,
        selection: p.selection || null,
        itemCount: p.selection ? p.selection.length : null,
        subdir: p.subdir || '',
        prefix: p.prefix || '',
        galleryFallback: !!p.galleryFallback,
        status: 'queued',
        phase: 'queued',
        progress: 0,
        speed: null,
        eta: null,
        filePath: null,
        info: null,
        editorReady: null,
        note: null,
        error: null,
        createdAt: Date.now()
      };
      this.jobs.set(job.id, job);
      created.push(job);
      this._emit(job, true);
    }
    this._persist();
    this._pump();
    return created.map((j) => this.publicJob(j));
  }

  setPaused(flag) {
    this.paused = !!flag;
    if (!this.paused) this._pump();
    return this.paused;
  }

  _pump() {
    if (this.paused) return;
    const limit = this.settings.data.concurrent || 2;
    let running = [...this.jobs.values()].filter((j) => RUNNING.includes(j.status)).length;
    for (const job of this.jobs.values()) {
      if (running >= limit) break;
      if (job.status === 'queued') {
        running++;
        this._run(job);
      }
    }
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job || TERMINAL.has(job.status)) return;
    job._canceled = true;
    if (job.proc) killTree(job.proc);
    this._set(job, { status: 'canceled', phase: 'canceled', speed: null, eta: null, error: null });
    this._pump();
  }

  retry(id) {
    const job = this.jobs.get(id);
    if (!job || !TERMINAL.has(job.status) || job.status === 'done') return;
    job._canceled = false;
    job._engineRetried = false;
    this._set(job, { status: 'queued', phase: 'queued', progress: 0, speed: null, eta: null, error: null, note: null });
    this._pump();
  }

  remove(id) {
    const job = this.jobs.get(id);
    if (!job) return;
    if (!TERMINAL.has(job.status)) this.cancel(id);
    this.jobs.delete(id);
    this._lastEmit.delete(id);
    this._persist();
    this.emit('removed', id);
  }

  clearFinished() {
    for (const [id, j] of [...this.jobs.entries()]) {
      if (j.status === 'done') {
        this.jobs.delete(id);
        this.emit('removed', id);
      }
    }
    this._persist();
  }

  killAll() {
    for (const j of this.jobs.values()) if (j.proc) killTree(j.proc);
  }

  // ---------- Çalıştırma ----------
  _outDir(job) {
    let dir = this.settings.downloadDir();
    if (this.settings.data.organizeByPlatform && P.PLATFORM_LABELS[job.platform]) {
      dir = path.join(dir, P.PLATFORM_LABELS[job.platform]);
    }
    if (job.subdir) dir = path.join(dir, A.sanitizeName(job.subdir, 80));
    fs.mkdirSync(dir, { recursive: true });
    const free = freeBytes(dir);
    if (free !== null && free < MIN_FREE_BYTES) {
      throw new Error('Diskte yeterli boş alan yok (500 MB altında). Yer açıp tekrar dene.');
    }
    return dir;
  }

  async _run(job) {
    this._set(job, { status: 'analyzing', phase: 'starting', progress: 0, error: null });
    this.log.info('İş başladı:', { id: job.id.slice(0, 8), platform: job.platform, route: job.route, format: job.format, quality: job.quality, url: job.url });
    let cookies = { file: null, cleanup() {} };
    try {
      await this.engine.ensure(job.route === 'gallery' ? ['gallerydl'] : ['ytdlp']);
      if (job._canceled) return;
      cookies = await this._prepareCookies(job.id.slice(0, 8));
      job._cookieFile = cookies.file;
      if (job.route === 'gallery') await this._runGallery(job);
      else await this._runYtdlp(job);
    } catch (e) {
      this.log.error('İş hatası:', job.platform, job.url, e.message, job._stderrTail || '');
      if (!job._canceled) this._set(job, { status: 'error', phase: 'error', speed: null, eta: null, error: A.friendlyError(e.message) });
    } finally {
      cookies.cleanup();
      job._cookieFile = null;
      job.proc = null;
      this._pump();
    }
  }

  _runYtdlp(job) {
    return new Promise((resolve, reject) => {
      const bin = this.engine.bin('ytdlp');
      if (!fs.existsSync(bin)) return reject(new Error('yt-dlp bulunamadı. Ayarlar > Motorlar bölümünden güncelleyin.'));
      if (!this.engine.ffmpegExists()) {
        return reject(new Error('ffmpeg bulunamadı. Video birleştirme ve dönüştürme için gerekli; uygulamayı yeniden kur ya da Ayarlar > Tanılama bölümüne bak.'));
      }
      let outDir;
      try {
        outDir = this._outDir(job);
      } catch (e) {
        return reject(e);
      }
      try { fs.mkdirSync(this.tmpDir, { recursive: true }); } catch (_) { /* yok say */ }
      const printFile = path.join(this.tmpDir, `outfile-${job.id.slice(0, 8)}-${Date.now()}.txt`);
      const args = A.buildYtdlpArgs(job, {
        printFile,
        settings: this.settings.data,
        ffmpegPath: this.engine.ffmpegPath(),
        denoPath: this.engine.has('deno') ? this.engine.bin('deno') : null,
        outDir,
        cookieFile: job._cookieFile
      });
      this._set(job, { status: 'downloading', phase: 'downloading' });

      const proc = spawn(bin, args, { windowsHide: true, env: utf8Env() });
      job.proc = proc;
      job._streamIdx = 0;
      job._streams = 1;
      job._stream = null;
      let finalFile = null;
      const errLines = [];
      const outLines = [];
      const startedAt = Date.now() - 2000;

      const onOut = lineSplitter((line) => {
        if (!line.startsWith('BLP|') && line.trim()) {
          outLines.push(line);
          if (outLines.length > 20) outLines.shift();
        }
        if (line.startsWith('BLFILE|')) {
          finalFile = line.slice(7).trim();
          return;
        }
        const existing = A.parseAlreadyDownloaded(line);
        if (existing) {
          if (!finalFile) finalFile = existing;
          return;
        }
        const p = A.parseProgressLine(line);
        if (!p) return;
        if (job._stream && p.filename && p.filename !== job._stream) job._streamIdx++;
        job._stream = p.filename || job._stream;
        job._streams = Math.max(job._streams, p.streams);
        const frac = p.total ? Math.min(1, (p.downloaded || 0) / p.total) : 0;
        let overall;
        if (job._streams === 2) overall = job._streamIdx === 0 ? frac * 90 : 90 + frac * 10;
        else overall = frac * 100;
        const merging = job._streams === 2 && job._streamIdx >= 1 && frac >= 0.999;
        this._set(
          job,
          {
            phase: merging ? 'merging' : 'downloading',
            progress: Math.max(job.progress || 0, Math.min(99, Math.round(overall))),
            speed: p.speed,
            eta: p.eta
          },
          false
        );
      });
      const onErr = lineSplitter((line) => {
        errLines.push(line);
        if (errLines.length > 60) errLines.shift();
      });
      proc.stdout.on('data', onOut);
      proc.stderr.on('data', onErr);
      proc.on('error', (e) => reject(e));
      proc.on('close', async (code) => {
        if (job._canceled) return resolve();
        job._stderrTail = errLines.slice(-6).join(' | ');
        try {
          const lines = fs.readFileSync(printFile, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
          const last = lines[lines.length - 1];
          if (last && fs.existsSync(last)) finalFile = last;
        } catch (_) { /* yazılmamış olabilir */ }
        try { fs.unlinkSync(printFile); } catch (_) { /* yok say */ }
        // yt-dlp başarıyla bittiyse ama bildirilen yol bulunamıyorsa (özel karakterli başlık,
        // farklı uzantı vb.) klasörde bu işin ürettiği en yeni dosyayı ara.
        if (code === 0 && (!finalFile || !fs.existsSync(finalFile))) {
          const found = findNewestOutput(outDir, startedAt, finalFile);
          this.log.warn('yt-dlp 0 ile bitti ama dosya yolu doğrulanamadı', { reported: finalFile, found, outDir, dir: found ? undefined : listDirTail(outDir), err: errLines.slice(-5) });
          if (found) finalFile = found;
        }
        // TikTok/Instagram "fotoğraf gönderisi" video yerine yalnızca ses verirse görsel motoruna geç.
        if (code === 0 && finalFile && fs.existsSync(finalFile) && job.format === 'mp4' && /\.(m4a|mp3|opus|aac|ogg|weba)$/i.test(finalFile)
            && P.IMAGE_PLATFORMS.includes(job.platform) && this.engine.has('gallerydl')) {
          try { fs.unlinkSync(finalFile); } catch (_) { /* yok say */ }
          this.log.info('Video yok, yalnızca ses geldi; fotoğraf gönderisi olarak gallery-dl deneniyor', job.url);
          job.route = 'gallery';
          job.selection = null;
          return this._runGallery(job).then(resolve, reject);
        }
        if (code !== 0 || !finalFile || !fs.existsSync(finalFile)) {
          const errText = errLines.filter((l) => /ERROR/i.test(l)).pop() || errLines.pop() ||
            (code === 0 ? 'İndirme tamamlandı ama dosya bulunamadı. Tanılama bilgisini kopyalayıp gönder.' : `yt-dlp hata kodu ${code}`);
          // Site değişmiş olabilir: motoru güncelle ve bir kez daha dene.
          if (!job._engineRetried && A.isEngineBreakage(errText)) {
            job._engineRetried = true;
            this.log.warn('Motor kırılması şüphesi, güncelleniyor:', errText);
            this._set(job, { phase: 'updating', speed: null, eta: null });
            await this.engine.update({ only: ['ytdlp', 'deno'], reason: 'indirme hatası sonrası' });
            if (job._canceled) return resolve();
            return this._runYtdlp(job).then(resolve, reject);
          }
          // Tek videolu galeri bağlantısıysa gallery-dl ile dene.
          if (job.galleryFallback && job.route !== 'gallery' && this.engine.has('gallerydl')) {
            job.route = 'gallery';
            job.selection = [1];
            return this._runGallery(job).then(resolve, reject);
          }
          return reject(new Error(errText));
        }
        try {
          let file = finalFile;
          let info = null;
          let ready = null;
          if (job.format === 'mp4') {
            const r = await this._ensureEditorFriendly(job, finalFile, { report: true });
            file = r.file;
            info = r.info;
            ready = r.ready;
          }
          if (job._canceled) return resolve();
          this._set(job, { status: 'done', phase: 'done', progress: 100, speed: null, eta: null, filePath: file, info, editorReady: ready });
          this.log.info('İş bitti:', job.platform, file, info || '');
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  // ffmpeg ile bir kez çalıştırır; ilerleme job'a yansır (report=true ise).
  _runFfmpeg(job, args, duration, report) {
    return new Promise((resolve, reject) => {
      const ffmpeg = this.engine.ffmpegPath();
      const proc = spawn(ffmpeg, args, { windowsHide: true });
      job.proc = proc;
      let tail = '';
      proc.stderr.on(
        'data',
        lineSplitter((line) => {
          tail = line;
          if (!report || !duration) return;
          const m = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
          if (m) {
            const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
            this._set(job, { progress: Math.min(99, Math.round((t / duration) * 100)) }, false);
          }
        })
      );
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (job._canceled) return resolve(false);
        if (code === 0) resolve(true);
        else reject(new Error('ffmpeg dönüştürmesi başarısız: ' + tail.slice(0, 200)));
      });
    });
  }

  async _probe(file) {
    const r = await runCapture(this.engine.ffmpegPath(), ['-hide_banner', '-i', file], { timeout: 60000 });
    return A.parseFfmpegProbe(r.err);
  }

  // Düzenleme yazılımları (After Effects, Premiere, CapCut) için çıktıyı H.264 + AAC .mp4 yapar,
  // ardından sonucu gerçekten denetler. Uyumluluk açıkken doğrulanamazsa HATA verir; "belki çalışır"
  // diye bozuk bir dosya bırakmaz.
  // Dönüş: { file, info, ready }
  async _ensureEditorFriendly(job, input, { report = true } = {}) {
    if (!this.engine.ffmpegExists()) {
      throw new Error('ffmpeg bulunamadı; dosya düzenleme uyumlu hale getirilemedi.');
    }
    if (!fs.existsSync(input)) throw new Error('İndirilen dosya bulunamadı: ' + path.basename(input));
    const compat = this.settings.data.editorCompat;
    const probe = await this._probe(input);
    let plan = A.planCompat(probe);
    // Uyumluluk kapalıysa yeniden kodlama yapılmaz; yalnızca kayıpsız MP4 kabına alınır.
    if (!compat) plan = { videoOk: true, audioOk: true, needsEncode: false };
    const ext = path.extname(input).toLowerCase();
    const base = input.slice(0, input.length - ext.length);
    const output = base + '.mp4';

    let finalFile = input;
    let finalProbe = probe;
    if (!(ext === '.mp4' && !plan.needsEncode)) {
      const tmpOut = base + '.berloader-tmp.mp4';
      this._set(job, {
        status: report ? 'converting' : job.status,
        phase: plan.needsEncode ? 'encoding' : 'remuxing',
        progress: 0,
        speed: null,
        eta: null
      });
      const ok = await this._runFfmpeg(job, A.buildFfmpegArgs(input, tmpOut, plan, probe), probe.duration, report);
      if (!ok || job._canceled) {
        fs.rmSync(tmpOut, { force: true });
        return { file: input, info: null, ready: null };
      }
      fs.rmSync(input, { force: true });
      if (fs.existsSync(output)) fs.rmSync(output, { force: true });
      fs.renameSync(tmpOut, output);
      finalFile = output;
      finalProbe = await this._probe(output);
    }

    const verdict = A.checkEditorReady(finalProbe, path.extname(finalFile));
    if (compat && !verdict.ok) {
      throw new Error(`Çıktı düzenleme uyumluluğunu sağlamıyor (${verdict.problems.join(', ')}): ${A.describeProbe(finalProbe)}`);
    }
    return { file: finalFile, info: A.describeProbe(finalProbe), ready: verdict.ok };
  }

  _uniquePath(dir, name) {
    let p = path.join(dir, name);
    if (!fs.existsSync(p)) return p;
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let n = 2; n < 1000; n++) {
      p = path.join(dir, `${stem} (${n})${ext}`);
      if (!fs.existsSync(p)) return p;
    }
    return p;
  }

  _runGallery(job) {
    return new Promise((resolve, reject) => {
      const bin = this.engine.bin('gallerydl');
      if (!fs.existsSync(bin)) return reject(new Error('gallery-dl bulunamadı. Ayarlar > Motorlar bölümünden güncelleyin.'));
      if (!job.subdir && job.selection && job.selection.length > 1) {
        job.subdir = `${P.PLATFORM_LABELS[job.platform] || 'Görsel'} - ${job.title}`;
      }
      let outDir;
      try {
        outDir = this._outDir(job);
      } catch (e) {
        return reject(e);
      }
      const total = job.selection ? job.selection.length : null;
      const args = A.buildGalleryArgs(job, { settings: this.settings.data, outDir, cookieFile: job._cookieFile });
      this._set(job, { status: 'downloading', phase: 'downloading', progress: 0, itemCount: total });

      const proc = spawn(bin, args, { windowsHide: true, env: utf8Env() });
      job.proc = proc;
      const files = [];
      const errLines = [];
      proc.stdout.on(
        'data',
        lineSplitter((line) => {
          const skipped = line.startsWith('# ');
          const file = (skipped ? line.slice(2) : line).trim();
          if (!file) return;
          files.push(file);
          const progress = total ? Math.min(95, Math.round((files.length / total) * 95)) : 50;
          this._set(job, { progress }, false);
        })
      );
      proc.stderr.on(
        'data',
        lineSplitter((line) => {
          errLines.push(line);
          if (errLines.length > 60) errLines.shift();
        })
      );
      proc.on('error', reject);
      proc.on('close', async (code) => {
        if (job._canceled) return resolve();
        job._stderrTail = errLines.slice(-6).join(' | ');
        const existing = files.filter((f) => fs.existsSync(f));
        if (existing.length === 0) {
          const errText = errLines.filter((l) => /error/i.test(l)).pop() || errLines.pop() || `gallery-dl hata kodu ${code}`;
          if (!job._engineRetried && A.isEngineBreakage(errText)) {
            job._engineRetried = true;
            this.log.warn('Motor kırılması şüphesi, güncelleniyor:', errText);
            this._set(job, { phase: 'updating' });
            await this.engine.update({ only: ['gallerydl'], reason: 'indirme hatası sonrası' });
            if (job._canceled) return resolve();
            return this._runGallery(job).then(resolve, reject);
          }
          return reject(new Error(errText));
        }
        try {
          this._set(job, { phase: 'finishing', progress: 96 });
          const result = await this._finishGallery(job, existing, outDir);
          if (job._canceled) return resolve();
          const note = total && result.files.length < total ? `${total} dosyadan ${result.files.length} tanesi indirilebildi.` : null;
          this._set(job, {
            status: 'done',
            phase: 'done',
            progress: 100,
            filePath: result.files[result.files.length - 1],
            itemCount: result.files.length,
            info: result.info,
            editorReady: result.ready,
            note
          });
          this.log.info('Görsel işi bitti:', job.platform, result.files.length, 'dosya');
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  // Görselleri okunur adlara çevirir; webp/avif -> PNG; videoları düzenleme uyumlu MP4 yapar.
  async _finishGallery(job, files, outDir) {
    const label = P.PLATFORM_LABELS[job.platform] || 'Görsel';
    const names = A.galleryFileNames(files, job.selection, label, job.title);
    const renamed = [];
    files.forEach((f, i) => {
      const target = this._uniquePath(path.dirname(f), names[i]);
      try {
        fs.renameSync(f, target);
        renamed.push(target);
      } catch {
        renamed.push(f); // yeniden adlandırılamazsa özgün ad kalır
      }
    });

    const compat = this.settings.data.editorCompat;
    const out = [];
    let videoInfo = null;
    let ready = null;
    for (const f of renamed) {
      if (job._canceled) break;
      const ext = path.extname(f).toLowerCase().replace('.', '');
      if (compat && A.IMAGE_CONVERT_EXT.has(ext) && this.engine.ffmpegExists()) {
        const png = f.replace(/\.[^.]+$/, '.png');
        const r = await runCapture(this.engine.ffmpegPath(), ['-hide_banner', '-y', '-i', f, png], { timeout: 60000 }).catch(() => ({ code: 1 }));
        if (r.code === 0 && fs.existsSync(png)) {
          fs.rmSync(f, { force: true });
          out.push(png);
          continue;
        }
        out.push(f); // dönüştürülemezse özgün dosya kalır
      } else if (A.VIDEO_EXT.has(ext)) {
        const r = await this._ensureEditorFriendly(job, f, { report: false });
        out.push(r.file);
        videoInfo = r.info || videoInfo;
        ready = r.ready === false ? false : ready === null ? r.ready : ready;
      } else {
        out.push(f);
      }
    }
    return { files: out.length ? out : renamed, info: videoInfo, ready };
  }
}

module.exports = { Downloader, TERMINAL, runCapture, lastLine };
