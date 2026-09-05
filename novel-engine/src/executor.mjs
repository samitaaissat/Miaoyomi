import { Worker } from 'node:worker_threads';
import { EngineError } from './errors.mjs';
export async function executePlugin(script, method, args = [], { fetch, deadlineMs = 20_000, memoryBytes, storageSnapshot, onStorage } = {}) {
  const controller = new AbortController();
  const worker = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: { script, method, args, deadlineMs, memoryBytes, storageSnapshot }, env: {}, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 } });
  let timeout; let settled = false;
  try {
    return await new Promise((resolve, reject) => {
      const finish = (error, value) => { if (settled) return; settled = true; error ? reject(error) : resolve(value); };
      timeout = setTimeout(() => finish(new EngineError('DEADLINE', 'Plugin worker deadline exceeded', 504)), deadlineMs);
      worker.on('error', error => finish(new EngineError('EXECUTOR_ERROR', error.message)));
      worker.on('exit', code => { if (!settled) finish(new EngineError('EXECUTOR_ERROR', `Plugin worker exited (${code})`)); });
      worker.on('message', async message => {
        if (settled) return;
        if (message.type === 'done') { onStorage?.(message.storage); return finish(null, message.result); }
        if (message.type === 'error') return finish(new EngineError(message.code, message.message, message.status));
        if (message.type !== 'fetch') return;
        try {
          if (!fetch) throw new EngineError('UNSUPPORTED_CAPABILITY', 'Network unavailable during metadata evaluation', 409);
          const result = await fetch(message.url, message.init, controller.signal);
          if (!settled) worker.postMessage({ id: message.id, result });
        } catch (error) { if (!settled) worker.postMessage({ id: message.id, error: { code: error.code || 'SOURCE_ERROR', message: error.message, status: error.status || 502 } }); }
      });
    });
  } finally { clearTimeout(timeout); controller.abort(); await worker.terminate(); }
}
