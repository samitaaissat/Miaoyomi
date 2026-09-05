import { EngineError } from './errors.mjs';

const unavailable = message => new EngineError('SOLVER_UNAVAILABLE', `FlareSolverr: ${message}`);

export function solverEndpoint(value) {
  if (!value) return '';
  let url;
  try { url = new URL(value); } catch { throw new Error('FLARESOLVERR_URL must be an HTTP(S) origin'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('FLARESOLVERR_URL must be an HTTP(S) origin without credentials or a path');
  return url.origin;
}

// The operator-configured solver is a trusted browser service. It handles its own
// DNS, redirects and subresources; the broker validates both boundary URLs.
export async function solvePage({ endpoint, fetch, url, method, body, contentType, cookies, signal, timeoutMs, maxBytes }) {
  if (!endpoint) throw unavailable('not configured');
  if (method !== 'GET' && (method !== 'POST' || !/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(contentType || ''))) {
    throw new EngineError('SOLVER_UNSUPPORTED', 'FlareSolverr supports GET and application/x-www-form-urlencoded POST requests');
  }
  const solverSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  try {
    const response = await fetch(`${endpoint}/v1`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error', signal: solverSignal,
      // FlareSolverr starts maxTimeout after creating Chrome, then tears Chrome
      // down before returning. Leave lifecycle time inside our HTTP deadline.
      body: JSON.stringify({ cmd: method === 'POST' ? 'request.post' : 'request.get', url, ...(method === 'POST' ? { postData: body || '' } : {}), cookies, maxTimeout: Math.max(1, Math.floor(timeoutMs * 5 / 6)) }),
    });
    if (!response.ok) { await response.body?.cancel(); throw unavailable(`HTTP ${response.status}`); }
    // JSON escaping can expand a character to six bytes. Bound the envelope as
    // well as the decoded page instead of calling unbounded response.json().
    const limit = maxBytes * 6 + 1024 * 1024;
    const reader = response.body?.getReader();
    if (!reader) throw unavailable('empty response');
    let size = 0; const chunks = [];
    try {
      while (true) {
        solverSignal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) { await reader.cancel(); throw new EngineError('RESPONSE_LIMIT', 'FlareSolverr response exceeds body limit'); }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw unavailable('invalid JSON response'); }
    if (data?.status !== 'ok' || !data.solution) throw unavailable(String(data?.message || 'no solution').slice(0, 300));
    const solution = data.solution;
    if (!Number.isInteger(solution.status) || typeof solution.url !== 'string' || typeof solution.response !== 'string' || !solution.response.trim()) throw unavailable('invalid or empty solution');
    const page = Buffer.from(solution.response, 'utf8');
    if (page.length > maxBytes) throw new EngineError('RESPONSE_LIMIT', 'Source response exceeds body limit');
    const headers = Object.fromEntries(Object.entries(solution.headers || {}).filter(([, value]) => typeof value === 'string').map(([key, value]) => [key.toLowerCase(), value]));
    // FlareSolverr returns decoded browser text, regardless of the origin encoding.
    headers['content-type'] = `${(headers['content-type'] || 'text/html').split(';')[0]}; charset=utf-8`;
    delete headers['content-encoding']; delete headers['content-length']; delete headers['set-cookie'];
    return { status: solution.status, headers, body: page, url: solution.url, cookies: solution.cookies, userAgent: solution.userAgent };
  } catch (error) {
    if (solverSignal.aborted) throw new EngineError('DEADLINE', 'FlareSolverr request deadline exceeded', 504);
    if (error instanceof EngineError) throw error;
    throw unavailable(error.message);
  }
}
