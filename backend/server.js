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

// Main extraction endpoint
app.post('/api/extract', async (req, res) => {
  const { url } = req.body;

  // Validate URL
  if (!url) {
    return res.status(400).json({ 
      success: false, 
      error: 'URL is required' 
    });
  }

  console.log(`Extracting video from: ${url}`);

  let browser;
  try {
    // Launch browser
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    
    // Set viewport
    await page.setViewport({ width: 1920, height: 1080 });

    let videoUrl = null;
    let videoUrls = [];

    // Intercept network requests to find video URLs
    page.on('response', async response => {
      try {
        const responseUrl = response.url();
        const contentType = response.headers()['content-type'] || '';

        // Check if response is a video
        if (
          contentType.includes('video') ||
          responseUrl.includes('.mp4') ||
          responseUrl.includes('.m3u8') ||
          responseUrl.includes('.webm') ||
          responseUrl.includes('video')
        ) {
          console.log('Found video URL:', responseUrl);
          videoUrls.push(responseUrl);
          if (!videoUrl) {
            videoUrl = responseUrl;
          }
        }
      } catch (err) {
        // Ignore errors from checking responses
      }
    });

    // Navigate to the page
    console.log('Navigating to page...');
    await page.goto(url, { 
      waitUntil: 'networkidle2',
      timeout: 30000 
    });

    // Wait for potential video to load
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Try to find video element in DOM
    const domVideoUrl = await page.evaluate(() => {
      const video = document.querySelector('video');
      if (video) {
        return video.src || video.currentSrc || 
               (video.querySelector('source') && video.querySelector('source').src);
      }
      return null;
    });

    if (domVideoUrl && !videoUrl) {
      videoUrl = domVideoUrl;
      videoUrls.push(domVideoUrl);
    }

    // Try to get page title
    const title = await page.title();

    await browser.close();

    if (videoUrl) {
      console.log('✓ Video extracted successfully!');
      res.json({
        success: true,
        videoUrl: videoUrl,
        title: title || 'Untitled Video',
        allUrls: videoUrls,
        thumbnail: 'https://via.placeholder.com/320x180/4F46E5/ffffff?text=Video',
        qualities: [
          { quality: 'Original', url: videoUrl }
        ]
      });
    } else {
      console.log('✗ No video found');
      res.status(404).json({
        success: false,
        error: 'No video found on this page. The site might not be supported or requires login.'
      });
    }

  } catch (error) {
    console.error('Error:', error.message);
    if (browser) {
      await browser.close();
    }
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to extract video'
    });
  }
});

// Download proxy endpoint (IMPROVED VERSION)
app.get('/api/download', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).send('URL parameter is required');
  }

  try {
    console.log('Downloading video from:', url);

    // Make request with proper headers
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

    // Get filename from URL or use default
    const urlParts = url.split('/');
    const filename = urlParts[urlParts.length - 1].split('?')[0] || `video_${Date.now()}.mp4`;

    // Set proper headers for download
    res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    
    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }

    // Pipe video stream to response
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
║   Running on http://localhost:${PORT}  ║
╚════════════════════════════════════════╝
  `);
});