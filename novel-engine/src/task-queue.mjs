import { EngineError } from './errors.mjs';

export class TaskQueue {
  #active = 0;
  #keys = new Set();
  #pending = [];

  constructor({ concurrency = 4, queueLimit = 32, queueTimeoutMs = 30_000 } = {}) {
    for (const [name, value, minimum] of [['concurrency', concurrency, 1], ['queueLimit', queueLimit, 0], ['queueTimeoutMs', queueTimeoutMs, 1]]) {
      if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${name}`);
    }
    Object.assign(this, { concurrency, queueLimit, queueTimeoutMs });
  }

  run(callback, { key, signal } = {}) {
    if (signal?.aborted) return Promise.reject(this.#cancelled());
    const available = this.#active < this.concurrency && (key === undefined || !this.#keys.has(key));
    if (!available && this.#pending.length >= this.queueLimit) {
      return Promise.reject(new EngineError('ENGINE_BUSY', 'Novel engine request queue is full; retry shortly', 503));
    }
    return new Promise((resolve, reject) => {
      const task = { callback, key, signal, resolve, reject, cleanup() {} };
      if (available) return this.#start(task);
      const remove = error => {
        const index = this.#pending.indexOf(task);
        if (index < 0) return;
        this.#pending.splice(index, 1);
        task.cleanup();
        reject(error);
      };
      const abort = () => remove(this.#cancelled());
      const timer = setTimeout(() => remove(new EngineError('DEADLINE', 'Novel engine request timed out waiting for a worker', 504)), this.queueTimeoutMs);
      task.cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      this.#pending.push(task);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  #cancelled() { return new EngineError('DEADLINE', 'Novel engine request cancelled', 504); }

  #start(task) {
    task.cleanup();
    this.#active++;
    if (task.key !== undefined) this.#keys.add(task.key);
    Promise.resolve().then(() => {
      if (task.signal?.aborted) throw this.#cancelled();
      return task.callback();
    }).then(task.resolve, task.reject).finally(() => {
      this.#active--;
      if (task.key !== undefined) this.#keys.delete(task.key);
      // A source waiting on its own worker must not block unrelated sources.
      while (this.#active < this.concurrency) {
        const index = this.#pending.findIndex(item => item.key === undefined || !this.#keys.has(item.key));
        if (index < 0) break;
        this.#start(this.#pending.splice(index, 1)[0]);
      }
    });
  }
}
