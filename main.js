'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const logger = require('./src/logger');
const { Settings, History } = require('./src/store');
const { Engine } = require('./src/engine');
const { Downloader } = require('./src/downloader');
const { Accounts } = require('./src/accounts');

app.setAppUserModelId('com.beratyurtoglu.berloader');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
let settings, history, engine, downloader, accounts;
let updater = null;
let updateState = { state: 'idle' };
let errorShown = false;

const ENGINE_CHECK_MS = 6 * 60 * 60 * 1000; // 6 saatte bir motor denetimi
const APP_CHECK_MS = 4 * 60 * 60 * 1000; // 4 saatte bir uygulama güncelleme denetimi

function send(channel, payload) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------- Çökme koruması ----------
// Beklenmeyen bir hata uygulamayı sessizce düşürmesin: kaydet, bir kez bildir, devam et.
process.on('uncaughtException', (e) => {
  logger.error('uncaughtException:', e);
  if (!errorShown && app.isReady()) {
    errorShown = true;
    dialog.showErrorBox('BerLoader', 'Beklenmeyen bir hata oluştu. Ayrıntılar günlüğe yazıldı (Ayarlar > Tanılama).\n\n' + (e && e.message ? e.message : e));
  }
});
process.on('unhandledRejection', (e) => logger.error('unhandledRejection:', e));

function createWindow() {
  const s = settings.data;
  win = new BrowserWindow({
    width: s.windowWidth || 1100,
    height: s.windowHeight || 760,
    minWidth: 900,
    minHeight: 640,
    center: true, // her açılışta ekranın ortasında
    show: false,
    title: 'BerLoader',
    backgroundColor: '#0b1220',
    autoHideMenuBar: true,
    icon: fs.existsSync(path.join(__dirname, 'build', 'icon.png')) ? path.join(__dirname, 'build', 'icon.png') : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.once('ready-to-show', () => {
    win.center();
    win.show();
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Arayüz süreci çökerse günlüğe yaz ve yeniden yükle (indirmeler ana süreçte, etkilenmez).
  win.webContents.on('render-process-gone', (_e, details) => {
    logger.error('Arayüz süreci kapandı:', details);
    if (win && !win.isDestroyed()) win.reload();
  });

  // Yalnızca boyut hatırlanır; konum her zaman ortadır.
  let t = null;
  win.on('resize', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      if (!win || win.isDestroyed() || win.isMaximized() || win.isMinimized()) return;
      const [w, h] = win.getSize();
      settings.patch({ windowWidth: w, windowHeight: h });
    }, 500);
  });

  win.on('close', (e) => {
    if (app.isQuiting) return;
    if (downloader.hasActive()) {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'question',
        buttons: ['Çık', 'Vazgeç'],
        defaultId: 1,
        cancelId: 1,
        title: 'BerLoader',
        message: 'İndirmeler sürüyor. Çıkarsan yarım kalacaklar.'
      });
      if (choice === 1) e.preventDefault();
    }
  });

  // Dışarı gezinmeyi ve yeni pencereleri engelle; http(s) bağlantıları tarayıcıda aç.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  if (app.isPackaged) Menu.setApplicationMenu(null);
}

// ---------- Uygulama güncellemesi (GitHub Releases) ----------
function setupAppUpdater() {
  if (!app.isPackaged) return;
  try {
    const pub = ((require('./package.json').build || {}).publish || [])[0] || {};
    if (!pub.owner || /GITHUB_KULLANICI_ADIN/.test(pub.owner)) {
      updateState = { state: 'unconfigured' };
      logger.info('Güncelleme deposu ayarlanmamış (package.json > publish.owner); uygulama güncellemesi kapalı.');
      return;
    }
    const { autoUpdater } = require('electron-updater');
    updater = autoUpdater;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.logger = { info: (m) => logger.info('[updater]', m), warn: (m) => logger.warn('[updater]', m), error: (m) => logger.error('[updater]', m), debug() {} };
    const set = (patch) => {
      updateState = { ...updateState, ...patch };
      send('update:status', updateState);
    };
    updater.on('checking-for-update', () => set({ state: 'checking' }));
    updater.on('update-available', (i) => set({ state: 'downloading', version: i.version, percent: 0 }));
    updater.on('update-not-available', () => set({ state: 'none' }));
    updater.on('download-progress', (p) => set({ state: 'downloading', percent: Math.round(p.percent) }));
    updater.on('update-downloaded', (i) => set({ state: 'ready', version: i.version }));
    updater.on('error', (e) => set({ state: 'error', message: String(e && e.message ? e.message : e).slice(0, 200) }));

    const check = () => {
      if (settings.data.autoUpdateApp) updater.checkForUpdates().catch((e) => logger.warn('Güncelleme denetimi:', e.message));
    };
    setTimeout(check, 15000);
    setInterval(check, APP_CHECK_MS);
  } catch (e) {
    logger.error('Güncelleyici başlatılamadı:', e);
  }
}

// ---------- Tanılama ----------
function diagnosticsText() {
  const st = engine.status();
  const s = settings.data;
  const failed = downloader
    .list()
    .filter((j) => j.status === 'error')
    .slice(-5)
    .map((j) => `- [${j.platform}/${j.format}] ${j.error} (${j.url})`);
  return [
    `BerLoader v${app.getVersion()} (${app.isPackaged ? 'kurulu' : 'geliştirme'})`,
    `Windows: ${os.release()} ${os.arch()} · Electron ${process.versions.electron} · Node ${process.versions.node}`,
    `Motorlar: yt-dlp ${st.ytdlp || '-'}${st.ytdlpChannel === 'nightly' ? ' (nightly)' : ''} · gallery-dl ${st.gallerydl || '-'} · deno ${st.deno || '-'} · ffmpeg ${st.ffmpeg}`,
    `ffmpeg ayrıntı: ${JSON.stringify(engine.ffmpegInfo)}`,
    `Ayarlar: biçim=${s.format} kalite=${s.quality} uyumluluk=${s.editorCompat} eşzamanlı=${s.concurrent} otoTemizlik=${s.autoClearDone} çerezTarayıcı=${s.cookiesBrowser} çerezDosyası=${s.cookiesFile ? 'var' : 'yok'}`,
    '',
    'Son hatalı işler:',
    ...(failed.length ? failed : ['- yok']),
    '',
    'Günlük (son satırlar):',
    ...logger.tail(60)
  ].join('\n');
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    update: updateState
  }));

  ipcMain.handle('settings:get', () => settings.all());
  ipcMain.handle('settings:set', (_e, partial) => {
    const before = settings.data.engineChannel;
    const all = settings.patch(partial || {});
    downloader._pump(); // eşzamanlı sayı değişmiş olabilir
    downloader.purgeOld(); // otomatik temizlik ayarı açılmış olabilir
    if (before !== settings.data.engineChannel) engine.update({ only: ['ytdlp'], reason: 'kanal değişti' });
    return all;
  });

  ipcMain.handle('dialog:folder', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'İndirme klasörünü seç',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: settings.downloadDir()
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:cookieFile', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'cookies.txt dosyasını seç',
      properties: ['openFile'],
      filters: [{ name: 'Metin', extensions: ['txt'] }]
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.handle('folder:open', () => {
    const dir = settings.downloadDir();
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });

  ipcMain.handle('url:analyze', async (_e, payload) => {
    try {
      const { url, platform, format } = payload || {};
      return { ok: true, result: await downloader.analyze(url, { platform, format }) };
    } catch (e) {
      logger.warn('Çözümleme hatası:', e.message);
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('jobs:enqueue', (_e, payload) => downloader.enqueue(payload));
  ipcMain.handle('jobs:list', () => downloader.list());
  ipcMain.handle('jobs:cancel', (_e, id) => downloader.cancel(id));
  ipcMain.handle('jobs:retry', (_e, id) => downloader.retry(id));
  ipcMain.handle('jobs:remove', (_e, id) => downloader.remove(id));
  ipcMain.handle('jobs:clearFinished', () => downloader.clearFinished());
  ipcMain.handle('jobs:pause', (_e, flag) => downloader.setPaused(flag));
  ipcMain.handle('jobs:reveal', (_e, id) => {
    const job = downloader.jobs.get(id);
    if (!job || !job.filePath) return false;
    if (fs.existsSync(job.filePath)) shell.showItemInFolder(job.filePath);
    else shell.openPath(path.dirname(job.filePath));
    return true;
  });
  ipcMain.handle('jobs:open', (_e, id) => {
    const job = downloader.jobs.get(id);
    if (!job || !job.filePath || !fs.existsSync(job.filePath)) return false;
    shell.openPath(job.filePath);
    return true;
  });

  ipcMain.handle('accounts:status', () => accounts.status());
  ipcMain.handle('accounts:login', (_e, platform) => accounts.login(platform, win));
  ipcMain.handle('accounts:logout', (_e, platform) => accounts.logout(platform));

  ipcMain.handle('engine:status', () => engine.status());
  ipcMain.handle('engine:update', async () => {
    if (downloader.hasActive()) return { ok: false, error: 'İndirmeler sürerken motor güncellenemez. Bitmelerini bekle.' };
    await engine.update({ force: false, reason: 'elle' });
    await engine.checkFfmpeg();
    return { ok: true, status: engine.status() };
  });

  ipcMain.handle('diag:copy', () => {
    clipboard.writeText(diagnosticsText());
    return true;
  });
  ipcMain.handle('diag:openLogs', () => shell.openPath(logger.dir() || app.getPath('userData')));

  ipcMain.handle('update:check', async () => {
    if (!updater) return updateState.state === 'unconfigured' ? updateState : { state: 'dev' };
    try {
      await updater.checkForUpdates();
    } catch (e) {
      updateState = { state: 'error', message: String(e.message || e).slice(0, 200) };
    }
    return updateState;
  });
  ipcMain.handle('update:install', () => {
    if (updater && updateState.state === 'ready') {
      app.isQuiting = true;
      updater.quitAndInstall(true, true); // sessiz kur, bitince uygulamayı yeniden aç
    }
  });
}

// ---------- Başlatma ----------
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  logger.init(path.join(app.getPath('userData'), 'logs'));
  logger.info(`BerLoader ${app.getVersion()} başlıyor (${app.isPackaged ? 'kurulu' : 'geliştirme'})`);

  // Önceki oturumdan kalmış geçici çerez dosyalarını sil.
  try {
    fs.rmSync(path.join(app.getPath('temp'), 'berloader'), { recursive: true, force: true });
  } catch {
    /* yoksay */
  }

  settings = new Settings();
  history = new History();
  accounts = new Accounts(logger);
  engine = new Engine(settings, logger);
  downloader = new Downloader({ settings, history, engine, accounts, logger, tmpDir: app.getPath('temp') });

  engine.on('status', (s) => send('engine:status', s));
  downloader.on('job', (j) => send('jobs:update', j));
  downloader.on('removed', (id) => send('jobs:removed', id));
  downloader.startAutoClean(); // 24 saatten eski biten işleri periyodik kaldırır

  registerIpc();
  createWindow();
  setupAppUpdater();

  // Motorlar: eksikse kur, varsa güncelle (indirme sürmüyorsa).
  engine.init().then(() => {
    if (settings.data.autoUpdateEngine && !downloader.hasActive()) engine.update({ reason: 'açılış' });
    downloader._pump();
  });
  setInterval(() => {
    if (settings.data.autoUpdateEngine && !downloader.hasActive()) engine.update({ reason: 'zamanlı denetim' });
  }, ENGINE_CHECK_MS);
});

app.on('before-quit', () => {
  app.isQuiting = true;
  if (downloader) downloader.killAll();
  if (settings) settings.save(true);
  if (history) history.save(true);
});

app.on('window-all-closed', () => app.quit());
