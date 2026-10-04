#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { SchulmanagerClient, berlinDate, addDays, studentsFromUser, selectStudent } from './client.js';

import { fileURLToPath } from 'node:url';
import { catalog, runModule } from './modules.js';
import { readSession, saveSession, clearSession } from './session.js';

async function passwordPrompt() {
  if (!process.stdin.isTTY) throw new Error('Set SCHULMANAGER_PASSWORD for non-interactive use.');
  process.stderr.write('Password: ');
  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const finish = () => {
      process.stdin.off('data', receive);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stderr.write('\n');
    };
    const receive = chunk => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') { finish(); reject(new Error('Login cancelled.')); return; }
        if (character === '\r' || character === '\n') { finish(); resolve(value); return; }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ') value += character;
      }
    };
    process.stdin.on('data', receive);
  });
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'student-id': { type: 'string' }, 'class-id': { type: 'string' },
    module: { type: 'string' }, endpoint: { type: 'string' }, 'course-id': { type: 'string' },
    student: { type: 'string' }, username: { type: 'string' }, password: { type: 'string' },
    'institution-id': { type: 'string' }, 'cache-file': { type: 'string' }, 'no-cache': { type: 'boolean' },
    start: { type: 'string' }, end: { type: 'string' }, days: { type: 'string', default: '14' },
    'bundle-version': { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }
  } });
  if (values.help) {
    console.log(`Usage: node cli.js [fetch|login|students|logout|modules|fetch-module|test-modules] [options]
  --module NAME                  Module name (or all)
  --endpoint NAME                Filter a captured endpoint
  --course-id ID                 Select a learning course (default first)
  --username USER --password PASS   Login credentials (or environment/prompt)
  --student N                    Select student by list number (default first)
  --student-id ID                 Select student by ID
  --class-id ID                   Override class ID
  --institution-id ID            Optional school selection
  --no-cache                     Disable session cache
  --cache-file PATH              Override local .session.json cache
  --start YYYY-MM-DD --end YYYY-MM-DD   Exam/event date range
  --days N                       Days ahead (default 14)
  --json                         Full fetched records as JSON
  --bundle-version VERSION       Override the firmware's API bundle version
Environment: SCHULMANAGER_USERNAME, SCHULMANAGER_PASSWORD,
  SCHULMANAGER_TOKEN, SCHULMANAGER_STUDENT_ID, SCHULMANAGER_CLASS_ID
Homework is returned as supplied by Schulmanager; its date need not be a due date.
login refreshes the session; students lists children; logout clears the cache.`);
    return;
  }
  const command = positionals[0] ?? 'fetch';
  if (positionals.length > 1 || !['fetch', 'login', 'students', 'logout', 'modules', 'fetch-module', 'test-modules'].includes(command)) throw new Error('Use fetch, login, students, or logout; see --help.');
  if (command === 'modules') {
    const modules = catalog.modules.map(m => ({ ...m, endpoints: catalog.endpoints.filter(e => e.module === m.name).map(e => e.id) }));
    if (values.json) console.log(JSON.stringify(modules, null, 2));
    else modules.forEach(m => console.log(`${m.name}: ${m.label} (${m.endpoints.length} captured read endpoints)`));
    return;
  }
  if (command === 'fetch-module' && !values.module) throw new Error('fetch-module requires --module NAME.');
  const index = values.student == null ? undefined : Number(values.student);
  if (index !== undefined && (!Number.isSafeInteger(index) || index < 1)) throw new Error('--student must be a positive list number.');
  if (values.student != null && (values['student-id'] ?? process.env.SCHULMANAGER_STUDENT_ID) != null) throw new Error('Choose --student-id or --student, not both.');
  let student, start, end;
  if (['fetch', 'fetch-module', 'test-modules'].includes(command)) {
    const days = Number(values.days);
    if (!Number.isSafeInteger(days) || days < 0 || days > 366) throw new Error('--days must be between 0 and 366.');
    start = values.start ?? berlinDate();
    addDays(start, 0);
    end = values.end ?? addDays(start, days);
    addDays(end, 0);
    if (end < start) throw new Error('--end must be on or after --start.');
  }
  const cachePath = values['cache-file'] ?? fileURLToPath(new URL('.session.json', import.meta.url));
  if (command === 'logout') {
    await clearSession(cachePath);
    console.log('Cached session removed.');
    return;
  }
  let username = values.username ?? process.env.SCHULMANAGER_USERNAME;
  let password = values.password ?? process.env.SCHULMANAGER_PASSWORD;
  const institutionId = values['institution-id'] == null ? null : Number(values['institution-id']);
  if (institutionId !== null && (!Number.isSafeInteger(institutionId) || institutionId <= 0)) throw new Error('Invalid --institution-id.');
  const token = process.env.SCHULMANAGER_TOKEN?.replace(/^Bearer\s+/i, '');
  const cached = !values['no-cache'] && command !== 'login' && !token
    ? await readSession(cachePath, { username, institutionId }) : null;
  username ??= cached?.username;
  const getCredentials = async () => {
    if (!username && process.stdin.isTTY) {
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      try { username = await prompt.question('Email or username: '); } finally { prompt.close(); }
    }
    if (!password && username) password = await passwordPrompt();
    return { username, password };
  };
  const client = new SchulmanagerClient({
    username, password, token: token ?? cached?.token, user: cached?.user, institutionId,
    getCredentials, bundleVersion: values['bundle-version'],
    onLogin: values['no-cache'] ? undefined : (data, account) => saveSession(cachePath, data, account, institutionId)
  });
  if (command === 'login' || !client.token || !client.user) await client.login();
  const students = studentsFromUser(client.user);
  if (command === 'login' || command === 'students') {
    if (values.json) console.log(JSON.stringify(students, null, 2));
    else {
      if (!students.length) console.log('No associated students found.');
      students.forEach((s, i) => console.log(
        `${i + 1}. ${s.firstname ?? ''} ${s.lastname ?? ''} (ID ${s.id}, class ${s.classId ?? 'unknown'})`
      ));
    }
    return;
  }
  student = selectStudent(students, {
    id: values['student-id'] ?? process.env.SCHULMANAGER_STUDENT_ID,
    index, classId: values['class-id'] ?? process.env.SCHULMANAGER_CLASS_ID
  });
  if (!values.json) console.error(`Student ${student.id}, class ${student.classId}`);
  if (command === 'fetch-module' || command === 'test-modules') {
    const report = await runModule(client, values.module ?? 'all', { student, start, end }, { endpoint: values.endpoint, courseId: values['course-id'] });
    if (command === 'fetch-module' || values.json) console.log(JSON.stringify(report, null, 2));
    else {
      for (const r of report.results) console.log(`${r.ok ? 'OK' : 'FAIL'} ${r.endpoint}: status ${r.status ?? 'unknown'}, ${Array.isArray(r.data) ? `${r.data.length} records` : r.data === null ? 'null' : typeof r.data}${r.error ? ` - ${r.error}` : ''}`);
      for (const name of report.unsupported) console.log(`UNSUPPORTED ${name}: no read request captured`);
    }
    if (report.results.some(r => !r.ok)) process.exitCode = 1;
    return;
  }
  const data = await client.fetchInformation({ student, start, end });
  if (values.json) console.log(JSON.stringify(data, null, 2));
  else {
    for (const [key, label] of [['homework', 'Hausaufgaben'], ['exams', 'Proben / Klausuren'], ['events', 'Termine mit Probensperre'], ...(data.topics ? [['topics', 'Unterrichtsthemen']] : [])]) {
      console.log(`\n${label}:`);
      if (key === 'homework' && data.homeworkUnavailable) console.log(`  ${data.homeworkUnavailable}`);
      else if (data[key] === null) console.log('  Fetch failed (see errors below).');
      else if (!data[key].length) console.log('  Keine Einträge.');
      else for (const item of data[key]) {
        const subject = typeof item.subject === 'object' ? item.subject?.name : item.subject;
        console.log(`  ${item.date ?? item.start ?? ''}  ${subject ?? item.summary ?? item.title ?? item.name ?? ''}  ${item.homework ?? item.topic ?? item.comment ?? item.description ?? ''}`.trimEnd());
      }
    }
  }
  if (data.errors.length) {
    for (const error of data.errors) console.error(`${error.section}: ${error.message} (status ${error.status ?? 'unknown'})`);
    process.exitCode = 1;
  }
}
main().catch(error => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
