#!/usr/bin/env node
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OAuth2Client } from 'google-auth-library';

const SCOPE = 'https://www.googleapis.com/auth/calendar.events';

export function oauthSettings(env) {
  const port = Number(env.GOOGLE_OAUTH_PORT ?? 8085);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid GOOGLE_OAUTH_PORT.');
  return { port, redirectUri: `http://127.0.0.1:${port}/` };
}

function promptLine(message) {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  return prompt.question(message).finally(() => prompt.close());
}

function promptHidden(message) {
  if (!process.stdin.isTTY) throw new Error('Set GOOGLE_CLIENT_SECRET for non-interactive use.');
  process.stderr.write(message);
  const previousRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let secret = '';
    const finish = (error, value) => {
      process.stdin.off('data', receive);
      process.stdin.setRawMode(previousRaw);
      process.stdin.pause();
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const receive = chunk => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') { finish(new Error('OAuth authorization cancelled.')); return; }
        if (character === '\r' || character === '\n') { finish(null, secret); return; }
        if (character === '\u007f' || character === '\b') secret = secret.slice(0, -1);
        else if (character >= ' ') secret += character;
      }
    };
    process.stdin.on('data', receive);
  });
}

export async function getOAuthCredentials(env, prompt = (message, hidden) => hidden ? promptHidden(message) : promptLine(message)) {
  const clientId = env.GOOGLE_CLIENT_ID || await prompt('Google OAuth Client ID: ', false);
  const clientSecret = env.GOOGLE_CLIENT_SECRET || await prompt('Google OAuth Client Secret (input hidden): ', true);
  if (!clientId.trim() || !clientSecret.trim()) throw new Error('Google OAuth client ID and client secret are required.');
  return { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
}

export async function authorizeGoogle(env) {
  const { clientId, clientSecret } = await getOAuthCredentials(env);
  const { port, redirectUri } = oauthSettings(env);
  const client = new OAuth2Client(clientId, clientSecret, redirectUri);
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
      console.log('Set this value in Portainer as GOOGLE_REFRESH_TOKEN, then redeploy the stack.');
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
