import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { storedLocale, storeLocale } from '../lib/i18n';
test('installed app and translated UI use Miaoyomi', () => {
 const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8'));
 assert.equal(manifest.name, 'Miaoyomi');
 for (const f of readdirSync('public/locales')) assert.doesNotMatch(readFileSync(`public/locales/${f}`, 'utf8'), /uchiyomi/i);
 assert.match(readFileSync('components/Brand.tsx','utf8'), /miaoyomi-mark/);
});
test('legacy language preference migrates without overwriting a current choice', () => {
 const values = new Map([['uchiyomi.lang', 'fr']]);
 Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string,v: string) => values.set(k,v) } });
 assert.equal(storedLocale(), 'fr');
 assert.equal(values.get('miaoyomi.lang'), 'fr');
 storeLocale('ja');
 assert.equal(storedLocale(), 'ja');
 assert.equal(values.get('uchiyomi.lang'), 'fr');
 values.set('miaoyomi.lang','invalid');
 assert.equal(storedLocale(), 'fr');
 Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => { throw new Error('denied'); } } });
 assert.equal(storedLocale(), null);
 delete (globalThis as any).localStorage;
});
