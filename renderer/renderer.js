'use strict';
(() => {
  const api = window.berloader;
  const $ = (s) => document.querySelector(s);

  const LABEL = { youtube: 'YouTube', instagram: 'Instagram', tiktok: 'TikTok', x: 'X', pinterest: 'Pinterest', other: 'Web' };
  // "…'dan/den indiriliyor" (Türkçe ünlü uyumuna göre)
  const FROM = { youtube: "YouTube'dan", instagram: "Instagram'dan", tiktok: "TikTok'tan", x: "X'ten", pinterest: "Pinterest'ten", other: 'Web üzerinden' };
  const PLAT_INFO = {
    youtube: 'Video, Shorts ve oynatma listeleri. MP4 ya da ses olarak indirilir.',
    instagram: 'Reels, video ve fotoğraf gönderileri. Çoklu gönderide istediklerini seçersin.',
    tiktok: 'Video ve fotoğraf gönderileri. Çoklu gönderide istediklerini seçersin.',
    x: 'Video ve görselli gönderiler. Çoklu görselde istediklerini seçersin.',
    pinterest: 'Pin görselleri ve videoları.'
  };
  const QUALITY = { best: 'En yüksek', 2160: '4K', 1440: '2K', 1080: '1080p', 720: '720p', 480: '480p' };
  const TERMINAL = ['done', 'error', 'canceled'];
  const ACCOUNT_ORDER = ['instagram', 'x', 'tiktok', 'pinterest'];

  let settings = {};
  let accounts = {};
  let platform = null; // zorunlu: kullanıcı seçmeden indirme yapılmaz
  const jobs = new Map();
  const rows = new Map();
  let paused = false;
  let busy = false;

  // ---------- Yardımcılar ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) el.append(kid);
    return el;
  }

  function fmtSpeed(bps) {
    if (!bps) return '';
    if (bps > 1048576) return (bps / 1048576).toFixed(1) + ' MB/sn';
    return Math.round(bps / 1024) + ' KB/sn';
  }
  function fmtEta(sec) {
    if (sec == null || !Number.isFinite(sec)) return '';
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // Yapıştırılan bağlantıdan platformu tahmin eder (yalnızca ipucu; asıl doğrulama ana süreçte).
  function guessPlatform(text) {
    const m = String(text).match(/https?:\/\/([^/\s?#]+)/i) || String(text).match(/^(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})/i);
    if (!m) return null;
    const host = m[1].toLowerCase();
    if (/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(host)) return 'youtube';
    if (/(^|\.)(instagram\.com|instagr\.am)$/.test(host)) return 'instagram';
    if (/(^|\.)tiktok\.com$/.test(host)) return 'tiktok';
    if (/(^|\.)(twitter\.com|x\.com)$|^t\.co$/.test(host)) return 'x';
    if (/(^|\.)pinterest\.[a-z.]+$|^pin\.it$/.test(host)) return 'pinterest';
    return null;
  }

  function setHint(text, kind) {
    const el = $('#hint');
    el.textContent = text || '';
    el.className = 'hint grow' + (kind ? ' ' + kind : '');
  }

  function setBusy(on, text) {
    busy = on;
    $('#downloadBtn').disabled = on;
    $('#urlInput').disabled = on;
    $('#downloadBtn').textContent = on ? 'Bekle…' : 'İndir';
    if (on) setHint(text || 'Bağlantı çözümleniyor…');
  }

  // ---------- Başlatma ----------
  async function init() {
    settings = await api.getSettings();
    applySettingsToUi();
    for (const j of await api.listJobs()) jobs.set(j.id, j);
    renderAll();

    api.onJobUpdate((j) => {
      jobs.set(j.id, j);
      renderJob(j);
      updateCount();
    });
    api.onJobRemoved((id) => {
      jobs.delete(id);
      const row = rows.get(id);
      if (row) row.remove();
      rows.delete(id);
      updateCount();
    });
    api.onEngineStatus(renderEngine);
    api.onAppUpdate(renderAppUpdate);

    renderEngine(await api.engineStatus());
    const info = await api.appInfo();
    $('#appVersion').textContent = 'v' + info.version + (info.packaged ? '' : ' (geliştirme)');
    renderAppUpdate(info.update);
    await refreshAccounts();
    renderPlatformHint();
    refreshOptions();
  }

  function applySettingsToUi() {
    $('#formatSelect').value = settings.format;
    $('#qualitySelect').value = settings.quality;
    $('#dirLabel').textContent = settings.downloadDir;
    $('#setDir').value = settings.downloadDir;
    $('#setByPlatform').checked = !!settings.organizeByPlatform;
    $('#setConcurrent').value = String(settings.concurrent);
    $('#setCompat').checked = !!settings.editorCompat;
    $('#setCookies').value = settings.cookiesBrowser;
    $('#setCookieFile').value = settings.cookiesFile || '';
    $('#setChannel').value = settings.engineChannel;
    $('#setAutoEngine').checked = !!settings.autoUpdateEngine;
    $('#setSolver').checked = !!settings.youtubeRemoteSolver;
    $('#setAutoApp').checked = !!settings.autoUpdateApp;
    refreshOptions();
  }

  async function save(partial) {
    settings = await api.setSettings(partial);
    applySettingsToUi();
  }

  // ---------- Platform seçimi ----------
  function selectPlatform(p) {
    platform = p;
    for (const b of document.querySelectorAll('.plat')) b.setAttribute('aria-pressed', String(b.dataset.platform === p));
    $('#platforms').classList.remove('needs-pick');
    setHint('');
    // Seçili platform YouTube ise "Görsel" biçimi geçersiz.
    if (p === 'youtube' && settings.format === 'image') save({ format: 'mp4' });
    renderPlatformHint();
    refreshOptions();
    $('#urlInput').focus();
  }

  function renderPlatformHint() {
    const el = $('#platformHint');
    el.textContent = '';
    if (!platform) {
      el.append(h('span', { text: 'İndirme yapacağın platformu seç.' }));
      return;
    }
    el.append(h('span', { text: PLAT_INFO[platform] }));
    const acc = accounts[platform];
    if (acc) {
      if (acc.loggedIn) {
        el.append(h('span', { class: 'muted', text: '· Hesap bağlı ✓' }));
      } else if (platform === 'instagram') {
        el.append(
          h('span', { class: 'warn', text: 'Instagram çoğu içerik için giriş ister.' }),
          h('button', { type: 'button', text: 'Giriş yap', onclick: () => loginAccount(platform) })
        );
      }
    }
  }

  function refreshOptions() {
    const fmt = $('#formatSelect');
    const imgOpt = fmt.querySelector('option[value="image"]');
    const noImages = platform === 'youtube';
    imgOpt.disabled = noImages;
    imgOpt.textContent = noImages ? 'Görsel (YouTube\'da yok)' : 'Görsel';
    fmt.value = settings.format;
    $('#qualitySelect').classList.toggle('hidden', settings.format !== 'mp4');
  }

  function flashPlatforms() {
    const box = $('#platforms');
    box.classList.remove('needs-pick');
    void box.offsetWidth; // animasyonu yeniden başlat
    box.classList.add('needs-pick');
  }

  // ---------- Hesaplar ----------
  async function refreshAccounts() {
    try {
      accounts = await api.accountStatus();
    } catch {
      accounts = {};
    }
    renderAccounts();
    renderPlatformHint();
  }

  async function loginAccount(key) {
    for (const b of document.querySelectorAll('.account button')) b.disabled = true;
    try {
      accounts = await api.accountLogin(key);
    } finally {
      renderAccounts();
      renderPlatformHint();
    }
  }

  function renderAccounts() {
    const box = $('#accountList');
    box.textContent = '';
    for (const key of ACCOUNT_ORDER) {
      const a = accounts[key];
      if (!a) continue;
      const state = h('span', { class: 'state' + (a.loggedIn ? ' on' : ''), text: a.loggedIn ? 'Giriş yapıldı' : 'Giriş yapılmadı' });
      const btn = a.loggedIn
        ? h('button', {
            class: 'secondary',
            type: 'button',
            text: 'Çıkış yap',
            onclick: async () => {
              accounts = await api.accountLogout(key);
              renderAccounts();
              renderPlatformHint();
            }
          })
        : h('button', { class: 'secondary', type: 'button', text: 'Giriş yap', onclick: () => loginAccount(key) });
      const row = h('div', { class: 'account', 'data-platform': key }, h('span', { class: 'name' }, h('i'), LABEL[key]), state, h('span', { class: 'grow' }), btn);
      box.append(row);
    }
  }

  // ---------- İndirme akışı ----------
  async function start() {
    if (busy) return;
    if (!platform) {
      flashPlatforms();
      setHint('Önce yukarıdan platformu seç.', 'error');
      return;
    }
    const raw = $('#urlInput').value.trim();
    if (!raw) {
      setHint('Önce bir bağlantı yapıştır.', 'error');
      return;
    }
    const guess = guessPlatform(raw);
    if (guess && guess !== platform) {
      setHint(`Bu bağlantı ${LABEL[guess]} bağlantısı, ama ${LABEL[platform]} seçili. Yukarıdan ${LABEL[guess]}'ı seç.`, 'error');
      flashPlatforms();
      return;
    }
    setBusy(true);
    let res;
    try {
      res = await api.analyze({ url: raw, platform, format: settings.format });
    } finally {
      setBusy(false);
    }
    if (!res.ok) {
      setHint(res.error, 'error');
      return;
    }
    setHint('');
    const r = res.result;
    const common = { format: settings.format, quality: settings.quality };

    if (r.kind === 'playlist') {
      if (!(await askPlaylist(r))) {
        setHint('Liste indirilmedi.');
        return;
      }
      const pad = Math.max(2, String(r.count).length);
      await api.enqueue({
        batch: r.entries.map((e) => ({
          ...common,
          route: 'ytdlp',
          url: e.url,
          platform: r.platform,
          title: e.title,
          subdir: r.title,
          prefix: String(e.index).padStart(pad, '0')
        }))
      });
      setHint(`${r.count} video sıraya eklendi.`, 'ok');
    } else if (r.kind === 'gallery') {
      // Tek görsel varsa panel açmadan doğrudan indirilir.
      const sel = r.items.length === 1 ? [r.items[0].index] : await pickItems(r);
      if (!sel || !sel.length) {
        setHint('Hiçbir öğe seçilmedi.');
        return;
      }
      const chosen = r.items.filter((i) => sel.includes(i.index));
      await api.enqueue({
        ...common,
        route: 'gallery',
        url: r.url,
        platform: r.platform,
        title: r.title,
        selection: sel,
        thumbnail: (chosen[0] || {}).thumb || null
      });
      const allImages = chosen.every((i) => i.type === 'image');
      setHint(`${sel.length} ${allImages ? 'görsel' : 'öğe'} sıraya eklendi.`, 'ok');
    } else {
      await api.enqueue({
        ...common,
        route: r.route || 'ytdlp',
        url: r.url,
        platform: r.platform,
        title: r.title,
        thumbnail: r.thumbnail,
        galleryFallback: r.galleryFallback
      });
      if (settings.format === 'mp4' && r.maxHeight && settings.quality !== 'best' && Number(settings.quality) > r.maxHeight) {
        setHint(`Bu video en fazla ${r.maxHeight}p; o kalitede indirilecek.`, 'ok');
      } else {
        setHint('Sıraya eklendi.', 'ok');
      }
    }
    $('#urlInput').value = '';
    $('#urlInput').focus();
  }

  function askPlaylist(r) {
    return new Promise((resolve) => {
      $('#playlistText').textContent = `Bu bağlantı bir oynatma listesi: "${r.title}" (${r.count} video). Listenin tamamını indirmek istiyor musunuz?`;
      const modal = $('#playlistModal');
      modal.classList.remove('hidden');
      const done = (v) => {
        modal.classList.add('hidden');
        $('#playlistYes').onclick = null;
        $('#playlistNo').onclick = null;
        resolve(v);
      };
      $('#playlistYes').onclick = () => done(true);
      $('#playlistNo').onclick = () => done(false);
    });
  }

  function pickItems(r) {
    return new Promise((resolve) => {
      const selected = new Set(r.items.map((i) => i.index));
      const grid = $('#galleryGrid');
      grid.textContent = '';
      const cells = new Map();
      const refresh = () => {
        $('#galleryCount').textContent = `${selected.size} / ${r.items.length} seçili`;
        $('#galleryOk').textContent = `İndir (${selected.size})`;
        $('#galleryOk').disabled = selected.size === 0;
        for (const [idx, el] of cells) el.classList.toggle('sel', selected.has(idx));
      };
      for (const it of r.items) {
        const cell = h(
          'button',
          {
            class: 'g-item',
            type: 'button',
            'aria-label': `${it.index}. ${it.type === 'video' ? 'video' : 'görsel'}`,
            onclick: () => {
              if (selected.has(it.index)) selected.delete(it.index);
              else selected.add(it.index);
              refresh();
            }
          },
          it.thumb
            ? h('img', { src: it.thumb, referrerpolicy: 'no-referrer', loading: 'lazy', alt: '' })
            : h('div', { class: 'ph', text: it.type === 'video' ? 'Video' : 'Görsel' }),
          h('span', { class: 'num', text: String(it.index) }),
          h('span', { class: 'tick', text: '✓' }),
          it.type === 'video' ? h('span', { class: 'badge-v', text: 'Video' }) : null
        );
        cells.set(it.index, cell);
        grid.append(cell);
      }
      const t = r.title ? ` · ${r.title.slice(0, 40)}` : '';
      $('#galleryTitle').textContent = `${LABEL[r.platform] || ''}: hangilerini indirmek istiyorsun?${t}`;
      const modal = $('#galleryModal');
      modal.classList.remove('hidden');
      refresh();
      const close = (v) => {
        modal.classList.add('hidden');
        grid.textContent = '';
        resolve(v);
      };
      $('#galleryAll').onclick = () => {
        r.items.forEach((i) => selected.add(i.index));
        refresh();
      };
      $('#galleryNone').onclick = () => {
        selected.clear();
        refresh();
      };
      $('#galleryCancel').onclick = () => close(null);
      $('#galleryOk').onclick = () => close([...selected].sort((a, b) => a - b));
    });
  }

  // ---------- Liste ----------
  function statusText(j) {
    const from = FROM[j.platform] || FROM.other;
    switch (j.status) {
      case 'queued':
        return 'Sırada';
      case 'analyzing':
        return `${from} başlatılıyor…`;
      case 'downloading': {
        if (j.phase === 'updating') return 'İndirme motoru güncelleniyor, ardından yeniden denenecek…';
        if (j.phase === 'merging') return 'Video ve ses birleştiriliyor…';
        if (j.phase === 'finishing') return 'Dosyalar düzenleniyor…';
        const parts = [`${from} indiriliyor %${j.progress || 0}`];
        if (j.speed) parts.push(fmtSpeed(j.speed));
        if (j.eta != null && j.eta !== 0) parts.push('kalan ' + fmtEta(j.eta));
        return parts.join(' · ');
      }
      case 'converting':
        return (j.phase === 'encoding' ? 'Adobe/CapCut uyumu için H.264 + AAC\'ye dönüştürülüyor' : 'MP4 kabına alınıyor') + ` %${j.progress || 0}`;
      case 'canceled':
        return j.error || 'İptal edildi';
      case 'error':
        return j.error || 'Hata';
      default:
        return '';
    }
  }

  function formatLabel(j) {
    if (j.route === 'gallery') return 'Görsel';
    if (j.format === 'mp4') return 'MP4 · ' + (QUALITY[j.quality] || j.quality);
    return j.format.toUpperCase();
  }

  function setMeta(el, parts) {
    el.textContent = '';
    parts.filter(Boolean).forEach((p, i) => {
      if (i > 0) el.append(document.createTextNode(' · '));
      if (typeof p === 'string') el.append(document.createTextNode(p));
      else el.append(h('span', { class: p.cls || '', text: p.t }));
    });
  }

  function renderJob(j) {
    let row = rows.get(j.id);
    if (!row) {
      const built = buildRow(j);
      built.el._refs = built;
      rows.set(j.id, built.el);
      $('#jobList').prepend(built.el);
    }
    const refs = rows.get(j.id)._refs;
    refs.el.className = 'job ' + j.status;
    refs.el.dataset.platform = j.platform;
    refs.badge.textContent = LABEL[j.platform] || 'Web';
    refs.title.textContent = j.title || j.url;
    refs.title.title = j.title || j.url;

    const isErr = j.status === 'error';
    refs.meta.className = 'job-meta' + (isErr ? ' error' : '');
    if (j.status === 'done') {
      const count = j.route === 'gallery' && j.itemCount ? `${j.itemCount} dosya` : null;
      setMeta(refs.meta, [
        { t: 'Tamamlandı', cls: 'good' },
        j.route === 'gallery' ? count : j.format === 'mp4' ? 'MP4' : j.format.toUpperCase(),
        j.info,
        j.editorReady === true ? { t: 'Adobe/CapCut uyumlu ✓', cls: 'good' } : null,
        j.editorReady === false ? { t: 'Düzenleme uyumu doğrulanamadı', cls: 'warn' } : null,
        j.note ? { t: j.note, cls: 'warn' } : null
      ]);
    } else if (isErr) {
      setMeta(refs.meta, [formatLabel(j), statusText(j)]);
    } else {
      setMeta(refs.meta, [formatLabel(j), statusText(j)]);
    }

    const indet = ['analyzing', 'converting'].includes(j.status) && !j.progress;
    refs.bar.className = 'bar' + (indet || (j.status === 'downloading' && j.phase === 'updating') ? ' indeterminate' : '');
    refs.fill.style.width = (j.status === 'done' ? 100 : j.progress || 0) + '%';

    refs.actions.textContent = '';
    const btn = (label, fn) => refs.actions.append(h('button', { type: 'button', text: label, onclick: fn }));
    if (j.status === 'done') {
      btn('Aç', () => api.openJob(j.id));
      btn('Klasörde göster', () => api.revealJob(j.id));
      btn('Kaldır', () => api.removeJob(j.id));
    } else if (j.status === 'error' || j.status === 'canceled') {
      btn('Tekrar dene', () => api.retryJob(j.id));
      btn('Kaldır', () => api.removeJob(j.id));
    } else {
      btn('İptal', () => api.cancelJob(j.id));
    }
    updateCount();
  }

  function buildRow(j) {
    const thumb = h('div', { class: 'thumb' });
    const initial = (LABEL[j.platform] || 'W')[0];
    if (j.thumbnail) {
      const img = h('img', { src: j.thumbnail, referrerpolicy: 'no-referrer', alt: '' });
      img.addEventListener('error', () => {
        img.remove();
        thumb.textContent = initial;
      });
      thumb.append(img);
    } else {
      thumb.textContent = initial;
    }
    const badge = h('span', { class: 'badge' });
    const title = h('span', { class: 'job-title' });
    const meta = h('div', { class: 'job-meta' });
    const fill = h('i');
    const bar = h('div', { class: 'bar' }, fill);
    const actions = h('div', { class: 'job-actions' });
    const el = h('div', { class: 'job' }, thumb, h('div', { class: 'job-main' }, h('div', { class: 'job-top' }, badge, title), meta, bar), actions);
    return { el, badge, title, meta, bar, fill, actions };
  }

  function renderAll() {
    $('#jobList').textContent = '';
    rows.clear();
    const sorted = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const j of sorted) renderJob(j);
    updateCount();
  }

  function updateCount() {
    const all = [...jobs.values()];
    const active = all.filter((j) => !TERMINAL.includes(j.status)).length;
    $('#jobCount').textContent = active ? `${all.length} işlem · ${active} sürüyor` : `${all.length} işlem`;
    $('#emptyState').classList.toggle('hidden', all.length > 0);
  }

  // ---------- Motor ve güncelleme durumu ----------
  function renderEngine(s) {
    if (!s) return;
    const label = $('#engineLabel');
    if (s.phase === 'downloading') label.textContent = `${s.message}… %${s.percent || 0}`;
    else if (s.phase === 'checking') label.textContent = 'Motorlar denetleniyor…';
    else if (s.phase === 'error') label.textContent = 'Motor hatası: ' + (s.message || '').slice(0, 80);
    else label.textContent = s.ytdlp ? `yt-dlp ${s.ytdlp}` : 'Motorlar hazırlanıyor…';

    const box = $('#engineInfo');
    box.textContent = '';
    const line = (k, v, cls) => box.append(h('span', { text: k }), h('span', { class: cls || '', text: v }));
    line('yt-dlp', s.ytdlp ? `${s.ytdlp}${s.ytdlpChannel === 'nightly' ? ' (nightly)' : ''}` : 'kurulu değil', s.ytdlp ? '' : 'bad');
    line('gallery-dl', s.gallerydl || 'kurulu değil', s.gallerydl ? '' : 'bad');
    line('deno', s.deno || 'kurulu değil', s.deno ? '' : 'bad');
    const ff = {
      ready: ['Hazır (H.264 + AAC ✓)', 'good'],
      checking: ['Denetleniyor…', ''],
      broken: ['H.264/AAC kodlayıcı eksik ya da çalışmıyor', 'bad'],
      missing: ['Bulunamadı', 'bad']
    }[s.ffmpeg] || ['-', ''];
    line('ffmpeg', ff[0], ff[1]);
    line('Son denetim', s.lastCheck ? new Date(s.lastCheck).toLocaleString('tr-TR') : 'henüz yok');

    const msg = $('#engineMsg');
    msg.textContent = s.phase === 'error' ? s.message : s.phase === 'idle' ? s.message || '' : s.message || 'Çalışıyor…';
    msg.className = 'hint grow' + (s.phase === 'error' || (s.phase === 'idle' && s.message) ? ' error' : '');
    $('#engineUpdateBtn').disabled = s.phase === 'downloading' || s.phase === 'checking';
  }

  function renderAppUpdate(u) {
    if (!u) return;
    const b = $('#updateBanner');
    const msg = $('#appUpdateMsg');
    b.classList.add('hidden');
    b.disabled = false;
    msg.className = 'hint grow';
    if (u.state === 'downloading') {
      b.classList.remove('hidden');
      b.disabled = true;
      b.textContent = `Güncelleme indiriliyor %${u.percent || 0}`;
      msg.textContent = `v${u.version || ''} indiriliyor %${u.percent || 0}`;
    } else if (u.state === 'ready') {
      b.classList.remove('hidden');
      b.textContent = `v${u.version} hazır · Yeniden başlat`;
      msg.textContent = `v${u.version} kuruluma hazır.`;
      msg.className = 'hint grow ok';
    } else if (u.state === 'none') {
      msg.textContent = 'Uygulama güncel.';
    } else if (u.state === 'checking') {
      msg.textContent = 'Denetleniyor…';
    } else if (u.state === 'error') {
      msg.textContent = 'Denetlenemedi: ' + (u.message || '');
      msg.className = 'hint grow error';
    } else if (u.state === 'unconfigured') {
      msg.textContent = 'Güncelleme deposu henüz ayarlanmadı (isteğe bağlı). Motorlar yine otomatik güncellenir.';
    } else if (u.state === 'dev') {
      msg.textContent = 'Geliştirme modunda güncelleme kapalı.';
    } else {
      msg.textContent = '';
    }
  }

  // ---------- Olaylar ----------
  for (const b of document.querySelectorAll('.plat')) b.addEventListener('click', () => selectPlatform(b.dataset.platform));

  $('#downloadBtn').addEventListener('click', start);
  $('#urlInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') start();
  });
  $('#urlInput').addEventListener('input', () => {
    // Bağlantı başka bir platforma aitse hemen haber ver (engellemez, yalnızca ipucu).
    const g = guessPlatform($('#urlInput').value);
    if (g && platform && g !== platform) setHint(`Bu bağlantı ${LABEL[g]} bağlantısı görünüyor. Yukarıdan ${LABEL[g]}'ı seç.`, 'error');
    else if (g && !platform) setHint(`Bu bağlantı ${LABEL[g]} bağlantısı görünüyor. Yukarıdan ${LABEL[g]}'ı seç.`);
    else setHint('');
  });
  $('#pasteBtn').addEventListener('click', async () => {
    const t = await api.readClipboard();
    if (t) {
      $('#urlInput').value = t.trim();
      $('#urlInput').dispatchEvent(new Event('input'));
      $('#urlInput').focus();
    }
  });
  $('#formatSelect').addEventListener('change', (e) => save({ format: e.target.value }));
  $('#qualitySelect').addEventListener('change', (e) => save({ quality: e.target.value }));

  $('#pauseBtn').addEventListener('click', async () => {
    paused = await api.pauseQueue(!paused);
    $('#pauseBtn').textContent = paused ? 'Kuyruğa devam et' : 'Kuyruğu duraklat';
  });
  $('#clearBtn').addEventListener('click', () => api.clearFinished());
  $('#openFolder').addEventListener('click', () => api.openDownloadFolder());

  $('#openSettings').addEventListener('click', () => {
    $('#settingsModal').classList.remove('hidden');
    refreshAccounts();
  });
  $('#closeSettings').addEventListener('click', () => $('#settingsModal').classList.add('hidden'));
  $('#settingsModal').addEventListener('mousedown', (e) => {
    if (e.target.id === 'settingsModal') $('#settingsModal').classList.add('hidden');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('#settingsModal').classList.add('hidden');
  });

  $('#setDirBtn').addEventListener('click', async () => {
    const dir = await api.chooseFolder();
    if (dir) save({ downloadDir: dir });
  });
  $('#setByPlatform').addEventListener('change', (e) => save({ organizeByPlatform: e.target.checked }));
  $('#setConcurrent').addEventListener('change', (e) => save({ concurrent: Number(e.target.value) }));
  $('#setCompat').addEventListener('change', (e) => save({ editorCompat: e.target.checked }));
  $('#setCookies').addEventListener('change', (e) => save({ cookiesBrowser: e.target.value }));
  $('#setCookieFileBtn').addEventListener('click', async () => {
    const f = await api.chooseCookieFile();
    if (f) save({ cookiesFile: f });
  });
  $('#setCookieFileClear').addEventListener('click', () => save({ cookiesFile: '' }));
  $('#setChannel').addEventListener('change', (e) => save({ engineChannel: e.target.value }));
  $('#setAutoEngine').addEventListener('change', (e) => save({ autoUpdateEngine: e.target.checked }));
  $('#setSolver').addEventListener('change', (e) => save({ youtubeRemoteSolver: e.target.checked }));
  $('#setAutoApp').addEventListener('change', (e) => save({ autoUpdateApp: e.target.checked }));

  $('#engineUpdateBtn').addEventListener('click', async () => {
    const r = await api.updateEngine();
    if (r && !r.ok) {
      const msg = $('#engineMsg');
      msg.textContent = r.error;
      msg.className = 'hint grow error';
    }
  });
  $('#appUpdateBtn').addEventListener('click', async () => renderAppUpdate(await api.checkAppUpdate()));
  $('#updateBanner').addEventListener('click', () => {
    const active = [...jobs.values()].some((j) => !TERMINAL.includes(j.status));
    if (active && !confirm('İndirmeler sürüyor. Yeniden başlatırsan yarım kalacaklar. Devam edilsin mi?')) return;
    api.installAppUpdate();
  });

  $('#copyDiagBtn').addEventListener('click', async () => {
    await api.copyDiagnostics();
    const m = $('#diagMsg');
    m.textContent = 'Panoya kopyalandı.';
    m.className = 'hint grow ok';
  });
  $('#openLogsBtn').addEventListener('click', () => api.openLogs());

  init();
})();
