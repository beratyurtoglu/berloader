'use strict';
// Bağlantı çözümleme: hangi platform, YouTube'da video mu liste mi?

const HOSTS = [
  ['youtube', /(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)youtube-nocookie\.com$/],
  ['instagram', /(^|\.)instagram\.com$|(^|\.)instagr\.am$/],
  ['tiktok', /(^|\.)tiktok\.com$/],
  ['x', /(^|\.)twitter\.com$|(^|\.)x\.com$|^t\.co$/],
  ['pinterest', /(^|\.)pinterest\.[a-z.]+$|^pin\.it$/]
];

const PLATFORM_LABELS = {
  youtube: 'YouTube',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  x: 'X',
  pinterest: 'Pinterest',
  other: 'Web'
};

// Platformların "…'dan/den indiriliyor" ekli biçimi (Türkçe ünlü uyumu).
const PLATFORM_FROM = {
  youtube: "YouTube'dan",
  instagram: "Instagram'dan",
  tiktok: "TikTok'tan",
  x: "X'ten",
  pinterest: "Pinterest'ten",
  other: 'Web üzerinden'
};

// Görsel indirme (gallery-dl) bu platformlarda mümkündür.
const IMAGE_PLATFORMS = ['instagram', 'tiktok', 'x', 'pinterest'];

// Yapıştırılan metinden ilk bağlantıyı çıkarır (paylaşım metni de yapıştırılabilir).
function extractUrl(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const m = s.match(/https?:\/\/[^\s"'<>]+/i);
  if (m) return m[0].replace(/[),.;!]+$/, '');
  if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(s)) return 'https://' + s;
  return null;
}

function detect(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { platform: 'other', host: '', url: null };
  }
  const host = u.hostname.toLowerCase();
  for (const [platform, re] of HOSTS) {
    if (re.test(host)) return { platform, host, url: u };
  }
  return { platform: 'other', host, url: u };
}

// 'video' | 'playlist'
// Kural: bağlantıda video kimliği varsa (watch?v=, youtu.be, shorts...) liste parametresi
// olsa bile SADECE o video indirilir. Yalnızca saf liste/kanal bağlantısı "liste" sayılır.
function youtubeKind(u) {
  const host = u.hostname.toLowerCase();
  const p = u.pathname;
  if (host === 'youtu.be') return 'video';
  if (p === '/watch' && u.searchParams.get('v')) return 'video';
  if (/^\/(shorts|live|embed|v)\//.test(p)) return 'video';
  if (p === '/playlist') return 'playlist';
  if (/^\/(@|channel\/|c\/|user\/)/.test(p)) return 'playlist';
  if (u.searchParams.get('list') && !u.searchParams.get('v')) return 'playlist';
  return 'video';
}

// YouTube video bağlantısını liste/radyo parametrelerinden arındırır.
function cleanYoutubeVideoUrl(u) {
  const host = u.hostname.toLowerCase();
  if (host === 'youtu.be') return `https://youtu.be${u.pathname}`;
  if (u.pathname === '/watch') return `https://www.youtube.com/watch?v=${u.searchParams.get('v')}`;
  return `https://www.youtube.com${u.pathname}`;
}

// YouTube bağlantısından 11 karakterlik video kimliğini çıkarır; bulunamazsa null.
function youtubeVideoId(url) {
  let u;
  try {
    u = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  let id = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (u.pathname === '/watch') id = u.searchParams.get('v');
  else {
    const m = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?#]+)/);
    if (m) id = m[1];
  }
  return id && /^[\w-]{6,20}$/.test(id) ? id : null;
}

// Seçili platform ile bağlantının platformu uyuşuyor mu? Uyuşmuyorsa Türkçe hata metni döner.
function checkPlatformMatch(selected, detected) {
  if (!selected) return 'Önce indirme yapacağın platformu seç.';
  if (selected === detected) return null;
  if (detected === 'other') {
    return `Bu bağlantı ${PLATFORM_LABELS[selected]} bağlantısına benzemiyor. Doğru bağlantıyı yapıştır.`;
  }
  return `Bu bağlantı ${PLATFORM_LABELS[detected]} bağlantısı, ama ${PLATFORM_LABELS[selected]} seçili. Yukarıdan ${PLATFORM_LABELS[detected]}'ı seç.`;
}

module.exports = {
  extractUrl,
  detect,
  youtubeKind,
  cleanYoutubeVideoUrl,
  youtubeVideoId,
  checkPlatformMatch,
  PLATFORM_LABELS,
  PLATFORM_FROM,
  IMAGE_PLATFORMS
};
