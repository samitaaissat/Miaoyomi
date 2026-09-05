import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createReadStream } from 'node:fs';
import { z, ZodError } from 'zod';
import { authenticate, requireAdmin, userIdOf, roleOf } from '../lib/auth';
import { one } from '../lib/db';
import { env } from '../env';
import { viewCtxFor, sourceAllowedFor } from '../lib/visibility';
import { createNovelEngine, resolveSourceUrl } from '../lib/novels/engine';
import { NovelService } from '../lib/novels/service';
import { discoverNovels, discoveryQuery, discoveryCursor, selectedSourceIds, type DiscoveryQuery } from '../lib/novels/discovery';
import * as catalog from '../lib/novels/catalog';
import { NovelError, type NovelEngine, type EngineSource } from '../lib/novels/apiTypes';

const key=z.string().regex(/^[a-f0-9]{64}$/);
const idParams=z.object({id:key});
const chapterParams=idParams.extend({chapterId:key});
const sourceId=z.string().min(1).max(200);
const inputProgress=z.object({chapterId:key,position:z.number().finite().min(0).max(1),completed:z.boolean(),updatedAt:z.number().finite().int().nonnegative(),mutationId:z.string().min(1).max(200)});

export default async function novelRoutes(app:FastifyInstance,opts:{engine?:NovelEngine;archiveRoot?:string}={}) {
  const engine=opts.engine||createNovelEngine();
  const service=new NovelService(engine,opts.archiveRoot||env.NOVEL_LIBRARY_PATH);
  app.addHook('preHandler',authenticate);
  app.addHook('onSend',async (_req,reply,payload)=>{reply.header('Cache-Control','private, no-store');return payload;});
  app.setErrorHandler((err,req,reply)=>{
    if(err instanceof ZodError)return reply.code(400).send({error:'bad_request',message:'Check the request fields.'});
    if(err instanceof NovelError)return reply.code(err.statusCode).send({error:err.code,message:err.message});
    req.log.error(err);
    return reply.code(500).send({error:'internal',message:'The novel request failed.'});
  });

  async function mayFetch(req:FastifyRequest):Promise<void> {
    const user=await one<{role:string;perms:{canDownload?:boolean}|null}>('SELECT role,perms FROM users WHERE id=$1',[userIdOf(req)]);
    if(!user || (user.role!=='admin'&&user.perms?.canDownload===false))throw new NovelError(403,'forbidden','This account cannot retrieve new source content.');
  }
  async function sourceFor(req:FastifyRequest,id:string,enabled=true):Promise<EngineSource> {
    await mayFetch(req);
    const source=await engine.source(id);
    const context=await viewCtxFor(userIdOf(req),roleOf(req));
    if(!sourceAllowedFor(source,context.maxAgeRating))throw new NovelError(403,'forbidden','This source is not available to this account.');
    if(enabled&&(!source.enabled||!source.supported))throw new NovelError(409,'source_unavailable',source.reason||'Enable a supported source to browse it.');
    return source;
  }

  async function discoverySources(req:FastifyRequest,v:DiscoveryQuery,mode?:string):Promise<EngineSource[]> {
    await mayFetch(req);
    const ctx=await viewCtxFor(userIdOf(req),roleOf(req));
    const all=await engine.sources(),ids=selectedSourceIds(v);
    for(const id of ids){
      const source=all.find(s=>s.id===id);
      if(!source)throw new NovelError(404,'unknown_source','Unknown novel source.');
      if(!sourceAllowedFor(source,ctx.maxAgeRating))throw new NovelError(403,'forbidden','This source is not available to this account.');
      if(!source.enabled||!source.supported)throw new NovelError(409,'source_unavailable',source.reason||'Enable a supported source to browse it.');
    }
    return all.filter(s=>s.enabled&&s.supported&&sourceAllowedFor(s,ctx.maxAgeRating)
      &&(!ids.length||ids.includes(s.id))&&(!v.lang||v.lang==='all'||s.lang.toLowerCase()===v.lang.toLowerCase())
      &&(mode!=='latest'||s.supportsLatest));
  }

  app.get('/api/novels/sources',async req=>{
    await mayFetch(req);
    const ctx=await viewCtxFor(userIdOf(req),roleOf(req));
    const sources=(await engine.sources()).filter(s=>sourceAllowedFor(s,ctx.maxAgeRating));
    // Enabled state survives engine restarts; runtime filter metadata is initialized lazily.
    // Resolve sequentially so a large enabled list cannot exceed the private engine's worker limit.
    for(let i=0;i<sources.length;i++)if(sources[i].enabled&&sources[i].supported&&!sources[i].filters) {
      try{sources[i]=await engine.source(sources[i].id);}
      catch(error){req.log.warn({err:error,sourceId:sources[i].id},'Novel source metadata could not initialize');}
    }
    return {sources};
  });
  app.post('/api/novels/sources/:sourceId',{preHandler:requireAdmin},async req=>{
    const id=sourceId.parse((req.params as any).sourceId);
    const {enabled}=z.object({enabled:z.boolean()}).parse(req.body);
    return {source:await engine.enable(id,enabled)};
  });
  app.get('/api/novels/browse',async req=>{
    const v=discoveryQuery.extend({mode:z.enum(['popular','latest']).default('popular'),filters:z.string().max(20000).optional()}).parse(req.query);
    const pages=discoveryCursor(v.cursor);
    let filters:Record<string,unknown>|undefined;
    if(v.filters){try{filters=z.record(z.unknown()).parse(JSON.parse(v.filters));}catch{throw new NovelError(400,'bad_filters','The source filters are invalid.');}}
    if(filters&&Object.keys(filters).length&&selectedSourceIds(v).length!==1)throw new NovelError(400,'bad_filters','Select one source to use its catalog filters.');
    const sources=await discoverySources(req,v,v.mode);
    return discoverNovels(engine,sources,{page:v.page,pages,mode:v.mode,filters:filters&&Object.keys(filters).length?filters:undefined});
  });
  app.get('/api/novels/search',async req=>{
    const v=discoveryQuery.extend({q:z.string().trim().min(1).max(500)}).parse(req.query);
    const pages=discoveryCursor(v.cursor),sources=await discoverySources(req,v);
    return discoverNovels(engine,sources,{page:v.page,pages,query:v.q});
  });
  app.get('/api/novels/detail',async req=>{
    const v=z.object({sourceId,path:z.string().min(1).max(8000)}).parse(req.query);
    const source=await sourceFor(req,v.sourceId);
    const raw=await engine.invoke(source.id,'parseNovel',[v.path]);
    const url=await resolveSourceUrl(engine,source,v.path,true);
    const detail=await catalog.storeDetail(userIdOf(req),source,v.path,raw,url);
    return service.detail(userIdOf(req),detail.id);
  });
  app.get('/api/novels/library',async req=>({items:await catalog.listLibrary(userIdOf(req))}));
  app.get('/api/novels/:id',async req=>service.detail(userIdOf(req),idParams.parse(req.params).id));
  app.put('/api/novels/:id/library',async req=>{
    const {id}=idParams.parse(req.params),{saved}=z.object({saved:z.boolean()}).parse(req.body);
    await catalog.saveToLibrary(userIdOf(req),id,saved);return {ok:true};
  });
  app.post('/api/novels/:id/chapters/refresh',async req=>{
    const {id}=idParams.parse(req.params),{page}=z.object({page:z.string().min(1).max(100)}).parse(req.body);
    const detail=await catalog.getDetail(userIdOf(req),id),source=await sourceFor(req,detail.sourceId);
    const raw=await engine.invoke(source.id,'parsePage',[detail.path,page]);
    await catalog.addChapterPage(userIdOf(req),id,source,page,raw);return service.detail(userIdOf(req),id);
  });
  app.post('/api/novels/:id/chapters/:chapterId/open',async req=>{
    const {id,chapterId}=chapterParams.parse(req.params);
    return service.chapter(userIdOf(req),id,chapterId,sourceId=>sourceFor(req,sourceId));
  });
  app.get('/api/novels/:id/chapters/:chapterId',async req=>{
    const {id,chapterId}=chapterParams.parse(req.params);return service.chapter(userIdOf(req),id,chapterId,false);
  });
  app.get('/api/novels/:id/progress',async req=>{
    const {id}=idParams.parse(req.params);await catalog.getDetail(userIdOf(req),id);
    return {progress:await catalog.getProgress(userIdOf(req),id)};
  });
  app.put('/api/novels/:id/progress',async req=>{
    const {id}=idParams.parse(req.params);return {progress:await catalog.putProgress(userIdOf(req),id,inputProgress.parse(req.body))};
  });
  app.get('/api/novels/:id/export.epub',async (req,reply)=>{
    const {id}=idParams.parse(req.params);const path=await service.exportFile(userIdOf(req),id);
    return reply.type('application/epub+zip').header('Content-Disposition',`attachment; filename="${id}.epub"`).send(createReadStream(path));
  });
}
