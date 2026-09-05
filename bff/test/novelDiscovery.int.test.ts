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
  let failBeta=false,failMetadata=false,active=0,peak=0;
  const calls:Array<{id:string;method:string;args:any[]}>=[];
  const engine={
    async sources(){return sources.map(s=>({...s}));},
    async source(id:string){if(id==='beta'&&failMetadata)throw new NovelError(502,'ENGINE_BUSY','Retry shortly');return {...sources.find(s=>s.id===id)!,filters:{order:{type:'Picker',value:`${id}-default`}}};},
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
      assert.ok(peak<=2,'fan-out respects the private engine worker capacity');
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
    await t.test('slow catalogs defer unstarted sources without losing or starving them',async()=>{
      const {discoverNovels,discoveryCursor}=await import('../src/lib/novels/discovery');
      const many=Array.from({length:6},(_,i)=>makeSource(`slow-${i}`));
      const slowEngine={...engine,async source(id:string){return makeSource(id);},async invoke(id:string){
        await new Promise(resolve=>setTimeout(resolve,30));return [{name:id,path:'novel'}];
      }};
      const first=await discoverNovels(slowEngine,many,{page:1,budgetMs:10});
      assert.deepEqual(first.items.map(v=>v.sourceId),['slow-0','slow-1']);
      const pages=discoveryCursor(first.nextCursor)!;
      assert.deepEqual(Object.keys(pages),['slow-2','slow-3','slow-4','slow-5','slow-0','slow-1']);
      assert.equal(pages['slow-2'],1);assert.equal(pages['slow-0'],2);
      const second=await discoverNovels(slowEngine,many,{page:2,pages,budgetMs:10});
      assert.deepEqual(second.items.map(v=>v.sourceId),['slow-2','slow-3']);
      const third=await discoverNovels(slowEngine,many,{page:3,pages:discoveryCursor(second.nextCursor),budgetMs:10});
      assert.deepEqual(third.items.map(v=>v.sourceId),['slow-4','slow-5']);
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
