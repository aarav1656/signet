import { encodeFunctionData, type Hex } from 'viem';
import { accountAbi } from '../../abi/AgentAccount.generated';
import { PAXOS_USDG, TSLA } from '../../lib/rhc.generated';
import { REQUESTED_MODEL_HASH, VENUE_GATEWAY_MEASUREMENT, VENUE_POOL } from '../../lib/venue';
import type { ParsedLimits, StepId } from './followPlan';

const ZERO32 = `0x${'0'.repeat(64)}` as const;

export type CallContext = { measurement: Hex; servedModelHash: Hex; usdg: ParsedLimits; tsla: ParsedLimits };

/** The AgentAccount call that performs one follow step. `admit` has no fixed call: it carries a fresh quote. */
export function followCalldata(step: Exclude<StepId, 'admit'>, ctx: CallContext): Hex {
  switch (step) {
    case 'limits-usdg':
      return encodeFunctionData({ abi: accountAbi, functionName: 'setLimits', args: [PAXOS_USDG, ctx.usdg] });
    case 'limits-tsla':
      return encodeFunctionData({ abi: accountAbi, functionName: 'setLimits', args: [TSLA, ctx.tsla] });
    case 'pool':
      return encodeFunctionData({ abi: accountAbi, functionName: 'setPool', args: [VENUE_POOL, true] });
    case 'model':
      return encodeFunctionData({ abi: accountAbi, functionName: 'setModel', args: [REQUESTED_MODEL_HASH, [ctx.servedModelHash, ZERO32, ZERO32, ZERO32], VENUE_GATEWAY_MEASUREMENT] });
    case 'measurement':
      return encodeFunctionData({ abi: accountAbi, functionName: 'setMeasurement', args: [ctx.measurement, true] });
  }
}
