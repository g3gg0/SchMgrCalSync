import { readFile } from 'node:fs/promises';
export const catalog = JSON.parse(await readFile(new URL('modules.json', import.meta.url), 'utf8'));

export function materialize(value, context) {
  if (typeof value === 'string' && /^\$(student|studentId|course|termId|start|end)$/.test(value)) {
    const result = context[value.slice(1)];
    if (result == null) throw new Error(`Missing context ${value}; supply the relevant selection.`);
    return result;
  }
  if (Array.isArray(value)) return value.map(v => materialize(v, context));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, materialize(v,context)]));
  return value;
}

export async function runModule(client, name, context, { endpoint, courseId } = {}) {
  if (name !== 'all' && !catalog.modules.some(m => m.name === name)) throw new Error(`Unknown module ${name}; run modules.`);
  const entries = catalog.endpoints.filter(e => (name === 'all' || e.module === name) && (!endpoint || e.id === endpoint || e.request.endpointName === endpoint));
  if (endpoint && !entries.length) throw new Error('No matching captured endpoint. Run modules --json for endpoint IDs.');
  const results = [];
  const resolved = { ...context, studentId: context.student.id };
  const dependency = async request => {
    const result = (await client.callRequests([request]))[0];
    if (Number(result.status) >= 400 || result.data == null) throw new Error(`Dependency ${request.endpointName} failed (${result.status}).`);
    return result.data;
  };
  for (const entry of entries) {
    try {
      const template = JSON.stringify(entry.request);
      if (template.includes('"$termId"') && !resolved.termId) {
        resolved.termId = (await dependency({ moduleName: null, endpointName: 'get-current-term' })).id;
      }
      if (template.includes('"$course"') && !resolved.course) {
        const courses = await dependency({ moduleName: 'learning', endpointName: 'get-learning-courses', parameters: { student: context.student } });
        resolved.course = courseId ? courses.find(c => String(c.id) === String(courseId)) : courses[0];
        if (!resolved.course) throw new Error('No matching learning course available.');
      }
      const request = materialize(entry.request, resolved);
      const response = (await client.callRequests([request]))[0];
      results.push({ endpoint: entry.id, status: response.status ?? 200, ok: !(Number(response.status) >= 400), data: response.data ?? null,
        ...(response.error ? { error: response.error } : {}) });
    } catch (error) { results.push({ endpoint: entry.id, ok: false, status: null, error: error.message }); }
  }
  return { module: name, student: context.student, results,
    unsupported: catalog.modules.filter(m => (name === 'all' || m.name === name) && !catalog.endpoints.some(e => e.module === m.name)).map(m => m.name) };
}
