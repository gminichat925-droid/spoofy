const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const util = require('util');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');

const execPromise = util.promisify(exec);
const app = express();
app.use(cors());

const COOKIES_PATH = path.join(__dirname, 'cookies.txt');
const YTDLP_PATH = path.join(__dirname, 'yt-dlp');

// 1. Properly format and write cookies.txt from Railway environment variable
if (process.env.YOUTUBE_COOKIES) {
  // Convert escaped literal '\n' strings into actual line breaks if needed
  const formattedCookies = process.env.YOUTUBE_COOKIES.replace(/\\n/g, '\n');
  fs.writeFileSync(COOKIES_PATH, formattedCookies);
  console.log('Successfully created cookies.txt');
}

app.get('/', (req, res) => {
  res.json({ status: 'online', message: 'Music Stream Proxy is running!' });
});

// Helper function to extract direct stream URL via yt-dlp
async function getStreamUrl(targetUrl) {
  const binary = fs.existsSync(YTDLP_PATH) ? `"${YTDLP_PATH}"` : 'yt-dlp';
  
  // Use mweb, ios, tv, android clients (EXCLUDING 'web' which triggers bot checks on cloud IPs)
  const flags = `--no-playlist --force-ipv4 --js-runtimes node --extractor-args "youtube:player_client=mweb,ios,tv,android" -g -f "ba[ext=m4a]/ba/b"`;

  if (fs.existsSync(COOKIES_PATH)) {
    try {
      const cookieCommand = `${binary} --cookies "${COOKIES_PATH}" ${flags} "${targetUrl}"`;
      const { stdout } = await execPromise(cookieCommand);
      if (stdout.trim()) return stdout.trim();
    } catch (err) {
      console.warn('Cookie extraction failed, attempting fallback without cookies...', err.message);
    }
  }

  const noCookieCommand = `${binary} ${flags} "${targetUrl}"`;
  const { stdout } = await execPromise(noCookieCommand);
  return stdout.trim();
}

// 2. HTTP Range Proxy Endpoint
app.get('/api/stream', async (req, res) => {
  try {
    const { videoId } = req.query;
    if (!videoId) return res.status(400).json({ error: 'videoId is required' });

    const targetUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const directStreamUrl = await getStreamUrl(targetUrl);

    if (!directStreamUrl) {
      return res.status(404).json({ error: 'No stream URL returned from yt-dlp' });
    }

    // Forward client Range header or default to full range
    const clientRange = req.headers.range || 'bytes=0-';

    const youtubeResponse = await fetch(directStreamUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Range': clientRange,
      },
    });

    if (!youtubeResponse.ok && youtubeResponse.status !== 206) {
      console.error(`YouTube CDN error status: ${youtubeResponse.status}`);
      return res.status(youtubeResponse.status).json({ error: 'YouTube CDN request failed' });
    }

    res.status(youtubeResponse.status);

    const headersToForward = [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
    ];

    headersToForward.forEach((headerName) => {
      const headerVal = youtubeResponse.headers.get(headerName);
      if (headerVal) {
        res.setHeader(headerName, headerVal);
      }
    });

    res.setHeader('Accept-Ranges', 'bytes');

    const audioStream = Readable.fromWeb(youtubeResponse.body);
    audioStream.pipe(res);

  } catch (error) {
    console.error('Proxy Error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Stream proxying failed',
        details: error.message || String(error),
      });
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
