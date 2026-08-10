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

// 3. Dynamically Scrape Live Apple Music Developer Token
async function getAppleDeveloperToken() {
  if (cachedAppleToken && Date.now() < appleTokenExpiresAt) {
    return cachedAppleToken;
  }

  try {
    console.log('[Apple Motion] Fetching live Apple Music developer token...');
    const res = await fetch('https://music.apple.com/us/browse', {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
    const html = await res.text();

    // Strategy A: Scrape from meta tag
    const metaMatch = html.match(/name="apple-music-developer-token"\s+content="([^"]+)"/);
    if (metaMatch && metaMatch[1]) {
      cachedAppleToken = metaMatch[1];
      appleTokenExpiresAt = Date.now() + 12 * 60 * 60 * 1000;
      console.log('[Apple Motion] Token scraped from meta tag successfully!');
      return cachedAppleToken;
    }

    // Strategy B: Scrape from main JS bundle
    const jsMatch = html.match(/\/assets\/index[^\"]+\.js/);
    if (jsMatch) {
      const jsRes = await fetch(`https://music.apple.com${jsMatch[0]}`);
      const jsText = await jsRes.text();
      const tokenMatch = jsText.match(
        /eyJhbGciOiJFUzI1NiI[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/
      );
      if (tokenMatch) {
        cachedAppleToken = tokenMatch[0];
        appleTokenExpiresAt = Date.now() + 12 * 60 * 60 * 1000;
        console.log('[Apple Motion] Token scraped from JS bundle successfully!');
        return cachedAppleToken;
      }
    }
  } catch (err) {
    console.warn('[Apple Motion] Failed to scrape Apple token:', err.message);
  }
  return null;
}

// 4. Extract Apple Motion Artwork (Prioritizing Tall/Portrait Assets)
async function getAppleMotionUrl(albumTitle, artistName) {
  const searchQuery = `${albumTitle} ${artistName}`;
  console.log(`[Apple Motion] Searching for tall artwork: "${searchQuery}"`);

  // ENGINE 1: Apple Catalog Amp API
  const token = await getAppleDeveloperToken();
  if (token) {
    try {
      const searchUrl = `https://amp-api.music.apple.com/v1/catalog/us/search?term=${encodeURIComponent(
        searchQuery
      )}&types=albums&limit=1`;

      const searchRes = await fetch(searchUrl, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Origin': 'https://music.apple.com',
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
      });

      if (searchRes.ok) {
        const searchData = await searchRes.json();
        const albumId = searchData.results?.albums?.data?.[0]?.id;

        if (albumId) {
          const detailUrl = `https://amp-api.music.apple.com/v1/catalog/us/albums/${albumId}?include=editorialVideo&platform=web`;
          const detailRes = await fetch(detailUrl, {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Origin': 'https://music.apple.com',
              'User-Agent':
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            },
          });

          if (detailRes.ok) {
            const detailData = await detailRes.json();
            const albumObj = detailData.data?.[0];
            const editorialVideo =
              albumObj?.attributes?.editorialVideo ||
              albumObj?.relationships?.editorialVideo?.data?.[0]?.attributes;

            if (editorialVideo) {
              // PRIORITY: Check for tall/portrait assets before square
              const motionObj =
                editorialVideo.motionDetailTall ||
                editorialVideo.motionTall ||
                editorialVideo.motionDetailSquare ||
                editorialVideo.motionSquare;

              const videoUrl =
                motionObj?.video ||
                motionObj?.assets?.[0]?.url ||
                motionObj?.response?.video;

              if (videoUrl) {
                console.log('[Apple Motion] Found video via Amp API!');
                return videoUrl;
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn('[Apple Motion] Engine 1 error:', err.message);
    }
  }

  // ENGINE 2: Unescaped Deep HTML Web Scraper (Fallback)
  try {
    const iTunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(
      searchQuery
    )}&entity=album&limit=3`;
    const searchRes = await fetch(iTunesUrl);
    if (!searchRes.ok) return null;

    const searchData = await searchRes.json();
    const albumUrl = searchData.results?.[0]?.collectionViewUrl;
    if (!albumUrl) return null;

    const pageRes = await fetch(albumUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    if (!pageRes.ok) return null;

    let html = await pageRes.text();
    // Unescape JSON escaped slashes (\/ and \u002F)
    html = html.replace(/\\\/|\\u002F/g, '/');

    // Scan for Apple CDN video URLs (.mp4 or .m3u8)
    const videoMatches = html.match(
      /https?:\/\/[^\s"'<>]+\.(?:mp4|m3u8)[^\s"'<>]*/gi
    );

    if (videoMatches && videoMatches.length > 0) {
      // PRIORITY: Find URLs containing 'tall' or 'portrait' keywords first
      const tallVideo =
        videoMatches.find(
          (u) =>
            u.includes('tall') ||
            u.includes('portrait') ||
            u.includes('3x4') ||
            u.includes('9x16')
        ) || videoMatches[0];

      console.log('[Apple Motion] Found video via Unescaped Scraper!');
      return tallVideo;
    }
  } catch (err) {
    console.warn('[Apple Motion] Engine 2 error:', err.message);
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
