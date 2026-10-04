#!/usr/bin/env node
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OAuth2Client } from 'google-auth-library';

const SCOPE = 'https://www.googleapis.com/auth/calendar.events';

export function oauthSettings(env) {
  const port = Number(env.GOOGLE_OAUTH_PORT ?? 8085);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid GOOGLE_OAUTH_PORT.');
  const redirectUri = env.GOOGLE_OAUTH_REDIRECT_URI ?? `http://127.0.0.1:${port}/`;
  let redirect;
  try { redirect = new URL(redirectUri); } catch { throw new Error('GOOGLE_OAUTH_REDIRECT_URI must be a complete URL.'); }
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname);
  if ((redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' && isLoopback)) ||
      redirect.username || redirect.password || redirect.search || redirect.hash) {
    throw new Error('GOOGLE_OAUTH_REDIRECT_URI must use HTTPS (HTTP is allowed only for localhost) and have no credentials, query, or fragment.');
  }
  return { redirectUri: redirect.toString(), callbackPath: redirect.pathname, port };
}

export async function saveGoogleRefreshToken(tokenPath, refreshToken) {
  if (!refreshToken) throw new Error('Cannot save an empty Google refresh token.');
  await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
  const temporary = `${tokenPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ refresh_token: refreshToken }), { mode: 0o600 });
    await rename(temporary, tokenPath);
  } finally { await rm(temporary, { force: true }); }
}

export async function authorizeGoogle(env, tokenPath) {
  const { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret } = env;
  if (!id || !secret) throw new Error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET for a Google OAuth Web application client.');
  const { redirectUri, callbackPath, port } = oauthSettings(env);
  const client = new OAuth2Client(id, secret, redirectUri);
  const state = randomBytes(32).toString('hex');
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });

  let resolveAuthorization, rejectAuthorization;
  const authorization = new Promise((resolve, reject) => {
    resolveAuthorization = resolve;
    rejectAuthorization = reject;
  });
  let authorizationHandled = false;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', redirectUri);
    if (request.method !== 'GET' || url.pathname !== callbackPath) {
      response.writeHead(404).end('Not found.');
      return;
    }
    if (url.searchParams.get('state') !== state) {
      response.writeHead(400).end('Invalid OAuth state.');
      return;
    }
    if (authorizationHandled) {
      response.writeHead(409).end('Authorization callback already received.');
      return;
    }
    authorizationHandled = true;
    const oauthError = url.searchParams.get('error');
    if (oauthError) {
      const error = new Error(`Google authorization failed: ${oauthError}`);
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
      client.setCredentials(tokens);
      await saveGoogleRefreshToken(tokenPath, tokens.refresh_token);
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Google authorization complete. You can close this page.');
      resolveAuthorization(client);
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Google authorization failed. Check the container logs.');
      rejectAuthorization(error);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
  console.log(`Google OAuth callback: ${redirectUri}`);
  console.log(`Open this authorization URL and approve access:\n${client.generateAuthUrl({
    access_type: 'offline', prompt: 'consent', scope: [SCOPE], state,
    code_challenge: codeChallenge, code_challenge_method: 'S256'
  })}`);
  try { return await authorization; }
  finally { await new Promise(resolve => server.close(resolve)); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const tokenPath = resolve(process.env.GOOGLE_TOKEN_PATH ?? './data/google-refresh-token.json');
  authorizeGoogle(process.env, tokenPath).catch(error => { console.error(`Google authorization failed: ${error.message}`); process.exitCode = 1; });
}
