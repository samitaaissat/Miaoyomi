import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { runPlugin } from '../src/runtime.mjs';

const invoke = (body, options = {}) => runPlugin(`exports.default = { async parseNovel() { ${body} } };`, 'parseNovel', [], options);

test('guest timeout waits for its delay and preserves callback arguments inside the isolate', async () => {
  const result = await invoke(`
    const started = Date.now();
    return await new Promise(resolve => setTimeout(function (first, second) {
      resolve([Date.now() - started, first, second, this === globalThis, typeof process, typeof Buffer]);
    }, 40, 'delayed', 7));
  `);
  assert.ok(result[0] >= 40, `timeout fired after ${result[0]} ms`);
  assert.deepEqual(result.slice(1), ['delayed', 7, true, 'undefined', 'undefined']);
});

test('timer callbacks run after promises and drain their own promise jobs before the next timer', async () => {
  const result = await invoke(`
    const order = [];
    setTimeout(() => {
      order.push('first timer');
      Promise.resolve().then(() => order.push('timer promise'));
    }, 0);
    const done = new Promise(resolve => setTimeout(() => { order.push('second timer'); resolve(order); }, 0));
    Promise.resolve().then(() => order.push('initial promise'));
    return await done;
  `);
  assert.deepEqual(result, ['initial promise', 'first timer', 'timer promise', 'second timer']);
});

test('timeout and interval cancellation share IDs and a repeating callback can cancel itself', async () => {
  const result = await invoke(`
    let cancelled = 0;
    clearInterval(setTimeout(() => cancelled++, 1));
    clearTimeout(setInterval(() => cancelled++, 1));
    clearTimeout(-1); clearInterval(undefined);
    const ticks = [];
    await new Promise(resolve => {
      const id = setInterval(value => {
        ticks.push(value);
        if (ticks.length === 3) { clearInterval(id); resolve(); }
      }, 5, 'tick');
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    return [cancelled, ticks];
  `);
  assert.deepEqual(result, [0, ['tick', 'tick', 'tick']]);
});

test('nested timer callbacks can wait for guarded guest fetches', async () => {
  const result = await invoke(`
    return await new Promise(resolve => setTimeout(() => setTimeout(async () => {
      resolve(await (await fetch('https://fixture.example/timer')).text());
    }, 5), 5));
  `, { fetch: async url => ({ status: 200, url, headers: {}, body: 'timer fetch result' }) });
  assert.equal(result, 'timer fetch result');
});

test('busy repeating timers still yield to outstanding network operations', async () => {
  const result = await invoke(`
    const id = setInterval(() => {
      const until = Date.now() + 5;
      while (Date.now() < until) {}
    }, 1);
    const response = await fetch('https://fixture.example/delayed');
    clearInterval(id);
    return await response.text();
  `, { deadlineMs: 500, fetch: async url => {
    await pause(30);
    return { status: 200, url, headers: {}, body: 'network completed' };
  } });
  assert.equal(result, 'network completed');
});

test('completion disposes outstanding timeout and interval callbacks without waiting for them', async () => {
  const result = await invoke(`
    setTimeout(() => { throw new Error('late timeout'); }, 60000);
    setInterval(() => { throw new Error('late interval'); }, 60000);
    return 'finished';
  `, { deadlineMs: 1000 });
  assert.equal(result, 'finished');
  assert.equal(await invoke('return 7;'), 7);
});

test('waiting timers cannot outlive the invocation deadline or fire early to avoid it', async () => {
  await assert.rejects(invoke(`
    setInterval(() => {}, 60000);
    await new Promise(resolve => setTimeout(resolve, 60000));
  `, { deadlineMs: 100 }), error => error.code === 'DEADLINE' && error.status === 504);
});

test('runaway timer callbacks remain subject to the QuickJS deadline', async () => {
  await assert.rejects(invoke(`
    await new Promise(resolve => setTimeout(() => { while (true) {} }, 1));
  `, { deadlineMs: 100 }), error => error.code === 'DEADLINE' && error.status === 504);
});

test('callback errors reject the invocation and dispose other scheduled callbacks', async () => {
  await assert.rejects(invoke(`
    setInterval(() => {}, 60000);
    await new Promise(resolve => setTimeout(() => { throw new Error('timer failure'); }, 1));
  `), error => error.code === 'SOURCE_ERROR' && error.message === 'timer failure');
});

test('timer allocation is bounded before an untrusted plugin can retain an unbounded host queue', async () => {
  await assert.rejects(invoke(`
    for (let i = 0; i < 10000; i++) setTimeout(() => {}, 60000);
  `), error => error.code === 'TIMER_LIMIT');
});

test('clearing callbacks releases capacity for later timers', async () => {
  assert.equal(await invoke(`
    for (let i = 0; i < 2000; i++) clearTimeout(setTimeout(() => {}, 60000));
    return await new Promise(resolve => setTimeout(resolve, 1, 'released'));
  `), 'released');
});

test('timer APIs accept callable callbacks only', async () => {
  for (const api of ['setTimeout', 'setInterval']) {
    await assert.rejects(invoke(`${api}('return 7', 1);`), error => error.code === 'SOURCE_ERROR' && /function/i.test(error.message));
  }
});
