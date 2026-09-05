import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = 'miaoyomi-tests-secret-32-characters';
  process.env.CONFIG_DIR = '/tmp/miaoyomi-test-config';
}

test('novel source → selected chapter → standard EPUB, owned library and progress', {skip: !DSN}, async t => {
  const {migrate} = await import('../src/lib/migrate');
  const {migrateNovels} = await import('../src/lib/novels/migrate');
  const {q, pool} = await import('../src/lib/db');
  const {NovelError} = await import('../src/lib/novels/apiTypes');
  const routes = (await import('../src/routes/novels')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await migrate(); await migrateNovels();
  await q("DELETE FROM users WHERE username IN ('novel-api-a','novel-api-b')");
  const users = await q<{id:string}>("INSERT INTO users(username,display_name,password_hash,role) VALUES ('novel-api-a','A','x','admin'),('novel-api-b','B','x','user') RETURNING id");
  const root = await mkdtemp(join(tmpdir(),'miaoyomi-api-'));
  const source = {id:'fixture-novel',name:'Fixture',lang:'English',site:'https://example.org',version:'1.0.0',enabled:true,supported:true,supportsLatest:true};
  const calls:string[] = [];
  const engine = {
    async sources(){return [source];}, async source(){return source;}, async enable(){return source;},
    async invoke(_id:string, method:string, args:unknown[]) {
      calls.push(method);
      if (method==='resolveUrl') throw new NovelError(409,'UNSUPPORTED_CAPABILITY','Plugin does not support method resolveUrl');
      if (method==='popularNovels' || method==='searchNovels') return [{name:'A Novel',path:'novel/1'}];
      if (method==='parseNovel') return {name:'A Novel',path:'novel/1',author:'An Author',chapters:[{name:'First',path:'chapter/1'},{name:'Second',path:'chapter/2'}]};
      if (method==='parseChapter') return `<p>${args[0]==='chapter/1'?'First chapter':'Second chapter'}</p><script>alert('no')</script>`;
      throw new Error(`Unexpected method: ${method}`);
    },
    async asset(){throw new Error('Unexpected asset fetch');},
  };
  const app = Fastify();
  await app.register(jwt,{secret:process.env.JWT_SECRET!});
  await app.register(routes,{engine,archiveRoot:root});
  const header=(i:number)=>({authorization:`Bearer ${app.jwt.sign({sub:users[i].id,role:i===0?'admin':'user'})}`});
  const request=(url:string,method:'GET'|'POST'|'PUT'='GET',payload?:unknown,i=0)=>app.inject({url,method,headers:header(i),payload:payload as any});
  let novel:any;
  try {
    await t.test('no credentials is unauthorized and only admin enables sources',async()=>{
      assert.equal((await app.inject('/api/novels/sources')).statusCode,401);
      assert.equal((await request('/api/novels/sources/fixture-novel','POST',{enabled:true},1)).statusCode,403);
    });
    await t.test('browsing and title metadata do not pre-download any chapter',async()=>{
      assert.equal((await request('/api/novels/browse?sourceId=fixture-novel')).json().items[0].title,'A Novel');
      const detail=await request('/api/novels/detail?sourceId=fixture-novel&path=novel%2F1');
      assert.equal(detail.statusCode,200,detail.body); novel=detail.json();
      assert.equal(novel.chapters.length,2);
      assert.equal(calls.includes('parseChapter'),false);
      assert.deepEqual(await readdir(root),[]);
      assert.equal((await request(`/api/novels/${novel.id}`,'GET',undefined,1)).statusCode,404);
    });
    await t.test('opening exactly the selected chapter stores only EPUB and reuses it',async()=>{
      const path=`/api/novels/${novel.id}/chapters/${novel.chapters[1].id}/open`;
      const opened=await request(path,'POST',{});
      assert.equal(opened.statusCode,200,opened.body);
      assert.match(opened.json().html,/Second chapter/);
      assert.doesNotMatch(opened.json().html,/<script|alert\(/);
      assert.equal(calls.filter(c=>c==='parseChapter').length,1);
      assert.equal((await request(path,'POST',{})).statusCode,200);
      assert.equal(calls.filter(c=>c==='parseChapter').length,1);
      const files=await readdir(root,{recursive:true});
      assert.ok(files.some(p=>String(p).endsWith('.epub')));
      assert.ok(files.every(p=>!String(p).endsWith('.html')&&!String(p).endsWith('.xhtml')));
      const exported=await request(`/api/novels/${novel.id}/export.epub`);
      assert.equal(exported.statusCode,200); assert.match(exported.headers['content-type']!,/application\/epub\+zip/);
      assert.equal(exported.rawPayload.subarray(0,2).toString(),'PK');
    });
    await t.test('the API checks chapter membership before retrieval',async()=>{
      assert.equal((await request(`/api/novels/${novel.id}/chapters/${'a'.repeat(64)}/open`,'POST',{})).statusCode,404);
      assert.equal(calls.filter(c=>c==='parseChapter').length,1);
    });
    await t.test('an older outbox update cannot reset completed progress or another account',async()=>{
      const url=`/api/novels/${novel.id}/progress`; const now=Date.now();
      const body={chapterId:novel.chapters[1].id,position:1,completed:true,updatedAt:now,mutationId:'one'};
      const first=await request(url,'PUT',body); assert.equal(first.statusCode,200,first.body);
      const stale=await request(url,'PUT',{...body,position:.1,completed:false,updatedAt:now-1000,mutationId:'two'});
      assert.equal(stale.json().progress.position,1); assert.equal(stale.json().progress.completed,true);
      assert.equal((await request(url,'GET',undefined,1)).statusCode,404);
      assert.equal((await request('/api/novels/library','GET',undefined,1)).json().items.length,0);
    });
  } finally {
    await app.close(); await q('DELETE FROM users WHERE id=ANY($1)',[users.map(u=>u.id)]);
    await q('DELETE FROM novel_series WHERE source_id=$1',['fixture-novel']);
    await pool.end(); await rm(root,{recursive:true,force:true});
  }
});
