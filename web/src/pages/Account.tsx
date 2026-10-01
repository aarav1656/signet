import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { getAddress, isAddress, keccak256, parseEventLogs, toHex, type Address } from 'viem';
import { useConnect, useConnection, useConnectors, usePublicClient, useSwitchChain, useWriteContract } from 'wagmi';
import { rhcChain, rhcExplorer } from '../chain';
import { factoryAbi } from '../abi/AgentAccount.generated';
import { Fact, HexValue, Num, Spec, Stamp, TitleBlock } from '../components/Stamp';
import { useAtBlock } from '../hooks/useAtBlock';
import { useTx } from '../hooks/useTx';
import { fmtCountdown, fmtStamp, fmtToken, short } from '../lib/format';
import { DEMO_ACCOUNT, FACTORY, GATEWAY_MEASUREMENT, MODEL_ID, RHC_DEPLOY_BLOCK } from '../lib/rhc.generated';
import { Compare } from './account/Compare';
import { OwnerActions } from './account/OwnerActions';
import { Refusals, useRefusals } from './account/Refusals';
import { ZERO_ADDR, ZERO_HASH, readAccount, type Snapshot, type TokenRow } from './account/read';

const MODEL_HASH = keccak256(toHex(MODEL_ID));

function CreateAction({ onCreated }: { onCreated: (a: Address) => void }) {
  const conn = useConnection();
  const connectors = useConnectors();
  const { mutate: connect, isPending } = useConnect();
  const { mutate: switchChain } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const tx = useTx(() => {});
  const [made, setMade] = useState<Address>();

  const wrongChain = conn.isConnected && conn.chainId !== rhcChain.id;
  const label = !conn.isConnected ? 'Connect a wallet to create an account' : wrongChain ? `Switch to ${rhcChain.name}` : 'Create an account';

  async function click() {
    if (!conn.isConnected) return connect({ connector: connectors[0] });
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
    <>
      <div className="actions">
        <button className="btn" type="button" disabled={isPending || connectors.length === 0 || tx.busy} onClick={click}>
          {isPending ? 'Connecting' : tx.state.phase === 'signing' ? 'Confirm in the wallet' : tx.state.phase === 'mining' ? 'Waiting for the receipt' : label}
        </button>
        <span className="small">The factory deploys an account that only your wallet controls.</span>
      </div>
      {tx.state.phase === 'failed' && (
        <p className="note warn" role="alert">Account not created: {tx.state.message}</p>
      )}
      {made && (
        <p className="note">
          Created <HexValue value={made} head={6} tail={4} href={rhcExplorer.address(made)} />. The sheet below shows it.
        </p>
      )}
    </>
  );
}

function TokenSpec({ t, now }: { t: TokenRow; now: bigint }) {
  void now;
  const ratio = t.limits.daily === 0n ? 0 : Math.min(100, Number((t.used * 10_000n) / t.limits.daily) / 100);
  return (
    <Spec
      subject={
        <>
          <span className="t-subject">{t.symbol}</span>
          <span className="small">{t.limits.allowed ? 'trading allowed' : 'trading not allowed'}</span>
        </>
      }
    >
      <Fact label="Per trade">{t.limits.allowed ? fmtToken(t.limits.perTrade, t.decimals) : 'none'}</Fact>
      <Fact label="Approval threshold">{t.limits.allowed ? fmtToken(t.limits.approvalAbove, t.decimals) : 'none'}</Fact>
      <Fact label="Daily window, used of cap">
        <span className="tnum">{fmtToken(t.used, t.decimals)} of {t.limits.allowed ? fmtToken(t.limits.daily, t.decimals) : '0.00'}</span>
        <span className="meter" aria-hidden="true"><i style={{ width: `${ratio}%` }} /></span>
      </Fact>
      <Fact label="Balance">{fmtToken(t.balance, t.decimals)}</Fact>
    </Spec>
  );
}

function Sheet({ snap, block, now, mine, onPick }: { snap: Snapshot; block: bigint; now: bigint; mine: Address[]; onPick: (a: Address) => void }) {
  const conn = useConnection();
  const you = !!conn.address && conn.address.toLowerCase() === snap.owner.toLowerCase();
  const hasAgent = snap.agent !== ZERO_ADDR;
  const left = Number(snap.agentExpiry) - Number(now);
  const model = snap.requestedModelHash === ZERO_HASH ? undefined : snap.requestedModelHash === MODEL_HASH ? MODEL_ID : undefined;
  const choices = [DEMO_ACCOUNT, ...mine.filter((a) => a.toLowerCase() !== DEMO_ACCOUNT.toLowerCase())];
  const tokenOf = (a: Address) => snap.tokens.find((t) => t.address.toLowerCase() === a.toLowerCase());

  return (
    <div className="doc sheet-doc">
      <div className="doc-head">
        <div className="doc-head-row">
          <span className="t-label">Account inspection sheet</span>
          <span className="switch" role="group" aria-label="Choose an account">
            {choices.map((a) => (
              <button key={a} type="button" aria-pressed={a.toLowerCase() === snap.account.toLowerCase()} onClick={() => onPick(a)}>
                {a === DEMO_ACCOUNT ? 'deployed account' : `yours ${short(a)}`}
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
              <div className="drow" key={t.address}><span className="t-label">{t.symbol}</span><span className="v tnum">{fmtToken(t.balance, t.decimals)}</span></div>
            ))}
            <div className="drow"><span className="t-label">Paused</span><span className="v">{snap.paused ? 'yes, the agent cannot trade' : 'no'}</span></div>
          </div>
        </section>

        <section className="sheet-sec" aria-labelledby="s-agent">
          <h3 id="s-agent" className="t-label sec-title"><Num n={2} mark="plain" /> Registered agent</h3>
          <div className="doc-rows">
            <div className="drow"><span className="t-label">Agent</span><span className="v">{hasAgent ? <HexValue value={snap.agent} head={6} tail={4} href={rhcExplorer.address(snap.agent)} /> : 'none yet'}</span></div>
            <div className="drow"><span className="t-label">Attested measurement</span><span className="v">{hasAgent ? <HexValue value={snap.agentMeasurement} head={8} tail={6} /> : 'none, set when a quote is admitted'}</span></div>
            <div className="drow"><span className="t-label">Expires</span><span className="v">{hasAgent ? <>{fmtStamp(snap.agentExpiry)} <span className="small">{fmtCountdown(left)}</span></> : 'not applicable'}</span></div>
            <div className="drow"><span className="t-label">Model pin</span><span className="v">{model ?? (snap.requestedModelHash === ZERO_HASH ? 'not set' : <HexValue value={snap.requestedModelHash} head={8} tail={6} />)}</span></div>
          </div>
        </section>

        <section className="sheet-sec" aria-labelledby="s-meas">
          <h3 id="s-meas" className="t-label sec-title"><Num n={3} mark="plain" /> Approved measurements</h3>
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
          <h3 id="s-pol" className="t-label sec-title"><Num n={4} mark="plain" /> Approvals</h3>
          <div className="doc-rows">
            <div className="drow"><span className="t-label">Proposal lifetime</span><span className="v">{Number(snap.approvalTtl) / 60} minutes</span></div>
            <div className="drow"><span className="t-label">Proposed</span><span className="v tnum">{snap.proposalCount.toString()}</span></div>
            <div className="drow"><span className="t-label">Executed</span><span className="v tnum">{snap.tradeCount.toString()}</span></div>
          </div>
        </section>
      </div>

      <section className="sheet-sec wide" aria-labelledby="s-caps">
        <h3 id="s-caps" className="t-label sec-title"><Num n={5} mark="plain" /> Per-token caps, daily window and approval threshold</h3>
        <p className="gloss">
          <b>Per trade:</b> the most one trade may spend. <b>Daily window:</b> the most spent in any rolling 24 hours.{' '}
          <b>Approval threshold:</b> a trade above it waits for the owner instead of executing.
        </p>
        {snap.tokens.map((t) => <TokenSpec key={t.address} t={t} now={now} />)}
      </section>

      <section className="sheet-sec wide last" aria-labelledby="s-trades">
        <h3 id="s-trades" className="t-label sec-title"><Num n={6} mark="plain" /> Last trades, with the model hash each recorded</h3>
        <p className="gloss">
          <b>Model hash:</b> the hash of the model name the inference gateway&apos;s signed receipt says answered; the account
          checks it equals the owner&apos;s pin before the trade runs.
        </p>
        {snap.trades.length === 0 ? (
          <Spec subject={<span className="t-subject">No trade yet</span>}>
            <Fact label="executed">{snap.tradeCount.toString()} at block {block.toLocaleString('en-US')}</Fact>
            <Fact label="listed here" wide>Each executed trade appears with its amounts, the attested measurement and the served model hash.</Fact>
          </Spec>
        ) : (
          snap.trades.map((tr) => {
            const a = tokenOf(tr.tokenIn), b = tokenOf(tr.tokenOut);
            return (
              <Spec
                key={tr.tx}
                subject={<><span className="t-subject">Trade {tr.tradeId.toString()}</span><span className="small">{fmtStamp(tr.time)}</span></>}
                action={<a href={rhcExplorer.tx(tr.tx)} target="_blank" rel="noreferrer">transaction</a>}
              >
                <Fact label="Sold">{a ? `${fmtToken(tr.amountIn, a.decimals)} ${a.symbol}` : tr.amountIn.toString()}</Fact>
                <Fact label="Bought">{b ? `${fmtToken(tr.amountOut, b.decimals)} ${b.symbol}` : tr.amountOut.toString()}</Fact>
                <Fact label="Served model hash" wide>
                  <HexValue value={tr.servedModelHash} head={8} tail={6} />
                  <span className="small">{tr.servedModelHash.toLowerCase() === snap.requestedModelHash.toLowerCase() ? 'equals the pin' : 'accepted served variant'}</span>
                </Fact>
              </Spec>
            );
          })
        )}
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
    document.title = 'Chiron: an account an attested agent can trade from';
  }, []);

  const snapQ = useAtBlock(['account', account], (c, b) => readAccount(c, account, b), true, rhcChain.id);
  const refusals = useRefusals();
  const mineQ = useQuery({
    queryKey: ['mine', conn.address],
    enabled: !!conn.address && !!client,
    refetchInterval: 15_000,
    queryFn: async () => {
      const logs = await client!.getContractEvents({
        address: FACTORY, abi: factoryAbi, eventName: 'AccountCreated', args: { owner: conn.address }, fromBlock: RHC_DEPLOY_BLOCK, toBlock: 'latest',
      });
      return logs.map((l) => l.args.account as Address);
    },
  });
  const mine = mineQ.data ?? [];
  const pick = (a: Address) => setParams(a === DEMO_ACCOUNT ? {} : { account: a }, { replace: true });

  const snap = snapQ.data?.value;
  const live = refusals.data?.value;
  const refused = !!live && live.notAgent.reverted && live.notAgent.name === 'NotAgent';
  const verdict = refusals.isError
    ? { label: 'Verdict', value: 'Chain unreadable', tone: 'alarm' as const, lead: true }
    : !live
      ? { label: 'Verdict', value: 'Asking the contract', lead: true }
      : refused
        ? { label: 'Verdict', value: 'Unattested key refused', tone: 'signal' as const, lead: true }
        : { label: 'Verdict', value: 'Not refused', tone: 'alarm' as const, lead: true };

  return (
    <>
      <div className="opener account">
        <TitleBlock
          cells={[
            { label: 'Network', value: `${rhcChain.name}, ${rhcChain.id}`, mobileHide: true },
            { label: 'Account', value: <HexValue value={account} head={6} tail={4} href={rhcExplorer.address(account)} />, mobileHide: true },
            { label: 'Block', value: snapQ.data ? <Stamp block={snapQ.data.block} url={rhcExplorer.block} label="" /> : 'reading', mobileHide: true },
            verdict,
          ]}
        />

        <header className="head">
          <h1 className="t-display">An account your AI agent can trade from only if its hardware proves which code it runs.</h1>
          <p className="gloss">
            <b>Attestation:</b> a statement signed by the agent&apos;s processor about the code it is running. <b>Measurement:</b> the
            fingerprint, a 32-byte hash, of that code, which the owner approves in advance. <b>TDX:</b> Intel Trust Domain
            Extensions, the confidential-computing hardware that signs the attestation; a Stylus contract (Rust on Arbitrum)
            verifies it on chain.
          </p>
          <CreateAction onCreated={pick} />
        </header>

        {snapQ.isError && (
          <div className="alarm" role="alert">
            <b>Could not read the account.</b>
            <span>{String(snapQ.error).slice(0, 180)}</span>
            <button className="textbtn" onClick={() => snapQ.refetch()}>Read again</button>
          </div>
        )}

        <figure className="board" aria-busy={snapQ.isPending}>
          <figcaption className="sr-only">The account as an inspection sheet, read live from Robinhood Chain testnet</figcaption>
          {snap && snapQ.data ? (
            <Sheet snap={snap} block={snapQ.data.block} now={snapQ.data.timestamp} mine={mine} onPick={pick} />
          ) : (
            <div className="doc sheet-doc"><div className="doc-head"><span className="t-label">Account inspection sheet</span><span className="small">Reading {short(account)} from the chain.</span></div></div>
          )}
        </figure>
      </div>

      <Refusals q={refusals} />
      {snap && snapQ.data && <OwnerActions snap={snap} refetch={() => snapQ.refetch()} now={snapQ.data.timestamp} />}
      <Compare />
    </>
  );
}
