import { z } from 'zod';
import { normalizeCards } from './catalog';
import { NovelError, type EngineSource, type NovelCard, type NovelEngine } from './apiTypes';

const sourceId=z.string().min(1).max(200);
const sourcePage=z.number().int().min(1).max(10000);
export const discoveryQuery=z.object({
  sourceId:sourceId.optional(),
  sourceIds:z.union([sourceId,z.array(sourceId).min(1).max(300)]).optional(),
  lang:z.string().trim().min(1).max(100).optional(),
  page:z.coerce.number().int().min(1).max(10000).default(1),
  cursor:z.string().max(100000).optional(),
});
export type DiscoveryQuery=z.infer<typeof discoveryQuery>;
export interface SourceFailure {sourceId:string;sourceName:string;code:string;message:string}

export function selectedSourceIds(query:DiscoveryQuery):string[] {
  if(query.sourceId&&query.sourceIds)throw new NovelError(400,'bad_request','Use one source selection field.');
  return [...new Set(query.sourceId?[query.sourceId]:typeof query.sourceIds==='string'?[query.sourceIds]:query.sourceIds||[])];
}

export function discoveryCursor(cursor?:string):Record<string,number>|undefined {
  if(cursor===undefined)return;
  try{
    if(!/^[A-Za-z0-9_-]+$/.test(cursor))throw Error();
    const parsed=z.object({version:z.literal(1),pages:z.record(sourceId,sourcePage)}).strict().parse(JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')));
    if(Object.keys(parsed.pages).length>300)throw Error();
    return parsed.pages;
  }catch{throw new NovelError(400,'bad_cursor','The discovery cursor is invalid. Restart browsing.');}
}

/** Sources are authorized by the route before any metadata or website request. */
export async function discoverNovels(engine:NovelEngine,sources:EngineSource[],options:{page:number;pages?:Record<string,number>;mode?:'popular'|'latest';query?:string;filters?:Record<string,unknown>;budgetMs?:number}) {
  const byId=new Map(sources.map(source=>[source.id,source]));
  const pending=options.pages?Object.keys(options.pages).flatMap(id=>byId.has(id)?[byId.get(id)!]:[]):sources;
  const results:Array<{items:NovelCard[];next?:number;error?:SourceFailure}>=new Array(pending.length);
  const scheduleUntil=Date.now()+(options.budgetMs??10_000);
  let index=0;
  // The private engine has two workers. Keep every source in scope without flooding it.
  async function worker(){
    while(index<pending.length&&(index<2||Date.now()<scheduleUntil)){
      const slot=index++,candidate=pending[slot],page=options.pages?.[candidate.id]??options.page;
      try{
        const source=await engine.source(candidate.id);
        if(!source.enabled||!source.supported)throw new NovelError(409,'source_unavailable',source.reason||'This source is unavailable.');
        const filters:Record<string,unknown>={};
        for(const [key,value] of Object.entries(source.filters||{})){
          const field=value as any;
          if(field&&typeof field.type==='string')filters[key]={type:field.type,value:field.value};
        }
        const raw=options.query===undefined
          ? await engine.invoke(source.id,'popularNovels',[page,{showLatestNovels:options.mode==='latest',filters:options.filters??filters}])
          : await engine.invoke(source.id,'searchNovels',[options.query,page]);
        const items=normalizeCards(source,raw);
        results[slot]={items,...(items.length&&page<10000?{next:page+1}:{})};
      }catch(error){
        results[slot]={items:[],next:page,error:{sourceId:candidate.id,sourceName:candidate.name,
          code:error instanceof NovelError?error.code:'source_error',
          message:error instanceof NovelError?error.message:'This source could not answer. Try again shortly.'}};
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(2,pending.length)},()=>worker()));
  // Interleave catalogs so the first screen represents every responding source.
  const items:NovelCard[]=[];
  const seen=new Set<string>();
  const completed=results.filter(Boolean);
  const longest=Math.max(0,...completed.map(result=>result.items.length));
  for(let row=0;row<longest;row++)for(const result of completed){
    const item=result.items[row];
    if(item){const key=JSON.stringify([item.sourceId,item.path]);if(!seen.has(key)){seen.add(key);items.push(item);}}
  }
  // If slow sites consume the scheduling budget, carry every unstarted source
  // forward first. No source is dropped or starved by earlier sources' next pages.
  const pages=Object.fromEntries([
    ...pending.flatMap((source,i)=>results[i]?[]:[[source.id,options.pages?.[source.id]??options.page]]),
    ...results.flatMap((result,i)=>result.next===undefined?[]:[[pending[i].id,result.next]]),
  ]);
  const hasMore=Object.keys(pages).length>0;
  return {items,page:options.page,hasMore,errors:completed.flatMap(result=>result.error?[result.error]:[]),
    ...(hasMore?{nextCursor:Buffer.from(JSON.stringify({version:1,pages})).toString('base64url')}:{})};
}
