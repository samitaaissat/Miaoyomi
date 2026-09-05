import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { CookieJar } from 'tough-cookie';
import { EngineError } from './errors.mjs';
const policy = message => new EngineError('NETWORK_POLICY', message);
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
  constructor({ lookup = host => dns.lookup(host, { all: true, verbatim: true }), transport = pinnedTransport, maxBytes = 5 * 1024 * 1024, timeoutMs = 12_000, allowedOrigins = {} } = {}) {
    Object.assign(this, { lookup, transport, maxBytes, timeoutMs, allowedOrigins }); this.jars = new Map();
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
  async request(source, value, init = {}, parentSignal) {
    const signal = parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
    let abortListener;
    const work = async () => {
      let current = value;
      let method = String(init.method || 'GET').toUpperCase();
      if (!['GET', 'POST', 'HEAD'].includes(method)) throw policy('Unsupported request method');
      let body = init.body;
      if (body !== undefined && (typeof body !== 'string' || Buffer.byteLength(body) > 64 * 1024)) throw policy('Request body must be text of at most 64 KiB');
      if (!this.jars.has(source.id)) this.jars.set(source.id, new CookieJar());
      const jar = this.jars.get(source.id);
      for (let redirect = 0; redirect <= 5; redirect++) {
        signal.throwIfAborted();
        const { url, pin } = await this.validate(source, current);
        const headers = { accept: '*/*', 'accept-encoding': 'gzip, deflate, br', 'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36' };
        for (const [key, value] of Object.entries(init.headers || {})) {
          const name = key.toLowerCase();
          if (['accept', 'accept-language', 'content-type', 'user-agent', 'referer', 'origin', 'x-requested-with'].includes(name) && typeof value === 'string' && value.length <= 2048) headers[name] = value;
        }
        const cookies = await jar.getCookieString(url.href); if (cookies) headers.cookie = cookies;
        const result = await this.transport(url, { method, headers, body }, pin, signal, this.maxBytes);
        if (result.body.length > this.maxBytes) throw new EngineError('RESPONSE_LIMIT', 'Source response exceeds body limit');
        for (const cookie of (Array.isArray(result.headers['set-cookie']) ? result.headers['set-cookie'] : result.headers['set-cookie'] ? [result.headers['set-cookie']] : []).slice(0, 32)) {
          if (cookie.length <= 4096) await jar.setCookie(cookie, url.href, { ignoreError: true });
        }
        if ((await jar.serialize()).cookies.length > 128) await jar.removeAllCookies();
        if ([301, 302, 303, 307, 308].includes(result.status)) {
          if (!result.headers.location || redirect === 5) throw new EngineError('SOURCE_REDIRECT', 'Invalid or excessive source redirects');
          current = new URL(result.headers.location, url).href;
          if (result.status === 303 || ([301, 302].includes(result.status) && method === 'POST')) { method = 'GET'; body = undefined; }
          continue;
        }
        const prefix = result.body.subarray(0, 8192).toString('utf8');
        if (result.headers['cf-mitigated'] === 'challenge' || /<title>\s*Just a moment|cf-chl-|challenge-platform/i.test(prefix)) throw new EngineError('SITE_CHALLENGE', 'Source returned a browser challenge');
        if (result.status < 200 || result.status >= 300) throw new EngineError('SOURCE_HTTP', `Source returned HTTP ${result.status}`);
        return { ...result, url: url.href };
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
    const result = await this.request(source, value, init, signal);
    const type = (result.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const b = result.body;
    const matches = type === 'image/png' ? b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : type === 'image/jpeg' ? b[0] === 255 && b[1] === 216 && b[2] === 255 : type === 'image/gif' ? /^GIF8[79]a/.test(b.subarray(0,6).toString()) : type === 'image/webp' ? b.subarray(0,4).toString() === 'RIFF' && b.subarray(8,12).toString() === 'WEBP' : false;
    if (!matches) throw new EngineError('INVALID_ASSET', 'Source asset must have a matching PNG, JPEG, GIF or WebP signature and Content-Type; AVIF is not supported by the EPUB path');
    return { body: b, contentType: type };
  }
}
