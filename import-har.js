// Imports request templates only: never credentials, headers, tokens or responses.
import { readFile, writeFile } from 'node:fs/promises';
const files = process.argv.slice(2);
if (!files.length) throw new Error('Usage: node import-har.js capture.har [more.har]');
const modules = new Map([['main', { name: 'main', label: 'Account / school' }]]);
const endpoints = new Map();
const studentIds = new Set();
function findStudents(value) {
  if (!value || typeof value !== 'object') return;
  if (value.student?.id) studentIds.add(value.student.id);
  if (value.associatedStudent?.id) studentIds.add(value.associatedStudent.id);
  for (const v of Object.values(value)) findStudents(v);
}
function sanitize(value, key = '', parent = {}) {
  if (key === 'student') return '$student';
  if (key === 'course') return '$course';
  if (key === 'termId') return '$termId';
  if (key === 'studentId' || (key === 'instanceId' && parent.model === 'main/student')) return '$studentId';
  if (key === 'id' && studentIds.has(value)) return '$studentId';
  if (key === '$in' && Array.isArray(value) && value.every(id => studentIds.has(id))) return ['$studentId'];
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return ['$lte', 'end', 'endDate'].includes(key) ? '$end' : '$start';
  if (Array.isArray(value)) return value.map(v => sanitize(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, sanitize(v,k,value)]));
  return value;
}
for (const file of files) {
  const har = JSON.parse(await readFile(file, 'utf8'));
  for (const entry of har.log.entries) {
    try { findStudents(JSON.parse(entry.request.postData?.text ?? 'null')); } catch {}
    if (entry.request.url.endsWith('/api/login')) { try { findStudents(JSON.parse(entry.response.content.text)); } catch {} }
  }
  for (const entry of har.log.entries) {
    if (!entry.request.url.endsWith('/api/calls')) continue;
    const body = JSON.parse(entry.request.postData.text);
    let response; try { response = JSON.parse(entry.response.content.text); } catch {}
    for (const [index, request] of body.requests.entries()) {
      if (request.endpointName === 'get-active-modules') for (const m of response?.results?.[index]?.data ?? []) modules.set(m.name, { name: m.name, label: m.label });
      const name = request.moduleName ?? 'main';
      if (!modules.has(name)) modules.set(name, { name, label: name });
      if (/token|websocket|2fa|authentication|mailing|user-settings/i.test(request.endpointName)) continue;
      if (!(request.endpointName.startsWith('get-') || ['count-new-messages', 'chat-is-visible', 'exams-visible-for-students', 'event-category-exists'].includes(request.endpointName) ||
          (request.endpointName === 'poqa' && ['findAll', 'findOne', 'getClass'].includes(request.parameters?.action?.action)))) continue;
      const clean = sanitize(request);
      const discriminator = request.endpointName === 'poqa' ? `:${request.parameters.action.model}:${request.parameters.action.action}` : '';
      const id = `${name}/${request.endpointName}${discriminator}`;
      endpoints.set(id, { id, module: name, request: clean });
    }
  }
}
await writeFile(new URL('modules.json', import.meta.url), JSON.stringify({ modules: [...modules.values()], endpoints: [...endpoints.values()] }, null, 2) + '\n');
console.log(`Imported ${modules.size} modules and ${endpoints.size} read endpoints.`);
