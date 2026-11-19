'use strict';
(() => {
  const api = window.berloader;
  const $ = (s) => document.querySelector(s);

  const LABEL = { youtube: 'YouTube', instagram: 'Instagram', tiktok: 'TikTok', x: 'X', pinterest: 'Pinterest', other: 'Web' };
  // "…'dan/den indiriliyor" (Türkçe ünlü uyumuna göre)
  const FROM = { youtube: "YouTube'dan", instagram: "Instagram'dan", tiktok: "TikTok'tan", x: "X'ten", pinterest: "Pinterest'ten", other: 'Web üzerinden' };
  const PLAT_INFO = {
    youtube: 'Video, Shorts ve oynatma listeleri. "Görsel" seçersen kapak resmini indirir.',
    instagram: 'Reels, video ve fotoğraf gönderileri. Çoklu gönderide istediklerini seçersin.',
    tiktok: 'Video ve fotoğraf gönderileri. Çoklu gönderide istediklerini seçersin.',
    x: 'Video ve görselli gönderiler. Çoklu görselde istediklerini seçersin.',
    pinterest: 'Pin görselleri ve videoları.'
  };
  // Kalite basamakları: değer = görüntünün kısa kenarı (yt-dlp "res").
  const TIERS = [4320, 2160, 1440, 1080, 720, 480, 360];
  const TIER_NAME = { 4320: '8K', 2160: '4K', 1440: '2K', 1080: '1080p', 720: '720p', 480: '480p', 360: '360p' };
  const tierLabel = (q) => (q >= 1440 ? `${TIER_NAME[q]} · ${q}p` : TIER_NAME[q] || `${q}p`);
  const TERMINAL = ['done', 'error', 'canceled'];
  const ACCOUNT_ORDER = ['instagram', 'x', 'tiktok', 'pinterest'];

  let settings = {};
  let accounts = {};
  let platform = null; // zorunlu: kullanıcı seçmeden indirme yapılmaz
  let cutMode = false; // "Keserek indir": yalnızca sıradaki tek video için
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

  const SVG = 'http://www.w3.org/2000/svg';
  function icon(name) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'ic');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
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
  function fmtDuration(sec) {
    const t = Math.round(Number(sec) || 0);
    const hh = Math.floor(t / 3600);
    const mm = Math.floor((t % 3600) / 60);
    const ss = t % 60;
    return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
  }
  const clipText = (sec) => `${window.BerTrim.shortTime(sec.start || 0)}–${sec.end == null ? 'son' : window.BerTrim.shortTime(sec.end)}`;

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
  const looksLikeUrl = (t) => /^(https?:\/\/)?[^\s/]+\.[a-z]{2,}\/\S+/i.test(String(t).trim());

  function setHint(text, kind) {
    const el = $('#hint');
    el.textContent = text || '';
    el.className = 'hint' + (kind ? ' ' + kind : '');
  }

  function setBusy(on, text) {
    busy = on;
    $('#downloadBtn').disabled = on;
    $('#urlInput').disabled = on;
    $('#downloadBtn').querySelector('span').textContent = on ? 'Bekle…' : 'İndir';
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
    $('#dirLabel').textContent = settings.downloadDir;
    $('#setDir').textContent = settings.downloadDir;
    $('#setDir').title = settings.downloadDir;
    $('#setByPlatform').checked = !!settings.organizeByPlatform;
    $('#setConcurrent').value = String(settings.concurrent);
    $('#setCompat').checked = !!settings.editorCompat;
    $('#setAutoClear').checked = !!settings.autoClearDone;
    $('#setCookies').value = settings.cookiesBrowser;
    $('#setCookieFile').textContent = settings.cookiesFile || 'Seçilmedi';
    $('#setCookieFile').title = settings.cookiesFile || '';
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
    const changed = p !== platform;
    platform = p;
    for (const b of document.querySelectorAll('.plat')) b.setAttribute('aria-pressed', String(b.dataset.platform === p));
    $('#platforms').classList.remove('needs-pick');
    if (changed) setCut(false); // başka platforma geçince kesme modu kapanır
    setHint('');
    renderPlatformHint();
    refreshOptions();
    scheduleProbe(0);
    $('#urlInput').focus();
  }

  function renderPlatformHint() {
    const el = $('#platformHint');
    el.textContent = '';
    if (!platform) {
      el.append(h('span', { text: 'Önce indirme yapacağın platformu seç.' }));
      return;
    }
    el.append(h('span', { text: PLAT_INFO[platform] }));
    const acc = accounts[platform];
    if (acc) {
      if (acc.loggedIn) {
        el.append(h('span', { class: 'ok', text: 'Hesap bağlı' }));
      } else if (platform === 'instagram') {
        el.append(
          h('span', { class: 'warn', text: 'Instagram çoğu içerik için giriş ister.' }),
          h('button', { class: 'btn', type: 'button', text: 'Giriş yap', onclick: () => loginAccount(platform) })
        );
      }
    }
  }

  // Biçime ve platforma göre seçenekleri gösterir/gizler.
  function refreshOptions() {
    const fmt = $('#formatSelect');
    const imgOpt = fmt.querySelector('option[value="image"]');
    imgOpt.textContent = platform === 'youtube' ? 'Görsel (kapak resmi)' : 'Görsel';
    fmt.value = settings.format;
    const canCut = platform === 'youtube' && settings.format !== 'image';
    $('#cutToggle').classList.toggle('hidden', !canCut);
    if (!canCut && cutMode) setCut(false);
    renderQuality();
  }

  function setCut(on) {
    cutMode = !!on;
    $('#cutToggle').setAttribute('aria-pressed', String(cutMode));
    if (cutMode) setHint("İndir'e basınca önizleme açılır; giriş ve çıkış noktasını seçersin. Yalnızca bu video için geçerli.");
    else if ($('#hint').textContent.startsWith("İndir'e basınca önizleme")) setHint('');
  }

  function flashPlatforms() {
    const box = $('#platforms');
    box.classList.remove('needs-pick');
    void box.offsetWidth; // animasyonu yeniden başlat
    box.classList.add('needs-pick');
  }

  // ---------- Bağlantı ön çözümleme ----------
  // Bağlantı yapıştırılınca arka planda çözümlenir: başlık, süre ve gerçekten var olan
  // kalite seçenekleri gösterilir. İndir'e basınca aynı sonuç yeniden kullanılır.
  const probes = new Map(); // anahtar -> { promise, res, at }
  let probeTimer = 0;
  let current = null; // { key, res } ekrandaki bağlantının sonucu

  const formatKind = (f) => (f === 'image' ? 'image' : f === 'mp4' ? 'video' : 'audio');
  const probeKey = (url, p, f) => `${p}|${formatKind(f)}|${url}`;

  function analyzeCached(url, p, f) {
    const key = probeKey(url, p, f);
    const hit = probes.get(key);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000 && !(hit.res && !hit.res.ok)) return hit.promise;
    const entry = { at: Date.now(), res: null, promise: null };
    entry.promise = api.analyze({ url, platform: p, format: f }).then(
      (res) => (entry.res = res),
      (e) => (entry.res = { ok: false, error: e.message || 'Bağlantı çözümlenemedi.' })
    );
    probes.set(key, entry);
    if (probes.size > 30) probes.delete(probes.keys().next().value);
    return entry.promise;
  }

  function scheduleProbe(delay = 450) {
    clearTimeout(probeTimer);
    probeTimer = setTimeout(runProbe, delay);
  }

  async function runProbe() {
    const url = $('#urlInput').value.trim();
    const g = guessPlatform(url);
    if (!platform || !url || !looksLikeUrl(url) || (g && g !== platform)) {
      current = null;
      renderProbe(null);
      renderQuality();
      return;
    }
    const key = probeKey(url, platform, settings.format);
    if (current && current.key === key && current.res) return;
    current = { key, res: null };
    renderProbe({ loading: true });
    renderQuality();
    const res = await analyzeCached(url, platform, settings.format);
    if (!current || current.key !== key) return; // bu arada bağlantı değişti
    current.res = res;
    renderProbe(res);
    renderQuality();
  }

  function renderProbe(state) {
    const box = $('#probeLine');
    box.textContent = '';
    box.className = 'probe';
    if (!state) {
      box.classList.add('hidden');
      return;
    }
    if (state.loading) {
      box.classList.add('loading');
      box.append(h('span', { class: 'spin' }), h('span', { class: 'probe-title', text: 'Bağlantıya bakılıyor…' }));
      return;
    }
    if (!state.ok) {
      box.classList.add('hidden');
      return;
    }
    const r = state.result;
    const meta = [];
    if (r.kind === 'playlist') meta.push(`Oynatma listesi · ${r.count} video`);
    else if (r.kind === 'gallery') meta.push(`${r.items.length} öğe`);
    else {
      if (r.duration) meta.push(fmtDuration(r.duration));
      if (settings.format === 'mp4' && r.qualities && r.qualities.length) meta.push('en fazla ' + TIER_NAME[r.qualities[0]]);
    }
    box.append(h('span', { class: 'probe-title', text: r.title || '' }), meta.length ? h('span', { class: 'probe-meta', text: meta.join(' · ') }) : null);
  }

  // Kalite listesi yalnızca videonun gerçekten sunduğu seçeneklerden oluşur.
  function renderQuality() {
    const sel = $('#qualitySelect');
    const show = settings.format === 'mp4';
    sel.classList.toggle('hidden', !show);
    if (!show) return;
    sel.textContent = '';
    const r = current && current.res && current.res.ok ? current.res.result : null;
    const loading = current && !current.res;
    if (loading) {
      sel.append(h('option', { value: 'best', text: 'Kaliteler alınıyor…' }));
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    let tiers = [];
    if (r && r.kind === 'video' && Array.isArray(r.qualities)) tiers = r.qualities;
    else if (r && r.kind === 'playlist') tiers = [1080, 720, 480]; // liste: her videonun en iyisi, isteğe bağlı üst sınır
    if (r && r.kind === 'video' && tiers.length) {
      sel.append(h('option', { value: 'best', text: `En yüksek · ${tierLabel(tiers[0])}` }));
      for (const q of tiers.slice(1)) sel.append(h('option', { value: String(q), text: tierLabel(q) }));
    } else {
      sel.append(h('option', { value: 'best', text: 'En yüksek kalite' }));
      for (const q of tiers) sel.append(h('option', { value: String(q), text: `En çok ${tierLabel(q)}` }));
    }
    sel.disabled = sel.options.length < 2;
    const want = String(settings.quality);
    sel.value = [...sel.options].some((o) => o.value === want) ? want : 'best';
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
            class: 'btn quiet',
            type: 'button',
            text: 'Çıkış yap',
            onclick: async () => {
              accounts = await api.accountLogout(key);
              renderAccounts();
              renderPlatformHint();
            }
          })
        : h('button', { class: 'btn secondary', type: 'button', text: 'Giriş yap', onclick: () => loginAccount(key) });
      box.append(h('div', { class: 'account', 'data-platform': key }, h('span', { class: 'name' }, h('i'), LABEL[key]), state, h('span', { class: 'grow' }), btn));
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
    const wantCut = cutMode && !$('#cutToggle').classList.contains('hidden');
    const format = settings.format;
    const quality = $('#qualitySelect').disabled ? 'best' : $('#qualitySelect').value || 'best';
    setBusy(true);
    let res;
    try {
      res = await analyzeCached(raw, platform, format);
    } finally {
      setBusy(false);
    }
    if (!res.ok) {
      setHint(res.error, 'error');
      return;
    }
    setHint('');
    const r = res.result;
    const common = { format, quality };
    if (wantCut && r.kind === 'playlist') {
      setHint('Keserek indirme yalnızca tek video için çalışır. "Keserek indir"i kapat ya da tek bir video bağlantısı yapıştır.', 'error');
      return;
    }
    if (wantCut && r.kind === 'video') {
      if (!r.duration) {
        setHint('Bu videonun süresi öğrenilemedi (canlı yayın olabilir); bölüm seçilemiyor.', 'error');
        return;
      }
      const picked = await window.BerTrim.open({ title: r.title, url: r.url, videoId: r.videoId, duration: r.duration, fps: r.fps });
      if (!picked) {
        setHint('Bölüm seçilmedi; indirme başlatılmadı.');
        return;
      }
      common.section = picked;
    }

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
          prefix: String(e.index).padStart(pad, '0'),
          duration: e.duration || null
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
        galleryFallback: r.galleryFallback,
        duration: r.duration || null,
        fps: r.fps || null
      });
      setHint(common.section ? `Bölüm sıraya eklendi (${clipText(common.section)}).` : 'Sıraya eklendi.', 'ok');
    }
    // Sıradaki bağlantı için temiz başlangıç: kesme modu tek seferliktir.
    $('#urlInput').value = '';
    current = null;
    renderProbe(null);
    renderQuality();
    if (cutMode) {
      cutMode = false;
      $('#cutToggle').setAttribute('aria-pressed', 'false');
    }
    $('#urlInput').focus();
  }

  function askPlaylist(r) {
    return new Promise((resolve) => {
      $('#playlistText').textContent = `"${r.title}" bir oynatma listesi (${r.count} video). Listenin tamamı sıraya eklensin mi?`;
      const modal = $('#playlistModal');
      modal.classList.remove('hidden');
      $('#playlistYes').focus();
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
          h('span', { class: 'tick' }, icon('check')),
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
        const parts = [j.section && !j.progress ? 'Seçilen bölüm indiriliyor…' : `%${j.progress || 0}`];
        if (j.speed) parts.push(fmtSpeed(j.speed));
        if (j.eta != null && j.eta !== 0) parts.push('kalan ' + fmtEta(j.eta));
        return parts.join(' · ');
      }
      case 'converting':
        return (j.phase === 'encoding' ? 'H.264 + AAC olarak kodlanıyor' : 'MP4 kabına alınıyor') + ` %${j.progress || 0}`;
      case 'canceled':
        return j.error || 'İptal edildi';
      case 'error':
        return j.error || 'Hata';
      default:
        return '';
    }
  }

  function qualityText(q) {
    if (!q || q === 'best') return 'En yüksek';
    return TIER_NAME[q] ? TIER_NAME[q] : `${q}p`;
  }

  function formatParts(j) {
    if (j.route === 'gallery') return ['Görsel'];
    if (j.route === 'thumb') return ['Kapak görseli'];
    const parts = [j.format === 'mp4' ? 'MP4 · ' + qualityText(j.quality) : j.format.toUpperCase()];
    if (j.section) parts.push({ t: clipText(j.section), cls: 'clip' });
    return parts;
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
    setThumb(refs.thumb, j);
    refs.badge.textContent = LABEL[j.platform] || 'Web';
    refs.title.textContent = j.title || j.url;
    refs.title.title = j.title || j.url;

    const isErr = j.status === 'error';
    refs.meta.className = 'job-meta' + (isErr ? ' error' : '');
    if (j.status === 'done') {
      const count = j.route === 'gallery' && j.itemCount ? `${j.itemCount} dosya` : null;
      setMeta(refs.meta, [
        { t: 'Tamamlandı', cls: 'good' },
        j.route === 'gallery' ? count : j.route === 'thumb' ? 'Kapak görseli' : j.format === 'mp4' ? 'MP4' : j.format.toUpperCase(),
        j.section ? { t: clipText(j.section), cls: 'clip' } : null,
        j.info,
        j.editorReady === false ? { t: 'Kurgu uyumu doğrulanamadı', cls: 'warn' } : null,
        j.note ? { t: j.note, cls: 'warn' } : null
      ]);
    } else {
      setMeta(refs.meta, [...formatParts(j), statusText(j)]);
    }

    const indet = (['analyzing', 'converting'].includes(j.status) && !j.progress) || (j.status === 'downloading' && j.phase === 'updating');
    refs.bar.className = 'bar' + (indet ? ' indeterminate' : '');
    refs.fill.style.width = (j.progress || 0) + '%';

    // Düğmeler yalnızca durum değişince yeniden kurulur; her ilerleme güncellemesinde
    // yenilenirse tıklamalar kaçabilir.
    const actionKey = j.status + (canReclip(j) ? ':r' : '');
    if (refs.actions.dataset.key !== actionKey) {
      refs.actions.dataset.key = actionKey;
      buildActions(refs.actions, j);
    }
    updateCount();
  }

  function iconBtn(name, label, fn) {
    return h('button', { class: 'btn icon-btn', type: 'button', title: label, 'aria-label': label, onclick: fn }, icon(name));
  }

  function copyLinkBtn(j) {
    const b = iconBtn('link', 'Bağlantıyı kopyala', async () => {
      await api.writeClipboard(j.url);
      b.classList.add('done-flash');
      b.title = 'Kopyalandı';
      b.querySelector('use').setAttribute('href', '#i-check');
      setTimeout(() => {
        b.classList.remove('done-flash');
        b.title = 'Bağlantıyı kopyala';
        b.querySelector('use').setAttribute('href', '#i-link');
      }, 1400);
    });
    return b;
  }

  function buildActions(box, j) {
    box.textContent = '';
    const id = j.id;
    let items;
    if (j.status === 'done') {
      items = [
        h('button', { class: 'btn text', type: 'button', text: 'Aç', onclick: () => api.openJob(id) }),
        iconBtn('folder', 'Klasörde göster', () => api.revealJob(id)),
        canReclip(j) ? iconBtn('scissors', 'Bu videodan bir bölüm kes', () => reclip(jobs.get(id) || j)) : null,
        copyLinkBtn(j),
        iconBtn('x', 'Listeden kaldır', () => api.removeJob(id))
      ];
    } else if (j.status === 'error' || j.status === 'canceled') {
      items = [
        h('button', { class: 'btn text', type: 'button', onclick: () => api.retryJob(id) }, icon('retry'), h('span', { text: 'Tekrar dene' })),
        copyLinkBtn(j),
        iconBtn('x', 'Listeden kaldır', () => api.removeJob(id))
      ];
    } else {
      items = [copyLinkBtn(j), iconBtn('x', 'İptal et', () => api.cancelJob(id))];
    }
    box.append(...items.filter(Boolean));
  }

  // Biten tek YouTube videosu/sesi için aynı videodan yeni bir bölüm indirilebilir.
  function canReclip(j) {
    return j.platform === 'youtube' && j.route === 'ytdlp' && j.duration > 1 && ['mp4', 'mp3', 'm4a', 'wav'].includes(j.format);
  }

  async function reclip(j) {
    const id = (/[?&]v=([\w-]{11})/.exec(j.url) || /youtu\.be\/([\w-]{11})/.exec(j.url) || /shorts\/([\w-]{11})/.exec(j.url) || [])[1] || null;
    // Bölüm seçmeden indirilmiş bir videoda ekran tüm videoyla açılır.
    const picked = await window.BerTrim.open({ title: j.title, url: j.url, videoId: id, duration: j.duration, fps: j.fps, section: j.section || null });
    if (!picked) return;
    await api.enqueue({
      format: j.format,
      quality: j.quality,
      route: 'ytdlp',
      url: j.url,
      platform: j.platform,
      title: j.title,
      thumbnail: j.thumbnail,
      duration: j.duration,
      fps: j.fps || null,
      section: picked
    });
    setHint(`Yeni bölüm sıraya eklendi (${clipText(picked)}).`, 'ok');
  }

  // Kapak küçük resmi; adres açılmazsa platformun baş harfi gösterilir.
  function setThumb(thumb, j) {
    if (thumb.dataset.src === (j.thumbnail || '')) return;
    thumb.dataset.src = j.thumbnail || '';
    thumb.textContent = '';
    const initial = (LABEL[j.platform] || 'W')[0];
    if (!j.thumbnail) {
      thumb.textContent = initial;
      return;
    }
    const img = h('img', { src: j.thumbnail, referrerpolicy: 'no-referrer', alt: '' });
    img.addEventListener('error', () => {
      img.remove();
      thumb.textContent = initial;
    });
    thumb.append(img);
  }

  function buildRow(j) {
    const thumb = h('div', { class: 'thumb' });
    setThumb(thumb, j);
    const badge = h('span', { class: 'badge' });
    const title = h('span', { class: 'job-title' });
    const meta = h('div', { class: 'job-meta' });
    const fill = h('i');
    const bar = h('div', { class: 'bar' }, fill);
    const actions = h('div', { class: 'job-actions' });
    const el = h('div', { class: 'job' }, thumb, h('div', { class: 'job-main' }, h('div', { class: 'job-top' }, badge, title), meta, bar), actions);
    return { el, thumb, badge, title, meta, bar, fill, actions };
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
    $('#jobCount').textContent = all.length ? (active ? `${all.length} · ${active} sürüyor` : String(all.length)) : '';
    $('#emptyState').classList.toggle('hidden', all.length > 0);
  }

  // ---------- Motor ve güncelleme durumu ----------
  function renderEngine(s) {
    if (!s) return;
    // Ana ekranda yalnızca bir şey olurken görünür; sürüm bilgisi Ayarlar > Gelişmiş'te.
    const chip = $('#engineChip');
    chip.classList.remove('error');
    if (s.phase === 'downloading') {
      chip.textContent = `${s.message || 'Motorlar indiriliyor'} %${s.percent || 0}`;
      chip.classList.remove('hidden');
    } else if (s.phase === 'error') {
      chip.textContent = 'İndirme motoru hatası · Ayarlar > Gelişmiş';
      chip.classList.add('error');
      chip.classList.remove('hidden');
    } else if (!s.ytdlp) {
      chip.textContent = 'İndirme motorları hazırlanıyor…';
      chip.classList.remove('hidden');
    } else {
      chip.classList.add('hidden');
    }

    const box = $('#engineInfo');
    box.textContent = '';
    const line = (k, v, cls) => box.append(h('span', { text: k }), h('span', { class: cls || '', text: v }));
    line('yt-dlp', s.ytdlp ? `${s.ytdlp}${s.ytdlpChannel === 'nightly' ? ' (nightly)' : ''}` : 'kurulu değil', s.ytdlp ? '' : 'bad');
    line('gallery-dl', s.gallerydl || 'kurulu değil', s.gallerydl ? '' : 'bad');
    line('deno', s.deno || 'kurulu değil', s.deno ? '' : 'bad');
    const ff = {
      ready: ['Hazır (H.264 + AAC)', 'good'],
      checking: ['Denetleniyor…', ''],
      broken: ['H.264/AAC kodlayıcı eksik ya da çalışmıyor', 'bad'],
      missing: ['Bulunamadı', 'bad']
    }[s.ffmpeg] || ['-', ''];
    line('ffmpeg', ff[0], ff[1]);
    line('Son denetim', s.lastCheck ? new Date(s.lastCheck).toLocaleString('tr-TR') : 'henüz yok');

    const msg = $('#engineMsg');
    msg.textContent = s.phase === 'error' ? s.message : s.phase === 'idle' ? s.message || '' : s.message || 'Çalışıyor…';
    msg.className = 'hint' + (s.phase === 'error' || (s.phase === 'idle' && s.message) ? ' error' : '');
    $('#engineUpdateBtn').disabled = s.phase === 'downloading' || s.phase === 'checking';
  }

  function renderAppUpdate(u) {
    if (!u) return;
    const b = $('#updateBanner');
    const msg = $('#appUpdateMsg');
    b.classList.add('hidden');
    b.disabled = false;
    msg.className = 'hint';
    if (u.state === 'downloading') {
      b.classList.remove('hidden');
      b.disabled = true;
      b.textContent = `Güncelleme indiriliyor %${u.percent || 0}`;
      msg.textContent = `v${u.version || ''} indiriliyor %${u.percent || 0}`;
    } else if (u.state === 'ready') {
      b.classList.remove('hidden');
      b.textContent = `v${u.version} hazır · Yeniden başlat`;
      msg.textContent = `v${u.version} kuruluma hazır.`;
      msg.className = 'hint ok';
    } else if (u.state === 'none') {
      msg.textContent = 'Uygulama güncel.';
    } else if (u.state === 'checking') {
      msg.textContent = 'Denetleniyor…';
    } else if (u.state === 'error') {
      msg.textContent = 'Denetlenemedi: ' + (u.message || '');
      msg.className = 'hint error';
    } else if (u.state === 'unconfigured') {
      msg.textContent = 'Güncelleme deposu bulunamadı; uygulama güncellemesi kapalı.';
    } else if (u.state === 'dev') {
      msg.textContent = 'Geliştirme modunda güncelleme kapalı.';
    } else {
      msg.textContent = '';
    }
  }

  // ---------- Ayarlar ekranı ----------
  function showSettings(on) {
    $('#settingsView').classList.toggle('hidden', !on);
    $('#mainView').classList.toggle('hidden', on);
    $('#openSettings').classList.toggle('hidden', on);
    if (on) {
      refreshAccounts();
      const sel = document.querySelector('.set-tab[aria-selected="true"]');
      if (sel) sel.focus();
    } else {
      $('#openSettings').focus();
    }
  }
  function selectTab(name) {
    for (const t of document.querySelectorAll('.set-tab')) t.setAttribute('aria-selected', String(t.dataset.tab === name));
    for (const p of document.querySelectorAll('.set-panel')) p.classList.toggle('hidden', p.dataset.panel !== name);
    $('.set-body').scrollTop = 0;
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
    else if ($('#hint').classList.contains('error') || $('#hint').classList.contains('ok')) setHint('');
    scheduleProbe();
  });
  $('#pasteBtn').addEventListener('click', async () => {
    const t = await api.readClipboard();
    if (t) {
      $('#urlInput').value = t.trim();
      $('#urlInput').dispatchEvent(new Event('input'));
      scheduleProbe(0);
      $('#urlInput').focus();
    }
  });
  $('#formatSelect').addEventListener('change', async (e) => {
    await save({ format: e.target.value });
    scheduleProbe(0);
  });
  $('#qualitySelect').addEventListener('change', (e) => save({ quality: e.target.value }));
  $('#cutToggle').addEventListener('click', () => setCut(!cutMode));

  $('#pauseBtn').addEventListener('click', async () => {
    paused = await api.pauseQueue(!paused);
    $('#pauseBtn').textContent = paused ? 'Kuyruğa devam et' : 'Kuyruğu duraklat';
  });
  $('#clearBtn').addEventListener('click', () => api.clearFinished());
  $('#openFolder').addEventListener('click', () => api.openDownloadFolder());

  $('#openSettings').addEventListener('click', () => showSettings(true));
  $('#closeSettings').addEventListener('click', () => showSettings(false));
  for (const t of document.querySelectorAll('.set-tab')) {
    t.addEventListener('click', () => selectTab(t.dataset.tab));
    t.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const tabs = [...document.querySelectorAll('.set-tab')];
      const i = tabs.indexOf(t) + (e.key === 'ArrowDown' ? 1 : -1);
      const next = tabs[(i + tabs.length) % tabs.length];
      selectTab(next.dataset.tab);
      next.focus();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#settingsView').classList.contains('hidden') && $('#trimModal').classList.contains('hidden')) showSettings(false);
  });

  $('#setDirBtn').addEventListener('click', async () => {
    const dir = await api.chooseFolder();
    if (dir) save({ downloadDir: dir });
  });
  $('#setByPlatform').addEventListener('change', (e) => save({ organizeByPlatform: e.target.checked }));
  $('#setConcurrent').addEventListener('change', (e) => save({ concurrent: Number(e.target.value) }));
  $('#setCompat').addEventListener('change', (e) => save({ editorCompat: e.target.checked }));
  $('#setAutoClear').addEventListener('change', (e) => save({ autoClearDone: e.target.checked }));
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
      msg.className = 'hint error';
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
    m.className = 'hint ok';
  });
  $('#openLogsBtn').addEventListener('click', () => api.openLogs());

  init();
})();
