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

// In-Memory Cache
const videoOffsetCache = new Map();
const rawStreamUrlCache = new Map();

// ─────────────────────────────────────────────────────────────
// 1. TIDAL AUDIO STREAMING
// ─────────────────────────────────────────────────────────────

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

    if (data.manifestMimeType === 'application/dash+xml') {
      if (decodedManifest.includes('<ContentProtection')) {
        console.warn(`[Tidal] 🔒 DASH Track ${trackId} is DRM Protected at ${quality}.`);
        if (quality === 'LOSSLESS') return await getTidalStreamUrl(trackId, 'HIGH');
        if (quality === 'HIGH') return await getTidalStreamUrl(trackId, 'LOW');
        throw new Error('Track is strictly DRM protected across all qualities.');
      }

      const baseUrlMatch = decodedManifest.match(/<BaseURL>(.+?)<\/BaseURL>/);
      if (baseUrlMatch && baseUrlMatch[1]) {
        return baseUrlMatch[1].replace(/&amp;/g, '&');
      }
    }

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
      if (urlMatch) return urlMatch[0].replace(/&amp;/g, '&');
    }
  }

  throw new Error('No audio URL found in Tidal manifest.');
}

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

// ─────────────────────────────────────────────────────────────
// 2. YT-DLP DIRECT STREAM EXTRACTOR
// ─────────────────────────────────────────────────────────────

function getStreamUrlFromYtDlp(videoId) {
  return new Promise((resolve, reject) => {
    const ytProcess = spawn('yt-dlp', [
      '-g',
      '-f', '18/22/b[ext=mp4][height<=720]/best[height<=720]/best',
      '--extractor-args', 'youtube:player_client=android,ios,web_safari',
      '--no-warnings',
      '--no-playlist',
      `https://www.youtube.com/watch?v=${videoId}`,
    ]);

    let stdoutData = '';
    let stderrData = '';

    ytProcess.stdout.on('data', (chunk) => {
      stdoutData += chunk.toString();
    });

    ytProcess.stderr.on('data', (chunk) => {
      stderrData += chunk.toString();
    });

    ytProcess.on('close', (code) => {
      if (code === 0 && stdoutData.trim()) {
        const streamUrl = stdoutData.trim().split('\n')[0];
        resolve(streamUrl);
      } else {
        reject(new Error(stderrData || `yt-dlp exited with code ${code}`));
      }
    });

    ytProcess.on('error', (err) => {
      reject(err);
    });
  });
}

async function resolveDirectYouTubeStream(videoId) {
  if (rawStreamUrlCache.has(videoId)) {
    const cached = rawStreamUrlCache.get(videoId);
    if (Date.now() < cached.expiresAt) return cached.url;
  }

  try {
    const directUrl = await getStreamUrlFromYtDlp(videoId);
    if (directUrl) {
      rawStreamUrlCache.set(videoId, { url: directUrl, expiresAt: Date.now() + 3600000 });
      return directUrl;
    }
  } catch (err) {
    console.error(`[yt-dlp Extraction Error for ${videoId}]:`, err.message);
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// 3. TITLE & ARTIST NORMALIZER AND STRICT MATCHER
// ─────────────────────────────────────────────────────────────

function cleanTrackTitle(title) {
  if (!title) return '';
  return title
    .replace(/[-_]/g, ' ')
    .replace(/\((?:taylor's version|from the vault|deluxe|remastered|remaster|bonus track|single version|anniversary|expanded|explicit|original mix|10 minute version)[^)]*\)/gi, '')
    .replace(/\[(?:taylor's version|from the vault|deluxe|remastered|remaster|bonus track|single version|anniversary|expanded|explicit|original mix|10 minute version)[^\]]*\]/gi, '')
    .replace(/-\s*(?:remastered|remaster|deluxe|single version|bonus track|live|from the vault).*/gi, '')
    .replace(/\s+feat\..*/gi, '')
    .replace(/\s+ft\..*/gi, '')
    .replace(/\s+with\s+.*/gi, '')
    .replace(/[^\w\s]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function cleanString(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const DISQUALIFY_REGEX = /\b(behind the scenes|making of|bts|in the studio|trailer|teaser|snippet|preview|interview|vlog|track by track|unboxing|promo|commentary|reaction|reacts|review|parody|karaoke|instrumental|slowed|reverb|speed up|sped up|nightcore|1 hour|10 hours|8d audio|mashup|without cut scene|no dialogue|fan made|fan edit|remastered & lyrics|hd remastered|& lyrics|with lyrics|w\/ lyrics|color coded|sub español|legendado|4k 60fps)\b/i;
const LIVE_KEYWORDS_REGEX = /\b(live|unplugged|performance|concert|festival|session|sessions|tour|stage|awards|rehearsal|acoustic|bbc radio|live at|live from|en vivo|ao vivo)\b/i;
const SHORT_FILM_REGEX = /\b(short film|the short film|directors cut|director's cut|extended cut|the movie|cinematic video)\b/i;
const OFFICIAL_MV_REGEX = /\b(official music video|official video|\(official video\)|\(official music video\)|\[official music video\]|\[official video\]|\(official\)|\[official\]|\bm\/v\b|\b\(mv\)\b|official visual album)\b/i;
const LYRIC_KEYWORDS_REGEX = /\b(official lyric video|official lyrics|lyric video|lyrics video|lyric|lyrics)\b/i;
const VISUALIZER_REGEX = /\b(official visualizer|visualizer|audio video|track video)\b/i;
const AUDIO_ONLY_REGEX = /\b(official audio|audio|topic)\b/i;

function getYouTubeVideoCategory(videoTitle) {
  const title = (videoTitle || '').toLowerCase();
  if (DISQUALIFY_REGEX.test(title)) return 'DISQUALIFIED';
  if (SHORT_FILM_REGEX.test(title)) return 'SHORT_FILM';
  if (OFFICIAL_MV_REGEX.test(title)) return 'OFFICIAL_VIDEO';
  if (LYRIC_KEYWORDS_REGEX.test(title)) return 'LYRIC_VIDEO';
  if (VISUALIZER_REGEX.test(title)) return 'VISUALIZER';
  if (LIVE_KEYWORDS_REGEX.test(title)) return 'LIVE';
  if (AUDIO_ONLY_REGEX.test(title)) return 'AUDIO';
  return 'OTHER';
}

function getYouTubeVideoScore(video, targetTitle, targetArtist, targetDurationSec = 0) {
  const vTitle = (video.title || '').toLowerCase();
  const vAuthor = (video.author || '').toLowerCase();

  const cleanTarget = cleanTrackTitle(targetTitle).toLowerCase();
  const cleanVTitle = cleanTrackTitle(vTitle).toLowerCase();
  const rawTarget = (targetTitle || '').toLowerCase();
  const artist = (targetArtist || '').toLowerCase();

  // 1. Strict Disqualification
  if (DISQUALIFY_REGEX.test(vTitle) && !DISQUALIFY_REGEX.test(rawTarget)) {
    return -5000;
  }
  if (video.seconds && video.seconds < 45) {
    return -5000;
  }

  // 2. Mandatory Title Word Verification
  const targetWords = cleanTarget.split(/\s+/).filter((w) => w.length > 1);
  if (targetWords.length > 0) {
    const matchedWords = targetWords.filter((w) => cleanVTitle.includes(w));
    const matchRatio = matchedWords.length / targetWords.length;
    if (matchRatio < 0.6) {
      return -5000; // Complete mismatch
    }
  }

  let score = 0;

  // 3. Exact Substring Match Bonus
  if (cleanVTitle.includes(cleanTarget) || vTitle.includes(cleanTarget)) {
    score += 600;
  } else {
    score += 200;
  }

  // 4. Channel Verification (Strict: Must be the actual artist's channel)
  const artistClean = cleanString(artist);
  const authorClean = cleanString(vAuthor);

  const isAuthorMatch =
    authorClean.includes(artistClean) ||
    artistClean.includes(authorClean) ||
    (vAuthor.includes('vevo') && artist.split(' ').some((part) => vAuthor.includes(part.toLowerCase())));

  if (isAuthorMatch) {
    score += 1500; // Huge boost for the verified artist/VEVO channel
  } else {
    score -= 1500; // Heavy penalty for 3rd-party fan uploaders (like Nova Tracks)
  }

  // 5. Category Priority
  const category = getYouTubeVideoCategory(vTitle);
  if (category === 'SHORT_FILM') score += 800;
  else if (category === 'OFFICIAL_VIDEO') score += 1000;
  else if (category === 'LYRIC_VIDEO') score += 300;
  else if (category === 'VISUALIZER') score += 150;
  else if (category === 'AUDIO') score += 50;

  // 6. Live Penalty
  const isExplicitlyLive = LIVE_KEYWORDS_REGEX.test(rawTarget);
  if (!isExplicitlyLive && (LIVE_KEYWORDS_REGEX.test(vTitle) || category === 'LIVE')) {
    score -= 1500;
  }

  // 7. Sanity Check for Extended Fan Loops (e.g. 529s for a 200s song)
  const vSeconds = video.seconds || 0;
  if (targetDurationSec > 0 && vSeconds > 0) {
    if (vSeconds > targetDurationSec * 2.2 + 45 && category !== 'SHORT_FILM') {
      score -= 2500; // Over twice the song duration
    }
  }

  return score;
}

// ─────────────────────────────────────────────────────────────
// 4. ZERO-DEPENDENCY YOUTUBE SEARCH & PARSER
// ─────────────────────────────────────────────────────────────

function parseDurationToSeconds(durationStr) {
  if (!durationStr || typeof durationStr !== 'string') return 0;
  const parts = durationStr.split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

async function searchYouTubeNative(query) {
  try {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return [];
    const html = await res.text();

    const dataMatch =
      html.match(/var ytInitialData\s*=\s*({.+?});<\/script>/s) ||
      html.match(/window\["ytInitialData"\]\s*=\s*({.+?});<\/script>/s);

    if (!dataMatch) return [];

    const json = JSON.parse(dataMatch[1]);
    const sections = json?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];

    const videos = [];
    for (const section of sections) {
      const items = section?.itemSectionRenderer?.contents || [];
      for (const item of items) {
        const v = item.videoRenderer;
        if (v && v.videoId) {
          const durationText = v.lengthText?.simpleText || '0:00';
          videos.push({
            videoId: v.videoId,
            title: v.title?.runs?.[0]?.text || '',
            author: v.ownerText?.runs?.[0]?.text || '',
            seconds: parseDurationToSeconds(durationText),
            thumbnail: v.thumbnail?.thumbnails?.slice(-1)[0]?.url || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
            description: v.detailedMetadataSnippets?.[0]?.snippetText?.runs?.map((r) => r.text).join('') || '',
          });
        }
      }
    }

    return videos;
  } catch (err) {
    console.warn(`[YouTube Search Native Error] ${err.message}`);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// 5. SPONSORBLOCK INTRO OFFSET ENGINE
// ─────────────────────────────────────────────────────────────

async function getSponsorBlockIntroOffset(ytVideoId) {
  try {
    const url = `https://sponsor.ajay.app/api/skipSegments?videoID=${ytVideoId}&categories=["music_offtopic"]`;
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;

    const segments = await res.json();
    if (Array.isArray(segments)) {
      const intro = segments.find((s) => Array.isArray(s.segment) && s.segment[0] <= 3);
      if (intro && intro.segment[1] > 2) {
        return Number(intro.segment[1].toFixed(2));
      }
    }
  } catch (err) {}
  return null;
}

async function getAccurateVideoIntroOffset(title, artist, ytVideoId, videoDuration, audioDuration) {
  const cleanTitle = cleanTrackTitle(title);
  const cacheKey = `${cleanTitle.toLowerCase()}|${(artist || '').toLowerCase()}|${ytVideoId}`;
  if (videoOffsetCache.has(cacheKey)) {
    return videoOffsetCache.get(cacheKey);
  }

  const vDur = Number(videoDuration > 10000 ? videoDuration / 1000 : videoDuration) || 0;
  const aDur = Number(audioDuration > 10000 ? audioDuration / 1000 : audioDuration) || 0;

  let calculatedOffset = 0;

  if (ytVideoId) {
    const sbOffset = await getSponsorBlockIntroOffset(ytVideoId);
    if (sbOffset !== null && sbOffset > 0) {
      calculatedOffset = sbOffset;
    }
  }

  if (calculatedOffset === 0 && vDur > 0 && aDur > 0) {
    const delta = vDur - aDur;
    if (delta >= 3 && delta < 60) {
      calculatedOffset = Number(delta.toFixed(2));
    }
  }

  videoOffsetCache.set(cacheKey, calculatedOffset);
  return calculatedOffset;
}

// ─────────────────────────────────────────────────────────────
// 6. APPLE MOTION & SPOTIFY / LRCLIB LYRICS
// ─────────────────────────────────────────────────────────────

async function getAppleDeveloperToken() {
  if (cachedAppleToken && Date.now() < appleTokenExpiresAt) return cachedAppleToken;
  if (Date.now() - lastAppleTokenAttempt < 10 * 60 * 1000) return null;

  lastAppleTokenAttempt = Date.now();

  try {
    const res = await fetch('https://music.apple.com/us/browse', {
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15' },
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
  } catch (err) {}
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
  const exactQuery = `${albumTitle} ${artistName}`;
  const isTaylorVersion = /taylor's version/i.test(albumTitle);

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
        let targetAlbum = albums[0];
        if (isTaylorVersion) {
          const match = albums.find((a) => /taylor's version/i.test(a.attributes?.name || ''));
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

  try {
    const iTunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(exactQuery)}&entity=album&limit=5`;
    const searchRes = await fetch(iTunesUrl, { signal: AbortSignal.timeout(4000) });
    if (searchRes.ok) {
      const searchData = await searchRes.json();
      const results = searchData.results || [];

      let targetAlbum = results[0];
      if (isTaylorVersion) {
        const match = results.find((a) => /taylor's version/i.test(a.collectionName || ''));
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

    const lyricsRes = await fetch(`https://spclient.wg.spotify.com/color-lyrics/v2/track/${trackId}?format=json&market=from-token`, {
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

    spotifyLyrics.lines.forEach((line) => {
      plainString += line.words + '\n';
      if (!line.startTimeMs) return;
      const lineTime = parseInt(line.startTimeMs, 10);
      const lMins = String(Math.floor(lineTime / 60000)).padStart(2, '0');
      const lSecs = ((lineTime % 60000) / 1000).toFixed(2).padStart(5, '0');
      let lineContent = '';

      if (isWordByWord && line.syllables && line.syllables.length > 0) {
        line.syllables.forEach((syllable) => {
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
        const wordByWordMatch = results.find((r) => r.syncedLyrics && enhancedLrcRegex.test(r.syncedLyrics));
        if (wordByWordMatch) return { ...wordByWordMatch, isWordByWord: true };

        const lineByLineMatch = results.find((r) => r.syncedLyrics);
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
      signal: controller.signal,
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

// YouTube Video Byte-Range Stream Proxy (yt-dlp Stream Proxy)
app.get('/api/yt-stream', async (req, res) => {
  try {
    const { videoId } = req.query;
    if (!videoId) return res.status(400).json({ error: 'videoId is required' });

    const rawUrl = await resolveDirectYouTubeStream(videoId);
    if (!rawUrl) {
      return res.status(404).json({ error: 'Failed to resolve YouTube media stream with yt-dlp.' });
    }

    const clientRange = req.headers.range || 'bytes=0-';
    const controller = new AbortController();
    req.on('close', () => controller.abort());

    const upstreamRes = await fetch(rawUrl, {
      headers: {
        'Range': clientRange,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      signal: controller.signal,
    });

    res.status(upstreamRes.status);
    ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach((h) => {
      const val = upstreamRes.headers.get(h);
      if (val) res.setHeader(h, val);
    });
    res.setHeader('Accept-Ranges', 'bytes');

    try {
      await pipeline(Readable.fromWeb(upstreamRes.body), res);
    } catch (err) {}
  } catch (error) {
    console.error('[YT-Stream Error]', error.message);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// YouTube Video Search
app.get('/api/search-video', async (req, res) => {
  try {
    const { q, duration } = req.query;
    if (!q) return res.status(400).json({ error: 'Search query required.' });

    const host = req.get('host');
    const protocol = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const baseUrl = `${protocol}://${host}`;

    const cleanQ = cleanTrackTitle(q);
    const targetDurationSec = Number(duration > 10000 ? duration / 1000 : duration) || 0;

    const rawVideos = await searchYouTubeNative(`${cleanQ} official music video`);

    const scoredVideos = rawVideos
      .map((v) => {
        const category = getYouTubeVideoCategory(v.title);
        const score = getYouTubeVideoScore(v, cleanQ, '', targetDurationSec);
        return {
          id: v.videoId,
          title: v.title,
          artist: v.author || 'Unknown Artist',
          thumbnailUrl: v.thumbnail,
          duration: v.seconds,
          category: category,
          score: score,
          videoUrl: `${baseUrl}/api/yt-stream?videoId=${v.videoId}`,
          embedUrl: `https://www.youtube-nocookie.com/embed/${v.videoId}?autoplay=1&enablejsapi=1`,
        };
      })
      .filter((v) => v.score > -500 && v.category !== 'DISQUALIFIED')
      .sort((a, b) => b.score - a.score);

    res.json({ videos: scoredVideos.slice(0, 15) });
  } catch (error) {
    console.error('[YouTube Search Video Error]', error.message);
    res.status(500).json({ error: error.message });
  }
});

// YouTube Video Details
app.get('/api/video', async (req, res) => {
  try {
    const { videoId } = req.query;
    if (!videoId) return res.status(400).json({ error: 'videoId is required' });

    const host = req.get('host');
    const protocol = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const baseUrl = `${protocol}://${host}`;

    const sbOffset = await getSponsorBlockIntroOffset(videoId);

    res.json({
      success: true,
      videoId: videoId,
      videoUrl: `${baseUrl}/api/yt-stream?videoId=${videoId}`,
      startOffset: sbOffset || 0,
      embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&enablejsapi=1`,
      watchUrl: `https://www.youtube.com/watch?v=${videoId}`,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Official Matched YouTube Video (Music Video / Short Film / Lyric Video)
app.get('/api/official-video', async (req, res) => {
  try {
    const { title, artist, duration, preferType } = req.query;
    if (!title || !artist) return res.status(400).json({ error: 'title and artist required.' });

    const host = req.get('host');
    const protocol = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const baseUrl = `${protocol}://${host}`;

    const cleanTitle = cleanTrackTitle(title);
    const cleanArtist = cleanTrackTitle(artist);
    const audioDurSec = Number(duration > 10000 ? duration / 1000 : duration) || 0;

    const queries = [
      `${cleanTitle} ${cleanArtist} official music video`,
      `${cleanArtist} ${cleanTitle} official`,
      `${cleanArtist} ${cleanTitle} vevo`,
      `${cleanTitle} ${cleanArtist} short film`,
      `${cleanTitle} ${cleanArtist} lyric video`,
    ];

    const responses = await Promise.all(queries.map((q) => searchYouTubeNative(q)));

    const seenIds = new Set();
    const candidateVideos = [];

    for (const vList of responses) {
      for (const v of vList) {
        if (!seenIds.has(v.videoId)) {
          seenIds.add(v.videoId);
          candidateVideos.push(v);
        }
      }
    }

    if (candidateVideos.length === 0) {
      return res.json({ found: false, message: 'No YouTube videos found.' });
    }

    const scoredList = candidateVideos.map((v) => {
      let score = getYouTubeVideoScore(v, cleanTitle, cleanArtist, audioDurSec);
      const category = getYouTubeVideoCategory(v.title);

      if (preferType && category === preferType.toUpperCase()) {
        score += 800;
      }

      return { video: v, score, category };
    });

    scoredList.sort((a, b) => b.score - a.score);

    const topMatch = scoredList[0];
    if (!topMatch || topMatch.score < -400 || topMatch.category === 'DISQUALIFIED') {
      return res.json({ found: false, message: 'No accurate match found on YouTube.' });
    }

    const bestVideo = topMatch.video;
    const startOffset = await getAccurateVideoIntroOffset(cleanTitle, cleanArtist, bestVideo.videoId, bestVideo.seconds, audioDurSec);

    res.json({
      found: true,
      videoId: bestVideo.videoId,
      videoUrl: `${baseUrl}/api/yt-stream?videoId=${bestVideo.videoId}`,
      title: bestVideo.title,
      artist: bestVideo.author || artist,
      duration: bestVideo.seconds,
      thumbnailUrl: bestVideo.thumbnail,
      category: topMatch.category,
      startOffset: startOffset,
      embedUrl: `https://www.youtube-nocookie.com/embed/${bestVideo.videoId}?autoplay=1&enablejsapi=1`,
      watchUrl: `https://www.youtube.com/watch?v=${bestVideo.videoId}`,
    });
  } catch (error) {
    console.error('[Official Video Error]', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Apple Motion & Color
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
    const motionUrl = await Promise.race([getAppleMotionUrl(album, artist), timeoutPromise]);

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
