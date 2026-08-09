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

let cachedAppleToken = null;
let appleTokenExpiresAt = 0;

// 1. Refresh Tidal Access Token
async function getAccessToken() {
  if (!REFRESH_TOKEN) {
    throw new Error('TIDAL_REFRESH_TOKEN environment variable is missing on Railway.');
  }

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
      scope: 'r_usr w_usr',
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

// 2. Dynamically Scrape Live Apple Music Developer Token
async function getAppleDeveloperToken() {
  if (cachedAppleToken && Date.now() < appleTokenExpiresAt) {
    return cachedAppleToken;
  }

  try {
    console.log('Fetching fresh Apple Music developer token...');
    const homeRes = await fetch('https://music.apple.com', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });
    const html = await homeRes.text();

    const jsMatch = html.match(/\/assets\/index[^\"]+\.js/);
    if (!jsMatch) throw new Error('Could not locate Apple Music JS bundle');

    const jsRes = await fetch(`https://music.apple.com${jsMatch[0]}`);
    const jsText = await jsRes.text();

    const tokenMatch = jsText.match(
      /eyJhbGciOiJFUzI1NiI[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/
    );

    if (tokenMatch) {
      cachedAppleToken = tokenMatch[0];
      appleTokenExpiresAt = Date.now() + 12 * 60 * 60 * 1000; // Cache 12 Hours
      console.log('Successfully acquired live Apple Music Developer Token!');
      return cachedAppleToken;
    }
  } catch (err) {
    console.warn('Failed to scrape Apple Music token:', err.message);
  }
  return null;
}

// 3. Fetch Direct Stream URL from Tidal Manifest
async function getTidalStreamUrl(trackId) {
  const token = await getAccessToken();

  const url = `https://api.tidal.com/v1/tracks/${trackId}/playbackinfopostpaywall?audioquality=HIGH&playbackmode=STREAM&assetpresentation=FULL`;

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
    const decodedManifest = Buffer.from(data.manifest, 'base64').toString('utf-8');

    try {
      const manifestJson = JSON.parse(decodedManifest);
      if (manifestJson.urls && manifestJson.urls.length > 0) {
        return manifestJson.urls[0];
      }
    } catch (e) {
      const urlMatch = decodedManifest.match(/https?:\/\/[^\s"<]+/);
      if (urlMatch) return urlMatch[0];
    }
  }

  throw new Error('No audio URL found in Tidal manifest.');
}

// 4. Extract Apple Music Motion Video Artwork
async function getAppleMotionUrl(albumTitle, artistName) {
  const token = await getAppleDeveloperToken();
  if (!token) return null;

  try {
    const query = `${albumTitle} ${artistName}`;
    const searchUrl = `https://amp-api.music.apple.com/v1/catalog/us/search?term=${encodeURIComponent(
      query
    )}&types=albums&limit=1`;

    const searchRes = await fetch(searchUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Origin': 'https://music.apple.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
    });

    if (!searchRes.ok) return null;

    const searchData = await searchRes.json();
    const albumId = searchData.results?.albums?.data?.[0]?.id;

    if (!albumId) return null;

    // Request detailed album metadata with editorialVideo included
    const albumDetailUrl = `https://amp-api.music.apple.com/v1/catalog/us/albums/${albumId}?include=editorialVideo`;
    const detailRes = await fetch(albumDetailUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Origin': 'https://music.apple.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
    });

    if (!detailRes.ok) return null;

    const detailData = await detailRes.json();
    const albumObj = detailData.data?.[0];
    const editorialVideo =
      albumObj?.attributes?.editorialVideo ||
      albumObj?.relationships?.editorialVideo?.data?.[0]?.attributes;

    if (!editorialVideo) return null;

    const motionObj =
      editorialVideo.motionDetailSquare ||
      editorialVideo.motionSquare ||
      editorialVideo.motionDetailTall ||
      editorialVideo.motionTall;

    if (motionObj) {
      return (
        motionObj.video ||
        motionObj.assets?.[0]?.url ||
        motionObj.response?.video ||
        null
      );
    }
  } catch (err) {
    console.warn('Apple Motion fetch error:', err.message);
  }
  return null;
}

// --- ENDPOINTS ---

app.get('/', (req, res) => {
  res.json({ status: 'online', message: 'Tidal Audio & Apple Motion Proxy is running!' });
});

// Search Tracks
app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) {
      return res.status(400).json({ error: 'Search query "q" parameter is required.' });
    }

    const token = await getAccessToken();
    const searchUrl = `https://api.tidal.com/v1/search?query=${encodeURIComponent(
      q
    )}&limit=10&types=TRACKS&countryCode=US`;

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
    const rawItems = searchData.tracks?.items || searchData.items || [];

    const tracks = rawItems.map((t) => ({
      id: t.id,
      title: t.title,
      artist: t.artist?.name || t.artists?.[0]?.name || 'Unknown Artist',
      album: t.album?.title || 'Unknown Album',
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

// Audio Stream Proxy
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

// Apple Motion Artwork Endpoint
app.get('/api/motion', async (req, res) => {
  try {
    const { album, artist } = req.query;
    if (!album || !artist) {
      return res.status(400).json({ error: 'Both album and artist query parameters are required.' });
    }

    const motionUrl = await getAppleMotionUrl(album, artist);

    res.json({
      hasMotion: !!motionUrl,
      motionUrl: motionUrl || null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
