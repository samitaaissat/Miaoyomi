import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry, capabilityReason } from '../src/registry.mjs';

test('timer APIs no longer disqualify a source, while unavailable browser capabilities still do', () => {
  assert.equal(capabilityReason('setTimeout(resolve, 100); clearTimeout(id); setInterval(tick, 100); clearInterval(id);', {}), undefined);
  assert.match(capabilityReason('setTimeout(resolve, 100); new WebSocket(url);', {}), /WebSocket/);
  assert.match(capabilityReason('require("fs")', {}), /Unsupported module/);
});

test('the conventional AJAX request header does not imply use of the browser XMLHttpRequest API', () => {
  const request = `fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });`;
  assert.equal(capabilityReason(request, {}), undefined);
  assert.match(capabilityReason(request + 'new XMLHttpRequest();', {}), /XMLHttpRequest/);
});

test('pinned timer-dependent sources expose metadata and can be activated', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'novel-timers-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const registry = await Registry.open({ stateDir });
  for (const id of ['novelbin', 'lightnovelvf', 'readnovelfull']) {
    const source = await registry.get(id);
    assert.equal(source.supported, true, `${id}: ${source.reason}`);
    assert.equal((await registry.enable(id, true)).enabled, true);
    assert.equal(registry.active(id).source.id, id);
  }
});
