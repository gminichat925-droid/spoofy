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

// Write cookies.txt from environment variable if provided
if (process.env.YOUTUBE_COOKIES) {
  const formattedCookies = process.env.YOUTUBE_COOKIES.replace(/\\n/g, '\n');
  fs.writeFileSync(COOKIES_PATH, formattedCookies);
  console.log('Successfully created cookies.txt');
}

app.get('/', (req, res) => {
  res.json({ status: 'online', message: 'Music Stream Proxy is running!' });
});

// Primary & Fallback API mirrors for zero-downtime extraction
const INVIDIOUS_INSTANCES = [
  'https://inv.tux.pizza',
  'https://invidious.nerdvpn.de',
  'https://invidious.drgns.space',
  'https://vid.puffyan.us',
];

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://api.piped.video',
  'https://pipedapi.palvelu.net',
  'https://pipedapi.adminforge.de',
];

// Fallback 1: Fetch from Invidious Instances
async function fetchFromInvidious(videoId) {
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      console.log(`Trying Invidious API: ${instance}`);
      const res = await fetch(`${instance}/api/v1/videos/${videoId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (!res.ok) continue;

      const data = await res.json();
      if (data && data.adaptiveFormats) {
        const audioFormat = data.adaptiveFormats.find(
          (f) => f.type && f.type.includes('audio/mp4')
        ) || data.adaptiveFormats.find((f) => f.type && f.type.includes('audio'));

        if (audioFormat && audioFormat.url) {
          console.log('Successfully retrieved audio stream from Invidious!');
          return audioFormat.url;
        }
      }
    } catch (err) {
      console.warn(`Invidious instance ${instance} failed:`, err.message);
    }
  }
  return null;
}

// Fallback 2: Fetch from Piped Instances
async function fetchFromPiped(videoId) {
  for (const instance of PIPED_INSTANCES) {
    try {
      console.log(`Trying Piped API: ${instance}`);
      const res = await fetch(`${instance}/streams/${videoId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (!res.ok) continue;

      const data = await res.json();
      if (data && data.audioStreams && data.audioStreams.length > 0) {
        const audioStream =
          data.audioStreams.find(
            (s) => s.mimeType && s.mimeType.includes('audio/mp4')
          ) || data.audioStreams[0];

        if (audioStream && audioStream.url) {
          console.log('Successfully retrieved audio stream from Piped API!');
          return audioStream.url;
        }
      }
    } catch (err) {
      console.warn(`Piped instance ${instance} failed:`, err.message);
    }
  }
  return null;
}

// Multi-Tier Stream URL Extractor
async function getStreamUrl(videoId, targetUrl) {
  const binary = fs.existsSync(YTDLP_PATH) ? `"${YTDLP_PATH}"` : 'yt-dlp';
  const flags = `--no-playlist --force-ipv4 --js-runtimes node --extractor-args "youtube:player_client=ios,mweb,android" -g -f "ba[ext=m4a]/ba/b"`;

  // Tier 1: Try yt-dlp with Cookies
  if (fs.existsSync(COOKIES_PATH)) {
    try {
      console.log('Attempting yt-dlp with cookies...');
      const cookieCmd = `${binary} --cookies "${COOKIES_PATH}" ${flags} "${targetUrl}"`;
      const { stdout } = await execPromise(cookieCmd);
      if (stdout.trim()) return stdout.trim();
    } catch (err) {
      console.warn('yt-dlp with cookies failed:', err.message);
    }
  }

  // Tier 2: Try yt-dlp without Cookies
  try {
    console.log('Attempting yt-dlp without cookies...');
    const noCookieCmd = `${binary} ${flags} "${targetUrl}"`;
    const { stdout } = await execPromise(noCookieCmd);
    if (stdout.trim()) return stdout.trim();
  } catch (err) {
    console.warn('yt-dlp without cookies failed.');
  }

  // Tier 3: Invidious API Mirror Fallback
  console.log('Falling back to Invidious API mirrors...');
  const invidiousUrl = await fetchFromInvidious(videoId);
  if (invidiousUrl) return invidiousUrl;

  // Tier 4: Piped API Fallback
  console.log('Falling back to Piped API mirrors...');
  const pipedUrl = await fetchFromPiped(videoId);
  if (pipedUrl) return pipedUrl;

  throw new Error('All stream extraction methods failed.');
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
      console.error(`Stream fetch status failed: ${youtubeResponse.status}`);
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
