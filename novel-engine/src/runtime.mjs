import { getQuickJS } from 'quickjs-emscripten';
import { readFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { EngineError } from './errors.mjs';
let bundle;
export async function runPlugin(script, method, args = [], options = {}) {
  const QuickJS = await getQuickJS();
  bundle ??= await readFile(new URL('../dist/guest.js', import.meta.url), 'utf8');
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(options.memoryBytes ?? 64 * 1024 * 1024);
  runtime.setMaxStackSize(1024 * 1024);
  const deadline = Date.now() + (options.deadlineMs ?? 20_000);
  runtime.setInterruptHandler(() => Date.now() >= deadline);
  const vm = runtime.newContext();
  const controller = new AbortController();
  const pending = new Set(); let closed = false; let hostFailure;
  const deferred = new Set();
  // Timers are invocation-local guest callbacks, never Node timer objects. The
  // same bounded event loop handles timers and network promise jobs.
  const timers = new Map(); let timerSequence = 0;
  const clearTimer = id => {
    const timer = timers.get(id);
    if (timer) { timers.delete(id); timer.callback.dispose(); }
  };
  const check = result => {
    if (result.error) { const error = vm.dump(result.error); result.error.dispose(); throw new EngineError(Date.now() >= deadline ? 'DEADLINE' : error.code || 'SOURCE_ERROR', error.message || String(error), Date.now() >= deadline ? 504 : error.code === 'UNSUPPORTED_CAPABILITY' ? 409 : 502); }
    return result.value;
  };
  const host = vm.newFunction('__hostFetch', requestHandle => {
    const request = JSON.parse(vm.getString(requestHandle));
    const promise = vm.newPromise(); deferred.add(promise);
    const task = Promise.resolve().then(async () => {
      try {
        if (!options.fetch) throw new EngineError('UNSUPPORTED_CAPABILITY', 'Network is unavailable in metadata evaluation', 409);
        const result = await options.fetch(request.url, request.init, controller.signal);
        if (!closed) { const value = vm.newString(JSON.stringify(result)); promise.resolve(value); value.dispose(); }
      } catch (error) {
        hostFailure = error;
        if (!closed) { const value = vm.newString(JSON.stringify({ error: error.code || 'SOURCE_ERROR', message: error.message })); promise.resolve(value); value.dispose(); }
      }
    }).finally(() => pending.delete(task));
    pending.add(task);
    return promise.handle;
  });
  vm.setProp(vm.global, '__hostFetch', host); host.dispose();
  const setTimer = vm.newFunction('__hostSetTimer', (callback, delay, repeat) => {
    if (timers.size >= 1024) return vm.newNumber(0);
    const id = ++timerSequence; const milliseconds = vm.getNumber(delay);
    timers.set(id, { callback: callback.dup(), delay: milliseconds, repeat: vm.getNumber(repeat) === 1, due: Date.now() + milliseconds });
    return vm.newNumber(id);
  });
  const cancelTimer = vm.newFunction('__hostClearTimer', id => { clearTimer(vm.getNumber(id)); });
  vm.setProp(vm.global, '__hostSetTimer', setTimer); setTimer.dispose();
  vm.setProp(vm.global, '__hostClearTimer', cancelTimer); cancelTimer.dispose();
  try {
    check(vm.evalCode('globalThis.__storageSeed = ' + JSON.stringify(options.storageSnapshot || {}) + ';')).dispose();
    check(vm.evalCode(bundle, 'host-library-bundle.js')).dispose();
    check(vm.evalCode(script, 'published-plugin.js')).dispose();
    const call = `globalThis.__result = undefined; globalThis.__failure = undefined; globalThis.__done = false;
    Promise.resolve().then(() => {
      const plugin = module.exports.default || exports.default;
      if (!plugin) throw new Error('Plugin has no default export');
      const method = ${JSON.stringify(method)}; const args = ${JSON.stringify(args)};
      if (method === '__metadata') return { filters: plugin.filters || {}, imageRequestInit: plugin.imageRequestInit, supportsLatest: !!plugin.popularNovels, methods: ['popularNovels','searchNovels','parseNovel','parsePage','parseChapter','resolveUrl'].filter(m => typeof plugin[m] === 'function') };
      if (typeof plugin[method] !== 'function') throw Object.assign(new Error('Plugin does not support method ' + method), {code:'UNSUPPORTED_CAPABILITY'});
      if (method === 'popularNovels') { args[1] = args[1] || {}; args[1].filters = Object.assign({}, plugin.filters || {}, args[1].filters || {}); }
      return plugin[method](...args);
    }).then(value => { __result = JSON.stringify(value === undefined ? null : value); __done = true; }, error => { __failure = JSON.stringify({message: String(error.message || error), code:error.code}); __done = true; });`;
    check(vm.evalCode(call, 'invoke.js')).dispose();
    while (true) {
      if (Date.now() >= deadline) throw new EngineError('DEADLINE', 'Plugin deadline exceeded', 504);
      const jobs = runtime.executePendingJobs();
      if (jobs.error) { const error = vm.dump(jobs.error); jobs.error.dispose(); throw new EngineError(Date.now() >= deadline ? 'DEADLINE' : 'SOURCE_ERROR', error.message, Date.now() >= deadline ? 504 : 502); }
      const done = vm.getProp(vm.global, '__done'); const finished = vm.dump(done); done.dispose();
      if (finished) break;
      let next;
      for (const [id, timer] of timers) if (!next || timer.due < next.timer.due) next = { id, timer };
      if (next && next.timer.due <= Date.now()) {
        // Retain a separate handle while running: an interval may cancel itself.
        const callback = next.timer.callback.dup();
        if (next.timer.repeat) next.timer.due = Date.now() + next.timer.delay;
        else clearTimer(next.id);
        try { check(vm.callFunction(callback, vm.global)).dispose(); }
        finally { callback.dispose(); }
        // A busy interval must not starve the host's network event loop.
        await pause(0);
        // Drain promise jobs after each callback, before another timer fires.
        continue;
      }
      await Promise.race([...pending, pause(5)]);
    }
    if (hostFailure) throw hostFailure;
    const failureHandle = vm.getProp(vm.global, '__failure'); const failure = vm.dump(failureHandle); failureHandle.dispose();
    if (failure) { const e = JSON.parse(failure); throw new EngineError(e.code || 'SOURCE_ERROR', e.message, e.code === 'UNSUPPORTED_CAPABILITY' ? 409 : 502); }
    const handle = vm.getProp(vm.global, '__result'); const result = vm.getString(handle); handle.dispose();
    if (result.length > 8 * 1024 * 1024) throw new EngineError('RESPONSE_LIMIT', 'Plugin output exceeds 8 MiB');
    if (!options.captureStorage) return JSON.parse(result);
    const snapshot = check(vm.evalCode('JSON.stringify(__exportStorage())'));
    const serialized = vm.getString(snapshot); snapshot.dispose();
    if (serialized.length > 256 * 1024) throw new EngineError('STORAGE_LIMIT', 'Plugin KV exceeds 256 KiB');
    return { result: JSON.parse(result), storage: JSON.parse(serialized) };
  } finally {
    closed = true; controller.abort();
    for (const id of timers.keys()) clearTimer(id);
    for (const promise of deferred) promise.dispose();
    vm.dispose(); runtime.dispose();
  }
}
