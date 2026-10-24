import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// The reference agent's first CVM boot: two real trades, tx hashes in docs/e2e/robinhood-testnet-agent-account.md.
const M = '0x9dfd5de3a81d9aa78ab912b6a759c934ba79a20cf86ac57163d05ea4a5b364c8';
const FIRST_TRADE = '0xe50522661b55c797071b56e43aaf2bc91d37c9745a295ff6a5976883dd4ddfa2';

describe('get_track_record over MCP stdio', () => {
  const client = new Client({ name: 'test', version: '0' });
  before(async () => {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/server.ts'] }));
  });
  after(() => client.close());
  const call = async (args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name: 'get_track_record', arguments: args })) as { content: { text: string }[] }).content[0].text);

  it('is listed with the other tools', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes('get_track_record') && names.includes('verify_receipt'));
  });

  it('returns the trades behind one measurement', async () => {
    const r = await call({ measurement: M });
    assert.equal(r.found, true);
    assert.equal(r.agents[0].tradeCount, 2);
    assert.equal(r.agents[0].trades[0].tx, FIRST_TRADE);
    assert.equal(r.agents[0].trades[0].oracle.roundId.length > 0, true);
  });

  it('answers found:false for a measurement that never traded', async () => {
    const r = await call({ measurement: `0x${'cd'.repeat(32)}` });
    assert.equal(r.found, false);
    assert.equal(r.agents.length, 0);
  });

  it('rejects a malformed measurement', async () => {
    const res = (await client.callTool({ name: 'get_track_record', arguments: { measurement: '0x12' } })) as { isError?: boolean };
    assert.equal(res.isError, true);
  });
});
