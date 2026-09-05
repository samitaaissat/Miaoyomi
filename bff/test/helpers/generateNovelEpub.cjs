// Opt-in fixture generation for independent EPUBCheck verification. No remote requests.
const {appendChapter,archivePath}=require('../../src/lib/novels/archive.ts');
const {novelId,chapterId}=require('../../src/lib/novels/identity.ts');
const id=novelId('epubcheck-fixture','/book');
const novel={id,title:'Miaoyomi & EPUB validation',language:'en',author:'Fixture Author',sourceId:'epubcheck-fixture',sourcePath:'/book',sourceUrl:'https://example.org/book'};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==','base64');
(async()=>{for(const n of [3,1,2]) await appendChapter('/tmp/miaoyomi-epub-fixture',novel,{id:chapterId(id,`/chapter/${n}`),title:`Chapter ${n} & prose`,position:n,sourcePath:`/chapter/${n}`,sourceUrl:`https://example.org/chapter/${n}`,html:`<h1>Chapter ${n}</h1><p>Text &amp; <em>emphasis</em> with &#x1f431;.</p><blockquote><p>Quotation</p></blockquote><ruby>猫<rt>cat</rt></ruby><figure><img src="/pixel.png" alt="Pixel"/><figcaption>Illustration</figcaption></figure><ul><li>A</li><li>B</li></ul>`},async()=>({bytes:png,contentType:'image/png'})); console.log(archivePath('/tmp/miaoyomi-epub-fixture',id));})();
