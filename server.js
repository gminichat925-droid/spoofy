const express = require('express');
const cors = require('cors');
const { Readable } = require('stream');

const app = express();
app.use(cors());

// Credentials loaded from Railway Environment Variables
const CLIENT_ID = process.env.TIDAL_CLIENT_ID || '4N3n6Q1x95LL5K7p';
const CLIENT_SECRET = process.env.TIDAL_CLIENT_SECRET || 'oKOXfJW371cX6xaZ0PyhgGNBdNLlBZd4AKKYougMjik=';
const REFRESH_TOKEN = process.env.TIDAL_REFRESH_TOKEN;

const BASIC_AUTH = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

let cachedAccessToken = null;
let tokenExpiresAt = 0;

// 1. Refresh Access Token automatically when expired
async function getAccessToken() {
  if (!REFRESH_TOKEN) {
    throw new Error('TIDAL_REFRESH_TOKEN environment variable is missing on Railway.');
  }

  // Return cached token if still valid
  if (cachedAccessToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedAccessToken;
  }

  console.log('Refreshing Tidal access token...');
  const res = await fetch('https://auth.tidal.com/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${BASIC_AUTH}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      refresh_token: REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to refresh Tidal token: ${res.status} ${errorText}`);
  }

  const data = await res.json();
  cachedAccessToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  return cachedAccessToken;
}

// 2. Fetch Direct Stream URL from Tidal Manifest
async function getTidalStreamUrl(trackId) {
  const token = await getAccessToken();

  const url = `https://api.tidal.com/v1/tracks/${trackId}/playbackinfostreamurl?audioquality=HIGH&playbackmode=STREAM&assetpresentation=FULL`;

  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'x-tidal-token': CLIENT_ID,
    },
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Tidal API playback info failed: ${res.status} ${errorText}`);
  }

  const data = await res.json();

  if (data.manifest) {
    // Decode Base64 Manifest returned by Tidal
    const decodedManifest = Buffer.from(data.manifest, 'base64').toString('utf-8');
    const manifestJson = JSON.parse(decodedManifest);

    if (manifestJson.urls && manifestJson.urls.length > 0) {
      return manifestJson.urls[0]; // Direct M4A audio stream URL from Tidal CDN
    }
  }

  throw new Error('No audio URL found in Tidal manifest.');
}

// 3. Health Check
app.get('/', (req, res) => {
  res.json({ status: 'online', message: 'Tidal Audio Proxy is running!' });
});

// 4. Search Tracks Endpoint
app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Search query "q" is required' });

    const token = await getAccessToken();
    const searchUrl = `https://api.tidal.com/v1/search/tracks?query=${encodeURIComponent(
      q
    )}&limit=10&countryCode=US`;

    const searchRes = await fetch(searchUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'x-tidal-token': CLIENT_ID,
      },
    });

    if (!searchRes.ok) {
      const errText = await searchRes.text();
      throw new Error(`Search request failed: ${searchRes.status} ${errText}`);
    }

    const searchData = await searchRes.json();
    const tracks = (searchData.items || []).map((t) => ({
      id: t.id,
      title: t.title,
      artist: t.artist?.name,
      album: t.album?.title,
      coverUrl: t.album?.cover
        ? `https://resources.tidal.com/images/${t.album.cover.replace(/-/g, '/')}/320x320.jpg`
        : null,
    }));

    res.json({ tracks });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 5. Audio Range Stream Proxy
app.get('/api/stream', async (req, res) => {
  try {
    const { trackId } = req.query;
    if (!trackId) return res.status(400).json({ error: 'trackId is required' });

    const directStreamUrl = await getTidalStreamUrl(trackId);
    const clientRange = req.headers.range || 'bytes=0-';

    const tidalResponse = await fetch(directStreamUrl, {
      headers: { 'Range': clientRange },
    });

    if (!tidalResponse.ok && tidalResponse.status !== 206) {
      return res.status(tidalResponse.status).json({ error: 'Tidal CDN request failed' });
    }

    res.status(tidalResponse.status);

    const headersToForward = [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
    ];

    headersToForward.forEach((h) => {
      const val = tidalResponse.headers.get(h);
      if (val) res.setHeader(h, val);
    });

    res.setHeader('Accept-Ranges', 'bytes');

    const audioStream = Readable.fromWeb(tidalResponse.body);
    audioStream.pipe(res);
  } catch (error) {
    console.error('Stream Proxy Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || 'Stream proxying failed' });
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
