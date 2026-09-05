import { q, tx } from '../db';
import { appendChapter, readChapter, inspectArchive, archivePath, updateChapterOrder } from './archive';
import * as catalog from './catalog';
import { NovelError, type NovelEngine, type NovelPayload, type NovelDetail, type EngineSource } from './apiTypes';
import { resolveSourceUrl } from './engine';

/** The application owns artifacts; the plugin service never receives filesystem or database access. */
export class NovelService {
  constructor(readonly engine: NovelEngine, readonly root: string) {}

  private async reconcile(id: string, qq: catalog.Query): Promise<void> {
    const artifact = await inspectArchive(this.root, id);
    const chapters = artifact?.chapters || [];
    // Recover an artifact replacement which succeeded just before the database transaction failed.
    for (const c of chapters) {
      await qq(`INSERT INTO novel_chapters(id,novel_id,source_path,source_url,title,position,saved)
        VALUES($1,$2,$3,$4,$5,$6,true) ON CONFLICT(id) DO UPDATE SET source_url=EXCLUDED.source_url`,
        [c.id,id,c.sourcePath,c.sourceUrl,c.title,c.position]);
    }
    await qq('UPDATE novel_chapters SET saved=(id=ANY($2::text[])) WHERE novel_id=$1',[id,chapters.map(c=>c.id)]);
    if(artifact){
      const positions=await qq<{id:string;position:number}>('SELECT id,position FROM novel_chapters WHERE novel_id=$1',[id]);
      await updateChapterOrder(this.root,id,positions);
    }
  }

  async detail(user: string, id: string): Promise<NovelDetail> {
    return tx(async qq=>{
      await catalog.getDetail(user,id,qq);
      await qq('SELECT pg_advisory_xact_lock(hashtext($1))',[`novel-archive:${id}`]);
      await this.reconcile(id,qq);
      return catalog.getDetail(user,id,qq);
    });
  }

  async chapter(user: string, id: string, cid: string, authorizeFetch: false | ((sourceId:string)=>Promise<EngineSource>)): Promise<NovelPayload> {
    let detail = await catalog.getDetail(user,id);
    let chapter = detail.chapters.find(c=>c.id===cid);
    if (!chapter) throw new NovelError(404,'not_found','This chapter does not belong to the novel.');
    let stored = await readChapter(this.root,id,cid);
    if (!stored && !authorizeFetch) throw new NovelError(404,'not_saved','This chapter has not been saved yet.');
    if (!stored) {
      // SQL saved flags are recoverable metadata, never an authorization decision.
      const source = await (authorizeFetch as (sourceId:string)=>Promise<EngineSource>)(detail.sourceId);
      if (!source.enabled || !source.supported) throw new NovelError(409,'source_unavailable',source.reason||'Enable a supported source to retrieve this chapter.');
      const raw = await this.engine.invoke(detail.sourceId,'parseChapter',[chapter.path]);
      if (typeof raw !== 'string' || !raw.trim() || raw.length > 10*1024*1024) throw new NovelError(502,'invalid_chapter','The source returned an empty or oversized chapter.');
      const chapterUrl=await resolveSourceUrl(this.engine,source,chapter.path,false);
      await tx(async qq=>{
        await qq('SELECT pg_advisory_xact_lock(hashtext($1))',[`novel-archive:${id}`]);
        await this.reconcile(id,qq);
        detail=await catalog.getDetail(user,id,qq);
        chapter=detail.chapters.find(c=>c.id===cid);
        if (!chapter) throw new NovelError(404,'not_found','This chapter is no longer available.');
        if (!await readChapter(this.root,id,cid)) {
          const [novel]=await qq<{source_url:string}>('SELECT source_url FROM novel_series WHERE id=$1',[id]);
          await appendChapter(this.root, {
            id,title:detail.title,language:detail.language,author:detail.author,sourceId:detail.sourceId,
            sourcePath:detail.path,sourceUrl:novel.source_url,
          }, {
            id:cid,title:chapter.title,position:chapter.position,sourcePath:chapter.path,
            sourceUrl:chapterUrl,html:raw,
          }, url=>this.engine.asset(detail.sourceId,url));
          await qq('UPDATE novel_chapters SET source_url=$2 WHERE id=$1',[cid,chapterUrl]);
        }
        await this.reconcile(id,qq);
      });
      stored=await readChapter(this.root,id,cid);
    }
    if (!stored) throw new NovelError(500,'archive_missing','The saved chapter could not be opened.');
    // Do not store chapter bodies in SQL. The response is reconstructed from the standard archive.
    const [row]=await q<{source_url:string}>('SELECT source_url FROM novel_chapters WHERE id=$1 AND novel_id=$2',[cid,id]);
    const index=detail.chapters.findIndex(c=>c.id===cid);
    return {novelId:id,chapterId:cid,novelTitle:detail.title,chapterTitle:detail.chapters[index].title,
      html:stored.html,sourceUrl:row.source_url,archiveRevision:stored.revision,
      previousChapterId:detail.chapters[index-1]?.id,nextChapterId:detail.chapters[index+1]?.id};
  }

  async exportFile(user: string, id: string): Promise<string> {
    await this.detail(user,id);
    if (!await inspectArchive(this.root,id)) throw new NovelError(404,'not_saved','Read or save a chapter before exporting this novel.');
    return archivePath(this.root,id);
  }
}
