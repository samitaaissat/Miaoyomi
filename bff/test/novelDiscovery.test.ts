import test from 'node:test';
import assert from 'node:assert/strict';
import type { EngineSource, NovelEngine } from '../src/lib/novels/apiTypes';

process.env.DATABASE_URL??='postgresql://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET??='novel-discovery-unit-test';

const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const source=(id:string):EngineSource=>({id,name:id,lang:'English',site:'https://example.org',version:'1',enabled:true,supported:true,supportsLatest:true});
function fakeEngine(sources:EngineSource[],invoke:NovelEngine['invoke']):NovelEngine {
  return {async sources(){return sources;},async source(id){return sources.find(s=>s.id===id)!;},async enable(){throw Error('Unexpected enable');},async asset(){throw Error('Unexpected asset');},invoke};
}

test('integer-like source IDs rotate across interrupted cursor requests',async()=>{
  const {discoverNovels,discoveryCursor}=await import('../src/lib/novels/discovery');
  const sources=[source('1'),source('2')],calls:string[]=[];
  const engine=fakeEngine(sources,async id=>{calls.push(id);return new Promise(()=>{});});
  let pages:Record<string,number>|undefined;
  for(let i=0;i<3;i++){
    const result=await discoverNovels(engine,sources,{page:7,pages,budgetMs:10,sourceTimeoutMs:50,concurrency:1});
    pages=discoveryCursor(result.nextCursor);
    assert.deepEqual(pages,{'1':7,'2':7});
  }
  assert.deepEqual(calls,['1','2','1']);
});

test('maximum-sized source cursors fit the public cursor length limit',async()=>{
  const {discoverNovels,discoveryQuery,discoveryCursor}=await import('../src/lib/novels/discovery');
  const sources=Array.from({length:300},(_,i)=>source(String(i).padEnd(200,'x')));
  const result=await discoverNovels(fakeEngine(sources,async()=>[]),sources,{page:10_000,budgetMs:0});
  assert.equal(discoveryQuery.safeParse({cursor:result.nextCursor}).success,true);
  assert.equal(Object.keys(discoveryCursor(result.nextCursor)!).length,300);
});

test('legacy v1 cursors remain usable and v2 ordered pairs reject duplicate or invalid pages',async()=>{
  const {discoverNovels,discoveryCursor}=await import('../src/lib/novels/discovery');
  const encode=(v:unknown)=>Buffer.from(JSON.stringify(v)).toString('base64url');
  const sources=[source('1'),source('2')];
  const legacy=discoveryCursor(encode({version:1,pages:{'2':4,'1':3}}));
  const result=await discoverNovels(fakeEngine(sources,async(id,_method,args)=>[{name:`${id}-${args[0]}`,path:'one'}]),sources,{page:9,pages:legacy});
  assert.deepEqual(result.items.map(i=>i.title),['1-3','2-4']);
  for(const pages of [[['1',3],['1',4]],[['1',0]],[['',3]],[['1',10001]]]){
    assert.throws(()=>discoveryCursor(encode({version:2,pages})),{code:'bad_cursor'});
  }
});

test('late invocation rejection is consumed without changing results or source health',async()=>{
  const {discoverNovels}=await import('../src/lib/novels/discovery');
  const sources=[source('one')];let rejectLate!:(error:Error)=>void;
  const engine=fakeEngine(sources,async()=>new Promise((_resolve,reject)=>{rejectLate=reject;}));
  for(let i=0;i<3;i++){
    const result=await discoverNovels(engine,sources,{page:1,budgetMs:5,sourceTimeoutMs:50});
    rejectLate(Error('late invocation failure'));await delay(5);
    assert.deepEqual(result.items,[]);assert.deepEqual(result.errors,[]);
  }
  engine.invoke=async()=>[{name:'recovered',path:'one'}];
  assert.deepEqual((await discoverNovels(engine,sources,{page:1})).errors,[]);
});

test('hard discovery budget returns completed cards while another source hangs',async()=>{
  const {discoverNovels,discoveryCursor}=await import('../src/lib/novels/discovery');
  const sources=[source('hang'),source('fast'),source('tail')];
  let finish!:(value:any)=>void;
  const engine=fakeEngine(sources,async id=>id==='hang'?new Promise(resolve=>{finish=resolve;}):[{name:id,path:'one'}]);
  const result=await Promise.race([discoverNovels(engine,sources,{page:3,budgetMs:25,concurrency:2}),delay(150).then(()=>null)]);
  finish([{name:'late',path:'late'}]);
  assert.ok(result,'response exceeded hard budget');
  assert.deepEqual(result.items.map(i=>i.sourceId),['fast','tail']);
  assert.deepEqual(discoveryCursor(result.nextCursor),{hang:3,fast:4,tail:4});
  await delay(10);
  assert.equal(result.items.length,2,'late completion must not mutate response');
});

test('repeated failed sources enter temporary cooldown without losing their cursor page',async()=>{
  const {discoverNovels,discoveryCursor}=await import('../src/lib/novels/discovery');
  const sources=[source('bad'),source('good')];let calls=0;
  const engine=fakeEngine(sources,async id=>{if(id==='bad'){calls++;throw Error('offline');}return [{name:id,path:'one'}];});
  await discoverNovels(engine,sources,{page:2});
  await discoverNovels(engine,sources,{page:2});
  const result=await discoverNovels(engine,sources,{page:2});
  assert.equal(calls,2,'cooling source must not be invoked again');
  assert.deepEqual(discoveryCursor(result.nextCursor),{bad:2,good:3});
  assert.equal(result.errors.find(e=>e.sourceId==='bad')?.code,'source_cooldown');
});

test('source-specific timeout cools repeated stalls but global truncation does not',async()=>{
  const {discoverNovels}=await import('../src/lib/novels/discovery');
  const sources=[source('hang'),source('good')];let calls=0;
  const engine=fakeEngine(sources,async id=>{if(id==='hang'){calls++;return new Promise(()=>{});}return [];});
  for(let i=0;i<3;i++)await discoverNovels(engine,sources,{page:1,budgetMs:80,sourceTimeoutMs:10});
  assert.equal(calls,2,'independent timeouts should trigger cooldown');
  const other=fakeEngine(sources,async()=>{calls++;return new Promise(()=>{});});
  calls=0;
  for(let i=0;i<3;i++)await discoverNovels(other,sources,{page:1,budgetMs:5,sourceTimeoutMs:50});
  assert.equal(calls,6,'a short global deadline must not blame healthy in-flight sources');
});

test('concurrent discovery calls do not duplicate an active recovery probe',async()=>{
  const {discoverNovels,discoveryCursor}=await import('../src/lib/novels/discovery');
  const sources=[source('one')];let calls=0,finish!:(v:any)=>void;
  const engine=fakeEngine(sources,async()=>{calls++;return new Promise(resolve=>{finish=resolve;});});
  const first=discoverNovels(engine,sources,{page:4,budgetMs:100});
  await delay(5);
  const second=await discoverNovels(engine,sources,{page:4,budgetMs:15});
  finish([]);await first;
  assert.equal(calls,1);
  assert.deepEqual(discoveryCursor(second.nextCursor),{one:4});
  assert.equal(second.errors[0]?.code,'source_busy');
});

test('global deadline prioritizes unstarted sources before interrupted pages',async()=>{
  const {discoverNovels,discoveryCursor}=await import('../src/lib/novels/discovery');
  const sources=[source('hang'),source('tail')];
  const engine=fakeEngine(sources,async()=>new Promise(()=>{}));
  const first=await discoverNovels(engine,sources,{page:7,budgetMs:10,concurrency:1});
  assert.deepEqual(Object.keys(discoveryCursor(first.nextCursor)!),['tail','hang']);
  const recovery={...engine,async invoke(id:string,_method:string,args:any[]){return [{name:`${id}-${args[0]}`,path:'one'}];}};
  const second=await discoverNovels(recovery,sources,{page:8,pages:discoveryCursor(first.nextCursor)});
  assert.deepEqual(second.items.map(i=>i.title),['tail-7','hang-7']);
});

test('cooldown expires, successful recovery resets failures, and another engine is isolated',async()=>{
  const {discoverNovels}=await import('../src/lib/novels/discovery');
  const sources=[source('one')];let calls=0,fail=true;
  const engine=fakeEngine(sources,async()=>{calls++;if(fail)throw Error('offline');return [];});
  const originalNow=Date.now;let now=originalNow();Date.now=()=>now;
  try{
    await discoverNovels(engine,sources,{page:1});await discoverNovels(engine,sources,{page:1});
    assert.equal((await discoverNovels(engine,sources,{page:1})).errors[0].code,'source_cooldown');
    const other=fakeEngine(sources,async()=>[]);
    assert.deepEqual((await discoverNovels(other,sources,{page:1})).errors,[]);
    now+=30_001;fail=false;
    assert.deepEqual((await discoverNovels(engine,sources,{page:1})).errors,[]);
    fail=true;await discoverNovels(engine,sources,{page:1});
    assert.notEqual((await discoverNovels(engine,sources,{page:1})).errors[0].code,'source_cooldown');
    assert.equal(calls,5);
    now+=60_001;
    assert.notEqual((await discoverNovels(engine,sources,{page:1})).errors[0].code,'source_cooldown','stale state expires');
  }finally{Date.now=originalNow;}
});

test('health state evicts oldest entries at its 300-source bound',async()=>{
  const {discoverNovels}=await import('../src/lib/novels/discovery');
  const sources=Array.from({length:301},(_,i)=>source(`state-${i}`));let calls=0;
  const engine=fakeEngine(sources,async()=>{calls++;throw Error('offline');});
  await discoverNovels(engine,[sources[0]],{page:1});await discoverNovels(engine,[sources[0]],{page:1});
  await discoverNovels(engine,sources.slice(1),{page:1});
  const first=await discoverNovels(engine,[sources[0]],{page:1});
  assert.equal(first.errors[0].code,'source_error','oldest cooldown entry was evicted');
  assert.equal(calls,303);
});

test('exhausted budgets preserve all pages without starting metadata or invocation',async()=>{
  const {discoverNovels,discoveryCursor}=await import('../src/lib/novels/discovery');
  const sources=[source('one'),source('two')];let calls=0;
  const engine={...fakeEngine(sources,async()=>{calls++;return [];}),async source(){calls++;return sources[0];}};
  const result=await discoverNovels(engine,sources,{page:1,pages:{two:9,one:3},budgetMs:0});
  assert.equal(calls,0);assert.deepEqual(result.errors,[]);assert.deepEqual(discoveryCursor(result.nextCursor),{two:9,one:3});
});

test('source metadata deadlines propagate cancellation and consume late rejection',async()=>{
  const {discoverNovels,initializeDiscoverySources}=await import('../src/lib/novels/discovery');
  const {currentSourceRequest,withSourceRequests}=await import('../src/lib/sourceRequests');
  const sources=[source('one')];let observed:AbortSignal|undefined,rejectLate!:(error:Error)=>void;
  const engine={...fakeEngine(sources,async()=>{throw Error('invoke must not start');}),async source(){observed=currentSourceRequest().signal;return new Promise<EngineSource>((_resolve,reject)=>{rejectLate=reject;});}};
  const result=await discoverNovels(engine,sources,{page:1,budgetMs:30,sourceTimeoutMs:5});
  assert.equal(result.errors[0].code,'source_timeout');assert.equal(observed?.aborted,true);
  rejectLate(Error('late failure'));await delay(5);
  const controller=new AbortController(),reason=Error('disconnected');
  const pending=withSourceRequests({signal:controller.signal},()=>initializeDiscoverySources(engine,sources,100));
  await delay(5);controller.abort(reason);
  await assert.rejects(pending,error=>error===reason);assert.equal(observed?.aborted,true);
  rejectLate(Error('late cancelled failure'));await delay(5);
});

test('discovery uses four concurrent requests and still includes every selected source', async () => {
  const { discoverNovels }=await import('../src/lib/novels/discovery');
  const sources:EngineSource[]=Array.from({length:7},(_,i)=>({id:`source-${i}`,name:`Source ${i}`,lang:'English',site:'https://example.org',version:'1',enabled:true,supported:true,supportsLatest:true}));
  let active=0,peak=0;
  const engine:NovelEngine={
    async sources(){return sources;},
    async source(id){return sources.find(source=>source.id===id)!;},
    async enable(){throw Error('Unexpected enable');},
    async asset(){throw Error('Unexpected asset');},
    async invoke(id){
      active++;peak=Math.max(peak,active);
      await new Promise(resolve=>setTimeout(resolve,15));
      active--;
      return [{name:id,path:'novel/1'}];
    },
  };
  const result=await discoverNovels(engine,sources,{page:1});
  assert.equal(peak,4);
  assert.deepEqual(result.items.map(item=>item.sourceId),sources.map(source=>source.id));
  assert.deepEqual(result.errors,[]);
});
