import { useQuery } from '@tanstack/react-query';
import type { Hex } from 'viem';
import { usePublicClient } from 'wagmi';
import { rhcChain, rhcExplorer } from '../../chain';
import { HexValue } from '../../components/Stamp';
import { fmtWhen } from '../../lib/format';
import { fmtAmount, TRACK, type TrackAgent, type TrackRefusal, type TrackTrade } from '../../lib/track';
import { modelNameOf, symbolOf } from '../../lib/venue';
import { RHC_EXPLORER_URL } from '../../lib/rhc.generated';

const GROUP = 8;

/** A 32-byte value as eight 4-byte groups. Groups that differ from `against` are marked. */
export function HashDiff({ value, against, tone }: { value: Hex; against?: Hex; tone: 'ok' | 'refused' }) {
  const body = value.slice(2);
  const other = against?.slice(2);
  const groups = Array.from({ length: body.length / GROUP }, (_, i) => body.slice(i * GROUP, (i + 1) * GROUP));
  return (
    <span className={`sg-hash ${tone}`} title={value}>
      {groups.map((g, i) => (
        <span key={i} className={other && other.slice(i * GROUP, (i + 1) * GROUP) !== g ? 'sg-g diff' : 'sg-g'}>{g}</span>
      ))}
    </span>
  );
}

type Receipt = { status: 'success' | 'reverted'; block: bigint; gasUsed: bigint };

export function useReceipts(hashes: Hex[]) {
  const client = usePublicClient({ chainId: rhcChain.id });
  return useQuery({
    queryKey: ['signet-receipts', ...hashes],
    enabled: !!client && hashes.length > 0,
    staleTime: 60_000,
    retry: 1,
    queryFn: async (): Promise<Receipt[]> =>
      Promise.all(hashes.map(async (hash) => {
        const r = await client!.getTransactionReceipt({ hash });
        return { status: r.status, block: r.blockNumber, gasUsed: r.gasUsed };
      })),
  });
}

/** The explorer's decoding of a mined revert: the RPC prunes old state, so the reason cannot be replayed. */
function useRevertReason(hash: Hex | undefined) {
  return useQuery({
    queryKey: ['signet-revert', hash],
    enabled: !!hash,
    staleTime: Infinity,
    retry: 1,
    queryFn: async (): Promise<{ call: string; param?: string }> => {
      const r = await fetch(`${RHC_EXPLORER_URL}/api/v2/transactions/${hash}`);
      if (!r.ok) throw new Error(`explorer answered ${r.status}`);
      const j = (await r.json()) as { revert_reason?: { method_call?: string; parameters?: { value?: string }[] } };
      const call = j.revert_reason?.method_call;
      if (!call) throw new Error('the explorer has no decoded revert for this transaction');
      return { call: call.split('(')[0], param: j.revert_reason?.parameters?.[0]?.value };
    },
  });
}

/** The passing attested trade and the refusal to set beside it: the newest trade of any agent, and the refusal of a different workload. */
export function pickProof(agents: readonly TrackAgent[], refusals: readonly TrackRefusal[]): { agent: TrackAgent; trade: TrackTrade; refusal: TrackRefusal } | undefined {
  // A different workload is a refused admission whose measurement no listed agent carries.
  const listed = new Set(agents.map((a) => a.measurement.toLowerCase()));
  const refusal = [...refusals].sort((a, b) => b.block - a.block).find((r) => r.reason === 'MeasurementNotApproved' && !listed.has(r.measurement.toLowerCase()));
  const all = agents.flatMap((agent) => agent.trades.map((trade) => ({ agent, trade })));
  const latest = all.sort((a, b) => b.trade.block - a.trade.block)[0];
  return refusal && latest ? { ...latest, refusal } : undefined;
}

export function SwapProof() {
  const proof = pickProof(TRACK.agents, TRACK.refusals);
  const hashes = proof ? [proof.trade.tx, proof.refusal.tx] : [];
  const rc = useReceipts(hashes);
  const reason = useRevertReason(proof?.refusal.tx);
  if (!proof) {
    return (
      <section className="section" aria-labelledby="swap-h">
        <div className="section-head"><h2 id="swap-h" className="t-section">Swap the code</h2></div>
        <p className="section-intro">The proof needs one attested trade and one refused workload on the same chain. Both come from the chain's own events, and the first of each appears here once the track record includes it.</p>
      </section>
    );
  }
  const { agent, trade, refusal } = proof;
  const [passRc, refRc] = rc.data ?? [];
  const passLive = passRc?.status === 'success';
  const refLive = refRc?.status === 'reverted';
  const decoded = reason.data;
  const model = modelNameOf(trade.modelHash);
  return (
    <section className="section" aria-labelledby="swap-h">
      <div className="section-head">
        <h2 id="swap-h" className="t-section">Swap the code and the account says no</h2>
        <span className="stamp">both transactions re-read from Robinhood Chain testnet</span>
      </div>
      <p className="section-intro">
        An account trades for the workload its owner approved. A different workload, carrying a valid Intel TDX quote of its own, is refused,
        because its measurement is not one the owner approved. The two measurements below are the two workloads.
      </p>
      <div className="sg-swap">
        <article className="sg-case ok" aria-labelledby="sw-ok">
          <header>
            <i className="d" aria-hidden="true" />
            <h3 id="sw-ok" className="t-subject">Approved workload trades</h3>
            <code>{rc.isPending ? 'READING' : passLive ? 'EXECUTED' : 'NOT CONFIRMED'}</code>
          </header>
          <dl>
            <div><dt>Measurement</dt><dd><HashDiff value={agent.measurement} against={refusal.measurement} tone="ok" /></dd></div>
            <div><dt>Trade</dt><dd>{fmtAmount(trade.amountIn)} {symbolOf(trade.tokenIn)} for {fmtAmount(trade.amountOut)} {symbolOf(trade.tokenOut)}</dd></div>
            <div><dt>Model on the receipt</dt><dd>{model ?? 'a model hash'} <HexValue value={trade.modelHash} head={6} tail={4} /></dd></div>
            <div><dt>Transaction</dt><dd><HexValue value={trade.tx} head={8} tail={6} href={rhcExplorer.tx(trade.tx)} /> <span className="small">block {(passRc?.block ?? BigInt(trade.block)).toLocaleString('en-US')}, {fmtWhen(trade.time)}</span></dd></div>
          </dl>
        </article>
        <article className="sg-case refused" aria-labelledby="sw-no">
          <header>
            <i className="d ring" aria-hidden="true" />
            <h3 id="sw-no" className="t-subject">Different workload is refused</h3>
            <code>{rc.isPending ? 'READING' : refLive ? 'REVERTED' : 'NOT CONFIRMED'}</code>
          </header>
          <dl>
            <div><dt>Measurement</dt><dd><HashDiff value={refusal.measurement} against={agent.measurement} tone="refused" /></dd></div>
            <div>
              <dt>Account answered</dt>
              <dd>
                <code className="sg-err">{decoded ? `${decoded.call}(${decoded.param ? 'measurement' : ''})` : `${refusal.reason}()`}</code>
                {decoded?.param && decoded.param.toLowerCase() === refusal.measurement.toLowerCase() && <span className="small"> naming the measurement it refused</span>}
                {reason.isError && <span className="small"> recorded reason, the explorer index did not answer</span>}
              </dd>
            </div>
            <div><dt>Call</dt><dd><code>{refusal.method ?? 'registerAgent'}(quote, refBlock)</code> <span className="small">on <HexValue value={refusal.account} head={6} tail={4} href={rhcExplorer.address(refusal.account)} /></span></dd></div>
            <div><dt>Transaction</dt><dd><HexValue value={refusal.tx} head={8} tail={6} href={rhcExplorer.tx(refusal.tx)} /> <span className="small">block {(refRc?.block ?? BigInt(refusal.block)).toLocaleString('en-US')}, {fmtWhen(refusal.time)}</span></dd></div>
          </dl>
        </article>
      </div>
      <p className="sg-swap-note">Highlighted groups are the 4-byte words of the measurement that differ between the two workloads.</p>
    </section>
  );
}
