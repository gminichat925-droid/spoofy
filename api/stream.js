import { Innertube, UniversalCache } from 'youtubei.js';

let innertubePromise = null;

async function getInnertubeInstance() {
  if (!innertubePromise) {
    innertubePromise = Innertube.create({
      cache: new UniversalCache(false),
      generate_session_locally: true,
    });
  }
  return innertubePromise;
}

export default async function handler(req, res) {
  try {
    const { videoId } = req.query;
    if (!videoId) return res.status(400).json({ error: 'Missing videoId parameter' });

    const youtube = await getInnertubeInstance();

    // Fetch video info using YTMUSIC client (returns unencrypted direct URLs)
    const info = await youtube.getInfo(videoId, 'YTMUSIC');

    // Select the best audio-only stream
    const format = info.chooseFormat({
      type: 'audio',
      quality: 'best',
      format: 'any',
    });

    if (!format) {
      return res.status(404).json({ error: 'No playable audio formats found' });
    }

    // SAFE EXTRACT: Use format.url first. Only call decipher if url is missing and cipher exists.
    let streamUrl = format.url;
    
    if (!streamUrl && (format.signature_cipher || format.cipher)) {
      streamUrl = format.decipher(youtube.session.player);
    }

    if (!streamUrl) {
      return res.status(500).json({ error: 'Could not extract stream URL' });
    }

    return res.status(200).json({
      title: info.basic_info.title,
      artist: info.basic_info.author,
      artwork: info.basic_info.thumbnail?.[0]?.url,
      streamUrl,
    });
  } catch (error) {
    console.error('Vercel stream resolution error:', error);
    return res.status(500).json({
      error: 'Vercel proxy failed to resolve stream',
      details: error.message,
    });
  }
}