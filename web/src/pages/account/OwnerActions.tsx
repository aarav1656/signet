import { useState } from 'react';
import { erc20Abi, formatUnits, isHex, parseUnits, type Address, type Hex } from 'viem';
import { useConnection, useReadContract, useWriteContract } from 'wagmi';
import { rhcChain, rhcExplorer } from '../../chain';
import { accountAbi } from '../../abi/AgentAccount.generated';
import { Code, HexValue, Num, Spec, Fact } from '../../components/Stamp';
import { useOnChain } from '../../components/Wallet';
import { useTx } from '../../hooks/useTx';
import { fmtCountdown, fmtToken, short } from '../../lib/format';
import { GATEWAY_MEASUREMENT } from '../../lib/rhc.generated';
import type { Snapshot, TokenRow } from './read';

const parse = (v: string, decimals: number): bigint | null => {
  try {
    const n = parseUnits(v.trim() || '0', decimals);
    return n >= 0n ? n : null;
  } catch {
    return null;
  }
};
const MAX_U128 = (1n << 128n) - 1n;
const isBytes32 = (v: string): v is Hex => isHex(v, { strict: true }) && v.length === 66;

function TokenPick({ tokens, value, onChange }: { tokens: TokenRow[]; value: number; onChange: (i: number) => void }) {
  return (
    <div className="picker" role="group" aria-label="Token">
      {tokens.map((t, i) => (
        <button key={t.address} type="button" aria-pressed={value === i} onClick={() => onChange(i)}>{t.symbol}</button>
      ))}
    </div>
  );
}

type Ctx = { snap: Snapshot; refetch: () => void };

function useGate(snap: Snapshot) {
  const chain = useOnChain(rhcChain);
  const isOwner = !!chain.address && chain.address.toLowerCase() === snap.owner.toLowerCase();
  const reason = !chain.ready ? chain.reason : !isOwner ? `This wallet is not the owner of this account. The owner is ${short(snap.owner)}.` : undefined;
  return { chain, isOwner, ownerReason: reason, anyReason: chain.ready ? undefined : chain.reason };
}

function FundsStep({ snap, refetch }: Ctx) {
  const { chain, ownerReason, anyReason } = useGate(snap);
  const [i, setI] = useState(0);
  const [amount, setAmount] = useState('');
  const tx = useTx(refetch);
  const { writeContractAsync } = useWriteContract();
  const t = snap.tokens[i];
  const wei = parse(amount, t.decimals);
  const walletBal = useReadContract({
    address: t.address, abi: erc20Abi, functionName: 'balanceOf', args: chain.address ? [chain.address] : undefined,
    chainId: rhcChain.id, query: { enabled: !!chain.address, refetchInterval: 15_000 },
  });
  const amountOk = wei !== null && wei > 0n;
  const canDeposit = !anyReason && amountOk && walletBal.data !== undefined && wei <= walletBal.data;
  const canWithdraw = !ownerReason && amountOk && wei <= t.balance;
  const to = chain.address as Address;

  return (
    <li className="step" aria-labelledby="o-funds">
      <Num n={1} mark="plain" />
      <div className="step-body">
        <h3 id="o-funds" className="t-section">Deposit and withdraw</h3>
        <p className="prose">Anyone may send tokens to the account. Only the owner can take them out, and withdrawals go to the owner&apos;s wallet.</p>
        <TokenPick tokens={snap.tokens} value={i} onChange={(n) => { setI(n); setAmount(''); tx.reset(); }} />
        <div className="fields">
          <div className="field">
            <label className="label" htmlFor="f-amt">Amount, {t.symbol}</label>
            <input id="f-amt" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="1.00" aria-invalid={amount !== '' && !amountOk} />
            <span className="hint">
              Account holds {fmtToken(t.balance, t.decimals)} {t.symbol}.
              {chain.address && walletBal.data !== undefined && <> Wallet holds {fmtToken(walletBal.data, t.decimals)}.</>}
            </span>
          </div>
        </div>
        {anyReason && <p className="note warn">{anyReason}</p>}
        {!anyReason && ownerReason && <p className="note">Deposit is open to any wallet. Withdraw: {ownerReason}</p>}
        <div className="actions">
          <button className="btn" type="button" disabled={!canDeposit || tx.busy}
            onClick={() => tx.run(`Deposit ${t.symbol}`, () => writeContractAsync({ address: t.address, abi: erc20Abi, functionName: 'transfer', args: [snap.account, wei as bigint], chainId: rhcChain.id }))}>
            Deposit
          </button>
          <button className="btn line" type="button" disabled={!canWithdraw || tx.busy}
            onClick={() => tx.run(`Withdraw ${t.symbol}`, () => writeContractAsync({ address: snap.account, abi: accountAbi, functionName: 'withdraw', args: [t.address, to, wei as bigint], chainId: rhcChain.id }))}>
            Withdraw to owner
          </button>
          {/USDG/.test(t.symbol) && (
            <a className="textbtn" href="https://faucet.paxos.com/" target="_blank" rel="noreferrer">
              Get Paxos USDG on Robinhood Chain testnet
            </a>
          )}
        </div>
      </div>
    </li>
  );
}

function CapsForm({ snap, refetch, t }: Ctx & { t: TokenRow }) {
  const { ownerReason } = useGate(snap);
  const tx = useTx(refetch);
  const { writeContractAsync } = useWriteContract();
  const f = (v: bigint) => (v === 0n ? '' : formatUnits(v, t.decimals));
  const [allowed, setAllowed] = useState(t.limits.allowed);
  const [per, setPer] = useState(f(t.limits.perTrade));
  const [daily, setDaily] = useState(f(t.limits.daily));
  const [above, setAbove] = useState(f(t.limits.approvalAbove));
  const p = parse(per, t.decimals), d = parse(daily, t.decimals), a = parse(above, t.decimals);
  const bad =
    p === null || d === null || a === null ? 'Enter all three amounts as plain numbers.'
    : p > MAX_U128 || d > MAX_U128 || a > MAX_U128 ? 'An amount is too large.'
    : a > p ? 'The approval threshold cannot be above the per-trade cap: the contract reverts BadLimits().'
    : undefined;
  return (
    <>
      <div className="fields">
        <div className="field">
          <span className="label">Trading</span>
          <div className="picker" role="group" aria-label="Trading allowed">
            <button type="button" aria-pressed={allowed} onClick={() => setAllowed(true)}>allowed</button>
            <button type="button" aria-pressed={!allowed} onClick={() => setAllowed(false)}>not allowed</button>
          </div>
        </div>
        <div className="field">
          <label className="label" htmlFor="c-per">Per trade, {t.symbol}</label>
          <input id="c-per" value={per} onChange={(e) => setPer(e.target.value)} inputMode="decimal" />
          <span className="hint">The most one trade may spend of this token.</span>
        </div>
        <div className="field">
          <label className="label" htmlFor="c-daily">Daily window, {t.symbol}</label>
          <input id="c-daily" value={daily} onChange={(e) => setDaily(e.target.value)} inputMode="decimal" />
          <span className="hint">The most the agent may spend of this token in any rolling 24 hours.</span>
        </div>
        <div className="field">
          <label className="label" htmlFor="c-above">Approval threshold, {t.symbol}</label>
          <input id="c-above" value={above} onChange={(e) => setAbove(e.target.value)} inputMode="decimal" aria-invalid={bad?.includes('threshold')} />
          <span className="hint">A trade above this waits for the owner&apos;s approval instead of executing.</span>
        </div>
      </div>
      {ownerReason && <p className="note warn">{ownerReason}</p>}
      {!ownerReason && bad && <p className="note">{bad}</p>}
      <div className="actions">
        <button className="btn" type="button" disabled={!!ownerReason || !!bad || tx.busy}
          onClick={() => tx.run(`Set ${t.symbol} caps`, () => writeContractAsync({
            address: snap.account, abi: accountAbi, functionName: 'setLimits',
            args: [t.address, { allowed, perTrade: p as bigint, daily: d as bigint, approvalAbove: a as bigint }], chainId: rhcChain.id,
          }))}>
          Set caps
        </button>
      </div>
    </>
  );
}

function CapsStep({ snap, refetch }: Ctx) {
  const [i, setI] = useState(0);
  const t = snap.tokens[i];
  return (
    <li className="step" aria-labelledby="o-caps">
      <Num n={2} mark="plain" />
      <div className="step-body">
        <h3 id="o-caps" className="t-section">Set caps</h3>
        <p className="prose">Caps are in the units of the token that leaves the account. A token with trading not allowed cannot be bought or sold.</p>
        <TokenPick tokens={snap.tokens} value={i} onChange={setI} />
        <CapsForm key={t.address} snap={snap} refetch={refetch} t={t} />
      </div>
    </li>
  );
}

function MeasurementStep({ snap, refetch }: Ctx) {
  const { ownerReason } = useGate(snap);
  const [m, setM] = useState('');
  const tx = useTx(refetch);
  const { writeContractAsync } = useWriteContract();
  const valid = isBytes32(m.trim());
  const listed = valid && snap.approved.some((x) => x.toLowerCase() === m.trim().toLowerCase());
  const send = (approved: boolean) =>
    tx.run(approved ? 'Approve measurement' : 'Withdraw approval', () =>
      writeContractAsync({ address: snap.account, abi: accountAbi, functionName: 'setMeasurement', args: [m.trim() as Hex, approved], chainId: rhcChain.id }));
  return (
    <li className="step" aria-labelledby="o-meas">
      <Num n={3} mark="plain" />
      <div className="step-body">
        <h3 id="o-meas" className="t-section">Approve a measurement</h3>
        <p className="prose">
          An agent key is admitted only when its quote carries an approved measurement. Withdrawing approval for the measurement the
          current agent was admitted under revokes that agent at once.
        </p>
        <div className="fields">
          <div className="field">
            <label className="label" htmlFor="m-hash">Measurement, bytes32</label>
            <input id="m-hash" className="hexin" value={m} onChange={(e) => setM(e.target.value)} placeholder="0x…" spellCheck={false} aria-invalid={m !== '' && !valid} />
            <span className="hint">
              {valid ? (listed ? 'Approved on this account now.' : 'Not approved on this account now.') : 'Read it from a quote with Verifier.verify, or take the one the refused quote carried.'}{' '}
              <button type="button" className="textbtn" onClick={() => setM(GATEWAY_MEASUREMENT)}>Use the refused quote&apos;s measurement</button>
            </span>
          </div>
        </div>
        {ownerReason && <p className="note warn">{ownerReason}</p>}
        <div className="actions">
          <button className="btn" type="button" disabled={!!ownerReason || !valid || tx.busy} onClick={() => send(true)}>Approve</button>
          <button className="btn line" type="button" disabled={!!ownerReason || !valid || tx.busy} onClick={() => send(false)}>Withdraw approval</button>
        </div>
      </div>
    </li>
  );
}

function PendingStep({ snap, refetch, now }: Ctx & { now: bigint }) {
  const { ownerReason } = useGate(snap);
  const tx = useTx(refetch);
  const { writeContractAsync } = useWriteContract();
  const pending = snap.proposals.filter((p) => p.status === 'Pending');
  const tok = (a: Address) => snap.tokens.find((t) => t.address.toLowerCase() === a.toLowerCase());
  return (
    <li className="step" aria-labelledby="o-pend">
      <Num n={4} mark="plain" />
      <div className="step-body">
        <h3 id="o-pend" className="t-section">Approve or reject a pending trade</h3>
        <p className="prose">
          When the agent proposes a trade above the approval threshold, the account holds it here with the model hash the agent&apos;s
          receipt recorded. Approving executes exactly that trade; rejecting closes it.
        </p>
        {ownerReason && <p className="note warn">{ownerReason}</p>}
        {pending.length === 0 ? (
          <Spec subject={<span className="t-subject">Nothing waiting</span>}>
            <Fact label="proposals">{snap.proposalCount.toString()} proposed in total</Fact>
            <Fact label="pending">0</Fact>
          </Spec>
        ) : (
          <div>
            {pending.map((p) => {
              const inTok = tok(p.trade.zeroForOne ? p.trade.key.currency0 : p.trade.key.currency1);
              const outTok = tok(p.trade.zeroForOne ? p.trade.key.currency1 : p.trade.key.currency0);
              const left = Number(p.expiry) - Number(now);
              return (
                <Spec
                  key={p.id.toString()}
                  subject={<><span className="t-subject">Proposal {p.id.toString()}</span><span className="small">{fmtCountdown(left)}</span></>}
                  action={
                    <span className="actions">
                      <button className="btn" type="button" disabled={!!ownerReason || left < 0 || tx.busy}
                        onClick={() => tx.run(`Approve proposal ${p.id}`, () => writeContractAsync({ address: snap.account, abi: accountAbi, functionName: 'approveTrade', args: [p.id, p.trade], chainId: rhcChain.id }))}>
                        Approve
                      </button>
                      <button className="btn line" type="button" disabled={!!ownerReason || tx.busy}
                        onClick={() => tx.run(`Reject proposal ${p.id}`, () => writeContractAsync({ address: snap.account, abi: accountAbi, functionName: 'rejectTrade', args: [p.id], chainId: rhcChain.id }))}>
                        Reject
                      </button>
                    </span>
                  }
                >
                  <Fact label="Sells">{inTok ? `${fmtToken(p.trade.amountIn, inTok.decimals)} ${inTok.symbol}` : p.trade.amountIn.toString()}</Fact>
                  <Fact label="At least">{outTok ? `${fmtToken(p.trade.minOut, outTok.decimals)} ${outTok.symbol}` : p.trade.minOut.toString()}</Fact>
                  <Fact label="Served model hash" wide><HexValue value={p.servedModelHash} head={8} tail={6} /></Fact>
                </Spec>
              );
            })}
          </div>
        )}
      </div>
    </li>
  );
}

export function OwnerActions({ snap, refetch, now }: Ctx & { now: bigint }) {
  const conn = useConnection();
  return (
    <section className="section" aria-labelledby="own-h">
      <div className="section-head">
        <h2 id="own-h" className="t-section">Owner actions</h2>
        <span className="stamp">{conn.isConnected ? 'wallet connected' : 'connect a wallet to act'}</span>
      </div>
      <p className="section-intro">
        Each action is a transaction from the connected wallet to <HexValue value={snap.account} head={6} tail={4} href={rhcExplorer.address(snap.account)} />.
        It reads as done only once the receipt says <Code>success</Code>, and the sheet above re-reads the chain afterwards.
      </p>
      <ol className="steps">
        <FundsStep snap={snap} refetch={refetch} />
        <CapsStep snap={snap} refetch={refetch} />
        <MeasurementStep snap={snap} refetch={refetch} />
        <PendingStep snap={snap} refetch={refetch} now={now} />
      </ol>
    </section>
  );
}
