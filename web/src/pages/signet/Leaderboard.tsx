import { Link } from 'react-router-dom';
import { rhcExplorer } from '../../chain';
import { Stamp } from '../../components/Stamp';
import { fmtCountdown, fmtWhen, short } from '../../lib/format';
import { fmtPct, fmtSignedDollars, rankedStrategies, STRATEGIES, TRACK, TRACK_ERROR, type Strategy } from '../../lib/track';
import { modelNameOf } from '../../lib/venue';
import { useAdmissions, useStrategyChecks } from './verify';

/** The record's own pricing note, without the sentences that describe its field names. */
export const pricingNote = (note?: string): string =>
  (note ?? '').split(/(?<=\.)\s+/).filter((s) => s && !/\b(pnl\w*|[a-z]+[A-Z]\w*)\b/.test(s)).map((s) => ` ${s}`).join('');

/** The profile of a strategy, by its compose hash (or by a measurement when the workload carries none). */
export const agentPath = (id: string) => `/agent/${id}`;

/** Live state of one strategy's record: every trade of every boot re-read from the chain and its receipt hash recomputed in the browser. */
export function useVerdict(strategy: Strategy): { kind: 'checking' | 'verified' | 'mismatch' | 'unread'; text: string; title?: string } {
  const q = useStrategyChecks(strategy);
  if (q.isError) return { kind: 'unread', text: 'Chain read failed' };
  if (!q.data) return { kind: 'checking', text: 'Reading the chain' };
  const n = q.data.checks.length;
  const bad = q.data.checks.filter((c) => !(c.ok && c.receipt?.state === 'verified'));
  return q.data.verified
    ? { kind: 'verified', text: `${n} of ${n} receipts verified`, title: 'Each trade was re-read from the chain: transaction succeeded, measurement and model recorded on the event, receipt hash recomputed from calldata.' }
    : { kind: 'mismatch', text: `${bad.length} of ${n} do not verify`, title: bad.map((c) => `${c.tx}: ${c.detail}`).join('\n') };
}

/** When a key for this measurement is admitted and unexpired on some account, how long it stays valid; otherwise nothing (the profile lists every admission). */
function useRunning(strategy: Strategy): string {
  const live = (useAdmissions(strategy).data?.rows ?? []).flatMap((r) => (r.view.state === 'live' || r.view.state === 'near' ? [r.view.left] : []));
  return live.length ? `Running now, key valid ${fmtCountdown(Math.max(...live))}` : '';
}

function Row({ strategy, rank }: { strategy: Strategy; rank: number }) {
  const v = useVerdict(strategy);
  const running = useRunning(strategy);
  const last = strategy.trades.at(-1);
  const models = strategy.modelHashes.map((h) => modelNameOf(h) ?? `model ${short(h)}`);
  const boots = strategy.boots.length;
  return (
    <li className="sg-row">
      <span className="sg-rank tnum" aria-label={`Rank ${rank}`}>{rank}</span>
      <div className="sg-agent">
        <Link to={agentPath(strategy.id)} className="t-subject">{strategy.label}</Link>
        {strategy.compose && <span className="hex" title={`Compose hash ${strategy.compose}: the strategy's identity across boots`}>strategy {short(strategy.compose)}</span>}
        <span className="sg-boots">
          {boots} {boots === 1 ? 'measurement' : 'measurements'}:{' '}
          {strategy.boots.map((b) =>
            b.admission ? (
              <a key={b.measurement} className="hex" href={rhcExplorer.tx(b.admission.tx)} target="_blank" rel="noreferrer" title={`${b.measurement}, admitted by the Stylus Verifier in ${b.admission.tx}`}>{short(b.measurement)}</a>
            ) : (
              <span key={b.measurement} className="hex" title={b.measurement}>{short(b.measurement)}</span>
            ),
          )}
        </span>
        <span className="small">{models.join(', ')}</span>
      </div>
      <div className="sg-cell" data-label="Trades">
        <b className="tnum">{strategy.trades.length}</b>
        <span className="sg-txs">
          {strategy.trades.map((t, i) => (
            <a key={t.tx} href={rhcExplorer.tx(t.tx)} target="_blank" rel="noreferrer" title={t.tx} aria-label={`Trade ${i + 1}, transaction ${t.tx}`}>{short(t.tx)}</a>
          ))}
        </span>
      </div>
      <div className="sg-cell" data-label="Return, profit">
        {last ? (
          <a className="sg-ret" href={rhcExplorer.tx(last.tx)} target="_blank" rel="noreferrer" title={`Open the latest trade, ${last.tx}`}>
            <b className={strategy.returnPct !== null && strategy.returnPct < 0 ? 'neg tnum' : 'tnum'}>{fmtPct(strategy.returnPct)}</b>
          </a>
        ) : <b>unmarked</b>}
        <span className="small tnum">{fmtSignedDollars(strategy.pnlUsd)}</span>
      </div>
      <div className="sg-cell" data-label="Last trade">
        {last && <a href={rhcExplorer.tx(last.tx)} target="_blank" rel="noreferrer" className="tnum">{fmtWhen(last.time)}</a>}
        <span className="small">block {last?.block.toLocaleString('en-US')}</span>
      </div>
      <div className={`sg-state ${v.kind}`} title={v.title}>
        <i className="d" aria-hidden="true" />
        <span>{v.text}{running && <small>{running}</small>}</span>
      </div>
      <Link to={`${agentPath(strategy.id)}#follow`} className="btn line sg-follow" aria-label={`Follow ${strategy.label}`}>Follow</Link>
    </li>
  );
}

export function Leaderboard() {
  const list = rankedStrategies(STRATEGIES);
  return (
    <section className="section sg-board" id="board" aria-labelledby="board-h">
      <div className="section-head">
        <h2 id="board-h" className="t-section">Attested agents</h2>
        <Stamp block={BigInt(TRACK.block)} label="record read at block" url={rhcExplorer.block} />
      </div>
      <p className="section-intro">
        A strategy is one compose hash. Each boot of it has its own measurement, and every trade names the measurement that made it. Return and
        profit come from the strategy&apos;s attested trades, and each figure opens the latest of them.
      </p>
      {TRACK_ERROR && (
        <div className="alarm" role="alert"><b>The track record could not be read.</b><span>{TRACK_ERROR}</span></div>
      )}
      {list.length === 0 && !TRACK_ERROR ? (
        <p className="sg-empty">The board fills with the first TradeExecuted under an approved measurement. That trade ranks its strategy here, with its transaction beside every number.</p>
      ) : list.length === 0 ? null : (
        <>
          <div className="sg-head" aria-hidden="true">
            <span>#</span><span>Strategy</span><span>Trades</span><span>Return, profit</span><span>Last trade</span><span>Chain check</span><span />
          </div>
          <ol className="sg-rows">
            {list.map((a, i) => <Row key={a.id} strategy={a} rank={i + 1} />)}
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
