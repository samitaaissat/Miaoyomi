import 'core-js/actual/url/index.js';
import 'core-js/actual/url-search-params/index.js';
import 'core-js/actual/atob.js';
import 'core-js/actual/btoa.js';
import * as cheerio from 'cheerio/slim';
import * as htmlparser2 from 'htmlparser2';
import dayjs from 'dayjs';
class Storage {
  data = new Map();
  constructor(seed = []) { this.data = new Map(seed); }
  set(key, value, expires) { this.data.set(key, { value, expires: expires instanceof Date ? expires.getTime() : expires }); }
  get(key, raw = false) { const item = this.data.get(key); if (!item) return; if (item.expires && Date.now() > item.expires) { this.delete(key); return; } return raw ? item : item.value; }
  delete(key) { this.data.delete(key); }
  clearAll() { this.data.clear(); }
  getAllKeys() { return Array.from(this.data.keys()); }
}
const unsupported = name => { throw Object.assign(new Error(`Unsupported host capability: ${name}`), { code: 'UNSUPPORTED_CAPABILITY' }); };
const bridge = globalThis.__hostFetch;
delete globalThis.__hostFetch;
class Headers {
  values = new Map();
  constructor(init = {}) { for (const [key, value] of init instanceof Headers || Array.isArray(init) ? init : Object.entries(init)) this.set(key, value); }
  set(key, value) { this.values.set(String(key).toLowerCase(), String(value)); }
  get(key) { return this.values.get(String(key).toLowerCase()) ?? null; }
  has(key) { return this.values.has(String(key).toLowerCase()); }
  append(key, value) { this.set(key, this.has(key) ? this.get(key) + ', ' + value : value); }
  delete(key) { this.values.delete(String(key).toLowerCase()); }
  entries() { return this.values.entries(); }
  [Symbol.iterator]() { return this.entries(); }
  forEach(fn) { for (const [key, value] of this.values) fn(value, key, this); }
}
class FormData {
  fields = [];
  append(key, value) { if (typeof value !== 'string' && typeof value !== 'number') unsupported('binary FormData'); this.fields.push([String(key), String(value)]); }
  set(key, value) { this.delete(key); this.append(key, value); }
  get(key) { return this.fields.find(x => x[0] === key)?.[1] ?? null; }
  getAll(key) { return this.fields.filter(x => x[0] === key).map(x => x[1]); }
  has(key) { return this.fields.some(x => x[0] === key); }
  delete(key) { this.fields = this.fields.filter(x => x[0] !== key); }
  entries() { return this.fields[Symbol.iterator](); }
  [Symbol.iterator]() { return this.entries(); }
}
globalThis.Headers = Headers; globalThis.FormData = FormData;
async function fetchApi(url, init = {}) {
  const headers = new Headers(init.headers); let body = init.body;
  if (body instanceof URLSearchParams) { body = body.toString(); if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8'); }
  if (body instanceof FormData) {
    const boundary = 'Miaoyomi' + Math.random().toString(36).slice(2);
    body = Array.from(body).map(([key, value]) => '--' + boundary + '\r\nContent-Disposition: form-data; name="' + key.replace(/[\r\n"]/g, '') + '"\r\n\r\n' + value + '\r\n').join('') + '--' + boundary + '--\r\n';
    headers.set('content-type', 'multipart/form-data; boundary=' + boundary);
  }
  if (body !== undefined && typeof body !== 'string') unsupported('non-string request body');
  const data = JSON.parse(await bridge(JSON.stringify({ url: String(url), init: { ...init, body, headers: Object.fromEntries(headers) } })));
  if (data.error) throw Object.assign(new Error(data.message), { code: data.error });
  const response = () => ({ ok: data.status >= 200 && data.status < 300, status: data.status, statusText: '', url: data.url, headers: new Headers(data.headers), text: async () => data.body, json: async () => JSON.parse(data.body), clone: response, arrayBuffer: () => unsupported('binary response in guest'), blob: () => unsupported('Blob') });
  return response();
}
const status = Object.fromEntries(['Unknown', 'Ongoing', 'Completed', 'Licensed', 'Cancelled', 'STUB', 'Inactive'].map(x => [x, x]));
status.PublishingFinished = 'Publishing Finished'; status.OnHiatus = 'On Hiatus';
const stores = Object.fromEntries(['storage', 'localStorage', 'sessionStorage'].map(name => [name, new Storage(globalThis.__storageSeed?.[name])]));
delete globalThis.__storageSeed;
globalThis.__exportStorage = () => Object.fromEntries(Object.entries(stores).map(([name, store]) => [name, Array.from(store.data)]));
const modules = Object.assign(Object.create(null), {
  cheerio, htmlparser2, dayjs,
  '@libs/fetch': { fetchApi, fetchText: async (...args) => (await fetchApi(...args)).text(), fetchProto: () => unsupported('fetchProto'), fetchFile: () => unsupported('fetchFile') },
  '@libs/storage': stores,
  '@libs/novelStatus': { NovelStatus: status },
  '@/types/constants': { NovelStatus: status, defaultCover: '' },
  '@libs/defaultCover': { defaultCover: '' },
  '@libs/isAbsoluteUrl': { isUrlAbsolute: value => /^https?:\/\//i.test(value) },
  '@libs/filterInputs': { FilterTypes: { TextInput: 'Text', Picker: 'Picker', CheckboxGroup: 'Checkbox', Switch: 'Switch', ExcludableCheckboxGroup: 'XCheckbox' } },
});
globalThis.require = name => Object.hasOwn(modules, name) ? modules[name] : unsupported(`module ${name}`);
globalThis.fetch = fetchApi;
globalThis.console = { log() {}, warn() {}, error() {}, debug() {} };
globalThis.setTimeout = () => unsupported('timers');
globalThis.setInterval = () => unsupported('timers');
globalThis.exports = {};
globalThis.module = { exports: globalThis.exports };
