import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarEvent, calendarEventsInRange, calendarIdFromUrl, scopeId, nextRun, openDatabase, reconcile, examEvent, sickEvent, exemptionEvent } from './sync-core.js';
import { GoogleCalendar } from './google-calendar.js';
import { getOAuthCredentials, oauthSettings } from './google-oauth.js';
import { configuration, hasGoogleAuth, recordsForStudentRange, sendTelegramUpdate, shouldPrefixStudentName, telegramMessage } from './sync.js';
const student = { id: 12, classId: 34 };
const scope = scopeId(56, student.id, 'test-calendar');
const exam = { id: 78, date: '2026-10-14', subject: { name: 'Math' }, type: { name: 'Test' }, comment: 'Chapters 1–2' };
const context = { student, scope, start: '2026-10-04', end: '2027-04-04' };
function fakeCalendar(events = []) {
  const remote = new Map(events.map(e => [e.id, structuredClone(e)]));
  const operations = [];
  return { remote, operations, list: async () => [...remote.values()],
    upsert: async event => { operations.push('create'); remote.set(event.id, structuredClone(event)); },
    update: async event => { operations.push('update'); remote.set(event.id, structuredClone(event)); },
    remove: async id => { operations.push('delete'); remote.delete(id); } };
}
test('iCal URL extracts only calendar ID; schedule uses local hour boundaries including DST', () => {
  assert.equal(calendarIdFromUrl('https://calendar.google.com/calendar/ical/test%40group.calendar.google.com/private-secret/basic.ics'), 'test@group.calendar.google.com');
  assert.throws(() => calendarIdFromUrl('https://example.com/calendar/ical/test/private-secret/basic.ics'));
  assert.equal(nextRun(new Date('2026-10-04T01:17:00Z'), 4).toISOString(), '2026-10-04T02:00:00.000Z');
  assert.equal(nextRun(new Date('2026-10-24T23:30:00Z'), 4).toISOString(), '2026-10-25T03:00:00.000Z');
  assert.equal(nextRun(new Date('2026-03-29T00:30:00Z'), 4).toISOString(), '2026-03-29T02:00:00.000Z');
});
test('stable IDs, repeat sync, edit correction, deletion and unrelated events', async () => {
  const db = openDatabase(':memory:');
  const calendar = fakeCalendar([{ id: 'unrelated', summary: 'Birthday', start: { date: '2026-10-14' } }]);
  try {
    const first = await reconcile({ db, calendar, exams: [exam], ...context });
    assert.equal(first.created, 1);
    const id = examEvent(exam, scope, student).id;
    assert.match(id, /^[a-v0-9]{5,1024}$/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM exams').get().n, 1);
    assert.equal((await reconcile({ db, calendar, exams: [exam], ...context })).unchanged, 1);
    calendar.remote.get(id).summary = 'Manually changed';
    assert.equal((await reconcile({ db, calendar, exams: [exam], ...context })).updated, 1);
    const deletion = await reconcile({ db, calendar, exams: [], ...context });
    assert.equal(deletion.deleted, 1);
    assert.deepEqual(deletion.changes.deleted, [{ date: '2026-10-14', summary: 'Math – Test' }]);
    assert.ok(calendar.remote.has('unrelated'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM exams').get().n, 0);
  } finally { db.close(); }
});
test('exam titles include the selected first name when enabled', () => {
  const namedStudent = { ...student, firstname: 'Raphael' };
  const worksExam = { ...exam, subject: { name: 'Werken' }, type: { name: 'Kurztest' } };
  assert.equal(examEvent(worksExam, scope, namedStudent).summary, 'Werken – Kurztest');
  assert.equal(examEvent(worksExam, scope, namedStudent, { prefixStudentName: true }).summary,
    'Raphael - Werken - Kurztest');
  assert.equal(examEvent(worksExam, scope, student, { prefixStudentName: true }).summary, 'Werken – Kurztest');
});
test('exam entries include class hours in the title and created/updated times in the description', () => {
  const examWithHours = {
    ...exam,
    subject: { name: 'Werken' },
    type: { name: 'Kurztest' },
    startClassHour: { number: '5', from: '11:30:00', until: '12:15:00' },
    endClassHour: { number: '5', from: '11:30:00', until: '12:15:00' },
    createdAt: '2026-09-23T05:43:59.973Z',
    updatedAt: '2026-09-24T06:10:00.000Z'
  };
  const event = examEvent(examWithHours, scope, { ...student, firstname: 'Raphael' }, { prefixStudentName: true });
  assert.equal(event.summary, 'Raphael - Werken - Kurztest (5. Stunde)');
  assert.deepEqual(event.start, { dateTime: '2026-10-14T11:30:00', timeZone: 'Europe/Berlin' });
  assert.deepEqual(event.end, { dateTime: '2026-10-14T12:15:00', timeZone: 'Europe/Berlin' });
  assert.match(event.description, /Erstellt: 23\.09\.26, 07:43/);
  assert.match(event.description, /Aktualisiert: 24\.09\.26, 08:10/);
});
test('exam events can set a popup reminder a configured number of days before', () => {
  assert.deepEqual(examEvent(exam, scope, student).reminders, { useDefault: true });
  assert.deepEqual(examEvent(exam, scope, student, { remindDays: 3 }).reminders,
    { useDefault: false, overrides: [{ method: 'popup', minutes: 4320 }] });
  assert.throws(() => examEvent(exam, scope, student, { remindDays: 29 }), /between 1 and 28/);
});
test('changing event reminder settings updates its existing calendar entry', async () => {
  const db = openDatabase(':memory:');
  const calendar = fakeCalendar();
  try {
    assert.equal((await reconcile({ db, calendar, exams: [exam], ...context })).created, 1);
    const stats = await reconcile({ db, calendar, exams: [exam], ...context, remindDays: 2 });
    assert.equal(stats.updated, 1);
    assert.deepEqual(calendar.remote.values().next().value.reminders,
      { useDefault: false, overrides: [{ method: 'popup', minutes: 2880 }] });
  } finally { db.close(); }
});
test('sick notes and exemptions create reminder-free all-day events with stable status', () => {
  const sick = sickEvent({ id: 81, studentId: student.id, startDate: '2026-10-14', endDate: '2026-10-16' },
    scopeId(56, student.id, 'test-calendar', 'sick'), student);
  assert.equal(sick.summary, 'Krankmeldung');
  assert.deepEqual(sick.start, { date: '2026-10-14' });
  assert.deepEqual(sick.end, { date: '2026-10-17' });
  assert.deepEqual(sick.reminders, { useDefault: false, overrides: [] });
  const exemptionScope = scopeId(56, student.id, 'test-calendar', 'exemptions');
  const request = { id: 82, studentId: student.id, startDate: '2026-10-20', endDate: '2026-10-21', granted: false };
  const pending = exemptionEvent(request, exemptionScope, student);
  const approved = exemptionEvent({ ...request, granted: true }, exemptionScope, student);
  assert.equal(pending.summary, 'Beurlaubung – Nicht genehmigt');
  assert.equal(approved.summary, 'Beurlaubung – Genehmigt');
  assert.equal(pending.id, approved.id);
  assert.deepEqual(approved.reminders, { useDefault: false, overrides: [] });
});
test('absence reconciliation updates a Beurlaubung when granted status changes', async () => {
  const db = openDatabase(':memory:');
  const calendar = fakeCalendar();
  const exemptionScope = scopeId(56, student.id, 'test-calendar', 'exemptions');
  const request = { id: 83, studentId: student.id, startDate: '2026-10-20', endDate: '2026-10-20', granted: false };
  try {
    assert.equal((await reconcile({ db, calendar, exams: [request], student, scope: exemptionScope,
      start: context.start, end: context.end, eventFactory: exemptionEvent, identityProperty: 'smExemptionId' })).created, 1);
    const updated = await reconcile({ db, calendar, exams: [{ ...request, granted: true }], student, scope: exemptionScope,
      start: context.start, end: context.end, eventFactory: exemptionEvent, identityProperty: 'smExemptionId' });
    assert.equal(updated.updated, 1);
    assert.equal(calendar.remote.values().next().value.summary, 'Beurlaubung – Genehmigt');
  } finally { db.close(); }
});
test('absence records are filtered to selected student and overlapping date range', () => {
  const records = [
    { id: 1, studentId: student.id, startDate: '2026-09-30', endDate: '2026-10-05' },
    { id: 2, studentId: student.id, startDate: '2027-04-05', endDate: '2027-04-06' },
    { id: 3, studentId: 999, startDate: '2026-10-10', endDate: '2026-10-10' }
  ];
  assert.deepEqual(recordsForStudentRange(records, student.id, context.start, context.end).map(record => record.id), [1]);
  assert.throws(() => recordsForStudentRange([{ studentId: student.id }], student.id, context.start, context.end), /Invalid date/);
});
test('calendar events expand weekly recurrences and never set reminders', () => {
  const calendarData = {
    nonRecurringEvents: [{
      id: 201, summary: 'Assembly', description: 'School assembly', location: 'Hall', organizer: 'School',
      allDay: true, start: '2026-10-10T00:00:00.000Z', end: '2026-10-11T00:00:00.000Z'
    }, {
      id: 202, summary: 'Meeting', description: null, location: null, organizer: 'School',
      allDay: false, start: '2026-10-08T07:00:00.000Z', end: '2026-10-08T08:15:00.000Z'
    }],
    recurringEvents: [{
      id: 203, summary: 'Weekly event', description: null, location: null, organizer: 'School', allDay: true,
      start: '2026-09-01T00:00:00.000Z', end: '2026-09-02T00:00:00.000Z',
      recurrencePattern: { start: '2026-09-01T00:00:00.000Z', end: '2026-10-20T00:00:00.000Z', frequency: 'Weekly', interval: 1, weekday: 2 }
    }]
  };
  const records = calendarEventsInRange(calendarData, '2026-10-04', '2026-10-20');
  assert.equal(records.length, 5);
  assert.deepEqual(records.filter(record => record.sourceEventId === 203).map(record => record.start.slice(0, 10)),
    ['2026-10-06', '2026-10-13', '2026-10-20']);
  const allDay = calendarEvent(records.find(record => record.id === 201), scope, student);
  assert.deepEqual(allDay.start, { date: '2026-10-10' });
  assert.deepEqual(allDay.end, { date: '2026-10-11' });
  assert.deepEqual(allDay.reminders, { useDefault: false, overrides: [] });
  const timed = calendarEvent(records.find(record => record.id === 202), scope, student);
  assert.deepEqual(timed.start, { dateTime: '2026-10-08T07:00:00.000Z', timeZone: 'Europe/Berlin' });
  assert.deepEqual(timed.end, { dateTime: '2026-10-08T08:15:00.000Z', timeZone: 'Europe/Berlin' });
  assert.deepEqual(timed.reminders, { useDefault: false, overrides: [] });
  assert.throws(() => calendarEventsInRange({ nonRecurringEvents: [], recurringEvents: [{
    id: 999, allDay: true, start: '2026-10-06T00:00:00.000Z', end: '2026-10-07T00:00:00.000Z',
    recurrencePattern: { frequency: 'Monthly', start: '2026-10-06T00:00:00.000Z', end: null }
  }] }, context.start, context.end), /Unsupported calendar recurrence frequency/);
});
test('calendar reconciliation updates timed events and preserves their times in Google PATCH', async () => {
  const db = openDatabase(':memory:');
  const calendar = fakeCalendar();
  const calendarScope = scopeId(56, student.id, 'test-calendar', 'calendar');
  const record = { id: 204, summary: 'Meeting', allDay: false, start: '2026-10-08T07:00:00.000Z',
    end: '2026-10-08T08:00:00.000Z' };
  const reconcileCalendar = entries => reconcile({ db, calendar, exams: entries, ...context, scope: calendarScope,
    eventFactory: calendarEvent, identityProperty: 'smCalendarOccurrenceId', eventOptions: { timeZone: 'Europe/Berlin' } });
  try {
    assert.equal((await reconcileCalendar([record])).created, 1);
    assert.equal((await reconcileCalendar([{ ...record, start: '2026-10-08T07:15:00.000Z' }])).updated, 1);
  } finally { db.close(); }

  const auth = { getRequestHeaders: async () => new Headers({ Authorization: 'Bearer fake' }) };
  let patched;
  const api = new GoogleCalendar(auth, 'test', async (url, options) => {
    patched = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => patched };
  });
  const event = calendarEvent({ ...record, start: '2026-10-08T07:15:00.000Z' }, calendarScope, student,
    { timeZone: 'Europe/Berlin' });
  await api.update(event);
  assert.equal(patched.start.dateTime, '2026-10-08T07:15:00.000Z');
  assert.equal(patched.start.timeZone, 'Europe/Berlin');
  assert.equal(patched.start.date, null);
});
test('Google timezone-offset normalization does not cause repeated timed-event updates', async () => {
  const db = openDatabase(':memory:');
  const original = { id: 205, summary: 'Meeting', allDay: false,
    start: '2026-10-08T07:00:00.000Z', end: '2026-10-08T08:15:00.000Z' };
  const desired = calendarEvent(original, scope, student, { timeZone: 'Europe/Berlin' });
  const remote = {
    ...desired,
    start: { dateTime: '2026-10-08T09:00:00+02:00', timeZone: 'Europe/Berlin' },
    end: { dateTime: '2026-10-08T10:15:00+02:00', timeZone: 'Europe/Berlin' }
  };
  const calendar = fakeCalendar([remote]);
  try {
    const result = await reconcile({ db, calendar, exams: [original], ...context,
      scope, eventFactory: calendarEvent, identityProperty: 'smCalendarOccurrenceId', eventOptions: { timeZone: 'Europe/Berlin' } });
    assert.equal(result.updated, 0);
    assert.equal(result.unchanged, 1);
  } finally { db.close(); }
});
test('Telegram reports actual calendar changes and ignores unchanged cycles', async () => {
  const env = { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '1234' };
  const summary = { studentId: 12, start: '2026-10-04', end: '2027-04-04', stats: {
    created: 1, updated: 1, deleted: 1,
    changes: {
      created: [{ date: '2026-10-14', summary: 'Werken - Kurztest' }],
      updated: [],
      deleted: [{ date: '2026-10-22', summary: 'Mathematik' }]
    }
  } };
  let requestUrl;
  let requestBody;
  const sent = await sendTelegramUpdate(env, summary, async (url, options) => {
    requestUrl = url;
    requestBody = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
  assert.equal(sent, true);
  assert.match(requestUrl, /api\.telegram\.org\/bottest-token\/sendMessage/);
  assert.equal(requestBody.chat_id, '1234');
  assert.match(requestBody.text, /➕ Hinzugefügt \(1\)\n• 14\.10\.2026 · Werken - Kurztest/);
  assert.match(requestBody.text, /➖ Gelöscht \(1\)\n• 22\.10\.2026 · Mathematik/);
  assert.match(requestBody.text, /✏️ Geändert: 1/);
  assert.equal(telegramMessage({ ...summary, stats: { created: 0, updated: 0, deleted: 0 } }), null);
  assert.equal(await sendTelegramUpdate(env, { ...summary, stats: { created: 0, updated: 0, deleted: 0 } }), false);
  await assert.rejects(sendTelegramUpdate({ TELEGRAM_BOT_TOKEN: 'token' }, summary), /Set both/);
  await assert.rejects(sendTelegramUpdate(env, summary, async () => ({ ok: false, status: 401, json: async () => ({ ok: false }) })), /HTTP 401/);
});
test('date changes keep identity; past and beyond-horizon events are preserved; dry run writes nothing', async () => {
  const db = openDatabase(':memory:');
  const past = examEvent({ ...exam, id: 1, date: '2026-09-01' }, scope, student);
  const far = examEvent({ ...exam, id: 2, date: '2027-05-01' }, scope, student);
  const calendar = fakeCalendar([past, far]);
  try {
    await reconcile({ db, calendar, exams: [exam], ...context, dryRun: true });
    assert.deepEqual(calendar.operations, []);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM exams').get().n, 0);
    await reconcile({ db, calendar, exams: [exam], ...context });
    const changed = { ...exam, date: '2026-10-15' };
    assert.equal((await reconcile({ db, calendar, exams: [changed], ...context })).updated, 1);
    assert.ok(calendar.remote.has(past.id)); assert.ok(calendar.remote.has(far.id));
  } finally { db.close(); }
});
test('malformed snapshot cannot trigger writes; remote success survives database rollback without duplicates', async () => {
  const db = openDatabase(':memory:'); const calendar = fakeCalendar();
  try {
    await assert.rejects(reconcile({ db, calendar, exams: [{ date: exam.date }], ...context }));
    assert.deepEqual(calendar.operations, []);
    const create = calendar.upsert;
    calendar.upsert = async event => { await create(event); throw new Error('Simulated crash after insert'); };
    await assert.rejects(reconcile({ db, calendar, exams: [exam], ...context }));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM exams').get().n, 0);
    calendar.upsert = create;
    assert.equal((await reconcile({ db, calendar, exams: [exam], ...context })).unchanged, 1);
    assert.equal(calendar.remote.size, 1);
  } finally { db.close(); }
});
test('Google pagination completes before reconciliation and collision ownership is checked', async () => {
  const headers = new Headers({ Authorization: 'Bearer fake' });
  const auth = { getRequestHeaders: async () => headers };
  let count = 0;
  const calendar = new GoogleCalendar(auth, 'test', async url => {
    count++;
    assert.equal(url.searchParams.get('privateExtendedProperty'), `smScope=${scope}`);
    if (count === 2) assert.equal(url.searchParams.get('pageToken'), 'next');
    return { ok: true, status: 200, json: async () => count === 1 ? { items: [{ id: 'one' }], nextPageToken: 'next' } : { items: [{ id: 'two' }] } };
  });
  assert.equal((await calendar.list(scope)).length, 2);
  const collision = new GoogleCalendar(auth, 'test', async (url, options) => options.method === 'POST'
    ? { ok: false, status: 409 } : { ok: true, status: 200, json: async () => ({ extendedProperties: { private: { smScope: 'other' } } }) });
  await assert.rejects(collision.upsert(examEvent(exam, scope, student), scope), /collision/);
});

test('Google API error details are included in failures', async () => {
  const auth = { getRequestHeaders: async () => new Headers({ Authorization: 'Bearer fake' }) };
  const calendar = new GoogleCalendar(auth, 'test', async () => ({
    ok: false,
    status: 403,
    json: async () => ({ error: { message: 'Calendar access denied.' } })
  }));
  await assert.rejects(calendar.list(scope), /HTTP 403 - Calendar access denied\./);
});

test('OAuth helper uses only a local loopback callback', () => {
  assert.deepEqual(oauthSettings({ GOOGLE_OAUTH_PORT: '8085' }), {
    port: 8085,
    redirectUri: 'http://127.0.0.1:8085/'
  });
  assert.throws(() => oauthSettings({ GOOGLE_OAUTH_PORT: '80' }), /Invalid GOOGLE_OAUTH_PORT/);
});

test('local OAuth helper prompts for missing credentials and hides the client secret prompt', async () => {
  const prompts = [];
  const credentials = await getOAuthCredentials({}, async (message, hidden) => {
    prompts.push({ message, hidden });
    return hidden ? 'client-secret' : 'client-id';
  });
  assert.deepEqual(credentials, { clientId: 'client-id', clientSecret: 'client-secret' });
  assert.deepEqual(prompts.map(prompt => prompt.hidden), [false, true]);
  assert.deepEqual(await getOAuthCredentials({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' }),
    { clientId: 'id', clientSecret: 'secret' });
});

test('Google deleted ID replacement stays linked and is rediscovered on the next sync', async () => {
  const db = openDatabase(':memory:'); const calendar = fakeCalendar();
  const create = calendar.upsert;
  calendar.upsert = async event => {
    const replacement = { ...event, id: `${event.id}abc123` };
    await create(replacement);
    return replacement;
  };
  try {
    await reconcile({ db, calendar, exams: [exam], ...context });
    assert.ok(db.prepare('SELECT google_id FROM exams').get().google_id.endsWith('abc123'));
    assert.equal((await reconcile({ db, calendar, exams: [exam], ...context })).unchanged, 1);
    db.exec('DELETE FROM exams'); // Recover identity even after loss of DB mapping.
    assert.equal((await reconcile({ db, calendar, exams: [exam], ...context })).unchanged, 1);
    assert.equal(calendar.remote.size, 1);
  } finally { db.close(); }
});

test('Google tombstone gets a new ID and updates clear manually added times', async () => {
  const auth = { getRequestHeaders: async () => new Headers({ Authorization: 'Bearer fake' }) };
  let posts = 0;
  const calendar = new GoogleCalendar(auth, 'test', async (url, options) => {
    if (options.method === 'POST') {
      posts++;
      if (posts === 1) return { ok: false, status: 409 };
      const data = JSON.parse(options.body);
      assert.notEqual(data.id, examEvent(exam, scope, student).id);
      assert.equal(data.extendedProperties.private.smExamId, String(exam.id));
      return { ok: true, status: 200, json: async () => data };
    }
    if (options.method === 'GET') return { ok: false, status: 410 };
    const data = JSON.parse(options.body);
    assert.equal(data.start.dateTime, null);
    assert.equal(data.status, 'confirmed');
    return { ok: true, status: 200, json: async () => data };
  });
  await calendar.upsert(examEvent(exam, scope, student), scope);
  await calendar.update(examEvent(exam, scope, student));
});

test('environment configuration supports explicit selection and rejects conflicting calendar IDs', () => {
  const env = { SCHULMANAGER_USERNAME: 'test', SCHULMANAGER_PASSWORD: 'test', GOOGLE_CALENDAR_ID: 'test-calendar', SCHULMANAGER_STUDENT_ID: '12' };
  const config = configuration(env, { weeks: '8', hours: '4' });
  assert.equal(config.weeks, 8); assert.equal(config.studentIndex, undefined);
  assert.equal(config.prefixStudentName, false);
  assert.equal(hasGoogleAuth({}), false);
  assert.equal(hasGoogleAuth({ GOOGLE_REFRESH_TOKEN: 'token' }), false);
  assert.equal(hasGoogleAuth({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_REFRESH_TOKEN: 'token' }), true);
  assert.equal(configuration({ ...env, SCHULMANAGER_STUDENT_ID: '' }, {}).studentId, undefined);
  assert.equal(configuration({ ...env, SYNC_PREFIX_STUDENT_NAME: 'true' }, {}).prefixStudentName, true);
  assert.equal(configuration({ ...env, SYNC_REMIND_DAYS: '3' }, {}).remindDays, 3);
  assert.throws(() => configuration({ ...env, SYNC_REMIND_DAYS: '29' }, {}), /Reminder days must be 1\.\.28/);
  assert.throws(() => configuration({ ...env, TELEGRAM_BOT_TOKEN: 'token' }, {}), /Set both TELEGRAM_BOT_TOKEN/);
  assert.equal(shouldPrefixStudentName(1, false), false);
  assert.equal(shouldPrefixStudentName(2, false), true);
  assert.equal(shouldPrefixStudentName(1, true), true);
  assert.throws(() => configuration(env, { hours: '0' }));
  assert.throws(() => configuration({ ...env, GOOGLE_CALENDAR_ICAL_URL: 'https://calendar.google.com/calendar/ical/other/private-secret/basic.ics' }, {}), /does not match/);
});
