import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SchulmanagerClient, buildRequests, addDays, studentsFromUser, selectStudent } from './client.js';
import { tokenExpired, readSession, saveSession, clearSession } from './session.js';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('HAR login shape and associated parents support default and explicit selection', async () => {
  const students = [{ id: 12, classId: 34, firstname: 'One' }, { id: 56, classId: 78, firstname: 'Two' }];
  let sent;
  const client = new SchulmanagerClient({ username: 'test', password: 'test', fetchImpl: async (url, options) => {
    sent = JSON.parse(options.body);
    return { ok: true, json: async () => ({ jwt: 'test-token', user: { associatedStudent: null, associatedParents: students.map(student => ({ student })) } }) };
  } });
  await client.login();
  assert.deepEqual(sent, { emailOrUsername: 'test', password: 'test', hash: null, mobileApp: false, institutionId: null });
  const found = studentsFromUser(client.user);
  assert.deepEqual(selectStudent(found), { id: 12, classId: 34 });
  assert.deepEqual(selectStudent(found, { index: 2 }), { id: 56, classId: 78 });
  assert.deepEqual(selectStudent(found, { id: '56' }), { id: 56, classId: 78 });
  assert.throws(() => selectStudent(found, { id: '999' }));
  assert.throws(() => selectStudent(found, { id: '12', index: 2 }));
  assert.deepEqual(studentsFromUser({ associatedStudent: students[0] }), [students[0]]);
});

test('session cache rejects expiry and other accounts and stores no password', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'schulmanager-test-'));
  const path = join(dir, 'session.json');
  const jwt = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
  try {
    await saveSession(path, { jwt, user: { associatedParents: [] }, password: 'never-store' }, 'account');
    assert.equal((await readSession(path, { username: 'account' })).token, jwt);
    assert.equal(await readSession(path, { username: 'other' }), null);
    assert.equal(await readSession(path, { institutionId: 123 }), null);
    assert.equal((await readFile(path, 'utf8')).includes('never-store'), false);
    assert.equal(tokenExpired(jwt, Date.now() + 3600000), true);
    assert.equal(tokenExpired('broken'), true);
    await clearSession(path);
    assert.equal(await readSession(path), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('calendar overlap uses real operators and correct range boundaries', () => {
  const requests = buildRequests({ id: 12, classId: 34 }, '2026-10-04', '2026-10-18');
  assert.deepEqual(requests[1].parameters.action.parameters[0].where, {
    blockExams: true, start: { $lte: '2026-10-18' }, end: { $gte: '2026-10-04' }
  });
  assert.equal(addDays('2026-10-24', 2), '2026-10-26');
  assert.throws(() => addDays('2026-02-30', 0));
});

test('expired token in any batch result triggers one login and full retry', async () => {
  const calls = [];
  const client = new SchulmanagerClient({ username: 'test', password: 'test', token: 'old', fetchImpl: async (url, options) => {
    if (JSON.parse(options.body).requests?.[0]?.endpointName === 'get-settings') return { ok: true, json: async () => ({ results: [{ status: 200, data: {} }] }) };
    calls.push({ url, options });
    if (url.endsWith('/login')) return { ok: true, json: async () => ({ jwt: 'new' }) };
    return { ok: true, json: async () => ({ results: calls.length === 1
      ? [{ data: [] }, { data: [] }, { status: 403 }]
      : [{ data: [{ date: '2026-10-06' }, { date: '2026-10-05' }] }, { data: [] }, { data: [] }] }) };
  } });
  const result = await client.fetchInformation({ student: { id: 12, classId: 34 }, start: '2026-10-04', end: '2026-10-18' });
  assert.equal(calls.length, 3);
  assert.equal(calls[2].options.headers.Authorization, 'Bearer new');
  assert.equal(result.exams[0].date, '2026-10-05');
  assert.deepEqual(result.errors, []);
});

test('failed section is distinct from an empty successful section', async () => {
  const client = new SchulmanagerClient({ token: 'test', fetchImpl: async (url, options) => ({ ok: true, json: async () => ({ results: JSON.parse(options.body).requests[0].endpointName === 'get-settings' ? [{ data: {} }] : [{ status: 500 }, { data: [] }, { data: [] }] }) }) });
  const result = await client.fetchInformation({ student: { id: 1, classId: 2 }, start: '2026-10-04', end: '2026-10-18' });
  assert.equal(result.exams, null);
  assert.deepEqual(result.homework, []);
  assert.equal(result.errors[0].section, 'exams');
});
