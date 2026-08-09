// Add this helper function to server.js

// Public token used by Apple Music Web Player
const APPLE_MUSIC_TOKEN =
  'eyJhbGciOiJFUzI1NicbdHlwIjoiSldUIiwia2lkIjI3N01MVE1IUFkifQ.eyJpc3MiOiJBMjI4VEpaNzRTIiwiaWF0IjoxNzA0MDY3MjAwLCJleHAiOjE3NzA2MDM2MDB9.sample';

async function getAppleMotionUrl(albumTitle, artistName) {
  try {
    const query = `${albumTitle} ${artistName}`;
    const searchUrl = `https://amp-api.music.apple.com/v1/catalog/us/search?term=${encodeURIComponent(
      query
    )}&types=albums&limit=1`;

    const searchRes = await fetch(searchUrl, {
      headers: {
        'Authorization': `Bearer ${APPLE_MUSIC_TOKEN}`,
        'Origin': 'https://music.apple.com',
      },
    });

    if (!searchRes.ok) return null;

    const searchData = await searchRes.json();
    const album = searchData.results?.albums?.data?.[0];

    if (!album) return null;

    // Fetch full album catalog details including editorial video assets
    const albumDetailUrl = `https://amp-api.music.apple.com/v1/catalog/us/albums/${album.id}?include=editorialVideo`;
    const detailRes = await fetch(albumDetailUrl, {
      headers: {
        'Authorization': `Bearer ${APPLE_MUSIC_TOKEN}`,
        'Origin': 'https://music.apple.com',
      },
    });

    if (!detailRes.ok) return null;

    const detailData = await detailRes.json();
    const albumAttributes = detailData.data?.[0]?.attributes;
    const editorialVideo = albumAttributes?.editorialVideo;

    // Check for square (1:1 ratio) motion video assets
    const motionVideoObj =
      editorialVideo?.motionDetailSquare ||
      editorialVideo?.motionSquare ||
      editorialVideo?.motionDetailTall;

    if (motionVideoObj) {
      // Return direct MP4 or video URL
      return (
        motionVideoObj.video ||
        motionVideoObj.response?.video ||
        motionVideoObj.assets?.[0]?.url ||
        null
      );
    }
  } catch (err) {
    console.warn('Apple Motion fetch error:', err.message);
  }
  return null;
}

// Endpoint: GET /api/motion?album=After%20Hours&artist=The%20Weeknd
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
