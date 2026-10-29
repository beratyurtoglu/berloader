'use strict';
// Basit dosya günlüğü. Bir şey ters gittiğinde nedenini görebilmek için:
// %APPDATA%\BerLoader\logs\berloader.log (1 MB'ı geçince berloader.old.log'a döner).

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 1024 * 1024;
let dir = null;
let file = null;
let written = 0; // bu oturumda yazılan bayt (uzun süre açık kalırsa da günlük şişmesin)
const recent = []; // son satırlar bellekte de tutulur (tanılama için)

function init(logDir) {
  dir = logDir;
  file = path.join(dir, 'berloader.log');
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) {
      fs.renameSync(file, path.join(dir, 'berloader.old.log'));
    }
  } catch {
    /* günlük yazılamıyorsa uygulama yine de çalışsın */
  }
}

function fmt(a) {
  if (a instanceof Error) return a.stack || a.message;
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function write(level, args) {
  const line = `${new Date().toISOString()} ${level} ${args.map(fmt).join(' ')}`;
  recent.push(line);
  if (recent.length > 300) recent.shift();
  if (!file) return;
  try {
    fs.appendFileSync(file, line + '\n', 'utf8');
    written += line.length + 1;
    if (written > MAX_BYTES) {
      written = 0;
      fs.renameSync(file, path.join(dir, 'berloader.old.log'));
    }
  } catch {
    /* yoksay */
  }
}

module.exports = {
  init,
  info: (...a) => write('INFO ', a),
  warn: (...a) => write('WARN ', a),
  error: (...a) => write('ERROR', a),
  tail: (n = 80) => recent.slice(-n),
  dir: () => dir
};
