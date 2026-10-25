import { useEffect } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { rhcExplorer } from '../../chain';
import { HexValue, TitleBlock } from '../../components/Stamp';
import { fmtCountdown, fmtWhen, short } from '../../lib/format';
import { RHC_VERIFIER } from '../../lib/rhc.generated';
import { executedPriceUsd, fmtAmount, fmtDollars, fmtPct, fmtSignedDollars, strategyById, STRATEGIES, TRACK, type Strategy, type TrackRefusal, type TrackTrade } from '../../lib/track';
import { modelNameOf, symbolOf } from '../../lib/venue';
import { FollowPanel } from './Follow';
import { HashDiff, SwapProof, useReceipts } from './SwapProof';
import { useVerdict } from './Leaderboard';
import { useAdmissions, useStrategyChecks, type TradeCheck } from './verify';

function tradeTitle(t: TrackTrade): string {
  const [i, o] = [symbolOf(t.tokenIn), symbolOf(t.tokenOut)];
  const verb = i === 'USDG' ? 'Bought' : 'Sold';
  const stock = verb === 'Bought' ? `${fmtAmount(t.amountOut)} ${o}` : `${fmtAmount(t.amountIn)} ${i}`;
  const usd = verb === 'Bought' ? `${fmtAmount(t.amountIn)} ${i}` : `${fmtAmount(t.amountOut)} ${o}`;
  const px = executedPriceUsd({ ...t, tokenIn: i, tokenOut: o });
  return `${verb} ${stock} for ${usd}${px ? ` at ${fmtDollars(px)}` : ''}`;
}

const REFUSAL_TEXT: Record<string, string> = {
  ExceedsPerTradeCap: "above the owner's per-trade limit, so no swap ran",
  NotAgent: 'the caller was not the key admitted on this account',
  MeasurementNotApproved: 'the measurement in the quote is not one the owner approved',
};

function ReceiptLine({ check }: { check?: TradeCheck }) {
  if (!check) return <p className="rcpt">Reading the transaction from the chain</p>;
  if (!check.ok) return <p className="rcpt">Does not verify: {check.detail}</p>;
  const r = check.receipt;
  if (!r || r.state === 'checking') return <p className="rcpt">Recomputing the receipt hash in your browser</p>;
  return r.state === 'verified'
    ? <p className="rcpt ok">Receipt hash recomputed in your browser, {r.checks.length} checks match the chain</p>
    : <p className="rcpt">Receipt hash mismatch: {r.checks.filter((c) => !c.ok).map((c) => c.name).join(', ') || r.reason}</p>;
}

type Item = { kind: 'trade'; block: number; trade: TrackTrade } | { kind: 'refusal'; block: number; refusal: TrackRefusal };

function Timeline({ strategy }: { strategy: Strategy }) {
  const q = useStrategyChecks(strategy);
  const mine = new Set(strategy.boots.map((b) => b.measurement.toLowerCase()));
  const refusals = TRACK.refusals.filter((r) => mine.has(r.measurement.toLowerCase()));
  const refused = useReceipts(refusals.map((r) => r.tx));
  const items: Item[] = [
    ...strategy.trades.map((trade): Item => ({ kind: 'trade', block: trade.block, trade })),
    ...refusals.map((refusal): Item => ({ kind: 'refusal', block: refusal.block, refusal })),
  ].sort((x, y) => y.block - x.block);
  return (
    <section className="log sg-log" aria-label="Receipt timeline" aria-busy={q.isPending}>
      <div className="lh">
        <span>Receipt timeline</span>
        <span>{strategy.trades.length} attested {strategy.trades.length === 1 ? 'trade' : 'trades'}{refusals.length > 0 && `, ${refusals.length} refused`}</span>
      </div>
      <ol className="rows">
        {items.map((it, i) => {
          if (it.kind === 'refusal') {
            const r = it.refusal;
            const rc = refused.data?.[refusals.indexOf(r)];
            const confirmed = rc?.status === 'reverted';
            return (
              <li key={r.tx} style={{ ['--i' as string]: Math.min(i, 10) }}>
                <a className="r ref" href={rhcExplorer.tx(r.tx)} target="_blank" rel="noreferrer" aria-label={`Refused ${r.reason}, open transaction on the explorer`}>
                  <i className="d" aria-hidden="true" />
                  <div>
                    <h3>{r.method ?? 'call'} refused with {r.reason}()</h3>
                    <p>{REFUSAL_TEXT[r.reason] ?? 'the account refused the call'}<span className="when"> · block {r.block.toLocaleString('en-US')} · {fmtWhen(r.time)}</span></p>
                    <p className={confirmed ? 'rcpt ok' : 'rcpt'}>{rc ? (confirmed ? 'Reverted on chain, nothing moved' : 'The chain does not show this transaction as reverted') : 'Reading the transaction from the chain'}</p>
                  </div>
                  <code>REFUSED</code>
                </a>
              </li>
            );
          }
          const t = it.trade;
          const check = q.data?.checks.find((c) => c.tx === t.tx);
          const model = modelNameOf(t.modelHash);
          return (
            <li key={t.tx} style={{ ['--i' as string]: Math.min(i, 10) }}>
              <a className={check && !check.ok ? 'r ref' : 'r'} href={rhcExplorer.tx(t.tx)} target="_blank" rel="noreferrer" aria-label={`${tradeTitle(t)}, open transaction on the explorer`}>
                <i className="d" aria-hidden="true" />
                <div>
                  <h3>{tradeTitle(t)}</h3>
                  <p>
                    model {model ?? 'hash'} {short(t.modelHash)}{strategy.boots.length > 1 && <> · measurement {short(t.measurement)}</>}<span className="when"> · block {t.block.toLocaleString('en-US')} · {fmtWhen(t.time)}</span>
                  </p>
                  <ReceiptLine check={check} />
                </div>
                <code>{check && !check.ok ? 'MISMATCH' : 'EXECUTED'}</code>
              </a>
            </li>
          );
        })}
      </ol>
      {q.isError && <p className="probe bad">The chain read failed ({String(q.error).slice(0, 120)}). The rows above come from the track record, and the chain check turns green once the read succeeds.</p>}
    </section>
  );
}

function CodePanel({ strategy }: { strategy: Strategy }) {
  const adm = useAdmissions(strategy);
  const checks = useStrategyChecks(strategy);
  const models = strategy.modelHashes;
  return (
    <section className="doc sg-code" aria-labelledby="code-h">
      <div className="doc-head">
        <h2 id="code-h" className="t-label">The code that traded</h2>
        <span className="small">Every trade above carries a measurement and a model hash in its TradeExecuted event.</span>
      </div>
      <div className="sg-code-body">
        {strategy.compose && (
          <div>
            <span className="fact-l">Strategy identity, compose hash</span>
            <HashDiff value={strategy.compose} tone="ok" />
            <span className="small">The SHA-256 of the app-compose that Phala&apos;s dstack extends into the TDX chip&apos;s RTMR3. It stays the same across boots, so this is the strategy a follower is choosing.</span>
          </div>
        )}
        {strategy.boots.map((boot, i) => {
          const rows = adm.data?.rows.filter((r) => r.measurement === boot.measurement) ?? [];
          return (
            <div key={boot.measurement}>
              <span className="fact-l">{strategy.boots.length > 1 ? `Boot ${i + 1} measurement, bytes32` : 'Workload measurement, bytes32'}</span>
              <HashDiff value={boot.measurement} tone="ok" />
              <span className="small">
                {i === 0 && 'The hash of the exact code, kernel and configuration the Intel TDX chip ran, including the boot\'s instance id. Followers approve this value and nothing else. '}
                {boot.trades.length} attested {boot.trades.length === 1 ? 'trade' : 'trades'}.
              </span>
              {adm.isPending && i === 0 && <span className="small">Reading the accounts that admitted this code.</span>}
              {adm.isError && i === 0 && <span className="note warn">Could not read the accounts ({String(adm.error).slice(0, 100)}).</span>}
              {rows.map((r) => (
                <p key={r.account} className="sg-ver">
                  <i className="d" aria-hidden="true" />
                  <span>
                    The Stylus Verifier <a href={rhcExplorer.address(RHC_VERIFIER)} target="_blank" rel="noreferrer">{short(RHC_VERIFIER)}</a> admitted{' '}
                    {r.registeredAgent ? <HexValue value={r.registeredAgent} head={6} tail={4} href={rhcExplorer.address(r.registeredAgent)} /> : 'a key'} on{' '}
                    <HexValue value={r.account} head={6} tail={4} href={rhcExplorer.address(r.account)} />
                    {r.admittedTx && <> in <a href={rhcExplorer.tx(r.admittedTx)} target="_blank" rel="noreferrer">{short(r.admittedTx)}</a></>}.{' '}
                    {r.view.state === 'live' || r.view.state === 'near' ? `The key is registered for another ${fmtCountdown(r.view.left)}. ` : ''}
                    {r.approved ? 'The owner approves this measurement.' : ''}
                  </span>
                </p>
              ))}
            </div>
          );
        })}
        <div>
          <span className="fact-l">Model on the receipts</span>
          {models.map((h) => <span key={h}>{modelNameOf(h) ?? 'a model whose id this app does not know'} <HexValue value={h} head={8} tail={6} /></span>)}
          {adm.data && <span className="small">Accounts read at block {adm.data.block.toLocaleString('en-US')}.</span>}
        </div>
        <div>
          <span className="fact-l">Receipts re-read from the chain</span>
          <span>{checks.data ? `${checks.data.checks.filter((c) => c.ok && c.receipt?.state === 'verified').length} of ${checks.data.checks.length} verified` : 'Reading'}</span>
          <span className="small">Each is checked for success, the recorded measurement and model, and a receipt hash recomputed from the transaction calldata.</span>
        </div>
      </div>
    </section>
  );
}

function NotListed({ id }: { id: string }) {
  return (
    <div className="pagehead">
      <h1 className="t-title">No attested agent has this identity</h1>
      <p className="lede">
        <span className="hex">{id.length > 20 ? short(id) : id}</span> has not traded on Robinhood Chain testnet under an approved measurement. A strategy is listed
        once its first trade is in the track record, which is generated from the chain&apos;s TradeExecuted events.
      </p>
      <div className="actions"><Link className="btn" to="/">See the attested agents</Link><Link className="btn line" to="/creator">Publish an agent</Link></div>
    </div>
  );
}

export function Profile() {
  const { measurement: id = '' } = useParams();
  const strategy = strategyById(STRATEGIES, id);
  useEffect(() => {
    document.title = strategy ? `${strategy.label} on Signet: the code behind the track record` : 'Signet agent';
  }, [strategy]);
  if (!strategy) return <NotListed id={id} />;
  return <AgentPage strategy={strategy} />;
}

function AgentPage({ strategy }: { strategy: Strategy }) {
  const v = useVerdict(strategy);
  const { hash } = useLocation();
  // A link to #follow lands on a freshly rendered route, so the browser has no anchor to scroll to until now.
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [hash]);
  const last = strategy.trades.at(-1);
  const boots = strategy.boots.length;
  return (
    <>
      <div className="pagehead sg-prof-head">
        <Link to="/" className="sg-back">All attested agents</Link>
        <h1 className="t-title">{strategy.label}</h1>
        <p className="lede">
          {strategy.trades.length} attested {strategy.trades.length === 1 ? 'trade' : 'trades'} on Robinhood Chain testnet across {boots} {boots === 1 ? 'boot' : 'boots'}
          {strategy.compose && <> of the compose <span className="hex">{short(strategy.compose)}</span></>}. Each receipt names the measurement of the boot that traded, so every
          trade belongs to that code and to no other.
        </p>
        <TitleBlock
          cells={[
            { label: 'Return, marked to mainnet Chainlink', value: last ? <a href={rhcExplorer.tx(last.tx)} target="_blank" rel="noreferrer">{fmtPct(strategy.returnPct)}</a> : 'unmarked', lead: true },
            { label: 'Profit', value: fmtSignedDollars(strategy.pnlUsd) },
            { label: 'First trade', value: fmtWhen(strategy.firstTrade) },
            { label: 'Last trade', value: fmtWhen(strategy.lastTrade), mobileHide: true },
            { label: 'Chain check', value: v.text, tone: v.kind === 'mismatch' ? 'alarm' : undefined },
          ]}
        />
      </div>
      <div className="sg-prof">
        <div className="sg-prof-main">
          <Timeline strategy={strategy} />
          <CodePanel strategy={strategy} />
        </div>
        <aside className="sg-prof-side"><FollowPanel strategy={strategy} /></aside>
      </div>
      <SwapProof />
    </>
  );
}
