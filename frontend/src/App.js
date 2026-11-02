import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Download, Video, AlertCircle, Loader2, Copy, CheckCircle, ExternalLink, Settings, Play, X,
  Server, Terminal, ShieldCheck, Film,
} from 'lucide-react';
import './App.css';

const API = process.env.REACT_APP_API_URL ||
  (window.location.port === '3000' ? 'http://127.0.0.1:3001' : '');

const TYPE_LABEL = {
  hls: 'HLS (.m3u8)', dash: 'DASH (.mpd)', mp4: 'MP4', webm: 'WebM', mkv: 'MKV', mov: 'MOV',
  flv: 'FLV', video: 'Video', audio: 'Audio', ytdlp: 'yt-dlp',
};
const DIRECT = new Set(['mp4', 'webm', 'mkv', 'mov', 'flv', 'video', 'audio']);

function fmtBytes(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function fmtDuration(s) {
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(sec).padStart(2, '0')}`;
}

async function api(path, opts = {}) {
  const r = await fetch(API + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  let data = null;
  try { data = await r.json(); } catch { /* non-json */ }
  if (!r.ok) {
    const err = new Error((data && data.error) || `Request failed (${r.status})`);
    err.data = data;
    throw err;
  }
  return data;
}

function useCopy() {
  const [copied, setCopied] = useState(null);
  const copy = useCallback(async (text, key = text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  }, []);
  return [copied, copy];
}

export default function App() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [errorData, setErrorData] = useState(null);
  const [health, setHealth] = useState(null);
  const [showOpts, setShowOpts] = useState(false);
  const [opts, setOpts] = useState({ engine: 'auto', timeout: 45, blockAds: true, headless: true });
  const [jobs, setJobs] = useState([]);
  const [copied, copy] = useCopy();
  const startedAt = useRef(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    api('/api/health').then(setHealth).catch(() => setHealth({ offline: true }));
  }, []);

  useEffect(() => {
    if (!loading) return undefined;
    startedAt.current = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - startedAt.current) / 1000)), 500);
    return () => clearInterval(t);
  }, [loading]);

  // Poll jobs while any is active.
  const refreshJobs = useCallback(() => api('/api/jobs').then(setJobs).catch(() => {}), []);
  useEffect(() => { refreshJobs(); }, [refreshJobs]);
  const active = jobs.some(j => j.status === 'running' || j.status === 'queued');
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(refreshJobs, 1000);
    return () => clearInterval(t);
  }, [active, refreshJobs]);

  const extract = async (targetUrl = url, referer) => {
    const u = (targetUrl || '').trim();
    if (!u) { setError('Please enter a URL'); return; }
    try {
      const p = new URL(u);
      if (!/^https?:$/.test(p.protocol)) throw new Error();
    } catch {
      setError('Please enter a valid URL (must start with http:// or https://)');
      return;
    }
    setUrl(u);
    setLoading(true);
    setError('');
    setErrorData(null);
    setResult(null);
    try {
      const data = await api('/api/extract', {
        method: 'POST',
        body: JSON.stringify({
          url: u, referer, engine: opts.engine, timeout: opts.timeout * 1000,
          blockAds: opts.blockAds, headless: opts.headless,
        }),
      });
      setResult(data);
    } catch (err) {
      setError(err.message === 'Failed to fetch'
        ? `Cannot reach the backend at ${API || window.location.origin}. Is it running?`
        : err.message);
      setErrorData(err.data || null);
    } finally {
      setLoading(false);
    }
  };

  const startJob = async (body) => {
    try {
      await api('/api/jobs', { method: 'POST', body: JSON.stringify({ ...body, sid: result?.sessionId, title: result?.title }) });
      refreshJobs();
    } catch (e) {
      setError(e.message);
    }
  };

  const tools = health?.tools || {};

  return (
    <div className="app">
      <div className="container">
        <header className="header">
          <Video size={44} className="accent" />
          <h1>Video URL Extractor</h1>
          <p className="muted">Extract and download videos from ad-heavy sites. Popups, redirects and overlays are blocked for you.</p>
          <div className="tools">
            {health?.offline ? (
              <span className="chip chip-bad">backend offline</span>
            ) : (
              <>
                <span className={`chip ${health ? 'chip-ok' : ''}`}><Server size={12} /> backend</span>
                <span className={`chip ${tools.ffmpeg ? 'chip-ok' : 'chip-off'}`} title={tools.ffmpeg || 'not installed: run npm run setup-tools in backend/'}>ffmpeg</span>
                <span className={`chip ${tools.ytdlp ? 'chip-ok' : 'chip-off'}`} title={tools.ytdlp || 'not installed: run npm run setup-tools in backend/'}>yt-dlp</span>
              </>
            )}
          </div>
        </header>

        <section className="card">
          <label className="label" htmlFor="url">Video page URL</label>
          <div className="row">
            <input
              id="url"
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !loading && extract()}
              placeholder="https://example.com/watch/12345"
              disabled={loading}
            />
            <button className="btn btn-primary" onClick={() => extract()} disabled={loading}>
              {loading ? <><Loader2 size={18} className="spin" /> {elapsed}s</> : <><Download size={18} /> Extract</>}
            </button>
            <button className="btn btn-ghost" onClick={() => setShowOpts(s => !s)} title="Options" aria-label="Options">
              <Settings size={18} />
            </button>
          </div>

          {showOpts && (
            <div className="opts">
              <label>
                Engine
                <select value={opts.engine} onChange={(e) => setOpts({ ...opts, engine: e.target.value })}>
                  <option value="auto">Auto (browser, then yt-dlp)</option>
                  <option value="browser">Browser sniffer only</option>
                  <option value="ytdlp" disabled={!tools.ytdlp}>yt-dlp only</option>
                </select>
              </label>
              <label>
                Timeout (s)
                <input type="number" min="10" max="180" value={opts.timeout}
                  onChange={(e) => setOpts({ ...opts, timeout: Number(e.target.value) || 45 })} />
              </label>
              <label className="check">
                <input type="checkbox" checked={opts.blockAds} onChange={(e) => setOpts({ ...opts, blockAds: e.target.checked })} />
                Block ad networks
              </label>
              <label className="check" title="Opens a visible Chrome window on the server machine. Useful for Cloudflare / captcha.">
                <input type="checkbox" checked={!opts.headless} onChange={(e) => setOpts({ ...opts, headless: !e.target.checked })} />
                Show browser window
              </label>
            </div>
          )}

          {loading && (
            <p className="muted small">Loading the page, killing popups and pressing play... this usually takes 10–40 seconds.</p>
          )}

          {error && (
            <div className="alert alert-error">
              <AlertCircle size={18} />
              <div>
                <strong>Error</strong>
                <p>{error}</p>
                {errorData?.iframes?.length > 0 && (
                  <IframeList iframes={errorData.iframes} onExtract={(src) => extract(src, errorData.pageUrl || url)} />
                )}
                {errorData?.warnings?.map((w) => <p key={w} className="small">⚠️ {w}</p>)}
                {errorData?.logs?.length > 0 && <Logs logs={errorData.logs} />}
              </div>
            </div>
          )}

          {result && (
            <Result
              result={result}
              tools={tools}
              copied={copied}
              copy={copy}
              startJob={startJob}
              onExtractIframe={(src) => extract(src, result.pageUrl || url)}
            />
          )}
        </section>

        {jobs.length > 0 && <Jobs jobs={jobs} refresh={refreshJobs} />}

        <section className="card how">
          <h2>How it works</h2>
          <ol>
            <li>A headless Chrome opens the page with popups, new tabs, redirect hijacks, alerts and known ad networks blocked.</li>
            <li>It presses play (JS + real mouse clicks), removes click-jacking overlays and sniffs every frame&apos;s network traffic, player configs and (packed / base64) scripts.</li>
            <li>Direct files stream through the server with the right Referer/cookies; HLS is downloaded segment-by-segment (AES-128 supported); DASH and 1800+ sites via ffmpeg / yt-dlp.</li>
          </ol>
        </section>

        <footer className="muted small center">For personal use only. Respect copyright and the site&apos;s terms of service. DRM-protected streams are not supported.</footer>
      </div>
    </div>
  );
}

function Result({ result, tools, copied, copy, startJob, onExtractIframe }) {
  const [thumbOk, setThumbOk] = useState(true);
  const s = result.stats || {};
  return (
    <div className="result">
      <div className="meta">
        {result.thumbnail && thumbOk ? (
          <img src={result.thumbnail} alt="" onError={() => setThumbOk(false)} referrerPolicy="no-referrer" />
        ) : (
          <div className="thumb-ph"><Film size={32} /></div>
        )}
        <div>
          <h3>{result.title}</h3>
          <p className="muted small">
            {result.candidates.length} candidate(s) · engine: {result.engine}
            {result.elapsedMs ? ` · ${(result.elapsedMs / 1000).toFixed(1)}s` : ''}
          </p>
          <div className="chips">
            {s.popupsBlocked > 0 && <span className="chip chip-ok"><ShieldCheck size={12} /> {s.popupsBlocked} popups blocked</span>}
            {s.navBlocked > 0 && <span className="chip chip-ok"><ShieldCheck size={12} /> {s.navBlocked} redirects blocked</span>}
            {s.adsBlocked > 0 && <span className="chip chip-ok"><ShieldCheck size={12} /> {s.adsBlocked} ad requests blocked</span>}
            {result.usesMSE && <span className="chip">MSE player</span>}
          </div>
        </div>
      </div>

      {result.warnings?.map((w) => (
        <div key={w} className="alert alert-warn"><AlertCircle size={16} /><p>{w}</p></div>
      ))}

      <div className="cands">
        {result.candidates.map((c, i) => (
          <Candidate key={c.url} c={c} best={i === 0} result={result} tools={tools} copied={copied} copy={copy} startJob={startJob} />
        ))}
      </div>

      {result.iframes?.length > 0 && (
        <details className="details">
          <summary>Embedded players / iframes ({result.iframes.length})</summary>
          <IframeList iframes={result.iframes} onExtract={onExtractIframe} />
        </details>
      )}
      {result.logs?.length > 0 && <Logs logs={result.logs} />}
    </div>
  );
}

function Candidate({ c, best, result, tools, copied, copy, startJob }) {
  const [variant, setVariant] = useState(c.variants?.[0]?.url || '');
  const [format, setFormat] = useState('');
  const [preview, setPreview] = useState(false);
  const [cmds, setCmds] = useState(null);

  const q = (extra = {}) => new URLSearchParams({
    url: c.url, sid: result.sessionId || '', referer: c.referer || '', title: result.title || '', ...extra,
  }).toString();
  const proxyUrl = `${API}/api/download?${q()}`;
  const isDirect = DIRECT.has(c.type);
  const blocked = !!c.drm;

  const loadCmds = async () => {
    if (cmds) { setCmds(null); return; }
    try { setCmds(await api(`/api/commands?${q()}`)); } catch (e) { setCmds({ error: e.message }); }
  };

  return (
    <div className={`cand ${best ? 'cand-best' : ''} ${c.isAd ? 'cand-ad' : ''}`}>
      <div className="cand-head">
        <span className={`badge badge-${c.type}`}>{TYPE_LABEL[c.type] || c.type}</span>
        {best && <span className="badge badge-best">best match</span>}
        {c.label && <span className="muted small">{c.label}</span>}
        {c.size ? <span className="muted small">{fmtBytes(c.size)}</span> : null}
        {c.duration ? <span className="muted small">{fmtDuration(c.duration)}</span> : null}
        {c.encrypted && !c.drm && <span className="chip">AES-128</span>}
        {c.drm && <span className="chip chip-bad">DRM: {c.drm}</span>}
        {c.live && <span className="chip chip-warn">live</span>}
        {c.isAd && <span className="chip chip-bad">ad?</span>}
        <span className="muted small grow right" title={`score ${c.score} · found via ${c.sources?.join(', ')}`}>
          via {c.sources?.join(', ')}
        </span>
      </div>
      <div className="url mono">{c.url}</div>

      {c.variants?.length > 0 && (
        <label className="inline">
          Quality
          <select value={variant} onChange={(e) => setVariant(e.target.value)}>
            {c.variants.map(v => <option key={v.url} value={v.url}>{v.label}</option>)}
          </select>
          {c.hasSeparateAudio && !tools.ffmpeg && <span className="small warn-text">separate audio track: install ffmpeg to merge</span>}
        </label>
      )}
      {c.formats?.length > 0 && (
        <label className="inline">
          Format
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="">Best available</option>
            {c.formats.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </label>
      )}

      <div className="actions">
        {isDirect && (
          <a className={`btn btn-primary ${blocked ? 'disabled' : ''}`} href={proxyUrl}>
            <Download size={16} /> Download
          </a>
        )}
        {isDirect && (
          <button className="btn" onClick={() => startJob({ kind: 'direct', url: c.url, referer: c.referer })}>
            <Server size={16} /> Save on server
          </button>
        )}
        {c.type === 'hls' && (
          <button className="btn btn-primary" disabled={blocked}
            onClick={() => startJob({ kind: 'hls', url: c.url, referer: c.referer, variantUrl: variant || undefined })}>
            <Download size={16} /> Download {tools.ffmpeg ? 'MP4' : '(.ts)'}
          </button>
        )}
        {c.type === 'hls' && tools.ffmpeg && (
          <button className="btn" disabled={blocked}
            onClick={() => startJob({ kind: 'ffmpeg', url: variant || c.url, referer: c.referer })}>
            via ffmpeg
          </button>
        )}
        {c.type === 'dash' && (
          <button className="btn btn-primary" disabled={blocked || (!tools.ffmpeg && !tools.ytdlp)}
            title={!tools.ffmpeg && !tools.ytdlp ? 'Needs ffmpeg or yt-dlp' : ''}
            onClick={() => startJob({ kind: tools.ffmpeg ? 'ffmpeg' : 'ytdlp', url: c.url, referer: c.referer })}>
            <Download size={16} /> Download {!tools.ffmpeg && !tools.ytdlp ? '(needs ffmpeg)' : ''}
          </button>
        )}
        {c.type === 'ytdlp' && (
          <button className="btn btn-primary" disabled={!tools.ytdlp}
            onClick={() => startJob({ kind: 'ytdlp', url: c.url, referer: c.referer, format: format || undefined })}>
            <Download size={16} /> Download with yt-dlp
          </button>
        )}
        {(c.type === 'hls' || c.type === 'dash') && tools.ytdlp && (
          <button className="btn" disabled={blocked}
            onClick={() => startJob({ kind: 'ytdlp', url: c.url, referer: c.referer })}>
            via yt-dlp
          </button>
        )}
        {isDirect && c.type !== 'audio' && (
          <button className="btn" onClick={() => setPreview(p => !p)}><Play size={16} /> {preview ? 'Hide' : 'Preview'}</button>
        )}
        <button className="btn" onClick={() => copy(c.url, c.url)}>
          {copied === c.url ? <><CheckCircle size={16} /> Copied</> : <><Copy size={16} /> URL</>}
        </button>
        {c.type !== 'ytdlp' && (
          <button className="btn" onClick={loadCmds}><Terminal size={16} /> Commands</button>
        )}
        <a className="btn" href={c.url} target="_blank" rel="noreferrer noopener"><ExternalLink size={16} /> Open</a>
      </div>

      {preview && (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video className="preview" src={`${API}/api/download?${q({ inline: '1' })}`} controls autoPlay muted />
      )}

      {cmds && (
        <div className="cmds">
          {cmds.error ? <p className="small">{cmds.error}</p> : ['ffmpeg', 'ytdlp', 'curl'].map(k => (
            <div key={k} className="cmd">
              <div className="cmd-head">
                <span className="small">{k}</span>
                <button className="btn btn-xs" onClick={() => copy(cmds[k], k + c.url)}>
                  {copied === k + c.url ? 'Copied' : 'Copy'}
                </button>
              </div>
              <pre className="mono">{cmds[k]}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Jobs({ jobs, refresh }) {
  const cancel = async (id) => { await api(`/api/jobs/${id}`, { method: 'DELETE' }).catch(() => {}); refresh(); };
  return (
    <section className="card">
      <h2>Downloads</h2>
      <div className="jobs">
        {jobs.map(j => (
          <div key={j.id} className={`job job-${j.status}`}>
            <div className="job-head">
              <span className="badge">{j.kind}</span>
              <strong className="grow ellipsis">{j.filename || j.title || j.id}</strong>
              <span className="small muted">{j.status}</span>
              {(j.status === 'running' || j.status === 'queued') && (
                <button className="btn btn-xs" onClick={() => cancel(j.id)}><X size={14} /> Cancel</button>
              )}
              {j.status === 'done' && (
                <a className="btn btn-xs btn-primary" href={`${API}/api/jobs/${j.id}/file`}><Download size={14} /> Save file</a>
              )}
            </div>
            {(j.status === 'running' || j.status === 'queued') && (
              <div className="bar"><div style={{ width: `${Math.round((j.progress || 0) * 100)}%` }} /></div>
            )}
            <div className="small muted">
              {j.error || j.message}{j.bytes && j.status === 'done' ? ` · ${fmtBytes(j.bytes)}` : ''}
            </div>
            {j.warnings?.map(w => <div key={w} className="small warn-text">⚠️ {w}</div>)}
          </div>
        ))}
      </div>
    </section>
  );
}

function IframeList({ iframes, onExtract }) {
  return (
    <div className="iframes">
      {iframes.map(f => (
        <div key={f.src} className="iframe-row">
          <span className="mono small grow ellipsis" title={f.src}>{f.src}</span>
          {f.width ? <span className="small muted">{f.width}×{f.height}</span> : null}
          <button className="btn btn-xs" onClick={() => onExtract(f.src)}>Extract this</button>
        </div>
      ))}
    </div>
  );
}

function Logs({ logs }) {
  return (
    <details className="details">
      <summary>Extraction log</summary>
      <pre className="mono logs">{logs.join('\n')}</pre>
    </details>
  );
}
