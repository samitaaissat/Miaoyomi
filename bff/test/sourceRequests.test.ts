import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import Fastify from 'fastify';
import type { SourceAdapter } from '../src/lib/sources/types';
process.env.DATABASE_URL||='postgresql://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET||='source-queue-fixture';
process.env.SOURCE_REQUEST_CONCURRENCY='1';
process.env.SOURCE_REQUEST_PER_SOURCE='1';
process.env.SOURCE_REQUEST_QUEUE_WAIT_MS='1000';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
const eventually=async(assertion:()=>void)=>{for(let attempt=0;attempt<100;attempt++){try{return assertion();}catch(error){if(attempt===99)throw error;await new Promise(resolve=>setTimeout(resolve,5));}}};
const source=(id:string):SourceAdapter=>({id,name:id,async search(){return[];},async getSeries(){return null;},async listChapters(){return[];},async getPageUrls(){return[];}});

test('registered adapters share capacity and withTimeout excludes queue waiting',async()=>{
  const {registerAdapter,getSource,reloadSources,withTimeout}=await import('../src/lib/sources');
  reloadSources('/nonexistent-source-queue-fixture');
  const entered=deferred(),release=deferred();
  registerAdapter({...source('held'),async search(){entered.resolve();await release.promise;return[];}});
  let nextStarted=false;
  registerAdapter({...source('next'),async search(){nextStarted=true;return[];}});
  const held=getSource('held')!.search('fixture');await entered.promise;
  const next=withTimeout(getSource('next')!.search('fixture'),20);
  try {
    await new Promise(resolve=>setTimeout(resolve,35));
    assert.equal(nextStarted,false,'registration must schedule every adapter');
  } finally {release.resolve();await Promise.all([held,next]);}
  assert.equal(nextStarted,true);
});

test('adapter wrappers preserve metadata and method receivers without nested acquisition',async()=>{
  const {registerAdapter,getSource}=await import('../src/lib/sources');
  const adapter={...source('receiver'),name:'Fixture',async search(){return (await this.getSeries('fixture'))?[{source:'receiver',sourceId:'fixture',title:this.name}]:[];},async getSeries(){return {source:'receiver',sourceId:'fixture',title:this.name};}};
  Object.freeze(adapter);
  registerAdapter(adapter);
  const wrapped=getSource('receiver')!;
  assert.equal({...wrapped}.name,'Fixture');
  assert.equal((await wrapped.search('fixture'))[0].title,'Fixture');
});

test('source request context cancels pending work before it can reach a source',async()=>{
  const {registerAdapter,getSource}=await import('../src/lib/sources');
  const {withSourceRequests}=await import('../src/lib/sourceRequests');
  const entered=deferred(),release=deferred();
  registerAdapter({...source('blocking'),async search(){entered.resolve();await release.promise;return[];}});
  let called=false;registerAdapter({...source('abandoned'),async search(){called=true;return[];}});
  const first=getSource('blocking')!.search('fixture');await entered.promise;
  const controller=new AbortController();
  const waiting=withSourceRequests({signal:controller.signal},()=>getSource('abandoned')!.search('fixture'));
  controller.abort();
  try {await assert.rejects(waiting,e=>(e as any).code==='CANCELLED');assert.equal(called,false);}
  finally {release.resolve();await first;}
});

test('disconnecting a GET aborts source work without releasing its slot before transport settles',async()=>{
  const {currentSourceRequest,installSourceRequestContext,scheduleSourceAdapter,sourceRequestQueue}=await import('../src/lib/sourceRequests');
  const app=Fastify();installSourceRequestContext(app);
  const entered=deferred(),release=deferred();
  let rawSignal:AbortSignal|undefined;
  const adapter=scheduleSourceAdapter({...source('socket-disconnect'),async search(){
    rawSignal=currentSourceRequest().signal;entered.resolve();await release.promise;return[];
  }});
  app.get('/read',()=>adapter.search('fixture'));
  await app.listen({host:'127.0.0.1',port:0});
  const address=app.server.address();assert.ok(address&&typeof address==='object');
  const baseline=sourceRequestQueue.snapshot().active;
  const request=get(`http://127.0.0.1:${address.port}/read`);
  request.on('error',()=>{});
  try {
    await entered.promise;
    assert.equal(sourceRequestQueue.snapshot().active,baseline+1);
    request.destroy();
    await eventually(()=>assert.equal(rawSignal?.aborted,true));
    assert.equal(sourceRequestQueue.snapshot().active,baseline+1,'cancelled transport must retain its scheduler slot while still running');
    release.resolve();
    await eventually(()=>assert.equal(sourceRequestQueue.snapshot().active,baseline));
  } finally {
    release.resolve();request.destroy();await app.close();
  }
});
