export type RequestPriority = 'interactive' | 'background';
export type RequestQueueCode = 'QUEUE_FULL' | 'QUEUE_TIMEOUT' | 'CANCELLED' | 'REQUEST_TIMEOUT' | 'QUEUE_CLOSED';

export class RequestQueueError extends Error {
  readonly statusCode: number;
  readonly selfTimeout: boolean;
  constructor(readonly code: RequestQueueCode, message: string, readonly ms?: number) {
    super(message);
    this.name = 'RequestQueueError';
    this.statusCode = code === 'REQUEST_TIMEOUT' ? 504 : 503;
    this.selfTimeout = code === 'REQUEST_TIMEOUT';
  }
}
export const isRequestQueueError = (error: unknown): error is RequestQueueError => error instanceof RequestQueueError;

export interface RequestQueueOptions {
  concurrency?: number;
  perKeyConcurrency?: number;
  maxQueued?: number;
  maxQueuedPerKey?: number;
  maxWaitMs?: number;
  defaultTimeoutMs?: number;
  agingMs?: number;
}
export interface RequestOptions { signal?: AbortSignal; timeoutMs?: number; priority?: RequestPriority }
const controls = new WeakMap<Promise<unknown>, (ms: number) => void>();
/** A source timeout applies to execution, after its scheduler slot has been acquired. */
export function setRequestTimeout(promise: Promise<unknown>, ms: number): boolean {
  const update = controls.get(promise);
  if (!update) return false;
  update(ms); return true;
}
interface Task {
  key: string;
  callback: (signal: AbortSignal) => Promise<unknown>;
  controller: AbortController;
  priority: RequestPriority;
  queuedAt: number;
  startedAt?: number;
  timeoutMs: number;
  timer?: NodeJS.Timeout;
  cleanup: () => void;
  finish: (succeeded: boolean, value: unknown) => void;
}

/** In-memory request scheduler. Slots remain occupied until underlying work really settles. */
export class RequestQueue {
  private readonly options: Required<RequestQueueOptions>;
  private readonly lanes = new Map<string, Task[]>();
  private readonly activeKeys = new Map<string, number>();
  private readonly active = new Set<Task>();
  private queued = 0;
  private closed = false;

  constructor(options: RequestQueueOptions = {}) {
    this.options = { concurrency: 4, perKeyConcurrency: 2, maxQueued: 128, maxQueuedPerKey: 32,
      maxWaitMs: 30_000, defaultTimeoutMs: 30_000, agingMs: 5_000, ...options };
    for (const [name, value] of Object.entries(this.options)) {
      if (!Number.isSafeInteger(value) || value < (name.startsWith('maxQueued') ? 0 : 1)) throw Error(`Invalid request queue ${name}`);
    }
  }

  snapshot() { return { active: this.active.size, queued: this.queued, closed: this.closed, ...this.options }; }

  run<T>(key: string, callback: (signal: AbortSignal) => Promise<T>, options: RequestOptions = {}): Promise<T> {
    if (this.closed) return Promise.reject(new RequestQueueError('QUEUE_CLOSED', 'Request queue is shutting down.'));
    if (options.signal?.aborted) return Promise.reject(new RequestQueueError('CANCELLED', 'Request cancelled.'));
    const timeoutMs = options.timeoutMs ?? this.options.defaultTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return Promise.reject(Error('Invalid request timeout'));
    // pump() already starts eligible queued work; remaining lanes are waiting on their own key limit.
    const ready = this.active.size < this.options.concurrency && (this.activeKeys.get(key) || 0) < this.options.perKeyConcurrency;
    if (!ready && (this.queued >= this.options.maxQueued || (this.lanes.get(key)?.length || 0) >= this.options.maxQueuedPerKey)) {
      return Promise.reject(new RequestQueueError('QUEUE_FULL', 'Request queue is full. Retry shortly.'));
    }
    let task!: Task;
    const promise = new Promise<T>((resolve, reject) => {
      let settled = false;
      const abort = () => this.cancel(task, new RequestQueueError('CANCELLED', 'Request cancelled.'));
      task = {
        key, callback, controller: new AbortController(), priority: options.priority ?? 'interactive', queuedAt: Date.now(), timeoutMs,
        cleanup: () => { clearTimeout(task.timer); options.signal?.removeEventListener('abort', abort); },
        finish: (succeeded, value) => {
          if (settled) return;
          settled = true; task.cleanup();
          succeeded ? resolve(value as T) : reject(value);
        },
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      if (ready) this.start(task);
      else {
        const lane = this.lanes.get(key) || [];
        lane.push(task); this.lanes.set(key, lane); this.queued++;
        task.timer = setTimeout(() => this.cancel(task, new RequestQueueError('QUEUE_TIMEOUT', 'Request expired while waiting for capacity. Retry shortly.')), this.options.maxWaitMs);
        this.pump();
      }
    });
    controls.set(promise, ms => {
      if (!Number.isSafeInteger(ms) || ms < 1) throw Error('Invalid request timeout');
      task.timeoutMs = ms;
      if (this.active.has(task) && !task.controller.signal.aborted) this.armDeadline(task);
    });
    return promise;
  }

  private cancel(task: Task, error: RequestQueueError) {
    const lane = this.lanes.get(task.key);
    const index = lane?.indexOf(task) ?? -1;
    if (lane && index >= 0) {
      lane.splice(index, 1); this.queued--;
      if (!lane.length) this.lanes.delete(task.key);
    }
    task.finish(false, error); task.controller.abort(error);
    this.pump();
  }

  private armDeadline(task: Task) {
    clearTimeout(task.timer);
    const remaining = task.timeoutMs - (Date.now() - task.startedAt!);
    task.timer = setTimeout(() => this.cancel(task,
      new RequestQueueError('REQUEST_TIMEOUT', `timeout after ${task.timeoutMs}ms`, task.timeoutMs)), Math.max(0, remaining));
  }

  private start(task: Task) {
    clearTimeout(task.timer);
    this.active.add(task); this.activeKeys.set(task.key, (this.activeKeys.get(task.key) || 0) + 1);
    task.startedAt = Date.now(); this.armDeadline(task);
    Promise.resolve().then(() => {
      task.controller.signal.throwIfAborted();
      return task.callback(task.controller.signal);
    }).then(value => task.finish(true, value), error => task.finish(false, error)).finally(() => {
      task.cleanup(); this.active.delete(task);
      const count = this.activeKeys.get(task.key)! - 1;
      if (count) this.activeKeys.set(task.key, count); else this.activeKeys.delete(task.key);
      this.pump();
    });
  }

  private pump() {
    if (this.closed) return;
    while (this.active.size < this.options.concurrency && this.queued) {
      let chosen: Task | undefined;
      const now = Date.now();
      for (const [key, lane] of this.lanes) {
        if ((this.activeKeys.get(key) || 0) >= this.options.perKeyConcurrency) continue;
        const aged = now - lane[0].queuedAt >= this.options.agingMs;
        const candidate = aged ? lane[0] : lane.find(task => task.priority === 'interactive') || lane[0];
        const chosenAged = chosen && now - chosen.queuedAt >= this.options.agingMs;
        if (!chosen || (aged && (!chosenAged || candidate.queuedAt < chosen.queuedAt)) ||
          (!aged && !chosenAged && candidate.priority === 'interactive' && chosen.priority === 'background')) chosen = candidate;
      }
      if (!chosen) return;
      const lane = this.lanes.get(chosen.key)!;
      lane.splice(lane.indexOf(chosen), 1); this.queued--;
      // Moving a served source to the end gives other eligible sources their turn.
      this.lanes.delete(chosen.key); if (lane.length) this.lanes.set(chosen.key, lane);
      this.start(chosen);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const error = new RequestQueueError('QUEUE_CLOSED', 'Request queue is shutting down.');
    for (const lane of this.lanes.values()) for (const task of lane) { task.finish(false, error); task.controller.abort(error); }
    this.lanes.clear(); this.queued = 0;
    for (const task of this.active) { task.finish(false, error); task.controller.abort(error); }
  }
}
