import { parentPort, workerData } from 'node:worker_threads';
import { runPlugin } from './runtime.mjs';
import { EngineError } from './errors.mjs';
const pending = new Map(); let sequence = 0;
parentPort.on('message', message => {
  const promise = pending.get(message.id); if (!promise) return; pending.delete(message.id);
  message.error ? promise.reject(new EngineError(message.error.code, message.error.message, message.error.status)) : promise.resolve(message.result);
});
try {
  const result = await runPlugin(workerData.script, workerData.method, workerData.args, {
    deadlineMs: workerData.deadlineMs, memoryBytes: workerData.memoryBytes, captureStorage: true, storageSnapshot: workerData.storageSnapshot,
    fetch: (url, init) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); parentPort.postMessage({ type: 'fetch', id, url, init }); }),
  });
  parentPort.postMessage({ type: 'done', ...result });
} catch (error) { parentPort.postMessage({ type: 'error', code: error.code || 'SOURCE_ERROR', message: error.message, status: error.status || 502 }); }
