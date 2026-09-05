import { createApp } from './app.mjs';
import { NetworkBroker } from './network.mjs';
const allowedOrigins = process.env.NOVEL_ENGINE_ALLOWED_ORIGINS ? JSON.parse(process.env.NOVEL_ENGINE_ALLOWED_ORIGINS) : { royalroad: ['https://www.royalroadcdn.com', 'https://royalroadcdn.com'] };
const broker = new NetworkBroker({ allowedOrigins, solverUrl: process.env.FLARESOLVERR_URL || '' });
const app = await createApp({ logger: true, broker, deadlineMs: broker.solverUrl ? 80_000 : 20_000, concurrency: Number(process.env.NOVEL_ENGINE_CONCURRENCY || 2) });
await app.listen({ host: process.env.HOST || '0.0.0.0', port: Number(process.env.PORT || 4100) });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
