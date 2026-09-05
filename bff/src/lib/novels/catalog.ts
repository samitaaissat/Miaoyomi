import { z } from 'zod';
import { q, tx } from '../db';
import { novelId, chapterId } from './identity';
import { NovelError, type EngineSource, type NovelCard, type NovelDetail } from './apiTypes';
import { mergeNovelProgress, type NovelProgress } from './progress';

export type Query = <T = any>(sql: string, params?: any[]) => Promise<T[]>;
const itemSchema = z.object({name:z.string().min(1).max(2000),path:z.string().min(1).max(8000),cover:z.string().optional()});
const chapterSchema = z.object({name:z.string().min(1).max(2000),path:z.string().min(1).max(8000),chapterNumber:z.number().finite().optional()});
const metadataSchema = z.object({name:z.string().min(1).max(2000),author:z.string().optional(),summary:z.string().optional(),cover:z.string().optional(),chapters:z.array(chapterSchema).max(100000).default([]),totalPages:z.number().int().positive().max(10000).optional()});

export function sourceUrl(source: {site:string}, path: string): string {
  try {
    const url = new URL(path, source.site.replace(/\/$/, '') + '/');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error();
    return url.href;
  } catch { throw new NovelError(502, 'invalid_source_url', 'The source returned an invalid link.'); }
}
function coverUrl(source: EngineSource, cover?: string): string | undefined {
  if (!cover) return undefined;
  try { return sourceUrl(source, cover); } catch { return undefined; }
}
function language(lang: string): string {
  const names:Record<string,string>={english:'en',french:'fr','français':'fr',spanish:'es',german:'de',portuguese:'pt',russian:'ru',japanese:'ja',chinese:'zh',korean:'ko',arabic:'ar',indonesian:'id',turkish:'tr'};
  return names[lang.toLowerCase()] || (/^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(lang) ? lang : 'und');
}
export function normalizeCards(source: EngineSource, raw: unknown): NovelCard[] {
  const parsed=z.array(itemSchema).max(1000).safeParse(raw);
  if (!parsed.success) throw new NovelError(502,'invalid_source_result','The source returned an invalid catalog.');
  return parsed.data.map(v=>({sourceId:source.id,path:v.path,title:v.name,cover:coverUrl(source,v.cover),id:novelId(source.id,v.path)}));
}

export async function storeDetail(userId:string,source:EngineSource,path:string,raw:unknown,resolvedUrl?:string):Promise<NovelDetail> {
  const parsed=metadataSchema.safeParse(raw);
  if (!parsed.success) throw new NovelError(502,'invalid_source_result','The source returned invalid novel details.');
  const data=parsed.data, id=novelId(source.id,path);
  await tx(async qq=>{
    await qq('SELECT pg_advisory_xact_lock(hashtext($1))',[`novel-archive:${id}`]);
    await qq(`INSERT INTO novel_series(id,source_id,source_path,source_url,title,language,author,summary,cover,total_pages)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,
      author=EXCLUDED.author,summary=EXCLUDED.summary,cover=EXCLUDED.cover,total_pages=EXCLUDED.total_pages,source_url=EXCLUDED.source_url,updated_at=now()`,
      [id,source.id,path,sourceUrl(source,resolvedUrl||path),data.name,language(source.lang),data.author?.slice(0,4000)||null,data.summary?.slice(0,100000)||null,coverUrl(source,data.cover)||null,data.totalPages||null]);
    await qq(`INSERT INTO novel_user_library(user_id,novel_id) VALUES($1,$2)
      ON CONFLICT(user_id,novel_id) DO UPDATE SET accessed_at=now()`,[userId,id]);
    await storeChapterRows(qq,id,source,data.chapters,0);
    await qq("INSERT INTO novel_chapter_pages(novel_id,source_page,position_offset) VALUES($1,'1',0) ON CONFLICT DO NOTHING",[id]);
  });
  return getDetail(userId,id);
}

async function storeChapterRows(qq:Query,id:string,source:EngineSource,chapters:z.infer<typeof chapterSchema>[],offset:number):Promise<void> {
  // One batch avoids a network round trip for every chapter in a long novel.
  const seen=new Set<string>();
  const rows=chapters.flatMap((c,i)=>{
    const cid=chapterId(id,c.path); if(seen.has(cid))return []; seen.add(cid);
    return [{id:cid,path:c.path,url:sourceUrl(source,c.path),title:c.name,number:c.chapterNumber??null,position:offset+i}];
  });
  await qq(`INSERT INTO novel_chapters(id,novel_id,source_path,source_url,title,chapter_number,position)
    SELECT x.id,$1,x.path,x.url,x.title,x.number,x.position
    FROM jsonb_to_recordset($2::jsonb) AS x(id text,path text,url text,title text,number double precision,position integer)
    ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,chapter_number=EXCLUDED.chapter_number,position=EXCLUDED.position`,[id,JSON.stringify(rows)]);
}

export async function addChapterPage(userId:string,id:string,source:EngineSource,page:string,raw:unknown):Promise<NovelDetail> {
  const parsed=z.object({chapters:z.array(chapterSchema).max(100000)}).safeParse(raw);
  if(!parsed.success)throw new NovelError(502,'invalid_source_result','The source returned an invalid chapter list.');
  await tx(async qq=>{
    await qq('SELECT pg_advisory_xact_lock(hashtext($1))',[`novel-archive:${id}`]);
    await getDetail(userId,id,qq);
    const [existing]=await qq<{position_offset:number}>('SELECT position_offset FROM novel_chapter_pages WHERE novel_id=$1 AND source_page=$2',[id,page]);
    let offset=existing?.position_offset;
    if(offset===undefined){
      const numeric=Number(page);
      offset=Number.isInteger(numeric)&&numeric>0&&numeric<=10000 ? (numeric-1)*100000 :
        (await qq<{n:number}>('SELECT ((floor(COALESCE(max(position),-1)::numeric/100000)+1)*100000)::integer n FROM novel_chapters WHERE novel_id=$1',[id]))[0].n;
      await qq('INSERT INTO novel_chapter_pages(novel_id,source_page,position_offset) VALUES($1,$2,$3)',[id,page,offset]);
    }
    await storeChapterRows(qq,id,source,parsed.data.chapters,offset);
  });
  return getDetail(userId,id);
}

export async function getDetail(userId:string,id:string,qq:Query=q):Promise<NovelDetail> {
  const [row]=await qq(`SELECT n.*,u.in_library FROM novel_series n JOIN novel_user_library u ON u.novel_id=n.id
    WHERE n.id=$1 AND u.user_id=$2`,[id,userId]);
  if(!row)throw new NovelError(404,'not_found','This novel is not in your reading catalog.');
  const chapters=await qq(`SELECT id,source_path AS path,title,chapter_number AS number,position,saved
    FROM novel_chapters WHERE novel_id=$1 ORDER BY position,id`,[id]);
  return {id:row.id,sourceId:row.source_id,path:row.source_path,title:row.title,cover:row.cover||undefined,
    author:row.author||undefined,summary:row.summary||undefined,language:row.language,totalPages:row.total_pages||undefined,
    inLibrary:row.in_library,chapters:chapters.map(c=>({...c,number:c.number??undefined}))};
}

export async function getProgress(userId:string,id:string,qq:Query=q):Promise<NovelProgress|null> {
  const [row]=await qq(`SELECT chapter_id AS "chapterId",position,completed,updated_at AS "updatedAt",mutation_id AS "mutationId"
    FROM novel_progress WHERE user_id=$1 AND novel_id=$2 ORDER BY updated_at DESC,chapter_id LIMIT 1`,[userId,id]);
  return row||null;
}
export async function putProgress(userId:string,id:string,incoming:NovelProgress):Promise<NovelProgress> {
  return tx(async qq=>{
    await qq('SELECT pg_advisory_xact_lock(hashtext($1))',[`novel-progress:${userId}:${id}`]);
    const detail=await getDetail(userId,id,qq);
    if(!detail.chapters.some(c=>c.id===incoming.chapterId))throw new NovelError(404,'not_found','This chapter does not belong to the novel.');
    const [old]=await qq<NovelProgress>(`SELECT chapter_id AS "chapterId",position,completed,updated_at AS "updatedAt",mutation_id AS "mutationId"
      FROM novel_progress WHERE user_id=$1 AND chapter_id=$2`,[userId,incoming.chapterId]);
    const merged=mergeNovelProgress(old||null,incoming);
    await qq(`INSERT INTO novel_progress(user_id,novel_id,chapter_id,position,completed,updated_at,mutation_id)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,chapter_id) DO UPDATE SET position=EXCLUDED.position,
      completed=EXCLUDED.completed,updated_at=EXCLUDED.updated_at,mutation_id=EXCLUDED.mutation_id`,
      [userId,id,merged.chapterId,merged.position,merged.completed,merged.updatedAt,merged.mutationId]);
    return merged;
  });
}

export async function listLibrary(userId:string):Promise<Array<NovelDetail&{progress?:NovelProgress}>> {
  const ids=await q<{novel_id:string}>(`SELECT u.novel_id FROM novel_user_library u
    WHERE u.user_id=$1 AND (u.in_library OR EXISTS(SELECT 1 FROM novel_progress p WHERE p.user_id=u.user_id AND p.novel_id=u.novel_id))
    ORDER BY u.accessed_at DESC LIMIT 500`,[userId]);
  return Promise.all(ids.map(async row=>({...await getDetail(userId,row.novel_id),progress:(await getProgress(userId,row.novel_id))||undefined})));
}

export async function saveToLibrary(userId:string,id:string,saved:boolean):Promise<void> {
  await getDetail(userId,id);
  await q('UPDATE novel_user_library SET in_library=$3,accessed_at=now() WHERE user_id=$1 AND novel_id=$2',[userId,id,saved]);
}
