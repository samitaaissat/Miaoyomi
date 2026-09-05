import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { executePlugin } from './executor.mjs';
import { EngineError } from './errors.mjs';
import { applySourceCompatibility } from './source-compatibility.mjs';
const modules = new Set(['cheerio', 'htmlparser2', 'dayjs', '@libs/fetch', '@libs/storage', '@libs/novelStatus', '@libs/defaultCover', '@libs/isAbsoluteUrl', '@libs/filterInputs', '@/types/constants']);
export function capabilityReason(script, entry) {
  for (const match of script.matchAll(/require\(["']([^"']+)["']\)/g)) if (!modules.has(match[1])) return `Unsupported module: ${match[1]}`;
  if (entry.customJS || /\b(?:webStorageUtilized|customJS)\b/.test(script)) return 'Browser storage or custom JavaScript requires an unsupported browser host';
  // This conventional fetch header is data, not a browser API dependency.
  const capabilities = script.replace(/(['"])X-Requested-With\1\s*:\s*(['"])XMLHttpRequest\2/gi, '');
  const missing = /\b(TextDecoder|TextEncoder|XMLHttpRequest|WebSocket|fetchProto|fetchFile)\b/.exec(capabilities);
  if (missing) return `Unsupported host capability: ${missing[1]}`;
}
export class Registry {
  static async open({ stateDir = process.env.NOVEL_ENGINE_STATE_DIR || './state', vendorDir = new URL('../vendor/', import.meta.url) } = {}) {
    const registry = new Registry(); Object.assign(registry, { stateDir, vendorDir, entries: new Map(), state: {}, writeQueue: Promise.resolve() });
    await mkdir(stateDir, { recursive: true });
    try { registry.state = JSON.parse(await readFile(join(stateDir, 'sources.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const manifest = JSON.parse(await readFile(new URL('registry.json', vendorDir), 'utf8'));
    for (const entry of manifest.sources) {
      if (!/^[a-zA-Z0-9_. -]+$/.test(entry.id)) throw Error('Invalid pinned source ID');
      const publishedScript = await readFile(new URL(`scripts/${entry.id}.js`, vendorDir), 'utf8');
      const digest = createHash('sha256').update(publishedScript).digest('hex');
      const script = applySourceCompatibility(entry.id, publishedScript);
      const reason = digest !== entry.digest || (registry.state[entry.id]?.digest && registry.state[entry.id].digest !== digest) ? 'Pinned script digest mismatch; review the source update before activation' : capabilityReason(script, entry);
      registry.entries.set(entry.id, { script, digest, source: { id: entry.id, name: entry.name, lang: entry.lang, site: entry.site, version: entry.version, enabled: registry.state[entry.id]?.enabled === true, supported: !reason, ...(reason ? { reason } : {}), supportsLatest: /showLatestNovels/.test(script) } });
    }
    return registry;
  }
  entry(id) { const entry = this.entries.get(id); if (!entry) throw new EngineError('UNKNOWN_SOURCE', 'Unknown novel source', 404); return entry; }
  list() { return [...this.entries.values()].map(x => ({ ...x.source })); }
  async get(id) {
    const entry = this.entry(id);
    if (entry.source.supported && !entry.source.filters) {
      try {
        const metadata = await executePlugin(entry.script, '__metadata');
        entry.source.filters = metadata.filters;
        // Transport options stay private to the engine and still cross the guarded header policy.
        entry.imageRequestInit = metadata.imageRequestInit;
      }
      catch (error) { entry.source.supported = false; entry.source.reason = error.message; }
    }
    return { ...entry.source };
  }
  active(id) {
    const entry = this.entry(id);
    if (!entry.source.supported) throw new EngineError('UNSUPPORTED_CAPABILITY', entry.source.reason, 409);
    if (!entry.source.enabled) throw new EngineError('SOURCE_DISABLED', 'Novel source is disabled', 409);
    return entry;
  }
  async enable(id, enabled) {
    const source = await this.get(id); const entry = this.entry(id);
    if (enabled && !source.supported) throw new EngineError('UNSUPPORTED_CAPABILITY', source.reason, 409);
    const task = this.writeQueue.then(async () => {
      const next = { ...this.state, [id]: { enabled, digest: entry.digest } };
      const temporary = join(this.stateDir, `sources.${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(temporary, join(this.stateDir, 'sources.json'));
      this.state = next; entry.source.enabled = enabled;
      return { ...entry.source };
    });
    this.writeQueue = task.catch(() => {}); return task;
  }
}
