const express = require('express');
const cors = require('cors');
const { Readable } = require('stream');
const Vibrant = require('node-vibrant'); // <-- Added for dynamic color extraction

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
    signal: AbortSignal.timeout(5000), // 5-second timeout
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
    signal: AbortSignal.timeout(5000),
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
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      },
      signal: AbortSignal.timeout(5000), // Prevent infinite hangs
    });
    
    const html = await res.text();

    const metaMatch = html.match(/name="apple-music-developer-token"\s+content="([^"]+)"/);
    if (metaMatch && metaMatch[1]) {
      cachedAppleToken = metaMatch[1];
      appleTokenExpiresAt = Date.now() + 12 * 60 * 60 * 1000;
      console.log('[Apple Motion] Token scraped from meta tag successfully!');
      return cachedAppleToken;
    }

    const jsMatch = html.match(/\/assets\/index[^\"]+\.js/);
    if (jsMatch) {
      const jsRes = await fetch(`https://music.apple.com${jsMatch[0]}`, {
        signal: AbortSignal.timeout(5000),
      });
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
    console.warn(`[Apple Motion] Failed to scrape Apple token: ${err.message}`);
  }
  return null; // Will fallback to Engine 2 if token fetch fails
}

// Helper A: Recursive JSON traversal EXCLUSIVELY for motionDetailTall (skips square keys)
function findTallVideoInJson(obj) {
  if (!obj || typeof obj !== 'object') return null;

  if (obj.motionDetailTall || obj.motionTall) {
    const target = obj.motionDetailTall || obj.motionTall;
    const videoUrl = target?.video || target?.assets?.[0]?.url || target?.response?.video;
    if (videoUrl) return videoUrl;
  }

  for (const key of Object.keys(obj)) {
    if (key === 'motionDetailSquare' || key === 'motionSquare') continue;

    if (typeof obj[key] === 'object' && obj[key] !== null) {
      const result = findTallVideoInJson(obj[key]);
      if (result) return result;
    }
  }

  return null;
}

// Helper B: Isolated text slicing specifically around motionDetailTall
function extractTallUrlFromRawString(str) {
  if (!str) return null;

  const tallIdx = str.indexOf('"motionDetailTall"');
  const tallShortIdx = str.indexOf('"motionTall"');

  const targetIdx = tallIdx !== -1 ? tallIdx : tallShortIdx;
  if (targetIdx === -1) return null;

  const snippet = str.slice(targetIdx, targetIdx + 800);
  const squareInSnippetIdx = snippet.indexOf('"motionDetailSquare"');
  const safeSnippet = squareInSnippetIdx !== -1 ? snippet.slice(0, squareInSnippetIdx) : snippet;

  const urlMatch = safeSnippet.match(/https?:\/\/[^\s"'<>]+\.(?:mp4|m3u8)[^\s"'<>]*/i);
  if (urlMatch) {
    return urlMatch[0].replace(/\\\/|\\u002F/g, '/');
  }

  return null;
}

// 4. Extract Apple Motion Artwork (Strict Tall/Portrait Extraction)
async function getAppleMotionUrl(albumTitle, artistName) {
  const searchQuery = `${albumTitle} ${artistName}`;
  console.log(`[Apple Motion] Searching strictly for tall artwork: "${searchQuery}"`);

  const IPHONE_USER_AGENT =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

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
          'User-Agent': IPHONE_USER_AGENT,
          'Accept-Language': 'en-US',
        },
        signal: AbortSignal.timeout(5000),
      });

      if (searchRes.ok) {
        const searchData = await searchRes.json();
        const albumId = searchData.results?.albums?.data?.[0]?.id;

        if (albumId) {
          const detailUrl = `https://amp-api.music.apple.com/v1/catalog/us/albums/${albumId}?include=editorial-video,editorialVideo&platform=iphone`;
          const detailRes = await fetch(detailUrl, {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Origin': 'https://music.apple.com',
              'User-Agent': IPHONE_USER_AGENT,
              'Accept-Language': 'en-US',
            },
            signal: AbortSignal.timeout(5000),
          });

          if (detailRes.ok) {
            const detailData = await detailRes.json();
            const tallUrl = findTallVideoInJson(detailData);
            if (tallUrl) {
              console.log('[Apple Motion] Found TALL video via Amp API!');
              return tallUrl;
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[Apple Motion] Engine 1 error/timeout: ${err.message}`);
    }
  }

  // ENGINE 2: Web Scraper Fallback (Isolated String Slicing)
  try {
    const iTunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(
      searchQuery
    )}&entity=album&limit=3`;
    const searchRes = await fetch(iTunesUrl, { signal: AbortSignal.timeout(5000) });
    if (!searchRes.ok) return null;

    const searchData = await searchRes.json();
    const albumUrl = searchData.results?.[0]?.collectionViewUrl;
    if (!albumUrl) return null;

    const pageRes = await fetch(albumUrl, {
      headers: { 'User-Agent': IPHONE_USER_AGENT },
      signal: AbortSignal.timeout(6000), // Slightly longer for full HTML doc
    });

    if (!pageRes.ok) return null;

    const html = await pageRes.text();

    const scriptMatches = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
    for (const scriptTag of scriptMatches) {
      if (scriptTag.includes('motionDetailTall') || scriptTag.includes('motionTall')) {
        const cleanScript = scriptTag.replace(/<[^>]+>/g, '').replace(/\\\/|\\u002F/g, '/');
        try {
          const json = JSON.parse(cleanScript);
          const tallUrl = findTallVideoInJson(json);
          if (tallUrl) {
            console.log('[Apple Motion] Found TALL video via Webpage Script JSON!');
            return tallUrl;
          }
        } catch (e) {
          const slicedUrl = extractTallUrlFromRawString(cleanScript);
          if (slicedUrl) {
            console.log('[Apple Motion] Found TALL video via Isolated String Slicing!');
            return slicedUrl;
          }
        }
      }
    }

    const htmlSlicedUrl = extractTallUrlFromRawString(html);
    if (htmlSlicedUrl) {
      console.log('[Apple Motion] Found TALL video via HTML Isolated Slice!');
      return htmlSlicedUrl;
    }
  } catch (err) {
    console.warn(`[Apple Motion] Engine 2 error/timeout: ${err.message}`);
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
      signal: AbortSignal.timeout(5000),
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

// Apple Motion & Dynamic Color Extraction Endpoint
app.get('/api/motion', async (req, res) => {
  try {
    const { album, artist, coverUrl } = req.query;
    if (!album || !artist) {
      return res.status(400).json({ error: 'Both album and artist query parameters are required.' });
    }

    // 1. Fetch Apple Motion URL
    const motionUrl = await getAppleMotionUrl(album, artist);

    // 2. Dynamically Extract Theme Color from the Artwork
    let themeColor = '#2A2E3D'; // Default slate fallback
    if (coverUrl) {
      try {
        const palette = await Vibrant.from(coverUrl).getPalette();
        // Prioritize darker, muted colors to ensure white text remains readable
        themeColor = 
          palette.DarkMuted?.hex || 
          palette.DarkVibrant?.hex || 
          palette.Muted?.hex || 
          themeColor;
      } catch (colorErr) {
        console.warn('[Color] Failed to extract color from URL:', colorErr.message);
      }
    }

    res.json({
      hasMotion: !!motionUrl,
      motionUrl: motionUrl || null,
      themeColor: themeColor, // Send the extracted hex color back to Expo
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
