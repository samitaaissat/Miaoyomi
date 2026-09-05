const BLOCKED = 'script,style,link,iframe,object,embed,form,input,button,textarea,select,canvas,svg';

function fallback(html: string): string {
  return html
    .replace(/<(script|style|iframe|object|embed|form|canvas|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(?:link|input|button|textarea|select)\b[^>]*>(?:[\s\S]*?<\/(?:button|textarea|select)\s*>)?/gi, '')
    .replace(/\s(?:style|class|id|on[a-z]+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\ssrc\s*=\s*(["'])(?!data:image\/)[\s\S]*?\1/gi, '')
    .replace(/\shref\s*=\s*(["'])\s*javascript:[\s\S]*?\1/gi, '');
}

export function sanitizeNovelHtml(html: string): string {
  if (typeof DOMParser === 'undefined') return fallback(html);
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  parsed.querySelectorAll(BLOCKED).forEach((node) => node.remove());
  parsed.body.querySelectorAll('*').forEach((node) => {
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name === 'style' || name === 'class' || name === 'id' || name.startsWith('on')) node.removeAttribute(attribute.name);
    }
    if (node instanceof HTMLImageElement && !node.src.startsWith('data:image/')) node.removeAttribute('src');
    if (node instanceof HTMLAnchorElement) {
      const href = node.getAttribute('href') || '';
      if (/^javascript:/i.test(href)) node.removeAttribute('href');
      else if (href) { node.target = '_blank'; node.rel = 'noreferrer noopener'; }
    }
  });
  return parsed.body.innerHTML;
}
