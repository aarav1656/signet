import { readFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { selectTrackRecord, type TrackRecord } from './trackrecord.js';

const measurement = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'a 32-byte hex TDX workload measurement');

/** Snapshot written by scripts/track-record.ts; CHIRON_TRACK_RECORD overrides the path. */
// The hosted endpoint deploys mcp/ alone, so it reads the copy in mcp/data (kept equal to web/lib by test/track-record-copy.test.ts).
const SNAPSHOTS = [new URL('../data/track-record.json', import.meta.url), new URL('../../web/lib/track-record.json', import.meta.url)];
const load = (): TrackRecord => {
  if (process.env.CHIRON_TRACK_RECORD) return JSON.parse(readFileSync(process.env.CHIRON_TRACK_RECORD, 'utf8'));
  for (const u of SNAPSHOTS) { try { return JSON.parse(readFileSync(u, 'utf8')); } catch { continue; } }
  throw new Error('track record snapshot not found in mcp/data or web/lib');
};

export function registerTrackRecord(server: McpServer): void {
  server.registerTool(
    'get_track_record',
    {
      description:
        'Track record of the attested agent that ran under one TDX workload measurement on Robinhood Chain testnet (46630): every executed trade with its tx hash, block, the Chainlink round that priced it and the recorded model hash, plus PnL, return and the refusals issued against that measurement. Omit measurement to list every agent. Feed each trade tx to verify_receipt to check it against the chain.',
      inputSchema: { measurement: measurement.optional() },
    },
    async ({ measurement }) => ({ content: [{ type: 'text' as const, text: JSON.stringify(selectTrackRecord(load(), measurement), null, 2) }] }),
  );
}
