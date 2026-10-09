import test from 'node:test';
import assert from 'node:assert/strict';
import type { EngineSource } from '../src/lib/novels/apiTypes';

const DSN=process.env.TEST_DATABASE_URL;
if(DSN){
  process.env.DATABASE_URL=DSN;
  process.env.JWT_SECRET='novel-discovery-regression-secret';
  process.env.CONFIG_DIR='/tmp/miaoyomi-novel-discovery-config';
}

test('novel discovery aggregates permitted sources and paginates each source independently',{skip:!DSN},async t=>{
  const {migrate}=await import('../src/lib/migrate');
  const {q,pool}=await import('../src/lib/db');
  const {NovelError}=await import('../src/lib/novels/apiTypes');
  await migrate();
  const [user]=await q<{id:string}>("INSERT INTO users(username,display_name,password_hash,role,max_age_rating) VALUES($1,'Discovery','x','user',13) RETURNING id",[`discovery-${Date.now()}`]);
  const makeSource=(id:string,extra:Partial<EngineSource>={}):EngineSource=>({id,name:id.toUpperCase(),lang:'English',site:'https://example.org',version:'1',enabled:true,supported:true,supportsLatest:true,...extra});
  const sources=[makeSource('alpha'),makeSource('beta',{supportsLatest:false}),makeSource('gamma',{lang:'French'}),makeSource('adult',{isNsfw:true}),makeSource('disabled',{enabled:false}),makeSource('unsupported',{supported:false})];
  let failBeta=false,failMetadata=false,stallMetadata=false,stallCatalog=false,active=0,peak=0;
  let releaseMetadata!:(v:EngineSource)=>void;
  let releaseCatalog!:(v:EngineSource[])=>void;
  const calls:Array<{id:string;method:string;args:any[]}>=[];
  const engine={
    async sources(){if(stallCatalog)return new Promise<EngineSource[]>(resolve=>{releaseCatalog=resolve;});return sources.map(s=>({...s}));},
    async source(id:string){if(id==='beta'&&stallMetadata)return new Promise<EngineSource>(resolve=>{releaseMetadata=resolve;});if(id==='beta'&&failMetadata)throw new NovelError(502,'ENGINE_BUSY','Retry shortly');return {...sources.find(s=>s.id===id)!,filters:{order:{type:'Picker',value:`${id}-default`}}};},
    async enable(id:string){return sources.find(s=>s.id===id)!;},
    async invoke(id:string,method:string,args:any[]){
      calls.push({id,method,args});active++;peak=Math.max(peak,active);
      try{
        await new Promise(resolve=>setTimeout(resolve,10));
        if(id==='beta'&&failBeta)throw new NovelError(502,'SITE_CHALLENGE','Challenge unresolved');
        const page=Number(method==='searchNovels'?args[1]:args[0]);
        if(id==='gamma'||page>(id==='alpha'?1:2))return [];
        return [{name:`${id} ${page}`,path:`novel/${page}`}];
      }finally{active--;}
    },
    async asset(){throw new Error('Unexpected asset call');},
  };
  const app=(await import('fastify')).default();
  await app.register((await import('@fastify/jwt')).default,{secret:process.env.JWT_SECRET!});
  await app.register((await import('../src/routes/novels')).default,{engine});
  const headers={authorization:`Bearer ${app.jwt.sign({sub:user.id,role:'user'})}`};
  const request=(url:string)=>app.inject({url,headers});
  try{
    await t.test('the default catalog combines all enabled compatible visible sources with their own defaults',async()=>{
      calls.length=0;peak=0;
      const r=await request('/api/novels/browse');assert.equal(r.statusCode,200,r.body);
      assert.deepEqual(r.json().items.map((v:any)=>[v.sourceId,v.title]),[['alpha','alpha 1'],['beta','beta 1']]);
      assert.deepEqual(calls.map(c=>c.id).sort(),['alpha','beta','gamma']);
      for(const call of calls)assert.equal(call.args[1].filters.order.value,`${call.id}-default`);
      assert.equal(peak,3,'eligible sources use the increased private engine worker capacity');
      assert.deepEqual(r.json().errors,[]);assert.equal(r.json().hasMore,true);assert.ok(r.json().nextCursor);
    });
    await t.test('filters restrict source subsets, language and latest capability without an automatic first source',async()=>{
      calls.length=0;
      let r=await request('/api/novels/browse?sourceIds=alpha&sourceIds=gamma');assert.equal(r.statusCode,200,r.body);
      assert.deepEqual(calls.map(c=>c.id).sort(),['alpha','gamma']);
      calls.length=0;r=await request('/api/novels/browse?lang=French');assert.equal(r.statusCode,200,r.body);
      assert.deepEqual(calls.map(c=>c.id),['gamma']);
      calls.length=0;r=await request('/api/novels/browse?mode=latest');assert.equal(r.statusCode,200,r.body);
      assert.deepEqual(calls.map(c=>c.id).sort(),['alpha','gamma']);
      calls.length=0;r=await request('/api/novels/browse?sourceId=beta&filters='+encodeURIComponent(JSON.stringify({order:{type:'Picker',value:'rating'}})));
      assert.equal(r.statusCode,200,r.body);assert.equal(calls[0].args[1].filters.order.value,'rating');
    });
    await t.test('search aggregates and keeps source identity for identical paths',async()=>{
      calls.length=0;const r=await request('/api/novels/search?q=door');assert.equal(r.statusCode,200,r.body);
      assert.equal(r.json().items.length,2);assert.notEqual(r.json().items[0].id,r.json().items[1].id);
      assert.deepEqual(calls.map(c=>[c.id,c.method,c.args]).sort(),[['alpha','searchNovels',['door',1]],['beta','searchNovels',['door',1]],['gamma','searchNovels',['door',1]]]);
    });
    await t.test('partial failures retain successful cards and retry the failed page while skipping exhausted sources',async()=>{
      failBeta=true;calls.length=0;
      const first=await request('/api/novels/browse');assert.equal(first.statusCode,200,first.body);
      assert.deepEqual(first.json().items.map((v:any)=>v.sourceId),['alpha']);
      assert.equal(first.json().errors[0].sourceId,'beta');assert.equal(first.json().errors[0].code,'SITE_CHALLENGE');
      failBeta=false;calls.length=0;
      const second=await request('/api/novels/browse?page=2&cursor='+encodeURIComponent(first.json().nextCursor));assert.equal(second.statusCode,200,second.body);
      assert.deepEqual(calls.map(c=>[c.id,c.args[0]]).sort(),[['alpha',2],['beta',1]]);
      assert.deepEqual(second.json().items.map((v:any)=>v.title),['beta 1']);
      calls.length=0;
      const third=await request('/api/novels/browse?page=3&cursor='+encodeURIComponent(second.json().nextCursor));assert.equal(third.statusCode,200,third.body);
      assert.deepEqual(calls.map(c=>[c.id,c.args[0]]),[['beta',2]]);
      const last=await request('/api/novels/browse?page=4&cursor='+encodeURIComponent(third.json().nextCursor));assert.equal(last.statusCode,200,last.body);
      assert.equal(last.json().hasMore,false);assert.equal(last.json().nextCursor,undefined);
    });
    await t.test('one source metadata failure does not prevent discovery from opening',async()=>{
      failMetadata=true;
      try{
        const list=await request('/api/novels/sources');assert.equal(list.statusCode,200,list.body);
        assert.deepEqual(list.json().sources.map((s:any)=>s.id),['alpha','beta','gamma','disabled','unsupported']);
        const r=await request('/api/novels/browse');assert.equal(r.statusCode,200,r.body);
        assert.deepEqual(r.json().items.map((v:any)=>v.sourceId),['alpha']);
        assert.equal(r.json().errors[0].sourceId,'beta');
      }finally{failMetadata=false;}
    });
    await t.test('source metadata stalls cannot hold the listing open',async()=>{
      stallMetadata=true;
      const work=request('/api/novels/sources');
      const result=await Promise.race([work,new Promise<null>(resolve=>setTimeout(()=>resolve(null),3500))]);
      releaseMetadata(makeSource('beta'));stallMetadata=false;
      await work;
      assert.ok(result,'metadata listing exceeded its bounded response window');
      assert.equal(result.statusCode,200,result.body);
      assert.deepEqual(result.json().sources.map((s:any)=>s.id),['alpha','beta','gamma','disabled','unsupported']);
      assert.ok(result.json().sources.find((s:any)=>s.id==='alpha').filters);
    });
    await t.test('slow catalogs defer unstarted sources without losing or starving them',async()=>{
      const {discoverNovels,discoveryCursor}=await import('../src/lib/novels/discovery');
      const many=Array.from({length:6},(_,i)=>makeSource(`slow-${i}`));
      const slowEngine={...engine,async source(id:string){return makeSource(id);},async invoke(id:string){
        await new Promise(resolve=>setTimeout(resolve,30));return [{name:id,path:'novel'}];
      }};
      const first=await discoverNovels(slowEngine,many,{page:1,budgetMs:10,concurrency:2});
      assert.deepEqual(first.items,[]);
      const pages=discoveryCursor(first.nextCursor)!;
      assert.deepEqual(Object.keys(pages),['slow-2','slow-3','slow-4','slow-5','slow-0','slow-1']);
      assert.equal(pages['slow-2'],1);assert.equal(pages['slow-0'],1);
      const second=await discoverNovels(slowEngine,many,{page:2,pages,budgetMs:10,concurrency:2});
      assert.deepEqual(second.items,[]);
      assert.deepEqual(Object.keys(discoveryCursor(second.nextCursor)!),['slow-4','slow-5','slow-0','slow-1','slow-2','slow-3']);
      const third=await discoverNovels(slowEngine,many.slice(4),{page:3,pages:discoveryCursor(second.nextCursor),budgetMs:100,concurrency:2});
      assert.deepEqual(third.items.map(v=>v.sourceId),['slow-4','slow-5']);
    });
    await t.test('initial source catalog waits are bounded on every discovery route',async()=>{
      for(const url of ['/api/novels/sources','/api/novels/browse','/api/novels/search?q=door']){
        stallCatalog=true;const work=request(url);
        const result=await Promise.race([work,new Promise<null>(resolve=>setTimeout(()=>resolve(null),3500))]);
        releaseCatalog(sources);stallCatalog=false;await work;
        assert.ok(result,'initial engine catalog exceeded metadata deadline');
        assert.equal(result.statusCode,504,result.body);
        assert.equal(result.json().error,'discovery_timeout');
      }
    });
    await t.test('overall deadlines include blocked permission preparation and prevent late upstream work',async st=>{
      const realTimeout=setTimeout;
      const originalQuery=pool.query.bind(pool);
      let catalogCalls=0;
      const originalSources=engine.sources;
      engine.sources=async()=>{catalogCalls++;return originalSources();};
      try{
        for(const [url,budget,blockedSql] of [
          ['/api/novels/browse',10_000,'SELECT role,perms FROM users'],
          ['/api/novels/browse?lang=French',10_000,'SELECT role,perms FROM users'],
          ['/api/novels/browse?cursor='+Buffer.from(JSON.stringify({version:1,pages:{alpha:1}})).toString('base64url'),10_000,'SELECT role,perms FROM users'],
          ['/api/novels/search?q=door&sourceIds=alpha&sourceIds=gamma&lang=French',10_000,'SELECT role,perms FROM users'],
          ['/api/novels/search?q=door&sourceId=alpha',30_000,'SELECT role,perms FROM users'],
          ['/api/novels/search?q=door',10_000,'SELECT max_age_rating FROM users'],
          ['/api/novels/browse?sourceIds=alpha',30_000,'SELECT max_age_rating FROM users'],
        ] as const){
          const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<any>();
          const mock=st.mock.method(pool,'query',((text:any,...args:any[])=>{
            if(typeof text==='string'&&text.startsWith(blockedSql)){entered.resolve();return release.promise;}
            if(typeof text==='string'&&text.startsWith('SELECT role,perms FROM users'))return Promise.resolve({rows:[{role:'user',perms:{canDownload:true}}]});
            if(typeof text==='string'&&text.startsWith('SELECT library_id FROM user_libraries'))return Promise.resolve({rows:[]});
            return (originalQuery as any)(text,...args);
          }) as any);
          st.mock.timers.enable({apis:['setTimeout','Date']});
          calls.length=0;catalogCalls=0;
          const work=request(url);
          await entered.promise;
          st.mock.timers.tick(budget-1);
          let settled=false;work.then(()=>{settled=true;});
          await new Promise(resolve=>setImmediate(resolve));
          assert.equal(settled,false,'must not expire before the selected budget');
          st.mock.timers.tick(1);
          const result=await Promise.race([work,new Promise<null>(resolve=>realTimeout(()=>resolve(null),100))]);
          release.resolve({rows:[{role:'user',perms:{canDownload:true}}]});
          st.mock.timers.reset();mock.mock.restore();
          await work;await new Promise(resolve=>realTimeout(resolve,20));
          assert.ok(result,`blocked ${blockedSql} exceeded ${budget}ms on ${url}`);
          assert.equal(result.statusCode,504,result.body);
          assert.equal(result.json().error,'discovery_timeout');
          assert.equal(catalogCalls,0,'late permission completion must not request the catalog');
          assert.equal(calls.length,0,'late permission completion must not invoke a source');
        }
      }finally{st.mock.timers.reset();engine.sources=originalSources;}
    });
    await t.test('only explicit single selection receives the extended source timeout',async st=>{
      const originalInvoke=engine.invoke;
      const cursor=Buffer.from(JSON.stringify({version:1,pages:{alpha:1}})).toString('base64url');
      let clock=Date.now();
      try{
        for(const [url,timeout] of [
          ['/api/novels/browse?lang=French',5_000],
          ['/api/novels/browse?cursor='+cursor,5_000],
          ['/api/novels/search?q=door&sourceIds=alpha&sourceIds=gamma&lang=French',5_000],
          ['/api/novels/browse?sourceId=alpha',25_000],
          ['/api/novels/search?q=door&sourceIds=alpha',25_000],
        ] as const){
          const entered=Promise.withResolvers<void>();
          engine.invoke=async()=>{entered.resolve();return new Promise(()=>{});};
          st.mock.timers.enable({apis:['setTimeout','Date']});
          st.mock.timers.setTime(clock+=120_000); // Expire prior probes between independent selection cases.
          const work=request(url);await entered.promise;
          let settled=false;work.then(()=>{settled=true;});
          st.mock.timers.tick(timeout-1);await new Promise(resolve=>setImmediate(resolve));
          assert.equal(settled,false,url);
          st.mock.timers.tick(1);
          const result=await work;
          assert.equal(result.statusCode,200,result.body);
          assert.equal(result.json().errors[0].code,'source_timeout',url);
          st.mock.timers.reset();
        }
      }finally{st.mock.timers.reset();engine.invoke=originalInvoke;}
    });
    await t.test('invalid filters and forbidden source selections fail before any source work',async()=>{
      for(const [query,status] of [['sourceIds=adult',403],['sourceIds=unknown',404],['sourceIds=disabled',409],['sourceId=alpha&sourceIds=beta',400],['cursor=broken',400],['filters=%7B',400],['filters=%7B%22order%22%3A1%7D',400]] as const){
        calls.length=0;const r=await request('/api/novels/browse?'+query);assert.equal(r.statusCode,status,r.body);assert.equal(calls.length,0);
      }
      await q('UPDATE users SET perms=$2 WHERE id=$1',[user.id,{canDownload:false}]);
      calls.length=0;const r=await request('/api/novels/browse');assert.equal(r.statusCode,403,r.body);assert.equal(calls.length,0);
    });
  }finally{await app.close();await q('DELETE FROM users WHERE id=$1',[user.id]);await pool.end();}
});
