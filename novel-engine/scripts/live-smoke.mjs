import { readFile } from 'node:fs/promises';
import { executePlugin } from '../src/executor.mjs';
import { NetworkBroker } from '../src/network.mjs';
const manifest = JSON.parse(await readFile(new URL('../vendor/registry.json', import.meta.url), 'utf8'));
const broker = new NetworkBroker({ solverUrl: process.env.FLARESOLVERR_URL || '' });
for (const id of process.argv.slice(2).length ? process.argv.slice(2) : ['royalroad', 'archiveofourown', 'scribblehub']) {
  const entry = manifest.sources.find(x => x.id === id);
  if (!entry) throw Error(`Unknown source ${id}`);
  const script = await readFile(new URL(`../vendor/scripts/${id}.js`, import.meta.url), 'utf8');
  const call = (method, args) => executePlugin(script, method, args, { deadlineMs: broker.solverUrl ? 80_000 : 30_000, fetch: (url, init, signal) => broker.fetch(entry, url, init, signal) });
  const report = { id, version: entry.version, digest: entry.digest };
  try {
    const browse = await call('popularNovels', [1, id === 'archiveofourown' ? { filters: { ratings: { value: '10', type: 'Picker' } } } : {}]); report.browseCount = browse.length;
    if (!browse[0]?.path) throw Error('No browse result');
    let detail; let selected;
    for (const candidate of browse) {
      try { detail = await call('parseNovel', [candidate.path]); selected = candidate; break; }
      catch (error) { if (error.code !== 'SOURCE_INTERSTITIAL') throw error; report.skippedInterstitials = (report.skippedInterstitials || 0) + 1; }
    }
    if (!selected) throw Error('All browse results require browser interaction');
    const search = await call('searchNovels', [selected.name, 1]); report.searchCount = search.length;
    report.title = detail.name; report.chapterCount = detail.chapters?.length;
    if (!detail.name || !detail.chapters?.[0]?.path) throw Error('Missing detail or chapters');
    const chapter = await call('parseChapter', [detail.chapters[0].path]); report.chapterLength = chapter?.length;
    if (typeof chapter !== 'string' || chapter.replace(/<[^>]+>/g, '').trim().length < 200) throw Error('Chapter is empty or too short');
    report.ok = true;
  } catch (error) { report.ok = false; report.error = error.code || 'SMOKE_FAILURE'; report.message = error.message; if (broker.solverUrl || id !== 'scribblehub' || error.code !== 'SITE_CHALLENGE') process.exitCode = 1; }
  console.log(JSON.stringify(report));
}
