#!/usr/bin/env node
'use strict';

/**
 * One-command launcher for vdxtrctr.
 *
 *   node run.js            install deps (if needed), build UI (if changed), start server, open browser
 *   node run.js --tools    also download yt-dlp + ffmpeg into backend/bin (first time)
 *   node run.js --dev      development mode: backend + React dev server (hot reload)
 *   node run.js --no-open  don't open the browser automatically
 *
 * Env: PORT (default 3001), HOST (default 127.0.0.1)
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const BACKEND = path.join(ROOT, 'backend');
const FRONTEND = path.join(ROOT, 'frontend');
const args = new Set(process.argv.slice(2));
const DEV = args.has('--dev');
const OPEN = !args.has('--no-open');
const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '127.0.0.1';
const isWin = process.platform === 'win32';

const step = (m) => console.log(`\n\x1b[36m▶ ${m}\x1b[0m`);
const fail = (m) => { console.error(`\n\x1b[31m✘ ${m}\x1b[0m`); process.exit(1); };

// npm is a .cmd on Windows, which needs a shell.
function run(cmd, cwd) {
  const r = spawnSync(cmd, { cwd, stdio: 'inherit', shell: true });
  if (r.status !== 0) fail(`Command failed: ${cmd} (in ${path.relative(ROOT, cwd) || '.'})`);
}

function newestMtime(p) {
  if (!fs.existsSync(p)) return 0;
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.mtimeMs;
  let max = st.mtimeMs;
  for (const e of fs.readdirSync(p)) {
    if (e === 'node_modules' || e === 'build') continue;
    max = Math.max(max, newestMtime(path.join(p, e)));
  }
  return max;
}

function ensureDeps(dir, name) {
  const marker = path.join(dir, 'node_modules', '.package-lock.json');
  const pkg = path.join(dir, 'package.json');
  if (!fs.existsSync(marker) || fs.statSync(pkg).mtimeMs > fs.statSync(marker).mtimeMs) {
    step(`Installing ${name} dependencies (first run can take a few minutes)...`);
    run('npm install --no-audit --no-fund', dir);
  }
}

function ensureChrome() {
  const r = spawnSync(process.execPath, ['-e', "const p=require('puppeteer');process.exit(require('fs').existsSync(p.executablePath())?0:1)"], { cwd: BACKEND });
  if (r.status !== 0) {
    step('Downloading Chrome for puppeteer...');
    run('npx puppeteer browsers install chrome', BACKEND);
  }
}

function ensureBuild() {
  const index = path.join(FRONTEND, 'build', 'index.html');
  const built = fs.existsSync(index) ? fs.statSync(index).mtimeMs : 0;
  const src = Math.max(
    newestMtime(path.join(FRONTEND, 'src')),
    newestMtime(path.join(FRONTEND, 'public')),
    newestMtime(path.join(FRONTEND, 'package.json')),
  );
  if (src > built) {
    step('Building the web UI...');
    run('npm run build', FRONTEND);
  }
}

async function waitForHealth(url, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url)).ok) return true; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

function openBrowser(url) {
  const cmd = isWin ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  spawn(cmd, { shell: true, stdio: 'ignore', detached: true }).unref();
}

(async () => {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) fail(`Node.js 20+ is required (you have ${process.version}). Download it from https://nodejs.org`);

  ensureDeps(BACKEND, 'backend');
  ensureChrome();
  ensureDeps(FRONTEND, 'frontend');

  if (args.has('--tools')) {
    step('Downloading yt-dlp / ffmpeg...');
    run('npm run setup-tools', BACKEND);
  }

  if (!DEV) ensureBuild();

  const children = [];
  const stopAll = () => {
    for (const c of children) {
      if (c.exitCode !== null) continue;
      if (isWin) spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
      else c.kill('SIGINT');
    }
  };
  process.on('SIGINT', () => { stopAll(); process.exit(0); });
  process.on('SIGTERM', () => { stopAll(); process.exit(0); });

  step(`Starting server on http://${HOST}:${PORT} ...`);
  const backend = spawn(process.execPath, ['server.js'], {
    cwd: BACKEND, stdio: 'inherit', env: { ...process.env, PORT: String(PORT), HOST },
  });
  children.push(backend);
  backend.on('exit', (code) => { stopAll(); process.exit(code ?? 0); });

  if (!(await waitForHealth(`http://127.0.0.1:${PORT}/api/health`))) {
    stopAll();
    fail(`Server did not start. Is port ${PORT} already in use? Try: set PORT=3005 (Windows) / PORT=3005 node run.js`);
  }

  let appUrl = `http://127.0.0.1:${PORT}`;
  if (DEV) {
    step('Starting React dev server (hot reload) on http://localhost:3000 ...');
    const fe = spawn('npm start', {
      cwd: FRONTEND, stdio: 'inherit', shell: true,
      env: { ...process.env, BROWSER: 'none', REACT_APP_API_URL: `http://127.0.0.1:${PORT}` },
    });
    children.push(fe);
    appUrl = 'http://localhost:3000';
  }

  console.log(`\n\x1b[32m✔ Ready: ${appUrl}\x1b[0m   (press Ctrl+C to stop)\n`);
  if (OPEN) setTimeout(() => openBrowser(appUrl), DEV ? 8000 : 300);
})();
