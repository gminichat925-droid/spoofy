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
const SPOTIFY_SP_DC = process.env.SPOTIFY_SP_DC; // New Spotify Cookie

const BASIC_AUTH = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

let cachedAccessToken = null;
let tokenExpiresAt = 0;

let cachedAppleToken = null;
let appleTokenExpiresAt = 0;
let lastAppleTokenAttempt = 0; 

let cachedSpotifyToken = null;
let spotifyTokenExpiresAt = 0;

// 1. Refresh Tidal Access Token
async function getAccessToken() {
  if (!REFRESH_TOKEN) throw new Error('TIDAL_REFRESH_TOKEN environment variable is missing.');
  if (cachedAccessToken && Date.now() < tokenExpiresAt - 60000) return cachedAccessToken;

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

  if (!res.ok) throw new Error(`Failed to refresh Tidal token: ${res.status}`);
  
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
    headers: { 'Authorization': `Bearer ${token}`, 'x-tidal-token': CLIENT_ID },
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) throw new Error(`Tidal API playback info failed: ${res.status}`);
  const data = await res.json();

  if (data.manifest) {
    const decodedManifest = Buffer.from(data.manifest, 'base64').toString('utf-8');
    try {
      const manifestJson = JSON.parse(decodedManifest);
      if (manifestJson.urls && manifestJson.urls.length > 0) return manifestJson.urls[0];
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
    const searchUrl = `https://api.tidal.com/v1/search?query=${encodeURIComponent(`${title} ${artist}`)}&limit=5&types=TRACKS&countryCode=US`;

    const searchRes = await fetch(searchUrl, {
      headers: { 'Authorization': `Bearer ${token}`, 'x-tidal-token': CLIENT_ID },
      signal: AbortSignal.timeout(5000),
    });

    if (searchRes.ok) {
      const searchData = await searchRes.json();
      const rawItems = searchData.tracks?.items || searchData.items || [];
      if (rawItems.length > 0) return rawItems[0].id;
    }
  } catch (error) {
    console.warn(`[Tidal] Search error: ${error.message}`);
  }
  return null;
}

// 2.6 Fetch Direct Stream URL for Music Videos
async function getTidalVideoStreamUrl(videoId) {
  const token = await getAccessToken();

  // Notice the path is /videos/ and query uses videoquality=HIGH
  const url = `https://api.tidal.com/v1/videos/${videoId}/playbackinfopostpaywall?videoquality=HIGH&playbackmode=STREAM&assetpresentation=FULL`;

  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'x-tidal-token': CLIENT_ID,
    },
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Tidal Video API failed: ${res.status} ${errorText}`);
  }

  const data = await res.json();

  if (data.manifest) {
    const decodedManifest = Buffer.from(data.manifest, 'base64').toString('utf-8');

    try {
      const manifestJson = JSON.parse(decodedManifest);
      if (manifestJson.urls && manifestJson.urls.length > 0) {
        return manifestJson.urls[0]; // Returns the direct .m3u8 URL
      }
    } catch (e) {
      const urlMatch = decodedManifest.match(/https?:\/\/[^\s"<]+/);
      if (urlMatch) return urlMatch[0];
    }
  }

  throw new Error('No video URL found in Tidal manifest.');
}

// 3. Ultra-Fast Apple Music Developer Token Scraper (No Regex over massive HTML)
async function getAppleDeveloperToken() {
  if (cachedAppleToken && Date.now() < appleTokenExpiresAt) return cachedAppleToken;
  if (Date.now() - lastAppleTokenAttempt < 10 * 60 * 1000) return null; // 10 min cooldown

  lastAppleTokenAttempt = Date.now();

  try {
    console.log('[Apple Motion] Fetching live Apple Music developer token...');
    const res = await fetch('https://music.apple.com/us/browse', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15'
      },
      signal: AbortSignal.timeout(4000),
    });
    
    const html = await res.text();

    // METHOD A: Fast string search for Meta Tag
    const metaKey = 'apple-music-developer-token';
    const metaStart = html.indexOf(metaKey);
    if (metaStart !== -1) {
      const contentStart = html.indexOf('content="', metaStart);
      if (contentStart !== -1) {
        const tokenStart = contentStart + 9;
        const tokenEnd = html.indexOf('"', tokenStart);
        if (tokenEnd !== -1) {
          cachedAppleToken = html.substring(tokenStart, tokenEnd);
          appleTokenExpiresAt = Date.now() + 12 * 60 * 60 * 1000;
          console.log('[Apple Motion] ✅ Token scraped rapidly from meta tag!');
          return cachedAppleToken;
        }
      }
    }

    // METHOD B: Fast string search for JS Bundle
    const jsStart = html.indexOf('/assets/index');
    if (jsStart !== -1) {
      const jsEnd = html.indexOf('"', jsStart);
      if (jsEnd !== -1) {
        const jsUrl = html.substring(jsStart, jsEnd);
        if (jsUrl.endsWith('.js')) {
          const jsRes = await fetch(`https://music.apple.com${jsUrl}`, { signal: AbortSignal.timeout(4000) });
          const jsText = await jsRes.text();
          
          const jwtStart = jsText.indexOf('eyJhbGciOiJFUzI1NiI');
          if (jwtStart !== -1) {
            // Slice a tiny 200 char chunk so regex doesn't freeze the server
            const tinySnippet = jsText.substring(jwtStart, jwtStart + 200);
            const match = tinySnippet.match(/eyJhbGciOiJFUzI1NiI[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/);
            if (match) {
              cachedAppleToken = match[0];
              appleTokenExpiresAt = Date.now() + 12 * 60 * 60 * 1000;
              console.log('[Apple Motion] ✅ Token scraped rapidly from JS bundle!');
              return cachedAppleToken;
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn(`[Apple Motion] Failed to scrape Apple token: ${err.message}`);
  }

  return null;
}

// 4. Apple Motion Extractors
function findTallVideoInJson(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const target = obj.motionDetailTall || obj.motionTall;
  if (target) {
    const videoUrl = target.video || target.assets?.[0]?.url || target.response?.video;
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

  // Safe slicing prevents regex freeze
  const snippet = str.slice(targetIdx, targetIdx + 800);
  const squareInSnippetIdx = snippet.indexOf('"motionDetailSquare"');
  const safeSnippet = squareInSnippetIdx !== -1 ? snippet.slice(0, squareInSnippetIdx) : snippet;

  const urlMatch = safeSnippet.match(/https?:\/\/[^\s"'<>]+\.(?:mp4|m3u8)[^\s"'<>]*/i);
  if (urlMatch) return urlMatch[0].replace(/\\\/|\\u002F/g, '/');
  return null;
}

async function getAppleMotionUrl(albumTitle, artistName) {
  const searchQuery = `${albumTitle} ${artistName}`;
  const IPHONE_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15';

  const token = await getAppleDeveloperToken();
  if (token) {
    try {
      const searchUrl = `https://amp-api.music.apple.com/v1/catalog/us/search?term=${encodeURIComponent(searchQuery)}&types=albums&limit=1`;
      const searchRes = await fetch(searchUrl, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Origin': 'https://music.apple.com',
          'User-Agent': IPHONE_USER_AGENT,
        },
        signal: AbortSignal.timeout(4000),
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
            },
            signal: AbortSignal.timeout(4000),
          });

          if (detailRes.ok) {
            const detailData = await detailRes.json();
            const tallUrl = findTallVideoInJson(detailData);
            if (tallUrl) {
              console.log('[Apple Motion] ✅ Found TALL video via Amp API!');
              return tallUrl;
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[Apple Motion] Engine 1 API error/timeout: ${err.message}`);
    }
  }

  // Engine 2: Web Scraper (Fast String Slicing)
  try {
    const iTunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(searchQuery)}&entity=album&limit=3`;
    const searchRes = await fetch(iTunesUrl, { signal: AbortSignal.timeout(4000) });
    if (!searchRes.ok) return null;

    const searchData = await searchRes.json();
    const albumUrl = searchData.results?.[0]?.collectionViewUrl;
    if (!albumUrl) return null;

    const pageRes = await fetch(albumUrl, {
      headers: { 'User-Agent': IPHONE_USER_AGENT },
      signal: AbortSignal.timeout(4000),
    });

    if (!pageRes.ok) return null;
    const html = await pageRes.text();

    // Use fast string slicer on the entire HTML page (Instantly bypasses RegExp locks)
    const htmlSlicedUrl = extractTallUrlFromRawString(html);
    if (htmlSlicedUrl) {
       console.log('[Apple Motion] ✅ Found TALL video via fast HTML Slice!');
       return htmlSlicedUrl;
    }
  } catch (err) {
    console.warn(`[Apple Motion] Engine 2 Web error/timeout: ${err.message}`);
  }

  return null;
}

// 5. Spotify internal Lyrics Engine
async function getSpotifyToken() {
  if (!SPOTIFY_SP_DC) return null;
  if (cachedSpotifyToken && Date.now() < spotifyTokenExpiresAt) return cachedSpotifyToken;

  try {
    const cleanCookie = SPOTIFY_SP_DC.replace('sp_dc=', '').trim();
    const headers = {
      'Cookie': `sp_dc=${cleanCookie}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    };

    const res = await fetch('https://open.spotify.com/', { headers, signal: AbortSignal.timeout(5000) });
    const html = await res.text();

    const sessionMatch = html.match(/<script id="session"[^>]*>([^<]+)<\/script>/);
    if (sessionMatch && sessionMatch[1]) {
      try {
        const sessionData = JSON.parse(sessionMatch[1]);
        if (!sessionData.isAnonymous) {
          cachedSpotifyToken = sessionData.accessToken;
          spotifyTokenExpiresAt = sessionData.accessTokenExpirationTimestampMs - 60000;
          return cachedSpotifyToken;
        }
      } catch (e) { /* ignore */ }
    }
  } catch (e) {
    console.warn('[Spotify] Fetch error:', e.message);
  }
  return null;
}

async function getSpotifyLyrics(title, artist) {
  const token = await getSpotifyToken();
  if (!token) return null;

  try {
    const query = encodeURIComponent(`track:${title} artist:${artist}`);
    const searchRes = await fetch(`https://api.spotify.com/v1/search?q=${query}&type=track&limit=1`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(4000),
    });
    
    const searchData = await searchRes.json();
    const trackId = searchData.tracks?.items?.[0]?.id;
    if (!trackId) return null;

    const lyricsRes = await fetch(`https://spclient.wg.spotify.com/color-lyrics/v2/track/${trackId}?format=json&market=from_token`, {
      headers: { 'App-Platform': 'WebPlayer', 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(4000),
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
           if (!isNaN(sylTime)) {
             const sMins = String(Math.floor(sylTime / 60000)).padStart(2, '0');
             const sSecs = ((sylTime % 60000) / 1000).toFixed(2).padStart(5, '0');
             lineContent += `<${sMins}:${sSecs}>${syllable.words}`;
           } else {
             lineContent += syllable.words;
           }
        });
      } else {
        lineContent = line.words;
      }
      lrcString += `[${lMins}:${lSecs}]${lineContent}\n`;
    });

    return { found: true, isWordByWord, plainLyrics: plainString.trim(), syncedLyrics: lrcString.trim() };
  } catch (err) {
    return null;
  }
}

// 6. Fallback LRCLIB Lyrics Engine
async function getLrclibLyrics(title, artist) {
  try {
    const searchUrl = new URL('https://lrclib.net/api/search');
    searchUrl.searchParams.append('q', `${title} ${artist}`);
    const res = await fetch(searchUrl.toString(), {
      headers: { 'User-Agent': 'SpoofyApp/1.0' },
      signal: AbortSignal.timeout(4000),
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
  } catch (err) {}
  return null;
}

// --- ENDPOINTS ---

app.get('/', (req, res) => {
  res.json({ status: 'online' });
});

// Audio Search
app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Search query required.' });

    const token = await getAccessToken();
    const searchRes = await fetch(`https://api.tidal.com/v1/search?query=${encodeURIComponent(q)}&limit=10&types=TRACKS&countryCode=US`, {
      headers: { 'Authorization': `Bearer ${token}`, 'x-tidal-token': CLIENT_ID },
      signal: AbortSignal.timeout(5000),
    });

    if (!searchRes.ok) throw new Error('Search request failed');
    const searchData = await searchRes.json();
    const rawItems = searchData.tracks?.items || searchData.items || [];

    const tracks = rawItems.map((t) => ({
      id: t.id,
      title: t.title,
      artist: t.artist?.name || t.artists?.[0]?.name || 'Unknown Artist',
      album: t.album?.title || 'Unknown Album',
      coverUrl: t.album?.cover ? `https://resources.tidal.com/images/${t.album.cover.replace(/-/g, '/')}/320x320.jpg` : null,
    }));

    res.json({ tracks });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Audio Stream
app.get('/api/stream', async (req, res) => {
  try {
    let { trackId, title, artist } = req.query;
    if (!trackId && (!title || !artist)) return res.status(400).json({ error: 'trackId OR (title and artist) is required' });

    if (!trackId) {
      trackId = await searchTidalForTrack(title, artist);
      if (!trackId) return res.status(404).json({ error: 'Track not found on Tidal' });
    }

    const directStreamUrl = await getTidalStreamUrl(trackId);
    const clientRange = req.headers.range || 'bytes=0-';

    const tidalResponse = await fetch(directStreamUrl, { headers: { 'Range': clientRange } });
    if (!tidalResponse.ok && tidalResponse.status !== 206) return res.status(tidalResponse.status).json({ error: 'Tidal CDN request failed' });

    res.status(tidalResponse.status);
    ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach((h) => {
      const val = tidalResponse.headers.get(h);
      if (val) res.setHeader(h, val);
    });

    res.setHeader('Accept-Ranges', 'bytes');
    Readable.fromWeb(tidalResponse.body).pipe(res);
  } catch (error) {
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// Video Search (Filtered for Official/Studio Videos)
app.get('/api/search-video', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Search query required.' });

    const token = await getAccessToken();
    
    // Check if the user explicitly asked for a live performance
    const isExplicitlyLive = /\b(live|performance|concert|festival|session|tour)\b/i.test(q);
    
    // Append "Official Video" to target music/lyric videos if not explicitly asking for live
    const searchQuery = isExplicitlyLive ? q : `${q} Official Video`;

    const searchUrl = `https://api.tidal.com/v1/search?query=${encodeURIComponent(searchQuery)}&limit=15&types=VIDEOS&countryCode=US`;
    
    const searchRes = await fetch(searchUrl, {
      headers: { 'Authorization': `Bearer ${token}`, 'x-tidal-token': CLIENT_ID },
      signal: AbortSignal.timeout(5000),
    });

    if (!searchRes.ok) throw new Error('Video search request failed');
    
    const searchData = await searchRes.json();
    let rawItems = searchData.videos?.items || searchData.items || [];

    // Filter out live performances if not explicitly requested
    if (!isExplicitlyLive) {
      const liveRegex = /\b(live|performance|concert|festival|session|tour|unplugged|stage|awards|rehearsal|vevo lift|live at)\b/i;
      const studioVideos = rawItems.filter(v => !liveRegex.test(v.title || ''));
      if (studioVideos.length > 0) {
        rawItems = studioVideos;
      }
    }

    const videos = rawItems.slice(0, 10).map((v) => ({
      id: v.id,
      title: v.title,
      artist: v.artist?.name || v.artists?.[0]?.name || 'Unknown Artist',
      thumbnailUrl: v.imageId ? `https://resources.tidal.com/images/${v.imageId.replace(/-/g, '/')}/320x240.jpg` : null,
      duration: v.duration
    }));

    res.json({ videos });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get Video Stream URL (Returns .m3u8 CDN link)
app.get('/api/video', async (req, res) => {
  try {
    const { videoId } = req.query;
    if (!videoId) return res.status(400).json({ error: 'videoId is required' });

    const directStreamUrl = await getTidalVideoStreamUrl(videoId);

    res.json({
      success: true,
      videoUrl: directStreamUrl
    });
  } catch (error) {
    console.error('Video Fetch Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Fetch Auto-Matched Official Video for a specific Track
app.get('/api/official-video', async (req, res) => {
  try {
    const { title, artist } = req.query;
    if (!title || !artist) return res.status(400).json({ error: 'title and artist required.' });

    const token = await getAccessToken();
    const searchQuery = `${title} ${artist} Official Video`;
    
    const searchUrl = `https://api.tidal.com/v1/search?query=${encodeURIComponent(searchQuery)}&limit=10&types=VIDEOS&countryCode=US`;
    const searchRes = await fetch(searchUrl, {
      headers: { 'Authorization': `Bearer ${token}`, 'x-tidal-token': CLIENT_ID },
      signal: AbortSignal.timeout(5000),
    });

    if (!searchRes.ok) throw new Error('Video search request failed');
    const searchData = await searchRes.json();
    const items = searchData.videos?.items || searchData.items || [];

    const liveRegex = /\b(live|performance|concert|festival|session|tour|unplugged|stage|awards|rehearsal)\b/i;
    
    // First choice: Non-live video
    let bestVideo = items.find(v => !liveRegex.test(v.title || ''));
    // Fallback: First returned item
    if (!bestVideo && items.length > 0) bestVideo = items[0];

    if (!bestVideo) {
      return res.json({ found: false, message: 'No official video found.' });
    }

    const directStreamUrl = await getTidalVideoStreamUrl(bestVideo.id);

    res.json({
      found: true,
      videoId: bestVideo.id,
      title: bestVideo.title,
      videoUrl: directStreamUrl
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Apple Motion & Color Endpoint (Safe Timeout Implementation)
app.get('/api/motion', async (req, res) => {
  try {
    const { album, artist, coverUrl } = req.query;
    if (!album || !artist) return res.status(400).json({ error: 'Parameters missing' });

    let themeColor = '#2A2E3D';
    if (coverUrl) {
      try {
        const palette = await Vibrant.from(coverUrl).getPalette();
        themeColor = palette.DarkMuted?.hex || palette.DarkVibrant?.hex || palette.Muted?.hex || themeColor;
      } catch (e) {}
    }

    // Force resolve to null if scraping takes longer than 3.5 seconds
    const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), 3500));
    const motionUrl = await Promise.race([ getAppleMotionUrl(album, artist), timeoutPromise ]);

    res.json({
      hasMotion: !!motionUrl,
      motionUrl: motionUrl || null,
      themeColor: themeColor,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/lyrics', async (req, res) => {
  try {
    const { title, artist } = req.query;
    if (!title || !artist) return res.status(400).json({ error: 'Missing parameters' });

    let lyricsData = await getSpotifyLyrics(title, artist);
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

    if (lyricsData) res.json(lyricsData);
    else res.json({ found: false, message: 'No lyrics found.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
