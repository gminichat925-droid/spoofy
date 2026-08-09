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

app.get('/api/stream', async (req, res) => {
  try {
    const { videoId } = req.query;
    if (!videoId) return res.status(400).json({ error: 'videoId required' });

    const targetUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // Execute yt-dlp using cookies if file exists
    let command = `yt-dlp -g -f "ba[ext=m4a]/ba/b" "${targetUrl}"`;
    if (fs.existsSync(COOKIES_PATH)) {
      command = `yt-dlp --cookies "${COOKIES_PATH}" -g -f "ba[ext=m4a]/ba/b" "${targetUrl}"`;
    }

    const { stdout } = await execPromise(command);
    const streamUrl = stdout.trim();

    if (!streamUrl) return res.status(404).json({ error: 'No stream found' });

    res.json({ streamUrl });
  } catch (error) {
    console.error('yt-dlp Error:', error.message);
    res.status(500).json({ error: 'Stream extraction failed' });
  }
});

// 2. Bind to process.env.PORT provided by Railway
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
