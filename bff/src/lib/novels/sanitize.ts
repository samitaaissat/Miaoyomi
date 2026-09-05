import { createHash } from 'node:crypto';
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import sharp from 'sharp';
import type { AssetFetcher } from './types';

type Node = DefaultTreeAdapterMap['node'];
export type EmbeddedAsset = { path: string; bytes: Buffer; contentType: string };
const allowed = new Set('p div span section article h1 h2 h3 h4 h5 h6 br hr em strong b i u s del ins small sub sup blockquote pre code ul ol li dl dt dd a img figure figcaption ruby rt rp table caption thead tbody tfoot tr th td'.split(' '));
const discard = new Set('script style svg math form input button select textarea iframe object embed template noscript audio video canvas link meta base'.split(' '));
const voidTags = new Set(['br', 'hr', 'img']);

export function escapeXml(value: string): string {
  return value.replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
export function httpUrl(value: string, base?: string): string {
  const url = new URL(value, base);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported source URL');
  return url.href;
}

export async function sanitizeChapter(html: string, sourceUrl: string, fetchAsset: AssetFetcher): Promise<{html: string; assets: EmbeddedAsset[]}> {
  if (typeof html !== 'string' || Buffer.byteLength(html) > 8 * 1024 * 1024) throw new Error('Chapter HTML is too large or invalid');
  httpUrl(sourceUrl);
  const assets = new Map<string, EmbeddedAsset>();
  const fetched = new Map<string, string>();
  let visibleText = '';
  let imageCount = 0;
  let totalBytes = 0;
  async function imageSource(src: string): Promise<string> {
    const inline = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-zA-Z0-9+/]+={0,2})$/i.exec(src);
    const url = inline ? src : httpUrl(src, sourceUrl);
    const previous = fetched.get(url); if (previous) return previous;
    if (++imageCount > 200) throw new Error('Too many chapter images');
    const asset = inline ? {bytes: Buffer.from(inline[2], 'base64'), contentType: inline[1]} : await fetchAsset(url);
    const mime = asset.contentType.split(';')[0].trim().toLowerCase();
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime)) throw new Error('Unsupported image content type');
    if (!Buffer.isBuffer(asset.bytes) || !asset.bytes.length || asset.bytes.length > 20 * 1024 * 1024) throw new Error('Invalid image size');
    totalBytes += asset.bytes.length;
    if (totalBytes > 100 * 1024 * 1024) throw new Error('Chapter images are too large');
    const metadata = await sharp(asset.bytes, { limitInputPixels: 40_000_000 }).metadata();
    const expected: Record<string, string> = {'image/png':'png','image/jpeg':'jpeg','image/gif':'gif','image/webp':'webp'};
    if (metadata.format !== expected[mime]) throw new Error('Image bytes do not match content type');
    // Header inspection alone accepts images with corrupt or truncated pixels.
    await sharp(asset.bytes, { limitInputPixels: 40_000_000 }).stats();
    // WebP is not an EPUB core media type; convert it to portable PNG.
    const bytes = mime === 'image/webp' ? await sharp(asset.bytes).png().toBuffer() : asset.bytes;
    const contentType = mime === 'image/webp' ? 'image/png' : mime;
    const extension = {'image/png':'png','image/jpeg':'jpg','image/gif':'gif'}[contentType]!;
    const path = `assets/${createHash('sha256').update(bytes).digest('hex')}.${extension}`;
    assets.set(path, {path, bytes, contentType}); fetched.set(url, `../${path}`);
    return `../${path}`;
  }
  async function render(node: Node): Promise<string> {
    if (node.nodeName === '#text') {
      const value = (node as DefaultTreeAdapterMap['textNode']).value;
      visibleText += value;
      return escapeXml(value);
    }
    if (!('tagName' in node)) return '';
    const tag = node.tagName;
    if (discard.has(tag) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') return '';
    const children = async () => { const out: string[] = []; for (const child of node.childNodes) out.push(await render(child)); return out.join(''); };
    if (!allowed.has(tag)) return children();
    const attrs = new Map(node.attrs.map(a => [a.name, a.value]));
    let attributes = '';
    if (tag === 'img') {
      // Lazy images use a real source when a placeholder is absent.
      const src = attrs.get('data-src') || attrs.get('data-original') || attrs.get('src');
      if (!src) throw new Error('Chapter image has no source');
      attributes = ` src="${escapeXml(await imageSource(src))}" alt="${escapeXml(attrs.get('alt') || '')}"`;
    }
    if (tag === 'a' && attrs.has('href')) {
      try { attributes += ` href="${escapeXml(httpUrl(attrs.get('href')!, sourceUrl))}"`; } catch { /* Inert text for unsafe links. */ }
    }
    for (const name of ['title', 'lang', 'dir']) {
      const value = attrs.get(name);
      if (value && (name !== 'dir' || ['ltr','rtl','auto'].includes(value))) attributes += ` ${name}="${escapeXml(value)}"`;
    }
    if (['td', 'th'].includes(tag)) for (const name of ['colspan','rowspan']) {
      const value = attrs.get(name); if (value && /^[1-9]\d{0,2}$/.test(value)) attributes += ` ${name}="${value}"`;
    }
    if (voidTags.has(tag)) return `<${tag}${attributes} />`;
    return `<${tag}${attributes}>${await children()}</${tag}>`;
  }
  const output: string[] = [];
  for (const node of parseFragment(html).childNodes) output.push(await render(node));
  if (!visibleText.trim() && !assets.size) throw new Error('Chapter is empty after sanitization');
  return {html: output.join(''), assets: [...assets.values()]};
}
