import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalog, materialize, runModule } from './modules.js';
import { SchulmanagerClient } from './client.js';

test('catalog templates use selected student and dates and contain only read actions', () => {
  const context = { student: { id: 99, classId: 88 }, studentId: 99, start: '2030-01-01', end: '2030-01-15', termId: 77, course: { id: 66 } };
  for (const entry of catalog.endpoints) {
    const request = materialize(entry.request, context);
    if (request.endpointName === 'poqa') assert.ok(['findAll', 'findOne', 'getClass'].includes(request.parameters.action.action));
    assert.equal(JSON.stringify(request).includes('$student'), false);
    assert.equal(JSON.stringify(request).includes('2407028'), false);
  }
});

test('module probes preserve object/null responses and continue after failures', async () => {
  let count = 0;
  const report = await runModule({ callRequests: async () => {
    count++;
    if (count === 1) throw new Error('network unavailable');
    return [{ status: 200, data: count === 2 ? { categories: [] } : null }];
  } }, 'calendar', { student: { id: 99, classId: 88 }, start: '2030-01-01', end: '2030-01-15' });
  assert.equal(report.results.length, 3);
  assert.equal(report.results[0].ok, false);
  assert.equal(report.results[1].ok, true);
  assert.deepEqual(report.results[1].data, { categories: [] });
  assert.equal(report.results[2].data, null);
  const unsupported = await runModule({}, 'resources', { student: { id: 99 } });
  assert.deepEqual(unsupported.unsupported, ['resources']);
});

test('disabled homework uses captured topics endpoint and explains availability', async () => {
  const sent = [];
  const client = new SchulmanagerClient({ token: 'mock', fetchImpl: async (url, options) => {
    const requests = JSON.parse(options.body).requests;
    sent.push(...requests);
    return { ok: true, json: async () => ({ results: requests.map(r => ({ status: 200, data: r.endpointName === 'get-settings' ? { classbook: { homeworkIsVisibleForStudents: false } } : r.endpointName === 'get-topics' ? [{ date: '2030-01-01', subject: 'Math', topic: 'Fractions' }] : [] })) }) };
  } });
  const result = await client.fetchInformation({ student: { id: 99, classId: 88 }, start: '2030-01-01', end: '2030-01-15' });
  assert.equal(result.homework, null);
  assert.equal(result.topics.length, 1);
  assert.match(result.homeworkUnavailable, /disable homework/);
  assert.equal(sent.some(r => r.endpointName === 'get-homework'), false);
  assert.deepEqual(result.errors, []);
});
