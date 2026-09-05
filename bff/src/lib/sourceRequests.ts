import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance } from 'fastify';
import { RequestQueue, type RequestOptions, type RequestPriority } from './requestQueue';
import type { SourceAdapter } from './sources/types';

interface SourceRequestContext { signal?: AbortSignal; priority?: RequestPriority }
const context = new AsyncLocalStorage<SourceRequestContext>();
export const currentSourceRequest = (): SourceRequestContext => context.getStore() || {};
export function withSourceRequests<T>(options: SourceRequestContext, callback: () => T): T {
  return context.run({ ...currentSourceRequest(), ...options }, callback);
}

/** Read requests own their work; detached mutation/download jobs retain their independent lifetime. */
export function installSourceRequestContext(app: FastifyInstance): void {
  app.addHook('onRequest', (request, reply, done) => {
    if (request.method !== 'GET') return done();
    const controller = new AbortController();
    const abort = () => controller.abort();
    const cleanup = () => {
      request.raw.off('aborted', abort);
      reply.raw.off('close', close);
      reply.raw.off('finish', cleanup);
    };
    const close = () => { if (!reply.raw.writableEnded) abort(); cleanup(); };
    request.raw.once('aborted', abort);
    reply.raw.once('close', close);
    reply.raw.once('finish', cleanup);
    withSourceRequests({ signal: controller.signal, priority: 'interactive' }, done);
  });
}
const number = (name: string, fallback: number) => process.env[name] ? Number(process.env[name]) : fallback;
export const sourceRequestQueue = new RequestQueue({
  concurrency: number('SOURCE_REQUEST_CONCURRENCY', 4),
  perKeyConcurrency: number('SOURCE_REQUEST_PER_SOURCE', 2),
  maxQueued: number('SOURCE_REQUEST_QUEUE_LIMIT', 128),
  maxQueuedPerKey: number('SOURCE_REQUEST_QUEUE_PER_SOURCE', 32),
  maxWaitMs: number('SOURCE_REQUEST_QUEUE_WAIT_MS', 30_000),
  defaultTimeoutMs: number('SOURCE_REQUEST_TIMEOUT_MS', 30_000),
});

export function runSourceRequest<T>(key: string, callback: (signal: AbortSignal) => Promise<T>, options: RequestOptions = {}): Promise<T> {
  const inherited = currentSourceRequest();
  return sourceRequestQueue.run(key, signal => withSourceRequests({ signal, priority: options.priority ?? inherited.priority }, () => callback(signal)),
    { ...inherited, ...options });
}

/** Combine transport deadlines with the scheduler/read-request cancellation signal. */
export function sourceRequestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const signals = [AbortSignal.timeout(timeoutMs), currentSourceRequest().signal, signal].filter((s): s is AbortSignal => !!s);
  return AbortSignal.any(signals);
}

/** Keep the public plugin interface unchanged while putting every registered operation behind the queue. */
export function scheduleSourceAdapter(adapter: SourceAdapter): SourceAdapter {
  const wrapped = Object.create(adapter) as SourceAdapter;
  // Forward metadata/state, preserving both object spreads and stateful/frozen plugin implementations.
  for (const key of Reflect.ownKeys(adapter)) {
    Object.defineProperty(wrapped, key, { configurable: true, enumerable: Object.getOwnPropertyDescriptor(adapter, key)?.enumerable,
      get: () => Reflect.get(adapter, key, adapter), set: value => { Reflect.set(adapter, key, value, adapter); } });
  }
  for (const method of ['search', 'getSeries', 'listChapters', 'getPageUrls', 'latest', 'popular'] as const) {
    const callback = adapter[method];
    if (typeof callback !== 'function') continue;
    Object.defineProperty(wrapped, method, { enumerable: true, configurable: true, value: (...args: unknown[]) =>
      runSourceRequest(adapter.id, () => (callback as (...args: unknown[]) => Promise<unknown>).apply(adapter, args),
        { timeoutMs: adapter.requiresCloudflare ? 95_000 : undefined }) });
  }
  return wrapped;
}
