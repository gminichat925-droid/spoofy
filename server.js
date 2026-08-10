const express = require('express');
const cors = require('cors');
const { Readable } = require('stream');
const { Vibrant } = require('node-vibrant/node'); 

const app = express();
app.use(cors());

// Credentials loaded from Railway Environment Variables
const CLIENT_ID = process.env.TIDAL_CLIENT_ID || '4N3n6Q1x95LL5K7p';
const CLIENT_SECRET = process.env.TIDAL_CLIENT_SECRET || 'oKOXfJW371cX6xaZ0PyhgGNBdNLlBZd4AKKYougMjik=';
const REFRESH_TOKEN = process.env.TIDAL_REFRESH_TOKEN;
const SPOTIFY_SP_DC = process.env.SPOTIFY_SP_DC;

const BASIC_AUTH = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

let cachedAccessToken = null;
let tokenExpiresAt = 0;

let cachedAppleToken = null;
let appleTokenExpiresAt = 0;
let lastAppleTokenAttempt = 0; // Cooldown tracker to prevent log spam

let cachedSpotifyToken = null;
let spotifyTokenExpiresAt = 0;

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
    signal: AbortSignal.timeout(5000),
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

// 2.5 Helper to Search Tidal by Title and Artist
async function searchTidalForTrack(title, artist) {
  try {
    const token = await getAccessToken();
    const query = `${title} ${artist}`;
    console.log(`[Tidal] Searching for track: "${query}"`);
    const searchUrl = `https://api.tidal.com/v1/search?query=${encodeURIComponent(query)}&limit=5&types=TRACKS&countryCode=US`;

    const searchRes = await fetch(searchUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'x-tidal-token': CLIENT_ID,
      },
      signal: AbortSignal.timeout(5000),
    });

    if (searchRes.ok) {
      const searchData = await searchRes.json();
      const rawItems = searchData.tracks?.items || searchData.items || [];
      if (rawItems.length > 0) {
        console.log(`[Tidal] Found match! Tidal Track ID: ${rawItems[0].id}`);
        return rawItems[0].id;
      }
    }
  } catch (error) {
    console.warn(`[Tidal] Search error: ${error.message}`);
  }
  return null;
}

// 3. Dynamically Scrape Live Apple Music Developer Token
async function getAppleDeveloperToken() {
  // Return cached token if valid
  if (cachedAppleToken && Date.now() < appleTokenExpiresAt) {
    return cachedAppleToken;
  }

  // Cooldown Guard: If scraping failed in the last 10 minutes, skip re-scraping HTML
  if (Date.now() - lastAppleTokenAttempt < 10 * 60 * 1000) {
    return null;
  }

  lastAppleTokenAttempt = Date.now();

  try {
    console.log('[Apple Motion] Fetching live Apple Music developer token...');
    const res = await fetch('https://music.apple.com/us/browse', {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      },
      signal: AbortSignal.timeout(5000),
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

  return null;
}

// 4. Extract Apple Motion Artwork
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

async function getAppleMotionUrl(albumTitle, artistName) {
  const searchQuery = `${albumTitle} ${artistName}`;
  console.log(`[Apple Motion] Searching strictly for tall artwork: "${searchQuery}"`);

  const IPHONE_USER_AGENT =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

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

  try {
    const iTunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(searchQuery)}&entity=album&limit=3`;
    const searchRes = await fetch(iTunesUrl, { signal: AbortSignal.timeout(5000) });
    if (!searchRes.ok) return null;

    const searchData = await searchRes.json();
    const albumUrl = searchData.results?.[0]?.collectionViewUrl;
    if (!albumUrl) return null;

    const pageRes = await fetch(albumUrl, {
      headers: { 'User-Agent': IPHONE_USER_AGENT },
      signal: AbortSignal.timeout(6000),
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
          if (tallUrl) return tallUrl;
        } catch (e) {
          const slicedUrl = extractTallUrlFromRawString(cleanScript);
          if (slicedUrl) return slicedUrl;
        }
      }
    }

    const htmlSlicedUrl = extractTallUrlFromRawString(html);
    if (htmlSlicedUrl) return htmlSlicedUrl;
  } catch (err) {
    console.warn(`[Apple Motion] Engine 2 error/timeout: ${err.message}`);
  }

  return null;
}

// 5. Spotify internal Lyrics Engine (Musixmatch Word-by-Word)
async function getSpotifyToken() {
  if (!SPOTIFY_SP_DC) {
    console.warn('[Spotify] SPOTIFY_SP_DC environment variable is missing.');
    return null;
  }

  if (cachedSpotifyToken && Date.now() < spotifyTokenExpiresAt) {
    return cachedSpotifyToken;
  }

  try {
    const cleanCookie = SPOTIFY_SP_DC.replace('sp_dc=', '').trim();
    
    const headers = {
      'Cookie': `sp_dc=${cleanCookie}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1'
    };

    const res = await fetch('https://open.spotify.com/', {
      headers,
      signal: AbortSignal.timeout(6000),
    });

    const html = await res.text();

    const sessionMatch = html.match(/<script id="session"[^>]*>([^<]+)<\/script>/);
    if (sessionMatch && sessionMatch[1]) {
      try {
        const sessionData = JSON.parse(sessionMatch[1]);
        if (sessionData.isAnonymous) {
          console.warn('[Spotify] sp_dc cookie is invalid or expired (Parsed Anonymous).');
          return null;
        }
        cachedSpotifyToken = sessionData.accessToken;
        spotifyTokenExpiresAt = sessionData.accessTokenExpirationTimestampMs - 60000;
        console.log('[Spotify] ✅ Successfully parsed token from JSON script tag!');
        return cachedSpotifyToken;
      } catch (e) {
        console.warn('[Spotify] Found session script but failed to parse JSON.');
      }
    }

    const tokenMatch = html.match(/"accessToken"\s*:\s*"([^"]+)"/);
    const expiryMatch = html.match(/"accessTokenExpirationTimestampMs"\s*:\s*(\d+)/);
    const isAnonymousMatch = html.match(/"isAnonymous"\s*:\s*(true|false)/);

    if (tokenMatch && tokenMatch[1]) {
      const isAnon = isAnonymousMatch && isAnonymousMatch[1] === 'true';
      if (isAnon) {
        console.warn('[Spotify] sp_dc cookie is invalid or expired (Regex Anonymous).');
        return null;
      }
      cachedSpotifyToken = tokenMatch[1];
      spotifyTokenExpiresAt = expiryMatch ? parseInt(expiryMatch[1], 10) - 60000 : Date.now() + 3000000;
      console.log('[Spotify] ✅ Successfully scraped token via Regex!');
      return cachedSpotifyToken;
    }

    console.warn('[Spotify] ❌ Failed to scrape token. Railway IP might be blocked, or HTML changed.');
    return null;
  } catch (e) {
    console.warn('[Spotify] Fetch error:', e.message);
    return null;
  }
}

async function getSpotifyLyrics(title, artist) {
  const token = await getSpotifyToken();
  if (!token) return null;

  try {
    const query = encodeURIComponent(`track:${title} artist:${artist}`);
    console.log(`[Spotify] Searching for track ID: "${title}" by "${artist}"`);
    
    const searchRes = await fetch(`https://api.spotify.com/v1/search?q=${query}&type=track&limit=1`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    
    const searchData = await searchRes.json();
    const trackId = searchData.tracks?.items?.[0]?.id;
    if (!trackId) {
      console.warn(`[Spotify] Track not found in search.`);
      return null;
    }

    console.log(`[Spotify] Fetching lyrics for Track ID: ${trackId}`);
    const lyricsRes = await fetch(`https://spclient.wg.spotify.com/color-lyrics/v2/track/${trackId}?format=json&market=from_token`, {
      headers: {
        'App-Platform': 'WebPlayer',
        'Authorization': `Bearer ${token}`
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!lyricsRes.ok) return null;
    const lyricsData = await lyricsRes.json();
    
    if (!lyricsData || !lyricsData.lyrics) return null;

    const spotifyLyrics = lyricsData.lyrics;
    const isWordByWord = spotifyLyrics.syncType === 'SYLLABLE_SYNCED';
    let lrcString = '';
    let plainString = '';

    spotifyLyrics.lines.forEach(line => {
      plainString += line.words + '\n';

      if (!line.startTimeMs) return;
      const lineTime = parseInt(line.startTimeMs, 10);
      const lMins = String(Math.floor(lineTime / 60000)).padStart(2, '0');
      const lSecs = ((lineTime % 60000) / 1000).toFixed(2).padStart(5, '0');
      
      let lineContent = '';

      if (isWordByWord && line.syllables && line.syllables.length > 0) {
        line.syllables.forEach(syllable => {
           const sylTime = parseInt(syllable.startTimeMs, 10);
           if (isNaN(sylTime)) {
             lineContent += syllable.words;
           } else {
             const sMins = String(Math.floor(sylTime / 60000)).padStart(2, '0');
             const sSecs = ((sylTime % 60000) / 1000).toFixed(2).padStart(5, '0');
             lineContent += `<${sMins}:${sSecs}>${syllable.words}`;
           }
        });
      } else {
        lineContent = line.words;
      }

      lrcString += `[${lMins}:${lSecs}]${lineContent}\n`;
    });

    console.log(`[Spotify] ✅ Success! Word-by-Word: ${isWordByWord}`);
    return {
      found: true,
      isWordByWord: isWordByWord,
      plainLyrics: plainString.trim(),
      syncedLyrics: lrcString.trim()
    };
  } catch (err) {
    console.warn(`[Spotify] Lyrics fetch error: ${err.message}`);
    return null;
  }
}

// 6. Fallback LRCLIB Lyrics Engine
async function getLrclibLyrics(title, artist) {
  const USER_AGENT = 'SpoofyApp/1.0 (spoofy@example.com)';
  try {
    const searchUrl = new URL('https://lrclib.net/api/search');
    searchUrl.searchParams.append('q', `${title} ${artist}`);

    console.log(`[LRCLIB] Fallback searching for lyrics: "${title} ${artist}"`);
    const res = await fetch(searchUrl.toString(), {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      const results = await res.json();
      if (results && results.length > 0) {
        const enhancedLrcRegex = /<\d{2}:\d{2}\.\d{2,3}>/;
        const wordByWordMatch = results.find(r => r.syncedLyrics && enhancedLrcRegex.test(r.syncedLyrics));
        
        if (wordByWordMatch) return { ...wordByWordMatch, isWordByWord: true };
        
        const lineByLineMatch = results.find(r => r.syncedLyrics);
        if (lineByLineMatch) return { ...lineByLineMatch, isWordByWord: false };

        return { ...results[0], isWordByWord: false };
      }
    }
  } catch (err) {
    console.warn(`[LRCLIB] Lyrics fetch error: ${err.message}`);
  }
  return null;
}

// --- ENDPOINTS ---

app.get('/', (req, res) => {
  res.json({ status: 'online', message: 'Tidal Audio, Apple Motion & Spotify Lyrics Proxy is running!' });
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
    let { trackId, title, artist } = req.query;
    
    if (!trackId && (!title || !artist)) {
      return res.status(400).json({ error: 'trackId OR (title and artist) is required' });
    }

    // Resolve Tidal trackId using title and artist from Spotify
    if (!trackId) {
      trackId = await searchTidalForTrack(title, artist);
      if (!trackId) {
        return res.status(404).json({ error: 'Track not found on Tidal' });
      }
    }

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

    const motionUrl = await getAppleMotionUrl(album, artist);

    let themeColor = '#2A2E3D';
    if (coverUrl) {
      try {
        const palette = await Vibrant.from(coverUrl).getPalette();
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
      themeColor: themeColor,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Lyrics Endpoint (Spotify -> LRCLIB Fallback)
app.get('/api/lyrics', async (req, res) => {
  try {
    const { title, artist } = req.query;
    
    if (!title || !artist) {
      return res.status(400).json({ error: 'Both title and artist query parameters are required.' });
    }

    // Try Spotify first
    let lyricsData = await getSpotifyLyrics(title, artist);
    
    // If Spotify fails or sp_dc isn't set, fallback to LRCLIB
    if (!lyricsData) {
      const fallbackData = await getLrclibLyrics(title, artist);
      if (fallbackData) {
        lyricsData = {
          found: true,
          isWordByWord: fallbackData.isWordByWord,
          plainLyrics: fallbackData.plainLyrics || null,
          syncedLyrics: fallbackData.syncedLyrics || null,
        };
      }
    }

    if (lyricsData) {
      res.json(lyricsData);
    } else {
      res.json({ found: false, message: 'No lyrics found for this track across all engines.' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
