import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';
import { executePlugin } from '../src/executor.mjs';
import { TaskQueue } from '../src/task-queue.mjs';

const script = `exports.default={async parseNovel(path){
  const response=await require('@libs/fetch').fetchApi('https://fixture.example/'+path);
  const storage=require('@libs/storage').storage;
  const count=(storage.get('count')||0)+1;storage.set('count',count);
  return {body:await response.text(),count};
}};`;

async function harness(t, options = {}) {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const entries = new Map(['alpha', 'beta'].map(id => [id, { script, source: { id, site: 'https://fixture.example', enabled: true, supported: true } }]));
  const calls = [];
  const broker = { async fetch(source, url) {
    calls.push([source.id, url]);
    if (url.endsWith('/held')) { entered.resolve(); await release.promise; }
    return { status: 200, headers: {}, body: source.id, url };
  } };
  const app = await createApp({ token: 'test', registry: { active: id => entries.get(id) }, broker, ...options });
  t.after(async () => { release.resolve(); await app.close(); });
  const invoke = (sourceId, path) => app.inject({ method: 'POST', url: '/v1/invoke', headers: { authorization: 'Bearer test' }, payload: { sourceId, method: 'parseNovel', args: [path] } });
  return { app, invoke, entered, release, calls };
}

test('a burst waits for an engine worker instead of rejecting the next source', async t => {
  const h = await harness(t, { concurrency: 1 });
  const first = h.invoke('alpha', 'held');
  await h.entered.promise;
  const second = h.invoke('beta', 'next');
  h.release.resolve();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(r => r.statusCode), [200, 200], results.map(r => r.body).join('\n'));
  assert.deepEqual(results.map(r => r.json().result.body), ['alpha', 'beta']);
});

test('same-source requests serialize their storage while other sources can run', async t => {
  const h = await harness(t, { concurrency: 2 });
  const first = h.invoke('alpha', 'held');
  await h.entered.promise;
  const queued = h.invoke('alpha', 'next');
  const other = await h.invoke('beta', 'other');
  assert.equal(other.statusCode, 200, other.body);
  assert.ok(!h.calls.some(([id, url]) => id === 'alpha' && url.endsWith('/next')));
  h.release.resolve();
  const results = await Promise.all([first, queued]);
  assert.deepEqual(results.map(r => r.statusCode), [200, 200], results.map(r => r.body).join('\n'));
  assert.deepEqual(results.map(r => r.json().result.count), [1, 2]);
});

test('caller cancellation terminates the worker and aborts its network request', async () => {
  const started = Promise.withResolvers();
  const controller = new AbortController();
  let transportSignal;
  const work = executePlugin(script, 'parseNovel', ['held'], { signal: controller.signal, deadlineMs: 10_000,
    fetch: async (_url, _init, signal) => { transportSignal = signal; started.resolve(); return new Promise(() => {}); },
  });
  await started.promise;
  controller.abort();
  await assert.rejects(work, error => error.code === 'DEADLINE' && /cancel/i.test(error.message));
  assert.equal(transportSignal.aborted, true);
});

test('an HTTP client disconnect releases its worker for the next request', async t => {
  const h = await harness(t, { concurrency: 1, deadlineMs: 10_000, queueTimeoutMs: 5_000 });
  const address = await h.app.listen({ host: '127.0.0.1', port: 0 });
  const controller = new AbortController();
  const first = fetch(address + '/v1/invoke', {
    method: 'POST', signal: controller.signal,
    headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
    body: JSON.stringify({ sourceId: 'alpha', method: 'parseNovel', args: ['held'] }),
  });
  await h.entered.promise;
  controller.abort();
  await assert.rejects(first, error => error.name === 'AbortError');
  const next = await h.invoke('beta', 'next');
  assert.equal(next.statusCode, 200, next.body);
  assert.equal(next.json().result.body, 'beta');
});

test('a full queue rejects excess work and cancelled waiting work never executes', async () => {
  const queue = new TaskQueue({ concurrency: 1, queueLimit: 1 });
  const release = Promise.withResolvers();
  const first = queue.run(() => release.promise);
  const controller = new AbortController();
  let cancelledRan = false;
  const queued = queue.run(() => { cancelledRan = true; }, { signal: controller.signal });
  await assert.rejects(queue.run(() => assert.fail('Excess work ran')), error => error.code === 'ENGINE_BUSY' && error.status === 503);
  controller.abort();
  await assert.rejects(queued, error => error.code === 'DEADLINE');
  const replacement = queue.run(() => 'replacement');
  release.resolve();
  await first;
  assert.equal(await replacement, 'replacement');
  assert.equal(cancelledRan, false);
});

test('waiting requests expire without occupying a worker or running later', async () => {
  const queue = new TaskQueue({ concurrency: 1, queueTimeoutMs: 20 });
  const release = Promise.withResolvers();
  const first = queue.run(() => release.promise);
  let expiredRan = false;
  await assert.rejects(queue.run(() => { expiredRan = true; }), error => error.code === 'DEADLINE' && /waiting/.test(error.message));
  release.resolve();
  await first;
  assert.equal(await queue.run(() => 'ready'), 'ready');
  assert.equal(expiredRan, false);
});
