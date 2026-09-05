import test from 'node:test';
import assert from 'node:assert/strict';
import { executePlugin } from '../src/executor.mjs';
test('hard deadline terminates runaway worker while HTTP event loop stays responsive', async () => {
  let ticks = 0; const timer = setInterval(() => ticks++, 5);
  try { await assert.rejects(executePlugin('exports.default={parseNovel(){while(true){}}}', 'parseNovel', [], { deadlineMs: 300 }), e => e.code === 'DEADLINE'); }
  finally { clearInterval(timer); }
  assert.ok(ticks > 10, `main loop ticked ${ticks} times`);
});
test('isolated worker forwards guest fetch through host broker and returns parsed data', async () => {
  const result = await executePlugin('exports.default={async parseNovel(){const r=await require("@libs/fetch").fetchApi("https://fixture.example/");return JSON.parse(await r.text())}}', 'parseNovel', [], { fetch: async url => ({ body: '{"name":"Worker fixture"}', status: 200, url, headers: {} }) });
  assert.deepEqual(result, { name: 'Worker fixture' });
});
test('plugin KV snapshot can be reused without crossing invocation source state', async () => {
  let snapshot;
  const script = 'exports.default={parseNovel(){const s=require("@libs/storage").storage; const old=s.get("last")||0;s.set("last",old+1);return old+1}}';
  assert.equal(await executePlugin(script,'parseNovel',[],{onStorage:value=>{snapshot=value}}),1);
  assert.equal(await executePlugin(script,'parseNovel',[],{storageSnapshot:snapshot}),2);
  assert.equal(await executePlugin(script,'parseNovel',[]),1);
});
test('worker does not inherit entrypoint-only Node flags', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const executor = new URL('../src/executor.mjs',import.meta.url).href;
  const {stdout} = await promisify(execFile)(process.execPath,['--input-type=module','--eval',`import {executePlugin} from ${JSON.stringify(executor)}; console.log(await executePlugin('exports.default={parseNovel:()=>7}', 'parseNovel', []));`]);
  assert.equal(stdout.trim(),'7');
});
