#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SchulmanagerClient, selectStudent, studentsFromUser, addDays } from './client.js';
import { saveSession } from './session.js';
import { googleAuth, GoogleCalendar } from './google-calendar.js';
import { calendarIdFromUrl, scopeId, openDatabase, reconcile, nextRun } from './sync-core.js';

function integer(value, name, min, max) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} must be ${min}..${max}.`);
  return n;
}
export function configuration(env, values) {
  const timezone = env.SYNC_TIMEZONE ?? 'Europe/Berlin';
  new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format();
  if (!env.SCHULMANAGER_USERNAME || !env.SCHULMANAGER_PASSWORD) throw new Error('Set SCHULMANAGER_USERNAME and SCHULMANAGER_PASSWORD.');
  const fromUrl = env.GOOGLE_CALENDAR_ICAL_URL ? calendarIdFromUrl(env.GOOGLE_CALENDAR_ICAL_URL) : null;
  if (env.GOOGLE_CALENDAR_ID && fromUrl && env.GOOGLE_CALENDAR_ID !== fromUrl) throw new Error('GOOGLE_CALENDAR_ID does not match the iCal URL.');
  const calendarId = env.GOOGLE_CALENDAR_ID ?? fromUrl;
  if (!calendarId) throw new Error('Set GOOGLE_CALENDAR_ICAL_URL or GOOGLE_CALENDAR_ID.');
  return { timezone, calendarId, weeks: integer(values.weeks ?? env.SYNC_WEEKS ?? 26, 'Weeks', 1, 104),
    hours: integer(values.hours ?? env.SYNC_HOURS ?? 4, 'Hours', 1, 24),
    prefixStudentName: env.SYNC_PREFIX_STUDENT_NAME === 'true',
    dbPath: resolve(env.SYNC_DB_PATH ?? './data/sync.sqlite'),
    sessionPath: resolve(env.SYNC_SESSION_PATH ?? './data/schulmanager-session.json'),
    institutionId: env.SCHULMANAGER_INSTITUTION_ID ? integer(env.SCHULMANAGER_INSTITUTION_ID, 'Institution ID', 1, Number.MAX_SAFE_INTEGER) : null,
    studentId: env.SCHULMANAGER_STUDENT_ID,
    studentIndex: env.SCHULMANAGER_STUDENT_ID ? undefined : integer(env.SCHULMANAGER_STUDENT ?? 1, 'Student index', 1, 1000) };
}
export function shouldPrefixStudentName(studentCount, forced) {
  return forced || studentCount > 1;
}
export async function runCycle(config, env, calendar, db, { dryRun = false } = {}) {
  const client = new SchulmanagerClient({ username: env.SCHULMANAGER_USERNAME, password: env.SCHULMANAGER_PASSWORD,
    institutionId: config.institutionId, bundleVersion: env.SCHULMANAGER_BUNDLE_VERSION,
    onLogin: (data, username) => saveSession(config.sessionPath, data, username, config.institutionId) });
  // Refresh account metadata each cycle so a class change cannot persist in cache.
  await client.login();
  const students = studentsFromUser(client.user);
  const student = selectStudent(students, { id: config.studentId, index: config.studentIndex });
  const start = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format();
  const end = addDays(start, config.weeks * 7);
  const result = (await client.callRequests([{ moduleName: 'exams', endpointName: 'get-exams', parameters: { student, start, end } }]))[0];
  if (Number(result.status) >= 400 || !Array.isArray(result.data)) throw new Error(`Schulmanager exam fetch failed (${result.status ?? 'invalid response'}); no calendar events changed.`);
  const institution = client.user.institutionId;
  if (!Number.isSafeInteger(institution) || institution <= 0) throw new Error('Login has no institution ID; refusing unscoped sync.');
  const scope = scopeId(institution, student.id, config.calendarId);
  const stats = await reconcile({ db, calendar, exams: result.data, student, scope, start, end,
    prefixStudentName: shouldPrefixStudentName(students.length, config.prefixStudentName), dryRun });
  console.log(JSON.stringify({ time: new Date().toISOString(), studentId: student.id, start, end, exams: result.data.length, ...stats }));
  return stats;
}
export async function main() {
  process.umask(0o077);
  const { values } = parseArgs({ options: { daemon: { type: 'boolean' }, hours: { type: 'string' }, weeks: { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    console.log('Usage: node sync.js [--weeks 26] [--daemon --hours 4] [--dry-run]\nEnvironment configuration and OAuth setup: see SYNC.md. Runs immediately; daemon then runs at matching local hour boundaries.'); return;
  }
  const env = process.env, config = configuration(env, values);
  const calendar = new GoogleCalendar(googleAuth(env), config.calendarId);
  await mkdir(dirname(config.dbPath), { recursive: true });
  const db = openDatabase(config.dbPath);
  let stopped = false, wake;
  const stop = () => { stopped = true; wake?.(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    do {
      try { await runCycle(config, env, calendar, db, { dryRun: values['dry-run'] }); }
      catch (error) {
        if (!values.daemon) throw error;
        console.error(`${new Date().toISOString()} Sync failed: ${error.message}`);
      }
      if (!values.daemon || stopped) break;
      const scheduled = nextRun(new Date(), config.hours, config.timezone);
      console.log(`Next sync: ${scheduled.toISOString()} (${config.timezone})`);
      while (!stopped && Date.now() < scheduled.getTime()) {
        await new Promise(resolve => {
          const timer = setTimeout(resolve, Math.min(60000, scheduled.getTime() - Date.now()));
          wake = () => { clearTimeout(timer); resolve(); };
        });
        wake = undefined;
      }
    } while (!stopped);
  } finally { db.close(); process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(`Sync failed: ${error.message}`); process.exitCode = 1; });
