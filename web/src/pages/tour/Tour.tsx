import { useEffect, useState, type ReactNode } from 'react';
import type { Hex } from 'viem';
import { rhcChain, rhcExplorer } from '../../chain';
import { HexValue } from '../../components/Stamp';
import { useAtBlock } from '../../hooks/useAtBlock';
import { fmtCountdown, fmtToken, short } from '../../lib/format';
import { DEMO_ACCOUNT, RHC_VERIFIER } from '../../lib/rhc.generated';
import { modelName } from '../account/gateRows';
import { isPaxosUsdg, matches, readTour, TX, type Outcome, type Tour } from './readTour';

export const useTour = () => useAtBlock(['tour'], readTour, true, rhcChain.id);

function useNowSec() {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

type Row = { title: string; body: ReactNode; tag: string; refusal?: boolean; ok: boolean; href: string; tx?: keyof typeof TX };

/** A gate row: amber dot when the chain confirms the claim, red ring for a refusal the chain confirms. */
function GateRow({ row, i }: { row: Row; i: number }) {
  return (
    <li style={{ '--i': i } as React.CSSProperties}>
      <a className={row.refusal ? 'r ref' : 'r'} href={row.href} target="_blank" rel="noreferrer" aria-label={`${row.tag}: ${row.title}, open on the explorer`}>
        <span className="d" aria-hidden="true" />
        <span>
          <h3>{row.title}</h3>
          <p>{row.ok ? row.body : 'The chain does not match this claim right now. Open the transaction to see what it says.'}</p>
        </span>
        <code>{row.ok ? row.tag : 'MISMATCH'}</code>
      </a>
    </li>
  );
}

const rcpt = (t: Tour, k: keyof typeof TX, expect: Outcome) => ({ ok: matches(t.receipts[k], expect), href: rhcExplorer.tx(TX[k]), tx: k });
const blk = (t: Tour, k: keyof typeof TX) => `block ${t.receipts[k].block.toLocaleString('en-US')}`;

/** The first screen's evidence: one admission, one refusal, and the verifier being a Stylus program. */
export function ProofPanel() {
  const q = useTour();
  const t = q.data?.value;
  const rows: Row[] = t
    ? [
        {
          title: 'Admitted: a real Intel TDX quote',
          body: <>The Stylus verifier accepted the CVM&apos;s quote over this account&apos;s nonce. The account&apos;s agent is now <HexValue value={t.agent} /> under measurement <HexValue value={t.measurement} head={6} tail={4} />, {blk(t, 'admit')}.</>,
          tag: 'ADMITTED',
          ...rcpt(t, 'admit', 'success'),
        },
        {
          title: 'Refused: a real TDX quote from different code',
          body: <>Phala&apos;s inference gateway signed this account&apos;s nonce on genuine TDX hardware. The verifier checked the whole quote ({t.receipts.stolenSigner.gasUsed.toLocaleString('en-US')} gas), then the account refused it: the measurement is not one the owner approved. {blk(t, 'stolenSigner')}.</>,
          tag: 'MeasurementNotApproved()',
          refusal: true,
          ...rcpt(t, 'stolenSigner', 'reverted'),
        },
        {
          title: 'The verifier is a Stylus program',
          body: <>Bytecode at <HexValue value={RHC_VERIFIER} /> starts <code className="inl">{t.verifierPrefix}</code>, the Stylus WASM prefix: the DCAP quote check runs on chain, not on a server.</>,
          tag: 'STYLUS',
          ok: t.verifierPrefix.startsWith('0xeff0'),
          href: rhcExplorer.address(RHC_VERIFIER),
        },
      ]
    : [];
  return (
    <div className="log proof" aria-busy={q.isPending}>
      <div className="lh">
        <span>Read now from Robinhood Chain</span>
        {q.data && <a href={rhcExplorer.block(q.data.block)} target="_blank" rel="noreferrer">block {q.data.block.toLocaleString('en-US')}</a>}
      </div>
      {q.isError && <p className="log-wait">The chain did not answer. It is read again every 15 seconds.</p>}
      {!t && !q.isError && <p className="log-wait">Reading the admission, the refusal and the verifier from the chain.</p>}
      {t && matches(t.receipts.stolenSigner, 'reverted') && (
        <a className="proof-num" href={rhcExplorer.tx(TX.stolenSigner)} target="_blank" rel="noreferrer">
          <b>{t.receipts.stolenSigner.gasUsed.toLocaleString('en-US')} gas</b>
          <span>a full Intel TDX DCAP quote checked on chain in Stylus, then refused because the code it measured was never approved</span>
        </a>
      )}
      {t && <ol className="rows">{rows.map((r, i) => <GateRow key={r.title} row={r} i={i} />)}</ol>}
    </div>
  );
}

/** One lifecycle step: collapsed to its verdict, or open with the receipt it rests on. */
function Step({ row, t, i, open, onOpen }: { row: Row; t: Tour; i: number; open: boolean; onOpen: () => void }) {
  const r = row.tx ? t.receipts[row.tx] : undefined;
  return (
    <li className={open ? 'step-open' : undefined} style={{ '--i': i } as React.CSSProperties}>
      <button type="button" className={row.refusal ? 'r ref' : 'r'} aria-expanded={open} onClick={onOpen}>
        <span className="d" aria-hidden="true" />
        <h3>{row.title}</h3>
        <code>{row.ok ? row.tag : 'MISMATCH'}</code>
      </button>
      {open && (
        <div className="step-body">
          <p>{row.ok ? row.body : 'The chain does not match this claim right now. Open the transaction to see what it says.'}</p>
          <p className="step-proof">
            {r ? (
              <>
                <HexValue value={r.hash} head={8} tail={6} href={row.href} /> · block {r.block.toLocaleString('en-US')} · receipt status {r.status} · {r.gasUsed.toLocaleString('en-US')} gas
              </>
            ) : (
              <>
                read live at block {t.block.toLocaleString('en-US')} · <a href={row.href} target="_blank" rel="noreferrer">open on the explorer</a>
              </>
            )}
          </p>
        </div>
      )}
    </li>
  );
}

/** The account's lifecycle, one real transaction or live read per step. */
export function Lifecycle() {
  const q = useTour();
  const now = useNowSec();
  const [active, setActive] = useState(0);
  const t = q.data?.value;
  const served = (h: Hex) => modelName(h) ?? short(h);
  const usdgIn = (amt: bigint, token?: string) => `${fmtToken(amt, 6)} ${token && isPaxosUsdg(token as `0x${string}`) ? 'Paxos USDG' : 'testUSDG'}`;
  const left = t ? Number(t.expiry) - now : 0;
  const rows: Row[] = t
    ? [
        {
          title: '1 · An owner creates an account from the factory',
          body: <>The factory deployed <HexValue value={t.created ?? DEMO_ACCOUNT} />, bound to Paxos USDG and the Stylus verifier. Only the owner can withdraw, set caps or approve code. {blk(t, 'create')}.</>,
          tag: 'CREATED',
          ...rcpt(t, 'create', 'success'),
        },
        {
          title: `2 · One attested agent serves ${t.operatorAgents.length} accounts`,
          body: <>Each account admitted the same CVM key <HexValue value={t.operatorAgents[0].agent} /> with a quote over its own nonce, and each set its own caps. Read now: {t.operatorAgents.filter((x) => x.agent.toLowerCase() === t.agent.toLowerCase()).length} of {t.operatorAgents.length} report that agent.</>,
          tag: 'ADMITTED',
          ok: t.operatorAgents.every((x) => x.agent.toLowerCase() === t.agent.toLowerCase()),
          href: rhcExplorer.address(t.agent),
        },
        {
          title: '3 · An in-cap trade, with the model that made it',
          body: t.trade ? <>The agent bought {fmtToken(t.trade.amountOut, 18)} TSLA with {usdgIn(t.trade.amountIn, t.trade.tokenIn)}. The trade event records the model the Phala gateway served, {served(t.trade.served)}, from a receipt the account verified first. {blk(t, 'trade')}.</> : '',
          tag: 'EXECUTED',
          ...rcpt(t, 'trade', 'success'),
        },
        {
          title: '4 · A trade over the cap is refused',
          body: <>One unit above the per-trade cap: the account reverted with ExceedsPerTradeCap(10000001, 10000000) and nothing moved. {blk(t, 'overCap')}.</>,
          tag: 'ExceedsPerTradeCap()',
          refusal: true,
          ...rcpt(t, 'overCap', 'reverted'),
        },
        {
          title: '5 · A big trade waits for the owner',
          body: t.approved ? <>Above the approval line, the agent could only propose. The owner approved proposal {t.approved.proposalId.toString()} and the account executed {fmtToken(t.approved.amountIn, 6)} testUSDG into {fmtToken(t.approved.amountOut, 18)} TSLA. {blk(t, 'approve')}.</> : '',
          tag: 'APPROVED',
          ...rcpt(t, 'approve', 'success'),
        },
        {
          title: '6 · A receipt for the wrong model is not paid',
          body: <>A genuine Phala receipt for a Llama call was offered to a channel pinned to Qwen. The signature verified; the model did not match. The payment reverted with ModelMismatch and the channel has paid {fmtToken(t.wrongModelPaid, 6)} USDG. {blk(t, 'wrongModel')}.</>,
          tag: 'ModelMismatch()',
          refusal: true,
          ...rcpt(t, 'wrongModel', 'reverted'),
        },
        {
          title: '7 · Stock Token splits pause the agent',
          body: t.corp.next !== t.corp.current
            ? <>TSLA has a multiplier change pending, so the agent cannot trade it until a day after it takes effect.</>
            : <>The account reads TSLA&apos;s ERC-8056 multiplier before every agent trade and stays out for {Number(t.corp.cooldown) / 3600} hours around a split. Read now: multiplier {(Number(t.corp.current) / 1e18).toString()}, no change pending, so trades pass.</>,
          tag: 'GUARD ARMED',
          ok: t.corp.cooldown === 86_400n,
          href: rhcExplorer.address(DEMO_ACCOUNT),
        },
        {
          title: '8 · The agent key expires on its own',
          body: left > 0
            ? <>The attestation lasts 24 hours. This account&apos;s agent stops being able to trade in <b className="tick">{fmtCountdown(left)}</b> unless a fresh quote renews it, so a key that leaves the enclave dies with it.</>
            : <>The attestation lapsed {fmtCountdown(-left)} ago; the account refuses the agent until a fresh quote renews it.</>,
          tag: left > 0 ? 'LIVE' : 'EXPIRED',
          ok: true,
          href: rhcExplorer.address(DEMO_ACCOUNT),
        },
      ]
    : [];
  return (
    <section className="section tour" aria-labelledby="tour-h" aria-busy={q.isPending}>
      <div className="section-head">
        <h2 id="tour-h" className="t-section">The lifecycle, read from the chain</h2>
        {q.data && <span className="stamp">block {q.data.block.toLocaleString('en-US')}, every row links to its transaction</span>}
      </div>
      <div className="log">
        {!t && !q.isError && <p className="log-wait">Reading eight steps from Robinhood Chain.</p>}
        {q.isError && <p className="log-wait">The chain did not answer. It is read again every 15 seconds.</p>}
        {t && (
          <>
            <div className="stepper" role="group" aria-label="Step through the lifecycle">
              <span className="step-count">Step {active + 1} of {rows.length}</span>
              <button type="button" className="ctl-ghost" disabled={active === 0} onClick={() => setActive((a) => a - 1)}>Previous</button>
              <button type="button" className="ctl-ghost" disabled={active === rows.length - 1} onClick={() => setActive((a) => a + 1)}>Next</button>
            </div>
            <ol className="rows steps-list">
              {rows.map((r, i) => <Step key={r.title} row={r} t={t} i={i} open={i === active} onOpen={() => setActive(i)} />)}
            </ol>
          </>
        )}
      </div>
    </section>
  );
}
