#!/usr/bin/env node
// Run once on a workstation with a browser, not inside the unattended container.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
const { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret } = process.env;
if (!id || !secret) throw new Error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET for a Google Desktop app OAuth client.');
const port = Number(process.env.GOOGLE_OAUTH_PORT ?? 8085);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid GOOGLE_OAUTH_PORT.');
const redirect = `http://127.0.0.1:${port}/`;
const client = new OAuth2Client(id, secret, redirect);
const state = randomBytes(32).toString('hex');
const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
let finish;
const completion = new Promise(resolve => { finish = resolve; });
const server = createServer(async (request, response) => {
  const url = new URL(request.url, redirect);
  if (url.pathname !== '/' || url.searchParams.get('state') !== state) { response.writeHead(400).end('Invalid callback'); return; }
  try {
    if (!url.searchParams.get('code')) throw new Error('Authorization declined or no code returned.');
    const { tokens } = await client.getToken({ code: url.searchParams.get('code'), codeVerifier });
    if (!tokens.refresh_token) throw new Error('No refresh token returned. Revoke the previous grant and authorize again.');
    response.end('Authorization complete. Return to your terminal.');
    console.log(`\nGOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
  } catch { response.writeHead(400).end('Authorization failed; check terminal.'); console.error('OAuth authorization failed.'); process.exitCode = 1; }
  finally { finish(); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
console.log(`OAuth redirect URI: ${redirect}\nUse a Desktop app client. For a Web application client, register this exact URI under Authorized redirect URIs.\n`);
console.log('Open this URL in your workstation browser:\n' + client.generateAuthUrl({
  access_type: 'offline', prompt: 'consent', scope: ['https://www.googleapis.com/auth/calendar.events'],
  state, code_challenge: codeChallenge, code_challenge_method: 'S256'
}));
const timer = setTimeout(() => { console.error('OAuth authorization timed out.'); process.exitCode = 1; finish(); }, 300000);
await completion; clearTimeout(timer); server.close();
