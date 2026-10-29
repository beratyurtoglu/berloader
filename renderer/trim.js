'use strict';
// Bölüm seçme ekranı: video önizlemesi + sol/sağ sürgülerle başlangıç ve bitiş seçimi.
// window.BerTrim.open({ title, url, videoId, duration, section }) -> Promise<{start, end}|null>
(() => {
  const $ = (s) => document.querySelector(s);
  const FRAMES = 8;
  const MIN_LEN = 1;

  function fmt(sec) {
    const t = Math.max(0, Math.round(sec));
    const hh = Math.floor(t / 3600);
    const mm = Math.floor((t % 3600) / 60);
    const ss = t % 60;
    return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
  }

  let active = null; // açık oturum (aynı anda tek ekran)

  function open(opts) {
    if (active) active.finish(null);
    return new Promise((resolve) => {
      const D = Math.floor(Number(opts.duration) || 0);
      if (D < 2) {
        resolve(null);
        return;
      }
      const modal = $('#trimModal');
      const video = $('#trimVideo');
      const poster = $('#trimPoster');
      const msg = $('#trimMsg');
      const track = $('#trimTrack');
      const strip = $('#trimStrip');
      const selEl = $('#trimSel');
      const hl = $('#trimHandleL');
      const hr = $('#trimHandleR');
      const dimL = $('#trimDimL');
      const dimR = $('#trimDimR');
      const playBtn = $('#trimPlay');
      const okBtn = $('#trimOk');

      let start = 0;
      let end = Math.min(D, 30);
      if (opts.section) {
        start = Math.min(Math.max(0, Math.floor(opts.section.start || 0)), D - MIN_LEN);
        end = opts.section.end == null ? D : Math.min(D, Math.ceil(opts.section.end));
        if (end - start < MIN_LEN) end = Math.min(D, start + MIN_LEN);
      }
      let closed = false;
      let ready = false;
      let seekRaf = 0;
      let playing = false;
      const cleanups = [];
      const on = (el, ev, fn, o) => {
        el.addEventListener(ev, fn, o);
        cleanups.push(() => el.removeEventListener(ev, fn, o));
      };

      $('#trimTitle').textContent = opts.title || '';
      msg.textContent = 'Önizleme hazırlanıyor…';
      msg.classList.remove('hidden');
      video.classList.add('hidden');
      poster.classList.remove('hidden');
      poster.removeAttribute('src');
      if (opts.videoId) poster.src = `https://i.ytimg.com/vi/${opts.videoId}/hqdefault.jpg`;
      strip.textContent = '';
      const cells = [];
      for (let i = 0; i < FRAMES; i++) {
        const c = document.createElement('canvas');
        c.className = 'trim-cell';
        c.width = 96;
        c.height = 54;
        strip.append(c);
        cells.push(c);
      }
      playBtn.disabled = true;
      playBtn.textContent = '▶ Seçimi oynat';

      const pct = (t) => (t / D) * 100;
      function paint() {
        hl.style.left = pct(start) + '%';
        hr.style.left = pct(end) + '%';
        selEl.style.left = pct(start) + '%';
        selEl.style.width = pct(end - start) + '%';
        dimL.style.width = pct(start) + '%';
        dimR.style.width = 100 - pct(end) + '%';
        $('#trimStart').textContent = fmt(start);
        $('#trimEnd').textContent = end >= D ? fmt(D) + ' (son)' : fmt(end);
        $('#trimLen').textContent = fmt(end - start);
        hl.setAttribute('aria-valuenow', String(start));
        hl.setAttribute('aria-valuetext', fmt(start));
        hr.setAttribute('aria-valuenow', String(end));
        hr.setAttribute('aria-valuetext', fmt(end));
        const whole = start === 0 && end >= D;
        okBtn.disabled = whole;
        okBtn.textContent = whole ? 'Bölüm videonun tamamı' : `Bu bölümü indir (${fmt(end - start)})`;
      }

      function seekTo(t) {
        if (!ready) return;
        cancelAnimationFrame(seekRaf);
        seekRaf = requestAnimationFrame(() => {
          try {
            video.currentTime = Math.min(Math.max(0, t), D);
          } catch {
            /* önizleme kapanmış olabilir */
          }
        });
      }

      function stopPlay() {
        playing = false;
        try {
          video.pause();
        } catch {
          /* yoksay */
        }
        playBtn.textContent = '▶ Seçimi oynat';
      }

      function setStart(t, seek = true) {
        start = Math.round(Math.min(Math.max(0, t), end - MIN_LEN));
        stopPlay();
        paint();
        if (seek) seekTo(start);
      }
      function setEnd(t, seek = true) {
        end = Math.round(Math.max(Math.min(D, t), start + MIN_LEN));
        stopPlay();
        paint();
        if (seek) seekTo(Math.max(start, end - 1));
      }
      function moveBoth(newStart) {
        const len = end - start;
        const s = Math.round(Math.min(Math.max(0, newStart), D - len));
        start = s;
        end = s + len;
        stopPlay();
        paint();
        seekTo(start);
      }

      // Sürükleme: sol sürgü, sağ sürgü ya da seçili bölgenin tamamı.
      function drag(el, kind) {
        on(el, 'pointerdown', (e) => {
          if (e.button !== undefined && e.button !== 0) return;
          e.preventDefault();
          el.setPointerCapture(e.pointerId);
          const rect = track.getBoundingClientRect();
          const x0 = e.clientX;
          const s0 = start;
          const mv = (ev) => {
            const t = ((ev.clientX - rect.left) / rect.width) * D;
            if (kind === 'l') setStart(t);
            else if (kind === 'r') setEnd(t);
            else moveBoth(s0 + ((ev.clientX - x0) / rect.width) * D);
          };
          const up = () => {
            el.removeEventListener('pointermove', mv);
            el.removeEventListener('pointerup', up);
            el.removeEventListener('pointercancel', up);
          };
          el.addEventListener('pointermove', mv);
          el.addEventListener('pointerup', up);
          el.addEventListener('pointercancel', up);
        });
      }
      drag(hl, 'l');
      drag(hr, 'r');
      drag(selEl, 'm');

      // Klavye ve ince ayar.
      const nudge = (kind, d) => (kind === 'l' ? setStart(start + d) : setEnd(end + d));
      for (const [el, kind] of [[hl, 'l'], [hr, 'r']]) {
        on(el, 'keydown', (e) => {
          const step = e.shiftKey ? 10 : 1;
          if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
            e.preventDefault();
            nudge(kind, -step);
          } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
            e.preventDefault();
            nudge(kind, step);
          }
        });
      }
      on($('#trimStartMinus'), 'click', () => nudge('l', -1));
      on($('#trimStartPlus'), 'click', () => nudge('l', 1));
      on($('#trimEndMinus'), 'click', () => nudge('r', -1));
      on($('#trimEndPlus'), 'click', () => nudge('r', 1));

      on(playBtn, 'click', () => {
        if (!ready) return;
        if (playing) {
          stopPlay();
          return;
        }
        video.currentTime = start;
        playing = true;
        playBtn.textContent = '❚❚ Durdur';
        video.play().catch(() => stopPlay());
      });
      on(video, 'timeupdate', () => {
        if (playing && video.currentTime >= end) {
          stopPlay();
          seekTo(start);
        }
      });

      // Önizleme akışı (alınamazsa kapak görseliyle devam edilir).
      async function loadPreview() {
        let u = null;
        try {
          u = await window.berloader.previewUrl(opts.url);
        } catch {
          u = null;
        }
        if (closed) return;
        if (!u) {
          msg.textContent = 'Önizleme açılamadı; yine de sürgülerle süreyi seçebilirsin.';
          fillCellsWithPoster();
          return;
        }
        on(video, 'loadedmetadata', onMeta, { once: true });
        on(video, 'error', onVideoError, { once: true });
        video.preload = 'metadata';
        video.src = u;
      }
      function onMeta() {
        if (closed) return;
        ready = true;
        poster.classList.add('hidden');
        video.classList.remove('hidden');
        msg.classList.add('hidden');
        playBtn.disabled = false;
        video.currentTime = start;
        buildFrames();
      }
      function onVideoError() {
        if (closed) return;
        ready = false;
        video.classList.add('hidden');
        poster.classList.remove('hidden');
        msg.classList.remove('hidden');
        msg.textContent = 'Önizleme açılamadı; yine de sürgülerle süreyi seçebilirsin.';
        fillCellsWithPoster();
      }
      function fillCellsWithPoster() {
        if (!poster.complete || !poster.naturalWidth) return;
        for (const c of cells) c.getContext('2d').drawImage(poster, 0, 0, c.width, c.height);
      }

      // Gerçek kareler: ikinci (gizli) video ile sırayla alınır; hata olursa durur.
      async function buildFrames() {
        const probe = document.createElement('video');
        probe.muted = true;
        probe.preload = 'auto';
        probe.src = video.currentSrc || video.src;
        cleanups.push(() => {
          probe.removeAttribute('src');
          probe.load();
        });
        const seek = (t) =>
          new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error('zaman aşımı')), 8000);
            probe.addEventListener(
              'seeked',
              () => {
                clearTimeout(timer);
                res();
              },
              { once: true }
            );
            probe.currentTime = t;
          });
        try {
          await new Promise((res, rej) => {
            probe.addEventListener('loadedmetadata', res, { once: true });
            probe.addEventListener('error', () => rej(new Error('açılamadı')), { once: true });
          });
          for (let i = 0; i < FRAMES && !closed; i++) {
            await seek(((i + 0.5) / FRAMES) * D);
            if (closed) return;
            cells[i].getContext('2d').drawImage(probe, 0, 0, cells[i].width, cells[i].height);
          }
        } catch {
          if (!closed) fillCellsWithPoster();
        } finally {
          probe.removeAttribute('src');
          probe.load();
        }
      }

      function finish(result) {
        if (closed) return;
        closed = true;
        cancelAnimationFrame(seekRaf);
        stopPlay();
        for (const fn of cleanups.splice(0)) fn();
        video.removeAttribute('src');
        video.load(); // akışı bırak: arka planda veri çekmeye devam etmesin
        modal.classList.add('hidden');
        active = null;
        resolve(result);
      }
      active = { finish };

      on($('#trimCancel'), 'click', () => finish(null));
      on(okBtn, 'click', () => {
        if (start === 0 && end >= D) return;
        finish({ start, end: end >= D ? null : end });
      });
      on(modal, 'mousedown', (e) => {
        if (e.target === modal) finish(null);
      });
      on(document, 'keydown', (e) => {
        if (e.key === 'Escape') finish(null);
      });

      modal.classList.remove('hidden');
      paint();
      loadPreview();
    });
  }

  window.BerTrim = { open, fmt };
})();
