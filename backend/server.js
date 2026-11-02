'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const { extractWithBrowser, closeBrowsers, analysePlaylist } = require('./lib/extractor');
const { extractWithYtdlp } = require('./lib/ytdlp');
const { detect } = require('./lib/tools');
const { headersFor, createSession } = require('./lib/sessions');
const { createJob, getJob, listJobs, cancelJob, publicJob, DOWNLOAD_DIR, ffmpegHeaderArgs } = require('./lib/jobs');
const { httpGet, lower } = require('./lib/http');
const {
  classify, isHttpUrl, contentDisposition, extFromContentType, extFromUrl, DIRECT_TYPES,
} = require('./lib/util');

const app = express();
const PORT = Number(process.env.PORT || 3001);
// Bind to localhost by default: /api/download is a generic proxy and must not
// be exposed to the network unless you really mean it (HOST=0.0.0.0).
const HOST = process.env.HOST || '127.0.0.1';

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const log = (...a) => console.log(...a);

// ---------------------------------------------------------------------------
app.get(['/health', '/api/health'], (req, res) => {
  const t = detect(req.query.refresh === '1');
  res.json({
    status: 'Server is running!',
    tools: {
      ffmpeg: t.ffmpeg ? t.ffmpeg.version : null,
      ytdlp: t.ytdlp ? t.ytdlp.version : null,
    },
    downloadDir: DOWNLOAD_DIR,
  });
});

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------
function legacyFields(result) {
  // Keep the response backwards compatible with the original frontend.
  const best = result.candidates[0];
  return {
    videoUrl: best?.url || null,
    allVideoUrls: result.candidates.map(c => c.url),
    isM3U8: best?.type === 'hls',
    isDirectMP4: best?.type === 'mp4',
  };
}

function hasUsable(result) {
  return result.candidates.some(c => !c.isAd && !c.drm && c.score > 40);
}

/** User pasted a direct media link: no browser needed. */
async function extractDirect(url, referer) {
  const type = classify(url);
  const sessionId = createSession({ pageUrl: referer || url, cookies: [], requestHeaders: new Map() });
  const c = {
    url, type, score: 100, sources: ['input'], referer: referer || null, frameUrl: referer || url, size: null,
    playlist: null,
  };
  if (type === 'hls' || type === 'dash') {
    try {
      const r = await httpGet(url, { headers: headersFor(url, { referer }), responseType: 'text', timeout: 15000 });
      analysePlaylist(c, r.body, r.url || url);
    } catch (e) { c.fetchError = e.message; }
  }
  const cand = {
    url: c.url, type: c.type, score: c.score, sources: c.sources, referer: c.referer, frameUrl: c.frameUrl,
    variants: c.playlist?.variants || null, hasSeparateAudio: c.playlist?.hasSeparateAudio || false,
    encrypted: c.playlist?.encrypted || false, drm: c.playlist?.drm || null,
    duration: c.playlist?.duration || null, live: c.playlist?.live || false,
  };
  let title = 'video';
  try { title = decodeURIComponent(new URL(url).pathname.split('/').pop().replace(/\.[a-z0-9]+$/i, '')) || 'video'; } catch { /* ignore */ }
  return {
    title, thumbnail: null, pageUrl: url, candidates: [cand], iframes: [], usesMSE: false,
    stats: {}, warnings: c.fetchError ? [`Could not read playlist: ${c.fetchError}`] : [], sessionId, engine: 'direct',
  };
}

app.post('/api/extract', async (req, res) => {
  const {
    url, engine = 'auto', timeout, headless = true, blockAds = true, referer,
  } = req.body || {};

  if (!url || !isHttpUrl(String(url).trim())) {
    return res.status(400).json({ success: false, error: 'A valid http(s) URL is required' });
  }
  const target = String(url).trim();
  const timeoutMs = Math.min(Math.max(Number(timeout) || 45000, 10000), 180000);

  log(`\n${'='.repeat(60)}\nExtracting (${engine}): ${target}\n${'='.repeat(60)}`);
  const logs = [];
  const tlog = (m) => { logs.push(m); log('  ' + m); };
  const tools = detect();

  try {
    let result = null;
    const errors = [];
    const directType = classify(target);

    if (directType && directType !== 'segment' && engine !== 'ytdlp') {
      result = await extractDirect(target, referer);
    } else {
      if (engine === 'ytdlp') {
        try { result = await extractWithYtdlp(target, { referer }); } catch (e) { errors.push(`yt-dlp: ${e.message}`); }
      }
      if (!result && engine !== 'ytdlp') {
        try {
          result = await extractWithBrowser(target, {
            timeout: timeoutMs, headless: headless !== false, blockAds: blockAds !== false, referer, log: tlog,
          });
          result.engine = 'browser';
        } catch (e) {
          errors.push(`browser: ${e.message}`);
          tlog(`❌ browser error: ${e.message}`);
        }
      }
      // Fallback to yt-dlp when the browser found nothing useful.
      if ((engine === 'auto') && tools.ytdlp && (!result || !hasUsable(result))) {
        tlog('↪️ trying yt-dlp fallback...');
        const tryUrls = [target];
        if (result?.embedUrl) tryUrls.push(result.embedUrl);
        for (const u of tryUrls) {
          try {
            const y = await extractWithYtdlp(u, { referer: u === target ? referer : target });
            if (result) {
              y.candidates.push(...result.candidates);
              y.warnings.push(...(result.warnings || []));
              y.iframes = result.iframes;
              y.stats = result.stats;
              if (!y.thumbnail) y.thumbnail = result.thumbnail;
            }
            result = y;
            break;
          } catch (e) { errors.push(`yt-dlp: ${e.message}`); tlog(`yt-dlp: ${e.message}`); }
        }
      }
    }

    if (!result) {
      return res.status(500).json({ success: false, error: errors.join(' | ') || 'Extraction failed', logs });
    }

    const payload = {
      success: result.candidates.length > 0,
      ...result,
      ...legacyFields(result),
      errors,
      logs,
      tools: { ffmpeg: !!tools.ffmpeg, ytdlp: !!tools.ytdlp },
    };
    if (!payload.success) {
      payload.error = 'No video found. The site may use DRM, require login, need a manual click (try "Show browser"), ' +
        'or embed the player in an iframe — try extracting one of the iframes listed below.';
      return res.status(404).json(payload);
    }
    return res.json(payload);
  } catch (error) {
    console.error('❌ Error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to extract video', logs });
  }
});

// ---------------------------------------------------------------------------
// Direct download proxy (streams to the browser, supports Range / resume)
// ---------------------------------------------------------------------------
app.get('/api/download', async (req, res) => {
  const { url, sid, referer, title, inline } = req.query;
  if (!url || !isHttpUrl(url)) return res.status(400).send('A valid http(s) url parameter is required');

  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });

  try {
    const headers = headersFor(url, { sid, referer });
    if (req.headers.range) headers.range = req.headers.range;
    const upstream = await fetch(url, { headers: lower(headers), redirect: 'follow', signal: ac.signal });

    if (!upstream.ok && upstream.status !== 206) {
      await upstream.body?.cancel().catch(() => {});
      return res.status(502).send(`Upstream responded ${upstream.status}. The link may have expired or needs a different Referer — try extracting again.`);
    }
    const ct = upstream.headers.get('content-type') || '';
    if (/text\/html/i.test(ct) && !/\.(mp4|webm|mkv|mov)(\?|$)/i.test(url)) {
      await upstream.body?.cancel().catch(() => {});
      return res.status(502).send('Upstream returned an HTML page instead of a video (hotlink protection or expired token). Try extracting again.');
    }

    const urlExt = extFromUrl(upstream.url || url);
    const ext = urlExt && ['mp4', 'webm', 'mkv', 'mov', 'flv', 'm4v', 'mp3', 'm4a', 'ts'].includes(urlExt)
      ? urlExt : extFromContentType(ct);
    let base = title;
    if (!base) {
      try { base = decodeURIComponent(new URL(url).pathname.split('/').pop().replace(/\.[a-z0-9]+$/i, '')); } catch { base = ''; }
    }
    res.status(upstream.status === 206 ? 206 : 200);
    res.setHeader('Content-Type', ct && !/octet-stream|text\//i.test(ct) ? ct : `video/${ext === 'mkv' ? 'x-matroska' : ext}`);
    res.setHeader('Content-Disposition', contentDisposition(`${base || 'video'}.${ext}`, inline === '1'));
    res.setHeader('Accept-Ranges', upstream.headers.get('accept-ranges') || 'bytes');
    for (const h of ['content-length', 'content-range', 'last-modified', 'etag']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!upstream.body) return res.end();
    await pipeline(Readable.fromWeb(upstream.body), res).catch((e) => {
      if (!ac.signal.aborted) console.error('Stream error:', e.message);
    });
  } catch (error) {
    if (ac.signal.aborted) return undefined;
    console.error('Download error:', error.message);
    if (!res.headersSent) res.status(500).send(`Failed to download video: ${error.message}`);
    else res.destroy();
  }
  return undefined;
});

// ---------------------------------------------------------------------------
// Ready-to-paste commands (include the captured Referer / Cookie headers)
// ---------------------------------------------------------------------------
function shQuote(s) { return `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`; }

app.get('/api/commands', (req, res) => {
  const { url, sid, referer, title } = req.query;
  if (!url || !isHttpUrl(url)) return res.status(400).json({ error: 'url required' });
  const h = headersFor(url, { sid, referer });
  const out = `${String(title || 'video').replace(/[^\w.-]+/g, '_').slice(0, 80)}.mp4`;
  const ff = ffmpegHeaderArgs(h).map((a, i) => (i % 2 ? shQuote(a.replace(/\r\n/g, '\\r\\n')) : a)).join(' ');
  const ytdlp = ['yt-dlp', '--user-agent', shQuote(h['user-agent'])];
  if (h.referer) ytdlp.push('--referer', shQuote(h.referer));
  for (const [k, v] of Object.entries(h)) {
    if (['user-agent', 'referer', 'accept', 'accept-language'].includes(k)) continue;
    ytdlp.push('--add-header', shQuote(`${k}:${v}`));
  }
  ytdlp.push('-o', shQuote(out), shQuote(url));
  res.json({
    ffmpeg: `ffmpeg ${ff} -i ${shQuote(url)} -c copy -bsf:a aac_adtstoasc ${shQuote(out)}`,
    ytdlp: ytdlp.join(' '),
    curl: `curl -L ${Object.entries(h).map(([k, v]) => `-H ${shQuote(`${k}: ${v}`)}`).join(' ')} -o ${shQuote(out)} ${shQuote(url)}`,
    headers: h,
  });
});

// ---------------------------------------------------------------------------
// Server-side download jobs (HLS / DASH / yt-dlp / direct) with progress
// ---------------------------------------------------------------------------
app.post('/api/jobs', (req, res) => {
  const { kind, url, sid, referer, variantUrl, format, title } = req.body || {};
  if (!url || !isHttpUrl(url)) return res.status(400).json({ error: 'A valid url is required' });
  const tools = detect();
  let k = kind;
  if (!k || k === 'auto') {
    const t = classify(url);
    if (t === 'hls') k = 'hls';
    else if (t === 'dash') k = tools.ffmpeg ? 'ffmpeg' : 'ytdlp';
    else if (DIRECT_TYPES.has(t)) k = 'direct';
    else k = tools.ytdlp ? 'ytdlp' : 'direct';
  }
  if (k === 'ffmpeg' && !tools.ffmpeg) return res.status(400).json({ error: 'ffmpeg is not installed (see README: npm run setup-tools)' });
  if (k === 'ytdlp' && !tools.ytdlp) return res.status(400).json({ error: 'yt-dlp is not installed (see README: npm run setup-tools)' });
  try {
    const job = createJob(k, { url, sid, referer, variantUrl, format, title });
    log(`⬇️  job ${job.id} (${k}) ${url}`);
    res.json(publicJob(job));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/jobs', (req, res) => res.json(listJobs()));

app.get('/api/jobs/:id', (req, res) => {
  const j = getJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'job not found' });
  return res.json(publicJob(j));
});

app.delete('/api/jobs/:id', (req, res) => {
  if (!cancelJob(req.params.id)) return res.status(404).json({ error: 'job not found' });
  return res.json(publicJob(getJob(req.params.id)));
});

app.get('/api/jobs/:id/file', (req, res) => {
  const j = getJob(req.params.id);
  if (!j || j.status !== 'done' || !j.file || !fs.existsSync(j.file)) return res.status(404).send('File not ready');
  res.setHeader('Content-Disposition', contentDisposition(path.basename(j.file), req.query.inline === '1'));
  return res.sendFile(j.file);
});

// ---------------------------------------------------------------------------
// Serve the production frontend build if present (single-port mode).
// ---------------------------------------------------------------------------
const BUILD_DIR = path.join(__dirname, '..', 'frontend', 'build');
if (fs.existsSync(BUILD_DIR)) {
  app.use(express.static(BUILD_DIR));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(BUILD_DIR, 'index.html')));
}

// ---------------------------------------------------------------------------
if (require.main === module) {
  const server = app.listen(PORT, HOST, () => {
    const t = detect();
    console.log(`
╔════════════════════════════════════════════╗
║   Video Extractor Backend Server           ║
║   http://${HOST}:${PORT}${' '.repeat(Math.max(0, 33 - HOST.length - String(PORT).length))}║
╚════════════════════════════════════════════╝
  ffmpeg : ${t.ffmpeg ? t.ffmpeg.version.slice(0, 60) : 'not found (optional: HLS saved as .ts, no DASH)'}
  yt-dlp : ${t.ytdlp ? t.ytdlp.version : 'not found (optional: no 1800+ site support / fallback)'}
  output : ${DOWNLOAD_DIR}
`);
  });
  const shutdown = async () => {
    console.log('\nShutting down...');
    server.close();
    await closeBrowsers();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = app;
