const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'Server is running!' });
});

// Main extraction endpoint (ENHANCED)
app.post('/api/extract', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ 
      success: false, 
      error: 'URL is required' 
    });
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Extracting video from: ${url}`);
  console.log('='.repeat(60));

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    });

    const page = await browser.newPage();
    
    // Set realistic viewport
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Set user agent to look like a real browser
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    let videoUrls = [];
    let m3u8Urls = [];
    let mp4Urls = [];

    // Intercept ALL network requests
    await page.setRequestInterception(true);
    
    page.on('request', (request) => {
      request.continue();
    });

    page.on('response', async response => {
      try {
        const responseUrl = response.url();
        const contentType = response.headers()['content-type'] || '';

        // Look for video files
        if (
          contentType.includes('video') ||
          contentType.includes('mpegurl') ||
          contentType.includes('application/vnd.apple.mpegurl') ||
          responseUrl.match(/\.(mp4|webm|m3u8|mov|avi|mkv|ts)(\?|$|#)/i) ||
          responseUrl.includes('/video/') ||
          responseUrl.includes('stream') ||
          responseUrl.includes('.m3u8')
        ) {
          console.log(`📹 Found video URL: ${responseUrl}`);
          
          if (responseUrl.includes('.m3u8')) {
            console.log(`   ✓ HLS Stream (m3u8): ${responseUrl}`);
            if (!m3u8Urls.includes(responseUrl)) {
              m3u8Urls.push(responseUrl);
            }
          }
          
          if (responseUrl.match(/\.mp4(\?|$|#)/i)) {
            console.log(`   ✓ MP4 Video: ${responseUrl}`);
            if (!mp4Urls.includes(responseUrl)) {
              mp4Urls.push(responseUrl);
            }
          }
          
          if (!videoUrls.includes(responseUrl)) {
            videoUrls.push(responseUrl);
          }
        }
      } catch (err) {
        // Ignore errors from checking responses
      }
    });

    console.log('🌐 Navigating to page...');
    await page.goto(url, { 
      waitUntil: 'networkidle0',
      timeout: 60000 
    });

    console.log('⏳ Waiting for dynamic content to load...');
    
    // Wait for common video player elements
    try {
      await Promise.race([
        page.waitForSelector('video', { timeout: 10000 }),
        page.waitForSelector('.video-js', { timeout: 10000 }),
        page.waitForSelector('[class*="player"]', { timeout: 10000 }),
        new Promise(resolve => setTimeout(resolve, 10000))
      ]);
    } catch (e) {
      console.log('   No video element found yet, continuing...');
    }

    // Additional wait for video to start loading
    await new Promise(resolve => setTimeout(resolve, 8000));

    console.log('🔍 Searching for video sources in DOM...');
    
    // Extract video URLs from DOM
    const domVideoData = await page.evaluate(() => {
      const results = {
        videos: [],
        sources: [],
        iframes: [],
        jwplayer: null,
        videojs: null
      };
      
      // Check for video elements
      document.querySelectorAll('video').forEach(video => {
        if (video.src) results.videos.push(video.src);
        if (video.currentSrc) results.videos.push(video.currentSrc);
        
        video.querySelectorAll('source').forEach(source => {
          if (source.src) results.sources.push(source.src);
        });
      });
      
      // Check for iframes
      document.querySelectorAll('iframe').forEach(iframe => {
        if (iframe.src) results.iframes.push(iframe.src);
      });
      
      // Check for JW Player config
      if (window.jwplayer && typeof window.jwplayer === 'function') {
        try {
          const player = window.jwplayer();
          if (player && player.getPlaylist) {
            const playlist = player.getPlaylist();
            if (playlist && playlist.length > 0) {
              results.jwplayer = playlist[0].sources;
            }
          }
        } catch (e) {}
      }
      
      // Check for Video.js
      if (window.videojs) {
        try {
          const players = document.querySelectorAll('.video-js');
          players.forEach(el => {
            const player = window.videojs(el.id);
            if (player && player.currentSrc) {
              results.videojs = player.currentSrc();
            }
          });
        } catch (e) {}
      }
      
      // Look for video URLs in script tags
      const scripts = Array.from(document.querySelectorAll('script'));
      scripts.forEach(script => {
        const content = script.textContent || '';
        const m3u8Match = content.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/gi);
        const mp4Match = content.match(/https?:\/\/[^\s"']+\.mp4[^\s"']*/gi);
        
        if (m3u8Match) results.sources.push(...m3u8Match);
        if (mp4Match) results.sources.push(...mp4Match);
      });
      
      return results;
    });

    console.log(`📺 DOM Analysis Results:`);
    console.log(`   Video elements: ${domVideoData.videos.length}`);
    console.log(`   Source elements: ${domVideoData.sources.length}`);
    console.log(`   iFrames: ${domVideoData.iframes.length}`);
    
    if (domVideoData.videos.length > 0) {
      domVideoData.videos.forEach(v => {
        if (v && !videoUrls.includes(v)) {
          console.log(`   + Adding from <video>: ${v}`);
          videoUrls.push(v);
          if (v.includes('.mp4')) mp4Urls.push(v);
          if (v.includes('.m3u8')) m3u8Urls.push(v);
        }
      });
    }
    
    if (domVideoData.sources.length > 0) {
      domVideoData.sources.forEach(v => {
        if (v && !videoUrls.includes(v)) {
          console.log(`   + Adding from <source>: ${v}`);
          videoUrls.push(v);
          if (v.includes('.mp4')) mp4Urls.push(v);
          if (v.includes('.m3u8')) m3u8Urls.push(v);
        }
      });
    }

    if (domVideoData.jwplayer) {
      console.log(`   + Found JW Player config`);
      domVideoData.jwplayer.forEach(src => {
        if (src.file && !videoUrls.includes(src.file)) {
          videoUrls.push(src.file);
          if (src.file.includes('.mp4')) mp4Urls.push(src.file);
          if (src.file.includes('.m3u8')) m3u8Urls.push(src.file);
        }
      });
    }

    const title = await page.title();
    await browser.close();

    console.log(`\n📊 FINAL SUMMARY:`);
    console.log(`   Total video URLs found: ${videoUrls.length}`);
    console.log(`   MP4 files: ${mp4Urls.length}`);
    console.log(`   M3U8 streams: ${m3u8Urls.length}`);
    console.log(`   Page title: ${title}`);
    
    // Filter and prioritize URLs
    const filteredUrls = videoUrls.filter(v => {
      const isPageUrl = v === url || v.startsWith(url.split('?')[0]);
      const isVideoFile = v.match(/\.(mp4|webm|m3u8|mov|avi|mkv)(\?|$|#)/i);
      const looksLikeVideo = v.includes('stream') || v.includes('video') || v.includes('/v/');
      return !isPageUrl && (isVideoFile || looksLikeVideo);
    });

    // Prioritize: MP4 first, then M3U8
    const bestVideoUrl = mp4Urls[0] || m3u8Urls[0] || filteredUrls[0] || videoUrls[0];
    
    if (bestVideoUrl) {
      console.log(`✅ Best video URL selected: ${bestVideoUrl}`);
      console.log('='.repeat(60) + '\n');

      // Determine if it's downloadable
      const isM3U8 = bestVideoUrl.includes('.m3u8');
      const isDirectMP4 = bestVideoUrl.includes('.mp4');

      res.json({
        success: true,
        videoUrl: bestVideoUrl,
        allVideoUrls: filteredUrls.length > 0 ? filteredUrls : videoUrls,
        title: title || 'Untitled Video',
        thumbnail: 'https://via.placeholder.com/320x180/4F46E5/ffffff?text=Video',
        isM3U8: isM3U8,
        isDirectMP4: isDirectMP4,
        downloadNote: isM3U8 ? 'This is an HLS stream (.m3u8). You may need a special downloader like FFmpeg or VLC to download it.' : null,
        qualities: (filteredUrls.length > 0 ? filteredUrls : videoUrls).map((url, i) => ({
          quality: url.includes('.m3u8') ? 'HLS Stream' : url.includes('.mp4') ? 'MP4' : `Option ${i + 1}`,
          url: url,
          type: url.includes('.m3u8') ? 'm3u8' : url.includes('.mp4') ? 'mp4' : 'unknown'
        }))
      });
    } else {
      console.log('❌ No video found');
      console.log('='.repeat(60) + '\n');
      
      res.status(404).json({
        success: false,
        error: 'No video found. This site might use DRM, require login, or use a streaming method we don\'t support yet.',
        debugInfo: {
          totalRequests: videoUrls.length,
          foundInDOM: domVideoData.videos.length + domVideoData.sources.length,
          iframes: domVideoData.iframes
        }
      });
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.log('='.repeat(60) + '\n');
    
    if (browser) {
      await browser.close();
    }
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to extract video'
    });
  }
});

// Download proxy endpoint
app.get('/api/download', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).send('URL parameter is required');
  }

  try {
    console.log('Downloading video from:', url);

    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5',
        'Accept-Language': 'en-US,en;q=0.9',
        'Range': 'bytes=0-',
      },
      maxRedirects: 5,
      validateStatus: (status) => status < 400,
    });

    const urlParts = url.split('/');
    const filename = urlParts[urlParts.length - 1].split('?')[0] || `video_${Date.now()}.mp4`;

    res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    
    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }

    response.data.pipe(res);

    response.data.on('error', (error) => {
      console.error('Stream error:', error);
      if (!res.headersSent) {
        res.status(500).send('Failed to download video');
      }
    });

  } catch (error) {
    console.error('Download error:', error.message);
    if (!res.headersSent) {
      res.status(500).send(`Failed to download video: ${error.message}`);
    }
  }
});

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   Video Extractor Backend Server       ║
║   Running on http://localhost:${PORT}   ║
╚════════════════════════════════════════╝
  `);
});