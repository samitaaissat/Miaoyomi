import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('scripts/proxmox/create-lxc.sh');
const run = (args, options = {}) => spawnSync('bash', [script, ...args], { encoding: 'utf8', ...options });
const shell = (code, env = {}) => spawnSync('bash', ['-c', 'source "$1"; ' + code, 'test', script], {
  encoding: 'utf8', env: { ...process.env, ...env },
});
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'miaoyomi-lxc-'));
  for (const name of ['bff', 'web', 'novel-engine', 'scripts/proxmox']) mkdirSync(join(dir, name), { recursive: true });
  for (const name of ['bff', 'web', 'novel-engine']) {
    writeFileSync(join(dir, name, 'package.json'), '{}');
    writeFileSync(join(dir, name, 'package-lock.json'), '{}');
  }
  writeFileSync(join(dir, 'scripts/proxmox/miaoyomi-native.sh'), '#!/bin/bash\n');
  return dir;
};

test('help works without a Proxmox node', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--source-dir/);
  assert.match(result.stdout, /--dry-run/);
});

test('the published bash -c transport can show help without BASH_SOURCE', () => {
  const result = spawnSync('bash', ['-c', readFileSync(script, 'utf8'), '--', '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Create an unprivileged Alpine LXC/);
});

test('unknown and missing options fail with actionable errors', () => {
  assert.match(run(['--unknown']).stderr, /Unknown option/);
  assert.match(run(['--memory']).stderr, /requires a value/);
});

test('dry run validates and prints unprivileged creation without running pct', () => {
  const dir = fixture();
  try {
    const result = run(['--dry-run', '--source-dir', dir, '--public-origin', 'https://read.example.com', '--ctid', '120', '--vlan', '20']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /pct create 120/);
    assert.match(result.stdout, /--unprivileged 1/);
    assert.match(result.stdout, /tag=20/);
    assert.doesNotMatch(result.stdout, /--privileged/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('separate FlareSolverr leaves Alpine resources unchanged and carries its endpoint to the guest', () => {
  const dir = fixture();
  const config = join(tmpdir(), `miaoyomi-solver-${process.pid}.conf`);
  try {
    const result = run(['--dry-run', '--source-dir', dir, '--public-origin', 'https://read.example.com', '--ctid', '121', '--flaresolverr', 'yes']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /6144 MiB RAM/);
    assert.match(result.stdout, /32 GiB root disk/);
    assert.match(result.stdout, /official community.*separate/i);
    const written = shell('FLARESOLVERR_URL=http://10.0.0.26:8191; FLARESOLVERR_CTID=122; write_guest_config "$CONFIG"', { CONFIG: config });
    assert.equal(written.status, 0, written.stderr);
    assert.match(readFileSync(config, 'utf8'), /^FLARESOLVERR_URL=http:\/\/10.0.0.26:8191$/m);
    assert.match(readFileSync(config, 'utf8'), /^FLARESOLVERR_CTID=122$/m);
    assert.doesNotMatch(readFileSync(config, 'utf8'), /INSTALL_FLARESOLVERR/);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(config, { force: true }); }
});

test('FlareSolverr rejects invalid choices and ambiguous connection settings', () => {
  const dir = fixture();
  try {
    for (const args of [
      ['--flaresolverr', 'maybe'], ['--flaresolverr-ctid', '100'],
      ['--flaresolverr', 'no', '--flaresolverr-ctid', '121'],
      ['--flaresolverr-ctid', '121', '--flaresolverr-url', 'http://10.0.0.26:8191'],
      ['--flaresolverr-url', 'http://user:pass@solver:8191'],
      ['--flaresolverr-url', 'http://solver:99999'], ['--flaresolverr-url', 'http://solver:8191/v1'],
    ]) {
      const result = run(['--dry-run', '--source-dir', dir, '--public-origin', 'https://read.example.com', ...args]);
      assert.notEqual(result.status, 0, args.join(' '));
      assert.match(result.stderr, /FlareSolverr|yes or no/i);
      assert.doesNotMatch(result.stdout, /pct create/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('invalid origin, network, resources and ambiguous sources fail before creation', () => {
  const dir = fixture();
  try {
    for (const args of [
      ['--public-origin', 'http://read.example.com'], ['--public-origin', 'https://read.example.com/path'],
      ['--public-origin', 'https://read.example.com:99999'], ['--ctid', '99'],
      ['--memory', '1024'], ['--web-port', '4100'], ['--disk', '8'],
      ['--ip', '10.0.0.999/24'], ['--ip', '10.0.0.20/24'],
      ['--ip', 'dhcp', '--gateway', '10.0.0.1'], ['--hostname', 'bad name'], ['--vlan', '4095'],
      ['--repo', 'https://example.com/repo.git'],
    ]) {
      const result = run(['--dry-run', '--source-dir', dir, '--public-origin', 'https://read.example.com', ...args]);
      assert.notEqual(result.status, 0, args.join(' '));
      assert.doesNotMatch(result.stdout, /pct create/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('source bundle includes unpublished code but excludes credentials, books and dependencies', () => {
  const dir = fixture();
  const archive = join(tmpdir(), `miaoyomi-test-${process.pid}.tgz`);
  try {
    for (const name of ['bff/node_modules', 'web/.next', 'novel-engine/vendor', 'bff/data', 'data']) mkdirSync(join(dir, name), { recursive: true });
    for (const name of ['.env', 'bff/.env.secret', 'bff/node_modules/secret', 'web/.next/cache', 'bff/data/book.cbz', 'data/book.epub']) writeFileSync(join(dir, name), 'DO NOT TRANSFER');
    writeFileSync(join(dir, 'novel-engine/vendor/source.js'), 'source');
    const result = shell('pack_source "$FIXTURE" "$ARCHIVE"', { FIXTURE: dir, ARCHIVE: archive });
    assert.equal(result.status, 0, result.stderr);
    const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
    assert.equal(listing.status, 0);
    assert.match(listing.stdout, /novel-engine\/vendor\/source.js/);
    assert.doesNotMatch(listing.stdout, /\.env|node_modules|\.next|book\.(cbz|epub)/);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(archive, { force: true }); }
});

test('guest config safely preserves literal characters without executing them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'miaoyomi-config-'));
  try {
    const config = join(dir, 'install.conf');
    const result = shell('PUBLIC_ORIGIN=https://read.example.com; WEB_PORT=8080; SOURCE_REPO=""; SOURCE_REF="feature/example"; MANGA_LIBRARY_PATH="/mnt/manga"; write_guest_config "$CONFIG"; source "$CONFIG"; printf "%s\\n" "$SOURCE_REF"', { CONFIG: config });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'feature/example');
    assert.match(readFileSync(config, 'utf8'), /MANGA_LIBRARY_PATH=/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('existing cluster VMID is rejected before pct creation', () => {
  const result = shell('CTID=120; pvesh() { return 1; }; ensure_unused_id');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already in use|available/);
});

test('pct create failure never starts, overwrites or destroys a container', () => {
  const result = shell('CTID=120; TEMPLATE=local:vztmpl/alpine.tar.xz; pct() { printf "CALLED %s\\n" "$*"; return 42; }; create_container');
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /CALLED create/);
  assert.doesNotMatch(result.stdout, /CALLED (start|destroy|set)/);
});

test('successful creation uses a read-only bind mount and reports an actual DHCP address', () => {
  const result = shell('CTID=120; TEMPLATE=local:vztmpl/alpine.tar.xz; MANGA_MOUNT=/srv/books; pct() { if [[ "$1" == exec ]]; then printf "2: eth0 inet 10.0.0.25/24 brd 10.0.0.255 scope global eth0\\n"; else printf "CALLED %s\\n" "$*"; fi; }; create_container; guest_address');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--mp0 \/srv\/books,mp=\/mnt\/manga,ro=1/);
  assert.match(result.stdout, /10\.0\.0\.25/);
  assert.doesNotMatch(result.stdout, /chown|destroy|nesting/);
});

test('LXC nesting is configurable without introducing an inner container runtime', () => {
  const dir = fixture();
  try {
    const result = run(['--dry-run', '--source-dir', dir, '--public-origin', 'https://read.example.com', '--nesting', 'yes']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--features nesting=1/);
    assert.doesNotMatch(result.stdout, /docker run|podman run/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('existing solver IDs and URLs are accepted without inflating the app guest', () => {
  const dir = fixture();
  try {
    for (const args of [['--flaresolverr-ctid', '125'], ['--flaresolverr-url', 'http://solver.lan:8191']]) {
      const result = run(['--dry-run', '--source-dir', dir, '--public-origin', 'https://read.example.com', '--memory', '4096', '--disk', '24', '--web-port', '8191', ...args]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /4096 MiB RAM/);
      assert.match(result.stdout, /FlareSolverr: existing/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unattended new-solver creation fails explicitly instead of hanging in the upstream wizard', () => {
  const result = shell('ASSUME_YES=1; validate_solver_settings');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /official.*wizard needs a terminal/);
});

function solverFixture(t, mode = 'success') {
  const root = mkdtempSync(join(tmpdir(), 'miaoyomi-solver-flow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stub = `
WORK_DIR="$TEST_ROOT"
CTID=120
BRIDGE=vmbr42
pct() {
  printf '%s\\n' "$*" >> "$TEST_ROOT/events"
  case "$1" in
    list) printf 'VMID Status Name\\n120 running miaoyomi\\n122 running unrelated\\n';;
    status) printf 'status: running\\n';;
    exec)
      if [[ "$*" == *'ip -4'* ]]; then printf '2: eth0 inet 10.0.0.26/24 brd 10.0.0.255 scope global eth0\\n'; fi
      if [[ "$*" == *'/usr/bin/update' && "\${MODE:-}" == update-failure ]]; then return 42; fi
      ;;
  esac
}
download_community_script() {
  cat > "$1" <<'COMMUNITY'
#!/usr/bin/env bash
set -eu
printf 'upstream:%s\\n' "$var_brg" >> "$TEST_ROOT/events"
case "$MODE" in
  cancel) exit 7;;
  missing) exit 0;;
  existing) APP=FlareSolverr CTID=122 bash "$var_post_install";;
  malformed) printf '125\\n126\\n' > "$TEST_ROOT/solver.ctid";;
  *) APP=FlareSolverr CTID=125 bash "$var_post_install";;
esac
exit 0
COMMUNITY
}
`;
  return {
    run(code) { return shell(stub + code, { TEST_ROOT: root, MODE: mode }); },
    events() { try { return readFileSync(join(root, 'events'), 'utf8'); } catch { return ''; } },
  };
}

test('official child wizard reports the actual new CT ID and address without altering upstream LXC features', t => {
  const f = solverFixture(t);
  const result = f.run('prepare_solver; write_guest_config "$TEST_ROOT/install.conf"; cat "$TEST_ROOT/install.conf"');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^FLARESOLVERR_CTID=125$/m);
  assert.match(result.stdout, /^FLARESOLVERR_URL=http:\/\/10\.0\.0\.26:8191$/m);
  assert.match(f.events(), /upstream:vmbr42/);
  assert.doesNotMatch(f.events(), /^set |destroy|nesting=/m);
});

for (const mode of ['cancel', 'missing', 'existing', 'malformed']) {
  test(`official wizard ${mode} result fails without guessing a solver or touching an existing LXC`, t => {
    const f = solverFixture(t, mode);
    const result = f.run('prepare_solver; printf SHOULD_NOT_CONNECT; install_guest');
    assert.notEqual(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /SHOULD_NOT_CONNECT/);
    assert.doesNotMatch(f.events(), /set-solver|destroy|^set |apk/m);
  });
}

test('existing solver bypasses the official creation wizard', t => {
  const f = solverFixture(t);
  const result = f.run('FLARESOLVERR_CTID=125; prepare_solver; printf "%s" "$FLARESOLVERR_URL"');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /http:\/\/10\.0\.0\.26:8191/);
  assert.doesNotMatch(f.events(), /upstream:/);
});

test('solver maintenance runs its official updater before checking from app guest and saving the new connection', t => {
  const f = solverFixture(t);
  const result = f.run('ACTION=update-solver; FLARESOLVERR_CTID=125; maintain_solver');
  assert.equal(result.status, 0, result.stderr);
  const events = f.events();
  assert.match(events, /exec 125 -- env PHS_SILENT=1 bash \/usr\/bin\/update/);
  assert.match(events, /exec 120 -- node -e/);
  assert.match(events, /exec 120 -- miaoyomi set-solver --url http:\/\/10\.0\.0\.26:8191 --ctid 125/);
  assert.ok(events.indexOf('env PHS_SILENT') < events.indexOf('exec 120 -- node'));
  assert.ok(events.indexOf('exec 120 -- node') < events.indexOf('miaoyomi set-solver'));
  assert.doesNotMatch(events, /^create |destroy/m);
});

test('official updater failure prevents reconnect and reports failure', t => {
  const f = solverFixture(t, 'update-failure');
  const result = f.run('ACTION=update-solver; FLARESOLVERR_CTID=125; maintain_solver');
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(f.events(), /set-solver|exec 120 -- node/);
});

test('maintenance dry-run validates the pair without requiring installation sources', () => {
  const result = run(['--reconnect', '120', '--flaresolverr-ctid', '125', '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No containers will be created/);
  assert.notEqual(run(['--update-solver', '120', '--flaresolverr-url', 'http://solver:8191', '--dry-run']).status, 0);
  assert.notEqual(run(['--reconnect', '120', '--flaresolverr-ctid', '120', '--dry-run']).status, 0);
});

test('failed inter-LXC health check prevents writing or installing guest configuration', () => {
  const result = shell(`
CTID=120
FLARESOLVERR_URL=http://10.0.0.26:8191
pct() {
  printf 'CALLED %s\\n' "$*"
  [[ "$*" != *'node -e'* ]] || return 7
}
write_guest_config() { printf SHOULD_NOT_CONFIGURE; }
install_guest
`);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /exec 120 -- node -e/);
  assert.doesNotMatch(result.stdout, /SHOULD_NOT_CONFIGURE|CALLED push|miaoyomi-native.sh install/);
});

test('malformed solver hosts fail before container creation', () => {
  for (const host of ['solver..lan', '-solver', 'solver.lan.', 'a'.repeat(64) + '.lan']) {
    const result = run(['--dry-run', '--public-origin', 'https://read.example.com', '--flaresolverr-url', `http://${host}:8191`]);
    assert.notEqual(result.status, 0, host);
    assert.match(result.stderr, /FlareSolverr hostname/);
    assert.doesNotMatch(result.stdout, /pct create/);
  }
});

test('maintenance rejects creation settings instead of silently changing the target or ignoring options', () => {
  for (const extra of [['--ctid', '121'], ['--nesting', 'yes'], ['--source-dir', '/root/source']]) {
    const result = run(['--reconnect', '120', '--flaresolverr-ctid', '125', '--dry-run', ...extra]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Creation options cannot be combined/);
  }
});
