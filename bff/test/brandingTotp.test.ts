import test from 'node:test';
import assert from 'node:assert/strict';
import { otpauthURL, verifyTotp } from '../src/lib/totp';
test('new authenticator enrollments identify Miaoyomi', () => {
 const url = new URL(otpauthURL('JBSWY3DPEHPK3PXP','reader'));
 assert.equal(url.searchParams.get('issuer'),'Miaoyomi');
 assert.equal(url.pathname,'/Miaoyomi:reader');
 assert.equal(new URL(otpauthURL('JBSWY3DPEHPK3PXP','reader','Custom')).searchParams.get('issuer'),'Custom');
});
test('existing TOTP secrets retain RFC6238 codes after issuer change', () => {
 const original = Date.now;
 Date.now = () => 59000;
 try { assert.equal(verifyTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ','287082',0),true); assert.equal(verifyTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ','000000',0),false); } finally { Date.now=original; }
});
