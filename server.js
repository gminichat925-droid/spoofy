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

if (process.env.YOUTUBE_COOKIES) {
  fs.writeFileSync(COOKIES_PATH, process.env.YOUTUBE_COOKIES);
  console.log('Successfully created cookies.txt');
}

app.get('/', (req, res) => {
  res.json({ status: 'online', message: 'Music Backend Proxy is running!' });
});

async function getStreamUrl(targetUrl) {
  const binary = fs.existsSync(YTDLP_PATH) ? `"${YTDLP_PATH}"` : 'yt-dlp';
  const flags = `--no-playlist --force-ipv4 --js-runtimes node --extractor-args "youtube:player_client=ios,mweb,web" -g -f "ba[ext=m4a]/ba/b"`;

  if (fs.existsSync(COOKIES_PATH)) {
    try {
      const cookieCommand = `${binary} --cookies "${COOKIES_PATH}" ${flags} "${targetUrl}"`;
      const { stdout } = await execPromise(cookieCommand);
      if (stdout.trim()) return stdout.trim();
    } catch (err) {
      console.warn('Cookie attempt failed. Retrying without cookies...', err.message);
    }
  }

  const noCookieCommand = `${binary} ${flags} "${targetUrl}"`;
  const { stdout } = await execPromise(noCookieCommand);
  return stdout.trim();
}

// Audio Proxy Endpoint
app.get('/api/stream', async (req, res) => {
  try {
    const { videoId } = req.query;
    if (!videoId) return res.status(400).json({ error: 'videoId is required' });

    const targetUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const streamUrl = await getStreamUrl(targetUrl);

    if (!streamUrl) return res.status(404).json({ error: 'No stream URL returned' });

    // Fetch stream from YouTube on Railway (matching Railway's IP)
    const response = await fetch(streamUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: 'YouTube stream fetch failed' });
    }

    // Set headers so audio players identify it as an audio file
    res.setHeader('Content-Type', 'audio/m4a');
    if (response.headers.get('content-length')) {
      res.setHeader('Content-Length', response.headers.get('content-length'));
    }

    // Pipe the audio stream straight through to the client app
    const audioStream = Readable.fromWeb(response.body);
    audioStream.pipe(res);
  } catch (error) {
    console.error('Proxy Error:', error);
    res.status(500).json({
      error: 'Stream proxying failed',
      details: error.message || String(error),
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
