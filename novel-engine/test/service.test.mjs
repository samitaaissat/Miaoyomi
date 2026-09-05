import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../src/registry.mjs';
import { createApp } from '../src/app.mjs';
test('authenticated source routes persist activation and enforce invoke contract', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'novel-engine-')); t.after(() => rm(stateDir, { recursive: true, force: true }));
  const registry = await Registry.open({ stateDir });
  const app = await createApp({ token: 'test-private-token', registry }); t.after(() => app.close());
  assert.deepEqual((await app.inject('/healthz')).json(), { ok: true });
  assert.equal((await app.inject('/v1/sources')).statusCode, 401);
  const headers = { authorization: 'Bearer test-private-token' };
  const sources = (await app.inject({ url: '/v1/sources', headers })).json().sources;
  assert.ok(sources.length > 250); assert.equal(sources.find(x => x.id === 'royalroad').supported, true);
  const call = body => app.inject({ method: 'POST', url: '/v1/invoke', headers, payload: body });
  assert.equal((await call({ sourceId: 'royalroad', method: 'parseNovel', args: ['fiction/21220'] })).statusCode, 409);
  assert.equal((await call({ sourceId: 'royalroad', method: 'constructor', args: [] })).statusCode, 400);
  assert.equal((await call({ sourceId: 'missing', method: 'parseNovel', args: ['x'] })).statusCode, 404);
  const enabled = await app.inject({ method: 'POST', url: '/v1/sources/royalroad', headers, payload: { enabled: true } });
  assert.equal(enabled.statusCode, 200); assert.equal(enabled.json().source.enabled, true);
  const detail = (await app.inject({ url: '/v1/sources/royalroad', headers })).json().source;
  assert.ok(detail.filters.orderBy); assert.equal(detail.supportsLatest, true);
  const reopened = await Registry.open({ stateDir }); assert.equal((await reopened.get('royalroad')).enabled, true);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/sources/royalroad', headers, payload: { enabled: 'false' } })).statusCode, 400);
  const persisted = JSON.parse(await readFile(join(stateDir, 'sources.json'), 'utf8'));
  assert.match(persisted.royalroad.digest, /^[0-9a-f]{64}$/);
});
test('tampered plugin digests refuse activation', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'novel-engine-')); t.after(() => rm(stateDir, { recursive: true, force: true }));
  await writeFile(join(stateDir, 'sources.json'), JSON.stringify({ royalroad: { enabled: true, digest: '0'.repeat(64) } }));
  const registry = await Registry.open({ stateDir });
  const source = await registry.get('royalroad');
  assert.equal(source.supported, false); assert.match(source.reason, /digest/i);
});
test('HTTP invoke returns real plugin output, source failure and binary assets', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'novel-engine-')); t.after(() => rm(stateDir, { recursive: true, force: true }));
  const registry = await Registry.open({ stateDir }); await registry.enable('royalroad', true);
  const { NetworkBroker } = await import('../src/network.mjs');
  const png = Buffer.from([137,80,78,71,13,10,26,10,0]);
  const broker = new NetworkBroker({ lookup: async () => [{address:'93.184.216.34',family:4}], transport: async url => url.pathname === '/bad' ? { status:403, headers:{'cf-mitigated':'challenge'}, body:Buffer.from('blocked') } : url.pathname === '/cover' ? { status:200, headers:{'content-type':'image/png'}, body:png } : { status:200, headers:{'content-type':'text/html'}, body:Buffer.from('<div class="chapter-content"><p>Saved through API.</p></div>') } });
  const app = await createApp({ token:'test', registry, broker }); t.after(() => app.close()); const headers={authorization:'Bearer test'};
  const result = await app.inject({method:'POST',url:'/v1/invoke',headers,payload:{sourceId:'royalroad',method:'parseChapter',args:['chapter']}});
  assert.equal(result.statusCode,200); assert.match(result.json().result,/Saved through API/);
  const failure=await app.inject({method:'POST',url:'/v1/invoke',headers,payload:{sourceId:'royalroad',method:'parseChapter',args:['bad']}});
  assert.equal(failure.statusCode,502); assert.equal(failure.json().error,'SITE_CHALLENGE');
  const asset=await app.inject({method:'POST',url:'/v1/asset',headers,payload:{sourceId:'royalroad',url:'https://www.royalroad.com/cover'}});
  assert.equal(asset.statusCode,200); assert.deepEqual(asset.rawPayload,png); assert.equal(asset.headers['content-type'],'image/png');
});
test('published image request metadata survives restart and reaches the guarded asset request', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'novel-engine-')); t.after(() => rm(stateDir, { recursive: true, force: true }));
  const initial = await Registry.open({ stateDir }); await initial.enable('ixdzs8', true);
  const registry = await Registry.open({ stateDir });
  const { NetworkBroker } = await import('../src/network.mjs');
  const png = Buffer.from([137,80,78,71,13,10,26,10,0]);
  const broker = new NetworkBroker({ lookup: async () => [{address:'93.184.216.34',family:4}], transport: async (_url, init) =>
    init.headers.referer === 'https://ixdzs8.com/' ? {status:200,headers:{'content-type':'image/png'},body:png} : {status:403,headers:{},body:Buffer.from('Referrer required')}
  });
  const app = await createApp({token:'test',registry,broker}); t.after(() => app.close());
  const result = await app.inject({method:'POST',url:'/v1/asset',headers:{authorization:'Bearer test'},payload:{sourceId:'ixdzs8',url:'https://ixdzs8.com/illustration.png'}});
  assert.equal(result.statusCode,200); assert.deepEqual(result.rawPayload,png);
  // Request metadata is an internal transport capability, not public source credentials.
  assert.equal((await app.inject({url:'/v1/sources',headers:{authorization:'Bearer test'}})).json().sources.find(s=>s.id==='ixdzs8').imageRequestInit,undefined);
});
