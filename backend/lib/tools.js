'use strict';

/**
 * Optional external tools. Everything works without them, but:
 *  - ffmpeg: remux .ts -> .mp4, merge separate HLS audio, download DASH (.mpd)
 *  - yt-dlp: supports 1800+ sites natively + strong generic extractor
 *
 * Lookup order: env (FFMPEG_PATH / YTDLP_PATH) -> backend/bin -> ffmpeg-static (if installed) -> PATH
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const BIN_DIR = path.join(__dirname, '..', 'bin');
const exe = (n) => (process.platform === 'win32' ? n + '.exe' : n);

function works(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { timeout: 15000, windowsHide: true, encoding: 'utf8' });
    if (r.status === 0) return (r.stdout || r.stderr || '').split(/\r?\n/)[0].trim();
  } catch { /* not found */ }
  return null;
}

function find(name, envVar, versionArgs, extraCandidates = []) {
  const candidates = [];
  if (process.env[envVar]) candidates.push(process.env[envVar]);
  candidates.push(path.join(BIN_DIR, exe(name)));
  candidates.push(...extraCandidates);
  candidates.push(name);
  for (const c of candidates) {
    if (!c) continue;
    if (c.includes(path.sep) && !fs.existsSync(c)) continue;
    const v = works(c, versionArgs);
    if (v) return { path: c, version: v };
  }
  return null;
}

let cache = null;

function detect(force = false) {
  if (cache && !force) return cache;
  let ffmpegStatic = null;
  try { ffmpegStatic = require('ffmpeg-static'); } catch { /* optional */ }
  cache = {
    ffmpeg: find('ffmpeg', 'FFMPEG_PATH', ['-version'], [ffmpegStatic]),
    ytdlp: find('yt-dlp', 'YTDLP_PATH', ['--version']),
  };
  return cache;
}

module.exports = { detect, BIN_DIR };
