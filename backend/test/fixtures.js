'use strict';

/**
 * Local fixture servers that imitate an ad-infested streaming site:
 *  - SITE (origin A): page with alert(), popup-on-click overlay, redirect hijack,
 *    and an <iframe> to EMBED (origin B).
 *  - EMBED (origin B): click-jacking overlay + play button. Clicking play calls
 *    an API (Referer-protected) that returns an escaped JSON with an HLS master
 *    URL, then loads it like hls.js would.
 *  - HLS: master (2 variants) -> AES-128 encrypted media playlist whose TS
 *    segments are disguised with a fake PNG header. Key + segments require
 *    the embed Referer.
 *  - /packed: page whose MP4 URL is only inside a p,a,c,k,e,d packed script.
 *    The MP4 supports Range and requires the Referer.
 */
const http = require('http');
const crypto = require('crypto');

function pack(code) {
  const words = [...new Set(code.match(/\b\w+\b/g))];
  const radix = 62;
  const enc = (n) => (n < radix ? '' : enc(Math.floor(n / radix))) + ((n = n % radix) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
  const idx = new Map(words.map((w, i) => [w, enc(i)]));
  const payload = code.replace(/\b\w+\b/g, w => idx.get(w)).replace(/'/g, "\\'");
  return `eval(function(p,a,c,k,e,d){e=function(c){return(c<a?'':e(parseInt(c/a)))+((c=c%a)>35?String.fromCharCode(c+29):c.toString(36))};if(!''.replace(/^/,String)){while(c--){d[e(c)]=k[c]||e(c)}k=[function(e){return d[e]}];e=function(){return'\\\\w+'};c=1};while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}('${payload}',${radix},${words.length},'${words.join('|')}'.split('|'),0,{}))`;
}

function makeTsSegment(i) {
  // 40 TS packets of 188 bytes, each starting with sync byte 0x47.
  const b = Buffer.alloc(188 * 40);
  for (let p = 0; p < 40; p++) {
    b[p * 188] = 0x47;
    crypto.randomFillSync(b, p * 188 + 1, 187);
    b[p * 188 + 1] = i; // make segments distinguishable
  }
  return b;
}

async function start() {
  const key = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const plainSegs = Array.from({ length: 5 }, (_, i) => makeTsSegment(i));
  const pngHeader = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const encSegs = plainSegs.map(s => {
    const c = crypto.createCipheriv('aes-128-cbc', key, iv);
    return Buffer.concat([c.update(s), c.final()]);
  });
  const mp4 = crypto.randomBytes(3 * 1024 * 1024);
  mp4.write('....ftypisom', 0, 'latin1');

  const hits = { popups: 0, adNav: 0 };
  let SITE, EMBED;

  const embedServer = http.createServer((req, res) => {
    const u = new URL(req.url, EMBED);
    const ref = req.headers.referer || '';
    const fromEmbed = ref.startsWith(EMBED);
    const deny = () => { res.writeHead(403); res.end('hotlink denied'); };

    if (u.pathname === '/embed/1') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<!doctype html><html><head><title>embed</title>
<style>#p{position:relative;width:640px;height:360px;background:#000}
#ov{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0)}
.vjs-big-play-button{position:absolute;left:280px;top:150px;width:80px;height:60px;background:#fff}</style></head>
<body><div id="p" class="player"><video id="v" width="640" height="360"></video><div class="vjs-big-play-button"></div></div>
<div id="ov"></div>
<script>
  document.getElementById('ov').addEventListener('click', function(){ window.open('${SITE}/ad-popup'); this.remove(); });
  document.querySelector('.vjs-big-play-button').addEventListener('click', async function(){
    if (window.__started) return; window.__started = true;
    const r = await fetch('/api/source?id=1'); const j = await r.json();
    const m = await (await fetch(j.data.file)).text();
    const variant = new URL(m.split('\\n').find(l => l && !l.startsWith('#')), j.data.file).href;
    const media = await (await fetch(variant)).text();
    const seg = new URL(media.split('\\n').find(l => l && !l.startsWith('#')), variant).href;
    await fetch(seg);
    const v = document.getElementById('v');
    v.src = URL.createObjectURL(new MediaSource());
  });
</script></body></html>`);
    }
    if (u.pathname === '/embed/2') {
      // Play only reacts to *trusted* clicks; an invisible overlay eats the first click.
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<!doctype html><html><body style="margin:0">
<div id="box" style="position:relative;width:640px;height:360px;background:#111">
  <img src="/poster.jpg" style="width:640px;height:360px">
  <div id="ov" style="position:absolute;inset:0;z-index:50"></div>
</div>
<script>
  document.getElementById('ov').addEventListener('click', function(e){ window.open('${SITE}/ad-popup'); top.location.href='${SITE}/ad-popup'; this.remove(); });
  document.getElementById('box').addEventListener('click', function(e){
    if (!e.isTrusted || window.__p) return; window.__p = 1;
    const v = document.createElement('video'); v.width = 640; v.height = 360;
    v.src = '/stream/get_video?id=42'; this.innerHTML = ''; this.appendChild(v); v.play().catch(function(){});
  });
</script></body></html>`);
    }
    if (u.pathname === '/stream/get_video') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': mp4.length, 'accept-ranges': 'bytes' });
      return res.end(mp4);
    }
    if (u.pathname === '/api/source') {
      if (!fromEmbed) return deny();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: { file: `${EMBED}/hls/master.m3u8?token=abc` } }).replace(/\//g, '\\/'));
    }
    if (u.pathname === '/hls/master.m3u8') {
      if (!fromEmbed) return deny();
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720\nhigh/index.m3u8\n');
    }
    if (/^\/hls\/(low|high)\/index\.m3u8$/.test(u.pathname)) {
      if (!fromEmbed) return deny();
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      let pl = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-KEY:METHOD=AES-128,URI="/hls/key.bin",IV=0x${iv.toString('hex')}\n`;
      encSegs.forEach((_, i) => { pl += `#EXTINF:4.0,\nseg${i}.png\n`; });
      return res.end(pl + '#EXT-X-ENDLIST\n');
    }
    if (u.pathname === '/hls/key.bin') {
      if (!fromEmbed) return deny();
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(key);
    }
    const sm = u.pathname.match(/^\/hls\/(?:low|high)\/seg(\d)\.png$/);
    if (sm) {
      if (!fromEmbed) return deny();
      // Note: fake PNG header is prepended to the *ciphertext*? No: hosts add it
      // to the plaintext TS. We emulate the common variant: encrypted payload
      // of (pngHeader + ts). Re-encrypt here.
      const c = crypto.createCipheriv('aes-128-cbc', key, iv);
      const body = Buffer.concat([c.update(Buffer.concat([pngHeader, plainSegs[+sm[1]]])), c.final()]);
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(body);
    }
    res.writeHead(404); res.end();
  });

  const siteServer = http.createServer((req, res) => {
    const u = new URL(req.url, SITE);
    if (u.pathname === '/watch') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<!doctype html><html><head><title>Watch Test Movie (2024) - FreeStream</title>
<meta property="og:image" content="${SITE}/thumb.jpg"></head><body>
<script>alert('Allow notifications!');</script>
<div id="cover" style="position:fixed;inset:0;z-index:1000"></div>
<iframe src="${EMBED}/embed/1" width="700" height="400" allowfullscreen></iframe>
<script>
  document.getElementById('cover').addEventListener('click', function(){ window.open('${SITE}/ad-popup'); this.remove(); });
  document.addEventListener('click', function(){ setTimeout(function(){ location.href = 'http://127.0.0.1:1/ad-redirect'; }, 10); }, { once: true });
</script></body></html>`);
    }
    if (u.pathname === '/watch-trusted') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<!doctype html><html><head><title>Trusted</title></head><body>
<a href="${SITE}/ad-popup" target="_blank" style="position:fixed;inset:0;z-index:999;display:block"></a>
<iframe src="${EMBED}/embed/2" width="640" height="360" style="border:0"></iframe>
<script>document.querySelector('a').addEventListener('click', function(){ var a=this; setTimeout(function(){ a.remove(); }, 0); });</script>
</body></html>`);
    }
    if (u.pathname === '/packed') {
      res.writeHead(200, { 'content-type': 'text/html' });
      const code = `var player=jwsetup({file:"${SITE}/media/movie_720p.mp4?e=999&s=sig",image:"${SITE}/thumb.jpg"});`;
      return res.end(`<!doctype html><html><head><title>Packed Host</title></head><body><div id="vplayer"></div>
<script>${pack(code)}</script></body></html>`);
    }
    if (u.pathname === '/ad-popup') { hits.popups++; res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<h1>AD</h1>'); }
    if (u.pathname.startsWith('/media/movie_720p.mp4')) {
      if (!(req.headers.referer || '').startsWith(SITE)) { res.writeHead(403); return res.end('no'); }
      const range = req.headers.range;
      if (range) {
        const [s, e] = range.replace('bytes=', '').split('-');
        const start = Number(s); const end = e ? Number(e) : mp4.length - 1;
        res.writeHead(206, {
          'content-type': 'video/mp4', 'accept-ranges': 'bytes',
          'content-range': `bytes ${start}-${end}/${mp4.length}`, 'content-length': end - start + 1,
        });
        return res.end(mp4.subarray(start, end + 1));
      }
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': mp4.length, 'accept-ranges': 'bytes' });
      return res.end(mp4);
    }
    res.writeHead(404); res.end();
  });

  await new Promise(r => siteServer.listen(0, '127.0.0.1', r));
  await new Promise(r => embedServer.listen(0, 'localhost', r));
  SITE = `http://127.0.0.1:${siteServer.address().port}`;
  EMBED = `http://localhost:${embedServer.address().port}`;
  return {
    SITE, EMBED, hits, plainSegs, mp4,
    close: () => { siteServer.close(); embedServer.close(); },
  };
}

module.exports = { start, pack };
