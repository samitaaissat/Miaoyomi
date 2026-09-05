import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkBroker, isPublicAddress } from '../src/network.mjs';
const source = { id: 'fixture', site: 'https://fiction.example/' };
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const response = (status = 200, headers = {}, body = 'hello') => ({ status, headers, body: Buffer.from(body) });
const challenge = () => response(403, { 'cf-mitigated': 'challenge' }, '<title>Just a moment...</title>');
// Real FlareSolverr exposes the browser DOM with synthetic status200 and no
// origin headers, even for JSON endpoints and HTTP error pages.
const solved = (solution = {}) => Response.json({ status: 'ok', solution: { url: source.site, status: 200, response: '<html><body>Chapter trouvé</body></html>', headers: {}, cookies: [], userAgent: 'SolverBrowser/1', ...solution } });
test('blocks private, local, mapped, link-local and special-use IP addresses', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::ffff:127.0.0.1', '::ffff:10.1.1.1', 'fc00::1', 'fe80::1', '2001:db8::1']) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('93.184.216.34'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});
test('validates all DNS answers and source origins before transport', async () => {
  const broker = new NetworkBroker({ lookup: async () => [{ address: '127.0.0.1', family: 4 }], transport: () => { throw Error('unsafe connection'); } });
  await assert.rejects(broker.fetch(source, 'https://fiction.example/'), e => e.code === 'NETWORK_POLICY');
  await assert.rejects(broker.fetch(source, 'https://other.example/'), e => e.code === 'NETWORK_POLICY');
  await assert.rejects(broker.fetch(source, 'file:///etc/passwd'), e => e.code === 'NETWORK_POLICY');
});
test('pins the validated DNS address and rejects redirects into private space', async () => {
  const broker = new NetworkBroker({ lookup: publicDns, transport: async (url, init, pin) => {
    assert.equal(pin.address, '93.184.216.34');
    return response(302, { location: 'https://127.0.0.1/admin' });
  } });
  await assert.rejects(broker.fetch(source, 'https://fiction.example/'), e => e.code === 'NETWORK_POLICY');
});
test('source jars retain matching cookies without crossing source boundaries', async () => {
  const seen = [];
  const broker = new NetworkBroker({ lookup: publicDns, transport: async (url, init) => { seen.push(init.headers.cookie || ''); return response(200, { 'set-cookie': ['session=abc; Secure; HttpOnly; Path=/'] }); } });
  await broker.fetch(source, 'https://fiction.example/'); await broker.fetch(source, 'https://fiction.example/next');
  await broker.fetch({ ...source, id: 'second' }, 'https://fiction.example/');
  assert.deepEqual(seen, ['', 'session=abc', '']);
});
test('challenge, oversized body and non-image assets are failures', async () => {
  const blocked = new NetworkBroker({ lookup: publicDns, transport: async () => response(403, { 'cf-mitigated': 'challenge' }, '<title>Just a moment...</title>') });
  await assert.rejects(blocked.fetch(source, source.site), e => e.code === 'SITE_CHALLENGE');
  const big = new NetworkBroker({ lookup: publicDns, maxBytes: 2, transport: async () => response() });
  await assert.rejects(big.fetch(source, source.site), e => e.code === 'RESPONSE_LIMIT');
  const html = new NetworkBroker({ lookup: publicDns, transport: async () => response(200, { 'content-type': 'text/html' }) });
  await assert.rejects(html.fetchAsset(source, source.site), e => e.code === 'INVALID_ASSET');
});
test('source consent/login interstitials cannot look like an empty successful novel', async () => {
  const broker = new NetworkBroker({ lookup: publicDns, transport: async () => response(200, { 'content-type': 'text/html' }, '<h2 class="landmark heading">Adult Content Warning</h2>') });
  await assert.rejects(broker.fetch(source, source.site), e => e.code === 'SOURCE_INTERSTITIAL');
});
test('a same-origin redirect re-resolves DNS and rejects a rebinding answer', async () => {
  let calls = 0;
  const broker = new NetworkBroker({ lookup: async () => ++calls === 1 ? [{address:'93.184.216.34',family:4}] : [{address:'192.168.0.9',family:4}], transport: async () => response(302, { location:'/next' }) });
  await assert.rejects(broker.fetch(source, source.site), e => e.code === 'NETWORK_POLICY');
});
test('asset signature validation rejects spoofed image types and returns image bytes', async () => {
  const png = Buffer.from([137,80,78,71,13,10,26,10,0,0]);
  const broker = new NetworkBroker({ lookup: publicDns, transport: async url => response(200, {'content-type':'image/png'}, url.pathname === '/good' ? png : '<script>bad</script>') });
  assert.deepEqual((await broker.fetchAsset(source, source.site+'good')).body, png);
  await assert.rejects(broker.fetchAsset(source, source.site+'bad'), e => e.code === 'INVALID_ASSET');
});
test('asset request metadata preserves allowed headers and cannot supply credentials or a host override', async () => {
  const png = Buffer.from([137,80,78,71,13,10,26,10,0]);
  const broker = new NetworkBroker({lookup:publicDns,transport:async (_url,init)=> {
    assert.equal(init.headers.referer,'https://fiction.example/');
    for (const name of ['authorization','cookie','host','proxy-authorization']) assert.equal(init.headers[name],undefined,name);
    return response(200,{'content-type':'image/png'},png);
  }});
  const init={headers:{Referer:'https://fiction.example/',Authorization:'Bearer unrelated',Cookie:'foreign=1',Host:'127.0.0.1','Proxy-Authorization':'Basic unrelated'}};
  assert.deepEqual((await broker.fetchAsset(source,source.site+'image',undefined,init)).body,png);
  await assert.rejects(broker.fetchAsset(source,'http://127.0.0.1/image',undefined,init),e=>e.code==='NETWORK_POLICY');
});
test('AVIF is explicitly rejected until the EPUB conversion path supports it', async () => {
  const avif=Buffer.concat([Buffer.from([0,0,0,32]),Buffer.from('ftypavif00000000')]);
  const broker=new NetworkBroker({lookup:publicDns,transport:async()=>response(200,{'content-type':'image/avif'},avif)});
  await assert.rejects(broker.fetchAsset(source,source.site+'image.avif'),e=>e.code==='INVALID_ASSET');
});
test('configured solver resolves browser challenges and reuses matching clearance cookies and user agent', async () => {
  const broker = new NetworkBroker({ lookup: publicDns, solverUrl: 'http://solver:8191/', transport: async (_url, init) => {
    if (init.headers.cookie === 'cf_clearance=guest') {
      assert.equal(init.headers['user-agent'], 'SolverBrowser/1');
      return response(200, {}, 'direct chapter');
    }
    return challenge();
  }, solverFetch: async (url, init) => {
    assert.equal(url, 'http://solver:8191/v1');
    assert.equal(init.redirect, 'error');
    const payload = JSON.parse(init.body);
    assert.equal(payload.cmd, 'request.get');
    assert.equal(payload.url, source.site);
    assert.equal(payload.maxTimeout, 50_000);
    assert.deepEqual(payload.cookies, []);
    return solved({ cookies: [{ name: 'cf_clearance', value: 'guest', domain: 'fiction.example', path: '/', secure: true, httpOnly: true }] });
  } });
  const page = await broker.fetch(source, source.site);
  assert.equal(page.body, 'direct chapter');
  assert.equal(page.headers['set-cookie'], undefined);
  assert.equal((await broker.fetch(source, source.site + 'next', { headers: { 'user-agent': 'PluginBrowser/1' } })).body, 'direct chapter');
  assert.equal((await broker.jars.get(source.id).getCookieString('https://other.example/')), '');
});
test('explicit browser form POST preserves its command and body without a direct replay', async () => {
  const broker = new NetworkBroker({ lookup: publicDns, solverUrl: 'http://solver:8191', transport: async () => { throw Error('Browser POST must not be replayed'); }, solverFetch: async (_url, init) => {
    const payload = JSON.parse(init.body);
    assert.equal(payload.cmd, 'request.post');
    assert.equal(payload.postData, 'search=one+two&page=2');
    assert.equal(payload.headers, undefined);
    return solved();
  } });
  assert.match((await broker.fetch(source, source.site, { useWebView: true, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: 'search=one+two&page=2' })).body, /Chapter/);
});
test('explicit browser requests require configured solver and bypass direct transport', async () => {
  const options = { lookup: publicDns, transport: async () => { throw Error('Direct transport cannot satisfy browser request'); } };
  await assert.rejects(new NetworkBroker(options).fetch(source, source.site, { useWebView: true }), e => e.code === 'SOLVER_UNAVAILABLE');
  const broker = new NetworkBroker({ ...options, solverUrl: 'http://solver:8191', solverFetch: async () => solved() });
  assert.match((await broker.fetch(source, source.site, { useWebView: true })).body, /Chapter/);
});
test('solver destinations still reject unapproved origins, private DNS and unsafe final URLs', async () => {
  let called = false;
  const options = { lookup: publicDns, solverUrl: 'http://solver:8191', transport: async () => challenge(), solverFetch: async () => { called = true; return solved({ url: 'http://127.0.0.1/admin' }); } };
  const broker = new NetworkBroker(options);
  await assert.rejects(broker.fetch(source, 'https://other.example/'), e => e.code === 'NETWORK_POLICY');
  assert.equal(called, false);
  await assert.rejects(new NetworkBroker({ ...options, lookup: async () => [{ address: '127.0.0.1', family: 4 }] }).fetch(source, source.site), e => e.code === 'NETWORK_POLICY');
  assert.equal(called, false);
  await assert.rejects(broker.fetch(source, source.site), e => e.code === 'NETWORK_POLICY');
  let resolutions = 0;
  const rebinding = new NetworkBroker({ ...options, lookup: async () => [{ address: ++resolutions <= 2 ? '93.184.216.34' : '127.0.0.1', family: 4 }], solverFetch: async () => solved() });
  await assert.rejects(rebinding.fetch(source, source.site), e => e.code === 'NETWORK_POLICY');
});
test('solver failures, empty output, unsolved challenges and limits cannot become successful scrapes', async () => {
  for (const [reply, code, maxBytes] of [
    [() => Response.json({ status: 'error', message: 'Chrome failed' }), 'SOLVER_UNAVAILABLE'],
    [() => Response.json({}, { status: 503 }), 'SOLVER_UNAVAILABLE'],
    [() => new Response('not json'), 'SOLVER_UNAVAILABLE'],
    [() => solved({ response: '' }), 'SOLVER_UNAVAILABLE'],
    [() => solved({ status: 403, response: 'Forbidden' }), 'SOURCE_HTTP'],
    [() => solved({ response: '<title>Just a moment...</title>' }), 'SITE_CHALLENGE'],
    [() => solved({ response: 'x'.repeat(500) }), 'RESPONSE_LIMIT', 64],
  ]) {
    const broker = new NetworkBroker({ lookup: publicDns, solverUrl: 'http://solver:8191', transport: async () => challenge(), solverFetch: async () => reply(), maxBytes });
    await assert.rejects(broker.fetch(source, source.site), e => e.code === code, code);
  }
});
test('explicit browser requests do not reinterpret JSON POST or HEAD as a GET', async () => {
  const broker = new NetworkBroker({ lookup: publicDns, solverUrl: 'http://solver:8191', transport: async () => challenge(), solverFetch: async () => { throw Error('Must not change the method or media type'); } });
  for (const init of [{ method: 'HEAD' }, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"page":1}' }]) {
    await assert.rejects(broker.fetch(source, source.site, { ...init, useWebView: true }), e => e.code === 'SOLVER_UNSUPPORTED');
  }
});
test('automatic solving retries raw JSON with its real content type instead of exposing browser pre markup', async () => {
  let attempts = 0;
  const broker = new NetworkBroker({ lookup: publicDns, solverUrl: 'http://solver:8191', transport: async (_url, init) => {
    if (++attempts === 1) return challenge();
    assert.equal(init.headers.cookie, 'cf_clearance=guest');
    assert.equal(init.headers['user-agent'], 'SolverBrowser/1');
    return response(200, { 'content-type': 'application/json; charset=utf-8' }, '{"chapters":["one"]}');
  }, solverFetch: async () => solved({ response: '<html><body><pre>{"chapters":["one"]}</pre></body></html>', cookies: [{ name: 'cf_clearance', value: 'guest', domain: 'fiction.example', path: '/' }] }) });
  const result = await broker.fetch(source, source.site + 'api');
  assert.deepEqual(JSON.parse(result.body), { chapters: ['one'] });
  assert.match(result.headers['content-type'], /application\/json/);
  assert.equal(attempts, 2);
});
test('a synthetic solver status200 cannot hide a source404 on guarded retry', async () => {
  let attempts = 0;
  const broker = new NetworkBroker({ lookup: publicDns, solverUrl: 'http://solver:8191', transport: async () => ++attempts === 1 ? challenge() : response(404, { 'content-type': 'text/html' }, '<html><title>Not found</title></html>'), solverFetch: async () => solved({ response: '<html><title>Not found</title></html>' }) });
  await assert.rejects(broker.fetch(source, source.site, { headers: { accept: 'text/html' } }), e => e.code === 'SOURCE_HTTP' && /404/.test(e.message));
  assert.equal(attempts, 2);
});
test('clearance recovery revalidates DNS and shares the original redirect budget', async () => {
  let resolutions = 0; let requests = 0;
  const rebinding = new NetworkBroker({ lookup: async () => [{ address: ++resolutions <= 3 ? '93.184.216.34' : '127.0.0.1', family: 4 }], solverUrl: 'http://solver:8191', transport: async () => { requests++; return challenge(); }, solverFetch: async () => solved() });
  await assert.rejects(rebinding.fetch(source, source.site), e => e.code === 'NETWORK_POLICY');
  assert.equal(requests, 1);
  let cleared = false;
  const redirects = new NetworkBroker({ lookup: publicDns, solverUrl: 'http://solver:8191', transport: async url => {
    const page = Number(url.pathname.slice(1));
    if (page === 5 && !cleared) return challenge();
    assert.ok(page <= 5, 'recovery must not create another redirect allowance');
    return response(302, { location: `/${page + 1}` });
  }, solverFetch: async () => { cleared = true; return solved({ url: source.site + '5' }); } });
  await assert.rejects(redirects.fetch(source, source.site + '0'), e => e.code === 'SOURCE_REDIRECT');
});
test('automatic POST recovery gets clearance before retrying the original form or JSON body once', async () => {
  for (const [contentType, body] of [['application/x-www-form-urlencoded;charset=UTF-8', 'page=1&name=one+two'], ['application/json', '{"page":1}']]) {
    let posts = 0; let solves = 0;
    const broker = new NetworkBroker({ lookup: publicDns, solverUrl: 'http://solver:8191', transport: async (_url, init) => {
      assert.equal(init.method, 'POST'); assert.equal(init.body, body); assert.equal(init.headers['content-type'], contentType);
      return ++posts === 1 ? response(403, { 'cf-mitigated': 'challenge', 'set-cookie': 'guest=one; Path=/; Secure' }) : response(200, { 'content-type': 'application/json' }, '{"page":1}');
    }, solverFetch: async (_url, init) => {
      solves++;
      const payload = JSON.parse(init.body);
      assert.equal(payload.cmd, 'request.get'); assert.equal(payload.postData, undefined);
      assert.equal(payload.cookies[0].name, 'guest');
      return solved({ response: '<html><body><pre>{"page":1}</pre></body></html>' });
    } });
    assert.deepEqual(JSON.parse((await broker.fetch(source, source.site, { method: 'POST', headers: { 'content-type': contentType }, body })).body), { page: 1 });
    assert.equal(posts, 2); assert.equal(solves, 1);
    await broker.fetch(source, source.site, { method: 'POST', headers: { 'content-type': contentType }, body });
    assert.equal(posts, 3); assert.equal(solves, 1);
  }
});
test('rendered fallback is limited to an explicit HTML GET whose direct retry remains challenged', async () => {
  const broker = new NetworkBroker({ lookup: publicDns, solverUrl: 'http://solver:8191', transport: async () => challenge(), solverFetch: async () => solved() });
  assert.match((await broker.fetch(source, source.site, { headers: { accept: 'text/html' } })).body, /Chapter trouvé/);
  for (const headers of [{}, { accept: 'application/json' }, { accept: 'text/html', 'x-requested-with': 'XMLHttpRequest' }]) {
    await assert.rejects(broker.fetch(source, source.site, { headers }), e => e.code === 'SITE_CHALLENGE');
  }
});
test('solver work aborts at the parent deadline and binary assets stay on the pinned transport', async () => {
  let started;
  const began = new Promise(resolve => { started = resolve; });
  const controller = new AbortController();
  const broker = new NetworkBroker({ lookup: publicDns, solverUrl: 'http://solver:8191', transport: async () => challenge(), solverFetch: async (_url, init) => { started(init.signal); return new Promise(() => {}); } });
  const pending = broker.fetch(source, source.site, {}, controller.signal);
  const signal = await began; controller.abort();
  await assert.rejects(pending, e => e.code === 'DEADLINE');
  assert.equal(signal.aborted, true);
  await assert.rejects(broker.fetchAsset(source, source.site + 'cover.png'), e => e.code === 'SITE_CHALLENGE');
});
test('novel solver concurrency is bounded even when a plugin fans out requests', async () => {
  let started; let finish; let calls = 0;
  const began = new Promise(resolve => { started = resolve; });
  const broker = new NetworkBroker({ lookup: publicDns, solverUrl: 'http://solver:8191', solverConcurrency: 1, solverFetch: async () => { if (++calls > 1) return solved(); started(); return new Promise(resolve => { finish = resolve; }); } });
  const first = broker.fetch(source, source.site, { useWebView: true });
  await began;
  try { await assert.rejects(broker.fetch(source, source.site, { useWebView: true }), e => e.code === 'SOLVER_BUSY'); }
  finally { finish(solved()); await first; }
});
test('solver cookies retain browser expiry, host-only scope and source isolation', async () => {
  const broker = new NetworkBroker({ lookup: publicDns, solverUrl: 'http://solver:8191', solverFetch: async () => solved({ cookies: [
    { name: 'host', value: 'one', domain: 'fiction.example', path: '/', secure: true },
    { name: 'domain', value: 'one', domain: '.fiction.example', path: '/', secure: true },
    { name: 'expired', value: 'bad', domain: 'fiction.example', path: '/', expiry: 1 },
  ] }) });
  await broker.fetch(source, source.site, { useWebView: true });
  const jar = broker.jars.get(source.id);
  assert.equal(await jar.getCookieString(source.site), 'host=one; domain=one');
  assert.equal(await jar.getCookieString('https://sub.fiction.example/'), 'domain=one');
  assert.equal(await jar.getCookieString('http://fiction.example/'), '');
  assert.equal(broker.jars.has('second-source'), false);
});
