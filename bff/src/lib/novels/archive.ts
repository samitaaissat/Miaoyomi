import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import AdmZip from 'adm-zip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { assertArchiveId, assertIdentityPart, chapterId, novelId } from './identity';
import { escapeXml as x, httpUrl, sanitizeChapter, type EmbeddedAsset } from './sanitize';
import type { ArchiveNovel, ArchiveChapter, ArchivedChapter, AssetFetcher } from './types';
export type { ArchiveNovel, ArchiveChapter, AssetFetcher } from './types';

const OPF = 'http://www.idpf.org/2007/opf';
const XHTML = 'http://www.w3.org/1999/xhtml';
const queues = new Map<string, Promise<unknown>>();
type ArchiveState = { revision: string; chapters: ArchivedChapter[]; zip: AdmZip };

export function archivePath(root: string, novelId: string): string {
  assertArchiveId(novelId);
  return join(resolve(root), `${novelId}.epub`);
}
function parseXml(value: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(value)) throw new Error('Unsupported archive XML declaration');
  return new DOMParser({onError: (_level, message) => { throw new Error(`Invalid archive XML: ${message}`); }}).parseFromString(value, 'application/xml');
}
async function load(root: string, id: string): Promise<ArchiveState | null> {
  const path = archivePath(root, id);
  let bytes: Buffer;
  try { bytes = await readFile(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  const zip = new AdmZip(bytes);
  if (zip.readAsText('mimetype') !== 'application/epub+zip') throw new Error('Invalid EPUB archive');
  const doc = parseXml(zip.readAsText('EPUB/package.opf'));
  const chapters: ArchivedChapter[] = [];
  for (const meta of Array.from(doc.getElementsByTagNameNS(OPF, 'meta'))) {
    if (meta.getAttribute('property') !== 'miaoyomi:chapter') continue;
    const value = JSON.parse(meta.textContent || '') as ArchivedChapter;
    validateChapter(id, {...value, html: ''});
    if (chapters.some(c=>c.id === value.id)) throw new Error('Duplicate EPUB chapter');
    if (!zip.getEntry(`EPUB/chapters/${value.id}.xhtml`)) throw new Error('Missing EPUB chapter');
    chapters.push(value);
  }
  if (!chapters.length) throw new Error('Missing EPUB chapter provenance');
  chapters.sort((a,b)=>a.position-b.position || a.id.localeCompare(b.id));
  return {revision: createHash('sha256').update(bytes).digest('hex'), chapters, zip};
}
export async function inspectArchive(root: string, novelId: string): Promise<{revision: string; chapters: ArchivedChapter[]} | null> {
  const saved = await load(root, novelId);
  return saved && {revision: saved.revision, chapters: saved.chapters};
}

/** Refresh the standard spine/navigation when a source reorders metadata, without fetching prose. */
export async function updateChapterOrder(root: string, id: string, positions: Array<{id:string;position:number}>): Promise<void> {
  const path=archivePath(root,id);
  const previous=queues.get(path)||Promise.resolve();
  const current=previous.catch(()=>{}).then(async()=>{
    const saved=await load(root,id);if(!saved)return;
    const order=new Map(positions.map(c=>[c.id,c.position]));
    const chapters=saved.chapters.map(c=>({...c,position:order.get(c.id)??c.position}));
    for(const c of chapters)validateChapter(id,{...c,html:''});
    if(chapters.every((c,i)=>c.position===saved.chapters[i].position))return;
    chapters.sort((a,b)=>a.position-b.position||a.id.localeCompare(b.id));
    const opf=parseXml(saved.zip.readAsText('EPUB/package.opf'));
    const byId=new Map(chapters.map(c=>[c.id,c]));
    for(const meta of Array.from(opf.getElementsByTagNameNS(OPF,'meta'))){
      if(meta.getAttribute('property')==='miaoyomi:chapter'){
        const before=JSON.parse(meta.textContent||'') as ArchivedChapter;
        meta.textContent=JSON.stringify(byId.get(before.id));
      }
      if(meta.getAttribute('property')==='dcterms:modified')meta.textContent=new Date().toISOString().replace(/\.\d{3}Z$/,'Z');
    }
    const spine=opf.getElementsByTagNameNS(OPF,'spine')[0];
    if(!spine)throw new Error('Missing EPUB spine');
    while(spine.firstChild)spine.removeChild(spine.firstChild);
    for(const c of chapters){const item=opf.createElementNS(OPF,'itemref');item.setAttribute('idref',`c-${c.id}`);spine.appendChild(item);}
    const nav=parseXml(saved.zip.readAsText('EPUB/nav.xhtml'));
    const list=nav.getElementsByTagNameNS(XHTML,'ol')[0];
    if(!list)throw new Error('Missing EPUB navigation');
    while(list.firstChild)list.removeChild(list.firstChild);
    for(const c of chapters){
      const li=nav.createElementNS(XHTML,'li'),a=nav.createElementNS(XHTML,'a');
      a.setAttribute('href',`chapters/${c.id}.xhtml`);a.appendChild(nav.createTextNode(c.title));li.appendChild(a);list.appendChild(li);
    }
    const serializer=new XMLSerializer();
    const zip=new AdmZip({noSort:true});
    zip.addFile('mimetype',Buffer.from('application/epub+zip'));zip.getEntry('mimetype')!.header.method=0;
    for(const entry of saved.zip.getEntries()){
      if(entry.entryName==='mimetype')continue;
      const bytes=entry.entryName==='EPUB/package.opf'?Buffer.from(serializer.serializeToString(opf)):
        entry.entryName==='EPUB/nav.xhtml'?Buffer.from(serializer.serializeToString(nav)):entry.getData();
      zip.addFile(entry.entryName,bytes);
    }
    await writeAtomically(root,id,zip.toBuffer());
  });
  queues.set(path,current);
  try{await current;}finally{if(queues.get(path)===current)queues.delete(path);}
}
export async function readChapter(root: string, novelId: string, chapterId: string): Promise<{html: string; revision: string; chapterIds: string[]} | null> {
  assertArchiveId(chapterId);
  const saved = await load(root, novelId);
  if (!saved || !saved.chapters.some(c=>c.id === chapterId)) return null;
  const doc = parseXml(saved.zip.readAsText(`EPUB/chapters/${chapterId}.xhtml`));
  const body = doc.getElementsByTagNameNS(XHTML, 'body')[0];
  if (!body) throw new Error('Missing EPUB chapter body');
  for (const image of Array.from(body.getElementsByTagNameNS(XHTML, 'img'))) {
    const src = image.getAttribute('src') || '';
    if (!/^\.\.\/assets\/[a-f0-9]{64}\.(png|jpg|gif)$/.test(src)) throw new Error('Invalid EPUB image path');
    const entry = saved.zip.getEntry(`EPUB/${src.slice(3)}`);
    if (!entry) throw new Error('Missing EPUB image');
    const mime = src.endsWith('.png') ? 'image/png' : src.endsWith('.jpg') ? 'image/jpeg' : 'image/gif';
    image.setAttribute('src', `data:${mime};base64,${entry.getData().toString('base64')}`);
  }
  const serializer = new XMLSerializer();
  const html = Array.from(body.childNodes).map(n=>serializer.serializeToString(n)).join('');
  return {html, revision: saved.revision, chapterIds: saved.chapters.map(c=>c.id)};
}
function validateChapter(id: string, chapter: ArchiveChapter): void {
  assertArchiveId(chapter.id); assertIdentityPart(chapter.sourcePath);
  if (chapter.id !== chapterId(id, chapter.sourcePath)) throw new Error('Chapter identity does not match provenance');
  if (typeof chapter.title !== 'string' || !chapter.title.trim() || !Number.isFinite(chapter.position) || chapter.position < 0) throw new Error('Invalid chapter metadata');
  httpUrl(chapter.sourceUrl);
}
function document(title: string, language: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><html xmlns="${XHTML}" xmlns:epub="http://www.idpf.org/2007/ops" lang="${x(language)}" xml:lang="${x(language)}"><head><title>${x(title)}</title></head><body>${body}</body></html>`;
}

// This queue protects callers in this process. The caller MUST also hold its
// authoritative database advisory lock for this novel across appendChapter;
// an in-memory queue alone cannot prevent lost updates between BFF processes.
export async function appendChapter(root: string, novel: ArchiveNovel, chapter: ArchiveChapter, fetchAsset: AssetFetcher): Promise<{revision: string}> {
  const path = archivePath(root, novel.id);
  const previous = queues.get(path) || Promise.resolve();
  const current = previous.catch(()=>{}).then(()=>appendUnlocked(root, novel, chapter, fetchAsset));
  queues.set(path, current);
  try { return await current; } finally { if (queues.get(path) === current) queues.delete(path); }
}
async function appendUnlocked(root: string, novel: ArchiveNovel, chapter: ArchiveChapter, fetchAsset: AssetFetcher): Promise<{revision: string}> {
  if (novel.id !== novelId(novel.sourceId, novel.sourcePath)) throw new Error('Novel identity does not match provenance');
  if (typeof novel.title !== 'string' || !novel.title.trim() || typeof novel.language !== 'string' || !/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/.test(novel.language)) throw new Error('Invalid novel metadata');
  httpUrl(novel.sourceUrl); validateChapter(novel.id, chapter);
  const saved = await load(root, novel.id);
  const sanitized = await sanitizeChapter(chapter.html, chapter.sourceUrl, fetchAsset);
  const {html: _html, ...provenance} = chapter;
  const chapters = [...(saved?.chapters || []).filter(c=>c.id !== chapter.id), provenance].sort((a,b)=>a.position-b.position || a.id.localeCompare(b.id));
  const zip = new AdmZip({noSort: true});
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.getEntry('mimetype')!.header.method = 0;
  zip.addFile('META-INF/container.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'));
  const assets = new Map<string, EmbeddedAsset>();
  for (const c of chapters) {
    const content = c.id === chapter.id ? document(c.title, novel.language, sanitized.html) : saved!.zip.readAsText(`EPUB/chapters/${c.id}.xhtml`);
    zip.addFile(`EPUB/chapters/${c.id}.xhtml`, Buffer.from(content));
    // Copy only referenced assets; chapter replacement does not accumulate images.
    if (c.id !== chapter.id) {
      const doc = parseXml(content);
      for (const image of Array.from(doc.getElementsByTagNameNS(XHTML,'img'))) {
        const src = image.getAttribute('src') || '';
        if (!/^\.\.\/assets\/[a-f0-9]{64}\.(png|jpg|gif)$/.test(src)) throw new Error('Invalid EPUB image path');
        const path = src.slice(3), entry = saved!.zip.getEntry(`EPUB/${path}`);
        if (!entry) throw new Error('Missing EPUB image');
        assets.set(path,{path,bytes:entry.getData(),contentType:path.endsWith('.png')?'image/png':path.endsWith('.jpg')?'image/jpeg':'image/gif'});
      }
    }
  }
  for (const asset of sanitized.assets) assets.set(asset.path,asset);
  for (const asset of assets.values()) zip.addFile(`EPUB/${asset.path}`, asset.bytes);
  const metadata = `<dc:identifier id="book-id">urn:sha256:${novel.id}</dc:identifier><dc:title>${x(novel.title)}</dc:title><dc:language>${x(novel.language)}</dc:language>${novel.author?`<dc:creator>${x(novel.author)}</dc:creator>`:''}<dc:source>${x(novel.sourceUrl)}</dc:source><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}</meta><meta property="miaoyomi:source">${x(JSON.stringify({sourceId:novel.sourceId,sourcePath:novel.sourcePath}))}</meta>${chapters.map(c=>`<meta property="miaoyomi:chapter">${x(JSON.stringify(c))}</meta>`).join('')}`;
  const manifest = `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${chapters.map(c=>`<item id="c-${c.id}" href="chapters/${c.id}.xhtml" media-type="application/xhtml+xml"/>`).join('')}${[...assets.values()].map((a,i)=>`<item id="image-${i}" href="${a.path}" media-type="${a.contentType}"/>`).join('')}`;
  const opf = `<?xml version="1.0" encoding="UTF-8"?><package xmlns="${OPF}" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0" unique-identifier="book-id" prefix="miaoyomi: https://miaoyomi.org/ns/epub#"><metadata>${metadata}</metadata><manifest>${manifest}</manifest><spine>${chapters.map(c=>`<itemref idref="c-${c.id}"/>`).join('')}</spine></package>`;
  zip.addFile('EPUB/package.opf', Buffer.from(opf));
  zip.addFile('EPUB/nav.xhtml', Buffer.from(document('Contents',novel.language,`<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${chapters.map(c=>`<li><a href="chapters/${c.id}.xhtml">${x(c.title)}</a></li>`).join('')}</ol></nav>`)));
  const bytes = zip.toBuffer();
  await writeAtomically(root,novel.id,bytes);
  return {revision: createHash('sha256').update(bytes).digest('hex')};
}
async function writeAtomically(root:string,id:string,bytes:Buffer):Promise<void>{
  const path = archivePath(root, id);
  const directory = resolve(root);
  await mkdir(directory,{recursive:true});
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary,'wx',0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(temporary,path);
    const folder = await open(directory,'r');
    try { await folder.sync(); } finally { await folder.close(); }
  } finally { await unlink(temporary).catch(e=>{if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;}); }
}
