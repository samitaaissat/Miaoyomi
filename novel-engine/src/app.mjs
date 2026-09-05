import Fastify from 'fastify';
import { timingSafeEqual, createHash } from 'node:crypto';
import { executePlugin } from './executor.mjs';
import { NetworkBroker } from './network.mjs';
import { Registry } from './registry.mjs';
import { EngineError } from './errors.mjs';
const methods = ['popularNovels', 'searchNovels', 'parseNovel', 'parsePage', 'parseChapter', 'resolveUrl'];
const bad = message => new EngineError('INVALID_CALL', message, 400);
export function validateInvocation(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.sourceId !== 'string' || !methods.includes(body.method) || !Array.isArray(body.args) || body.args.length > 3) throw bad('Expected sourceId, an allowed method, and an args array');
  const a = body.args;
  if (body.method === 'popularNovels') { if (!Number.isInteger(a[0]) || a[0] < 1 || a[0] > 10000 || (a[1] !== undefined && (!a[1] || typeof a[1] !== 'object' || Array.isArray(a[1])))) throw bad('Browse expects a positive page and an options object'); }
  else if (body.method === 'searchNovels') { if (typeof a[0] !== 'string' || !a[0].trim() || a[0].length > 500 || !Number.isInteger(a[1]) || a[1] < 1 || a[1] > 10000) throw bad('Search expects a term and positive page'); }
  else if (typeof a[0] !== 'string' || !a[0] || a[0].length > 4096) throw bad('Source method expects a nonempty path');
  if (body.method === 'parsePage' && typeof a[1] !== 'string') throw bad('parsePage expects a page string');
}
export async function createApp({ token = process.env.NOVEL_ENGINE_TOKEN, registry, broker = new NetworkBroker(), concurrency = 2, deadlineMs = 20_000, logger = false } = {}) {
  if (!token) throw Error('NOVEL_ENGINE_TOKEN is required');
  registry ??= await Registry.open();
  const app = Fastify({ logger, bodyLimit: 128 * 1024 });
  const expected = createHash('sha256').update(`Bearer ${token}`).digest();
  let active = 0;
  const bounded = async callback => { if (active >= concurrency) throw new EngineError('ENGINE_BUSY', 'Novel engine concurrency limit reached; retry shortly', 502); active++; try { return await callback(); } finally { active--; } };
  app.addHook('onRequest', async request => {
    if (request.method === 'GET' && request.url === '/healthz') return;
    const provided = createHash('sha256').update(request.headers.authorization || '').digest();
    if (!timingSafeEqual(provided, expected)) throw new EngineError('UNAUTHORIZED', 'Private engine token required', 401);
  });
  app.setErrorHandler((error, _request, reply) => reply.code(error.status || (error.statusCode === 400 || error.statusCode === 413 ? 400 : 502)).send({ error: error.code || 'ENGINE_ERROR', message: error.message }));
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/v1/sources', async () => ({ sources: registry.list() }));
  app.get('/v1/sources/:id', async request => ({ source: await bounded(() => registry.get(request.params.id)) }));
  app.post('/v1/sources/:id', async request => {
    if (!request.body || typeof request.body.enabled !== 'boolean') throw bad('enabled must be a boolean');
    return { source: await bounded(() => registry.enable(request.params.id, request.body.enabled)) };
  });
  app.post('/v1/invoke', async request => {
    validateInvocation(request.body);
    const { sourceId, method, args } = request.body;
    const entry = registry.active(sourceId);
    return bounded(async () => {
      if (entry.running) throw new EngineError('SOURCE_BUSY', 'Source already has an active request; retry shortly', 502);
      entry.running = true;
      let requests = 0;
      try {
        const result = await executePlugin(entry.script, method, args, { deadlineMs, storageSnapshot: entry.storageExpires > Date.now() ? entry.storage : {}, onStorage: storage => { entry.storage = storage; entry.storageExpires = Date.now() + 15 * 60 * 1000; }, fetch: (url, init, signal) => { if (++requests > 32) throw new EngineError('REQUEST_LIMIT', 'Plugin request limit exceeded'); return broker.fetch(entry.source, url, init, signal); } });
        return { result };
      } finally { entry.running = false; }
    });
  });
  app.post('/v1/asset', async (request, reply) => {
    if (!request.body || typeof request.body.sourceId !== 'string' || typeof request.body.url !== 'string' || request.body.url.length > 4096) throw bad('Expected sourceId and an asset URL');
    const asset = await bounded(async () => {
      await registry.get(request.body.sourceId);
      const entry = registry.active(request.body.sourceId);
      return broker.fetchAsset(entry.source, request.body.url, undefined, entry.imageRequestInit);
    });
    reply.header('content-type', asset.contentType).header('x-content-type-options', 'nosniff'); return reply.send(asset.body);
  });
  return app;
}
