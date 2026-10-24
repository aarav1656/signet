import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('mcp/data/track-record.json equals the app snapshot in web/lib', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.equal(read('../data/track-record.json'), read('../../web/lib/track-record.json'));
});
