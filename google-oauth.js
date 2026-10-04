#!/usr/bin/env node
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OAuth2Client } from 'google-auth-library';

const SCOPE = 'https://www.googleapis.com/auth/calendar.events';

export function oauthSettings(env) {
  const port = Number(env.GOOGLE_OAUTH_PORT ?? 8085);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid GOOGLE_OAUTH_PORT.');
  return { port, redirectUri: `http://127.0.0.1:${port}/` };
}

export async function authorizeGoogle(env) {
  const { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret } = env;
  if (!id || !secret) throw new Error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET for a Google Desktop app OAuth client.');
  const { port, redirectUri } = oauthSettings(env);
  const client = new OAuth2Client(id, secret, redirectUri);
  const state = randomBytes(32).toString('hex');
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  let resolveAuthorization, rejectAuthorization;
  const authorization = new Promise((resolve, reject) => {
    resolveAuthorization = resolve;
    rejectAuthorization = reject;
  });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', redirectUri);
    if (request.method !== 'GET' || url.pathname !== '/') {
      response.writeHead(404).end('Not found.');
      return;
    }
    if (url.searchParams.get('state') !== state) {
      response.writeHead(400).end('Invalid OAuth state.');
      return;
    }
    if (url.searchParams.get('error')) {
      const error = new Error(`Google authorization failed: ${url.searchParams.get('error')}`);
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end(error.message);
      rejectAuthorization(error);
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      response.writeHead(400).end('Missing authorization code.');
      rejectAuthorization(new Error('Google callback did not include an authorization code.'));
      return;
    }
    try {
      const { tokens } = await client.getToken({ code, codeVerifier });
      if (!tokens.refresh_token) throw new Error('Google did not return a refresh token; revoke the existing grant and authorize again.');
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Google authorization complete. Copy the refresh token from your terminal into Portainer.');
      console.log(`\nGOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
      resolveAuthorization();
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Google authorization failed. Check the terminal.');
      rejectAuthorization(error);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  console.log(`OAuth callback: ${redirectUri}`);
  console.log(`Open this authorization URL in a browser on this machine:\n${client.generateAuthUrl({
    access_type: 'offline', prompt: 'consent', scope: [SCOPE], state,
    code_challenge: codeChallenge, code_challenge_method: 'S256'
  })}`);
  const timer = setTimeout(() => rejectAuthorization(new Error('Google authorization timed out.')), 300000);
  try { await authorization; }
  finally { clearTimeout(timer); await new Promise(resolve => server.close(resolve)); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  authorizeGoogle(process.env).catch(error => { console.error(`Google authorization failed: ${error.message}`); process.exitCode = 1; });
}
