'use strict';

/**
 * Server-side download jobs with progress (HLS, DASH via ffmpeg, yt-dlp,
 * and direct files). Finished files land in DOWNLOAD_DIR and can be fetched
 * through /api/jobs/:id/file.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable, Transform } = require('stream');

const { detect } = require('./tools');
const { headersFor, getSession, netscapeCookies } = require('./sessions');
const { resolvePlaylist, downloadMedia } = require('./hls');
const { httpGet } = require('./http');
const { sanitizeFilename, extFromContentType, extFromUrl, DEFAULT_UA } = require('./util');

const DOWNLOAD_DIR = path.resolve(process.env.DOWNLOAD_DIR || path.join(__dirname, '..', 'downloads'));
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

const jobs = new Map();

function publicJob(j) {
  return {
    id: j.id, kind: j.kind, status: j.status, progress: j.progress, message: j.message,
    error: j.error, filename: j.filename, bytes: j.bytes, warnings: j.warnings,
    createdAt: j.createdAt, finishedAt: j.finishedAt, title: j.title,
  };
}

function listJobs() { return [...jobs.values()].map(publicJob).sort((a, b) => b.createdAt - a.createdAt); }
function getJob(id) { return jobs.get(id) || null; }

function cancelJob(id) {
  const j = jobs.get(id);
  if (!j) return false;
  if (j.status === 'running' || j.status === 'queued') {
    j.abort.abort();
    j.status = 'cancelled';
    j.message = 'Cancelled';
  }
  return true;
}

async function uniquePath(base, ext) {
  let p = path.join(DOWNLOAD_DIR, `${base}.${ext}`);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(DOWNLOAD_DIR, `${base} (${i}).${ext}`);
  return p;
}

function tmpPath(id, suffix) { return path.join(DOWNLOAD_DIR, `.part-${id}-${suffix}`); }

async function rmQuiet(...files) {
  await Promise.all(files.filter(Boolean).map(f => fsp.rm(f, { force: true }).catch(() => {})));
}

function createJob(kind, params) {
  const id = crypto.randomBytes(6).toString('hex');
  const job = {
    id, kind, params, status: 'queued', progress: 0, message: 'Queued', error: null,
    file: null, filename: null, bytes: 0, warnings: [], createdAt: Date.now(), finishedAt: null,
    title: params.title || null, abort: new AbortController(), temps: [],
  };
  jobs.set(id, job);
  const runners = { hls: runHls, ffmpeg: runFfmpegJob, ytdlp: runYtdlp, direct: runDirect };
  const fn = runners[kind];
  if (!fn) throw new Error(`Unknown job kind: ${kind}`);
  setImmediate(async () => {
    job.status = 'running';
    job.message = 'Starting...';
    try {
      await fn(job);
      if (job.status === 'running') {
        job.status = 'done';
        job.progress = 1;
        job.message = 'Done';
      }
    } catch (e) {
      if (job.abort.signal.aborted || job.status === 'cancelled') {
        job.status = 'cancelled';
        job.message = 'Cancelled';
      } else {
        job.status = 'error';
        job.error = e.message || String(e);
        job.message = 'Failed';
        console.error(`❌ job ${id} (${kind}) failed:`, job.error);
      }
      await rmQuiet(...job.temps, job.status === 'done' ? null : job.file);
    } finally {
      job.finishedAt = Date.now();
      await rmQuiet(...job.temps);
    }
  });
  return job;
}

// ---------------------------------------------------------------------------
// ffmpeg helpers
// ---------------------------------------------------------------------------
function ffmpegHeaderArgs(headers) {
  const h = { ...headers };
  const ua = h['user-agent'] || DEFAULT_UA;
  delete h['user-agent'];
  const lines = Object.entries(h).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  const args = ['-user_agent', ua];
  if (lines) args.push('-headers', lines);
  return args;
}

function parseTime(s) {
  const m = /(\d+):(\d+):([\d.]+)/.exec(s || '');
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : null;
}

function runFfmpeg(args, { signal, onProgress, duration } = {}) {
  const tools = detect();
  if (!tools.ffmpeg) return Promise.reject(new Error('ffmpeg is not installed'));
  return new Promise((resolve, reject) => {
    const p = spawn(tools.ffmpeg.path, ['-hide_banner', '-nostdin', '-y', ...args], { windowsHide: true });
    let tail = '';
    let total = duration || null;
    const onAbort = () => p.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    p.stderr.on('data', (d) => {
      const s = d.toString();
      tail = (tail + s).slice(-4000);
      if (!total) { const m = /Duration:\s*([\d:.]+)/.exec(s); if (m) total = parseTime(m[1]); }
      const t = /time=\s*([\d:.]+)/.exec(s);
      if (t && total && onProgress) onProgress(Math.min(0.99, parseTime(t[1]) / total));
    });
    p.on('error', reject);
    p.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('cancelled'));
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed (${code}): ${tail.trim().split(/\r?\n/).slice(-3).join(' | ')}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------
async function runHls(job) {
  const { url, sid, referer, variantUrl, title } = job.params;
  const signal = job.abort.signal;
  const headers = headersFor(url, { sid, referer });
  job.message = 'Reading playlist...';
  const pl = await resolvePlaylist(url, headers, { prefer: variantUrl, signal });
  if (pl.media.drm) throw new Error(`This stream is DRM protected (${pl.media.drm}) and cannot be downloaded.`);
  if (!pl.media.endList) job.warnings.push('Live stream: only the segments currently in the playlist are saved.');

  const tools = detect();
  const base = sanitizeFilename(title || 'video');
  const videoExt = pl.media.isFmp4 ? 'mp4' : 'ts';
  const videoTmp = tmpPath(job.id, `v.${videoExt}`);
  job.temps.push(videoTmp);
  const audioTmp = pl.audio ? tmpPath(job.id, `a.${pl.audio.media.isFmp4 ? 'mp4' : 'ts'}`) : null;
  if (audioTmp) job.temps.push(audioTmp);

  const vTotal = pl.media.segments.length;
  const aTotal = pl.audio ? pl.audio.media.segments.length : 0;
  const weight = tools.ffmpeg ? 0.95 : 1;
  let vDone = 0;
  let aDone = 0;
  const update = () => {
    job.progress = weight * ((vDone + aDone) / (vTotal + aTotal));
    job.message = `Downloading segments ${vDone + aDone}/${vTotal + aTotal}`;
  };

  const vh = headersFor(pl.mediaUrl, { sid, referer: headers.referer });
  await downloadMedia(pl.media, videoTmp, vh, {
    signal, onProgress: (p) => { vDone = p.done; job.bytes = p.bytes; update(); },
  });
  if (pl.audio && (tools.ffmpeg || !pl.media.segments.length)) {
    await downloadMedia(pl.audio.media, audioTmp, headersFor(pl.audio.url, { sid, referer: headers.referer }), {
      signal, onProgress: (p) => { aDone = p.done; update(); },
    });
  } else if (pl.audio) {
    job.warnings.push('This stream has a separate audio track; install ffmpeg to merge it. Saved video only.');
  }

  if (tools.ffmpeg) {
    job.message = 'Remuxing to MP4 (ffmpeg)...';
    const out = await uniquePath(base, 'mp4');
    const args = ['-i', videoTmp];
    if (pl.audio && fs.existsSync(audioTmp)) args.push('-i', audioTmp, '-map', '0:v?', '-map', '0:a?', '-map', '1:a?');
    args.push('-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', out);
    try {
      await runFfmpeg(args, { signal });
      job.file = out;
    } catch (e) {
      if (signal.aborted) throw e;
      // Remux failed (odd codecs) -> keep the raw stream instead of failing.
      job.warnings.push(`Remux failed, saved raw .${videoExt} instead (${e.message.slice(0, 160)})`);
      await rmQuiet(out);
      const raw = await uniquePath(base, videoExt);
      await fsp.rename(videoTmp, raw);
      job.file = raw;
    }
  } else {
    const raw = await uniquePath(base, videoExt);
    await fsp.rename(videoTmp, raw);
    job.file = raw;
    if (videoExt === 'ts') job.warnings.push('Saved as .ts (MPEG-TS). It plays in VLC/MPV; install ffmpeg to get .mp4 automatically.');
  }
  finish(job);
}

async function runFfmpegJob(job) {
  const { url, sid, referer, title } = job.params;
  const headers = headersFor(url, { sid, referer });
  const out = await uniquePath(sanitizeFilename(title || 'video'), 'mp4');
  job.file = out;
  job.message = 'Downloading with ffmpeg...';
  await runFfmpeg([
    ...ffmpegHeaderArgs(headers),
    '-allowed_extensions', 'ALL',
    '-i', url, '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', out,
  ], { signal: job.abort.signal, onProgress: (p) => { job.progress = p; job.message = `ffmpeg ${(p * 100).toFixed(0)}%`; } })
    .catch(async (e) => {
      // Older/newer ffmpeg builds may not know -allowed_extensions for non-HLS inputs.
      if (!/allowed_extensions|Option not found|Unrecognized option/i.test(e.message)) throw e;
      await runFfmpeg([
        ...ffmpegHeaderArgs(headers), '-i', url, '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', out,
      ], { signal: job.abort.signal, onProgress: (p) => { job.progress = p; } });
    });
  finish(job);
}

async function runYtdlp(job) {
  const { url, sid, referer, format, title } = job.params;
  const tools = detect();
  if (!tools.ytdlp) throw new Error('yt-dlp is not installed');
  const base = sanitizeFilename(title || 'video');
  const prefix = `${base} [${job.id}]`;
  const args = [
    '--no-playlist', '--newline', '--no-part', '--no-mtime', '--restrict-filenames',
    '--user-agent', DEFAULT_UA, '-o', path.join(DOWNLOAD_DIR, `${prefix.replace(/[^\w.-]+/g, '_')}.%(ext)s`),
    '--concurrent-fragments', '4', '--retries', '10', '--fragment-retries', '10',
  ];
  if (tools.ffmpeg) args.push('--ffmpeg-location', tools.ffmpeg.path, '--merge-output-format', 'mp4');
  args.push('-f', format || (tools.ffmpeg ? 'bv*+ba/b' : 'b'));
  if (referer) args.push('--referer', referer);
  const sess = getSession(sid);
  if (sess?.cookies?.length) {
    const cf = tmpPath(job.id, 'cookies.txt');
    await fsp.writeFile(cf, netscapeCookies(sess.cookies));
    job.temps.push(cf);
    args.push('--cookies', cf);
  }
  args.push(url);

  let finalFile = null;
  await new Promise((resolve, reject) => {
    const p = spawn(tools.ytdlp.path, args, { windowsHide: true });
    let tail = '';
    const onAbort = () => p.kill('SIGKILL');
    job.abort.signal.addEventListener('abort', onAbort, { once: true });
    const onLine = (line) => {
      tail = (tail + '\n' + line).slice(-3000);
      const m = /\[download\]\s+([\d.]+)%(?:.*?of\s+~?\s*([\d.]+\w+))?(?:.*?at\s+(\S+))?(?:.*?ETA\s+(\S+))?/.exec(line);
      if (m) {
        job.progress = Math.min(0.99, parseFloat(m[1]) / 100);
        job.message = `yt-dlp ${m[1]}%${m[2] ? ' of ' + m[2] : ''}${m[3] ? ' @ ' + m[3] : ''}${m[4] ? ' ETA ' + m[4] : ''}`;
      }
      let f = /Destination:\s+(.+)$/.exec(line) || /Merging formats into "(.+)"/.exec(line) || /\[download\]\s+(.+?) has already been downloaded/.exec(line);
      if (f) finalFile = f[1].trim();
    };
    let buf = '';
    const feed = (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      lines.forEach(onLine);
    };
    p.stdout.on('data', feed);
    p.stderr.on('data', feed);
    p.on('error', reject);
    p.on('close', (code) => {
      job.abort.signal.removeEventListener('abort', onAbort);
      if (job.abort.signal.aborted) return reject(new Error('cancelled'));
      if (code === 0) resolve();
      else reject(new Error((tail.split('\n').filter(l => /ERROR/.test(l)).pop() || `yt-dlp exited with ${code}`).trim()));
    });
  });

  // Locate the output file (merged output name differs from fragments).
  const tag = `[${job.id}]`.replace(/[^\w.-]+/g, '_');
  const files = (await fsp.readdir(DOWNLOAD_DIR)).filter(f => f.includes(job.id) && !f.startsWith('.part-'));
  const pick = files.map(f => path.join(DOWNLOAD_DIR, f)).sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
  const src = (finalFile && fs.existsSync(finalFile)) ? finalFile : pick;
  if (!src) throw new Error(`yt-dlp finished but no output file was found (${tag})`);
  // Rename to a nice title (keep extension).
  const ext = path.extname(src).slice(1) || 'mp4';
  const nice = await uniquePath(base, ext);
  await fsp.rename(src, nice).catch(() => {});
  job.file = fs.existsSync(nice) ? nice : src;
  finish(job);
}

async function runDirect(job) {
  const { url, sid, referer, title } = job.params;
  const headers = headersFor(url, { sid, referer });
  const r = await httpGet(url, { headers, signal: job.abort.signal, responseType: 'stream', timeout: 6 * 60 * 60 * 1000 });
  const total = Number(r.headers.get('content-length') || 0);
  const ext = extFromUrl(r.url) && ['mp4', 'webm', 'mkv', 'mov', 'flv', 'm4v', 'mp3', 'm4a'].includes(extFromUrl(r.url))
    ? extFromUrl(r.url) : extFromContentType(r.headers.get('content-type'));
  const out = await uniquePath(sanitizeFilename(title || 'video'), ext);
  job.file = out;
  let got = 0;
  const counter = new Transform({
    transform(chunk, _e, cb) {
      got += chunk.length;
      job.bytes = got;
      job.progress = total ? Math.min(0.99, got / total) : 0;
      job.message = total ? `${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB` : `${(got / 1048576).toFixed(1)} MB`;
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(r.body), counter, fs.createWriteStream(out), { signal: job.abort.signal });
  finish(job);
}

function finish(job) {
  if (job.file && fs.existsSync(job.file)) {
    job.filename = path.basename(job.file);
    job.bytes = fs.statSync(job.file).size;
    job.message = `Saved to ${job.file}`;
  }
}

module.exports = { createJob, getJob, listJobs, cancelJob, publicJob, DOWNLOAD_DIR, ffmpegHeaderArgs };
