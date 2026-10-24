import { Link } from 'react-router-dom';
import { rhcExplorer } from '../../chain';
import { Stamp } from '../../components/Stamp';
import { fmtWhen, short } from '../../lib/format';
import { fmtPct, fmtSignedDollars, ranked, TRACK, TRACK_ERROR, type TrackAgent } from '../../lib/track';
import { modelNameOf } from '../../lib/venue';
import { useAgentChecks } from './verify';

/** The record's own pricing note, without the sentences that describe its field names. */
export const pricingNote = (note?: string): string =>
  (note ?? '').split(/(?<=\.)\s+/).filter((s) => s && !/\b(pnl\w*|[a-z]+[A-Z]\w*)\b/.test(s)).map((s) => ` ${s}`).join('');

export const agentPath = (m: string) => `/agent/${m}`;

/** Live state of one agent's record: every trade re-read from the chain and its receipt hash recomputed in the browser. */
export function useVerdict(agent: TrackAgent): { kind: 'checking' | 'verified' | 'mismatch' | 'unread'; text: string; title?: string } {
  const q = useAgentChecks(agent);
  if (q.isError) return { kind: 'unread', text: 'Chain read failed' };
  if (!q.data) return { kind: 'checking', text: 'Reading the chain' };
  const n = q.data.checks.length;
  const bad = q.data.checks.filter((c) => !(c.ok && c.receipt?.state === 'verified'));
  return q.data.verified
    ? { kind: 'verified', text: `${n} of ${n} receipts verified`, title: 'Each trade was re-read from the chain: transaction succeeded, measurement and model recorded on the event, receipt hash recomputed from calldata.' }
    : { kind: 'mismatch', text: `${bad.length} of ${n} do not verify`, title: bad.map((c) => `${c.tx}: ${c.detail}`).join('\n') };
}

function Row({ agent, rank }: { agent: TrackAgent; rank: number }) {
  const v = useVerdict(agent);
  const last = agent.trades.at(-1);
  const model = modelNameOf(agent.modelHash);
  return (
    <li className="sg-row">
      <span className="sg-rank tnum" aria-label={`Rank ${rank}`}>{rank}</span>
      <div className="sg-agent">
        <Link to={agentPath(agent.measurement)} className="t-subject">{agent.label}</Link>
        <span className="hex" title={agent.measurement}>{short(agent.measurement)}</span>
        <span className="small">{model ?? `model ${short(agent.modelHash)}`}</span>
      </div>
      <div className="sg-cell" data-label="Trades">
        <b className="tnum">{agent.trades.length}</b>
        <span className="sg-txs">
          {agent.trades.map((t, i) => (
            <a key={t.tx} href={rhcExplorer.tx(t.tx)} target="_blank" rel="noreferrer" title={t.tx} aria-label={`Trade ${i + 1}, transaction ${t.tx}`}>{short(t.tx)}</a>
          ))}
        </span>
      </div>
      <div className="sg-cell" data-label="Return, profit">
        {last ? (
          <a className="sg-ret" href={rhcExplorer.tx(last.tx)} target="_blank" rel="noreferrer" title={`Open the latest trade, ${last.tx}`}>
            <b className={agent.returnPct !== null && agent.returnPct < 0 ? 'neg tnum' : 'tnum'}>{fmtPct(agent.returnPct)}</b>
          </a>
        ) : <b>unmarked</b>}
        <span className="small tnum">{fmtSignedDollars(agent.pnlUsd)}</span>
      </div>
      <div className="sg-cell" data-label="Last trade">
        {last && <a href={rhcExplorer.tx(last.tx)} target="_blank" rel="noreferrer" className="tnum">{fmtWhen(last.time)}</a>}
        <span className="small">block {last?.block.toLocaleString('en-US')}</span>
      </div>
      <div className={`sg-state ${v.kind}`} title={v.title}>
        <i className="d" aria-hidden="true" />
        <span>{v.text}</span>
      </div>
      <Link to={`${agentPath(agent.measurement)}#follow`} className="btn line sg-follow" aria-label={`Follow ${agent.label}`}>Follow</Link>
    </li>
  );
}

export function Leaderboard() {
  const list = ranked(TRACK.agents);
  return (
    <section className="section sg-board" id="board" aria-labelledby="board-h">
      <div className="section-head">
        <h2 id="board-h" className="t-section">Attested agents</h2>
        <Stamp block={BigInt(TRACK.block)} label="record read at block" url={rhcExplorer.block} />
      </div>
      <p className="section-intro">
        An agent is listed once a trade under its measurement lands on an account. Return and profit come from the agent&apos;s attested
        trades, and each figure opens the latest of them.
      </p>
      {TRACK_ERROR && (
        <div className="alarm" role="alert"><b>The track record could not be read.</b><span>{TRACK_ERROR}</span></div>
      )}
      {list.length === 0 && !TRACK_ERROR ? (
        <p className="sg-empty">No agent has traded yet. The first TradeExecuted under an approved measurement ranks its agent here, with its transaction beside every number.</p>
      ) : list.length === 0 ? null : (
        <>
          <div className="sg-head" aria-hidden="true">
            <span>#</span><span>Agent</span><span>Trades</span><span>Return, profit</span><span>Last trade</span><span>Chain check</span><span />
          </div>
          <ol className="sg-rows">
            {list.map((a, i) => <Row key={a.measurement} agent={a} rank={i + 1} />)}
          </ol>
          {TRACK.pricing && (
            <p className="sg-pricing">
              Valued with {TRACK.pricing.feed}
              {TRACK.pricing.markPriceUsd !== null && <>, latest mark ${TRACK.pricing.markPriceUsd.toFixed(2)} per TSLA{TRACK.pricing.roundId ? `, round ${TRACK.pricing.roundId}` : ''}</>}.
              {pricingNote(TRACK.pricing.note)}
            </p>
          )}
        </>
      )}
    </section>
  );
}
