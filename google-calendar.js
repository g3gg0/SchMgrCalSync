import { OAuth2Client, GoogleAuth } from 'google-auth-library';
import { randomBytes } from 'node:crypto';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
export function googleAuth(env) {
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN) {
    const auth = new OAuth2Client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
    auth.setCredentials({ refresh_token: env.GOOGLE_REFRESH_TOKEN });
    return auth;
  }
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON) return new GoogleAuth({ credentials: JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON), scopes: [SCOPE] });
  if (env.GOOGLE_APPLICATION_CREDENTIALS) return new GoogleAuth({ keyFile: env.GOOGLE_APPLICATION_CREDENTIALS, scopes: [SCOPE] });
  throw new Error('Google writes require GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN (or service-account credentials). A private iCal URL is read-only.');
}
export class GoogleCalendar {
  constructor(auth, calendarId, fetchImpl = fetch) { Object.assign(this, { auth, calendarId, fetchImpl }); }
  async request(method, suffix = '', body, query = {}) {
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events${suffix}`);
    for (const [key,value] of Object.entries(query)) if (value != null) url.searchParams.set(key, value);
    for (let attempt = 0; attempt < 4; attempt++) {
      const headers = await this.auth.getRequestHeaders();
      const response = await this.fetchImpl(url, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { ...Object.fromEntries(headers.entries()), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 3) {
        await response.body?.cancel();
        await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt)); continue;
      }
      if (!response.ok) {
        let detail;
        try { detail = (await response.json()).error?.message; } catch {}
        const error = new Error(`Google Calendar ${method}: HTTP ${response.status}${detail ? ` - ${detail}` : ''}`);
        error.status = response.status;
        throw error;
      }
      return response.status === 204 ? null : response.json();
    }
  }
  async list(scope) {
    const items = []; let pageToken;
    do {
      const page = await this.request('GET', '', null, { privateExtendedProperty: `smScope=${scope}`, showDeleted: 'false', maxResults: '2500', pageToken });
      if (!Array.isArray(page.items ?? [])) throw new Error('Invalid Google list response.');
      items.push(...(page.items ?? [])); pageToken = page.nextPageToken;
    } while (pageToken);
    return items;
  }
  update(event) {
    return this.request('PATCH', `/${event.id}`, { ...event, status: 'confirmed',
      start: { ...event.start, dateTime: null, timeZone: null }, end: { ...event.end, dateTime: null, timeZone: null } }, { sendUpdates: 'none' });
  }
  async upsert(event, scope) {
    try { return await this.request('POST', '', event, { sendUpdates: 'none' }); }
    catch (error) {
      if (error.status !== 409) throw error;
      let current;
      try { current = await this.request('GET', `/${event.id}`); }
      catch (readError) {
        if (readError.status !== 410) throw readError;
        // Google retains deleted IDs. A new ID is safe: the stable Schulmanager
        // reference remains in private properties and is rediscovered after crashes.
        return this.request('POST', '', { ...event, id: `${event.id}${randomBytes(8).toString('hex')}` }, { sendUpdates: 'none' });
      }
      if (current.status === 'cancelled') return this.request('POST', '', { ...event, id: `${event.id}${randomBytes(8).toString('hex')}` }, { sendUpdates: 'none' });
      if (current.extendedProperties?.private?.smScope !== scope) throw new Error('Google event ID collision; refusing to overwrite an unrelated event.');
      return this.update(event);
    }
  }
  async remove(id) {
    try { await this.request('DELETE', `/${id}`, null, { sendUpdates: 'none' }); }
    catch (error) { if (![404,410].includes(error.status)) throw error; }
  }
}
