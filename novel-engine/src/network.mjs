import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import ipaddr from 'ipaddr.js';
import { Cookie, CookieJar } from 'tough-cookie';
import { EngineError } from './errors.mjs';
import { destroySession, solvePage, solverEndpoint } from './flaresolverr.mjs';
const policy = message => new EngineError('NETWORK_POLICY', message);
const isChallenge = result => result.headers['cf-mitigated'] === 'challenge' || /<title>\s*(?:Just a moment|DDoS-Guard)|cf-chl-|challenge-platform/i.test(result.body.subarray(0, 8192).toString('utf8'));
const positiveInteger = (value, fallback) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
const deadline = () => new EngineError('DEADLINE', 'Source request deadline exceeded', 504);
export function isPublicAddress(value) {
  try { const ip = ipaddr.parse(value); return ip.kind() === 'ipv6' && ip.isIPv4MappedAddress() ? false : ip.range() === 'unicast'; } catch { return false; }
}
export async function pinnedTransport(url, init, pin, signal, maxBytes) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: init.method, headers: init.headers, agent: false, signal,
      lookup: (_host, options, callback) => callback(null, options.all ? [pin] : pin.address, pin.family),
    }, response => {
      let stream = response;
      const encoding = response.headers['content-encoding'];
      const inflater = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null;
      if (inflater) { stream = response.pipe(inflater); response.on('error', error => inflater.destroy(error)); }
      let size = 0; const chunks = [];
      stream.on('data', chunk => { size += chunk.length; if (size > maxBytes) { const error = new EngineError('RESPONSE_LIMIT', 'Source response exceeds body limit'); stream.destroy(error); request.destroy(error); } else chunks.push(chunk); });
      stream.on('error', reject);
      stream.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    request.end(init.body);
  });
}
export class NetworkBroker {
  constructor({ lookup = host => dns.lookup(host, { all: true, verbatim: true }), transport = pinnedTransport, maxBytes = 5 * 1024 * 1024, timeoutMs = 12_000, allowedOrigins = {}, solverUrl = '', solverFetch = globalThis.fetch, solverTimeoutMs = 60_000, solverConcurrency = 2, solverQueueLimit = 32, solverQueueTimeoutMs = 30_000, solverSessionLimit = 4, solverSessionIdleMs = 10 * 60_000, solverSessionTtlMinutes = 15 } = {}) {
    this.solverConcurrency = positiveInteger(solverConcurrency, 2);
    this.solverQueueLimit = positiveInteger(solverQueueLimit, 32);
    this.solverQueueTimeoutMs = positiveInteger(solverQueueTimeoutMs, 30_000);
    this.solverSessionLimit = Math.max(this.solverConcurrency, positiveInteger(solverSessionLimit, 4));
    this.solverSessionIdleMs = positiveInteger(solverSessionIdleMs, 10 * 60_000);
    this.solverSessionTtlMinutes = positiveInteger(solverSessionTtlMinutes, 15);
    Object.assign(this, { lookup, transport, maxBytes, timeoutMs, allowedOrigins, solverFetch, solverTimeoutMs });
    this.solverUrl = solverEndpoint(solverUrl); this.jars = new Map(); this.userAgents = new Map();
    this.activeSolves = 0; this.activeSessionKeys = new Set(); this.solveQueue = [];
    this.sessions = new Map(); this.sessionCleanups = new Set(); this.clearanceSolves = new Map(); this.closeWaiters = []; this.closed = false; this.closePromise = undefined;
  }
  async validate(source, value) {
    let url; try { url = new URL(value); } catch { throw policy('Invalid source URL'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw policy('Only standard public HTTP(S) URLs are allowed');
    const origins = new Set([new URL(source.site).origin, ...(this.allowedOrigins[source.id] || [])]);
    if (!origins.has(url.origin)) throw policy(`Origin is not approved for ${source.id}: ${url.origin}`);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await this.lookup(hostname);
    if (!addresses.length || addresses.some(x => !isPublicAddress(x.address))) throw policy('DNS resolved to a non-public address');
    return { url, pin: addresses[0] };
  }
  sessionKey(source, url) { return `${source.id}\u0000${url.origin}`; }
  async cleanupSession(session) {
    clearTimeout(session.timer);
    const cleanup = destroySession({ endpoint: this.solverUrl, fetch: this.solverFetch, session: session.id, signal: AbortSignal.timeout(10_000) }).catch(() => {
      // Session cleanup is best effort; FlareSolverr also enforces its TTL.
    });
    this.sessionCleanups.add(cleanup);
    try { await cleanup; } finally { this.sessionCleanups.delete(cleanup); }
  }
  async acquireSession(key) {
    let session = this.sessions.get(key);
    if (session) { clearTimeout(session.timer); session.lastUsed = Date.now(); return session; }
    if (this.sessions.size >= this.solverSessionLimit) {
      const evicted = [...this.sessions.values()].filter(item => !this.activeSessionKeys.has(item.key)).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (evicted) { this.sessions.delete(evicted.key); await this.cleanupSession(evicted); }
    }
    session = { id: `miaoyomi-${randomUUID()}`, key, lastUsed: Date.now(), timer: undefined };
    this.sessions.set(key, session);
    return session;
  }
  releaseSession(session) {
    if (this.closed || this.sessions.get(session.key) !== session) return;
    session.lastUsed = Date.now(); clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      if (this.sessions.get(session.key) !== session) return;
      if (this.activeSessionKeys.has(session.key)) { this.releaseSession(session); return; }
      this.sessions.delete(session.key); void this.cleanupSession(session);
    }, this.solverSessionIdleMs);
    session.timer.unref?.();
  }
  pumpSolves() {
    if (this.closed) return;
    while (this.activeSolves < this.solverConcurrency) {
      const index = this.solveQueue.findIndex(item => !this.activeSessionKeys.has(item.key));
      if (index < 0) break;
      const [item] = this.solveQueue.splice(index, 1);
      clearTimeout(item.timer); item.signal.removeEventListener('abort', item.abort);
      if (item.signal.aborted) { item.reject(deadline()); continue; }
      this.activeSolves++; this.activeSessionKeys.add(item.key);
      Promise.resolve().then(item.task).then(item.resolve, item.reject).finally(() => {
        this.activeSolves--; this.activeSessionKeys.delete(item.key); this.pumpSolves();
        if (this.activeSolves === 0) for (const resolve of this.closeWaiters.splice(0)) resolve();
      });
    }
  }
  scheduleSolve(key, signal, task) {
    if (this.closed) return Promise.reject(new EngineError('SOLVER_UNAVAILABLE', 'Novel FlareSolverr broker is shutting down'));
    if (signal.aborted) return Promise.reject(deadline());
    if (this.activeSolves < this.solverConcurrency && !this.activeSessionKeys.has(key)) {
      this.activeSolves++; this.activeSessionKeys.add(key);
      return Promise.resolve().then(task).finally(() => {
        this.activeSolves--; this.activeSessionKeys.delete(key); this.pumpSolves();
        if (this.activeSolves === 0) for (const resolve of this.closeWaiters.splice(0)) resolve();
      });
    }
    if (this.solveQueue.length >= this.solverQueueLimit) return Promise.reject(new EngineError('SOLVER_BUSY', 'Novel FlareSolverr queue is full; retry shortly'));
    return new Promise((resolve, reject) => {
      const item = { key, signal, task, resolve, reject };
      item.abort = () => { const index = this.solveQueue.indexOf(item); if (index >= 0) this.solveQueue.splice(index, 1); clearTimeout(item.timer); reject(deadline()); };
      item.timer = setTimeout(() => { const index = this.solveQueue.indexOf(item); if (index >= 0) this.solveQueue.splice(index, 1); signal.removeEventListener('abort', item.abort); reject(new EngineError('SOLVER_BUSY', 'Novel FlareSolverr queue wait timed out; retry shortly')); }, this.solverQueueTimeoutMs);
      signal.addEventListener('abort', item.abort, { once: true }); this.solveQueue.push(item);
    });
  }
  async solve(source, url, init, jar, signal) {
    const key = this.sessionKey(source, url);
    return this.scheduleSolve(key, signal, () => this.solveNow(source, url, init, jar, signal, key));
  }
  async solveNow(source, url, init, jar, signal, key) {
    await this.validate(source, url.href);
    signal.throwIfAborted();
    const session = await this.acquireSession(key);
    let succeeded = false;
    try {
      const cookies = (await jar.getCookies(url.href)).slice(0, 32).map(cookie => ({ name: cookie.key, value: cookie.value, domain: `${cookie.hostOnly ? '' : '.'}${cookie.domain}`, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, ...(cookie.expires instanceof Date ? { expiry: Math.floor(cookie.expires.getTime() / 1000) } : {}) }));
      const result = await solvePage({ endpoint: this.solverUrl, fetch: this.solverFetch, url: url.href, method: init.method, body: init.body, contentType: init.headers['content-type'], cookies, session: session.id, sessionTtlMinutes: this.solverSessionTtlMinutes, signal, timeoutMs: this.solverTimeoutMs, maxBytes: this.maxBytes });
      signal.throwIfAborted();
      const { url: finalUrl } = await this.validate(source, result.url);
      for (const cookie of (Array.isArray(result.cookies) ? result.cookies : []).slice(0, 32)) {
        if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name) || /[;\r\n]/.test(cookie.value) || cookie.name.length + cookie.value.length > 4096) continue;
        const expiry = cookie.expiry ?? cookie.expires;
        const domain = typeof cookie.domain === 'string' ? cookie.domain : '';
        const parsed = new Cookie({ key: cookie.name, value: cookie.value, domain: domain ? domain.replace(/^\./, '').toLowerCase() : undefined, hostOnly: !domain.startsWith('.'), path: typeof cookie.path === 'string' ? cookie.path : '/', secure: cookie.secure === true, httpOnly: cookie.httpOnly === true, ...(Number.isFinite(expiry) && expiry >= 0 ? { expires: new Date(expiry * 1000) } : {}) });
        if (parsed.toString().length <= 4096) await jar.setCookie(parsed, finalUrl.href, { ignoreError: true });
      }
      if ((await jar.serialize()).cookies.length > 128) await jar.removeAllCookies();
      if (typeof result.userAgent === 'string' && result.userAgent.length <= 2048 && !/[\r\n]/.test(result.userAgent)) this.userAgents.set(`${source.id}:${finalUrl.origin}`, result.userAgent);
      succeeded = true;
      return { status: result.status, headers: result.headers, body: result.body, url: finalUrl.href };
    } finally {
      if (succeeded) this.releaseSession(session);
      else if (this.sessions.get(session.key) === session) { this.sessions.delete(session.key); void this.cleanupSession(session); }
    }
  }
  waitForClearance(flight, signal) {
    if (signal.aborted) return Promise.reject(deadline());
    flight.waiters++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = callback => value => { if (settled) return; settled = true; signal.removeEventListener('abort', abort); flight.waiters--; callback(value); };
      const abort = () => {
        if (settled) return;
        settled = true; signal.removeEventListener('abort', abort); flight.waiters--;
        if (!flight.settled && flight.waiters === 0) flight.controller.abort();
        reject(deadline());
      };
      signal.addEventListener('abort', abort, { once: true });
      flight.promise.then(finish(resolve), finish(reject));
    });
  }
  async solveClearance(source, url, headers, jar, signal) {
    const key = this.sessionKey(source, url);
    let flight = this.clearanceSolves.get(key);
    if (!flight) {
      const controller = new AbortController();
      const solveSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.solverQueueTimeoutMs + this.solverTimeoutMs)]);
      flight = { controller, waiters: 0, settled: false, url: url.href };
      flight.promise = this.solve(source, url, { method: 'GET', headers }, jar, solveSignal).finally(() => {
        flight.settled = true;
        if (this.clearanceSolves.get(key) === flight) this.clearanceSolves.delete(key);
      });
      this.clearanceSolves.set(key, flight);
    }
    return { rendered: await this.waitForClearance(flight, signal), fallbackAllowed: flight.url === url.href };
  }
  async request(source, value, init = {}, parentSignal, allowSolver = true, redirectLimit = 5) {
    const totalMs = this.timeoutMs + (allowSolver && this.solverUrl ? this.solverQueueTimeoutMs + this.solverTimeoutMs : 0);
    const signal = parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(totalMs)]) : AbortSignal.timeout(totalMs);
    let abortListener;
    const work = async () => {
      let current = value;
      let method = String(init.method || 'GET').toUpperCase();
      if (!['GET', 'POST', 'HEAD'].includes(method)) throw policy('Unsupported request method');
      let body = init.body;
      if (body !== undefined && (typeof body !== 'string' || Buffer.byteLength(body) > 64 * 1024)) throw policy('Request body must be text of at most 64 KiB');
      if (!this.jars.has(source.id)) this.jars.set(source.id, new CookieJar());
      const jar = this.jars.get(source.id);
      for (let redirect = 0; redirect <= redirectLimit; redirect++) {
        signal.throwIfAborted();
        const { url, pin } = await this.validate(source, current);
        const headers = { accept: '*/*', 'accept-encoding': 'gzip, deflate, br', 'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36' };
        for (const [key, value] of Object.entries(init.headers || {})) {
          const name = key.toLowerCase();
          if (['accept', 'accept-language', 'content-type', 'user-agent', 'referer', 'origin', 'x-requested-with'].includes(name) && typeof value === 'string' && value.length <= 2048) headers[name] = value;
        }
        const userAgent = this.userAgents.get(`${source.id}:${url.origin}`); if (userAgent) headers['user-agent'] = userAgent;
        const cookies = await jar.getCookieString(url.href); if (cookies) headers.cookie = cookies;
        const directSignal = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
        let result;
        if (allowSolver && init.useWebView === true) result = await this.solve(source, url, { method, headers, body }, jar, signal);
        else {
          try { result = await this.transport(url, { method, headers, body }, pin, directSignal, this.maxBytes); }
          catch (error) { if (directSignal.aborted) throw new EngineError('DEADLINE', 'Source request deadline exceeded', 504); throw error; }
        }
        if (result.body.length > this.maxBytes) throw new EngineError('RESPONSE_LIMIT', 'Source response exceeds body limit');
        for (const cookie of (Array.isArray(result.headers['set-cookie']) ? result.headers['set-cookie'] : result.headers['set-cookie'] ? [result.headers['set-cookie']] : []).slice(0, 32)) {
          if (cookie.length <= 4096) await jar.setCookie(cookie, url.href, { ignoreError: true });
        }
        if ((await jar.serialize()).cookies.length > 128) await jar.removeAllCookies();
        if ([301, 302, 303, 307, 308].includes(result.status)) {
          if (!result.headers.location || redirect === redirectLimit) throw new EngineError('SOURCE_REDIRECT', 'Invalid or excessive source redirects');
          current = new URL(result.headers.location, url).href;
          if (result.status === 303 || ([301, 302].includes(result.status) && method === 'POST')) { method = 'GET'; body = undefined; }
          continue;
        }
        if (isChallenge(result) && allowSolver && this.solverUrl && init.useWebView !== true) {
          // Browser DOM is not a raw HTTP response: FlareSolverr currently reports
          // synthetic status200 and renders JSON inside <pre>. Establish clearance
          // with a GET, then retry the original guarded request exactly once. A
          // challenged POST is never also submitted by the browser.
          const { rendered, fallbackAllowed } = await this.solveClearance(source, url, headers, jar, signal);
          if (isChallenge(rendered)) throw new EngineError('SITE_CHALLENGE', 'Source returned a browser challenge');
          if (rendered.status < 200 || rendered.status >= 300) throw new EngineError('SOURCE_HTTP', `Source returned HTTP ${rendered.status}`);
          try { return await this.request(source, url.href, { ...init, method, body, useWebView: false }, signal, false, redirectLimit - redirect); }
          catch (error) {
            // Only a caller explicitly asking for an HTML document can use a
            // rendered fallback, and only if HTTP still encounters a challenge.
            // Real HTTP errors and JSON/AJAX responses must remain observable.
            if (error.code === 'SITE_CHALLENGE' && fallbackAllowed && method === 'GET' && /\btext\/html\b/i.test(headers.accept) && !/json/i.test(headers.accept) && !headers['x-requested-with'] && !/<pre\b/i.test(rendered.body.toString('utf8'))) return rendered;
            throw error;
          }
        }
        if (isChallenge(result)) throw new EngineError('SITE_CHALLENGE', 'Source returned a browser challenge');
        if (result.status < 200 || result.status >= 300) throw new EngineError('SOURCE_HTTP', `Source returned HTTP ${result.status}`);
        return { ...result, url: result.url || url.href };
      }
    };
    try {
      return await Promise.race([work(), new Promise((_, reject) => { abortListener = () => reject(new EngineError('DEADLINE', 'Source request deadline exceeded', 504)); signal.addEventListener('abort', abortListener, { once: true }); if (signal.aborted) abortListener(); })]);
    } catch (error) { if (error instanceof EngineError) throw error; if (signal.aborted) throw new EngineError('DEADLINE', 'Source request deadline exceeded', 504); throw new EngineError('SOURCE_NETWORK', `Source network error: ${error.message}`); }
    finally { signal.removeEventListener('abort', abortListener); }
  }
  async fetch(source, value, init, signal) {
    const result = await this.request(source, value, init, signal);
    if (/<h2[^>]*>\s*Adult Content Warning\s*<\/h2>/i.test(result.body.toString('utf8'))) throw new EngineError('SOURCE_INTERSTITIAL', 'Source requires consent in a browser; this guest-only engine cannot complete that step');
    if (/\/users\/login(?:[?#]|$)/.test(result.url)) throw new EngineError('SOURCE_INTERSTITIAL', 'Source requires browser login');
    const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(result.headers['content-type'] || '')?.[1] || 'utf-8';
    let body; try { body = new TextDecoder(charset).decode(result.body); } catch { throw new EngineError('SOURCE_ENCODING', `Unsupported text encoding: ${charset}`); }
    return { ...result, body, headers: Object.fromEntries(Object.entries(result.headers).filter(([key]) => key !== 'set-cookie').map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value])) };
  }
  async fetchAsset(source, value, signal, init = {}) {
    const result = await this.request(source, value, init, signal, false);
    const type = (result.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const b = result.body;
    const matches = type === 'image/png' ? b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : type === 'image/jpeg' ? b[0] === 255 && b[1] === 216 && b[2] === 255 : type === 'image/gif' ? /^GIF8[79]a/.test(b.subarray(0,6).toString()) : type === 'image/webp' ? b.subarray(0,4).toString() === 'RIFF' && b.subarray(8,12).toString() === 'WEBP' : false;
    if (!matches) throw new EngineError('INVALID_ASSET', 'Source asset must have a matching PNG, JPEG, GIF or WebP signature and Content-Type; AVIF is not supported by the EPUB path');
    return { body: b, contentType: type };
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      for (const item of this.solveQueue.splice(0)) {
        clearTimeout(item.timer); item.signal.removeEventListener('abort', item.abort);
        item.reject(new EngineError('SOLVER_UNAVAILABLE', 'Novel FlareSolverr broker is shutting down'));
      }
      for (const flight of this.clearanceSolves.values()) flight.controller.abort();
      if (this.activeSolves > 0) await new Promise(resolve => this.closeWaiters.push(resolve));
      const sessions = [...this.sessions.values()]; this.sessions.clear();
      await Promise.allSettled([...this.sessionCleanups, ...sessions.map(session => this.cleanupSession(session))]);
    })();
    return this.closePromise;
  }
}
