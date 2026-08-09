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

// 1. Auto-create cookies.txt from environment variable on server boot
if (process.env.YOUTUBE_COOKIES) {
  fs.writeFileSync(COOKIES_PATH, process.env.YOUTUBE_COOKIES);
  console.log('Successfully created cookies.txt from environment variable.');
}

// 2. Health check root endpoint
app.get('/', (req, res) => {
  res.json({ status: 'online', message: 'Music Backend is running!' });
});

// 3. Audio stream extraction endpoint
app.get('/api/stream', async (req, res) => {
  try {
    const { videoId } = req.query;
    if (!videoId) return res.status(400).json({ error: 'videoId is required' });

    const targetUrl = `https://www.youtube.com/watch?v=${videoId}`;

    let command = `yt-dlp --no-playlist --force-ipv4 -g -f "ba[ext=m4a]/ba/b" "${targetUrl}"`;
    if (fs.existsSync(COOKIES_PATH)) {
      command = `yt-dlp --cookies "${COOKIES_PATH}" --no-playlist --force-ipv4 -g -f "ba[ext=m4a]/ba/b" "${targetUrl}"`;
    }

    const { stdout } = await execPromise(command);
    const streamUrl = stdout.trim();

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

// 4. Bind to PORT provided by Railway
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
