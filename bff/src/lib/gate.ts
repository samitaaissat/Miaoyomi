// Per-key concurrency gate with a politeness delay between starts.
//
// Every download path funnels through downloadChapter, and each "add a series" spawns its own detached
// background loop. The active work was already bounded, but the waiting arrays were not: a large import
// could retain thousands of closures indefinitely. Bound and expire waiters without adding another global
// active-work limit; outbound HTTP has its own shared scheduler.
import { RequestQueueError } from './requestQueue';

interface Waiter {
  resolve: () => void;
  reject: (error: GateError) => void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface Lane {
  active: number;
  queue: Waiter[];
  nextFreeAt: number;
  concurrency: number;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

export type GateErrorCode = 'queue_full' | 'queue_timeout' | 'queue_aborted';

/** Gate-specific context with the shared queue error contract used by routes and health classification. */
export class GateError extends RequestQueueError {
  constructor(readonly gateCode: GateErrorCode, message: string, ms?: number) {
    super(gateCode === 'queue_full' ? 'QUEUE_FULL' : gateCode === 'queue_timeout' ? 'QUEUE_TIMEOUT' : 'CANCELLED', message, ms);
    this.name = 'GateError';
  }
}

const DEFAULT_PENDING_PER_KEY = 32;
const DEFAULT_PENDING_TOTAL = 256;
const DEFAULT_WAIT_MS = 30_000;

const lanes = new Map<string, Lane>();
let totalQueued = 0;

const finiteInt = (value: number | undefined, fallback: number, minimum: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : fallback;

const laneOf = (key: string, concurrency: number): Lane => {
  let lane = lanes.get(key);
  if (!lane) {
    lane = { active: 0, queue: [], nextFreeAt: 0, concurrency };
    lanes.set(key, lane);
  } else {
    if (lane.cleanupTimer) clearTimeout(lane.cleanupTimer);
    lane.cleanupTimer = undefined;
    // A drained lane may remain briefly to preserve its start gap. Its next operation can choose a new
    // concurrency; an in-use lane keeps the capacity that admitted its existing work.
    if (lane.active === 0 && lane.queue.length === 0) lane.concurrency = concurrency;
  }
  return lane;
};

const cleanupWaiter = (waiter: Waiter): void => {
  if (waiter.timer) clearTimeout(waiter.timer);
  if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
};

const cleanupLane = (key: string, lane: Lane): void => {
  if (lane.active || lane.queue.length || lanes.get(key) !== lane) return;
  const wait = lane.nextFreeAt - Date.now();
  if (wait <= 0) {
    lanes.delete(key);
    return;
  }
  lane.cleanupTimer = setTimeout(() => {
    if (!lane.active && !lane.queue.length && lanes.get(key) === lane) lanes.delete(key);
  }, wait);
  lane.cleanupTimer.unref?.();
};

const releaseNext = (key: string, lane: Lane): void => {
  const waiter = lane.queue.shift();
  if (!waiter) {
    cleanupLane(key, lane);
    return;
  }
  totalQueued--;
  cleanupWaiter(waiter);
  // Reserve the slot before resolving. A new caller cannot slip into the apparent gap between resolve()
  // and the queued continuation and make active exceed the lane capacity.
  lane.active++;
  waiter.resolve();
};

const rejectQueued = (key: string, lane: Lane, waiter: Waiter, error: GateError): void => {
  const index = lane.queue.indexOf(waiter);
  if (index < 0) return;
  lane.queue.splice(index, 1);
  totalQueued--;
  cleanupWaiter(waiter);
  waiter.reject(error);
  cleanupLane(key, lane);
};

const acquire = async (
  key: string,
  lane: Lane,
  signal: AbortSignal | undefined,
  maxPendingPerKey: number,
  maxPendingTotal: number,
  maxWaitMs: number,
): Promise<void> => {
  if (signal?.aborted) throw new GateError('queue_aborted', `Gate wait for ${key} was aborted`);
  if (lane.active < lane.concurrency) {
    lane.active++;
    return;
  }
  if (lane.queue.length >= maxPendingPerKey || totalQueued >= maxPendingTotal) {
    throw new GateError('queue_full', `Gate queue is full for ${key}`);
  }

  await new Promise<void>((resolve, reject) => {
    const waiter: Waiter = { resolve, reject, signal };
    waiter.onAbort = () => rejectQueued(
      key, lane, waiter, new GateError('queue_aborted', `Gate wait for ${key} was aborted`),
    );
    if (signal) signal.addEventListener('abort', waiter.onAbort, { once: true });
    waiter.timer = setTimeout(() => rejectQueued(
      key, lane, waiter, new GateError('queue_timeout', `Gate wait for ${key} exceeded ${maxWaitMs}ms`, maxWaitMs),
    ), maxWaitMs);
    waiter.timer.unref?.();
    lane.queue.push(waiter);
    totalQueued++;
  });
};

const waitWithSignal = (ms: number, signal: AbortSignal | undefined, key: string): Promise<void> => {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
    const aborted = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      reject(new GateError('queue_aborted', `Gate wait for ${key} was aborted`));
    };
    function done() {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    if (signal?.aborted) aborted();
    else signal?.addEventListener('abort', aborted, { once: true });
  });
};

export interface GateOptions {
  /** how many operations may run at once for this key */
  concurrency?: number;
  /** minimum gap between the start of one operation and the next, per key */
  minGapMs?: number;
  /** maximum queued operations retained for this key (default 32) */
  maxPendingPerKey?: number;
  /** maximum queued operations retained across every key (default 256) */
  maxPendingTotal?: number;
  /** maximum time before `fn` starts, including politeness spacing (default 30 seconds) */
  maxWaitMs?: number;
  /** cancels this operation while it is waiting; running `fn` is left to its own cancellation policy */
  signal?: AbortSignal;
}

/** Run `fn` under the gate for `key`, waiting for a slot and for the politeness gap. */
export async function withGate<T>(key: string, fn: () => Promise<T>, opts: GateOptions = {}): Promise<T> {
  const concurrency = finiteInt(opts.concurrency, 2, 1);
  const minGapMs = finiteInt(opts.minGapMs, 0, 0);
  const maxPendingPerKey = finiteInt(opts.maxPendingPerKey, DEFAULT_PENDING_PER_KEY, 0);
  const maxPendingTotal = finiteInt(opts.maxPendingTotal, DEFAULT_PENDING_TOTAL, 0);
  const maxWaitMs = finiteInt(opts.maxWaitMs, DEFAULT_WAIT_MS, 0);
  const deadline = Date.now() + maxWaitMs;
  if (opts.signal?.aborted) throw new GateError('queue_aborted', `Gate wait for ${key} was aborted`);
  const lane = laneOf(key, concurrency);

  await acquire(key, lane, opts.signal, maxPendingPerKey, maxPendingTotal, maxWaitMs);
  try {
    if (opts.signal?.aborted) throw new GateError('queue_aborted', `Gate wait for ${key} was aborted`);
    if (minGapMs) {
      // Reserve start times synchronously. With concurrency >1, independent sleepers otherwise wake at the
      // same instant and violate the very gap this gate promises.
      const prior = lane.nextFreeAt;
      const startAt = Math.max(Date.now(), prior);
      const reservedUntil = startAt + minGapMs;
      lane.nextFreeAt = reservedUntil;
      const wait = startAt - Date.now();
      if (wait > Math.max(0, deadline - Date.now())) {
        if (lane.nextFreeAt === reservedUntil) lane.nextFreeAt = prior;
        throw new GateError('queue_timeout', `Gate wait for ${key} exceeded ${maxWaitMs}ms`, maxWaitMs);
      }
      try {
        await waitWithSignal(wait, opts.signal, key);
      } catch (error) {
        if (lane.nextFreeAt === reservedUntil) lane.nextFreeAt = prior;
        throw error;
      }
    }
    return await fn();
  } finally {
    lane.active--;
    releaseNext(key, lane);
  }
}

/** Testing/introspection helper: how many operations are in flight or queued for a key. */
export function gateDepth(key: string): { active: number; queued: number } {
  const lane = lanes.get(key);
  return { active: lane?.active ?? 0, queued: lane?.queue.length ?? 0 };
}
