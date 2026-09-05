import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestQueueError } from '../src/lib/requestQueue';
import { GateError } from '../src/lib/gate';

test('only local queue pressure is excluded from permanent chapter failure accounting', async () => {
  process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:1/test';
  process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
  const { isLocalDownloadQueueError } = await import('../src/lib/chapterFailures');
  for (const code of ['QUEUE_FULL', 'QUEUE_TIMEOUT', 'CANCELLED', 'QUEUE_CLOSED'] as const) {
    assert.equal(isLocalDownloadQueueError(new RequestQueueError(code, code)), true, code);
  }
  assert.equal(isLocalDownloadQueueError(new RequestQueueError('REQUEST_TIMEOUT', 'execution deadline')), false,
    'an operation that acquired capacity and exceeded its deadline remains a real attempt');
  assert.equal(isLocalDownloadQueueError(new GateError('queue_timeout', 'download gate wait expired')), true,
    'the download gate shares the local queue error contract');
  assert.equal(isLocalDownloadQueueError(new Error('site failed')), false);
});
