'use strict';
// Hesap girişleri: Instagram / X / TikTok / Pinterest.
//
// Neden: Bu platformlar çoğu içerik için giriş ister. Chrome ve Edge çerezlerini dışarıdan
// okumak (--cookies-from-browser) yeni sürümlerde şifreleme yüzünden çalışmıyor. Bu yüzden
// uygulama kendi giriş penceresini açar; oturum yalnızca BerLoader'a aittir. İndirme sırasında
// bu oturumun çerezleri geçici bir cookies.txt dosyasına yazılır ve iş bitince silinir.
// Şifren hiçbir yerde saklanmaz; yalnızca platformun verdiği oturum çerezleri tutulur.

const { BrowserWindow, session, app } = require('electron');
const fs = require('fs');
const path = require('path');

const PARTITION = 'persist:berloader-accounts';

const PLATFORMS = {
  instagram: {
    label: 'Instagram',
    loginUrl: 'https://www.instagram.com/accounts/login/',
    domains: ['instagram.com'],
    keyCookie: 'sessionid'
  },
  x: {
    label: 'X',
    loginUrl: 'https://x.com/i/flow/login',
    domains: ['x.com', 'twitter.com'],
    keyCookie: 'auth_token'
  },
  tiktok: {
    label: 'TikTok',
    loginUrl: 'https://www.tiktok.com/login',
    domains: ['tiktok.com'],
    keyCookie: 'sessionid'
  },
  pinterest: {
    label: 'Pinterest',
    loginUrl: 'https://www.pinterest.com/login/',
    domains: ['pinterest.com'],
    keyCookie: '_auth'
  }
};

const ALL_DOMAINS = Object.values(PLATFORMS).flatMap((p) => p.domains);

function domainMatches(cookieDomain, domains) {
  const d = String(cookieDomain || '').replace(/^\./, '').toLowerCase();
  return domains.some((x) => d === x || d.endsWith('.' + x));
}

// Netscape cookies.txt biçimi (yt-dlp ve gallery-dl bunu okur).
function toNetscape(cookies, nowSec = Math.floor(Date.now() / 1000)) {
  const lines = ['# Netscape HTTP Cookie File', '# BerLoader tarafından oluşturuldu. Düzenleme.', ''];
  for (const c of cookies) {
    if (!c || !c.name || !c.domain) continue;
    const includeSub = c.domain.startsWith('.');
    const domain = (c.httpOnly ? '#HttpOnly_' : '') + c.domain;
    // Oturum çerezlerinin süresi yoktur; bazı okuyucular 0'ı atar, bu yüzden 30 gün verilir.
    const expiry = c.expirationDate ? Math.floor(c.expirationDate) : nowSec + 30 * 86400;
    const clean = (s) => String(s).replace(/[\t\r\n]/g, '');
    lines.push(
      [domain, includeSub ? 'TRUE' : 'FALSE', c.path || '/', c.secure ? 'TRUE' : 'FALSE', expiry, clean(c.name), clean(c.value)].join('\t')
    );
  }
  return lines.join('\n') + '\n';
}

// Electron'un "Electron/xx" imzasını kaldırır; aksi halde bazı siteler girişi reddeder.
function browserUserAgent(ua) {
  return String(ua)
    .replace(/\s+Electron\/\S+/i, '')
    .replace(/\s+(?:berloader|BerLoader)\/\S+/i, '');
}

class Accounts {
  constructor(logger) {
    this.log = logger || { info() {}, warn() {}, error() {} };
    this.ses = null;
    this.loginWin = null;
  }

  session() {
    if (!this.ses) {
      this.ses = session.fromPartition(PARTITION);
      this.ses.setUserAgent(browserUserAgent(this.ses.getUserAgent()));
    }
    return this.ses;
  }

  async _cookies() {
    try {
      return await this.session().cookies.get({});
    } catch (e) {
      this.log.warn('Çerezler okunamadı:', e.message);
      return [];
    }
  }

  async status() {
    const cookies = await this._cookies();
    const now = Date.now() / 1000;
    const out = {};
    for (const [key, p] of Object.entries(PLATFORMS)) {
      out[key] = {
        label: p.label,
        loggedIn: cookies.some(
          (c) => c.name === p.keyCookie && domainMatches(c.domain, p.domains) && (!c.expirationDate || c.expirationDate > now)
        )
      };
    }
    return out;
  }

  // Giriş penceresini açar; kapanınca (ya da giriş algılanınca otomatik kapanır) güncel durumu döndürür.
  login(platform, parent) {
    const p = PLATFORMS[platform];
    if (!p) return Promise.reject(new Error('Bilinmeyen platform'));
    if (this.loginWin && !this.loginWin.isDestroyed()) {
      this.loginWin.focus();
      return Promise.resolve(this.status());
    }
    return new Promise((resolve) => {
      const win = new BrowserWindow({
        width: 520,
        height: 760,
        parent: parent || undefined,
        modal: !!parent,
        center: true,
        title: `${p.label} hesabına giriş`,
        autoHideMenuBar: true,
        backgroundColor: '#ffffff',
        webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true }
      });
      this.loginWin = win;
      win.setMenu(null);
      let finished = false;
      let timer = null;
      let closeTimer = null;

      const finish = async () => {
        if (finished) return;
        finished = true;
        clearInterval(timer);
        clearTimeout(closeTimer);
        try {
          await this.session().cookies.flushStore();
        } catch {
          /* yoksay */
        }
        this.loginWin = null;
        resolve(await this.status());
      };

      // Giriş yapıldığında pencere kendiliğinden kapanır.
      timer = setInterval(async () => {
        if (win.isDestroyed()) return;
        const st = await this.status();
        if (st[platform] && st[platform].loggedIn && !closeTimer) {
          closeTimer = setTimeout(() => {
            if (!win.isDestroyed()) win.close();
          }, 2500);
        }
      }, 1500);

      win.on('closed', finish);
      win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) win.loadURL(url);
        return { action: 'deny' };
      });
      win.loadURL(p.loginUrl).catch((e) => this.log.warn('Giriş sayfası açılamadı:', e.message));
    });
  }

  async logout(platform) {
    const p = PLATFORMS[platform];
    if (!p) return this.status();
    const ses = this.session();
    const cookies = await this._cookies();
    for (const c of cookies) {
      if (!domainMatches(c.domain, p.domains)) continue;
      const host = c.domain.replace(/^\./, '');
      const url = `http${c.secure ? 's' : ''}://${host}${c.path || '/'}`;
      try {
        await ses.cookies.remove(url, c.name);
      } catch {
        /* yoksay */
      }
    }
    for (const d of p.domains) {
      try {
        await ses.clearStorageData({ origin: `https://www.${d}` });
        await ses.clearStorageData({ origin: `https://${d}` });
      } catch {
        /* yoksay */
      }
    }
    return this.status();
  }

  // Tüm hesap çerezlerini taze olarak dosyaya yazar. Çerez yoksa false döner.
  async writeCookieFile(dest) {
    const all = (await this._cookies()).filter((c) => domainMatches(c.domain, ALL_DOMAINS));
    if (!all.length) return false;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, toNetscape(all), { encoding: 'utf8', mode: 0o600 });
    return true;
  }
}

module.exports = { Accounts, PLATFORMS, toNetscape, browserUserAgent, domainMatches };
