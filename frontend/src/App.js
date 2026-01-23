import React, { useState } from 'react';
import { Download, Video, AlertCircle, Loader2, Copy, CheckCircle, ExternalLink } from 'lucide-react';

function App() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const extractVideo = async (inputUrl) => {
    const response = await fetch('http://localhost:3001/api/extract', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: inputUrl }),
    });

    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.error || 'Failed to extract video');
    }
    
    return data;
  };

  const handleExtract = async () => {
    if (!url.trim()) {
      setError('Please enter a valid URL');
      return;
    }

    try {
      new URL(url);
    } catch {
      setError('Please enter a valid URL (must start with http:// or https://)');
      return;
    }

    setLoading(true);
    setError('');
    setResult(null);

    try {
      const data = await extractVideo(url);
      setResult(data);
    } catch (err) {
      setError(err.message || 'Failed to extract video. The site might not be supported.');
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = (text) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = (videoUrl) => {
    const downloadUrl = `http://localhost:3001/api/download?url=${encodeURIComponent(videoUrl)}`;
    window.location.href = downloadUrl;
  };

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(to bottom right, #eef2ff, #ffffff, #faf5ff)' }}>
      <div style={{ maxWidth: '56rem', margin: '0 auto', padding: '3rem 1rem' }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: '3rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '1rem' }}>
            <Video size={48} color="#4f46e5" />
          </div>
          <h1 style={{ fontSize: '2.5rem', fontWeight: 'bold', color: '#111827', marginBottom: '0.75rem' }}>
            Video URL Extractor
          </h1>
          <p style={{ fontSize: '1.125rem', color: '#6b7280' }}>
            Extract direct video URLs from websites - no ads, no hassle
          </p>
        </div>

        {/* Main Card */}
        <div style={{ background: 'white', borderRadius: '1rem', boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)', padding: '2rem', marginBottom: '2rem' }}>
          {/* URL Input */}
          <div style={{ marginBottom: '1.5rem' }}>
            <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: '500', color: '#374151', marginBottom: '0.5rem' }}>
              Video Page URL
            </label>
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleExtract()}
                placeholder="https://example.com/video/12345"
                style={{
                  flex: 1,
                  padding: '0.75rem 1rem',
                  border: '1px solid #d1d5db',
                  borderRadius: '0.5rem',
                  outline: 'none',
                  fontSize: '1rem'
                }}
                disabled={loading}
              />
              <button
                onClick={handleExtract}
                disabled={loading}
                style={{
                  padding: '0.75rem 1.5rem',
                  background: loading ? '#9ca3af' : '#4f46e5',
                  color: 'white',
                  borderRadius: '0.5rem',
                  border: 'none',
                  cursor: loading ? 'not-allowed' : 'pointer',
                  fontWeight: '500',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem'
                }}
              >
                {loading ? (
                  <>
                    <Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} />
                    Extracting...
                  </>
                ) : (
                  <>
                    <Download size={20} />
                    Extract
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Error Message */}
          {error && (
            <div style={{ marginBottom: '1.5rem', padding: '1rem', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '0.5rem', display: 'flex', gap: '0.75rem' }}>
              <AlertCircle size={20} color="#dc2626" style={{ flexShrink: 0, marginTop: '0.125rem' }} />
              <div>
                <p style={{ color: '#991b1b', fontWeight: '500', margin: 0 }}>Error</p>
                <p style={{ color: '#b91c1c', fontSize: '0.875rem', margin: '0.25rem 0 0 0' }}>{error}</p>
              </div>
            </div>
          )}

          {/* Results */}
          {result && (
            <div style={{ marginTop: '1.5rem' }}>
              {/* Video Info */}
              <div style={{ border: '1px solid #e5e7eb', borderRadius: '0.5rem', overflow: 'hidden', marginBottom: '1.5rem' }}>
                <div style={{ display: 'flex', gap: '1rem', padding: '1rem' }}>
                  <img
                    src={result.thumbnail}
                    alt="Video thumbnail"
                    style={{ width: '160px', height: '96px', objectFit: 'cover', borderRadius: '0.25rem' }}
                  />
                  <div style={{ flex: 1 }}>
                    <h3 style={{ fontWeight: '600', fontSize: '1.125rem', color: '#111827', margin: '0 0 0.25rem 0' }}>
                      {result.title}
                    </h3>
                    <p style={{ fontSize: '0.875rem', color: '#6b7280', margin: 0 }}>
                      Found {result.allVideoUrls?.length || 1} video URL(s)
                    </p>
                  </div>
                </div>
              </div>

              {/* Show all found video URLs */}
              {result.allVideoUrls && result.allVideoUrls.length > 1 && (
                <div style={{ marginBottom: '1.5rem', padding: '1rem', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: '0.5rem' }}>
                  <p style={{ fontSize: '0.875rem', fontWeight: '500', color: '#92400e', margin: '0 0 0.5rem 0' }}>
                    Multiple videos found - Select the correct one:
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {result.allVideoUrls.map((videoUrl, index) => (
                      <div key={index} style={{ 
                        display: 'flex', 
                        alignItems: 'center', 
                        gap: '0.5rem',
                        padding: '0.5rem',
                        background: 'white',
                        borderRadius: '0.25rem',
                        fontSize: '0.75rem',
                        fontFamily: 'monospace'
                      }}>
                        <input
                          type="radio"
                          name="videoUrl"
                          checked={result.videoUrl === videoUrl}
                          onChange={() => setResult({...result, videoUrl: videoUrl})}
                          style={{ cursor: 'pointer' }}
                        />
                        <span style={{ flex: 1, wordBreak: 'break-all', color: '#374151' }}>
                          {videoUrl}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Direct Video URL */}
              <div style={{ border: '1px solid #86efac', background: '#f0fdf4', borderRadius: '0.5rem', padding: '1rem', marginBottom: '1.5rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                  <label style={{ fontSize: '0.875rem', fontWeight: '500', color: '#15803d' }}>
                    Selected Video URL
                  </label>
                  <button
                    onClick={() => handleCopy(result.videoUrl)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.25rem',
                      fontSize: '0.875rem',
                      color: '#15803d',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer'
                    }}
                  >
                    {copied ? (
                      <>
                        <CheckCircle size={16} />
                        Copied!
                      </>
                    ) : (
                      <>
                        <Copy size={16} />
                        Copy
                      </>
                    )}
                  </button>
                </div>
                <div style={{
                  background: 'white',
                  border: '1px solid #86efac',
                  borderRadius: '0.25rem',
                  padding: '0.75rem',
                  fontSize: '0.875rem',
                  color: '#374151',
                  fontFamily: 'monospace',
                  wordBreak: 'break-all'
                }}>
                  {result.videoUrl}
                </div>
              </div>

              {/* Action Buttons */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {result.isM3U8 && (
                  <div style={{ padding: '1rem', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: '0.5rem' }}>
                    <p style={{ fontSize: '0.875rem', color: '#92400e', margin: 0 }}>
                      <strong>⚠️ HLS Stream Detected:</strong> This is a streaming format (.m3u8). 
                      To download, you'll need to use tools like <strong>FFmpeg</strong>, <strong>VLC Media Player</strong>, 
                      or online M3U8 downloaders. The "Watch" button will open it in your browser.
                    </p>
                  </div>
                )}
                
                <div style={{ display: 'flex', gap: '0.75rem' }}>
                  <button
                    onClick={() => handleDownload(result.videoUrl)}
                    disabled={result.isM3U8}
                    style={{
                      flex: 1,
                      padding: '0.75rem 1.5rem',
                      background: result.isM3U8 ? '#9ca3af' : '#4f46e5',
                      color: 'white',
                      borderRadius: '0.5rem',
                      border: 'none',
                      cursor: result.isM3U8 ? 'not-allowed' : 'pointer',
                      fontWeight: '500',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '0.5rem'
                    }}
                  >
                    <Download size={20} />
                    {result.isM3U8 ? 'M3U8 - Use FFmpeg' : 'Download Video'}
                  </button>
                  <button
                    onClick={() => window.open(result.videoUrl, '_blank')}
                    style={{
                      padding: '0.75rem 1.5rem',
                      border: '1px solid #d1d5db',
                      color: '#374151',
                      borderRadius: '0.5rem',
                      background: 'white',
                      cursor: 'pointer',
                      fontWeight: '500',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem'
                    }}
                  >
                    <Video size={20} />
                    {result.isM3U8 ? 'Open Stream' : 'Watch'}
                  </button>
                </div>
                
                {result.isM3U8 && (
                  <button
                    onClick={() => handleCopy(`ffmpeg -i "${result.videoUrl}" -c copy output.mp4`)}
                    style={{
                      padding: '0.75rem 1.5rem',
                      border: '1px solid #4f46e5',
                      color: '#4f46e5',
                      borderRadius: '0.5rem',
                      background: 'white',
                      cursor: 'pointer',
                      fontWeight: '500',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '0.5rem'
                    }}
                  >
                    <Copy size={20} />
                    Copy FFmpeg Command
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* How It Works */}
        <div style={{ background: 'white', borderRadius: '0.75rem', boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1)', padding: '1.5rem' }}>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 'bold', color: '#111827', marginBottom: '1rem' }}>How It Works</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', color: '#374151' }}>
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <span style={{ 
                flexShrink: 0, 
                width: '1.5rem', 
                height: '1.5rem', 
                background: '#eef2ff', 
                color: '#4f46e5', 
                borderRadius: '50%', 
                display: 'flex', 
                alignItems: 'center', 
                justifyContent: 'center', 
                fontSize: '0.875rem', 
                fontWeight: 'bold' 
              }}>1</span>
              <p style={{ margin: 0 }}>Paste the URL of any video page</p>
            </div>
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <span style={{ 
                flexShrink: 0, 
                width: '1.5rem', 
                height: '1.5rem', 
                background: '#eef2ff', 
                color: '#4f46e5', 
                borderRadius: '50%', 
                display: 'flex', 
                alignItems: 'center', 
                justifyContent: 'center', 
                fontSize: '0.875rem', 
                fontWeight: 'bold' 
              }}>2</span>
              <p style={{ margin: 0 }}>Our server extracts the direct video URL</p>
            </div>
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <span style={{ 
                flexShrink: 0, 
                width: '1.5rem', 
                height: '1.5rem', 
                background: '#eef2ff', 
                color: '#4f46e5', 
                borderRadius: '50%', 
                display: 'flex', 
                alignItems: 'center', 
                justifyContent: 'center', 
                fontSize: '0.875rem', 
                fontWeight: 'bold' 
              }}>3</span>
              <p style={{ margin: 0 }}>Stream or download directly - no ads!</p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{ textAlign: 'center', marginTop: '2rem', fontSize: '0.875rem', color: '#9ca3af' }}>
          For educational purposes only. Respect copyright and terms of service.
        </div>
      </div>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

export default App;  // THIS LINE IS CRITICAL!