'use strict';

/**
 * Static text scanning helpers: find media URLs inside HTML / JS / JSON,
 * including escaped JSON, Dean-Edwards "p,a,c,k,e,d" packed scripts and
 * base64-encoded URLs (all common on ad-heavy file hosts).
 */
const { resolveUrl, classify } = require('./util');

const MEDIA = '(?:m3u8|mpd|mp4|m4v|webm|mkv|mov|flv)';
const ABS_RE = new RegExp(`https?:\\/\\/[^\\s"'<>()\\[\\]{}\\\\^\`|]+?\\.${MEDIA}(?:\\?[^\\s"'<>\\\\{}\`]*)?(?=$|[\\s"'<>()\\\\,;\`])`, 'gi');
const REL_RE = new RegExp(`["'](\\/[^"'\\s<>]+?\\.${MEDIA}(?:\\?[^"'\\s<>]*)?)["']`, 'gi');
const B64_RE = /["'`]((?:aHR0c|Ly9)[A-Za-z0-9+/_-]{16,4000}={0,2})["'`]/g; // base64 of "http" / "//"

/** Unpack all eval(function(p,a,c,k,e,d){...}) blobs found in `code`. */
function unpackPacked(code) {
  const out = [];
  const re = /\}\s*\(\s*'((?:\\.|[^'\\])*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:\\.|[^'\\])*)'\s*\.split\(\s*'\|'\s*\)/g;
  let m;
  let guard = 0;
  while ((m = re.exec(code)) && guard++ < 50) {
    try {
      let payload = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
      const radix = parseInt(m[2], 10);
      let count = parseInt(m[3], 10);
      const words = m[4].split('|');
      const enc = (n) =>
        (n < radix ? '' : enc(Math.floor(n / radix))) +
        ((n = n % radix) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
      const dict = Object.create(null);
      while (count--) dict[enc(count)] = words[count] || enc(count);
      payload = payload.replace(/\b\w+\b/g, (w) => (w in dict ? dict[w] : w));
      out.push(payload);
    } catch { /* ignore malformed */ }
  }
  return out;
}

function decodeB64(s) {
  try {
    const t = s.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(t, 'base64').toString('utf8');
  } catch { return ''; }
}

/**
 * Return [{url, type, how}] of media URLs found in arbitrary text.
 * `baseUrl` resolves relative paths.
 */
function scanText(text, baseUrl) {
  if (!text || typeof text !== 'string') return [];
  if (text.length > 6 * 1024 * 1024) text = text.slice(0, 6 * 1024 * 1024);

  const found = new Map();
  const add = (raw, how) => {
    if (!raw) return;
    let u = raw.replace(/\\u0026/gi, '&').replace(/\\u002F/gi, '/').replace(/&amp;/g, '&').replace(/\\\//g, '/');
    u = resolveUrl(u, baseUrl);
    if (!u || found.has(u)) return;
    const type = classify(u);
    if (!type || type === 'segment') return;
    found.set(u, { url: u, type, how });
  };

  const sweep = (t, how) => {
    const unescaped = t.replace(/\\\//g, '/');
    for (const m of unescaped.matchAll(ABS_RE)) add(m[0], how);
    for (const m of unescaped.matchAll(REL_RE)) add(m[1], how);
  };

  sweep(text, 'text');

  for (const unpacked of unpackPacked(text)) sweep(unpacked, 'packed');

  let n = 0;
  for (const m of text.matchAll(B64_RE)) {
    if (n++ > 200) break;
    const d = decodeB64(m[1]);
    if (/^(https?:)?\/\//.test(d)) sweep(`"${d}"`, 'base64');
  }

  return [...found.values()];
}

module.exports = { scanText, unpackPacked };
