import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { getAddress, isAddress, parseEventLogs, type Address } from 'viem';
import { useConnection, usePublicClient, useSwitchChain, useWriteContract } from 'wagmi';
import { rhcChain, rhcExplorer } from '../chain';
import { factoryAbi } from '../abi/AgentAccount.generated';
import { Fact, HexValue, Num, Spec } from '../components/Stamp';
import { EligibilityGate } from '../components/Eligibility';
import { corporateActionLabel } from './account/corp';
import { Wallet } from '../components/Wallet';
import { useAtBlock } from '../hooks/useAtBlock';
import { useTx } from '../hooks/useTx';
import { fmtToken, short } from '../lib/format';
import { DEMO_ACCOUNT, LEGACY_ACCOUNT, FACTORIES, FACTORY, GATEWAY_MEASUREMENT, RHC_DEPLOY_BLOCK } from '../lib/rhc.generated';
import { Compare } from './account/Compare';
import { OwnerActions } from './account/OwnerActions';
import { Refusals, useRefusals } from './account/Refusals';
import { GateLog } from './account/GateLog';
import { readAccount, type Snapshot, type TokenRow } from './account/read';

function CreateAction({ onCreated }: { onCreated: (a: Address) => void }) {
  const conn = useConnection();
  const { mutate: switchChain } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const tx = useTx(() => {});
  const [made, setMade] = useState<Address>();

  const wrongChain = conn.isConnected && conn.chainId !== rhcChain.id;

  async function click() {
    if (wrongChain) return switchChain({ chainId: rhcChain.id });
    const owner = conn.address as Address;
    const receipt = await tx.run('Create account', () =>
      writeContractAsync({ address: FACTORY, abi: factoryAbi, functionName: 'createAccount', args: [owner], chainId: rhcChain.id }),
    );
    if (!receipt) return;
    const [created] = parseEventLogs({ abi: factoryAbi, eventName: 'AccountCreated', logs: receipt.logs });
    if (!created) return;
    setMade(created.args.account);
    onCreated(created.args.account);
  }

  return (
    <EligibilityGate>
      <div className="actions">
        {conn.isConnected ? (
          <button className="btn line" type="button" disabled={tx.busy} onClick={click}>
            {tx.state.phase === 'signing' ? 'Confirm in the wallet' : tx.state.phase === 'mining' ? 'Waiting for the receipt' : wrongChain ? `Switch to ${rhcChain.name}` : 'Create an account'}
          </button>
        ) : (
          <Wallet />
        )}
        <span className="small">The factory deploys an account that only your wallet controls. It holds Paxos USDG and pays for inference in Paxos USDG.</span>
      </div>
      {made && (
        <p className="note">
          Created <HexValue value={made} head={6} tail={4} href={rhcExplorer.address(made)} />. It is selected above.
        </p>
      )}
    </EligibilityGate>
  );
}

function TokenSpec({ t, now }: { t: TokenRow; now: bigint }) {
  const ratio = t.limits.daily === 0n ? 0 : Math.min(100, Number((t.used * 10_000n) / t.limits.daily) / 100);
  return (
    <Spec
      subject={
        <>
          <span className="t-subject">{t.symbol}</span>
          <span className="small">{t.note ? `${t.note}, ` : ''}{t.limits.allowed ? 'trading allowed' : 'trading not allowed'}</span>
        </>
      }
    >
      <Fact label="Per trade">{t.limits.allowed ? fmtToken(t.limits.perTrade, t.decimals) : 'none'}</Fact>
      {t.corp && <Fact label="Corporate action, ERC-8056" wide>{corporateActionLabel(t.corp, now).text}</Fact>}
      <Fact label="Approval threshold">{t.limits.allowed ? fmtToken(t.limits.approvalAbove, t.decimals) : 'none'}</Fact>
      <Fact label="Daily window, used of cap">
        <span className="tnum">{fmtToken(t.used, t.decimals)} of {t.limits.allowed ? fmtToken(t.limits.daily, t.decimals) : '0.00'}</span>
        <span className="meter" aria-hidden="true"><i style={{ width: `${ratio}%` }} /></span>
      </Fact>
      <Fact label="Balance">{fmtToken(t.balance, t.decimals)}</Fact>
    </Spec>
  );
}

function Mandate({ snap, block, now, mine, onPick }: { snap: Snapshot; block: bigint; now: bigint; mine: Address[]; onPick: (a: Address) => void }) {
  const conn = useConnection();
  const you = !!conn.address && conn.address.toLowerCase() === snap.owner.toLowerCase();
  const choices = [DEMO_ACCOUNT, LEGACY_ACCOUNT, ...mine.filter((a) => a.toLowerCase() !== DEMO_ACCOUNT.toLowerCase() && a.toLowerCase() !== LEGACY_ACCOUNT.toLowerCase())];

  return (
    <div className="doc sheet-doc">
      <div className="doc-head">
        <div className="doc-head-row">
          <span className="t-label">Account</span>
          <span className="switch" role="group" aria-label="Choose an account">
            {choices.map((a) => (
              <button key={a} type="button" aria-pressed={a.toLowerCase() === snap.account.toLowerCase()} onClick={() => onPick(a)}>
                {a === DEMO_ACCOUNT ? 'Paxos USDG account' : a === LEGACY_ACCOUNT ? 'first venue account' : `yours ${short(a)}`}
              </button>
            ))}
          </span>
        </div>
        <span className="small">
          <HexValue value={snap.account} head={10} tail={8} href={rhcExplorer.address(snap.account)} />, read from the chain at block{' '}
          <a href={rhcExplorer.block(block)} target="_blank" rel="noreferrer">{block.toLocaleString('en-US')}</a>, refreshed every 15 s
        </span>
      </div>

      <div className="sheet-cols">
        <section className="sheet-sec" aria-labelledby="s-owner">
          <h3 id="s-owner" className="t-label sec-title"><Num n={1} mark="plain" /> Owner and funds</h3>
          <div className="doc-rows">
            <div className="drow"><span className="t-label">Owner</span><span className="v"><HexValue value={snap.owner} head={6} tail={4} href={rhcExplorer.address(snap.owner)} />{you && <span className="small"> you</span>}</span></div>
            {snap.tokens.map((t) => (
              <div className="drow" key={t.address}><span className="t-label">{t.symbol}{t.note && <span className="small"> {t.note}</span>}</span><span className="v tnum">{fmtToken(t.balance, t.decimals)}</span></div>
            ))}
            <div className="drow"><span className="t-label">Paused</span><span className="v">{snap.paused ? 'yes, the agent cannot trade' : 'no'}</span></div>
          </div>
        </section>

        <section className="sheet-sec" aria-labelledby="s-meas">
          <h3 id="s-meas" className="t-label sec-title"><Num n={2} mark="plain" /> Approved measurements</h3>
          <div className="doc-rows">
            {snap.approved.length === 0 ? (
              <div className="drow"><span className="t-label">Approved</span><span className="v">none, so no quote is admitted</span></div>
            ) : (
              snap.approved.map((m) => (
                <div className="drow" key={m}><span className="t-label">Approved</span><span className="v"><HexValue value={m} head={8} tail={6} /></span></div>
              ))
            )}
            <div className="drow">
              <span className="t-label">Phala gateway</span>
              <span className="v"><HexValue value={GATEWAY_MEASUREMENT} head={8} tail={6} /> <span className="small">{snap.gatewayApproved ? 'approved' : 'not approved'}</span></span>
            </div>
          </div>
        </section>

        <section className="sheet-sec" aria-labelledby="s-pol">
          <h3 id="s-pol" className="t-label sec-title"><Num n={3} mark="plain" /> Approvals</h3>
          <div className="doc-rows">
            <div className="drow"><span className="t-label">Proposal lifetime</span><span className="v">{Number(snap.approvalTtl) / 60} minutes</span></div>
            <div className="drow"><span className="t-label">Proposed</span><span className="v tnum">{snap.proposalCount.toString()}</span></div>
            <div className="drow"><span className="t-label">Executed</span><span className="v tnum">{snap.tradeCount.toString()}</span></div>
          </div>
        </section>
      </div>

      <section className="sheet-sec wide last" aria-labelledby="s-caps">
        <h3 id="s-caps" className="t-label sec-title"><Num n={4} mark="plain" /> Per-token caps, daily window and approval threshold</h3>
        <p className="gloss">
          <b>Per trade:</b> the most one trade may spend. <b>Daily window:</b> the most spent in any rolling 24 hours.{' '}
          <b>Approval threshold:</b> a trade above it waits for the owner instead of executing.
        </p>
        {snap.tokens.map((t) => <TokenSpec key={t.address} t={t} now={now} />)}
      </section>
    </div>
  );
}

export function Account() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('account') ?? '';
  const account: Address = isAddress(raw) ? getAddress(raw) : DEMO_ACCOUNT;
  const conn = useConnection();
  const client = usePublicClient({ chainId: rhcChain.id });

  useEffect(() => {
    document.title = 'Chiron: give an AI agent a mandate, not your keys';
  }, []);

  const snapQ = useAtBlock(['account', account], (c, b) => readAccount(c, account, b), true, rhcChain.id);
  const refusals = useRefusals();
  const mineQ = useQuery({
    queryKey: ['mine', conn.address],
    enabled: !!conn.address && !!client,
    refetchInterval: 15_000,
    queryFn: async () => {
      const logs = await Promise.all(FACTORIES.map((address) => client!.getContractEvents({
        address, abi: factoryAbi, eventName: 'AccountCreated', args: { owner: conn.address }, fromBlock: RHC_DEPLOY_BLOCK, toBlock: 'latest',
      })));
      return logs.flat().map((l) => l.args.account as Address);
    },
  });
  const mine = mineQ.data ?? [];
  const pick = (a: Address) => setParams(a === DEMO_ACCOUNT ? {} : { account: a }, { replace: true });

  const snap = snapQ.data?.value;
  const live = refusals.data?.value;
  const probe = live && refusals.data ? { block: refusals.data.block, refused: live.notAgent.reverted && live.notAgent.name === 'NotAgent', name: live.notAgent.name } : undefined;

  return (
    <>
      <div className="stage">
        <h1 className="hd">Give an AI agent a <em>mandate</em>, not your keys.</h1>
        <GateLog account={account} snap={snap} snapBlock={snapQ.data?.block} probe={account === DEMO_ACCOUNT ? probe : undefined} />
        <p className="lede">Caps per token. Big trades wait for you. Every trade records the model that made it, and every refusal is on the record too.</p>
        {account === DEMO_ACCOUNT && (
          <p className="small stage-acct">
            Reading <HexValue value={DEMO_ACCOUNT} head={6} tail={4} href={rhcExplorer.address(DEMO_ACCOUNT)} />: Paxos USDG on both legs, ERC-8056 corporate-action guard,
            one attested operator agent. The first venue account, with the live trade cycle on TestUSDG, is one click away under Account.
          </p>
        )}
        <div className="cta-row"><a className="btn" href="#account">Open the account <span aria-hidden="true">&rarr;</span></a></div>
        <div className="glosses">
          <p><b>Mandate.</b> The caps, approval line and approved measurements the owner sets. The account enforces them whatever the agent does.</p>
          <p><b>Attestation.</b> A signed report from the agent&apos;s Intel TDX chip, checked on chain by a Stylus contract.</p>
          <p><b>Measurement.</b> The fingerprint, a 32-byte hash, of the exact code the chip is running. The owner approves it in advance.</p>
        </div>
      </div>

      {snapQ.isError && (
        <div className="alarm" role="alert">
          <b>Could not read the account.</b>
          <span>{String(snapQ.error).slice(0, 180)}</span>
          <button className="textbtn" onClick={() => snapQ.refetch()}>Read again</button>
        </div>
      )}

      <section className="section" id="account" aria-labelledby="acc-h" aria-busy={snapQ.isPending}>
        <div className="section-head">
          <h2 id="acc-h" className="t-section">The mandate</h2>
        </div>
        {snap && snapQ.data ? (
          <Mandate snap={snap} block={snapQ.data.block} now={snapQ.data.timestamp} mine={mine} onPick={pick} />
        ) : (
          <div className="doc sheet-doc"><div className="doc-head"><span className="small">Reading {short(account)} from the chain.</span></div></div>
        )}
        <div className="create"><CreateAction onCreated={pick} /></div>
      </section>

      {snap && snapQ.data && <OwnerActions snap={snap} refetch={() => snapQ.refetch()} now={snapQ.data.timestamp} />}
      <Refusals q={refusals} />
      <Compare />
    </>
  );
}
