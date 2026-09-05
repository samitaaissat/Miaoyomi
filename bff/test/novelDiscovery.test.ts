import test from 'node:test';
import assert from 'node:assert/strict';
import type { EngineSource, NovelEngine } from '../src/lib/novels/apiTypes';

process.env.DATABASE_URL??='postgresql://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET??='novel-discovery-unit-test';

test('discovery uses four concurrent requests and still includes every selected source', async () => {
  const { discoverNovels }=await import('../src/lib/novels/discovery');
  const sources:EngineSource[]=Array.from({length:7},(_,i)=>({id:`source-${i}`,name:`Source ${i}`,lang:'English',site:'https://example.org',version:'1',enabled:true,supported:true}));
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
