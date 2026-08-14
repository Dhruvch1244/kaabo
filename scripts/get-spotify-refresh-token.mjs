// One-time local helper: run this on your own machine to mint a Spotify
// refresh token for the portfolio site's "now playing" / "top artists"
// widgets. The token is printed to YOUR terminal only -- it never leaves
// your machine through this script, and should go straight into Render's
// dashboard as SPOTIFY_REFRESH_TOKEN, never into a repo or a chat.
//
// Setup:
//   1. https://developer.spotify.com/dashboard -> your app -> Settings ->
//      add Redirect URI: http://127.0.0.1:8888/callback
//   2. In this terminal:
//        export SPOTIFY_CLIENT_ID=xxxx
//        export SPOTIFY_CLIENT_SECRET=xxxx
//        node scripts/get-spotify-refresh-token.mjs
//   3. Open the printed URL, log in, approve. The script catches the
//      redirect automatically and prints the refresh token.

import http from 'node:http';

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = 'http://127.0.0.1:8888/callback';
const SCOPES = ['user-read-currently-playing', 'user-top-read'].join(' ');

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in your shell first.');
  process.exit(1);
}

const authUrl = new URL('https://accounts.spotify.com/authorize');
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('scope', SCOPES);

console.log('\nOpen this URL, log in, and approve access:\n');
console.log(authUrl.toString());
console.log('\nWaiting for the redirect on http://127.0.0.1:8888 ...\n');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  if (url.pathname !== '/callback') {
    res.writeHead(404).end();
    return;
  }

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (error || !code) {
    res.writeHead(400).end('Authorization failed. Check the terminal and try again.');
    console.error('Authorization failed:', error ?? 'no code returned');
    server.close();
    process.exit(1);
  }

  try {
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });
    const data = await tokenRes.json();

    if (!tokenRes.ok || !data.refresh_token) {
      throw new Error(data.error_description ?? 'token exchange failed');
    }

    res.writeHead(200, { 'Content-Type': 'text/html' }).end(
      '<p>Done -- refresh token printed in your terminal. You can close this tab.</p>'
    );
    console.log('Success. Add this as SPOTIFY_REFRESH_TOKEN in Render:\n');
    console.log(data.refresh_token);
    console.log('\nAlso set SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET / SPOTIFY_USER_ID in Render if not already set.');
  } catch (err) {
    res.writeHead(500).end('Token exchange failed. Check the terminal.');
    console.error('Token exchange failed:', err.message);
  } finally {
    server.close();
    process.exit(0);
  }
});

server.listen(8888);
