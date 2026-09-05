import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

const REPO = join(__dirname, '..', '..');
const read = (file: string) => readFileSync(join(REPO, file), 'utf8');

test('the default Compose path pulls one matching published app and engine release', () => {
  assert.ok(existsSync(join(REPO, 'docker-compose.yml')), 'the documented prebuilt Compose file is missing');
  assert.ok(!existsSync(join(REPO, 'compose.yaml')), 'the retired source-build Compose file is still selectable by Docker');

  const compose: any = parseYaml(read('docker-compose.yml'));
  assert.equal(compose.services.app.image, 'ghcr.io/samitaaissat/miaoyomi:${MIAOYOMI_IMAGE_TAG:-latest}');
  assert.equal(compose.services['novel-engine'].image, 'ghcr.io/samitaaissat/miaoyomi-novel-engine:${MIAOYOMI_IMAGE_TAG:-latest}');
  for (const service of Object.values<any>(compose.services)) {
    assert.equal(service.build, undefined, 'the default deployment must not require a source checkout or local build');
    assert.equal(service.platform, undefined, 'the published OCI index must select the host architecture');
  }
});

test('the development overlay adds only the two local source builds', () => {
  const dev: any = parseYaml(read('docker-compose.dev.yml'));
  assert.deepEqual(Object.keys(dev.services).sort(), ['app', 'novel-engine']);
  assert.equal(dev.services.app.image, 'miaoyomi/app:local');
  assert.deepEqual(dev.services.app.build, { context: '.', dockerfile: 'Dockerfile.miaoyomi' });
  assert.equal(dev.services.app.pull_policy, 'build', 'the development app must build locally instead of pulling a release');
  assert.equal(dev.services['novel-engine'].image, 'miaoyomi/novel-engine:local');
  assert.deepEqual(dev.services['novel-engine'].build, { context: './novel-engine' });
  assert.equal(dev.services['novel-engine'].pull_policy, 'build', 'the development engine must build locally instead of pulling a release');
  for (const service of Object.values<any>(dev.services)) {
    assert.equal(service.platform, undefined, 'development builds must use the local host architecture');
  }
});
