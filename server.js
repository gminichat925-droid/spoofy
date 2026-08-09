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

// 1. Refresh Tidal Access Token
async function getAccessToken() {
  if (!REFRESH_TOKEN) {
    throw new Error('TIDAL_REFRESH_TOKEN environment variable is missing on Railway.');
  }

  if (cachedAccessToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedAccessToken;
  }

  console.log('[Tidal] Refreshing access token...');
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

// 2. Fetch Direct Stream URL from Tidal Manifest
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

// 3. Extract Apple Music Motion Artwork (Token-Free Scraper)
async function getAppleMotionUrl(albumTitle, artistName) {
  try {
    const searchQuery = `${albumTitle} ${artistName}`;
    console.log(`[Apple Motion] Searching iTunes catalog for: "${searchQuery}"`);

    // Step A: Find album on iTunes Search API (no auth required)
    const iTunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(
      searchQuery
    )}&entity=album&limit=3`;

    const searchRes = await fetch(iTunesUrl);
    if (!searchRes.ok) return null;

    const searchData = await searchRes.json();
    const albumUrl = searchData.results?.[0]?.collectionViewUrl;

    if (!albumUrl) {
      console.log('[Apple Motion] No matching album found on iTunes.');
      return null;
    }

    console.log(`[Apple Motion] Found album page: ${albumUrl}`);

    // Step B: Fetch public Apple Music album HTML page
    const pageRes = await fetch(albumUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    if (!pageRes.ok) return null;

    const html = await pageRes.text();

    // Step C: Check serialized JSON state inside the webpage for editorialVideo
    const scriptMatch = html.match(/<script[^>]*id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/i);
    if (scriptMatch && scriptMatch[1]) {
      try {
        const serverData = JSON.parse(scriptMatch[1]);
        const jsonStr = JSON.stringify(serverData);

        // Find video URLs inside serverData structure
        const videoMatch = jsonStr.match(/https?:\/\/video-ssl\.itunes\.apple\.com\/[^\s"'\\]+\.(?:mp4|m3u8)[^\s"'\\]*/i);
        if (videoMatch) {
          console.log('[Apple Motion] Found motion video URL in server data!');
          return videoMatch[0].replace(/\\/g, '');
        }
      } catch (e) {
        // Ignore JSON parse error and fallback to regex scanning
      }
    }

    // Step D: Fallback regex scan directly on HTML
    const directMatches = html.match(/https?:\/\/video-ssl\.itunes\.apple\.com\/[^\s"'\\]+\.(?:mp4|m3u8)[^\s"'\\]*/gi);

    if (directMatches && directMatches.length > 0) {
      // Prioritize square 1:1 motion video assets
      const squareVideo = directMatches.find(
        (url) => url.includes('square') || url.includes('1x1') || url.includes('1:1')
      );
      const selectedUrl = (squareVideo || directMatches[0]).replace(/\\/g, '');
      console.log('[Apple Motion] Found motion video URL via direct HTML match!');
      return selectedUrl;
    }

    console.log('[Apple Motion] Album exists on Apple Music but does not have motion artwork.');
  } catch (err) {
    console.warn('[Apple Motion] Extraction error:', err.message);
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
