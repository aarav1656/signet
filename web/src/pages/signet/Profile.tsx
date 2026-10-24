import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { rhcExplorer } from '../../chain';
import { HexValue, TitleBlock } from '../../components/Stamp';
import { fmtCountdown, fmtWhen, short } from '../../lib/format';
import { RHC_VERIFIER } from '../../lib/rhc.generated';
import { agentByMeasurement, fmtAmount, fmtDollars, fmtPct, TRACK, type TrackAgent, type TrackTrade } from '../../lib/track';
import { modelNameOf, symbolOf } from '../../lib/venue';
import { FollowPanel } from './Follow';
import { HashDiff, SwapProof } from './SwapProof';
import { useVerdict } from './Leaderboard';
import { useAdmissions, useAgentChecks, type TradeCheck } from './verify';

function tradeTitle(t: TrackTrade): string {
  const [i, o] = [symbolOf(t.tokenIn), symbolOf(t.tokenOut)];
  const verb = i === 'USDG' ? 'Bought' : 'Sold';
  const stock = verb === 'Bought' ? `${fmtAmount(t.amountOut)} ${o}` : `${fmtAmount(t.amountIn)} ${i}`;
  const usd = verb === 'Bought' ? `${fmtAmount(t.amountIn)} ${i}` : `${fmtAmount(t.amountOut)} ${o}`;
  return `${verb} ${stock} for ${usd}${t.priceUsdAtTrade ? ` at ${fmtDollars(t.priceUsdAtTrade)}` : ''}`;
}

function ReceiptLine({ check }: { check?: TradeCheck }) {
  if (!check) return <p className="rcpt">Reading the transaction from the chain</p>;
  if (!check.ok) return <p className="rcpt">Does not verify: {check.detail}</p>;
  const r = check.receipt;
  if (!r || r.state === 'checking') return <p className="rcpt">Recomputing the receipt hash in your browser</p>;
  return r.state === 'verified'
    ? <p className="rcpt ok">Receipt hash recomputed in your browser, {r.checks.length} checks match the chain</p>
    : <p className="rcpt">Receipt hash mismatch: {r.checks.filter((c) => !c.ok).map((c) => c.name).join(', ') || r.reason}</p>;
}

function Timeline({ agent }: { agent: TrackAgent }) {
  const q = useAgentChecks(agent);
  const rows = [...agent.trades].reverse();
  return (
    <section className="log sg-log" aria-label="Receipt timeline" aria-busy={q.isPending}>
      <div className="lh">
        <span>Receipt timeline</span>
        <span>{rows.length} attested {rows.length === 1 ? 'trade' : 'trades'}</span>
      </div>
      <ol className="rows">
        {rows.map((t, i) => {
          const check = q.data?.checks.find((c) => c.tx === t.tx);
          const model = modelNameOf(t.modelHash);
          return (
            <li key={t.tx} style={{ ['--i' as string]: Math.min(i, 10) }}>
              <a className={check && !check.ok ? 'r ref' : 'r'} href={rhcExplorer.tx(t.tx)} target="_blank" rel="noreferrer" aria-label={`${tradeTitle(t)}, open transaction on the explorer`}>
                <i className="d" aria-hidden="true" />
                <div>
                  <h3>{tradeTitle(t)}</h3>
                  <p>
                    model {model ?? 'hash'} {short(t.modelHash)}<span className="when"> · block {t.block.toLocaleString('en-US')} · {fmtWhen(t.time)}</span>
                  </p>
                  <ReceiptLine check={check} />
                </div>
                <code>{check && !check.ok ? 'MISMATCH' : 'EXECUTED'}</code>
              </a>
            </li>
          );
        })}
      </ol>
      {q.isError && <p className="probe bad">The chain read failed ({String(q.error).slice(0, 120)}). The rows above come from the track record and are not verified until it succeeds.</p>}
    </section>
  );
}

function CodePanel({ agent }: { agent: TrackAgent }) {
  const adm = useAdmissions(agent);
  const checks = useAgentChecks(agent);
  const model = modelNameOf(agent.modelHash);
  return (
    <section className="doc sg-code" aria-labelledby="code-h">
      <div className="doc-head">
        <h2 id="code-h" className="t-label">The code that traded</h2>
        <span className="small">Every trade above carries these two values in its TradeExecuted event.</span>
      </div>
      <div className="sg-code-body">
        <div>
          <span className="fact-l">Workload measurement, bytes32</span>
          <HashDiff value={agent.measurement} tone="ok" />
          <span className="small">The hash of the exact code, kernel and configuration the Intel TDX chip ran. Followers approve this value and nothing else.</span>
        </div>
        <div>
          <span className="fact-l">Model on the receipts</span>
          <span>{model ?? 'a model whose id this app does not know'} <HexValue value={agent.modelHash} head={8} tail={6} /></span>
        </div>
        <div>
          <span className="fact-l">Verifier result</span>
          {adm.isPending && <span className="small">Reading the accounts that admitted this code.</span>}
          {adm.isError && <span className="note warn">Could not read the accounts ({String(adm.error).slice(0, 100)}).</span>}
          {adm.data?.rows.map((r) => (
            <p key={r.account} className="sg-ver">
              <i className={r.view.state === 'live' || r.view.state === 'near' ? 'd' : 'd ring'} aria-hidden="true" />
              <span>
                The Stylus Verifier <a href={rhcExplorer.address(RHC_VERIFIER)} target="_blank" rel="noreferrer">{short(RHC_VERIFIER)}</a> admitted{' '}
                {r.registeredAgent ? <HexValue value={r.registeredAgent} head={6} tail={4} href={rhcExplorer.address(r.registeredAgent)} /> : 'a key'} on{' '}
                <HexValue value={r.account} head={6} tail={4} href={rhcExplorer.address(r.account)} />
                {r.admittedTx && <> in <a href={rhcExplorer.tx(r.admittedTx)} target="_blank" rel="noreferrer">{short(r.admittedTx)}</a></>}.{' '}
                {r.view.state === 'live' || r.view.state === 'near' ? `The key is registered for another ${fmtCountdown(r.view.left)}.` : r.view.state === 'expired' ? `That registration expired ${fmtCountdown(-r.view.ago).replace('expired ', '')}.` : 'No key is registered now.'}{' '}
                {r.approved ? 'The owner still approves this measurement.' : 'The owner no longer approves this measurement.'}
              </span>
            </p>
          ))}
          {adm.data && <span className="small">Read at block {adm.data.block.toLocaleString('en-US')}.</span>}
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
      <h1 className="t-title">No attested agent has this measurement</h1>
      <p className="lede">
        <span className="hex">{id.length > 20 ? short(id) : id}</span> has not traded on Robinhood Chain testnet under an approved measurement. An agent is listed
        the block its first trade confirms.
      </p>
      <div className="actions"><Link className="btn" to="/">See the attested agents</Link><Link className="btn line" to="/creator">Publish an agent</Link></div>
    </div>
  );
}

export function Profile() {
  const { measurement = '' } = useParams();
  const agent = agentByMeasurement(TRACK.agents, measurement);
  useEffect(() => {
    document.title = agent ? `${agent.label} on Signet: the code behind the track record` : 'Signet agent';
  }, [agent]);
  if (!agent) return <NotListed id={measurement} />;
  return <AgentPage agent={agent} />;
}

function AgentPage({ agent }: { agent: TrackAgent }) {
  const v = useVerdict(agent);
  const last = agent.trades.at(-1);
  return (
    <>
      <div className="pagehead sg-prof-head">
        <Link to="/" className="sg-back">All attested agents</Link>
        <h1 className="t-title">{agent.label}</h1>
        <p className="lede">
          {agent.trades.length} attested {agent.trades.length === 1 ? 'trade' : 'trades'} on Robinhood Chain testnet. Each receipt names the measurement{' '}
          <span className="hex">{short(agent.measurement)}</span>, so this record belongs to that code and to no other.
        </p>
        <TitleBlock
          cells={[
            { label: 'Return', value: last ? <a href={rhcExplorer.tx(last.tx)} target="_blank" rel="noreferrer">{fmtPct(agent.returnPct)}</a> : 'unmarked', lead: true },
            { label: 'Marked at', value: agent.markPriceUsd ? `${fmtDollars(agent.markPriceUsd)} per TSLA` : 'no price' },
            { label: 'First trade', value: fmtWhen(agent.firstTrade) },
            { label: 'Last trade', value: fmtWhen(agent.lastTrade), mobileHide: true },
            { label: 'Chain check', value: v.text, tone: v.kind === 'mismatch' ? 'alarm' : undefined },
          ]}
        />
      </div>
      <div className="sg-prof">
        <div className="sg-prof-main">
          <Timeline agent={agent} />
          <CodePanel agent={agent} />
        </div>
        <aside className="sg-prof-side"><FollowPanel agent={agent} /></aside>
      </div>
      <SwapProof />
    </>
  );
}
