import { createApp } from './app.mjs';
import { NetworkBroker } from './network.mjs';
const integer = (name, fallback) => {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value <= 0) throw Error(`${name} must be a positive integer`);
  return value;
};
const builtInAllowedOrigins = {
  royalroad: ['https://www.royalroadcdn.com', 'https://royalroadcdn.com'],
};
const allowedOrigins = { ...builtInAllowedOrigins, ...(process.env.NOVEL_ENGINE_ALLOWED_ORIGINS ? JSON.parse(process.env.NOVEL_ENGINE_ALLOWED_ORIGINS) : {}) };
const broker = new NetworkBroker({
  allowedOrigins,
  solverUrl: process.env.FLARESOLVERR_URL || '',
  solverConcurrency: integer('NOVEL_SOLVER_CONCURRENCY', 2),
  solverQueueLimit: integer('NOVEL_SOLVER_QUEUE_LIMIT', 32),
  solverQueueTimeoutMs: integer('NOVEL_SOLVER_QUEUE_TIMEOUT_MS', 30_000),
  solverSessionLimit: integer('NOVEL_SOLVER_SESSION_LIMIT', 4),
  solverSessionIdleMs: integer('NOVEL_SOLVER_SESSION_IDLE_MS', 600_000),
  solverSessionTtlMinutes: integer('NOVEL_SOLVER_SESSION_TTL_MINUTES', 15),
});
const app = await createApp({
  logger: true, broker, deadlineMs: broker.solverUrl ? 110_000 : 20_000,
  concurrency: integer('NOVEL_ENGINE_CONCURRENCY', 4),
  queueLimit: integer('NOVEL_ENGINE_QUEUE_LIMIT', 32),
  queueTimeoutMs: integer('NOVEL_ENGINE_QUEUE_TIMEOUT_MS', 30_000),
});
await app.listen({ host: process.env.HOST || '0.0.0.0', port: Number(process.env.PORT || 4100) });
let closing;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  closing ??= (async () => { await app.close(); await broker.close(); process.exit(0); })();
});
