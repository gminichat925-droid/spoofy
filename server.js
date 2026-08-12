const express = require('express');
const cors = require('cors');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises'); // Added for safe stream handling
const { spawn } = require('child_process'); // Added to handle FFmpeg transcoding
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

// 2. Fetch Direct Stream URL from Tidal Manifest (With Smart DASH & DRM Extraction)
async function getTidalStreamUrl(trackId, quality = 'LOSSLESS') {
  const token = await getAccessToken();
  
  // Added &audioMode=STEREO to prevent silent Dolby Atmos streams
  const url = `https://api.tidal.com/v1/tracks/${trackId}/playbackinfopostpaywall?audioquality=${quality}&playbackmode=STREAM&assetpresentation=FULL&audioMode=STEREO`;

  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}`, 'x-tidal-token': CLIENT_ID },
    signal: AbortSignal.timeout(5000),
  });

  // Fallback safely if the API outright rejects the requested quality
  if (!res.ok) {
    if (quality === 'LOSSLESS') return await getTidalStreamUrl(trackId, 'HIGH');
    if (quality === 'HIGH') return await getTidalStreamUrl(trackId, 'LOW');
    throw new Error(`Tidal API playback info failed: ${res.status}`);
  }

  const data = await res.json();

  if (data.manifest) {
    const decodedManifest = Buffer.from(data.manifest, 'base64').toString('utf-8');
    
    // 🚨 SCENARIO A: Tidal sent a DASH XML Playlist
    if (data.manifestMimeType === 'application/dash+xml') {
      // 1. Check if the DASH file contains DRM Encryption
      if (decodedManifest.includes('<ContentProtection')) {
        console.warn(`[Tidal] 🔒 DASH Track ${trackId} is DRM Protected at ${quality}.`);
        if (quality === 'LOSSLESS') {
          console.log(`[Tidal] 🔓 Downgrading to HIGH quality to bypass DRM...`);
          return await getTidalStreamUrl(trackId, 'HIGH');
        } else if (quality === 'HIGH') {
          console.log(`[Tidal] 🔓 Downgrading to LOW quality to bypass DRM...`);
          return await getTidalStreamUrl(trackId, 'LOW');
        } else {
          throw new Error('Track is strictly DRM protected across all qualities.');
        }
      }

      // 2. If no DRM, crack open the XML and extract the direct audio link!
      const baseUrlMatch = decodedManifest.match(/<BaseURL>(.+?)<\/BaseURL>/);
      if (baseUrlMatch && baseUrlMatch[1]) {
        console.log(`[Tidal] ✅ Extracted direct audio file from DASH XML! (${quality})`);
        // XML escapes ampersands, so we must unescape them to get a valid URL
        return baseUrlMatch[1].replace(/&amp;/g, '&'); 
      }
    }

    // 🚨 SCENARIO B: Tidal sent a standard JSON Manifest
    try {
      const manifestJson = JSON.parse(decodedManifest);
      
      const isDRM = manifestJson.encryptionType && manifestJson.encryptionType !== 'NONE';
      if (isDRM) {
        console.warn(`[Tidal] 🔒 JSON Track ${trackId} is DRM Protected at ${quality}.`);
        if (quality === 'LOSSLESS') {
          console.log(`[Tidal] 🔓 Downgrading to HIGH quality to bypass DRM...`);
          return await getTidalStreamUrl(trackId, 'HIGH');
        } else if (quality === 'HIGH') {
          console.log(`[Tidal] 🔓 Downgrading to LOW quality to bypass DRM...`);
          return await getTidalStreamUrl(trackId, 'LOW');
        } else {
          throw new Error('Track is strictly DRM protected across all qualities.');
        }
      }

      if (manifestJson.urls && manifestJson.urls.length > 0) {
        console.log(`[Tidal] ✅ Extracted direct audio file from JSON! (${quality})`);
        return manifestJson.urls[0];
      }
    } catch (e) {
      // Fallback regex if it's neither standard DASH nor JSON
      const urlMatch = decodedManifest.match(/https?:\/\/[^\s"<]+/);
      if (urlMatch) return urlMatch[0].replace(/&amp;/g, '&');
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
        return manifestJson.urls[0]; 
      }
    } catch (e) {
      const urlMatch = decodedManifest.match(/https?:\/\/[^\s"<]+/);
      if (urlMatch) return urlMatch[0];
    }
  }

  throw new Error('No video URL found in Tidal manifest.');
}

// 3. Ultra-Fast Apple Music Developer Token Scraper
async function getAppleDeveloperToken() {
  if (cachedAppleToken && Date.now() < appleTokenExpiresAt) return cachedAppleToken;
  if (Date.now() - lastAppleTokenAttempt < 10 * 60 * 1000) return null; 

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

// Audio Stream - UPGRADED WITH FFMPEG TRANSCODING
app.get('/api/stream', async (req, res) => {
  try {
    let { trackId, title, artist } = req.query;
    if (!trackId && (!title || !artist)) return res.status(400).json({ error: 'trackId OR (title and artist) is required' });

    if (!trackId) {
      trackId = await searchTidalForTrack(title, artist);
      if (!trackId) return res.status(404).json({ error: 'Track not found on Tidal' });
    }

    const directStreamUrl = await getTidalStreamUrl(trackId);
    
    // 1. FLAC streams (LOSSLESS) can be piped directly to the browser natively
    if (directStreamUrl.includes('.flac')) {
      const clientRange = req.headers.range || 'bytes=0-';
      const controller = new AbortController();
      req.on('close', () => controller.abort());

      const tidalResponse = await fetch(directStreamUrl, { 
        headers: { 'Range': clientRange },
        signal: controller.signal 
      });
      
      if (!tidalResponse.ok && tidalResponse.status !== 206) return res.status(tidalResponse.status).json({ error: 'Tidal CDN request failed' });

      res.status(tidalResponse.status);
      ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach((h) => {
        const val = tidalResponse.headers.get(h);
        if (val) res.setHeader(h, val);
      });
      if (!res.getHeader('content-type')) res.setHeader('Content-Type', 'audio/flac');
      res.setHeader('Accept-Ranges', 'bytes');
      
      try {
        await pipeline(Readable.fromWeb(tidalResponse.body), res);
      } catch (err) {}
      return;
    }

    // 2. AAC / DASH streams (HIGH/LOW) are Fragmented MP4s. 
    // Browsers CANNOT play fMP4 natively, so we transcode it live into a standard MP3.
    res.setHeader('Content-Type', 'audio/mpeg');
    
    const ffmpegProcess = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', directStreamUrl,   // Let FFmpeg safely download the CDN URL directly
      '-f', 'mp3',             // Output as MP3
      '-c:a', 'libmp3lame',    // Standard MP3 audio codec
      '-b:a', '128k',          // Lock bitrate to match LOW/HIGH stream quality
      'pipe:1'                 // Pipe the output to stdout
    ]);

    // Pipe the transcoded audio directly to the browser
    ffmpegProcess.stdout.pipe(res);

    // Suppress background crash logs if the user skips a song
    ffmpegProcess.on('error', () => {});
    ffmpegProcess.stdout.on('error', () => {});
    
    // Kill the heavy FFmpeg process immediately if the user closes the tab or skips
    req.on('close', () => {
      ffmpegProcess.kill('SIGKILL');
    });

  } catch (error) {
    console.error('[Stream Error]', error.message);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// --- UPDATED VIDEO SCORING ENGINE ---
function getVideoScore(video, targetTitle, targetArtist) {
  let score = 0;
  // Combine title AND hidden version tag for grading!
  const vTitle = (video.title || '').toLowerCase();
  const vVersion = (video.version || '').toLowerCase();
  const fullString = `${vTitle} ${vVersion}`;
  const target = targetTitle.toLowerCase();
  const artist = targetArtist.toLowerCase();
  const vArtist = (video.artist?.name || video.artists?.[0]?.name || '').toLowerCase();

  // 1. Artist Match Verification (+100 points or Huge Penalty)
  if (vArtist && (vArtist.includes(artist) || artist.includes(vArtist))) {
    score += 100;
  } else {
    score -= 200; 
  }

  // 2. Title Match Bonus
  if (vTitle === target) score += 100;
  else if (vTitle.includes(target)) score += 50;
  else if (target.includes(vTitle)) score += 20;

  // 3. Official Keywords Bonus
  if (/\b(official|music video)\b/i.test(fullString)) score += 30;
  if (/\b(lyric|lyrics)\b/i.test(fullString)) score += 15;

  // 4. INSTANT KILL for Live / Unplugged performances (-500 points!)
  const liveRegex = /\b(live|performance|concert|festival|session|tour|unplugged|stage|awards|rehearsal|acoustic|behind the scenes|making of|vevo lift|live at)\b/i;
  if (liveRegex.test(fullString)) {
    score -= 500; 
  }

  return score;
}

// Video Search (Filtered and Ranked for Studio Videos)
app.get('/api/search-video', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Search query required.' });

    const token = await getAccessToken();
    const isExplicitlyLive = /\b(live|performance|concert|festival|session|tour|unplugged|acoustic)\b/i.test(q);
    
    // Increased limit to 30 to dig deeper for buried official videos
    const searchUrl = `https://api.tidal.com/v1/search?query=${encodeURIComponent(q)}&limit=30&types=VIDEOS&countryCode=US`;
    
    const searchRes = await fetch(searchUrl, {
      headers: { 'Authorization': `Bearer ${token}`, 'x-tidal-token': CLIENT_ID },
      signal: AbortSignal.timeout(5000),
    });

    if (!searchRes.ok) throw new Error('Video search request failed');
    
    const searchData = await searchRes.json();
    let rawItems = searchData.videos?.items || searchData.items || [];

    if (!isExplicitlyLive) {
      // Sort items so Official videos go to the top
      rawItems.sort((a, b) => getVideoScore(b, q, '') - getVideoScore(a, q, ''));
      
      // Completely strip out any videos that still trigger the live penalty
      const liveRegex = /\b(live|performance|concert|festival|session|tour|unplugged|stage|awards|rehearsal|acoustic|behind the scenes|making of|vevo lift|live at)\b/i;
      const studioVideos = rawItems.filter(v => {
        const fullString = `${v.title || ''} ${v.version || ''}`;
        return !liveRegex.test(fullString);
      });

      if (studioVideos.length > 0) {
        rawItems = studioVideos;
      }
    }

    const videos = rawItems.slice(0, 10).map((v) => ({
      id: v.id,
      // Pass the version down to the app so you can visibly see what was fetched
      title: v.version ? `${v.title} (${v.version})` : v.title, 
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
    const searchQuery = `${title} ${artist}`;
    
    // Digging up to 30 items deep to bypass popular live performances
    const searchUrl = `https://api.tidal.com/v1/search?query=${encodeURIComponent(searchQuery)}&limit=30&types=VIDEOS&countryCode=US`;
    const searchRes = await fetch(searchUrl, {
      headers: { 'Authorization': `Bearer ${token}`, 'x-tidal-token': CLIENT_ID },
      signal: AbortSignal.timeout(5000),
    });

    if (!searchRes.ok) throw new Error('Video search request failed');
    const searchData = await searchRes.json();
    const items = searchData.videos?.items || searchData.items || [];

    if (items.length === 0) {
      return res.json({ found: false, message: 'No videos found for this track.' });
    }

    // Use our new Scoring Engine to pick the absolute best Official Video
    items.sort((a, b) => getVideoScore(b, title, artist) - getVideoScore(a, title, artist));

    const bestVideo = items[0];
    const topScore = getVideoScore(bestVideo, title, artist);

    // Guard Clause: If the top-scoring video STILL has a negative score, 
    // it means ONLY live performances exist on Tidal. We bravely refuse to return it.
    if (topScore < 0) {
      return res.json({ found: false, message: 'Only live performances exist on Tidal. Studio video unavailable.' });
    }

    const directStreamUrl = await getTidalVideoStreamUrl(bestVideo.id);

    res.json({
      found: true,
      videoId: bestVideo.id,
      title: bestVideo.version ? `${bestVideo.title} (${bestVideo.version})` : bestVideo.title,
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
