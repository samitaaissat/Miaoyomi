// Browsing and installing Mihon/Tachiyomi extensions on the connected Suwayomi server.
//
// Uchiyomi is a remote control here, not a store: the catalogue comes from repositories the OPERATOR has
// configured on their own server, and Suwayomi does the fetching and installing. No repository URL ships in
// this codebase, and nothing is fetched until someone adds one.
//
// Operation names and shapes verified live against Suwayomi-Server v2.3.2243.
import { gql as defaultGql, type Gql } from './client';

export interface ExtensionInfo {
  pkgName: string;
  name: string;
  lang: string | null;
  versionName: string | null;
  iconUrl: string | null;
  installed: boolean;
  hasUpdate: boolean;
  obsolete: boolean;
  nsfw: boolean;
  repo: string | null;
}

interface RawExtension {
  pkgName: string; name?: string | null; lang?: string | null; versionName?: string | null;
  iconUrl?: string | null; isInstalled?: boolean | null; hasUpdate?: boolean | null;
  isObsolete?: boolean | null; isNsfw?: boolean | null; repo?: string | null;
}

const EXT_FIELDS = 'pkgName name lang versionName iconUrl isInstalled hasUpdate isObsolete isNsfw repo';

const toInfo = (e: RawExtension): ExtensionInfo | null =>
  e?.pkgName
    ? {
        pkgName: e.pkgName,
        name: e.name?.trim() || e.pkgName,
        lang: e.lang || null,
        versionName: e.versionName || null,
        iconUrl: e.iconUrl || null,
        installed: !!e.isInstalled,
        hasUpdate: !!e.hasUpdate,
        obsolete: !!e.isObsolete,
        nsfw: !!e.isNsfw,
        repo: e.repo || null,
      }
    : null;

/** Everything the configured repositories offer, plus what is already installed. */
export async function listExtensions(run: Gql = defaultGql): Promise<ExtensionInfo[]> {
  const d = await run<{ extensions: { nodes: RawExtension[] } }>(`{ extensions { nodes { ${EXT_FIELDS} } } }`, {}, 30000);
  const nodes = d?.extensions?.nodes;
  return Array.isArray(nodes) ? nodes.map(toInfo).filter((e): e is ExtensionInfo => !!e) : [];
}

/**
 * Re-read the repositories. Slow (it downloads each repo index), so it runs when someone asks for it or on
 * the scheduled extension check -- never on every catalogue read.
 *
 * This is the ONLY thing that makes the engine recompute "update available". Its previous one-line comment
 * said "only ever explicit", and that sentence was the bug: the nightly auto-updater read the catalogue
 * without ever calling this, so it compared against whatever an admin had last refreshed by hand and found
 * nothing to do, indefinitely.
 */
export async function refreshExtensions(run: Gql = defaultGql, timeoutMs = 120000): Promise<number> {
  const d = await run<{ fetchExtensions: { extensions: RawExtension[] } }>(
    `mutation{ fetchExtensions(input:{}){ extensions { pkgName } } }`, {}, timeoutMs,
  );
  return d?.fetchExtensions?.extensions?.length ?? 0;
}

export type ExtensionAction = 'install' | 'uninstall' | 'update';

export async function setExtensionState(pkgName: string, action: ExtensionAction, run: Gql = defaultGql): Promise<boolean> {
  const patch = action === 'install' ? 'install:true' : action === 'uninstall' ? 'uninstall:true' : 'update:true';
  const d = await run<{ updateExtension: { extension: RawExtension | null } }>(
    `mutation($id:String!){ updateExtension(input:{id:$id,patch:{${patch}}}){ extension { pkgName isInstalled } } }`,
    { id: pkgName },
    180000, // installing downloads an APK and converts its bytecode; it is genuinely slow
  );
  return !!d?.updateExtension?.extension;
}

/** The source ids one installed extension provides — an extension can carry several (one per language). */
export async function sourcesOfExtension(pkgName: string, run: Gql = defaultGql): Promise<Array<{ id: string; name: string; lang: string | null; nsfw: boolean }>> {
  const d = await run<{ extensions: { nodes: Array<{ pkgName: string; source?: { nodes?: Array<{ id: string; name?: string; lang?: string; isNsfw?: boolean }> } }> } }>(
    `{ extensions { nodes { pkgName source { nodes { id name lang isNsfw } } } } }`, {}, 30000,
  );
  const hit = (d?.extensions?.nodes || []).find((e) => e.pkgName === pkgName);
  return (hit?.source?.nodes || [])
    .filter((s) => s && s.id != null)
    .map((s) => ({ id: String(s.id), name: s.name || pkgName, lang: s.lang ?? null, nsfw: !!s.isNsfw }));
}

// ---- extension repositories -------------------------------------------------

export async function getRepos(run: Gql = defaultGql): Promise<string[]> {
  const d = await run<{ extensionStores: { nodes: Array<{ indexUrl?: string | null }> } }>(
    `{ extensionStores { nodes { indexUrl } } }`, {}, 15000,
  );
  const nodes = d?.extensionStores?.nodes;
  return Array.isArray(nodes)
    ? nodes.map((store) => store?.indexUrl).filter((url): url is string => !!url)
    : [];
}

/** Register one store and wait until Suwayomi has fetched and persisted it. */
export async function addRepo(url: string, run: Gql = defaultGql): Promise<string> {
  const d = await run<{ addExtensionStore: { extensionStore: { indexUrl: string } } | null }>(
    `mutation($url:String!){ addExtensionStore(input:{indexUrl:$url}){ extensionStore { indexUrl } } }`,
    { url },
    120000,
  );
  const added = d?.addExtensionStore?.extensionStore?.indexUrl;
  if (!added) throw new Error('suwayomi did not register the extension repository');
  return added;
}

/** Remove one store by the canonical index URL Suwayomi returned when it was added. */
export async function removeRepo(url: string, run: Gql = defaultGql): Promise<void> {
  await run(
    `mutation($url:String!){ removeExtensionStore(input:{indexUrl:$url}){ extensionStore { indexUrl } } }`,
    { url },
    30000,
  );
}

/**
 * Reconcile the store list through Suwayomi's native v2.3 API.
 *
 * Adds finish before removals begin, so a rejected replacement cannot destroy the working configuration.
 * A store descriptor may canonicalize itself (for example repo.json -> index.pb); retain that returned URL
 * because it is the database key the remove mutation expects.
 */
export async function setRepos(urls: string[], run: Gql = defaultGql): Promise<string[]> {
  const current = await getRepos(run);
  const wanted = [...new Set(urls)];
  const resolved: string[] = [];

  for (const url of wanted) {
    resolved.push(current.includes(url) ? url : await addRepo(url, run));
  }

  const final = [...new Set(resolved)];
  const keep = new Set(final);
  for (const url of current) {
    if (!keep.has(url)) await removeRepo(url, run);
  }

  return final;
}

/** Trim whitespace a paste can carry. Nothing semantic — see altRepoUrl for that. */
export function normalizeRepoUrl(raw: string): string {
  return raw.trim().replace(/\s+/g, '');
}

/**
 * A second URL worth trying when Suwayomi rejects a repository URL.
 *
 * This is insurance, not a rule. The native addExtensionStore mutation fetches and validates the index
 * before it returns, so an empty catalogue is no longer an asynchronous-settings signal. Repository layouts
 * still vary, though: some serve their catalogue only at a full index path, and a bare directory URL is a
 * reasonable thing for someone to paste, so a rejected registration gets one alternative.
 *
 * The caller must verify: try what the user typed, and keep this alternative ONLY if it registers.
 * Rewriting a URL blindly would break repositories where the original form is the correct one.
 */
export function altRepoUrl(raw: string): string | null {
  const u = raw.trim().replace(/\s+/g, '');
  if (/\/index\.min\.json$/i.test(u)) return u.replace(/\/index\.min\.json$/i, '/index.json');
  if (/\/$/.test(u)) return `${u}index.json`;
  if (!/\.(json|pb)$/i.test(u)) return `${u}/index.json`;
  return null;
}
