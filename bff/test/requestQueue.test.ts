import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestQueue, setRequestTimeout } from '../src/lib/requestQueue';

const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};

test('global and per-source limits hold across a burst and failures release capacity',async()=>{
  const queue=new RequestQueue({concurrency:3,perKeyConcurrency:1});
  let active=0,peak=0;const counts=new Map<string,number>();
  const results=await Promise.allSettled(Array.from({length:18},(_,i)=>{
    const key=String(i%4);
    return queue.run(key,async()=>{
      counts.set(key,(counts.get(key)||0)+1);assert.equal(counts.get(key),1);
      peak=Math.max(peak,++active);
      await pause(5);active--;counts.set(key,counts.get(key)!-1);
      if(i===2)throw Error('fixture failure');
      return i;
    });
  }));
  assert.equal(peak,3);assert.equal(results.filter(r=>r.status==='rejected').length,1);
  await pause(0);assert.equal(queue.snapshot().active,0);assert.equal(queue.snapshot().queued,0);
});

test('a hot source cannot occupy every waiting slot or starve another source',async()=>{
  const queue=new RequestQueue({concurrency:1,perKeyConcurrency:1,maxQueued:4,maxQueuedPerKey:2});
  const held=deferred();const started:string[]=[];
  const first=queue.run('hot',()=>held.promise);
  const rest=[queue.run('hot',async()=>{started.push('hot1');}),queue.run('hot',async()=>{started.push('hot2');})];
  await assert.rejects(queue.run('hot',async()=>{}),e=>(e as any).code==='QUEUE_FULL');
  rest.push(queue.run('other',async()=>{started.push('other');}));
  held.resolve();await Promise.all([first,...rest]);
  assert.ok(started.indexOf('other')<started.indexOf('hot2'));
});

test('cancelled waiting work is removed and never starts',async()=>{
  const queue=new RequestQueue({concurrency:1,maxQueued:1});const held=deferred();
  const first=queue.run('first',()=>held.promise);
  const controller=new AbortController();let ran=false;
  const waiting=queue.run('cancelled',async()=>{ran=true;},{signal:controller.signal});
  controller.abort();await assert.rejects(waiting,e=>(e as any).code==='CANCELLED');
  const next=queue.run('replacement',async()=>42);
  held.resolve();await first;assert.equal(await next,42);assert.equal(ran,false);
});

test('a full waiting lane does not prevent another source using an idle worker',async()=>{
  const queue=new RequestQueue({concurrency:2,perKeyConcurrency:1,maxQueued:1});const held=deferred();
  const first=queue.run('hot',()=>held.promise);
  const waiting=queue.run('hot',async()=>{});
  try { assert.equal(await queue.run('other',async()=>42),42); }
  finally {held.resolve();await Promise.all([first,waiting]);}
});

test('execution time starts after dequeue and can be set by the existing timeout helper',async()=>{
  const queue=new RequestQueue({concurrency:1,maxWaitMs:500});const held=deferred();
  const first=queue.run('first',()=>held.promise);
  const waiting=queue.run('next',async()=>{await pause(5);return 'ok';});
  assert.equal(setRequestTimeout(waiting,25),true);
  await pause(45);held.resolve();await first;assert.equal(await waiting,'ok');
});

test('queue wait expiry does not execute work or blame the source',async()=>{
  const queue=new RequestQueue({concurrency:1,maxWaitMs:15});const held=deferred();
  const first=queue.run('first',()=>held.promise);let ran=false;
  await assert.rejects(queue.run('late',async()=>{ran=true;}),e=>(e as any).code==='QUEUE_TIMEOUT'&&!(e as any).selfTimeout);
  held.resolve();await first;assert.equal(ran,false);
});

test('timed-out opaque work holds its active slot until it actually settles',async()=>{
  const queue=new RequestQueue({concurrency:1,maxWaitMs:1000});const held=deferred();let transportSignal:AbortSignal|undefined;
  const first=queue.run('opaque',signal=>{transportSignal=signal;return held.promise;},{timeoutMs:15});
  await assert.rejects(first,e=>(e as any).code==='REQUEST_TIMEOUT'&&(e as any).selfTimeout);
  assert.equal(transportSignal?.aborted,true);assert.equal(queue.snapshot().active,1);
  let ran=false;const next=queue.run('next',async()=>{ran=true;});
  await pause(10);assert.equal(ran,false);held.resolve();await next;assert.equal(ran,true);
});

test('interactive work gets priority while aged background work gets a turn',async()=>{
  const queue=new RequestQueue({concurrency:1,agingMs:15});let held=deferred();const started:string[]=[];
  let first=queue.run('held',()=>held.promise);
  let background=queue.run('background',async()=>{started.push('background');},{priority:'background'});
  let interactive=queue.run('interactive',async()=>{started.push('interactive');});
  held.resolve();await Promise.all([first,background,interactive]);
  assert.deepEqual(started,['interactive','background']);
  held=deferred();started.length=0;first=queue.run('held',()=>held.promise);
  background=queue.run('background',async()=>{started.push('background');},{priority:'background'});
  await pause(25);interactive=queue.run('interactive',async()=>{started.push('interactive');});
  held.resolve();await Promise.all([first,background,interactive]);assert.deepEqual(started,['background','interactive']);
});

test('shutdown cancels active transports and rejects pending and future requests',async()=>{
  const queue=new RequestQueue({concurrency:1});const began=deferred();
  const active=queue.run('active',signal=>new Promise<void>((_resolve,reject)=>{began.resolve();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});}));
  await began.promise;const pending=queue.run('pending',async()=>{});
  queue.close();
  await assert.rejects(active,e=>(e as any).code==='QUEUE_CLOSED');
  await assert.rejects(pending,e=>(e as any).code==='QUEUE_CLOSED');
  await assert.rejects(queue.run('future',async()=>{}),e=>(e as any).code==='QUEUE_CLOSED');
});

test('a callback rejecting with undefined remains a rejection',async()=>{
  const queue=new RequestQueue();
  let fulfilled=false,rejected=false,rejection:unknown='not observed';
  await queue.run('undefined-rejection',()=>Promise.reject(undefined)).then(
    ()=>{fulfilled=true;},
    error=>{rejected=true;rejection=error;},
  );
  assert.equal(fulfilled,false);
  assert.equal(rejected,true);
  assert.equal(rejection,undefined);
});
