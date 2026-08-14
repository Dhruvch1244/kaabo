// Proxies a few read-only Spotify endpoints for the portfolio site.
//
// "Now playing" and "top artists" are private to Dhruv's account, so they
// need a one-time user authorization (see scripts/get-spotify-refresh-token.mjs)
// that produces a long-lived refresh token, stored only as a Render env var
// (SPOTIFY_REFRESH_TOKEN) -- never in the repo. That refresh token is
// exchanged here for short-lived access tokens on demand.
//
// Playlists are public, so they use the simpler client-credentials
// (app-only) flow -- no user authorization needed for those.

const TOKEN_URL = 'https://accounts.spotify.com/api/token';

let userToken = null; // { accessToken, expiresAt }
let appToken = null; // { accessToken, expiresAt }

function basicAuthHeader() {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) return null;
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
}

async function getUserAccessToken() {
  if (userToken && userToken.expiresAt > Date.now()) return userToken.accessToken;

  const auth = basicAuthHeader();
  const refreshToken = process.env.SPOTIFY_REFRESH_TOKEN;
  if (!auth || !refreshToken) return null;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  userToken = { accessToken: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return userToken.accessToken;
}

async function getAppAccessToken() {
  if (appToken && appToken.expiresAt > Date.now()) return appToken.accessToken;

  const auth = basicAuthHeader();
  if (!auth) return null;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  appToken = { accessToken: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return appToken.accessToken;
}

function cached(ttlMs) {
  let value = null;
  let expiresAt = 0;
  return {
    get: () => (Date.now() < expiresAt ? value : null),
    set: (v) => {
      value = v;
      expiresAt = Date.now() + ttlMs;
    },
  };
}

const nowPlayingCache = cached(10_000);
const topArtistsCache = cached(60 * 60_000);
const playlistsCache = cached(60 * 60_000);

async function getNowPlaying() {
  const cachedValue = nowPlayingCache.get();
  if (cachedValue) return cachedValue;

  const token = await getUserAccessToken();
  if (!token) return null;

  const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { Authorization: `Bearer ${token}` },
  });

  let result;
  if (res.status === 204 || !res.ok) {
    result = { isPlaying: false };
  } else {
    const data = await res.json();
    if (!data.item) {
      result = { isPlaying: false };
    } else {
      result = {
        isPlaying: Boolean(data.is_playing),
        track: data.item.name,
        artist: data.item.artists.map((a) => a.name).join(', '),
        album: data.item.album?.name ?? '',
        albumArt: data.item.album?.images?.[0]?.url ?? null,
        url: data.item.external_urls?.spotify ?? null,
        progressMs: data.progress_ms ?? 0,
        durationMs: data.item.duration_ms ?? 0,
      };
    }
  }
  nowPlayingCache.set(result);
  return result;
}

async function getTopArtists() {
  const cachedValue = topArtistsCache.get();
  if (cachedValue) return cachedValue;

  const token = await getUserAccessToken();
  if (!token) return null;

  const res = await fetch('https://api.spotify.com/v1/me/top/artists?time_range=medium_term&limit=8', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const result = (data.items ?? []).map((a) => ({
    name: a.name,
    url: a.external_urls?.spotify ?? null,
    image: a.images?.[a.images.length - 1]?.url ?? a.images?.[0]?.url ?? null,
    genres: a.genres ?? [],
  }));
  topArtistsCache.set(result);
  return result;
}

async function getPlaylists() {
  const cachedValue = playlistsCache.get();
  if (cachedValue) return cachedValue;

  const userId = process.env.SPOTIFY_USER_ID;
  const token = await getAppAccessToken();
  if (!token || !userId) return null;

  const res = await fetch(`https://api.spotify.com/v1/users/${encodeURIComponent(userId)}/playlists?limit=20`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const result = (data.items ?? [])
    .filter((p) => p.public)
    .map((p) => ({
      name: p.name,
      description: p.description ?? '',
      url: p.external_urls?.spotify ?? null,
      image: p.images?.[0]?.url ?? null,
      trackCount: p.tracks?.total ?? 0,
    }));
  playlistsCache.set(result);
  return result;
}

module.exports = { getNowPlaying, getTopArtists, getPlaylists };
