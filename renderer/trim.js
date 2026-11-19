'use strict';
// Bölüm seçme: video önizlemesi, giriş/çıkış sürgüleri, kare kare ince ayar.
// window.BerTrim.open({ title, url, videoId, duration, fps, section }) -> Promise<{start, end}|null>
(() => {
  const $ = (s) => document.querySelector(s);
  const FRAMES = 10;

  // Zaman kodu: SS:DD:SS:KK (saat:dakika:saniye:kare)
  function timecode(t, fps) {
    const r = Math.round(fps) || 30;
    let whole = Math.floor(t + 1e-6);
    let ff = Math.round((t - whole) * fps);
    if (ff >= r) {
      ff = 0;
      whole += 1;
    }
    const hh = Math.floor(whole / 3600);
    const mm = Math.floor((whole % 3600) / 60);
    const ss = whole % 60;
    const p = (n) => String(n).padStart(2, '0');
    return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
  }

  function shortTime(t) {
    const whole = Math.floor(t + 1e-6);
    const frac = t - whole;
    const mm = Math.floor(whole / 60);
    const ss = whole % 60;
    const base = `${mm}:${String(ss).padStart(2, '0')}`;
    return frac > 0.05 ? `${base}.${Math.floor(frac * 10)}` : base;
  }

  let active = null; // aynı anda tek ekran

  function open(opts) {
    if (active) active.finish(null);
    return new Promise((resolve) => {
      const D = Number(opts.duration) || 0;
      if (D < 1) {
        resolve(null);
        return;
      }
      const fps = Number(opts.fps) > 1 && Number(opts.fps) <= 240 ? Number(opts.fps) : 30;
      const FRAME = 1 / fps;
      const MIN_LEN = Math.max(FRAME * 3, 0.2);
      const snap = (t) => Math.min(D, Math.max(0, Math.round(t * fps) / fps));

      const modal = $('#trimModal');
      const video = $('#trimVideo');
      const poster = $('#trimPoster');
      const msg = $('#trimMsg');
      const track = $('#trimTrack');
      const strip = $('#trimStrip');
      const selEl = $('#trimSel');
      const head = $('#trimHead');
      const hl = $('#trimHandleL');
      const hr = $('#trimHandleR');
      const dimL = $('#trimDimL');
      const dimR = $('#trimDimR');
      const playBtn = $('#trimPlay');
      const okBtn = $('#trimOk');

      // Bölüm verilmediyse videonun tamamı seçili açılır; kullanıcı daraltır.
      let start = 0;
      let end = D;
      if (opts.section) {
        start = snap(Math.min(Math.max(0, Number(opts.section.start) || 0), D - MIN_LEN));
        end = opts.section.end == null ? D : snap(Math.min(D, Number(opts.section.end)));
        if (end - start < MIN_LEN) end = Math.min(D, start + MIN_LEN);
      }
      let which = 'in'; // ok tuşlarının oynattığı uç
      let closed = false;
      let ready = false;
      let playing = false;
      let seekRaf = 0;
      let headRaf = 0;
      const cleanups = [];
      const on = (el, ev, fn, o) => {
        el.addEventListener(ev, fn, o);
        cleanups.push(() => el.removeEventListener(ev, fn, o));
      };

      $('#trimTitle').textContent = opts.title || '';
      $('#trimFps').textContent = `${Math.round(fps * 100) / 100} kare/sn`;
      msg.textContent = 'Önizleme hazırlanıyor…';
      video.classList.add('hidden');
      poster.classList.remove('hidden');
      poster.removeAttribute('src');
      if (opts.videoId) poster.src = `https://i.ytimg.com/vi/${opts.videoId}/hqdefault.jpg`;
      strip.textContent = '';
      head.classList.add('hidden');
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
      setPlayLabel(false);

      const pct = (t) => (t / D) * 100;
      function paint() {
        hl.style.left = pct(start) + '%';
        hr.style.left = pct(end) + '%';
        selEl.style.left = pct(start) + '%';
        selEl.style.width = pct(end - start) + '%';
        dimL.style.width = pct(start) + '%';
        dimR.style.width = 100 - pct(end) + '%';
        $('#trimStart').textContent = timecode(start, fps);
        $('#trimEnd').textContent = timecode(end, fps);
        $('#trimLen').textContent = timecode(end - start, fps);
        hl.setAttribute('aria-valuemax', String(D));
        hr.setAttribute('aria-valuemax', String(D));
        hl.setAttribute('aria-valuenow', String(start));
        hl.setAttribute('aria-valuetext', timecode(start, fps));
        hr.setAttribute('aria-valuenow', String(end));
        hr.setAttribute('aria-valuetext', timecode(end, fps));
        hl.classList.toggle('active', which === 'in');
        hr.classList.toggle('active', which === 'out');
        $('#trimInBox').classList.toggle('active', which === 'in');
        $('#trimOutBox').classList.toggle('active', which === 'out');
        const whole = start <= 0 && end >= D;
        okBtn.disabled = whole;
        okBtn.textContent = whole ? 'Önce bir bölüm seç' : `Bu bölümü indir · ${shortTime(end - start)}`;
      }

      function setPlayLabel(isPlaying) {
        playBtn.querySelector('use').setAttribute('href', isPlaying ? '#i-pause' : '#i-play');
        playBtn.querySelector('span').textContent = isPlaying ? 'Durdur' : 'Seçimi oynat';
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
        setPlayLabel(false);
      }

      function setStart(t, seek = true) {
        start = snap(Math.min(Math.max(0, t), end - MIN_LEN));
        which = 'in';
        stopPlay();
        paint();
        if (seek) seekTo(start);
      }
      function setEnd(t, seek = true) {
        end = snap(Math.max(Math.min(D, t), start + MIN_LEN));
        which = 'out';
        stopPlay();
        paint();
        if (seek) seekTo(Math.max(start, end - FRAME));
      }
      function moveBoth(newStart) {
        const len = end - start;
        start = snap(Math.min(Math.max(0, newStart), D - len));
        end = Math.min(D, start + len);
        stopPlay();
        paint();
        seekTo(start);
      }
      const nudge = (side, d) => (side === 'in' ? setStart(start + d) : setEnd(end + d));

      // Sürükleme: giriş, çıkış ya da seçili bölgenin tamamı.
      function drag(el, kind) {
        on(el, 'pointerdown', (e) => {
          if (e.button !== undefined && e.button !== 0) return;
          e.preventDefault();
          el.focus({ preventScroll: true });
          el.setPointerCapture(e.pointerId);
          const rect = track.getBoundingClientRect();
          const x0 = e.clientX;
          const s0 = start;
          if (kind === 'in' || kind === 'out') {
            which = kind;
            paint();
          }
          const mv = (ev) => {
            const t = ((ev.clientX - rect.left) / rect.width) * D;
            if (kind === 'in') setStart(t);
            else if (kind === 'out') setEnd(t);
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
      drag(hl, 'in');
      drag(hr, 'out');
      drag(selEl, 'move');
      on(hl, 'focus', () => {
        which = 'in';
        paint();
      });
      on(hr, 'focus', () => {
        which = 'out';
        paint();
      });

      // Şeridin boş yerine tıklayınca oynatma kafası oraya gider.
      on(strip, 'pointerdown', (e) => {
        const rect = track.getBoundingClientRect();
        const t = snap(((e.clientX - rect.left) / rect.width) * D);
        stopPlay();
        seekTo(t);
      });

      // Basılı tutunca tekrarlayan kare düğmeleri.
      function repeater(el, fn) {
        let t1 = 0;
        let t2 = 0;
        const stop = () => {
          clearTimeout(t1);
          clearInterval(t2);
        };
        on(el, 'pointerdown', (e) => {
          if (e.button !== 0) return;
          fn();
          t1 = setTimeout(() => {
            t2 = setInterval(fn, 55);
          }, 380);
        });
        on(el, 'pointerup', stop);
        on(el, 'pointerleave', stop);
        on(el, 'pointercancel', stop);
        on(el, 'keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            fn();
          }
        });
        cleanups.push(stop);
      }
      repeater($('#trimStartMinus'), () => nudge('in', -FRAME));
      repeater($('#trimStartPlus'), () => nudge('in', FRAME));
      repeater($('#trimEndMinus'), () => nudge('out', -FRAME));
      repeater($('#trimEndPlus'), () => nudge('out', FRAME));
      on($('#trimInBox'), 'pointerdown', () => {
        which = 'in';
        paint();
      });
      on($('#trimOutBox'), 'pointerdown', () => {
        which = 'out';
        paint();
      });

      function togglePlay() {
        if (!ready) return;
        if (playing) {
          stopPlay();
          return;
        }
        if (video.currentTime < start || video.currentTime >= end - FRAME) video.currentTime = start;
        playing = true;
        setPlayLabel(true);
        video.play().catch(() => stopPlay());
      }
      on(playBtn, 'click', togglePlay);
      on(video, 'timeupdate', () => {
        if (playing && video.currentTime >= end) {
          stopPlay();
          seekTo(start);
        }
      });

      // Oynatma kafası (beyaz çizgi) videonun o anki yerini gösterir.
      function drawHead() {
        if (closed) return;
        if (ready) head.style.left = pct(Math.min(D, video.currentTime || 0)) + '%';
        headRaf = requestAnimationFrame(drawHead);
      }

      // Klavye: ekran açıkken her yerde çalışır (odak hangi düğmede olursa olsun).
      on(document, 'keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          finish(null);
          return;
        }
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          const dir = e.key === 'ArrowLeft' ? -1 : 1;
          nudge(which, dir * (e.shiftKey ? 1 : FRAME));
        } else if (e.key === 'i' || e.key === 'I' || e.key === 'ı') {
          if (!ready) return;
          e.preventDefault();
          cancelAnimationFrame(seekRaf);
          setStart(video.currentTime, false);
        } else if (e.key === 'o' || e.key === 'O') {
          if (!ready) return;
          e.preventDefault();
          cancelAnimationFrame(seekRaf);
          setEnd(video.currentTime, false);
        } else if (e.key === ' ' && !(e.target && e.target.tagName === 'BUTTON' && e.target !== hl && e.target !== hr)) {
          e.preventDefault();
          togglePlay();
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
          msg.textContent = 'Önizleme açılamadı; sürgüler ve zaman kodları yine çalışır.';
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
        msg.textContent = '';
        playBtn.disabled = false;
        head.classList.remove('hidden');
        video.currentTime = start;
        drawHead();
        buildFrames();
      }
      function onVideoError() {
        if (closed) return;
        ready = false;
        video.classList.add('hidden');
        poster.classList.remove('hidden');
        head.classList.add('hidden');
        msg.textContent = 'Önizleme açılamadı; sürgüler ve zaman kodları yine çalışır.';
        fillCellsWithPoster();
      }
      function fillCellsWithPoster() {
        if (!poster.complete || !poster.naturalWidth) return;
        for (const c of cells) c.getContext('2d').drawImage(poster, 0, 0, c.width, c.height);
      }

      // Film şeridi: ikinci (gizli) video ile sırayla kareler alınır.
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

      const r3 = (n) => Math.round(n * 1000) / 1000;
      function finish(result) {
        if (closed) return;
        closed = true;
        cancelAnimationFrame(seekRaf);
        cancelAnimationFrame(headRaf);
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
      on($('#trimClose'), 'click', () => finish(null));
      on(okBtn, 'click', () => {
        if (start <= 0 && end >= D) return;
        finish({ start: r3(start), end: end >= D - FRAME / 2 ? null : r3(end) });
      });
      on(modal, 'mousedown', (e) => {
        if (e.target === modal) finish(null);
      });

      modal.classList.remove('hidden');
      paint();
      hl.focus({ preventScroll: true });
      loadPreview();
    });
  }

  window.BerTrim = { open, timecode, shortTime };
})();
