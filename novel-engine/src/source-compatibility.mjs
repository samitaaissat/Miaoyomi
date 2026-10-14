const shims = {
  allnovel: String.raw`
;(() => {
  const plugin = module.exports.default || exports.default;
  const fetches = require('@libs/fetch');
  const originalFetch = fetches.fetchApi;
  const validateDocument = (body, kind) => {
    const $ = require('cheerio').load(body);
    const closed = new Set(), stack = [];
    // The parser repairs missing closing tags. Require the actual adapter boundary.
    const parser = new (require('htmlparser2').Parser)({
      onopentag(name, attributes) {
        const marker = name === 'select' && attributes.id === 'chapter-nav' ? 'chapter options'
          : name === 'div' && attributes.id === 'list-page' ? 'catalog'
          : name === 'div' && ['books', 'm-imgtxt'].includes(attributes.class) ? 'detail'
          : ['chr-content', 'chapter-content'].includes(attributes.id) || attributes.class === 'txt' ? 'chapter'
          : undefined;
        stack.push(marker);
      },
      onclosetag(_name, implied) { const marker = stack.pop(); if (marker && !implied) closed.add(marker); },
    });
    parser.write(body); parser.end();
    const errorPage = $('title, h1').toArray().some(element =>
      /^(?:40[034]\b|50[0234]\b|not found\b|access denied\b|internal server error\b|bad gateway\b|service unavailable\b)/i.test($(element).text().trim()));
    let valid = false;
    if (kind === 'catalog') {
      const catalog = $('#list-page .archive .list-truyen').first();
      valid = catalog.find('.title-list h2').text().trim()
        && catalog.children('.row').toArray().every(row => {
          const link = $(row).find('h3 a').first();
          return link.attr('href') && link.attr('title')?.trim() && link.text().trim();
        });
    } else if (kind === 'chapter options') {
      const select = $('select#chapter-nav');
      valid = select.length === 1 && select.find('option').toArray().every(option =>
        option.attribs.value?.trim() && $(option).text().trim());
    } else if (kind === 'detail') {
      valid = $('[class="books"], [class="m-imgtxt"]').toArray().some(cover =>
        $(cover).find('img[title]').attr('title')?.trim() || $(cover).find('h3').text().trim());
    } else {
      const content = $('[id="chr-content"], [id="chapter-content"], [class="txt"]').first();
      // These are the same hidden elements skipped by the pinned chapter parser.
      content.find('sub, iframe, div[class*="ads"], div[class*="unlock-buttons"]').remove();
      valid = content.text().trim();
    }
    if (errorPage || !closed.has(kind) || !valid) {
      throw Object.assign(new Error('AllNovel: invalid ' + kind + ' HTML response'), { code: 'SOURCE_RESPONSE' });
    }
  };
  // Only the pinned adapter's document routes may use rendered HTML recovery.
  // Only chapter-option GET returns HTML; JSON and form POST keep their responses.
  fetches.fetchApi = async (url, init = {}) => {
    const target = new URL(url, plugin.site);
    const headers = new Headers(init.headers);
    const document = target.pathname === '/ajax-chapter-option' || /^(?:\/(?:most-popular|hot-novel|completed-novel|latest-release-novel|search)\/?|\/genre\/[^/]+\/?|\/[^?#]+\.html)$/.test(target.pathname);
    if (target.origin === new URL(plugin.site).origin && document
        && String(init.method || 'GET').toUpperCase() === 'GET'
        && !target.searchParams.has('ajax') && !headers.has('x-requested-with')
        && !headers.has('accept')) {
      headers.set('accept', 'text/html');
      const response = await originalFetch(url, { ...init, headers });
      if (response.ok) {
        const kind = target.pathname === '/ajax-chapter-option' ? 'chapter options'
          : !target.pathname.endsWith('.html') ? 'catalog'
          : target.pathname.slice(1).includes('/') ? 'chapter' : 'detail';
        // Inspect a clone; the pinned adapter still owns parsing the original body.
        validateDocument(await response.clone().text(), kind);
      }
      return response;
    }
    return originalFetch(url, init);
  };
})();`,

  arcane: String.raw`
;(() => {
  const plugin = module.exports.default || exports.default;
  const { fetchApi, fetchWebView } = require('@libs/fetch');
  const { NovelStatus } = require('@libs/novelStatus');
  const { defaultCover } = require('@libs/defaultCover');
  const site = 'https://noveldex.io';
  const api = site + '/api/ai';
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const novelSlug = path => {
    const slug = String(path).replace(/^series\/(?:novel\/)?/, '').replace(/\/$/, '');
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) fail('SOURCE_RESPONSE', 'Arcane: invalid migrated novel path');
    return slug;
  };
  const chapterPath = path => {
    const match = /^([a-z0-9][a-z0-9-]*)\/chapter\/(\d+(?:\.\d+)?)$/i.exec(String(path));
    if (!match) fail('SOURCE_RESPONSE', 'Arcane: invalid migrated chapter path');
    return match;
  };
  const novelItem = value => ({
    name: value.title || 'Untitled',
    path: value.slug,
    cover: value.cover_image || defaultCover,
  });
  const json = async url => (await fetchApi(url, { headers: { accept: 'application/json' } })).json();

  plugin.site = site + '/';
  plugin.filters = {};
  plugin.popularNovels = async (page, options = {}) => {
    const sort = options.showLatestNovels ? 'latest' : 'popular';
    const payload = await json(api + '/series?page=' + page + '&limit=20&type=novel&sort=' + sort);
    if (!payload || !Array.isArray(payload.data)) fail('SOURCE_RESPONSE', 'Arcane: migrated catalog response is incomplete');
    return payload.data.map(novelItem);
  };
  plugin.searchNovels = async (term, page) => {
    if (page !== 1) return [];
    const payload = await json(api + '/search?q=' + encodeURIComponent(term) + '&limit=20');
    if (!payload || !Array.isArray(payload.results)) fail('SOURCE_RESPONSE', 'Arcane: migrated search response is incomplete');
    return payload.results.map(novelItem);
  };
  plugin.parseNovel = async path => {
    const slug = novelSlug(path);
    const value = await json(api + '/series/' + encodeURIComponent(slug));
    if (!value || typeof value !== 'object' || !Array.isArray(value.chapters)) fail('SOURCE_RESPONSE', 'Arcane: migrated novel response is incomplete');
    const statuses = {
      ONGOING: NovelStatus.Ongoing,
      COMPLETED: NovelStatus.Completed,
      HIATUS: NovelStatus.OnHiatus,
      DROPPED: NovelStatus.Cancelled,
      DISCONTINUED: NovelStatus.Cancelled,
    };
    return {
      path: slug,
      name: value.title || 'Untitled',
      cover: value.cover_image || defaultCover,
      summary: value.description || '',
      author: value.author || '',
      artist: value.artist || '',
      status: statuses[value.status] || NovelStatus.Unknown,
      genres: Array.isArray(value.genres) ? value.genres.join(', ') : '',
      chapters: (value.chapters || []).flatMap(chapter => {
        if (chapter.is_premium && plugin.hideLocked) return [];
        return [{
          name: (chapter.is_premium ? '🔒 ' : '') + (chapter.title || 'Chapter ' + chapter.number),
          path: slug + '/chapter/' + chapter.number,
          chapterNumber: chapter.number,
          releaseTime: chapter.published_at || null,
        }];
      }),
    };
  };
  plugin.parseChapter = async path => {
    const match = chapterPath(path);
    const url = site + '/series/novel/' + encodeURIComponent(match[1]) + '/chapter/' + encodeURIComponent(match[2]);
    const body = await fetchWebView(url, { headers: { accept: 'text/html' } });
    const loaded = require('cheerio').load(body);
    const chapter = loaded('[data-paragraph-key] > .prose').toArray().map(element => loaded(element).html() || '').join('');
    if (!chapter.trim()) fail('SOURCE_INTERSTITIAL', 'Arcane: migrated chapter requires NovelDex browser access');
    return chapter;
  };
  plugin.resolveUrl = path => {
    const match = /^([a-z0-9][a-z0-9-]*)\/chapter\/(\d+(?:\.\d+)?)$/i.exec(String(path));
    if (match) return site + '/series/novel/' + match[1] + '/chapter/' + match[2];
    return site + '/series/novel/' + novelSlug(path);
  };
})();`,

  crimsonscrolls: String.raw`
;(() => {
  const plugin = module.exports.default || exports.default;
  const { fetchApi } = require('@libs/fetch');
  plugin.queryAPI = async query => {
    const form = new FormData();
    form.append('action', query.action);
    Object.entries(query.params).forEach(([key, value]) => form.append(key, String(value)));
    const payload = await (await fetchApi(plugin.site + '/wp-admin/admin-ajax.php', { method: 'POST', body: form })).json();
    const html = typeof payload.html === 'string' ? payload.html
      : typeof payload.data === 'string' ? payload.data
      : payload.data && typeof payload.data.html === 'string' ? payload.data.html
      : undefined;
    if (html === undefined) throw new Error('Crimson Scrolls: AJAX response did not include HTML');
    return require('cheerio').load(html);
  };
})();`,

  webnovel: String.raw`
;(() => {
  const plugin = module.exports.default || exports.default;
  plugin.headers = Object.assign({}, plugin.headers, { Accept: 'text/html' });
})();`,
};

export function applySourceCompatibility(id, script) {
  return shims[id] ? script + shims[id] : script;
}
