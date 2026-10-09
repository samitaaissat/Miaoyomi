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

test('metadata deadline failures remain retryable while genuine capability failures remain unsupported',async()=>{
  const registry=new Registry();
  registry.entries=new Map([['fixture',{
    script:'exports.default={get filters(){while(true){}}};',
    source:{id:'fixture',enabled:true,supported:true},
  }]]);
  await assert.rejects(registry.get('fixture',{deadlineMs:100}),error=>error.code==='DEADLINE');
  assert.equal(registry.entry('fixture').source.supported,true);
  assert.equal(registry.entry('fixture').source.reason,undefined);
  registry.entry('fixture').script='exports.default={filters:{recovered:true}};';
  assert.deepEqual((await registry.get('fixture')).filters,{recovered:true});
  delete registry.entry('fixture').source.filters;
  registry.entry('fixture').script='exports.default={get filters(){return require("fs");}};';
  const unsupported=await registry.get('fixture');
  assert.equal(unsupported.supported,false);
  assert.ok(unsupported.reason);
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
