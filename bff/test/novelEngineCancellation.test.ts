import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
process.env.DATABASE_URL??='postgresql://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET??='novel-cancellation-test';

test('engine cancellation reaches upstream fetch and streamed response body',async()=>{
  const {createNovelEngine}=await import('../src/lib/novels/engine');
  const {withSourceRequests}=await import('../src/lib/sourceRequests');
  for(const bodyStarted of [false,true]){
    let arrived!:()=>void,closed!:()=>void,headersReceived!:()=>void;
    const headers=new Promise<void>(resolve=>{headersReceived=resolve;});
    const originalFetch=globalThis.fetch;
    globalThis.fetch=async(...args)=>{const response=await originalFetch(...args);headersReceived();return response;};
    const arrival=new Promise<void>(resolve=>{arrived=resolve;});
    const closure=new Promise<void>(resolve=>{closed=resolve;});
    const server=createServer((_req,res)=>{res.on('close',closed);if(bodyStarted){res.writeHead(200,{'content-type':'application/json'});res.write('{"result":');}arrived();});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address() as {port:number};
    const engine=createNovelEngine(`http://127.0.0.1:${address.port}`,'secret');
    const controller=new AbortController();
    const reason=new Error('caller cancelled discovery');
    try{
      const work=withSourceRequests({signal:controller.signal},()=>engine.invoke('one','popularNovels',[]));
      const rejected=assert.rejects(work,error=>error===reason);
      await arrival;
      if(bodyStarted)await headers;
      controller.abort(reason);
      await rejected;
      await Promise.race([closure,new Promise((_,reject)=>setTimeout(()=>reject(Error('upstream was not closed')),200))]);
    }finally{globalThis.fetch=originalFetch;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  }
});
