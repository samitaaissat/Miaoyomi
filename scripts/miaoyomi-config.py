#!/usr/bin/env python3
"""Create local configuration without evaluating shell code or replacing existing settings."""
import os
import json
import re
import secrets
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote


def existing_values(root: Path, keys) -> dict:
    """Use Compose's parser so comments, quoting and interpolation match the actual deployment."""
    if not (root / '.env').exists():
        return {}
    document = {'services': {'config': {'image': 'scratch', 'environment': {
        key: '${' + key + '-}' for key in keys
    }}}}
    result = subprocess.run(
        ['docker', 'compose', '--project-name', 'miaoyomi-config', '--project-directory', str(root),
         '--env-file', str(root / '.env'), '-f', '-', 'config', '--format', 'json'],
        input=json.dumps(document), capture_output=True, text=True,
    )
    if result.returncode:
        # The parser can include input text in diagnostics; never echo a credential line.
        raise ValueError('Could not parse .env with Docker Compose; check its syntax and the Compose installation')
    # `config` renders a reusable Compose model, escaping literal dollars as $$.
    return {key: value.replace('$$', '$') for key, value in
            json.loads(result.stdout)['services']['config']['environment'].items()}


def key_of(line: str):
    match = re.match(r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]', line)
    return match.group(1) if match else None


def configure(root: Path) -> Path:
    env_file = root / '.env'
    previous = env_file.read_text() if env_file.exists() else ''
    uid, gid = os.getuid(), os.getgid()
    defaults = {
        'BIND_ADDRESS': '127.0.0.1', 'WEB_PORT': '8080', 'PUBLIC_ORIGIN': 'http://localhost:8080',
        'PUID': str(uid or 10002), 'PGID': str(gid if uid else 10002),
        'MANGA_LIBRARY_PATH': './data/manga', 'MANGA_DOWNLOAD_PATH': './data/downloaded-manga',
        'NOVEL_LIBRARY_PATH': './data/novels',
        'POSTGRES_PASSWORD': secrets.token_hex(24), 'JWT_SECRET': secrets.token_hex(48),
        'NOVEL_ENGINE_TOKEN': secrets.token_hex(32),
    }
    original = existing_values(root, [*defaults, 'DATABASE_URL'])
    values = dict(original)
    for key, value in defaults.items():
        if not values.get(key):
            values[key] = value
    if not values.get('DATABASE_URL'):
        values['DATABASE_URL'] = 'postgresql://miaoyomi:' + quote(values['POSTGRES_PASSWORD'], safe='') + '@db:5432/miaoyomi'
    for key in ('PUID', 'PGID'):
        if not values[key].isdigit() or int(values[key]) <= 0:
            raise ValueError(f'{key} must be a positive non-root numeric ID')
    # Preserve all comments, unknown fields and populated values; fill empty keys in-place.
    lines, written = [], set()
    for line in previous.splitlines():
        key = key_of(line)
        if key in defaults or key == 'DATABASE_URL':
            if key in written:
                raise ValueError(f'Duplicate configuration key: {key}')
            written.add(key)
            if not original.get(key):
                line = f'{key}={values[key]}'
        lines.append(line)
    lines.extend(f'{key}={value}' for key, value in values.items() if key not in written and key in {*defaults, 'DATABASE_URL'})
    temp = env_file.with_name('.env.miaoyomi.tmp')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w') as out:
            out.write('\n'.join(lines) + '\n'); out.flush(); os.fsync(out.fileno())
        os.replace(temp, env_file)
    finally:
        temp.unlink(missing_ok=True)
    for key in ('MANGA_LIBRARY_PATH', 'MANGA_DOWNLOAD_PATH', 'NOVEL_LIBRARY_PATH'):
        path = Path(values[key]).expanduser()
        if not path.is_absolute():
            path = root / path
        existed = path.exists()
        path.mkdir(parents=True, exist_ok=True)
        # A root-run LXC bootstrap assigns only newly-created directories, never existing libraries.
        if os.getuid() == 0 and not existed:
            os.chown(path, int(values['PUID']), int(values['PGID']))
    return env_file


if __name__ == '__main__':
    root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent
    print(f'Configuration ready: {configure(root)} (credentials not printed)')
