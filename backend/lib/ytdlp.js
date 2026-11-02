'use strict';

/**
 * Optional yt-dlp integration. yt-dlp supports 1800+ sites (YouTube, Vimeo,
 * Dailymotion, Twitter/X, TikTok, Facebook, many file hosts) and has a good
 * generic extractor, so it is used as a fallback (or primary engine) when
 * the browser sniffer finds nothing.
 */
const { spawn } = require('child_process');
const { detect } = require('./tools');
const { createSession } = require('./sessions');
const { DEFAULT_UA, classify } = require('./util');

function run(bin, args, { timeout = 90000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let out = '';
    let err = '';
    const t = setTimeout(() => { p.kill(); reject(new Error('yt-dlp timed out')); }, timeout);
    const onAbort = () => p.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { clearTimeout(t); reject(e); });
    p.on('close', code => {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve(out);
      else reject(new Error((err.split(/\r?\n/).filter(l => /ERROR/.test(l)).pop() || err.trim().split(/\r?\n/).pop() || `yt-dlp exited with ${code}`).slice(0, 400)));
    });
  });
}

function fmtLabel(f) {
  const parts = [];
  if (f.height) parts.push(`${f.height}p`);
  else if (f.format_note) parts.push(f.format_note);
  if (f.ext) parts.push(f.ext);
  if (f.vcodec === 'none') parts.push('audio only');
  else if (f.acodec === 'none') parts.push('video only');
  const size = f.filesize || f.filesize_approx;
  if (size) parts.push(`${(size / 1048576).toFixed(1)} MB`);
  return parts.join(' · ') || f.format_id;
}

/** Returns an extraction result in the same shape as the browser extractor. */
async function extractWithYtdlp(url, { referer, timeout = 90000 } = {}) {
  const tools = detect();
  if (!tools.ytdlp) throw new Error('yt-dlp is not installed');
  const args = ['-J', '--no-playlist', '--no-warnings', '--user-agent', DEFAULT_UA];
  if (referer) args.push('--referer', referer);
  args.push(url);
  const json = JSON.parse(await run(tools.ytdlp.path, args, { timeout }));
  const info = json._type === 'playlist' && json.entries?.length ? json.entries[0] : json;

  const formats = (info.formats || []).filter(f => f.url && f.protocol !== 'mhtml');
  const requestHeaders = new Map();
  const direct = [];
  for (const f of formats) {
    requestHeaders.set(f.url, lowerKeys(f.http_headers || info.http_headers || {}));
    // Expose progressive (audio+video) formats as direct candidates too.
    if (f.vcodec !== 'none' && f.acodec !== 'none' && /^https?$/.test(f.protocol || '')) direct.push(f);
  }
  const sessionId = createSession({ pageUrl: info.webpage_url || url, userAgent: DEFAULT_UA, cookies: [], requestHeaders });

  const candidates = [{
    url: info.webpage_url || url,
    type: 'ytdlp',
    score: 200,
    sources: ['yt-dlp'],
    label: `yt-dlp (${info.extractor_key || info.extractor || 'generic'})`,
    referer: referer || null,
    formats: formats
      .filter(f => f.vcodec !== 'none' || f.acodec !== 'none')
      .map(f => ({ id: f.format_id, label: fmtLabel(f), height: f.height || 0, ext: f.ext, protocol: f.protocol }))
      .sort((a, b) => b.height - a.height)
      .slice(0, 40),
    duration: info.duration || null,
    drm: formats.length && formats.every(f => f.has_drm) ? 'DRM' : null,
  }];
  for (const f of direct.sort((a, b) => (b.height || 0) - (a.height || 0)).slice(0, 5)) {
    candidates.push({
      url: f.url, type: classify(f.url) || (f.ext === 'webm' ? 'webm' : 'mp4'), score: 150 + (f.height || 0) / 100,
      sources: ['yt-dlp'], label: fmtLabel(f), size: f.filesize || f.filesize_approx || null,
      referer: (f.http_headers || {}).Referer || referer || null,
    });
  }

  return {
    title: info.title || 'Untitled video',
    thumbnail: info.thumbnail || null,
    pageUrl: info.webpage_url || url,
    candidates,
    iframes: [],
    usesMSE: false,
    stats: {},
    warnings: [],
    sessionId,
    engine: 'yt-dlp',
  };
}

function lowerKeys(h) {
  const o = {};
  for (const [k, v] of Object.entries(h)) o[k.toLowerCase()] = v;
  return o;
}

module.exports = { extractWithYtdlp, run };
