import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runPlugin } from '../src/runtime.mjs';
const script = id => readFile(new URL(`../vendor/scripts/${id}.js`, import.meta.url), 'utf8');
const royalList = '<div class="fiction-list-item"><figure><a href="/fiction/21220/mother"><img src="/cover.jpg" alt="Mother of Learning"></a></figure></div>';
const royalDetail = '<h1>Mother of Learning</h1><a href="/profile/1">Nobody</a><div class="description"><p>A time loop.</p></div><script>window.chapters = [{"title":"Chapter One","url":"/fiction/21220/mother/chapter/301778/one","order":1,"date":"2020-01-01"}];</script>';
const aoList = '<li class="work"><h4 class="heading"><a href="/works/123">Fixture Story</a></h4></li>';
const aoDetail = '<h2 class="title">Fixture Story</h2><a rel="author">Writer</a><blockquote class="userstuff">Summary</blockquote><div id="chapter_index"><select><option value="456">Chapter One</option></select></div>';
function fixtureFetch(id) { return async url => {
  const u = new URL(url); let body;
  if (id === 'royalroad') body = u.pathname.includes('search') ? royalList : u.pathname.includes('chapter') ? '<div class="chapter-content"><p>Hello reader &amp; friend.</p></div>' : royalDetail;
  else body = u.pathname.includes('search') ? aoList : u.pathname.endsWith('navigate') ? '<ol class="index"><li><span class="datetime">(2020-01-01)</span></li></ol>' : u.pathname.includes('chapters') ? '<div id="chapters"><div><p>Hello reader.</p></div></div>' : aoDetail;
  return { body, status: 200, url, headers: { 'content-type': 'text/html' } };
}; }
for (const id of ['royalroad', 'archiveofourown']) test(`pinned ${id}: browse, search, detail and chapter inside QuickJS`, async () => {
  const source = await script(id); const fetch = fixtureFetch(id);
  const browse = await runPlugin(source, 'popularNovels', [1, {}], { fetch });
  assert.equal(browse[0].name, id === 'royalroad' ? 'Mother of Learning' : 'Fixture Story');
  const search = await runPlugin(source, 'searchNovels', ['fixture', 1], { fetch });
  assert.equal(search[0].path, id === 'royalroad' ? 'fiction/21220' : 'works/123');
  const detail = await runPlugin(source, 'parseNovel', [search[0].path], { fetch });
  assert.equal(detail.chapters[0].path, id === 'royalroad' ? 'fiction/21220/chapter/301778' : 'works/123/chapters/456');
  assert.equal(detail.author, id === 'royalroad' ? 'Nobody' : 'Writer');
  const chapter = await runPlugin(source, 'parseChapter', [detail.chapters[0].path], { fetch });
  assert.match(chapter, /Hello reader/);
});
test('runaway code is interrupted and unavailable modules are explicit', async () => {
  await assert.rejects(runPlugin('while(true){}', 'parseNovel', [], { deadlineMs: 50 }), e => e.code === 'DEADLINE');
  await assert.rejects(runPlugin('require("fs")', 'parseNovel', []), e => e.code === 'UNSUPPORTED_CAPABILITY');
});
test('guest cannot reach Node or manufacture host objects', async () => {
  const result = await runPlugin('exports.default={parseNovel:()=>[typeof process,typeof Buffer,require("cheerio").load.constructor("return typeof process")()]};', 'parseNovel', []);
  assert.deepEqual(result, ['undefined', 'undefined', 'undefined']);
});
test('common form, headers and base64 APIs keep bodies and responses inside guest', async () => {
  let request;
  const result = await runPlugin(`exports.default={async parseNovel(){const form = new FormData(); form.append('action','search'); form.append('title','A & B');const response=await fetch('https://fixture.example/',{method:'POST',body:form,headers:new Headers({'X-Requested-With':'XMLHttpRequest'})});return [response.clone().status,await response.text(),atob(btoa('hello'))]}}`, 'parseNovel', [], { fetch: async (url, init) => { request = init; return { url, status: 200, headers: {}, body: 'reply' }; } });
  assert.deepEqual(result, [200, 'reply', 'hello']);
  assert.match(request.body, /name="action"\r\n\r\nsearch/);
  assert.match(request.body, /name="title"\r\n\r\nA & B/);
  assert.match(request.headers['content-type'], /^multipart\/form-data; boundary=/);
});
test('fetchWebView requests a guarded browser fetch and returns response text', async () => {
  let request;
  const result = await runPlugin(`exports.default={async parseNovel(){return await require('@libs/fetch').fetchWebView('https://fixture.example/', {headers:{'X-Requested-With':'XMLHttpRequest'}})}}`, 'parseNovel', [], { fetch: async (url, init) => { request = { url, init }; return { url, status: 200, headers: {}, body: '<p>browser result</p>' }; } });
  assert.equal(result, '<p>browser result</p>');
  assert.equal(request.url, 'https://fixture.example/');
  assert.equal(request.init.useWebView, true);
  assert.equal(request.init.headers['x-requested-with'], 'XMLHttpRequest');
});
