import { createHash } from 'node:crypto';

export function assertIdentityPart(value: string): void {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value) || value.length > 8192) {
    throw new Error('Invalid source identity');
  }
}
export function assertArchiveId(value: string): void {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid archive identity');
}
// Preserve exact plugin paths: case, query strings, fragments and slashes can all
// be source-significant. Tuple encoding avoids concatenation collisions.
export function novelId(sourceId: string, path: string): string {
  assertIdentityPart(sourceId); assertIdentityPart(path);
  return createHash('sha256').update(JSON.stringify(['novel', sourceId, path])).digest('hex');
}
export function chapterId(novelId: string, path: string): string {
  assertArchiveId(novelId); assertIdentityPart(path);
  return createHash('sha256').update(JSON.stringify(['chapter', novelId, path])).digest('hex');
}
