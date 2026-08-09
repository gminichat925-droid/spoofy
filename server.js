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

if (process.env.YOUTUBE_COOKIES) {
  fs.writeFileSync(COOKIES_PATH, process.env.YOUTUBE_COOKIES);
  console.log('Successfully created cookies.txt');
}

app.get('/', (req, res) => {
  res.json({ status: 'online', message: 'Music Backend is running!' });
});

app.get('/api/stream', async (req, res) => {
  try {
    const { videoId } = req.query;
    if (!videoId) return res.status(400).json({ error: 'videoId is required' });

    const targetUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const binary = fs.existsSync(YTDLP_PATH) ? `"${YTDLP_PATH}"` : 'yt-dlp';

    // Flags:
    // --js-runtimes node : Solves YouTube's JS n-challenge using Node.js
    // --extractor-args "youtube:player_client=android,web" : Bypasses SABR experiment restrictions
    // -f "140/ba[ext=m4a]/ba[acodec=mp4a]/ba" : Strictly prioritizes m4a/AAC format so iOS and Android native players can play the audio
    let flags = `--no-playlist --force-ipv4 --js-runtimes node --extractor-args "youtube:player_client=android,web" -g -f "140/ba[ext=m4a]/ba[acodec=mp4a]/ba"`;

    let command = `${binary} ${flags} "${targetUrl}"`;
    if (fs.existsSync(COOKIES_PATH)) {
      command = `${binary} --cookies "${COOKIES_PATH}" ${flags} "${targetUrl}"`;
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
