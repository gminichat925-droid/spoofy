const express = require('express');
const cors = require('cors');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { spawn } = require('child_process');
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
let lastAppleTokenAttempt = 0; 

let cachedSpotifyToken = null;
let spotifyTokenExpiresAt = 0;

// In-Memory Offset Cache (Track Name + Artist -> Intro Offset in seconds)
const videoOffsetCache = new Map();

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
async function getTidalStreamUrl(trackId, quality = 'LOSSLESS') {
  const token = await getAccessToken();
  const url = `https://api.tidal.com/v1/tracks/${trackId}/playbackinfopostpaywall?audioquality=${quality}&playbackmode=STREAM&assetpresentation=FULL&audioMode=STEREO`;

  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}`, 'x-tidal-token': CLIENT_ID },
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    if (quality === 'LOSSLESS') return await getTidalStreamUrl(trackId, 'HIGH');
    if (quality === 'HIGH') return await getTidalStreamUrl(trackId, 'LOW');
    throw new Error(`Tidal API playback info failed: ${res.status}`);
  }

  const data = await res.json();

  if (data.manifest) {
    const decodedManifest = Buffer.from(data.manifest, 'base64').toString('utf-8');
    
    // DASH XML
    if (data.manifestMimeType === 'application/dash+xml') {
      if (decodedManifest.includes('<ContentProtection')) {
        console.warn(`[Tidal] 🔒 DASH Track ${trackId} is DRM Protected at ${quality}.`);
        if (quality === 'LOSSLESS') return await getTidalStreamUrl(trackId, 'HIGH');
        if (quality === 'HIGH') return await getTidalStreamUrl(trackId, 'LOW');
        throw new Error('Track is strictly DRM protected across all qualities.');
      }

      const baseUrlMatch = decodedManifest.match(/<BaseURL>(.+?)<\/BaseURL>/);
      if (baseUrlMatch && baseUrlMatch[1]) {
        return baseUrlMatch[1].replace(/&/g, '&'); 
      }
    }

    // JSON Manifest
    try {
      const manifestJson = JSON.parse(decodedManifest);
      const isDRM = manifestJson.encryptionType && manifestJson.encryptionType !== 'NONE';
      if (isDRM) {
        if (quality === 'LOSSLESS') return await getTidalStreamUrl(trackId, 'HIGH');
        if (quality === 'HIGH') return await getTidalStreamUrl(trackId, 'LOW');
        throw new Error('Track is strictly DRM protected across all qualities.');
      }

      if (manifestJson.urls && manifestJson.urls.length > 0) {
        return manifestJson.urls[0];
      }
    } catch (e) {
      const urlMatch = decodedManifest.match(/https?:\/\/[^\s"<]+/);
      if (urlMatch) return urlMatch[0].replace(/&/g, '&');
    }
  }
  
  throw new Error('No audio URL found in Tidal manifest.');
}

// 2.5 Helper to Search Tidal by Title and Artist
async function searchTidalForTrack(title, artist) {
  try {
    const token = await getAccessToken();
    const cleanTitle = cleanTrackTitle(title);
    const searchUrl = `https://api.tidal.com/v1/search?query=${encodeURIComponent(`${cleanTitle} ${artist}`)}&limit=5&types=TRACKS&countryCode=US`;

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

// ─────────────────────────────────────────────────────────────
// 3. TITLE NORMALIZER & MULTI-TIER SMART VIDEO SELECTOR
// ─────────────────────────────────────────────────────────────

function cleanTrackTitle(title) {
  if (!title) return '';
  return title
    .replace(/\((?:taylor's version|from the vault|deluxe|remastered|remaster|bonus track|single version|anniversary|expanded|explicit|original mix|10 minute version)[^)]*\)/gi, '')
    .replace(/\[(?:taylor's version|from the vault|deluxe|remastered|remaster|bonus track|single version|anniversary|expanded|explicit|original mix|10 minute version)[^\]]*\]/gi, '')
    .replace(/-\s*(?:remastered|remaster|deluxe|single version|bonus track|live|from the vault).*/gi, '')
    .replace(/\s+feat\..*/gi, '')
    .replace(/\s+ft\..*/gi, '')
    .replace(/\s+with\s+.*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const LIVE_KEYWORDS_REGEX = /\b(live|unplugged|mtv unplugged|performance|concert|festival|session|sessions|tour|stage|awards|rehearsal|acoustic|behind the scenes|making of|vevo lift|vevo dscvr|bbc radio|live at|live from|stripped|en vivo|ao vivo|world tour|on the run)\b/i;
const LYRIC_KEYWORDS_REGEX = /\b(lyric|lyrics|lyric video|visualizer|audio|audio video|track video|visualizer video|canvas)\b/i;
const OFFICIAL_KEYWORDS_REGEX = /\b(official music video|official video|music video|short film|the short film|directors cut|director's cut|extended version)\b/i;

function getVideoScore(video, rawTargetTitle, targetArtist) {
  let score = 0;
  const vTitle = (video.title || '').toLowerCase();
  const vVersion = (video.version || '').toLowerCase();
  const albumTitle = (video.album?.title || '').toLowerCase();
  const fullString = `${vTitle} ${vVersion} ${albumTitle}`;
  
  const cleanTarget = cleanTrackTitle(rawTargetTitle).toLowerCase();
  const rawTarget = (rawTargetTitle || '').toLowerCase();
  const artist = (targetArtist || '').toLowerCase();
  const vArtist = (video.artist?.name || video.artists?.[0]?.name || '').toLowerCase();

  // 1. Artist Match Verification
  if (artist) {
    if (vArtist && (vArtist.includes(artist) || artist.includes(vArtist))) {
      score += 150;
    } else {
      score -= 500; 
    }
  }

  // 2. Base Title & Short Film Matching
  const cleanVTitle = cleanTrackTitle(vTitle).toLowerCase();
  if (cleanVTitle === cleanTarget || vTitle === rawTarget) {
    score += 200;
  } else if (cleanVTitle.startsWith(cleanTarget) || cleanTarget.startsWith(cleanVTitle)) {
    score += 120;
  } else if (vTitle.includes(cleanTarget) || cleanTarget.includes(vTitle)) {
    score += 80;
  }

  // 3. Official Music Video & Short Film Bonuses
  if (OFFICIAL_KEYWORDS_REGEX.test(fullString)) {
    score += 150;
  }

  // 4. Penalty for Lyric Videos & Visualizers
  if (LYRIC_KEYWORDS_REGEX.test(fullString)) {
    score -= 400;
  }

  // 5. Severe Disqualification Penalty for Live / MTV Unplugged
  const isExplicitlyLive = LIVE_KEYWORDS_REGEX.test(rawTarget);
  if (!isExplicitlyLive && LIVE_KEYWORDS_REGEX.test(fullString)) {
    score -= 1000;
  }

  return score;
}

// Multi-Tier Video Candidate Selector
function selectBestVideo(items, rawTitle, artist) {
  if (!items || items.length === 0) return null;

  const isExplicitlyLive = LIVE_KEYWORDS_REGEX.test(rawTitle);

  const scoredItems = items.map(v => ({
    video: v,
    score: getVideoScore(v, rawTitle, artist),
    isLive: LIVE_KEYWORDS_REGEX.test(`${v.title || ''} ${v.version || ''} ${v.album?.title || ''}`),
    isLyric: LYRIC_KEYWORDS_REGEX.test(`${v.title || ''} ${v.version || ''} ${v.album?.title || ''}`),
  }));

  scoredItems.sort((a, b) => b.score - a.score);

  if (!isExplicitlyLive) {
    // Priority 1: Studio Official Music Videos (Not Live, Not Lyric Video)
    const studioVideos = scoredItems.filter(item => !item.isLive && !item.isLyric && item.score > 0);
    if (studioVideos.length > 0) {
      return studioVideos[0].video;
    }

    // Priority 2: Non-live fallback (e.g., Short Film or Lyric Video if no studio video exists)
    const nonLiveVideos = scoredItems.filter(item => !item.isLive && item.score > -300);
    if (nonLiveVideos.length > 0) {
      return nonLiveVideos[0].video;
    }
  }

  // Priority 3: Fallback (only if user explicitly wanted live or strictly nothing else exists)
  return scoredItems[0].score > -800 ? scoredItems[0].video : null;
}

// ─────────────────────────────────────────────────────────────
// 4. SMART INTRO OFFSET ENGINE
// ─────────────────────────────────────────────────────────────

async function getYouTubeVideoId(title, artist) {
  try {
    const cleanTitle = cleanTrackTitle(title);
    const query = encodeURIComponent(`${cleanTitle} ${artist} official music video`);
    const searchUrl = `https://www.youtube.com/results?search_query=${query}`;
    
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/\/watch\?v=([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
  } catch (err) {
    return null;
  }
}

async function getSponsorBlockIntroOffset(ytVideoId) {
  try {
    const url = `https://sponsor.ajay.app/api/skipSegments?videoID=${ytVideoId}&categories=["music_offtopic"]`;
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;

    const segments = await res.json();
    if (Array.isArray(segments)) {
      const intro = segments.find(s => Array.isArray(s.segment) && s.segment[0] <= 3);
      if (intro && intro.segment[1] > 2) {
        return Number(intro.segment[1].toFixed(2));
      }
    }
  } catch (err) {}
  return null;
}

async function getAccurateVideoIntroOffset(title, artist, videoDuration, audioDuration) {
  const cleanTitle = cleanTrackTitle(title);
  const cacheKey = `${cleanTitle.toLowerCase()}|${(artist || '').toLowerCase()}`;
  if (videoOffsetCache.has(cacheKey)) {
    return videoOffsetCache.get(cacheKey);
  }

  const vDur = Number(videoDuration > 10000 ? videoDuration / 1000 : videoDuration) || 0;
  const aDur = Number(audioDuration > 10000 ? audioDuration / 1000 : audioDuration) || 0;

  let calculatedOffset = 0;

  try {
    const ytVideoId = await getYouTubeVideoId(cleanTitle, artist);
    if (ytVideoId) {
      const sbOffset = await getSponsorBlockIntroOffset(ytVideoId);
      if (sbOffset !== null && sbOffset > 0) {
        calculatedOffset = sbOffset;
      }
    }
  } catch (e) {}

  if (calculatedOffset === 0 && vDur > 0 && aDur > 0) {
    const delta = vDur - aDur;
    if (delta >= 3) {
      calculatedOffset = Number(delta.toFixed(2));
    }
  }

  videoOffsetCache.set(cacheKey, calculatedOffset);
  return calculatedOffset;
}

// ─────────────────────────────────────────────────────────────
// 5. APPLE MOTION SCRAPER (PRESERVES TAYLOR'S VERSION & EDITIONS)
// ─────────────────────────────────────────────────────────────

async function getAppleDeveloperToken() {
  if (cachedAppleToken && Date.now() < appleTokenExpiresAt) return cachedAppleToken;
  if (Date.now() - lastAppleTokenAttempt < 10 * 60 * 1000) return null; 

  lastAppleTokenAttempt = Date.now();

  try {
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
          return cachedAppleToken;
        }
      }
    }
  } catch (err) {
    console.warn(`[Apple Motion] Scrape error: ${err.message}`);
  }

  return null;
}

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
  const IPHONE_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15';
  
  // Keep original album title (with Taylor's Version) for accurate matching
  const exactQuery = `${albumTitle} ${artistName}`;
  const isTaylorVersion = /taylor's version/i.test(albumTitle);

  // Engine 1: Apple Music Developer Amp API
  const token = await getAppleDeveloperToken();
  if (token) {
    try {
      const searchUrl = `https://amp-api.music.apple.com/v1/catalog/us/search?term=${encodeURIComponent(exactQuery)}&types=albums&limit=5`;
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
        const albums = searchData.results?.albums?.data || [];

        // Find the album matching edition requirements
        let targetAlbum = albums[0];
        if (isTaylorVersion) {
          const match = albums.find(a => /taylor's version/i.test(a.attributes?.name || ''));
          if (match) targetAlbum = match;
        }

        if (targetAlbum?.id) {
          const detailUrl = `https://amp-api.music.apple.com/v1/catalog/us/albums/${targetAlbum.id}?include=editorial-video,editorialVideo&platform=iphone`;
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
            if (tallUrl) return tallUrl;
          }
        }
      }
    } catch (err) {}
  }

  // Engine 2: iTunes Direct HTML Scraper Fallback
  try {
    const iTunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(exactQuery)}&entity=album&limit=5`;
    const searchRes = await fetch(iTunesUrl, { signal: AbortSignal.timeout(4000) });
    if (searchRes.ok) {
      const searchData = await searchRes.json();
      const results = searchData.results || [];

      let targetAlbum = results[0];
      if (isTaylorVersion) {
        const match = results.find(a => /taylor's version/i.test(a.collectionName || ''));
        if (match) targetAlbum = match;
      }

      if (targetAlbum?.collectionViewUrl) {
        const pageRes = await fetch(targetAlbum.collectionViewUrl, {
          headers: { 'User-Agent': IPHONE_USER_AGENT },
          signal: AbortSignal.timeout(4000),
        });

        if (pageRes.ok) {
          const html = await pageRes.text();
          const tallUrl = extractTallUrlFromRawString(html);
          if (tallUrl) return tallUrl;
        }
      }
    }
  } catch (err) {}

  return null;
}

// ─────────────────────────────────────────────────────────────
// 6. SPOTIFY & LRCLIB LYRICS ENGINE
// ─────────────────────────────────────────────────────────────

async function getSpotifyToken() {
  if (!SPOTIFY_SP_DC) return null;
  if (cachedSpotifyToken && Date.now() < spotifyTokenExpiresAt) return cachedSpotifyToken;

  try {
    const cleanCookie = SPOTIFY_SP_DC.replace('sp_dc=', '').trim();
    const headers = {
      'Cookie': `sp_dc=${cleanCookie}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    };

    const res = await fetch('https://open.spotify.com/', { headers, signal: AbortSignal.timeout(5000) });
    const html = await res.text();

    const sessionMatch = html.match(/<script id="session"[^>]*>([^<]+)<\/script>/);
    if (sessionMatch && sessionMatch[1]) {
      const sessionData = JSON.parse(sessionMatch[1]);
      if (!sessionData.isAnonymous) {
        cachedSpotifyToken = sessionData.accessToken;
        spotifyTokenExpiresAt = sessionData.accessTokenExpirationTimestampMs - 60000;
        return cachedSpotifyToken;
      }
    }
  } catch (e) {}
  return null;
}

async function getSpotifyLyrics(title, artist) {
  const token = await getSpotifyToken();
  if (!token) return null;

  try {
    const cleanTitle = cleanTrackTitle(title);
    const query = encodeURIComponent(`track:${cleanTitle} artist:${artist}`);
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

async function getLrclibLyrics(title, artist) {
  try {
    const cleanTitle = cleanTrackTitle(title);
    const searchUrl = new URL('https://lrclib.net/api/search');
    searchUrl.searchParams.append('q', `${cleanTitle} ${artist}`);
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

// ─────────────────────────────────────────────────────────────
// 7. API ENDPOINTS
// ─────────────────────────────────────────────────────────────

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
      duration: t.duration || 0,
    }));

    res.json({ tracks });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Audio Stream (Byte-Range Proxy)
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
    const controller = new AbortController();
    req.on('close', () => controller.abort());

    const tidalResponse = await fetch(directStreamUrl, { 
      headers: { 'Range': clientRange },
      signal: controller.signal 
    });
    
    res.status(tidalResponse.status);
    ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach((h) => {
      const val = tidalResponse.headers.get(h);
      if (val) res.setHeader(h, val);
    });
    res.setHeader('Accept-Ranges', 'bytes');
    
    try {
      await pipeline(Readable.fromWeb(tidalResponse.body), res);
    } catch (err) {}
  } catch (error) {
    console.error('[Stream Error]', error.message);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// Video Search (Filtered & Ranked)
app.get('/api/search-video', async (req, res) => {
  try {
    const { q, duration } = req.query;
    if (!q) return res.status(400).json({ error: 'Search query required.' });

    const token = await getAccessToken();
    const cleanQ = cleanTrackTitle(q);

    const searchUrl = `https://api.tidal.com/v1/search?query=${encodeURIComponent(cleanQ)}&limit=30&types=VIDEOS&countryCode=US`;
    const searchRes = await fetch(searchUrl, {
      headers: { 'Authorization': `Bearer ${token}`, 'x-tidal-token': CLIENT_ID },
      signal: AbortSignal.timeout(5000),
    });

    if (!searchRes.ok) throw new Error('Video search request failed');
    
    const searchData = await searchRes.json();
    let rawItems = searchData.videos?.items || searchData.items || [];

    // Filter and score videos
    const bestVid = selectBestVideo(rawItems, q, '');
    const sharedOffset = bestVid ? await getAccurateVideoIntroOffset(bestVid.title, bestVid.artist?.name || '', bestVid.duration, duration) : 0;

    const videos = rawItems
      .filter(v => !LIVE_KEYWORDS_REGEX.test(`${v.title || ''} ${v.version || ''}`))
      .slice(0, 10)
      .map((v) => ({
        id: v.id,
        title: v.version ? `${v.title} (${v.version})` : v.title, 
        artist: v.artist?.name || v.artists?.[0]?.name || 'Unknown Artist',
        thumbnailUrl: v.imageId ? `https://resources.tidal.com/images/${v.imageId.replace(/-/g, '/')}/320x240.jpg` : null,
        duration: v.duration,
        startOffset: sharedOffset,
      }));

    res.json({ videos });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get Video Stream URL (.m3u8 CDN link)
app.get('/api/video', async (req, res) => {
  try {
    const { videoId } = req.query;
    if (!videoId) return res.status(400).json({ error: 'videoId is required' });

    const directStreamUrl = await getTidalVideoStreamUrl(videoId);
    res.json({ success: true, videoUrl: directStreamUrl });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Official Matched Music Video (Multi-Tier Studio Verification)
app.get('/api/official-video', async (req, res) => {
  try {
    const { title, artist, duration } = req.query;
    if (!title || !artist) return res.status(400).json({ error: 'title and artist required.' });

    const token = await getAccessToken();
    const cleanTitle = cleanTrackTitle(title);
    
    const searchQuery = `${cleanTitle} ${artist}`;
    const searchUrl = `https://api.tidal.com/v1/search?query=${encodeURIComponent(searchQuery)}&limit=30&types=VIDEOS&countryCode=US`;
    
    const searchRes = await fetch(searchUrl, {
      headers: { 'Authorization': `Bearer ${token}`, 'x-tidal-token': CLIENT_ID },
      signal: AbortSignal.timeout(5000),
    });

    if (!searchRes.ok) throw new Error('Video search request failed');
    const searchData = await searchRes.json();
    let items = searchData.videos?.items || searchData.items || [];

    if (items.length === 0) {
      return res.json({ found: false, message: 'No videos found for this track.' });
    }

    // Select best video via Multi-Tier Studio Selector
    const bestVideo = selectBestVideo(items, title, artist);

    if (!bestVideo) {
      return res.json({ found: false, message: 'Studio video unavailable.' });
    }

    const startOffset = await getAccurateVideoIntroOffset(title, artist, bestVideo.duration, duration);
    const directStreamUrl = await getTidalVideoStreamUrl(bestVideo.id);

    res.json({
      found: true,
      videoId: bestVideo.id,
      title: bestVideo.version ? `${bestVideo.title} (${bestVideo.version})` : bestVideo.title,
      duration: bestVideo.duration,
      startOffset: startOffset,
      videoUrl: directStreamUrl
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Apple Motion & Color (Taylor's Version Safe)
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

// Lyrics Endpoint
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
