import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkBroker, isPublicAddress } from '../src/network.mjs';
const source = { id: 'fixture', site: 'https://fiction.example/' };
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const response = (status = 200, headers = {}, body = 'hello') => ({ status, headers, body: Buffer.from(body) });
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
