import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { addDays } from './client.js';

export function calendarIdFromUrl(value) {
  let url; try { url = new URL(value); } catch { throw new Error('Invalid GOOGLE_CALENDAR_ICAL_URL.'); }
  const match = url.pathname.match(/^\/calendar\/ical\/([^/]+)\/private-[^/]+\/basic\.ics$/);
  if (url.protocol !== 'https:' || url.hostname !== 'calendar.google.com' || !match) throw new Error('Expected a Google private iCal URL.');
  return decodeURIComponent(match[1]);
}
export function scopeId(institutionId, studentId, calendarId, sourceType = 'exams') {
  const namespace = sourceType === 'exams' ? 'schulmanager-exams-v1' : `schulmanager-${sourceType}-v1`;
  return createHash('sha256').update(JSON.stringify([namespace, institutionId, studentId, calendarId])).digest('hex');
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
function absenceEvent(record, scope, student, type) {
  if (!Number.isSafeInteger(record.id) || record.id <= 0) throw new Error(`${type} record has no stable numeric ID.`);
  const startDate = record.startDate?.slice(0, 10);
  const lastDate = (record.endDate ?? record.startDate)?.slice(0, 10);
  addDays(startDate ?? '', 0);
  addDays(lastDate ?? '', 0);
  if (lastDate < startDate) throw new Error(`${type} record ends before it starts.`);
  const isExemption = type === 'exemption';
  const status = record.granted === true ? 'Genehmigt' : 'Nicht genehmigt';
  const idProperty = isExemption ? 'smExemptionId' : 'smSickId';
  return {
    id: `sm${createHash('sha256').update(`${scope}:${type}:${record.id}`).digest('hex')}`,
    summary: isExemption ? `Beurlaubung – ${status}` : 'Krankmeldung',
    description: [`Schulmanager ${type} ${record.id}; student ${student.id}`,
      ...(isExemption ? [`Status: ${status}`] : []), 'Managed by schulmanager-sync (one-way).'].join('\n'),
    start: { date: startDate }, end: { date: addDays(lastDate, 1) },
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: { private: { smScope: scope, [idProperty]: String(record.id), smStudentId: String(student.id) } }
  };
}
export function sickEvent(record, scope, student) { return absenceEvent(record, scope, student, 'sick'); }
export function exemptionEvent(record, scope, student) { return absenceEvent(record, scope, student, 'exemption'); }
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
function eventDetails(event, date = event.start?.date) {
  return { date, summary: event.summary ?? 'Prüfung' };
}

export async function reconcile({ db, calendar, exams, student, scope, start, end, prefixStudentName = false, remindDays = null,
  eventFactory = examEvent, identityProperty = 'smExamId', dryRun = false }) {
  if (!Array.isArray(exams)) throw new Error('Invalid source snapshot; no calendar mutations performed.');
  const desired = new Map();
  for (const record of exams) {
    const event = eventFactory(record, scope, student, { prefixStudentName, remindDays });
    const eventLastDate = addDays(event.end.date, -1);
    if (event.start.date > end || eventLastDate < start) throw new Error('Event outside requested range; refusing incomplete source snapshot.');
    if (desired.has(event.id) && JSON.stringify(desired.get(event.id).event) !== JSON.stringify(event)) throw new Error('Conflicting duplicate source ID.');
    desired.set(event.id, { event, record });
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
    const stats = { created: 0, updated: 0, deleted: 0, unchanged: 0, dryRun,
      changes: { created: [], updated: [], deleted: [] } };
    for (const { event, record } of desired.values()) {
      const recordId = String(record.id);
      const row = stored.find(row => row.exam_id === recordId);
      const found = (row && existing.get(row.google_id)) ?? existing.get(event.id) ?? owned.find(e => e.extendedProperties?.private?.[identityProperty] === recordId);
      if (found) event.id = found.id;
      if (!dryRun) db.prepare(`INSERT INTO exams(scope,exam_id,google_id,exam_date,source_json) VALUES(?,?,?,?,?)
        ON CONFLICT(scope,exam_id) DO UPDATE SET google_id=excluded.google_id,exam_date=excluded.exam_date,source_json=excluded.source_json`).run(scope, recordId, event.id, event.start.date, JSON.stringify(record));
      if (!found) {
        if (!dryRun) {
          const created = await calendar.upsert(event, scope);
          if (created?.id) event.id = created.id;
          db.prepare('UPDATE exams SET google_id=? WHERE scope=? AND exam_id=?').run(event.id, scope, recordId);
        }
        stats.created++;
        stats.changes.created.push(eventDetails(event));
      }
      else if (!sameEvent(found, event)) {
        if (!dryRun) await calendar.update(event);
        stats.updated++;
        stats.changes.updated.push(eventDetails(event));
      }
      else stats.unchanged++;
      keptIds.add(event.id);
      if (!dryRun) db.prepare('UPDATE exams SET synced_at=? WHERE scope=? AND exam_id=?').run(new Date().toISOString(), scope, recordId);
    }
    for (const event of owned) {
      const date = tracked.get(event.id)?.exam_date ?? event.start?.date ?? event.start?.dateTime?.slice(0,10);
      if (!keptIds.has(event.id) && date >= start && date <= end) {
        if (!dryRun) await calendar.remove(event.id);
        stats.deleted++;
        stats.changes.deleted.push(eventDetails(event, date));
      }
    }
    if (!dryRun) {
      const examIds = new Set([...desired.values()].map(value => String(value.record.id)));
      for (const row of stored) if (!examIds.has(row.exam_id) && row.exam_date >= start && row.exam_date <= end) db.prepare('DELETE FROM exams WHERE scope=? AND exam_id=?').run(scope, row.exam_id);
      db.prepare('INSERT OR REPLACE INTO sync_runs VALUES(?,?,?,?)').run(scope, start, end, new Date().toISOString());
    }
    db.exec(dryRun ? 'ROLLBACK' : 'COMMIT');
    return stats;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
