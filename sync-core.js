import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { addDays } from './client.js';

export function calendarIdFromUrl(value) {
  let url; try { url = new URL(value); } catch { throw new Error('Invalid GOOGLE_CALENDAR_ICAL_URL.'); }
  const match = url.pathname.match(/^\/calendar\/ical\/([^/]+)\/private-[^/]+\/basic\.ics$/);
  if (url.protocol !== 'https:' || url.hostname !== 'calendar.google.com' || !match) throw new Error('Expected a Google private iCal URL.');
  return decodeURIComponent(match[1]);
}
export function scopeId(institutionId, studentId, calendarId) {
  return createHash('sha256').update(JSON.stringify(['schulmanager-exams-v1', institutionId, studentId, calendarId])).digest('hex');
}
function remindersForDays(days) {
  if (days == null) return { useDefault: true };
  if (!Number.isSafeInteger(days) || days < 1 || days > 28) throw new Error('Reminder days must be between 1 and 28.');
  return { useDefault: false, overrides: [{ method: 'popup', minutes: days * 24 * 60 }] };
}
function normalizedReminders(reminders) {
  if (!reminders || reminders.useDefault !== false) return { useDefault: true, overrides: [] };
  const overrides = [...(reminders.overrides ?? [])]
    .map(({ method, minutes }) => ({ method, minutes }))
    .sort((first, second) => first.minutes - second.minutes || first.method.localeCompare(second.method));
  return { useDefault: false, overrides };
}
export function examEvent(exam, scope, student, { prefixStudentName = false, remindDays = null } = {}) {
  if (!Number.isSafeInteger(exam.id) || exam.id <= 0) throw new Error('Exam has no stable numeric ID; refusing incomplete source snapshot.');
  const date = exam.date?.slice(0, 10);
  addDays(date ?? '', 0);
  const subject = exam.subject?.name ?? exam.subjectText ?? 'Prüfung';
  const labels = [subject, exam.type?.name].filter(Boolean);
  const summary = prefixStudentName && student.firstname
    ? [student.firstname, ...labels].join(' - ')
    : labels.join(' – ');
  return {
    id: `sm${createHash('sha256').update(`${scope}:${exam.id}`).digest('hex')}`,
    summary,
    description: [exam.comment, `Schulmanager exam ${exam.id}; student ${student.id}`, 'Managed by schulmanager-sync (one-way).'].filter(Boolean).join('\n'),
    start: { date }, end: { date: addDays(date, 1) },
    reminders: remindersForDays(remindDays),
    extendedProperties: { private: { smScope: scope, smExamId: String(exam.id), smStudentId: String(student.id) } }
  };
}
export function nextRun(now, hours, timezone = 'Europe/Berlin') {
  if (!Number.isInteger(hours) || hours < 1 || hours > 24) throw new Error('Hours must be 1..24.');
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  for (let timestamp = Math.floor(now.getTime() / 60000) * 60000 + 60000; timestamp <= now.getTime() + 49 * 3600000; timestamp += 60000) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map(p => [p.type, p.value]));
    if (parts.minute === '00' && Number(parts.hour) % hours === 0) return new Date(timestamp);
  }
  throw new Error('Cannot calculate next scheduled run.');
}
export function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS exams (
      scope TEXT NOT NULL, exam_id TEXT NOT NULL, google_id TEXT NOT NULL,
      exam_date TEXT NOT NULL, source_json TEXT NOT NULL, synced_at TEXT,
      PRIMARY KEY(scope, exam_id));
    CREATE TABLE IF NOT EXISTS sync_runs (scope TEXT PRIMARY KEY, start_date TEXT, end_date TEXT, completed_at TEXT);`);
  return db;
}
function sameEvent(remote, desired) {
  return remote.summary === desired.summary && (remote.description ?? '') === desired.description &&
    remote.start?.date === desired.start.date && remote.end?.date === desired.end.date &&
    JSON.stringify(normalizedReminders(remote.reminders)) === JSON.stringify(normalizedReminders(desired.reminders)) &&
    Object.entries(desired.extendedProperties.private).every(([k,v]) => remote.extendedProperties?.private?.[k] === v);
}

export async function reconcile({ db, calendar, exams, student, scope, start, end, prefixStudentName = false, remindDays = null, dryRun = false }) {
  if (!Array.isArray(exams)) throw new Error('Invalid exams response; no calendar mutations performed.');
  const desired = new Map();
  for (const exam of exams) {
    const event = examEvent(exam, scope, student, { prefixStudentName, remindDays });
    if (event.start.date < start || event.start.date > end) throw new Error('Exam outside requested range; refusing incomplete source snapshot.');
    if (desired.has(event.id) && JSON.stringify(desired.get(event.id).event) !== JSON.stringify(event)) throw new Error('Conflicting duplicate exam ID.');
    desired.set(event.id, { event, exam });
  }
  // Hold a SQLite writer lock throughout reconciliation; another process cannot
  // run a competing cycle against this DB. Google operations are recoverable by IDs.
  db.exec('BEGIN IMMEDIATE');
  try {
    const stored = db.prepare('SELECT * FROM exams WHERE scope=?').all(scope);
    const tracked = new Map(stored.map(row => [row.google_id, row]));
    const remote = await calendar.list(scope);
    if (!Array.isArray(remote)) throw new Error('Invalid Google calendar list.');
    const owned = remote.filter(e => e.extendedProperties?.private?.smScope === scope);
    const existing = new Map(owned.map(e => [e.id, e]));
    const keptIds = new Set();
    const stats = { created: 0, updated: 0, deleted: 0, unchanged: 0, dryRun };
    for (const { event, exam } of desired.values()) {
      const row = stored.find(row => row.exam_id === String(exam.id));
      const found = (row && existing.get(row.google_id)) ?? existing.get(event.id) ?? owned.find(e => e.extendedProperties?.private?.smExamId === String(exam.id));
      if (found) event.id = found.id;
      if (!dryRun) db.prepare(`INSERT INTO exams(scope,exam_id,google_id,exam_date,source_json) VALUES(?,?,?,?,?)
        ON CONFLICT(scope,exam_id) DO UPDATE SET google_id=excluded.google_id,exam_date=excluded.exam_date,source_json=excluded.source_json`).run(scope, String(exam.id), event.id, event.start.date, JSON.stringify(exam));
      if (!found) {
        if (!dryRun) {
          const created = await calendar.upsert(event, scope);
          if (created?.id) event.id = created.id;
          db.prepare('UPDATE exams SET google_id=? WHERE scope=? AND exam_id=?').run(event.id, scope, String(exam.id));
        }
        stats.created++;
      }
      else if (!sameEvent(found, event)) { if (!dryRun) await calendar.update(event); stats.updated++; }
      else stats.unchanged++;
      keptIds.add(event.id);
      if (!dryRun) db.prepare('UPDATE exams SET synced_at=? WHERE scope=? AND exam_id=?').run(new Date().toISOString(), scope, String(exam.id));
    }
    for (const event of owned) {
      const date = tracked.get(event.id)?.exam_date ?? event.start?.date ?? event.start?.dateTime?.slice(0,10);
      if (!keptIds.has(event.id) && date >= start && date <= end) {
        if (!dryRun) await calendar.remove(event.id);
        stats.deleted++;
      }
    }
    if (!dryRun) {
      const examIds = new Set([...desired.values()].map(value => String(value.exam.id)));
      for (const row of stored) if (!examIds.has(row.exam_id) && row.exam_date >= start && row.exam_date <= end) db.prepare('DELETE FROM exams WHERE scope=? AND exam_id=?').run(scope, row.exam_id);
      db.prepare('INSERT OR REPLACE INTO sync_runs VALUES(?,?,?,?)').run(scope, start, end, new Date().toISOString());
    }
    db.exec(dryRun ? 'ROLLBACK' : 'COMMIT');
    return stats;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
