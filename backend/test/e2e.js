'use strict';

/* End-to-end test against local fixtures. Run: npm test */
process.env.DOWNLOAD_DIR = require('path').join(require('os').tmpdir(), 'vdx-test-downloads');
const assert = require('assert');
const fs = require('fs');
const fixtures = require('./fixtures');
const app = require('../server');
const { closeBrowsers } = require('../lib/extractor');
const { scanText, unpackPacked } = require('../lib/scan');
const { classify } = require('../lib/util');

async function main() {
  const fx = await fixtures.start();
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const API = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body) => fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let failures = 0;
  const test = async (name, fn) => {
    const t = Date.now();
    try { await fn(); console.log(`✔ ${name} (${Date.now() - t}ms)`); } catch (e) { failures++; console.log(`✘ ${name}\n   ${e.stack}`); }
  };

  await test('unit: classify', () => {
    assert.equal(classify('https://a.com/x/master.m3u8?t=1'), 'hls');
    assert.equal(classify('https://a.com/x/seg-12-v1.ts'), 'segment');
    assert.equal(classify('https://a.com/chunk-2023/movie.mp4'), 'mp4');
    assert.equal(classify('https://a.com/get?id=1', 'video/mp4'), 'mp4');
    assert.equal(classify('https://a.com/manifest.mpd'), 'dash');
    assert.equal(classify('https://a.com/x.png', 'video/mp2t'), 'segment');
  });

  await test('unit: scanText finds escaped JSON, packed and base64 URLs', () => {
    const b64 = Buffer.from('https://cdn.example.com/v/abc.m3u8').toString('base64');
    const txt = `{"file":"https:\\/\\/cdn.example.com\\/hls\\/x.m3u8"} var s="${b64}"; ${fixtures.pack('var a={file:"https://h.example.com/m.mp4"}')}`;
    const urls = scanText(txt, 'https://page.example.com/').map(x => x.url);
    assert.ok(urls.includes('https://cdn.example.com/hls/x.m3u8'), 'escaped json');
    assert.ok(urls.includes('https://cdn.example.com/v/abc.m3u8'), 'base64');
    assert.ok(urls.includes('https://h.example.com/m.mp4'), 'packed');
    assert.equal(unpackPacked(fixtures.pack('hello world hello')).length, 1);
  });

  let hlsResult;
  await test('extract: ad-heavy page with iframe embed + click-to-play HLS', async () => {
    const r = await post('/api/extract', { url: `${fx.SITE}/watch`, timeout: 40000 });
    const j = await r.json();
    hlsResult = j;
    if (!j.success) console.log(JSON.stringify(j, null, 1).slice(0, 3000));
    assert.equal(r.status, 200);
    const best = j.candidates[0];
    assert.equal(best.type, 'hls');
    assert.ok(best.url.includes('/hls/master.m3u8'), best.url);
    assert.equal(best.variants.length, 2);
    assert.equal(best.variants[0].height, 720);
    assert.ok(best.referer.startsWith(fx.EMBED), 'referer should be the embed frame: ' + best.referer);
    assert.ok(!j.candidates.some(c => c.url.includes('/index.m3u8')), 'variant playlists should be folded into master');
    assert.equal(j.title, 'Watch Test Movie (2024) - FreeStream');
    assert.equal(fx.hits.popups, 0, 'popup must never load');
    console.log('   stats:', JSON.stringify(j.stats));
  });

  await test('job: native HLS download (AES-128 + fake PNG header)', async () => {
    const best = hlsResult.candidates[0];
    const r = await post('/api/jobs', { kind: 'hls', url: best.url, sid: hlsResult.sessionId, referer: best.referer, title: 'Test Movie' });
    const job = await r.json();
    let st;
    for (let i = 0; i < 100; i++) {
      st = await (await fetch(`${API}/api/jobs/${job.id}`)).json();
      if (['done', 'error', 'cancelled'].includes(st.status)) break;
      await new Promise(res => setTimeout(res, 200));
    }
    assert.equal(st.status, 'done', st.error);
    const file = await (await fetch(`${API}/api/jobs/${job.id}/file`)).arrayBuffer();
    const expected = Buffer.concat(fx.plainSegs);
    if (/\.ts$/.test(st.filename)) assert.ok(Buffer.from(file).equals(expected), 'decrypted output must equal plaintext TS');
    console.log('   ->', st.filename, st.bytes, 'bytes', st.warnings);
  });

  await test('extract: trusted-click-only player behind popup/redirect overlays', async () => {
    const before = fx.hits.popups;
    const r = await post('/api/extract', { url: `${fx.SITE}/watch-trusted`, timeout: 40000 });
    const j = await r.json();
    if (!j.success) console.log(j.logs);
    assert.equal(r.status, 200);
    const best = j.candidates[0];
    assert.ok(best.url.includes('/stream/get_video?id=42'), best.url);
    assert.equal(best.type, 'mp4');
    assert.equal(best.size, fx.mp4.length);
    assert.equal(fx.hits.popups, before, 'popup/redirect must never load');
    console.log('   stats:', JSON.stringify(j.stats));
  });

  let packedResult;
  await test('extract: packed (p,a,c,k,e,d) page', async () => {
    const r = await post('/api/extract', { url: `${fx.SITE}/packed`, timeout: 20000 });
    const j = await r.json();
    packedResult = j;
    assert.equal(r.status, 200, JSON.stringify(j).slice(0, 500));
    assert.ok(j.candidates.some(c => c.url.includes('/media/movie_720p.mp4')), JSON.stringify(j.candidates));
  });

  await test('proxy: direct download replays Referer and supports Range', async () => {
    const c = packedResult.candidates.find(x => x.url.includes('movie_720p.mp4'));
    const q = new URLSearchParams({ url: c.url, sid: packedResult.sessionId, referer: c.referer, title: 'Movie ünïcode "q"' });
    const full = await fetch(`${API}/api/download?${q}`);
    if (full.status !== 200) console.log('   candidate:', c, await full.clone().text());
    assert.equal(full.status, 200);
    assert.ok(/filename\*=UTF-8''Movie/.test(full.headers.get('content-disposition')));
    const buf = Buffer.from(await full.arrayBuffer());
    assert.ok(buf.equals(fx.mp4), 'full body matches');
    const part = await fetch(`${API}/api/download?${q}`, { headers: { range: 'bytes=100-199' } });
    assert.equal(part.status, 206);
    assert.ok(Buffer.from(await part.arrayBuffer()).equals(fx.mp4.subarray(100, 200)));
  });

  await test('proxy: without referer the host blocks -> clear 502', async () => {
    const r = await fetch(`${API}/api/download?url=${encodeURIComponent(`${fx.SITE}/media/movie_720p.mp4`)}&referer=${encodeURIComponent('https://evil.example/')}`);
    assert.equal(r.status, 502);
  });

  await test('extract: direct m3u8 URL input skips the browser', async () => {
    const r = await post('/api/extract', { url: `${fx.EMBED}/hls/master.m3u8`, referer: `${fx.EMBED}/embed/1` });
    const j = await r.json();
    assert.equal(j.engine, 'direct');
    assert.equal(j.candidates[0].variants.length, 2);
  });

  await test('commands endpoint includes captured referer', async () => {
    const c = hlsResult.candidates[0];
    const j = await (await fetch(`${API}/api/commands?${new URLSearchParams({ url: c.url, sid: hlsResult.sessionId })}`)).json();
    assert.ok(j.ffmpeg.includes(fx.EMBED), j.ffmpeg);
    assert.ok(j.ytdlp.includes('--referer'), j.ytdlp);
  });

  server.close();
  fx.close();
  await closeBrowsers();
  fs.rmSync(process.env.DOWNLOAD_DIR, { recursive: true, force: true });
  console.log(failures ? `\n${failures} test(s) failed` : '\nAll tests passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
