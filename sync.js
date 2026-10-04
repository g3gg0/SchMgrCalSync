#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SchulmanagerClient, selectStudent, studentsFromUser, addDays } from './client.js';
import { saveSession } from './session.js';
import { googleAuth, GoogleCalendar } from './google-calendar.js';
import { calendarIdFromUrl, scopeId, openDatabase, reconcile, nextRun, sickEvent, exemptionEvent, calendarEventsInRange, calendarEvent } from './sync-core.js';

function integer(value, name, min, max) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} must be ${min}..${max}.`);
  return n;
}
export function configuration(env, values) {
  const timezone = env.SYNC_TIMEZONE ?? 'Europe/Berlin';
  new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format();
  if (!env.SCHULMANAGER_USERNAME || !env.SCHULMANAGER_PASSWORD) throw new Error('Set SCHULMANAGER_USERNAME and SCHULMANAGER_PASSWORD.');
  const explicitCalendarId = env.GOOGLE_CALENDAR_ID || undefined;
  const fromUrl = env.GOOGLE_CALENDAR_ICAL_URL ? calendarIdFromUrl(env.GOOGLE_CALENDAR_ICAL_URL) : null;
  if (explicitCalendarId && fromUrl && explicitCalendarId !== fromUrl) throw new Error('GOOGLE_CALENDAR_ID does not match the iCal URL.');
  const calendarId = explicitCalendarId ?? fromUrl;
  if (!calendarId) throw new Error('Set GOOGLE_CALENDAR_ICAL_URL or GOOGLE_CALENDAR_ID.');
  const telegramBotToken = env.TELEGRAM_BOT_TOKEN?.trim() || null;
  const telegramChatId = env.TELEGRAM_CHAT_ID?.trim() || null;
  if (Boolean(telegramBotToken) !== Boolean(telegramChatId)) throw new Error('Set both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, or leave both unset.');
  return { timezone, calendarId, weeks: integer(values.weeks ?? env.SYNC_WEEKS ?? 26, 'Weeks', 1, 104),
    hours: integer(values.hours ?? env.SYNC_HOURS ?? 4, 'Hours', 1, 24),
    remindDays: env.SYNC_REMIND_DAYS ? integer(env.SYNC_REMIND_DAYS, 'Reminder days', 1, 28) : null,
    prefixStudentName: env.SYNC_PREFIX_STUDENT_NAME === 'true',
    telegramBotToken, telegramChatId,
    dbPath: resolve(env.SYNC_DB_PATH ?? './data/sync.sqlite'),
    sessionPath: resolve(env.SYNC_SESSION_PATH ?? './data/schulmanager-session.json'),
    institutionId: env.SCHULMANAGER_INSTITUTION_ID ? integer(env.SCHULMANAGER_INSTITUTION_ID, 'Institution ID', 1, Number.MAX_SAFE_INTEGER) : null,
    studentId: env.SCHULMANAGER_STUDENT_ID || undefined,
    studentIndex: env.SCHULMANAGER_STUDENT_ID ? undefined : integer(env.SCHULMANAGER_STUDENT ?? 1, 'Student index', 1, 1000) };
}
export function telegramMessage({ studentId, start, end, stats }) {
  if (!stats.created && !stats.updated && !stats.deleted) return null;
  const formatDate = value => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
    return match ? `${match[3]}.${match[2]}.${match[1]}` : String(value ?? 'Datum unbekannt');
  };
  const lines = [
    '📚 Schulmanager-Kalender aktualisiert',
    `Schüler-ID: ${studentId}`,
    `Zeitraum: ${formatDate(start)} – ${formatDate(end)}`
  ];
  const sections = [
    { count: stats.created, title: '➕ Hinzugefügt', events: stats.changes?.created ?? [] },
    { count: stats.deleted, title: '➖ Gelöscht', events: stats.changes?.deleted ?? [] }
  ];
  for (const section of sections) {
    if (!section.count) continue;
    lines.push('', `${section.title} (${section.count})`);
    if (!section.events.length) lines.push('• Details nicht verfügbar');
    else for (const event of section.events) lines.push(`• ${formatDate(event.date)} · ${event.summary}`);
  }
  if (stats.updated) lines.push('', `✏️ Geändert: ${stats.updated}`);
  let text = lines.join('\n');
  if (text.length > 3900) {
    text = `${text.slice(0, 3850).replace(/\n[^\n]*$/, '')}\n… Weitere Details wegen der Telegram-Nachrichtenlänge gekürzt.`;
  }
  return text;
}
export async function sendTelegramUpdate(env, summary, fetchImpl = fetch) {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (!botToken && !chatId) return false;
  if (!botToken || !chatId) throw new Error('Set both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, or leave both unset.');
  const text = telegramMessage(summary);
  if (!text) return false;
  let response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(10000)
    });
  } catch {
    throw new Error('Telegram request failed; check network and bot configuration.');
  }
  let result;
  try { result = await response.json(); } catch {}
  if (!response.ok || result?.ok !== true) throw new Error(`Telegram API rejected the notification (HTTP ${response.status}).`);
  return true;
}
export function shouldPrefixStudentName(studentCount, forced) {
  return forced || studentCount > 1;
}
export function hasGoogleAuth(env) {
  const hasOAuthCredentials = env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN;
  return Boolean(hasOAuthCredentials || env.GOOGLE_SERVICE_ACCOUNT_JSON || env.GOOGLE_APPLICATION_CREDENTIALS);
}
export function recordsForStudentRange(records, studentId, start, end) {
  if (!Array.isArray(records)) throw new Error('Invalid absence response; no calendar events changed.');
  return records.filter(record => {
    if (String(record.studentId) !== String(studentId)) return false;
    const startDate = record.startDate?.slice(0, 10);
    const endDate = (record.endDate ?? record.startDate)?.slice(0, 10);
    addDays(startDate ?? '', 0);
    addDays(endDate ?? '', 0);
    if (endDate < startDate) throw new Error('Absence record ends before it starts; no calendar events changed.');
    return startDate <= end && endDate >= start;
  });
}
function waitForShutdown() {
  return new Promise(resolve => {
    const shutdown = () => {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      resolve();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
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
  const exemptionRequest = {
    moduleName: 'exemptions',
    endpointName: 'poqa',
    parameters: { action: { model: 'modules/exemptions/exemption-request', action: 'findAll', parameters: [{
      where: { studentId: student.id, isInternal: { $not: true } },
      include: [{ association: 'student', required: true }]
    }] }, uiState: 'main.modules.exemptions.request' }
  };
  const [examResult, sickResult, exemptionResult, calendarResult] = await client.callRequests([
    { moduleName: 'exams', endpointName: 'get-exams', parameters: { student, start, end } },
    { moduleName: 'sick', endpointName: 'get-sick-notes-as-student-fully-entitled' },
    exemptionRequest,
    { moduleName: 'calendar', endpointName: 'get-events-for-user', parameters: { start, end, includeHolidays: false } }
  ]);
  const requireRecords = (result, section) => {
    if (Number(result.status) >= 400 || !Array.isArray(result.data)) {
      throw new Error(`Schulmanager ${section} fetch failed (${result.status ?? 'invalid response'}); no calendar events changed.`);
    }
    return result.data;
  };
  const exams = requireRecords(examResult, 'exam');
  const sickNotes = recordsForStudentRange(requireRecords(sickResult, 'sick notes'), student.id, start, end);
  const exemptions = recordsForStudentRange(requireRecords(exemptionResult, 'exemptions'), student.id, start, end)
    .filter(record => record.isInternal !== true);
  if (Number(calendarResult.status) >= 400 || !calendarResult.data || typeof calendarResult.data !== 'object') {
    throw new Error(`Schulmanager calendar fetch failed (${calendarResult.status ?? 'invalid response'}); no calendar events changed.`);
  }
  const calendarEvents = calendarEventsInRange(calendarResult.data, start, end);
  const institution = client.user.institutionId;
  if (!Number.isSafeInteger(institution) || institution <= 0) throw new Error('Login has no institution ID; refusing unscoped sync.');
  const sources = [
    { scope: scopeId(institution, student.id, config.calendarId), records: exams,
      prefixStudentName: shouldPrefixStudentName(students.length, config.prefixStudentName), remindDays: config.remindDays },
    { scope: scopeId(institution, student.id, config.calendarId, 'sick'), records: sickNotes,
      eventFactory: sickEvent, identityProperty: 'smSickId' },
    { scope: scopeId(institution, student.id, config.calendarId, 'exemptions'), records: exemptions,
      eventFactory: exemptionEvent, identityProperty: 'smExemptionId' },
    { scope: scopeId(institution, student.id, config.calendarId, 'calendar'), records: calendarEvents,
      eventFactory: calendarEvent, identityProperty: 'smCalendarOccurrenceId', eventOptions: { timeZone: config.timezone } }
  ];
  const stats = { created: 0, updated: 0, deleted: 0, unchanged: 0, dryRun,
    changes: { created: [], updated: [], deleted: [] } };
  for (const source of sources) {
    const result = await reconcile({ db, calendar, exams: source.records, student, scope: source.scope, start, end,
      eventFactory: source.eventFactory, identityProperty: source.identityProperty,
      prefixStudentName: source.prefixStudentName, remindDays: source.remindDays, eventOptions: source.eventOptions, dryRun });
    for (const key of ['created', 'updated', 'deleted', 'unchanged']) stats[key] += result[key];
    for (const key of ['created', 'updated', 'deleted']) stats.changes[key].push(...result.changes[key]);
  }
  if (!dryRun && config.telegramBotToken && stats.created + stats.updated + stats.deleted > 0) {
    try { await sendTelegramUpdate(env, { studentId: student.id, start, end, stats }); }
    catch (error) { console.error(`Telegram notification failed: ${error.message}`); }
  }
  console.log(JSON.stringify({ time: new Date().toISOString(), studentId: student.id, start, end,
    exams: exams.length, sickNotes: sickNotes.length, exemptions: exemptions.length, calendarEvents: calendarEvents.length, ...stats }));
  return stats;
}
export async function main() {
  process.umask(0o077);
  const { values } = parseArgs({ options: { daemon: { type: 'boolean' }, hours: { type: 'string' }, weeks: { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    console.log('Usage: node sync.js [--weeks 26] [--daemon --hours 4] [--dry-run]\nEnvironment configuration and OAuth setup: see SYNC.md. Runs immediately; daemon then runs at matching local hour boundaries.'); return;
  }
  const env = process.env, config = configuration(env, values);
  if (!hasGoogleAuth(env) && values.daemon) {
    console.error('Google auth is not configured.\nOn your private computer run: npm run google-oauth\nThen set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN in Portainer and redeploy this stack.\nContainer is idle until stopped.');
    await waitForShutdown();
    return;
  }
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
