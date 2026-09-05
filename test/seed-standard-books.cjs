// Disposable Compose smoke fixture. Run inside the app container with `node < this-file`.
const {appendChapter}=require('/app/dist/lib/novels/archive.js');
const {novelId,chapterId}=require('/app/dist/lib/novels/identity.js');
const AdmZip=require('adm-zip');
const fs=require('node:fs/promises');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==','base64');
(async()=>{
 const id=novelId('compose-smoke','/book');
 await appendChapter('/novels',{id,title:'Compose smoke novel',language:'en',sourceId:'compose-smoke',sourcePath:'/book',sourceUrl:'https://example.org/book'},
 {id:chapterId(id,'/chapter'),title:'Chapter 1',position:1,sourcePath:'/chapter',sourceUrl:'https://example.org/chapter',html:'<h1>Chapter 1</h1><p>Disposable backup verification.</p>'},async()=>({bytes:png,contentType:'image/png'}));
 const cbz=new AdmZip();cbz.addFile('001.png',png);cbz.addFile('ComicInfo.xml',Buffer.from('<?xml version="1.0"?><ComicInfo><Title>Compose smoke manga</Title><Number>1</Number></ComicInfo>'));
 await fs.mkdir('/library-dl/Compose smoke',{recursive:true});await fs.writeFile('/library-dl/Compose smoke/Chapter 001.cbz',cbz.toBuffer());
 console.log('Standard EPUB and CBZ fixtures written');
})().catch(e=>{console.error(e);process.exitCode=1;});
