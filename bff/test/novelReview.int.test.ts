import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = 'miaoyomi-review-test-secret-32-characters';
  process.env.CONFIG_DIR = '/tmp/miaoyomi-review-test-config';
}

test('novel retrieval permissions, published URL resolvers and refreshed archive order', {skip: !DSN}, async t => {
  const {migrate} = await import('../src/lib/migrate');
  const {migrateNovels} = await import('../src/lib/novels/migrate');
  const {q,pool} = await import('../src/lib/db');
  const {archivePath,inspectArchive} = await import('../src/lib/novels/archive');
  const {NovelError} = await import('../src/lib/novels/apiTypes');
  const routes = (await import('../src/routes/novels')).default;
  const app = (await import('fastify')).default();
  await migrate(); await migrateNovels();
  const source = {id:'review-regression-source',name:'Review fixture',lang:'English',site:'https://example.org',version:'1.0.0',enabled:true,supported:true,supportsLatest:true};
  const root = await mkdtemp(join(tmpdir(),'miaoyomi-review-test-'));
  const [user] = await q<{id:string}>("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Review','x','user') RETURNING id",[`review-${Date.now()}`]);
  const books = new Map<string,{name:string;chapters:Array<{name:string;path:string}>;totalPages?:number}>();
  const pages = new Map<string,Array<{name:string;path:string}>>();
  const calls:Array<{method:string;args:unknown[]}> = [];
  const assets:string[] = [];
  let offline = false;
  let resolver: 'missing'|'custom'|'failed' = 'missing';
  let html = '<p>Saved prose</p>';
  const engine = {
    async sources(){return [source];},
    async source(){if(offline)throw new NovelError(503,'engine_unavailable','Offline');return {...source,filters:{orderBy:{type:'Picker',value:'views',label:'Order',options:[{label:'Views',value:'views'}]}}};},
    async enable(){return source;},
    async invoke(_source:string,method:string,args:unknown[]){
      if(offline)throw new NovelError(503,'engine_unavailable','Offline');
      calls.push({method,args});
      if(method==='parseNovel')return books.get(String(args[0]));
      if(method==='parseChapter')return html;
      if(method==='parsePage')return {chapters:pages.get(String(args[1]))||[]};
      if(method==='resolveUrl'){
        if(resolver==='missing')throw new NovelError(409,'UNSUPPORTED_CAPABILITY','Plugin does not support method resolveUrl');
        if(resolver==='failed')throw new NovelError(502,'SOURCE_ERROR','Resolver failed');
        return `https://example.org/${args[1]===true?'books':'reader'}/${args[0]}/`;
      }
      throw Error(`Unexpected ${method}`);
    },
    async asset(_source:string,url:string){assets.push(url);return {contentType:'image/png',bytes:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==','base64')};},
  };
  await app.register((await import('@fastify/jwt')).default,{secret:process.env.JWT_SECRET!});
  await app.register(routes,{engine,archiveRoot:root});
  const headers={authorization:`Bearer ${app.jwt.sign({sub:user.id,role:'user'})}`};
  const req=(url:string,method:'GET'|'POST'='GET',payload?:unknown)=>app.inject({url,method,headers,payload:payload as any});
  const detail=async(path:string)=>{
    const r=await req(`/api/novels/detail?sourceId=${source.id}&path=${encodeURIComponent(path)}`);
    assert.equal(r.statusCode,200,r.body);return r.json();
  };
  const open=(n:any,c=n.chapters[0])=>req(`/api/novels/${n.id}/chapters/${c.id}/open`,'POST',{});
  try {
    await t.test('enabled source filters remain available through the public source list',async()=>{
      const r=await req('/api/novels/sources');assert.equal(r.statusCode,200,r.body);
      assert.equal(r.json().sources[0].filters?.orderBy.label,'Order');
    });
    await t.test('a missing EPUB cannot bypass revoked download permission',async()=>{
      books.set('permission',{name:'Permission',chapters:[{name:'One',path:'permission-one'}]});
      const n=await detail('permission');assert.equal((await open(n)).statusCode,200);
      await q('UPDATE users SET perms=$2 WHERE id=$1',[user.id,{canDownload:false}]);
      try {
        offline=true; assert.equal((await open(n)).statusCode,200,'saved content works without the source service');offline=false;
        await unlink(archivePath(root,n.id));
        const before=calls.filter(c=>c.method==='parseChapter').length;
        const r=await open(n);assert.equal(r.statusCode,403,r.body);
        assert.equal(calls.filter(c=>c.method==='parseChapter').length,before);
        assert.equal((await readdir(root)).includes(`${n.id}.epub`),false);
      } finally {offline=false;await q('UPDATE users SET perms=$2 WHERE id=$1',[user.id,{}]);}
    });
    await t.test('chapter source links and relative images use the published resolver',async()=>{
      resolver='custom';html='<p>Illustrated prose</p><img src="image.png" alt="Diagram">';
      try {
        books.set('opaque-42',{name:'Opaque',chapters:[{name:'Opaque chapter',path:'opaque-99'}]});
        const n=await detail('opaque-42');const r=await open(n);assert.equal(r.statusCode,200,r.body);
        assert.equal(r.json().sourceUrl,'https://example.org/reader/opaque-99/');
        assert.equal(assets.at(-1),'https://example.org/reader/opaque-99/image.png');
        assert.match(r.json().html,/data:image\/png;base64/);
        const [row]=await q('SELECT source_url FROM novel_series WHERE id=$1',[n.id]);
        assert.equal(row.source_url,'https://example.org/books/opaque-42/');
      } finally {resolver='missing';html='<p>Saved prose</p>';}
    });
    await t.test('a real resolver error is not silently replaced with a guessed URL',async()=>{
      resolver='failed';books.set('broken-resolver',{name:'Broken',chapters:[]});
      try {assert.equal((await req(`/api/novels/detail?sourceId=${source.id}&path=broken-resolver`)).statusCode,502);}
      finally {resolver='missing';}
    });
    await t.test('archive reconciliation recovers resolved links after a database rollback',async()=>{
      const n=await req(`/api/novels/detail?sourceId=${source.id}&path=opaque-42`);
      assert.equal(n.statusCode,200,n.body);
      const id=n.json().id,cid=n.json().chapters[0].id;
      await q('UPDATE novel_chapters SET source_url=$2 WHERE id=$1',[cid,'https://example.org/opaque-99']);
      assert.equal((await req(`/api/novels/${id}`)).statusCode,200);
      const saved=await req(`/api/novels/${id}/chapters/${cid}`);
      assert.equal(saved.json().sourceUrl,'https://example.org/reader/opaque-99/');
    });
    await t.test('reloading an opaque chapter page preserves its reading order',async()=>{
      books.set('pages',{name:'Pages',chapters:[{name:'One',path:'page-one'}],totalPages:3});
      const n=await detail('pages');pages.set('next',[{name:'Two',path:'page-two'}]);pages.set('last',[{name:'Three',path:'page-three'}]);
      for(const page of ['next','last','next'])assert.equal((await req(`/api/novels/${n.id}/chapters/refresh`,'POST',{page})).statusCode,200);
      assert.deepEqual((await req(`/api/novels/${n.id}`)).json().chapters.map((c:any)=>c.title),['One','Two','Three']);
    });
    await t.test('metadata refresh updates the existing EPUB spine before export',async()=>{
      books.set('reorder',{name:'Order',chapters:[{name:'One',path:'order-one'},{name:'Two',path:'order-two'}]});
      let n=await detail('reorder');for(const c of n.chapters)assert.equal((await open(n,c)).statusCode,200);
      books.set('reorder',{name:'Order',chapters:[{name:'New Preface',path:'order-preface'},{name:'Two',path:'order-two'},{name:'One',path:'order-one'}]});
      n=await detail('reorder');
      assert.deepEqual((await inspectArchive(root,n.id))?.chapters.map(c=>[c.title,c.position]),[['Two',1],['One',2]]);
      assert.equal((await open(n,n.chapters[0])).statusCode,200);
      assert.deepEqual((await inspectArchive(root,n.id))?.chapters.map(c=>c.title),['New Preface','Two','One']);
      const exported=await req(`/api/novels/${n.id}/export.epub`);
      assert.equal(exported.rawPayload.readUInt16LE(8),0,'mimetype remains the first uncompressed ZIP member');
      const nameSize=exported.rawPayload.readUInt16LE(26);
      assert.equal(exported.rawPayload.subarray(30,30+nameSize).toString(),'mimetype');
    });
  } finally {
    await app.close();await q('DELETE FROM users WHERE id=$1',[user.id]);await q('DELETE FROM novel_series WHERE source_id=$1',[source.id]);
    await pool.end();await rm(root,{recursive:true,force:true});
  }
});
