import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentAccountAbi } from '../src/account-abi.js';
import { REFUSAL_GLOSS } from '../src/chain.js';

test('every custom error the account can revert with has a plain-words explanation', () => {
  const errors = agentAccountAbi.filter((x) => x.type === 'error').map((x) => (x as { name: string }).name);
  assert.ok(errors.length >= 40, `only ${errors.length} errors in the ABI`);
  assert.ok(errors.includes('CorporateActionPending'));
  assert.deepEqual(errors.filter((e) => !REFUSAL_GLOSS[e]), []);
});
