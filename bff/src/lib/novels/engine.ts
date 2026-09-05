import { env } from '../../env';
import { NovelError, type NovelEngine, type EngineSource } from './apiTypes';
import { sourceUrl } from './catalog';

/** Plugin paths may be opaque API IDs. Only an absent resolver permits the ordinary URL fallback. */
export async function resolveSourceUrl(engine: NovelEngine, source: EngineSource, path: string, isNovel: boolean): Promise<string> {
  let resolved: unknown;
  try { resolved = await engine.invoke(source.id, 'resolveUrl', [path, isNovel]); }
  catch (error) {
    if (error instanceof NovelError && error.code === 'UNSUPPORTED_CAPABILITY' && error.message === 'Plugin does not support method resolveUrl') {
      return sourceUrl(source, path);
    }
    throw error;
  }
  if (typeof resolved !== 'string' || !resolved.trim()) throw new NovelError(502, 'invalid_source_url', 'The source returned an invalid link.');
  return sourceUrl(source, resolved);
}

export function createNovelEngine(base = env.NOVEL_ENGINE_URL, token = env.NOVEL_ENGINE_TOKEN): NovelEngine {
  async function request(path: string, body?: unknown): Promise<Response> {
    if (!base || !token) throw new NovelError(503, 'engine_unconfigured', 'The novel source service is not configured.');
    let response: Response;
    try {
      response = await fetch(base.replace(/\/$/, '') + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90_000),
      });
    } catch {
      throw new NovelError(503, 'engine_unavailable', 'The novel source service is unavailable. Try again shortly.');
    }
    if (!response.ok) {
      const detail = await response.json().catch(() => ({})) as any;
      const status = response.status === 401 ? 503 : response.status;
      throw new NovelError(status, String(detail.error || 'source_error'), String(detail.message || 'The source request failed.'));
    }
    return response;
  }
  return {
    async sources() { return ((await (await request('/v1/sources')).json()) as {sources: EngineSource[]}).sources; },
    async source(id) { return ((await (await request(`/v1/sources/${encodeURIComponent(id)}`)).json()) as {source: EngineSource}).source; },
    async enable(id, enabled) { return ((await (await request(`/v1/sources/${encodeURIComponent(id)}`, {enabled})).json()) as {source: EngineSource}).source; },
    async invoke(sourceId, method, args) { return ((await (await request('/v1/invoke', {sourceId, method, args})).json()) as {result: unknown}).result; },
    async asset(sourceId, url) {
      const r = await request('/v1/asset', {sourceId, url});
      const contentType = (r.headers.get('content-type') || '').split(';')[0].trim();
      if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(contentType)) {
        throw new NovelError(502, 'invalid_asset', 'The source returned an unsupported image.');
      }
      const max = 10 * 1024 * 1024;
      if (Number(r.headers.get('content-length')) > max) { await r.body?.cancel(); throw new NovelError(502, 'asset_too_large', 'The source image is too large.'); }
      const chunks: Uint8Array[] = []; let length = 0;
      if (!r.body) throw new NovelError(502, 'invalid_asset', 'The source returned an empty image.');
      for await (const chunk of r.body as any as AsyncIterable<Uint8Array>) {
        length += chunk.length;
        if (length > max) throw new NovelError(502, 'asset_too_large', 'The source image is too large.');
        chunks.push(chunk);
      }
      return {bytes: Buffer.concat(chunks), contentType};
    },
  };
}
