'use strict';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Extensions we consider a "whole" media resource (not a segment).
const MEDIA_EXT = ['m3u8', 'mpd', 'mp4', 'm4v', 'webm', 'mkv', 'mov', 'flv', 'ogv', 'mp3', 'm4a', 'ogg'];
const MEDIA_EXT_RE = new RegExp(`\\.(${MEDIA_EXT.join('|')})(?:[?#&;]|$)`, 'i');
// Segment-ish resources. These must never be offered as "the video".
const SEGMENT_RE = /\.(ts|m4s|m4f|aac|cmfv|cmfa|vtt|webvtt|key)(?:[?#&;]|$)|[/_-](seg|segment|frag|fragment|chunk)[-_]?\d+/i;

const AD_HOST_PATTERNS = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'google-analytics.com',
  'googletagmanager.com', 'googletagservices.com', 'adservice.google.', 'imasdk.googleapis.com',
  'popads.net', 'popcash.net', 'propellerads.com', 'propellerclick.com', 'adsterra.com',
  'exoclick.com', 'exosrv.com', 'exdynsrv.com', 'juicyads.com', 'trafficjunky.net', 'trafficjunky.com',
  'adcash.com', 'hilltopads.net', 'a-ads.com', 'clickadu.com', 'onclickads.net', 'onclkds.com',
  'mgid.com', 'taboola.com', 'outbrain.com', 'revcontent.com', 'adnxs.com', 'criteo.com',
  'criteo.net', 'pubmatic.com', 'rubiconproject.com', 'openx.net', 'amazon-adsystem.com',
  'ads-twitter.com', 'scorecardresearch.com', 'quantserve.com', 'hotjar.com', 'mc.yandex.ru',
  'histats.com', 'statcounter.com', 'adskeeper.com', 'realsrv.com', 'tsyndicate.com', 'magsrv.com',
  'dolohen.com', 'acscdn.com', 'highperformanceformat.com', 'profitabledisplaynetwork.com',
  'effectivegatecpm.com', 'bidgear.com', 'pushance.com', 'richpush.co', 'adspyglass.com',
  'clickaine.com', 'adxadserv.com', 'adform.net', 'smartadserver.com', 'yieldmo.com',
  'zedo.com', 'adhigh.net', 'popmyads.com', 'ad-maven.com', 'admaven.com', 'monetag.com',
  'whos.amung.us', 'disqusads.com', 'vidverto.io', 'aniview.com', 'spotxchange.com',
  'springserve.com', 'adtng.com', 'adspirit.de', 'betteradsystem.com', 'cloudfront-ads',
];
const AD_URL_RE = /(\/|\b)(popunder|popup-?ad|pop-?under|vast(\.xml)?|vmap|preroll|pre-roll|adserver|ad[sx]?\.js|adframe|banner-?ads?)(\b|\/|\?)/i;

function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch { return ''; }
}

function isAdUrl(u) {
  const h = hostOf(u);
  if (!h) return false;
  if (AD_HOST_PATTERNS.some(p => h === p || h.endsWith('.' + p) || (p.endsWith('.') && h.includes(p)))) return true;
  return AD_URL_RE.test(u);
}

function isHttpUrl(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u);
}

function resolveUrl(u, base) {
  if (!u || typeof u !== 'string') return null;
  u = u.trim().replace(/\\\//g, '/');
  if (u.startsWith('//')) u = 'https:' + u;
  try { return new URL(u, base).href; } catch { return null; }
}

/**
 * Classify a URL (and optional content-type) as a media type.
 * Returns one of: hls, dash, mp4, webm, mkv, mov, flv, audio, video, segment, null
 */
function classify(url, contentType = '') {
  const ct = String(contentType || '').toLowerCase().split(';')[0].trim();
  let path = url;
  try { path = new URL(url).pathname; } catch { /* keep */ }

  if (ct.includes('mpegurl') || /\.m3u8(?:$|[?#])/i.test(url)) return 'hls';
  if (ct === 'application/dash+xml' || /\.mpd(?:$|[?#])/i.test(url)) return 'dash';
  const base = '/' + path.split('/').pop();
  if (ct === 'video/mp2t' || ct === 'video/iso.segment' || SEGMENT_RE.test(base)) return 'segment';

  const m = path.match(/\.([a-z0-9]{2,4})$/i);
  const ext = m ? m[1].toLowerCase() : '';
  if (ext === 'mp4' || ext === 'm4v') return 'mp4';
  if (ext === 'webm') return 'webm';
  if (ext === 'mkv') return 'mkv';
  if (ext === 'mov') return 'mov';
  if (ext === 'flv') return 'flv';
  if (['mp3', 'm4a', 'ogg', 'opus', 'wav'].includes(ext)) return 'audio';

  if (ct.startsWith('video/')) {
    if (ct.includes('mp4')) return 'mp4';
    if (ct.includes('webm')) return 'webm';
    return 'video';
  }
  if (ct.startsWith('audio/')) return 'audio';
  // e.g. "/video.mp4?token=..." already handled; query-string style "file=x.mp4"
  if (MEDIA_EXT_RE.test(url)) {
    const mm = url.match(MEDIA_EXT_RE);
    const e = mm[1].toLowerCase();
    if (e === 'm3u8') return 'hls';
    if (e === 'mpd') return 'dash';
    if (e === 'mp4' || e === 'm4v') return 'mp4';
    return e === 'webm' ? 'webm' : 'video';
  }
  return null;
}

const DIRECT_TYPES = new Set(['mp4', 'webm', 'mkv', 'mov', 'flv', 'video', 'audio']);
const STREAM_TYPES = new Set(['hls', 'dash']);

function sanitizeFilename(name, fallback = 'video') {
  let s = String(name || '')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '');
  if (!s) s = fallback;
  if (s.length > 120) s = s.slice(0, 120).trim();
  // Windows reserved names
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = '_' + s;
  return s;
}

/** RFC 6266 / 5987 Content-Disposition value that never throws on unicode. */
function contentDisposition(filename, inline = false) {
  const safe = sanitizeFilename(filename);
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

function extFromContentType(ct, fallback = 'mp4') {
  ct = String(ct || '').toLowerCase();
  if (ct.includes('webm')) return 'webm';
  if (ct.includes('matroska')) return 'mkv';
  if (ct.includes('quicktime')) return 'mov';
  if (ct.includes('x-flv')) return 'flv';
  if (ct.includes('mp2t')) return 'ts';
  if (ct.includes('audio/mpeg')) return 'mp3';
  if (ct.includes('audio/mp4')) return 'm4a';
  if (ct.includes('mp4')) return 'mp4';
  return fallback;
}

function extFromUrl(u) {
  try {
    const m = new URL(u).pathname.match(/\.([a-z0-9]{2,4})$/i);
    return m ? m[1].toLowerCase() : null;
  } catch { return null; }
}

const HOP_HEADERS = new Set([
  'host', 'connection', 'content-length', 'range', 'accept-encoding', 'if-range', 'if-none-match',
  'if-modified-since', 'upgrade-insecure-requests', 'te', 'trailer', 'transfer-encoding', 'keep-alive',
  'proxy-connection', 'cookie',
]);

/** Keep headers that matter for replaying a media request from outside the browser. */
function sanitizeRequestHeaders(h = {}) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    const key = k.toLowerCase();
    if (HOP_HEADERS.has(key) || key.startsWith(':')) continue;
    if (key.startsWith('sec-ch-') || key === 'sec-fetch-dest' || key === 'sec-fetch-mode' || key === 'sec-fetch-site' || key === 'sec-fetch-user') continue;
    if (typeof v !== 'string' || /[\r\n]/.test(v)) continue;
    out[key] = v;
  }
  return out;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function humanBytes(n) {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

module.exports = {
  DEFAULT_UA, MEDIA_EXT_RE, SEGMENT_RE, DIRECT_TYPES, STREAM_TYPES,
  hostOf, isAdUrl, isHttpUrl, resolveUrl, classify, sanitizeFilename, contentDisposition,
  extFromContentType, extFromUrl, sanitizeRequestHeaders, sleep, humanBytes,
};
