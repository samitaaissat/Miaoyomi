import { z } from 'zod';
import { currentSourceRequest, withSourceRequests } from '../sourceRequests';

/** Race even uncooperative engines; handlers consume late rejection without publishing late results. */
function cancellable<T>(signal:AbortSignal,work:()=>Promise<T>):Promise<T> {
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason);
    if(signal.aborted){abort();return;}
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve().then(work).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
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

// Ephemeral discovery-only circuit breaker, isolated by engine (including its credentials).
// Two failures in one minute park a source for 30s; success erases the streak.
interface Health {failures:number;until:number;expires:number}
const activeByEngine=new WeakMap<NovelEngine,Set<string>>();
const healthByEngine=new WeakMap<NovelEngine,Map<string,Health>>();
function discoveryHealth(engine:NovelEngine):Map<string,Health> {
  let health=healthByEngine.get(engine);
  if(!health){health=new Map();healthByEngine.set(engine,health);}
  for(const [id,state] of health)if(state.expires<=Date.now())health.delete(id);
  return health;
}
function failed(health:Map<string,Health>,id:string){
  const failures=(health.get(id)?.failures??0)+1;
  health.delete(id);
  health.set(id,{failures,until:failures>=2?Date.now()+30_000:0,expires:Date.now()+60_000});
  while(health.size>300)health.delete(health.keys().next().value!);
}

export function selectedSourceIds(query:DiscoveryQuery):string[] {
  if(query.sourceId&&query.sourceIds)throw new NovelError(400,'bad_request','Use one source selection field.');
  return [...new Set(query.sourceId?[query.sourceId]:typeof query.sourceIds==='string'?[query.sourceIds]:query.sourceIds||[])];
}

// Keep the decoded scheduling order separate from the page map: JS reorders numeric keys.
const cursorOrders=new WeakMap<Record<string,number>,string[]>();
export function discoveryCursor(cursor?:string):Record<string,number>|undefined {
  if(cursor===undefined)return;
  try{
    if(!/^[A-Za-z0-9_-]+$/.test(cursor))throw Error();
    const parsed=z.discriminatedUnion('version',[
      z.object({version:z.literal(1),pages:z.record(sourceId,sourcePage)}).strict(),
      z.object({version:z.literal(2),pages:z.array(z.tuple([sourceId,sourcePage])).max(300)}).strict(),
    ]).parse(JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')));
    if(parsed.version===2){
      const order=parsed.pages.map(([id])=>id);
      if(new Set(order).size!==order.length)throw Error();
      const pages=Object.fromEntries(parsed.pages);
      cursorOrders.set(pages,order);
      return pages;
    }
    if(Object.keys(parsed.pages).length>300)throw Error();
    return parsed.pages;
  }catch{throw new NovelError(400,'bad_cursor','The discovery cursor is invalid. Restart browsing.');}
}

/** Bound engine catalog requests separately; they have no source to blame on failure. */
export async function discoveryMetadataRequest<T>(work:()=>Promise<T>,budgetMs=2_000):Promise<T> {
  const controller=new AbortController(),inherited=currentSourceRequest().signal;
  const signal=inherited?AbortSignal.any([controller.signal,inherited]):controller.signal;
  const timer=setTimeout(()=>controller.abort(new NovelError(504,'discovery_timeout','The novel source catalog took too long to answer. Try again shortly.')),budgetMs);
  try{return await cancellable(signal,()=>withSourceRequests({signal},work));}
  finally{clearTimeout(timer);}
}

/** Initialize only an already-authorized list; preserve catalog entries when metadata stalls. */
export async function initializeDiscoverySources(engine:NovelEngine,sources:EngineSource[],budgetMs=2_000):Promise<EngineSource[]> {
  const initialized=[...sources],controller=new AbortController();
  const inherited=currentSourceRequest().signal;
  const signal=inherited?AbortSignal.any([controller.signal,inherited]):controller.signal;
  const timer=setTimeout(()=>controller.abort(),budgetMs);
  let index=0;
  async function worker(){
    while(index<sources.length&&!signal.aborted){
      const slot=index++,source=sources[slot];
      if(!source.enabled||!source.supported||source.filters)continue;
      try{initialized[slot]=await cancellable(signal,()=>withSourceRequests({signal},()=>engine.source(source.id)));}
      catch{ /* The catalog remains usable without optional filter metadata. */ }
    }
  }
  try{await Promise.all(Array.from({length:Math.min(4,sources.length)},worker));}
  finally{clearTimeout(timer);}
  if(inherited?.aborted)throw inherited.reason;
  return initialized;
}

/** Sources are authorized by the route before any metadata or website request. */
export async function discoverNovels(engine:NovelEngine,sources:EngineSource[],options:{page:number;pages?:Record<string,number>;mode?:'popular'|'latest';query?:string;filters?:Record<string,unknown>;budgetMs?:number;sourceTimeoutMs?:number;concurrency?:number}) {
  const byId=new Map(sources.map(source=>[source.id,source]));
  const pending=options.pages?(cursorOrders.get(options.pages)??Object.keys(options.pages)).flatMap(id=>byId.has(id)?[byId.get(id)!]:[]):sources;
  const results:Array<{items:NovelCard[];next?:number;error?:SourceFailure}>=new Array(pending.length);
  const budgetMs=options.budgetMs??(pending.length===1?30_000:10_000);
  const scheduleUntil=Date.now()+budgetMs;
  const controller=new AbortController();
  const inherited=currentSourceRequest().signal;
  const signal=inherited?AbortSignal.any([controller.signal,inherited]):controller.signal;
  const timer=setTimeout(()=>controller.abort(new NovelError(504,'discovery_timeout','Discovery reached its response deadline.')),Math.max(0,budgetMs));
  const concurrency=options.concurrency??4;
  if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>32)throw new Error('Invalid discovery concurrency');
  const health=discoveryHealth(engine);
  let active=activeByEngine.get(engine);
  if(!active){active=new Set();activeByEngine.set(engine,active);}
  let index=0;
  // Match the engine's default worker count; its bounded queue absorbs other users' work.
  async function worker(){
    while(index<pending.length&&!signal.aborted&&Date.now()<scheduleUntil){
      const slot=index++,candidate=pending[slot],page=options.pages?.[candidate.id]??options.page;
      let ownsSlot=false;
      const sourceController=new AbortController();
      const sourceSignal=AbortSignal.any([signal,sourceController.signal]);
      const sourceTimer=setTimeout(()=>sourceController.abort(new NovelError(504,'source_timeout','This source took too long to answer. Try again shortly.')),options.sourceTimeoutMs??(pending.length===1?25_000:5_000));
      try{
        if((health.get(candidate.id)?.until??0)>Date.now())throw new NovelError(503,'source_cooldown','This source is temporarily cooling down. Try again shortly.');
        if(active!.has(candidate.id)||active!.size>=300)throw new NovelError(503,'source_busy','This source is already being checked. Try again shortly.');
        active!.add(candidate.id);ownsSlot=true;
        const source=await cancellable(sourceSignal,()=>withSourceRequests({signal:sourceSignal},()=>engine.source(candidate.id)));
        if(!source.enabled||!source.supported)throw new NovelError(409,'source_unavailable',source.reason||'This source is unavailable.');
        const filters:Record<string,unknown>={};
        for(const [key,value] of Object.entries(source.filters||{})){
          const field=value as any;
          if(field&&typeof field.type==='string')filters[key]={type:field.type,value:field.value};
        }
        const raw=options.query===undefined
          ? await cancellable(sourceSignal,()=>withSourceRequests({signal:sourceSignal},()=>engine.invoke(source.id,'popularNovels',[page,{showLatestNovels:options.mode==='latest',filters:options.filters??filters}])))
          : await cancellable(sourceSignal,()=>withSourceRequests({signal:sourceSignal},()=>engine.invoke(source.id,'searchNovels',[options.query,page])));
        const items=normalizeCards(source,raw);
        health.delete(candidate.id);
        results[slot]={items,...(items.length&&page<10000?{next:page+1}:{})};
      }catch(error){
        if(signal.aborted)continue;
        if(!(error instanceof NovelError)||!['source_busy','source_cooldown','source_unavailable','engine_unavailable','engine_unconfigured','QUEUE_OVERLOADED','QUEUE_TIMEOUT'].includes(error.code))failed(health,candidate.id);
        results[slot]={items:[],next:page,error:{sourceId:candidate.id,sourceName:candidate.name,
          code:error instanceof NovelError?error.code:'source_error',
          message:error instanceof NovelError?error.message:'This source could not answer. Try again shortly.'}};
      }finally{clearTimeout(sourceTimer);if(ownsSlot)active!.delete(candidate.id);}
    }
  }
  try{await Promise.all(Array.from({length:Math.min(concurrency,pending.length)},()=>worker()));}
  finally{clearTimeout(timer);}
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
  const entries=([
    ...pending.flatMap((source,i)=>i<index?[]:[[source.id,options.pages?.[source.id]??options.page]]),
    ...pending.flatMap((source,i)=>i>=index||results[i]?[]:[[source.id,options.pages?.[source.id]??options.page]]),
    ...results.flatMap((result,i)=>result.next===undefined?[]:[[pending[i].id,result.next]]),
  ]) as Array<[string,number]>;
  const hasMore=entries.length>0;
  return {items,page:options.page,hasMore,errors:completed.flatMap(result=>result.error?[result.error]:[]),
    ...(hasMore?{nextCursor:Buffer.from(JSON.stringify({version:2,pages:entries})).toString('base64url')}:{})};
}
