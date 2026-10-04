import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export function tokenExpired(token, now = Date.now()) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return !Number.isFinite(payload.exp) || payload.exp * 1000 <= now + 60000;
  } catch { return true; }
}

export async function readSession(path, { username, institutionId = null } = {}) {
  let session;
  try { session = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
  if (session.version !== 1 || !session.user || tokenExpired(session.token) ||
      (username && session.username !== username) || session.institutionId !== institutionId) return null;
  return session;
}

export async function saveSession(path, { jwt, user }, username, institutionId = null) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, username, institutionId, token: jwt, user }), { mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function clearSession(path) { await rm(path, { force: true }); }
