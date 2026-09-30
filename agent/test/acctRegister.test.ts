// report_data layout the Verifier enforces for an agent quote (verifier/src/lib.rs: signer is
// report_data[0..20], report_data[20..32] must be zero, report_data[32..64] must equal the nonce).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexToBytes, keccak256, toHex, type Address } from 'viem';
import { agentReportData } from '../src/account.ts';

const agent: Address = '0x2aD12a72362704367e99a344cFf5affDDF7f5DEF';
const nonce = keccak256(toHex('attestNonce(refBlock) at epoch 1'));

test('agentReportData is agent || 0^12 || nonce, exactly 64 bytes', () => {
  const b = hexToBytes(agentReportData(agent, nonce));
  assert.equal(b.length, 64);
  assert.equal(toHex(b.slice(0, 20)), agent.toLowerCase());
  assert.ok(b.slice(20, 32).every((x) => x === 0));
  assert.equal(toHex(b.slice(32, 64)), nonce);
});

test('a different nonce or agent changes the bound bytes', () => {
  const base = agentReportData(agent, nonce);
  assert.notEqual(agentReportData(agent, keccak256(toHex('epoch 2'))), base);
  assert.notEqual(agentReportData('0x0000000000000000000000000000000000000001', nonce), base);
});
