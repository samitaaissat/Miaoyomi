const shims = {
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
