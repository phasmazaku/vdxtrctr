'use strict';

/**
 * Downloads the optional helper binaries into backend/bin:
 *   - yt-dlp  (all platforms, official GitHub release)
 *   - ffmpeg  (Windows: yt-dlp/FFmpeg-Builds zip; other OS: prints install hint)
 *
 * Usage: npm run setup-tools [-- --only=ytdlp|ffmpeg]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const BIN = path.join(__dirname, '..', 'bin');
fs.mkdirSync(BIN, { recursive: true });
const only = (process.argv.find(a => a.startsWith('--only=')) || '').split('=')[1];

async function download(url, dest) {
  process.stdout.write(`  downloading ${url}\n`);
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  const total = Number(r.headers.get('content-length') || 0);
  let got = 0;
  let last = 0;
  const src = Readable.fromWeb(r.body);
  src.on('data', (c) => {
    got += c.length;
    if (total && Date.now() - last > 500) {
      last = Date.now();
      process.stdout.write(`\r  ${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`);
    }
  });
  await pipeline(src, fs.createWriteStream(dest));
  process.stdout.write(`\r  done (${(got / 1048576).toFixed(1)} MB)            \n`);
}

async function ytdlp() {
  const name = { win32: 'yt-dlp.exe', darwin: 'yt-dlp_macos', linux: 'yt-dlp' }[process.platform] || 'yt-dlp';
  const dest = path.join(BIN, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  await download(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${name}`, dest);
  if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
  console.log(`✔ yt-dlp -> ${dest}`);
}

async function ffmpeg() {
  if (process.platform !== 'win32') {
    console.log('ℹ ffmpeg: install it with your package manager (e.g. `brew install ffmpeg` / `sudo apt install ffmpeg`),');
    console.log('  or run `npm install ffmpeg-static` in backend/ (auto-detected).');
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-ffmpeg-'));
  const zip = path.join(tmp, 'ffmpeg.zip');
  await download('https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip', zip);
  // Windows 10+ ships bsdtar which can extract zip files.
  const r = spawnSync('tar', ['-xf', zip, '-C', tmp], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('Failed to extract ffmpeg zip (tar). Extract it manually into backend/bin.');
  const find = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { const x = find(p); if (x) return x; } else if (e.name.toLowerCase() === 'ffmpeg.exe') return p;
    }
    return null;
  };
  const exe = find(tmp);
  if (!exe) throw new Error('ffmpeg.exe not found in archive');
  fs.copyFileSync(exe, path.join(BIN, 'ffmpeg.exe'));
  const probe = path.join(path.dirname(exe), 'ffprobe.exe');
  if (fs.existsSync(probe)) fs.copyFileSync(probe, path.join(BIN, 'ffprobe.exe'));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`✔ ffmpeg -> ${path.join(BIN, 'ffmpeg.exe')}`);
}

(async () => {
  try {
    if (!only || only === 'ytdlp') await ytdlp();
    if (!only || only === 'ffmpeg') await ffmpeg();
    console.log('\nRestart the backend to pick up the new tools.');
  } catch (e) {
    console.error('✘', e.message);
    process.exit(1);
  }
})();
