const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());

const COOKIES_PATH = path.join(__dirname, 'cookies.txt');
const YTDLP_PATH = path.join(__dirname, 'yt-dlp');

// 1. Create cookies.txt if environment variable is present
if (process.env.YOUTUBE_COOKIES) {
  fs.writeFileSync(COOKIES_PATH, process.env.YOUTUBE_COOKIES);
  console.log('Successfully created cookies.txt');
}

app.get('/', (req, res) => {
  res.json({ status: 'online', message: 'Music Stream Proxy is running!' });
});

// 2. Direct Audio Streaming Endpoint
app.get('/api/stream', (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.status(400).json({ error: 'videoId is required' });

  const targetUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const binary = fs.existsSync(YTDLP_PATH) ? YTDLP_PATH : 'yt-dlp';

  // Set headers to force inline stream playback instead of downloading a file
  res.setHeader('Content-Type', 'audio/mp4');
  res.setHeader('Content-Disposition', 'inline; filename="stream.m4a"');

  // yt-dlp arguments:
  // -o - : Output audio bytes directly to stdout
  const args = [
    '--no-playlist',
    '--force-ipv4',
    '--js-runtimes',
    'node',
    '--extractor-args',
    'youtube:player_client=ios,mweb,web',
    '-f',
    'ba[ext=m4a]/ba/b',
    '-o',
    '-',
    targetUrl,
  ];

  if (fs.existsSync(COOKIES_PATH)) {
    args.unshift('--cookies', COOKIES_PATH);
  }

  console.log(`Starting stream for videoId: ${videoId}`);
  const ytdlpProcess = spawn(binary, args);

  // Pipe yt-dlp binary stream straight to Express response
  ytdlpProcess.stdout.pipe(res);

  ytdlpProcess.stderr.on('data', (data) => {
    // Log warnings/progress from yt-dlp
    console.log(`yt-dlp: ${data.toString().trim()}`);
  });

  ytdlpProcess.on('error', (err) => {
    console.error('yt-dlp Spawn Error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to start stream process' });
    }
  });

  // Kill the yt-dlp process if the user closes or pauses the app
  req.on('close', () => {
    console.log(`Client disconnected from videoId: ${videoId}`);
    ytdlpProcess.kill();
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
