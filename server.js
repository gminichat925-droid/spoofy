const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const util = require('util');
const path = require('path');
const fs = require('fs');

const execPromise = util.promisify(exec);
const app = express();
app.use(cors());

const COOKIES_PATH = path.join(__dirname, 'cookies.txt');
const YTDLP_PATH = path.join(__dirname, 'yt-dlp');

// 1. Write cookies from environment variable if present
if (process.env.YOUTUBE_COOKIES) {
  fs.writeFileSync(COOKIES_PATH, process.env.YOUTUBE_COOKIES);
  console.log('Successfully created cookies.txt');
}

app.get('/', (req, res) => {
  res.json({ status: 'online', message: 'Music Backend is running!' });
});

// Helper function with automatic cookie fallback
async function getStreamUrl(targetUrl) {
  const binary = fs.existsSync(YTDLP_PATH) ? `"${YTDLP_PATH}"` : 'yt-dlp';
  
  // Use clients that support cookies cleanly (ios, mweb, web)
  const flags = `--no-playlist --force-ipv4 --js-runtimes node --extractor-args "youtube:player_client=ios,mweb,web" -g -f "ba[ext=m4a]/ba/b"`;

  // Attempt 1: Try WITH cookies if file exists
  if (fs.existsSync(COOKIES_PATH)) {
    try {
      const cookieCommand = `${binary} --cookies "${COOKIES_PATH}" ${flags} "${targetUrl}"`;
      const { stdout } = await execPromise(cookieCommand);
      if (stdout.trim()) return stdout.trim();
    } catch (err) {
      console.warn('Cookie attempt failed. Falling back to non-cookie extraction...', err.message);
    }
  }

  // Attempt 2: Fallback WITHOUT cookies
  const noCookieCommand = `${binary} ${flags} "${targetUrl}"`;
  const { stdout } = await execPromise(noCookieCommand);
  return stdout.trim();
}

app.get('/api/stream', async (req, res) => {
  try {
    const { videoId } = req.query;
    if (!videoId) return res.status(400).json({ error: 'videoId is required' });

    const targetUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const streamUrl = await getStreamUrl(targetUrl);

    if (!streamUrl) return res.status(404).json({ error: 'No stream URL returned' });

    res.json({ streamUrl });
  } catch (error) {
    console.error('yt-dlp Execution Error:', error);
    res.status(500).json({
      error: 'Stream extraction failed',
      details: error.message || String(error),
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
