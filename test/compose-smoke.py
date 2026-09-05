#!/usr/bin/env python3
"""Smoke test an EMPTY disposable Compose installation; never point at an existing library."""
import json
import os
import secrets
import urllib.error
import urllib.request

base = os.environ.get('MIAOYOMI_SMOKE_BASE', 'http://127.0.0.1:8080')

def request(path, body=None, token=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(base + path, headers=headers, data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(req, timeout=90) as response:
        return json.load(response)

assert request('/healthz')['ok'] is True
assert request('/api/setup/status')['needsSetup'] is True, 'Smoke requires a fresh, empty instance'
try:
    request('/api/novels/sources')
    raise AssertionError('Novel sources must require an account')
except urllib.error.HTTPError as error:
    assert error.code == 401
session = request('/api/setup', {'username': 'smoke', 'password': secrets.token_urlsafe(24)})
token = session['accessToken']
sources = request('/api/novels/sources', token=token)['sources']
assert len(sources) == 278
assert all(not source['enabled'] for source in sources)
assert any(source['id'] == 'royalroad' and source['supported'] for source in sources)
assert request('/api/novels/library', token=token)['items'] == []
for path in ['/novels', '/novels/title', '/novels/read', '/sw.js']:
    with urllib.request.urlopen(base + path) as response:
        assert response.status == 200 and len(response.read()) > 100
print('Compose smoke PASS: health, setup, authenticated runtime registry, empty library, static novel routes')
