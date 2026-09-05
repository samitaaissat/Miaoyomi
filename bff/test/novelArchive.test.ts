import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import AdmZip from 'adm-zip';
import { DOMParser } from '@xmldom/xmldom';
import { appendChapter, readChapter, inspectArchive, archivePath } from '../src/lib/novels/archive';
import { novelId, chapterId } from '../src/lib/novels/identity';

const id = novelId('fixture', '/book');
const novel = {id, title: 'A & B <Novel>', language: 'en', author:'An Author', sourceId:'fixture', sourcePath:'/book', sourceUrl:'https://example.org/book'};
const chapter = (n:number, html=`<p>Chapter ${n} &amp; prose</p>`) => ({id:chapterId(id, `/chapter/${n}`), title:`Chapter ${n}`, position:n, sourcePath:`/chapter/${n}`, sourceUrl:`https://example.org/chapter/${n}`, html});
const noAssets = async () => { throw new Error('unexpected asset'); };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==', 'base64');
async function fixture(t:any) { const root = await mkdtemp(join(tmpdir(),'miaoyomi-epub-')); t.after(()=>rm(root,{recursive:true,force:true})); return root; }
function xml(source:string) { const errors:string[]=[]; const doc = new DOMParser({onError:(_level,msg)=>errors.push(msg)}).parseFromString(source,'application/xml'); assert.deepEqual(errors,[]); return doc; }

test('first saved chapter is standard EPUB and missing chapters return null', async t => {
  const root = await fixture(t);
  assert.equal(await inspectArchive(root,id),null);
  const result = await appendChapter(root,novel,chapter(1),noAssets);
  const bytes = await readFile(archivePath(root,id));
  assert.equal(bytes.readUInt16LE(8),0,'first entry must be uncompressed');
  const nameSize=bytes.readUInt16LE(26); assert.equal(bytes.subarray(30,30+nameSize).toString(),'mimetype');
  const zip = new AdmZip(bytes);
  assert.equal(zip.readAsText('mimetype'),'application/epub+zip');
  assert.match(zip.readAsText('META-INF/container.xml'),/EPUB\/package.opf/);
  for (const entry of zip.getEntries().filter(e=>/\.(opf|xhtml|xml)$/.test(e.entryName))) xml(entry.getData().toString());
  const opf = xml(zip.readAsText('EPUB/package.opf'));
  assert.equal(opf.documentElement?.getAttribute('version'),'3.0');
  assert.equal(opf.getElementsByTagName('itemref').length,1);
  const saved = await readChapter(root,id,chapter(1).id);
  assert.equal(saved?.revision,result.revision); assert.match(saved!.html,/Chapter 1 &amp; prose/);
  assert.equal(await readChapter(root,id,chapter(9).id),null);
  assert.deepEqual(await readdir(root),[`${id}.epub`]);
});

test('out-of-order and concurrent appends preserve reading order and survive process restart', async t => {
  const root = await fixture(t);
  await appendChapter(root,novel,chapter(3),noAssets);
  await Promise.all([appendChapter(root,novel,chapter(2),noAssets),appendChapter(root,novel,chapter(1),noAssets)]);
  const info = await inspectArchive(root,id);
  assert.deepEqual(info?.chapters.map(c=>c.position),[1,2,3]);
  assert.deepEqual((await readChapter(root,id,chapter(2).id))?.chapterIds,[1,2,3].map(n=>chapter(n).id));
  const output = execFileSync(process.execPath,['--import','tsx','-e',`require('./src/lib/novels/archive').readChapter(${JSON.stringify(root)},${JSON.stringify(id)},${JSON.stringify(chapter(1).id)}).then(v=>process.stdout.write(JSON.stringify(v)))`],{cwd:join(__dirname,'..')});
  assert.match(JSON.parse(output.toString()).html,/Chapter 1/);
});

test('malicious and malformed source HTML becomes well-formed inert semantic XHTML', async t => {
  const root=await fixture(t);
  await appendChapter(root,novel,chapter(1,`<p onclick="evil()">Text & copy &nbsp; <em>word</p><script>evil()</script><style>@import 'evil'</style><svg><script>evil()</script></svg><form><input><p>trap</p></form><iframe src="https://evil.invalid"></iframe><a href="javascript:evil()">link</a><p style="background:url(https://evil.invalid)">end</p>`),noAssets);
  const saved=await readChapter(root,id,chapter(1).id);
  assert.doesNotMatch(saved!.html,/script|onclick|style|svg|form|input|iframe|javascript|trap|evil/);
  assert.match(saved!.html,/<em>word<\/em>/);
  xml(`<div xmlns="http://www.w3.org/1999/xhtml">${saved!.html}</div>`);
});

test('images are local EPUB assets and self-contained data URLs on read', async t => {
  const root=await fixture(t);
  await appendChapter(root,novel,chapter(1,'<p>Hello<img src="../image.png" alt="A &amp; B"></p>'),async url=>{assert.equal(url,'https://example.org/image.png');return {bytes:png,contentType:'image/png'};});
  const zip=new AdmZip(await readFile(archivePath(root,id)));
  const images=zip.getEntries().filter(e=>e.entryName.endsWith('.png'));
  assert.equal(images.length,1); assert.deepEqual(images[0].getData(),png);
  assert.doesNotMatch(zip.readAsText(`EPUB/chapters/${chapter(1).id}.xhtml`),/data:|https:\/\/example.org\/image/);
  assert.match((await readChapter(root,id,chapter(1).id))!.html,/src="data:image\/png;base64,/);
});

test('failed image append and invalid metadata retain the prior EPUB byte-for-byte without staging leftovers', async t=>{
  const root=await fixture(t);
  await appendChapter(root,novel,chapter(1),noAssets);
  const before=await readFile(archivePath(root,id));
  await assert.rejects(appendChapter(root,novel,chapter(2,'<img src="/missing.png">'),async()=>{throw new Error('image failed');}),/image failed/);
  await assert.rejects(appendChapter(root,novel,{...chapter(2),id:'../traversal'},noAssets));
  assert.deepEqual(await readFile(archivePath(root,id)),before);
  assert.deepEqual(await readdir(root),[`${id}.epub`]);
});

test('SVG and mislabeled executable image responses fail explicitly', async t=>{
  const root=await fixture(t);
  for (const contentType of ['image/svg+xml','image/png']) await assert.rejects(appendChapter(root,novel,chapter(1,'<img src="/image">'),async()=>({bytes:Buffer.from('<svg onload="evil()"/>'),contentType})));
  assert.equal(await inspectArchive(root,id),null);
});


test('rename failure cleans the staging file and preserves the previous readable chapter', async t => {
  const root = await fixture(t);
  await appendChapter(root,novel,chapter(1),noAssets);
  const before = await readFile(archivePath(root,id));
  const originalRename = fs.rename;
  t.mock.method(fs,'rename',async () => { throw Object.assign(new Error('disk rename failed'),{code:'EIO'}); });
  await assert.rejects(appendChapter(root,novel,chapter(2),noAssets),/disk rename failed/);
  t.mock.restoreAll();
  assert.equal(fs.rename,originalRename);
  assert.deepEqual(await readFile(archivePath(root,id)),before);
  assert.deepEqual(await readdir(root),[`${id}.epub`]);
  assert.match((await readChapter(root,id,chapter(1).id))!.html,/Chapter 1/);
  await appendChapter(root,novel,chapter(2),noAssets);
  assert.equal((await inspectArchive(root,id))?.chapters.length,2,'failed queue entry must not poison later saves');
});

test('existing chapter images survive appends, and replacement removes unreferenced assets', async t => {
  const root = await fixture(t);
  await appendChapter(root,novel,chapter(1,'<img src="/image.png">'),async()=>({bytes:png,contentType:'image/png'}));
  await appendChapter(root,novel,chapter(2),noAssets);
  assert.match((await readChapter(root,id,chapter(1).id))!.html,/data:image\/png;base64,/);
  await appendChapter(root,novel,chapter(1,'<p>Replacement</p>'),noAssets);
  const zip = new AdmZip(await readFile(archivePath(root,id)));
  assert.equal(zip.getEntries().filter(e=>e.entryName.endsWith('.png')).length,0);
  assert.equal((await inspectArchive(root,id))?.chapters.length,2);
  assert.match((await readChapter(root,id,chapter(1).id))!.html,/Replacement/);
});

test('inline raster data images are embedded as standard local EPUB assets', async t => {
  const root = await fixture(t);
  await appendChapter(root,novel,chapter(1,`<img src="data:image/png;base64,${png.toString('base64')}">`),noAssets);
  const zip = new AdmZip(await readFile(archivePath(root,id)));
  assert.deepEqual(zip.getEntries().find(e=>e.entryName.endsWith('.png'))!.getData(),png);
  assert.match((await readChapter(root,id,chapter(1).id))!.html,/data:image\/png;base64,/);
});

test('a source body emptied by sanitization is an explicit failure', async t => {
  const root = await fixture(t);
  await assert.rejects(appendChapter(root,novel,chapter(1,'<script>challenge()</script><p> &nbsp; </p>'),noAssets),/empty/i);
  assert.equal(await inspectArchive(root,id),null);
});


test('corrupt image pixels cannot become a successful offline chapter', async t => {
  const root = await fixture(t);
  const corrupt = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfZkAAAAASUVORK5CYII=', 'base64');
  await assert.rejects(appendChapter(root,novel,chapter(1,'<img src="/broken.png">'),async()=>({bytes:corrupt,contentType:'image/png'})));
  assert.equal(await inspectArchive(root,id),null);
});
