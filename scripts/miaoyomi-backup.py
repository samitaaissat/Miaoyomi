#!/usr/bin/env python3
"""Consistent full backup, and restoration into a new, empty Compose installation."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent


def compose_command():
    mode = os.environ.get('MIAOYOMI_COMPOSE_MODE', 'production')
    files = [ROOT / 'docker-compose.yml']
    if mode == 'dev':
        files.append(ROOT / 'docker-compose.dev.yml')
    elif mode != 'production':
        raise ValueError('MIAOYOMI_COMPOSE_MODE must be production or dev')
    command = ['docker', 'compose']
    for file in files:
        command.extend(('-f', str(file)))
    return command


COMPOSE = compose_command()
WRITERS = ('app', 'novel-engine', 'suwayomi')
MOUNTS = {
    'config': ('app', '/config'), 'manga': ('app', '/library'),
    'downloaded-manga': ('app', '/library-dl'), 'novels': ('app', '/novels'),
    'novel-engine': ('novel-engine', '/state'),
    'suwayomi': ('suwayomi', '/home/suwayomi/.local/share/Tachidesk'),
}


def run(args, **kwargs):
    return subprocess.run(args, check=True, cwd=ROOT, **kwargs)


def output(args):
    return run(args, stdout=subprocess.PIPE).stdout


def digest(file):
    h = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def empty_probe_arguments(root='/data'):
    # Fresh ext filesystems can contain lost+found. Preserve the empty directory, but reject any
    # recovered files in it, any other entry, or a non-directory carrying the same name.
    return [root, '-mindepth', '1', '-maxdepth', '2', '!', '(', '-path', f'{root}/lost+found',
            '-type', 'd', ')', '-print', '-quit']


def mount_command(config, name, readonly):
    service, target = MOUNTS[name]
    mount = next(m for m in config['services'][service]['volumes'] if m['target'] == target)
    source = mount['source']
    if mount['type'] == 'volume':
        source = config['volumes'][source]['name']
        run(['docker', 'volume', 'create', source], stdout=subprocess.DEVNULL)
    elif mount['type'] == 'bind':
        source = str(Path(source).resolve())
        Path(source).mkdir(parents=True, exist_ok=True)
    else:
        raise ValueError('Only bind and named volumes can be backed up')
    if ',' in source:
        raise ValueError('Docker --mount cannot safely represent a path containing a comma')
    spec = f"type={mount['type']},source={source},target=/data" + (',readonly' if readonly else '')
    return ['docker', 'run', '--rm', '-i', '--network', 'none', '--user', '0:0',
            '--mount', spec, '--entrypoint', 'tar', config['services']['app']['image']]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['backup', 'restore-empty'])
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    folder = args.directory.resolve()
    config = json.loads(output(COMPOSE + ['config', '--format', 'json']))
    # A backup inside a captured library would recursively archive itself.
    for service, target in MOUNTS.values():
        mount = next(m for m in config['services'][service]['volumes'] if m['target'] == target)
        if mount['type'] == 'bind' and folder.is_relative_to(Path(mount['source']).resolve()):
            raise ValueError('Choose a backup directory outside all library bind mounts')
    commands = {name: mount_command(config, name, args.action == 'backup') for name in MOUNTS}
    if args.action == 'backup':
        folder.mkdir(parents=True, exist_ok=False)
        running = output(COMPOSE + ['ps', '--status', 'running', '--services']).decode().splitlines()
        restart = [name for name in WRITERS if name in running]
        if 'db' not in running:
            raise ValueError('The database must be running for backup')
        try:
            if restart:
                run(COMPOSE + ['stop', '-t', '120', *restart])
            with (folder / 'database.dump').open('wb') as stream:
                run(COMPOSE + ['exec', '-T', 'db', 'pg_dump', '-U', 'miaoyomi', '-d', 'miaoyomi',
                               '-Fc', '--no-owner', '--no-acl'], stdout=stream)
            for name, command in commands.items():
                with (folder / f'{name}.tar.gz').open('wb') as stream:
                    run(command + ['-czf', '-', '-C', '/data', '.'], stdin=subprocess.DEVNULL, stdout=stream)
            shutil.copyfile(ROOT / '.env', folder / 'configuration.env')
            manifest = {'version': 1, 'files': {file.name: digest(file) for file in folder.iterdir() if file.is_file()}}
            (folder / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
            print(f'Full backup complete: {folder} (contains credentials; keep private)')
        finally:
            if restart:
                run(COMPOSE + ['start', *restart])
    else:
        manifest = json.loads((folder / 'manifest.json').read_text())
        expected = {'database.dump', 'configuration.env', *(f'{name}.tar.gz' for name in MOUNTS)}
        if manifest.get('version') != 1 or set(manifest['files']) != expected:
            raise ValueError('Unsupported or incomplete backup manifest')
        for name, checksum in manifest['files'].items():
            if digest(folder / name) != checksum:
                raise ValueError(f'Backup checksum mismatch: {name}')
        running = output(COMPOSE + ['ps', '--status', 'running', '--services']).decode().splitlines()
        if any(name in running for name in WRITERS):
            raise ValueError('Restore requires a NEW empty installation with writers stopped')
        # Refuse every nonempty destination before writing any payload.
        for name, command in commands.items():
            probe = command.copy()
            probe[probe.index('--entrypoint') + 1] = 'find'
            if output(probe + empty_probe_arguments()).strip():
                raise ValueError(f'Refusing nonempty destination: {name}')
        run(COMPOSE + ['up', '-d', '--wait', 'db'])
        count = output(COMPOSE + ['exec', '-T', 'db', 'psql', '-U', 'miaoyomi', '-d', 'miaoyomi', '-Atc',
                                 "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"]).strip()
        if count != b'0':
            raise ValueError('Refusing to restore over a nonempty database')
        for name, command in commands.items():
            with (folder / f'{name}.tar.gz').open('rb') as stream:
                run(command + ['-xzf', '-', '-C', '/data'], stdin=stream)
        with (folder / 'database.dump').open('rb') as stream:
            run(COMPOSE + ['exec', '-T', 'db', 'pg_restore', '-U', 'miaoyomi', '-d', 'miaoyomi',
                           '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl'], stdin=stream)
        command = 'docker compose -f docker-compose.yml'
        if os.environ.get('MIAOYOMI_COMPOSE_MODE') == 'dev':
            command += ' -f docker-compose.dev.yml'
        command += ' up -d --wait'
        if os.environ.get('MIAOYOMI_COMPOSE_MODE') == 'dev':
            command += ' --build'
        print(f'Restore complete. Start with: {command}')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f'Backup/restore failed: {error}', file=sys.stderr)
        sys.exit(1)
