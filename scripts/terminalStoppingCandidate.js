const STORAGE_KEY = 'hxd1c-terminal-stopping-candidate-v1';

const clean = (value) => String(value ?? '').trim().replace(/\s+/g, ' ');

export function normalizeCandidate(candidate = {}) {
  return {
    name: clean(candidate.name).slice(0, 20),
    studentId: clean(candidate.studentId).slice(0, 20),
  };
}

export function validateCandidate(candidate = {}) {
  const normalized = normalizeCandidate(candidate);
  if (normalized.name.length < 2) return { valid: false, field: 'name', message: '请输入2～20个字符的姓名。', candidate: normalized };
  if (!/^[\p{Script=Han}A-Za-z·•\s]{2,20}$/u.test(normalized.name)) {
    return { valid: false, field: 'name', message: '姓名仅支持中文、字母、空格和间隔点。', candidate: normalized };
  }
  if (!/^[A-Za-z0-9-]{4,20}$/.test(normalized.studentId)) {
    return { valid: false, field: 'studentId', message: '学号请输入4～20位数字、字母或短横线。', candidate: normalized };
  }
  return { valid: true, field: '', message: '', candidate: normalized };
}

export function loadCandidateDraft(storage = globalThis.sessionStorage) {
  try {
    return normalizeCandidate(JSON.parse(storage?.getItem(STORAGE_KEY) || '{}'));
  } catch {
    return normalizeCandidate();
  }
}

export function saveCandidateDraft(candidate, storage = globalThis.sessionStorage) {
  const normalized = normalizeCandidate(candidate);
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(normalized)); } catch { /* 本轮仍可继续。 */ }
  return normalized;
}

export function clearCandidateDraft(storage = globalThis.sessionStorage) {
  try { storage?.removeItem(STORAGE_KEY); } catch { /* 无持久化存储时无需处理。 */ }
}

export function createCandidateAttempt(candidate, now = new Date()) {
  const validation = validateCandidate(candidate);
  if (!validation.valid) throw new Error(validation.message);
  return Object.freeze({ ...validation.candidate, startedAt: now.toISOString() });
}

export function formatAttemptTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date).replaceAll('/', '-');
}
