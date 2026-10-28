'use strict';
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  downloadDir: '', // boş = Downloads\BerLoader
  organizeByPlatform: false, // true: BerLoader\YouTube, BerLoader\Instagram ... alt klasörleri
  format: 'mp4', // mp4 | mp3 | m4a | wav | image
  quality: 'best', // best | 2160 | 1440 | 1080 | 720 | 480
  editorCompat: true, // Adobe / CapCut için H.264 + AAC garantisi
  concurrent: 1, // sırayla indir: bir video bitmeden sıradaki başlamaz
  autoClearDone: true, // biten işleri 24 saat sonra listeden kaldır (dosyalara dokunmaz)
  cookiesBrowser: 'none', // none | firefox | edge | chrome | brave | opera
  cookiesFile: '',
  engineChannel: 'stable', // stable | nightly (yt-dlp)
  autoUpdateEngine: true,
  autoUpdateApp: true,
  youtubeRemoteSolver: true,
  windowWidth: 1100,
  windowHeight: 760
};

const FORMATS = ['mp4', 'mp3', 'm4a', 'wav', 'image'];

class JsonFile {
  constructor(name, defaults) {
    this.file = path.join(app.getPath('userData'), name);
    this.data = JSON.parse(JSON.stringify(defaults));
    this._timer = null;
    this._load();
  }
  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(this.data)) this.data = Array.isArray(raw) ? raw : this.data;
      else this.data = { ...this.data, ...raw };
    } catch {
      /* ilk çalıştırma ya da bozuk dosya: varsayılanlarla devam */
    }
  }
  save(immediate = false) {
    clearTimeout(this._timer);
    const write = () => {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = this.file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
        fs.renameSync(tmp, this.file);
      } catch (e) {
        console.error('Kaydedilemedi:', this.file, e.message);
      }
    };
    if (immediate) write();
    else this._timer = setTimeout(write, 400);
  }
}

class Settings extends JsonFile {
  constructor() {
    super('settings.json', DEFAULTS);
    if (!FORMATS.includes(this.data.format)) this.data.format = 'mp4';
    // v2: eski kurulumlarda kayıtlı "2 eşzamanlı" ayarını sıralı indirmeye çevir.
    if ((Number(this.data.settingsVersion) || 1) < 2) {
      this.data.concurrent = 1;
      this.data.settingsVersion = 2;
      this.save(true);
    }
  }
  all() {
    return { ...this.data, downloadDir: this.downloadDir() };
  }
  downloadDir() {
    return this.data.downloadDir || path.join(app.getPath('downloads'), 'BerLoader');
  }
  patch(partial) {
    for (const k of Object.keys(partial)) {
      if (k in DEFAULTS) this.data[k] = partial[k];
    }
    this.data.concurrent = Math.min(5, Math.max(1, Number(this.data.concurrent) || 1));
    if (!FORMATS.includes(this.data.format)) this.data.format = 'mp4';
    this.save();
    return this.all();
  }
}

class History extends JsonFile {
  constructor() {
    super('history.json', []);
  }
  list() {
    return this.data;
  }
  set(list) {
    this.data = list.slice(-200);
    this.save();
  }
}

module.exports = { Settings, History, DEFAULTS, FORMATS };
