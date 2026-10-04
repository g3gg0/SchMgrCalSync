const BASE = 'https://login.schulmanager-online.de/api';
export const DEFAULT_BUNDLE = 'a2bbc79000';

export function studentsFromUser(user) {
  const records = [user?.associatedStudent, ...(user?.associatedParents ?? []).map(parent => parent.student)].filter(Boolean);
  return [...new Map(records.map(student => [student.id, student])).values()];
}

export function selectStudent(students, { id, index, classId } = {}) {
  if (id != null && index != null) throw new Error('Choose --student-id or --student, not both.');
  const student = id != null ? students.find(s => String(s.id) === String(id)) : students[(index ?? 1) - 1];
  if (!student) throw new Error('Student not found. Run students to list available students.');
  const selected = { id: student.id, classId: classId == null ? student.classId : Number(classId) };
  if (!Object.values(selected).every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Student has no valid class ID; provide --class-id.');
  return selected;
}

export function berlinDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function addDays(date, days) {
  const parsed = new Date(`${date}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error('Invalid date; use YYYY-MM-DD.');
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function buildRequests(student, start, end) {
  return [
    { moduleName: 'exams', endpointName: 'get-exams', parameters: { student, start, end } },
    { moduleName: 'exams', endpointName: 'poqa', parameters: { action: {
      model: 'modules/calendar/event', action: 'findAll', parameters: [{
        where: { blockExams: true, start: { $lte: end }, end: { $gte: start } },
        include: [{ association: 'visibleForGroups', required: true, attributes: ['id'], include: [
          { association: 'students', required: true, attributes: ['id'], where: { id: student.id } }
        ] }]
      }]
    } } },
    { moduleName: 'classbook', endpointName: 'get-homework', parameters: { student: { id: student.id } } }
  ];
}

export class SchulmanagerClient {
  constructor({ username, password, token, institutionId = null, user, onLogin, getCredentials, bundleVersion = DEFAULT_BUNDLE, fetchImpl = fetch }) {
    Object.assign(this, { username, password, token, institutionId, user, onLogin, getCredentials, bundleVersion, fetchImpl });
  }
  async post(path, body, authenticated = false) {
    const response = await this.fetchImpl(`${BASE}/${path}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/json;charset=utf-8', ...(authenticated ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const error = new Error(`Schulmanager ${path}: HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }
  async login() {
    if ((!this.username || !this.password) && this.getCredentials) Object.assign(this, await this.getCredentials());
    if (!this.username || !this.password) throw new Error('Login requires SCHULMANAGER_USERNAME and SCHULMANAGER_PASSWORD (or the interactive login prompt).');
    const data = await this.post('login', { emailOrUsername: this.username, password: this.password, hash: null, mobileApp: false, institutionId: this.institutionId });
    if (typeof data.jwt !== 'string' || !data.jwt) throw new Error('Login returned no JWT. Check credentials or whether school selection/additional authentication is required.');
    this.token = data.jwt;
    this.user = data.user;
    if (this.onLogin) await this.onLogin(data, this.username);
    return data;
  }
  async callRequests(requests) {
    if (!this.token) await this.login();
    for (let attempt = 0; attempt < 2; attempt++) {
      let data;
      try {
        data = await this.post('calls', { bundleVersion: this.bundleVersion, requests }, true);
      } catch (error) {
        if (attempt === 0 && [401, 403].includes(error.status)) { await this.login(); continue; }
        throw error;
      }
      if (!Array.isArray(data.results) || data.results.length !== requests.length) throw new Error('Unexpected API response: missing batch results. The private API may have changed.');
      if (attempt === 0 && data.results.some(result => [401, 403].includes(Number(result.status)))) { await this.login(); continue; }
      return data.results;
    }
  }
  async fetchInformation({ student, start, end }) {
      const settings = (await this.callRequests([{ moduleName: null, endpointName: 'get-settings' }]))[0];
      const unavailable = settings.data?.classbook?.homeworkIsVisibleForStudents === false;
      const requests = buildRequests(student, start, end);
      if (unavailable) requests[2] = { moduleName: 'classbook', endpointName: 'get-topics', parameters: { student: { id: student.id } } };
      const results = await this.callRequests(requests);
      const names = ['exams', 'events', unavailable ? 'topics' : 'homework'];
      const output = { student, start, end, fetchedAt: new Date().toISOString(), errors: [] };
      if (unavailable) { output.homework = null; output.homeworkUnavailable = 'School settings disable homework visibility for students; lesson topics are fetched instead.'; }
      results.forEach((result, index) => {
        const name = names[index];
        if ((result.status != null && Number(result.status) >= 400) || !Array.isArray(result.data)) {
          output[name] = null;
          output.errors.push({ section: name, status: result.status ?? null, message: 'Request failed or returned an unexpected data format.' });
        } else output[name] = [...result.data].sort((a, b) => String(a.date ?? a.start ?? '').localeCompare(String(b.date ?? b.start ?? '')));
      });
      return output;
  }
}
