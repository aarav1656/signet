import { useEffect, useMemo, useState } from 'react';
import type { Address } from 'viem';
import { rhcExplorer } from '../../chain';
import { HexValue } from '../../components/Stamp';
import { fmtCountdown, fmtWhen } from '../../lib/format';
import { agentView } from './agent';
import { buildGateRows, modelName, useGateLog, type AccountLog, type GateRow, type TokenInfo } from './gateRows';
import { useReceiptCheck } from './receiptCheck';
import { ZERO_HASH, type Snapshot } from './read';

const FIRST = 6;

/** Wall-clock unix seconds, ticking once a second. */
function useNowSec() {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

function AgentPanel({ snap }: { snap?: Snapshot }) {
  const now = useNowSec();
  if (!snap) return <div className="agent"><div>Agent<b>reading</b></div></div>;
  const view = agentView(snap.agent, snap.agentExpiry, now);
  const pin = snap.requestedModelHash === ZERO_HASH ? 'not set' : (modelName(snap.requestedModelHash) ?? snap.requestedModelHash);
  return (
    <div className="agent">
      <div>
        Agent
        <b>{view.state === 'none' ? 'none admitted' : <HexValue value={snap.agent} head={4} tail={4} href={rhcExplorer.address(snap.agent)} />}</b>
      </div>
      <div>
        Attested measurement
        <b>{view.state === 'none' ? 'none' : <HexValue value={snap.agentMeasurement} head={8} tail={4} />}</b>
      </div>
      <div>
        Key expires
        <b className={view.state === 'live' || view.state === 'near' ? 'tick' : undefined} title={view.state === 'none' ? undefined : fmtWhen(snap.agentExpiry)}>
          {view.state === 'live' || view.state === 'near' ? `in ${fmtCountdown(view.left)}` : view.state === 'expired' ? fmtWhen(snap.agentExpiry) : 'not applicable'}
        </b>
      </div>
      <div>
        Model pin
        <b>{pin}</b>
      </div>
      {view.state === 'near' && (
        <p className="readmit" role="status">
          Re-admission due in {fmtCountdown(view.left)}. <span>A fresh quote from the agent extends the key another 24 hours.</span>
        </p>
      )}
      {view.state === 'expired' && (
        <p className="readmit expired" role="status">
          Attestation expired, re-admission needed. <span>A fresh quote from the agent registers it again; trades wait until then.</span>
        </p>
      )}
      {view.state === 'none' && (
        <p className="readmit" role="status">
          No agent is admitted. <span>An agent's hardware quote, carrying a measurement the owner approved, admits it.</span>
        </p>
      )}
    </div>
  );
}

function ReceiptBadge({ account, row, logs }: { account: Address; row: GateRow; logs: AccountLog[] }) {
  const r = useReceiptCheck(account, row, logs);
  if (!r) return null;
  const ok = r.state === 'verified';
  const failed = r.state === 'not-verified' ? r.checks.filter((c) => !c.ok).map((c) => c.name).join(', ') || r.reason : undefined;
  return (
    <p className={ok ? 'rcpt ok' : 'rcpt'} title={r.state === 'checking' ? undefined : r.checks.map((c) => `${c.ok ? 'pass' : 'FAIL'} ${c.name}`).join('\n')}>
      {ok ? `Receipt hash recomputed in your browser, ${r.checks.length} checks match` : r.state === 'checking' ? 'Not verified: recomputing the receipt hash' : `Not verified${failed ? `: ${failed}` : ''}`}
    </p>
  );
}

export function GateLog({ account, snap, snapBlock, probe }: { account: Address; snap?: Snapshot; snapBlock?: bigint; probe?: { block: bigint; refused: boolean; name?: string } }) {
  const q = useGateLog(account);
  const [all, setAll] = useState(false);
  const tokens: TokenInfo[] | undefined = snap?.tokens.map((t) => ({ address: t.address, symbol: t.symbol, decimals: t.decimals }));
  const rows = useMemo(() => (q.data && tokens ? buildGateRows(q.data.logs, q.data.refusals, q.data.times, tokens) : undefined), [q.data, snap]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = rows ? (all ? rows : rows.slice(0, FIRST)) : [];
  const refused = rows?.filter((r) => r.tone === 'refuse').length ?? 0;
  const block = q.data?.head ?? snapBlock;

  return (
    <section className="log" aria-label="Gate log" aria-busy={!rows}>
      <div className="lh">
        <span>Gate log</span>
        <span>{block ? <>Live <a href={rhcExplorer.block(block)} target="_blank" rel="noreferrer">block {block.toLocaleString('en-US')}</a></> : 'Reading'}</span>
      </div>
      <AgentPanel snap={snap} />
      {probe && (
        <p className={probe.refused ? 'probe' : 'probe bad'}>
          {probe.refused ? (
            <>Live check at block {probe.block.toLocaleString('en-US')}: a key with no attestation calls <code>execute()</code> and the account answers <code>{probe.name}()</code>.</>
          ) : (
            <>Live check at block {probe.block.toLocaleString('en-US')}: the unattested call was not refused as <code>NotAgent()</code>{probe.name ? `, it returned ${probe.name}()` : ''}.</>
          )}
        </p>
      )}
      {q.isError && (
        <div className="alarm" role="alert">
          <b>Could not read the account events.</b>
          <span>{String(q.error).slice(0, 160)}</span>
          <button className="textbtn" onClick={() => q.refetch()}>Read again</button>
        </div>
      )}
      {!rows && !q.isError && <p className="log-wait">Reading every event this account has emitted, from its deployment block.</p>}
      {rows && rows.length === 0 && <p className="log-wait">This account has no events yet. The first admission, trade or refusal appears here the block it lands.</p>}
      {rows && (
        <ol className="rows" key={account}>
          {shown.map((r, i) => (
            <li key={r.key} style={{ ['--i' as string]: Math.min(i, 10) }}>
              <a className={r.tone === 'refuse' ? 'r ref' : 'r'} href={rhcExplorer.tx(r.tx)} target="_blank" rel="noreferrer" aria-label={`${r.tag} ${r.title}, open transaction on the explorer`}>
                <i className="d" aria-hidden="true" />
                <div>
                  <h3>{r.title}</h3>
                  <p>{r.sub}{r.time !== undefined && <span className="when"> · {fmtWhen(r.time)}</span>}</p>
                  {q.data && <ReceiptBadge account={account} row={r} logs={q.data.logs} />}
                </div>
                <code>{r.tag}</code>
              </a>
            </li>
          ))}
        </ol>
      )}
      {rows && rows.length > FIRST && (
        <button className="more" type="button" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? 'Show the latest rows only' : `Show all ${rows.length} rows, ${refused} refused`}
        </button>
      )}
      {q.data?.refusalsError && (
        <p className="probe bad">Refusals could not be read from the explorer index ({q.data.refusalsError}). Trades and approvals above are read from the chain directly.</p>
      )}
    </section>
  );
}
