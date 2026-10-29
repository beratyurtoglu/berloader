'use strict';
// Paketlenmiş uygulamada güncelleme ayarı resources/app-update.yml içindedir
// (electron-builder derleme sırasında üretir; electron-updater de bunu okur).
// package.json içindeki "build" bölümü pakete girmediği için oradan okunmaz.
const fs = require('fs');
const path = require('path');

function parseUpdateYml(text) {
  const get = (k) => {
    const m = new RegExp('^' + k + ':\\s*(.+?)\\s*$', 'm').exec(String(text || ''));
    return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
  };
  return { provider: get('provider'), owner: get('owner'), repo: get('repo') };
}

// { ok: true, owner, repo } ya da { ok: false, reason }
function readUpdateConfig(resourcesPath) {
  let text;
  try {
    text = fs.readFileSync(path.join(resourcesPath, 'app-update.yml'), 'utf8');
  } catch {
    return { ok: false, reason: 'app-update.yml bulunamadı' };
  }
  const c = parseUpdateYml(text);
  if (c.provider !== 'github' || !c.owner || !c.repo) return { ok: false, reason: 'GitHub bilgisi eksik' };
  if (/GITHUB_KULLANICI_ADIN/.test(c.owner)) return { ok: false, reason: 'owner ayarlanmamış' };
  return { ok: true, owner: c.owner, repo: c.repo };
}

module.exports = { parseUpdateYml, readUpdateConfig };
