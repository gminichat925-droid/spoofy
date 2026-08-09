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
  const formattedCookies = process.env.YOUTUBE_COOKIES.replace(/\\n/g, '\n');
  fs.writeFileSync(COOKIES_PATH, formattedCookies);
  console.log('Successfully created cookies.txt');
}

app.get('/', (req, res) => {
  res.json({ status: 'online', message: 'Music Stream Proxy is running!' });
});

// List of public Piped API instances used as a fallback when Railway IP gets 429 blocked
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://api.piped.video',
  'https://pipedapi.palvelu.net',
  'https://pipedapi.adminforge.de',
];

// Fallback stream fetcher via Piped API
async function fetchFromPiped(videoId) {
  for (const instance of PIPED_INSTANCES) {
    try {
      console.log(`Trying Piped API instance: ${instance}`);
      const response = await fetch(`${instance}/streams/${videoId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (!response.ok) continue;

      const data = await response.json();
      if (data && data.audioStreams && data.audioStreams.length > 0) {
        // Find M4A/MP4 audio stream or default to first audio stream
        const audioStream =
          data.audioStreams.find(
            (s) => s.mimeType && s.mimeType.includes('audio/mp4')
          ) || data.audioStreams[0];

        if (audioStream && audioStream.url) {
          console.log('Successfully fetched stream URL from Piped API fallback!');
          return audioStream.url;
        }
      }
    } catch (err) {
      console.warn(`Piped instance ${instance} failed:`, err.message);
    }
  }
  return null;
}

// Multi-tier stream URL extractor
async function getStreamUrl(videoId, targetUrl) {
  const binary = fs.existsSync(YTDLP_PATH) ? `"${YTDLP_PATH}"` : 'yt-dlp';
  const flags = `--no-playlist --force-ipv4 --js-runtimes node --extractor-args "youtube:player_client=ios,mweb,android" -g -f "ba[ext=m4a]/ba/b"`;

  // Tier 1: Try yt-dlp WITH cookies
  if (fs.existsSync(COOKIES_PATH)) {
    try {
      console.log('Attempting yt-dlp with cookies...');
      const cookieCommand = `${binary} --cookies "${COOKIES_PATH}" ${flags} "${targetUrl}"`;
      const { stdout } = await execPromise(cookieCommand);
      if (stdout.trim()) return stdout.trim();
    } catch (err) {
      console.warn('yt-dlp with cookies failed:', err.message);
    }
  }

  // Tier 2: Try yt-dlp WITHOUT cookies
  try {
    console.log('Attempting yt-dlp without cookies...');
    const noCookieCommand = `${binary} ${flags} "${targetUrl}"`;
    const { stdout } = await execPromise(noCookieCommand);
    if (stdout.trim()) return stdout.trim();
  } catch (err) {
    console.warn('yt-dlp without cookies failed (HTTP 429 / Bot check).');
  }

  // Tier 3: Fallback to Piped API (Bypasses Railway IP blocks)
  console.log('Falling back to Piped API instances...');
  const pipedUrl = await fetchFromPiped(videoId);
  if (pipedUrl) return pipedUrl;

  throw new Error('All stream extraction methods failed (yt-dlp & Piped API)');
}

// HTTP Range Proxy Endpoint
app.get('/api/stream', async (req, res) => {
  try {
    const { videoId } = req.query;
    if (!videoId) return res.status(400).json({ error: 'videoId is required' });

    const targetUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const directStreamUrl = await getStreamUrl(videoId, targetUrl);

    if (!directStreamUrl) {
      return res.status(404).json({ error: 'No stream URL returned' });
    }

    const clientRange = req.headers.range || 'bytes=0-';

    const youtubeResponse = await fetch(directStreamUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Range': clientRange,
      },
    });

    if (!youtubeResponse.ok && youtubeResponse.status !== 206) {
      console.error(`Stream fetch failed with status: ${youtubeResponse.status}`);
      return res.status(youtubeResponse.status).json({ error: 'Stream fetch failed' });
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
