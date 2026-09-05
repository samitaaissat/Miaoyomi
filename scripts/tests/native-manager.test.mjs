import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync, readlinkSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const manager = resolve(dirname(fileURLToPath(import.meta.url)), '../proxmox/miaoyomi-native.sh');
const sh = s => `'${s.replaceAll("'", "'\\''")}'`;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'miaoyomi-native-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const d of ['bin', 'etc', 'state/config', 'state/novel-engine', 'state/suwayomi', 'state/downloaded-manga', 'state/novels', 'state/manga', 'app/releases/old', 'app/suwayomi', 'backups', 'services', 'init', 'logs', 'pg-conf']) mkdirSync(join(root, d), { recursive: true });
  const put = (p, data, mode = 0o600) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), data, { mode }); };
  put('etc/installed', 'native-v1\n');
  put('etc/install.conf', `PUBLIC_ORIGIN=https://read.example.com\nWEB_PORT=8080\nSOURCE_REPO=\nSOURCE_REF=\nMANGA_LIBRARY_PATH=${sh(join(root, 'state/manga'))}\n`);
  put('etc/app.env', 'JWT_SECRET=keep-this-secret\nPUBLIC_ORIGIN=https://custom.example.com\n');
  put('etc/novel.env', 'NOVEL_ENGINE_TOKEN=keep-this-token\n');
  put('etc/suwayomi.env', 'SUWAYOMI_VERSION=v2.3.2243\nSUWAYOMI_SHA256=old\n');
  put('state/config/sites.json', '{"custom":true}\n');
  put('state/novel-engine/sources.json', '{"royalroad":{"enabled":true}}\n');
  put('state/downloaded-manga/kept.cbz', 'comic');
  put('state/novels/kept.epub', 'novel');
  put('app/releases/old/.miaoyomi-release', 'old\n');
  put('app/suwayomi/old.jar', 'old-jar');
  symlinkSync(join(root, 'app/releases/old'), join(root, 'app/current'));
  symlinkSync(join(root, 'app/suwayomi/old.jar'), join(root, 'app/suwayomi/current.jar'));
  for (const service of ['miaoyomi', 'miaoyomi-novel', 'miaoyomi-suwayomi']) put(`services/${service}`, 'running');
  for (const d of ['bff', 'web', 'novel-engine']) {
    put(`source/${d}/package.json`, JSON.stringify({ name: d }));
    put(`source/${d}/package-lock.json`, '{}');
  }
  for (const f of ['bff/src/server.ts', 'bff/openapi.yaml', 'web/next.config.mjs', 'novel-engine/src/server.mjs', 'novel-engine/scripts/build.mjs', 'novel-engine/vendor/registry.json']) put(`source/${f}`, '// fixture');
  put('source/.env', 'SHOULD_NOT_SHIP=secret');
  put('source/web/node_modules/old', 'do not ship');
  put('source/data/book.epub', 'do not ship');
  const stub = (name, body) => put(`bin/${name}`, `#!/bin/bash\nset -eu\n${body}\n`, 0o755);
  stub('npm', `printf 'npm:%s:%s\n' "\${PWD##*/}" "$*" >> "$TEST_ROOT/events"
if [[ "$*" == 'run build' ]]; then
  [[ "\${FAIL_BUILD:-}" != "\${PWD##*/}" ]] || exit 9
  case "\${PWD##*/}" in bff) mkdir -p dist; echo api > dist/server.js;; web) mkdir -p out; echo '<html>new</html>' > out/index.html;; novel-engine) mkdir -p dist; echo guest > dist/guest.js;; esac
fi`);
  stub('rc-service', `printf 'service:%s:%s\n' "$1" "$2" >> "$TEST_ROOT/events"
case "$2" in
  status) [[ -f "$TEST_ROOT/services/$1" ]];;
  start|restart) [[ "\${FAIL_START:-}" != "$1" ]] || exit 7; touch "$TEST_ROOT/services/$1"; if [[ "\${SIGNAL_START:-}" == "$1" ]]; then kill -TERM "$PPID"; fi;;
  stop) [[ "\${FAIL_STOP:-}" != "$1" ]] || exit 8; rm -f "$TEST_ROOT/services/$1";;
esac`);
  stub('pg_dump', `echo pg_dump >> "$TEST_ROOT/events"; [[ "\${FAIL_BACKUP:-}" != 1 ]] || exit 9; if [[ "\${SIGNAL_BACKUP:-}" == 1 ]]; then kill -TERM "$PPID"; fi; printf 'database dump\n'`);
  stub('curl', `printf 'curl:%s\n' "$*" >> "$TEST_ROOT/events"
[[ "\${FAIL_READY:-}" != 1 ]] || exit 22
if [[ "$*" == *'solver.example.com'* || "$*" == *'192.0.2.20'* ]]; then
  [[ "\${FAIL_SOLVER:-}" != 1 ]] || exit 22
  if [[ "\${WRONG_SOLVER:-}" == 1 ]]; then printf '{"ok":true}\n'; else printf '{"msg":"FlareSolverr is ready!","version":"3.4.6"}\n'; fi
else printf '{"ok":true}\n'; fi`);
  stub('su-exec', 'shift; exec "$@"');
  stub('chown', ':');
  stub('sleep', ':');
  stub('rc-update', ':');
  stub('apk', `printf 'apk:%s\n' "$*" >> "$TEST_ROOT/events"`);
  stub('mv', `if [[ "$1" == '-Tf' ]]; then shift; node -e 'require("fs").renameSync(process.argv[1],process.argv[2])' "$1" "$2"; else exec /bin/mv "$@"; fi`);
  const run = (args, env = {}, before = '') => spawnSync('bash', ['-c', `
source ${sh(manager)}
ETC_DIR=${sh(join(root, 'etc'))}
STATE_DIR=${sh(join(root, 'state'))}
APP_DIR=${sh(join(root, 'app'))}
RELEASES_DIR="$APP_DIR/releases"
BACKUPS_DIR=${sh(join(root, 'backups'))}
LOG_DIR=${sh(join(root, 'logs'))}
INIT_DIR=${sh(join(root, 'init'))}
PG_CONF_DIR=${sh(join(root, 'pg-conf'))}
APK_REPOSITORIES=${sh(join(root, 'repositories'))}
READINESS_ATTEMPTS=1
MANAGER_PATH="$TEST_ROOT/bin/miaoyomi"
require_platform() { :; }
require_root_file() { [[ -f "$1" && ! -L "$1" ]]; }
${before}
main "$@"
`, 'test-manager', ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, TEST_ROOT: root, ...env }, timeout: 15_000 });
  const events = () => existsSync(join(root, 'events')) ? readFileSync(join(root, 'events'), 'utf8') : '';
  return { root, put, run, events, source: join(root, 'source'), current: () => readlinkSync(join(root, 'app/current')), backups: () => readdirSync(join(root, 'backups')).map(d => join(root, 'backups', d)) };
}

test('help works without privileges and unknown commands fail before host mutation', () => {
  const help = spawnSync('bash', [manager, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /update-suwayomi/);
  const invalid = spawnSync('bash', [manager, 'wipe-everything'], { encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Unknown command/);
});

test('a failed build preserves the running release without stopping writers', t => {
  const f = fixture(t);
  const result = f.run(['update', '--source-dir', f.source], { FAIL_BUILD: 'web' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /build/i);
  assert.equal(f.current(), join(f.root, 'app/releases/old'));
  assert.doesNotMatch(f.events(), /service:.*:stop/);
  assert.equal(readFileSync(join(f.root, 'etc/app.env'), 'utf8'), 'JWT_SECRET=keep-this-secret\nPUBLIC_ORIGIN=https://custom.example.com\n');
});

test('a failed backup prevents cutover and resumes the previous writers', t => {
  const f = fixture(t);
  const result = f.run(['update', '--source-dir', f.source], { FAIL_BACKUP: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(f.current(), join(f.root, 'app/releases/old'));
  assert.match(f.events(), /service:miaoyomi:stop/);
  assert.match(f.events(), /service:miaoyomi:start/);
  assert.equal(f.backups().length, 1);
  assert.ok(existsSync(join(f.backups()[0], '.incomplete')));
  assert.ok(!existsSync(join(f.root, 'etc/recovery-required')));
});

test('successful update backs up durable files and preserves operator configuration', t => {
  const f = fixture(t);
  f.put('etc/install.conf', readFileSync(join(f.root, 'etc/install.conf'), 'utf8') + '# operator extension\nCUSTOM_OPTION=preserve\n');
  const result = f.run(['update', '--source-dir', f.source]);
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(f.current(), join(f.root, 'app/releases/old'));
  assert.ok(existsSync(join(f.root, 'app/releases/old')));
  assert.equal(readFileSync(join(f.root, 'etc/app.env'), 'utf8'), 'JWT_SECRET=keep-this-secret\nPUBLIC_ORIGIN=https://custom.example.com\n');
  assert.equal(readFileSync(join(f.root, 'state/config/sites.json'), 'utf8'), '{"custom":true}\n');
  assert.match(readFileSync(join(f.root, 'etc/install.conf'), 'utf8'), /# operator extension\nCUSTOM_OPTION=preserve\n/);
  assert.equal(readFileSync(join(f.current(), 'web/out/index.html'), 'utf8'), '<html>new</html>\n');
  assert.ok(!existsSync(join(f.current(), '.env')));
  assert.ok(!existsSync(join(f.current(), 'data')));
  assert.ok(!existsSync(join(f.current(), 'web/node_modules/old')));
  const [backup] = f.backups();
  assert.equal(readFileSync(join(backup, 'database.dump'), 'utf8'), 'database dump\n');
  assert.ok(!existsSync(join(backup, '.incomplete')));
  const archive = spawnSync('tar', ['-tzf', join(backup, 'files.tar.gz')], { encoding: 'utf8' });
  assert.equal(archive.status, 0, archive.stderr);
  for (const name of ['etc/app.env', 'state/downloaded-manga/kept.cbz', 'state/novels/kept.epub', 'state/novel-engine/sources.json']) assert.ok(archive.stdout.includes(name), name);
  assert.equal(statSync(backup).mode & 0o777, 0o700);
  assert.ok(f.events().indexOf('pg_dump') < f.events().indexOf('service:miaoyomi:start'));
});

test('readiness failure leaves new code selected, stops writers, and blocks further cutovers', t => {
  const f = fixture(t);
  const result = f.run(['update', '--source-dir', f.source], { FAIL_READY: '1' });
  assert.notEqual(result.status, 0);
  assert.notEqual(f.current(), join(f.root, 'app/releases/old'));
  assert.ok(existsSync(join(f.root, 'etc/recovery-required')));
  for (const name of ['miaoyomi', 'miaoyomi-novel', 'miaoyomi-suwayomi']) assert.ok(!existsSync(join(f.root, 'services', name)));
  assert.match(result.stderr, /not.*roll|no.*roll/i);
  const second = f.run(['update', '--source-dir', f.source]);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /recovery-required/);
});

test('standalone backup restores only services that were running', t => {
  const f = fixture(t);
  rmSync(join(f.root, 'services/miaoyomi-suwayomi'));
  const result = f.run(['backup']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(f.root, 'services/miaoyomi')));
  assert.ok(!existsSync(join(f.root, 'services/miaoyomi-suwayomi')));
  assert.doesNotMatch(f.events(), /service:miaoyomi-suwayomi:start/);
});

test('local installations require an explicit replacement source and reject unknown options', t => {
  const f = fixture(t);
  const result = f.run(['update']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source-dir/);
  assert.doesNotMatch(f.events(), /service:.*:stop/);
  const invalid = f.run(['update', '--upgrade-os']);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Unknown option/);
});

test('failure to stop a writer prevents creating an inconsistent backup', t => {
  const f = fixture(t);
  const result = f.run(['backup'], { FAIL_STOP: 'miaoyomi-novel' });
  assert.notEqual(result.status, 0);
  assert.match(f.events(), /service:miaoyomi:stop/);
  assert.doesNotMatch(f.events(), /pg_dump/);
  assert.equal(f.backups().length, 0);
  assert.ok(existsSync(join(f.root, 'services/miaoyomi')));
});

test('external FlareSolverr is wired into both app and Suwayomi without a local solver service', t => {
  const f = fixture(t);
  f.put('etc/install.conf', readFileSync(join(f.root, 'etc/install.conf'), 'utf8') + 'FLARESOLVERR_URL=http://192.0.2.20:8191\nFLARESOLVERR_CTID=120\n');
  const result = f.run(['--help'], {}, `
load_install_config "$ETC_DIR/install.conf"
rm "$ETC_DIR/app.env" "$ETC_DIR/novel.env"
write_application_environment
write_services
`);
  assert.equal(result.status, 0, result.stderr);
  const app = readFileSync(join(f.root, 'etc/app.env'), 'utf8');
  assert.match(app, /^FLARESOLVERR_URL=http:\/\/192\.0\.2\.20:8191$/m);
  const solver = readFileSync(join(f.root, 'etc/suwayomi-solver.env'), 'utf8');
  assert.match(solver, /server\.flareSolverrEnabled=true/);
  assert.match(solver, /server\.flareSolverrUrl=http:\/\/192\.0\.2\.20:8191/);
  assert.deepEqual(readdirSync(join(f.root, 'init')).sort(), ['miaoyomi', 'miaoyomi-novel', 'miaoyomi-suwayomi']);
  const engine = spawnSync('sh', ['-c', '. "$1"; printf "%s" "$command_args"', 'test', join(f.root, 'init/miaoyomi-suwayomi')], { encoding: 'utf8' });
  assert.equal(engine.status, 0, engine.stderr);
  assert.match(engine.stdout, /-Dsuwayomi\.tachidesk\.config\.server\.flareSolverrUrl=http:\/\/192\.0\.2\.20:8191/);
  assert.equal(statSync(join(f.root, 'etc/app.env')).mode & 0o777, 0o640);
});

test('solver outage does not prevent local restart and is reported separately by status', t => {
  const f = fixture(t);
  f.put('etc/install.conf', readFileSync(join(f.root, 'etc/install.conf'), 'utf8') + 'FLARESOLVERR_URL=http://solver.example.com:8191\nFLARESOLVERR_CTID=120\n');
  const result = f.run(['restart'], { FAIL_SOLVER: '1' });
  assert.equal(result.status, 0, result.stderr);
  for (const name of ['miaoyomi', 'miaoyomi-novel', 'miaoyomi-suwayomi']) assert.ok(existsSync(join(f.root, 'services', name)));
  assert.doesNotMatch(f.events(), /service:.*(?:solver|flaresolverr)/);
  assert.ok(!existsSync(join(f.root, 'etc/recovery-required')));
  const status = f.run(['status'], { FAIL_SOLVER: '1' });
  assert.notEqual(status.status, 0);
  assert.match(status.stdout + status.stderr, /FlareSolverr.*unreachable|unhealthy/i);
  assert.match(status.stdout, /120/);
  const logs = f.run(['logs', 'solver']);
  assert.notEqual(logs.status, 0);
  assert.match(logs.stderr, /remote|separate/i);
  assert.match(logs.stderr, /120/);
});

test('set-solver backs up and updates both consumers while preserving secrets and custom settings', t => {
  const f = fixture(t);
  f.put('etc/database.env', 'POSTGRES_PASSWORD=keep-database-secret\n');
  f.put('etc/suwayomi-solver.env', '# operator comment\nEXTRA_ENGINE_SETTING=keep\n');
  f.put('state/suwayomi/server.conf', 'server { customSetting = true }\n');
  const result = f.run(['set-solver', '--url', 'https://solver.example.com:8191', '--ctid', '120']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.backups().length, 1);
  const app = readFileSync(join(f.root, 'etc/app.env'), 'utf8');
  assert.match(app, /^JWT_SECRET=keep-this-secret$/m);
  assert.match(app, /^PUBLIC_ORIGIN=https:\/\/custom\.example\.com$/m);
  assert.match(app, /^FLARESOLVERR_URL=https:\/\/solver\.example\.com:8191$/m);
  assert.equal(readFileSync(join(f.root, 'etc/novel.env'), 'utf8'), 'NOVEL_ENGINE_TOKEN=keep-this-token\n');
  assert.equal(readFileSync(join(f.root, 'etc/database.env'), 'utf8'), 'POSTGRES_PASSWORD=keep-database-secret\n');
  assert.match(readFileSync(join(f.root, 'etc/suwayomi-solver.env'), 'utf8'), /EXTRA_ENGINE_SETTING=keep/);
  assert.equal(readFileSync(join(f.root, 'state/suwayomi/server.conf'), 'utf8'), 'server { customSetting = true }\n');
  assert.match(readFileSync(join(f.root, 'etc/install.conf'), 'utf8'), /^FLARESOLVERR_CTID=120$/m);
  assert.ok(f.events().indexOf('curl:') < f.events().indexOf('service:miaoyomi:stop'));
  assert.doesNotMatch(f.events(), /service:.*(?:solver|flaresolverr)/);
  const update = f.run(['update', '--source-dir', f.source], { FAIL_SOLVER: '1' });
  assert.equal(update.status, 0, update.stderr);
  assert.equal(readFileSync(join(f.root, 'etc/app.env'), 'utf8'), app);
  assert.match(readFileSync(join(f.root, 'etc/install.conf'), 'utf8'), /^FLARESOLVERR_URL=https:\/\/solver\.example\.com:8191$/m);
});

test('set-solver can disable remote integration without probing or touching the remote service', t => {
  const f = fixture(t);
  f.put('etc/install.conf', readFileSync(join(f.root, 'etc/install.conf'), 'utf8') + 'FLARESOLVERR_URL=http://solver.example.com:8191\nFLARESOLVERR_CTID=120\n');
  f.put('etc/app.env', 'JWT_SECRET=keep-this-secret\nFLARESOLVERR_URL=http://solver.example.com:8191\n');
  const result = f.run(['set-solver', '--url', ''], { FAIL_SOLVER: '1' });
  assert.equal(result.status, 0, result.stderr);
  const inspect = f.run(['--help'], {}, 'source "$ETC_DIR/app.env"; printf "solver=<%s>\n" "$FLARESOLVERR_URL"');
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.match(inspect.stdout, /solver=<>/);
  assert.match(readFileSync(join(f.root, 'etc/suwayomi-solver.env'), 'utf8'), /server\.flareSolverrEnabled=false/);
  assert.doesNotMatch(f.events(), /curl:.*solver\.example\.com|service:.*(?:solver|flaresolverr)/);
});

for (const env of [{ FAIL_SOLVER: '1' }, { WRONG_SOLVER: '1' }]) {
  test('unreachable or non-FlareSolverr endpoints cannot change existing config: ' + Object.keys(env)[0], t => {
    const f = fixture(t);
    const config = readFileSync(join(f.root, 'etc/install.conf'), 'utf8');
    const app = readFileSync(join(f.root, 'etc/app.env'), 'utf8');
    const result = f.run(['set-solver', '--url', 'http://solver.example.com:8191'], env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /FlareSolverr/i);
    assert.equal(readFileSync(join(f.root, 'etc/install.conf'), 'utf8'), config);
    assert.equal(readFileSync(join(f.root, 'etc/app.env'), 'utf8'), app);
    assert.equal(f.backups().length, 0);
    assert.doesNotMatch(f.events(), /service:.*:stop/);
  });
}

test('solver URL and metadata reject unsafe or invalid input before service mutation', t => {
  const f = fixture(t);
  const urls = ['http://user:pass@solver.example.com:8191', 'http://solver.example.com:8191/v1', 'http://solver.example.com:8191/', 'http://solver.example.com:0', 'http://solver.example.com:65536', 'http://solver.example.com:9999999999999999999', 'ftp://solver.example.com', 'http://solver.example.com;touch /tmp/injected', "http://solver.example.com'", 'http://solver.example.com\n', 'http://solver.example.com\r', 'http://solver.example.com\t'];
  for (const url of urls) {
    const result = f.run(['set-solver', '--url', url]);
    assert.notEqual(result.status, 0, url);
    assert.match(result.stderr, /URL|origin|port/i, url);
  }
  const ctid = f.run(['set-solver', '--url', '', '--ctid', '120;id']);
  assert.notEqual(ctid.status, 0);
  assert.match(ctid.stderr, /CTID|container ID/);
  const missing = f.run(['set-solver']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--url/);
  assert.doesNotMatch(f.events(), /service:.*:stop/);
});

test('managed default manga directory is created while an existing collection is left untouched', t => {
  const f = fixture(t);
  rmSync(join(f.root, 'state/manga'), { recursive: true });
  const result = f.run(['--help'], {}, `
load_install_config "$ETC_DIR/install.conf"
id() { return 0; }
create_users_and_paths
`);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(f.root, 'state/manga')));
  f.put('collection/owned.cbz', 'collection');
  const collection = join(f.root, 'collection');
  f.put('etc/install.conf', 'PUBLIC_ORIGIN=https://read.example.com\nWEB_PORT=8080\nMANGA_LIBRARY_PATH=' + sh(collection) + '\n');
  const before = statSync(collection).mode;
  const existing = f.run(['--help'], {}, 'load_install_config "$ETC_DIR/install.conf"; id() { return 0; }; create_users_and_paths');
  assert.equal(existing.status, 0, existing.stderr);
  assert.equal(statSync(collection).mode, before);
  assert.equal(readFileSync(join(collection, 'owned.cbz'), 'utf8'), 'collection');
});

test('unverified Suwayomi download cannot stop writers or replace the active engine', t => {
  const f = fixture(t);
  const result = f.run(['update-suwayomi', '--version', 'v2.3.2243', '--sha256', 'a'.repeat(64)]);
  assert.notEqual(result.status, 0);
  assert.match(f.events(), /curl/);
  assert.doesNotMatch(f.events(), /service:.*:stop/);
  assert.equal(readlinkSync(join(f.root, 'app/suwayomi/current.jar')), join(f.root, 'app/suwayomi/old.jar'));
});

test('application update installs a validated replacement manager and backs up the old one', t => {
  const f = fixture(t);
  const replacement = readFileSync(manager, 'utf8');
  f.put('source/scripts/proxmox/miaoyomi-native.sh', replacement, 0o755);
  f.put('bin/miaoyomi', '#!/bin/bash\necho old-manager\n', 0o755);
  const result = f.run(['update', '--source-dir', f.source]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(f.root, 'bin/miaoyomi'), 'utf8'), replacement);
  const backup = spawnSync('tar', ['-xzOf', join(f.backups()[0], 'files.tar.gz'), join(f.root, 'bin/miaoyomi').slice(1)], { encoding: 'utf8' });
  assert.equal(backup.status, 0, backup.stderr);
  assert.equal(backup.stdout, '#!/bin/bash\necho old-manager\n');
});

test('an invalid replacement manager cannot interrupt running services', t => {
  const f = fixture(t);
  f.put('source/scripts/proxmox/miaoyomi-native.sh', '#!/bin/bash\nif broken syntax\n');
  f.put('bin/miaoyomi', '#!/bin/bash\necho old-manager\n', 0o755);
  const result = f.run(['update', '--source-dir', f.source]);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(f.events(), /service:.*:stop/);
  assert.equal(readFileSync(join(f.root, 'bin/miaoyomi'), 'utf8'), '#!/bin/bash\necho old-manager\n');
  assert.equal(f.current(), join(f.root, 'app/releases/old'));
});

test('a failed solver cutover retains backup and stops all writers for recovery', t => {
  const f = fixture(t);
  const result = f.run(['set-solver', '--url', 'http://solver.example.com:8191'], { FAIL_START: 'miaoyomi-suwayomi' });
  assert.notEqual(result.status, 0);
  assert.equal(f.backups().length, 1);
  assert.ok(existsSync(join(f.root, 'etc/recovery-required')));
  for (const name of ['miaoyomi', 'miaoyomi-novel', 'miaoyomi-suwayomi']) assert.ok(!existsSync(join(f.root, 'services', name)));
  assert.doesNotMatch(f.events(), /service:.*(?:solver|flaresolverr)/);
});

test('service logs remain writable after dropping privileges and installation logs stay private', t => {
  const f = fixture(t);
  f.put('logs/install.log', 'private install details\n');
  const result = f.run(['--help'], {}, `
load_install_config "$ETC_DIR/install.conf"
id() { return 0; }
create_users_and_paths
write_services
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(statSync(join(f.root, 'logs')).mode & 0o777, 0o711);
  for (const service of ['miaoyomi', 'miaoyomi-novel', 'miaoyomi-suwayomi']) {
    assert.equal(statSync(join(f.root, 'logs', service + '.log')).mode & 0o777, 0o600);
    rmSync(join(f.root, 'logs', service + '.log'));
    const restart = spawnSync('sh', ['-c', '. "$1"; start_pre', 'test', join(f.root, 'init', service)], { encoding: 'utf8', env: { ...process.env, PATH: join(f.root, 'bin') + ':' + process.env.PATH, TEST_ROOT: f.root } });
    // Application environments are required to source the service script.
    assert.equal(restart.status, 0, restart.stderr);
    assert.equal(statSync(join(f.root, 'logs', service + '.log')).mode & 0o777, 0o600);
  }
  assert.equal(statSync(join(f.root, 'logs/install.log')).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(f.root, 'logs/install.log'), 'utf8'), 'private install details\n');
});

test('native packages enable the matching Alpine community repository and reject mixed releases', t => {
  const f = fixture(t);
  f.put('repositories', 'https://dl-cdn.alpinelinux.org/alpine/v3.24/main\n');
  const prepare = f.run(['--help'], {}, 'ensure_alpine_repositories');
  assert.equal(prepare.status, 0, prepare.stderr);
  assert.match(readFileSync(join(f.root, 'repositories'), 'utf8'), /^https:\/\/dl-cdn\.alpinelinux\.org\/alpine\/v3\.24\/community$/m);
  const again = f.run(['--help'], {}, 'ensure_alpine_repositories');
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(join(f.root, 'repositories'), 'utf8').match(/\/community/g).length, 1);
  f.put('repositories', 'https://dl-cdn.alpinelinux.org/alpine/v3.24/main\nhttps://dl-cdn.alpinelinux.org/alpine/edge/community\n');
  const mixed = f.run(['--help'], {}, 'install_packages');
  assert.notEqual(mixed.status, 0);
  assert.doesNotMatch(f.events(), /apk:/);
  assert.match(mixed.stderr, /3\.24|repositories/i);
});

test('installation records diagnostics in a private log without replacing previous details', t => {
  const f = fixture(t);
  f.put('logs/install.log', 'previous install details\n');
  const result = f.run(['--help'], {}, 'start_install_log; say "installation diagnostics"');
  assert.equal(result.status, 0, result.stderr);
  const log = readFileSync(join(f.root, 'logs/install.log'), 'utf8');
  assert.match(log, /previous install details/);
  assert.match(log, /installation diagnostics/);
  assert.equal(statSync(join(f.root, 'logs/install.log')).mode & 0o777, 0o600);
});

test('the web app can use port 8191 because FlareSolverr is a remote service', t => {
  const f = fixture(t);
  f.put('etc/install.conf', readFileSync(join(f.root, 'etc/install.conf'), 'utf8').replace('WEB_PORT=8080', 'WEB_PORT=8191'));
  const result = f.run(['--help'], {}, 'load_install_config "$ETC_DIR/install.conf"');
  assert.equal(result.status, 0, result.stderr);
});

test('termination during backup resumes the unchanged release and preserves the incomplete backup', t => {
  const f = fixture(t);
  const result = f.run(['backup'], { SIGNAL_BACKUP: '1' });
  assert.equal(result.status, 143, result.stderr);
  for (const name of ['miaoyomi', 'miaoyomi-novel', 'miaoyomi-suwayomi']) assert.ok(existsSync(join(f.root, 'services', name)));
  assert.equal(f.current(), join(f.root, 'app/releases/old'));
  assert.ok(existsSync(join(f.backups()[0], '.incomplete')));
  assert.ok(!existsSync(join(f.root, 'etc/recovery-required')));
  assert.ok(!existsSync(join(f.root, 'etc/operation.lock')));
});

test('termination during cutover stops writers and records recovery before releasing the lock', t => {
  const f = fixture(t);
  const result = f.run(['update', '--source-dir', f.source], { SIGNAL_START: 'miaoyomi-suwayomi' });
  assert.equal(result.status, 143, result.stderr);
  for (const name of ['miaoyomi', 'miaoyomi-novel', 'miaoyomi-suwayomi']) assert.ok(!existsSync(join(f.root, 'services', name)));
  assert.ok(existsSync(join(f.root, 'etc/recovery-required')));
  assert.ok(!existsSync(join(f.root, 'etc/operation.lock')));
  assert.notEqual(f.current(), join(f.root, 'app/releases/old'));
});

test('installing the native manager creates a missing sbin directory in a fresh Alpine guest', t => {
  const f = fixture(t);
  const result = f.run(['--help'], {}, `MANAGER_PATH="$TEST_ROOT/local/sbin/miaoyomi"; install_manager_file ${sh(manager)}`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(statSync(join(f.root, 'local/sbin')).mode & 0o777, 0o755);
  assert.equal(statSync(join(f.root, 'local/sbin/miaoyomi')).mode & 0o777, 0o755);
  assert.equal(readFileSync(join(f.root, 'local/sbin/miaoyomi'), 'utf8'), readFileSync(manager, 'utf8'));
});
