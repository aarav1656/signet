import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Address, Hash } from 'viem';
import { useConnection, usePublicClient, useSwitchChain, useWriteContract } from 'wagmi';
import { accountAbi } from '../../abi/AgentAccount.generated';
import { rhcChain, rhcExplorer } from '../../chain';
import { EligibilityGate } from '../../components/Eligibility';
import { HexValue, Num } from '../../components/Stamp';
import { Wallet } from '../../components/Wallet';
import { useMyAccounts } from '../../hooks/useMyAccounts';
import { useTx } from '../../hooks/useTx';
import { short } from '../../lib/format';
import { PAXOS_USDG, OPERATOR_CVM_URL, TSLA } from '../../lib/rhc.generated';
import type { TrackAgent } from '../../lib/track';
import { DEFAULT_LIMITS, REQUESTED_MODEL_HASH, VENUE_GATEWAY_MEASUREMENT, VENUE_POOL, type LimitsInput } from '../../lib/venue';
import { CreateAction } from '../Account';
import { readOperatorQuote } from '../account/operator';
import { parseLimits, pending, planFollow, type FollowSpec, type Step, type StepId } from './followPlan';
import { readFollowState } from './followRead';

const ZERO32 = `0x${'0'.repeat(64)}` as const;
const RPC = 'https://rpc.testnet.chain.robinhood.com';

type Limits = { usdg: LimitsInput; tsla: LimitsInput };

function LimitFields({ symbol, value, onChange, error }: { symbol: string; value: LimitsInput; onChange: (v: LimitsInput) => void; error?: string }) {
  const f = (k: keyof LimitsInput, label: string) => (
    <label className="sg-lim-f">
      <span>{label}</span>
      <input value={value[k]} inputMode="decimal" spellCheck={false} aria-label={`${symbol} ${label}`} aria-invalid={!!error} onChange={(e) => onChange({ ...value, [k]: e.target.value })} />
    </label>
  );
  return (
    <div className="sg-lim">
      <b className="sg-lim-sym">{symbol}</b>
      {f('perTrade', 'Per trade')}
      {f('daily', 'Per day')}
      {f('approvalAbove', 'Waits for you above')}
      {error && <p className="note warn sg-lim-err">{error}</p>}
    </div>
  );
}

export function FollowPanel({ agent }: { agent: TrackAgent }) {
  const conn = useConnection();
  const { mutate: switchChain } = useSwitchChain();
  const client = usePublicClient({ chainId: rhcChain.id });
  const { writeContractAsync } = useWriteContract();
  const mineQ = useMyAccounts();
  const mine = mineQ.data ?? [];
  const [picked, setPicked] = useState<Address>();
  const account = picked && mine.includes(picked) ? picked : mine[0];
  const [limits, setLimits] = useState<Limits>(DEFAULT_LIMITS);
  const [active, setActive] = useState<StepId>();
  const [note, setNote] = useState<string>();

  const usdg = parseLimits(limits.usdg, 6);
  const tsla = parseLimits(limits.tsla, 18);
  const stateQ = useQuery({
    queryKey: ['follow-state', account, agent.measurement],
    enabled: !!client && !!account,
    refetchInterval: 15_000,
    retry: 1,
    queryFn: () => readFollowState(client as never, account as Address, agent.measurement),
  });
  const tx = useTx(() => void stateQ.refetch());

  const spec: FollowSpec = {
    measurement: agent.measurement, requestedModelHash: REQUESTED_MODEL_HASH, servedModelHash: agent.modelHash, gatewayMeasurement: VENUE_GATEWAY_MEASUREMENT,
    usdg: { decimals: 6, limits: limits.usdg }, tsla: { decimals: 18, limits: limits.tsla },
  };
  const steps = stateQ.data ? planFollow(stateQ.data.state, spec) : undefined;
  const todo = steps ? pending(steps) : [];
  const owns = !!stateQ.data && !!conn.address && stateQ.data.owner.toLowerCase() === conn.address.toLowerCase();
  const wrongChain = conn.isConnected && conn.chainId !== rhcChain.id;
  const limitError = !usdg.ok ? usdg.reason : !tsla.ok ? tsla.reason : undefined;

  const write = (step: StepId): Promise<Hash> => {
    const base = { address: account as Address, abi: accountAbi, chainId: rhcChain.id } as const;
    if (step === 'limits-usdg' && usdg.ok) return writeContractAsync({ ...base, functionName: 'setLimits', args: [PAXOS_USDG, usdg.value] });
    if (step === 'limits-tsla' && tsla.ok) return writeContractAsync({ ...base, functionName: 'setLimits', args: [TSLA, tsla.value] });
    if (step === 'pool') return writeContractAsync({ ...base, functionName: 'setPool', args: [VENUE_POOL, true] });
    if (step === 'model') return writeContractAsync({ ...base, functionName: 'setModel', args: [REQUESTED_MODEL_HASH, [agent.modelHash, ZERO32, ZERO32, ZERO32], VENUE_GATEWAY_MEASUREMENT] });
    if (step === 'measurement') return writeContractAsync({ ...base, functionName: 'setMeasurement', args: [agent.measurement, true] });
    throw new Error(`no call for step ${step}`);
  };

  async function follow() {
    if (!account || !client) return;
    setNote(undefined);
    for (const step of todo) {
      setActive(step.id);
      if (step.id === 'admit') {
        // A quote names a block hash the chain answers for 256 blocks, so admission asks the agent for a fresh one.
        let q;
        try {
          q = await readOperatorQuote(client as never, OPERATOR_CVM_URL, account);
        } catch (e) {
          setNote(`The agent did not hand over a quote (${e instanceof Error ? e.message.split('\n')[0] : String(e)}). Your account is set up; any wallet can admit the agent with a fresh quote once it answers.`);
          break;
        }
        if (q.measurement.toLowerCase() !== agent.measurement.toLowerCase()) {
          setNote(`The agent running now proves measurement ${short(q.measurement)}, not ${short(agent.measurement)}. Your account approves only this code, so the running agent is refused until a boot of this code answers.`);
          break;
        }
        const r = await tx.run('Admit the agent', () => writeContractAsync({ address: account, abi: accountAbi, functionName: 'registerAgent', args: [q.quote, q.refBlock], chainId: rhcChain.id }));
        if (!r) break;
      } else {
        const r = await tx.run(step.title, () => write(step.id));
        if (!r) break;
      }
    }
    setActive(undefined);
    void stateQ.refetch();
  }

  const stepMark = (s: Step): 'pass' | 'fail' | 'plain' => (s.done ? 'pass' : tx.state.phase === 'failed' && active === s.id ? 'fail' : 'plain');
  const label = tx.state.phase === 'signing' ? 'Confirm in the wallet' : tx.state.phase === 'mining' ? 'Waiting for the receipt' : todo.length === 0 && steps ? 'Following' : `Follow this code${todo.length ? `, ${todo.length} ${todo.length === 1 ? 'signature' : 'signatures'}` : ''}`;

  return (
    <section className="sg-follow-panel" id="follow" aria-labelledby="follow-h">
      <h2 id="follow-h" className="t-section">Let this code trade for you</h2>
      <p className="prose">
        Following approves one measurement on your own account. Only a key whose Intel TDX quote carries it can trade your Stock Tokens, and
        the limits below stop it at a size you chose.
      </p>
      <EligibilityGate>
        {!conn.isConnected ? (
          <div className="actions"><Wallet /><span className="small">Connect the wallet that owns your Chiron account.</span></div>
        ) : mineQ.isPending ? (
          <p className="small">Looking for your accounts on Robinhood Chain testnet.</p>
        ) : mine.length === 0 ? (
          <div className="sg-noacct">
            <p className="note">Following happens on an account you own, so the first step is one. The factory deploys it with you as the only owner.</p>
            <CreateAction onCreated={(a) => { setPicked(a); void mineQ.refetch(); }} />
          </div>
        ) : (
          <>
            {mine.length > 1 && (
              <div className="switch" role="group" aria-label="Choose your account">
                {mine.map((a) => <button key={a} type="button" aria-pressed={a === account} onClick={() => setPicked(a)}>{short(a)}</button>)}
              </div>
            )}
            <p className="small">Account <HexValue value={account as string} head={6} tail={4} href={rhcExplorer.address(account as string)} />{stateQ.data && <>, read at block {stateQ.data.block.toLocaleString('en-US')}</>}</p>

            <div className="sg-safety">
              <h3 className="t-label">Safety net: limits the account enforces whatever the code does</h3>
              <LimitFields symbol="USDG" value={limits.usdg} onChange={(v) => setLimits({ ...limits, usdg: v })} error={!usdg.ok ? usdg.reason : undefined} />
              <LimitFields symbol="TSLA" value={limits.tsla} onChange={(v) => setLimits({ ...limits, tsla: v })} error={!tsla.ok ? tsla.reason : undefined} />
            </div>

            {stateQ.isError && <div className="alarm" role="alert"><b>Could not read the account.</b><span>{String(stateQ.error).slice(0, 140)}</span></div>}
            {steps && (
              <ol className="sg-steps" aria-label="What following changes on your account">
                {steps.map((s, i) => (
                  <li key={s.id} className={s.done ? 'done' : active === s.id ? 'live' : undefined}>
                    <Num n={i + 1} mark={stepMark(s)} />
                    <div>
                      <b>{s.title}</b>
                      <span className="small">
                        {s.done ? 'Done on the chain.' : active === s.id ? (tx.state.phase === 'signing' ? 'Confirm in the wallet.' : tx.state.phase === 'mining' ? <>Pending: <a href={rhcExplorer.tx(tx.state.hash)} target="_blank" rel="noreferrer">{short(tx.state.hash)}</a></> : s.detail) : s.detail}
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
            )}
            {tx.state.phase === 'failed' && <p className="note warn" role="alert">{tx.state.message} Nothing after this step ran. Press the button to resume from here.</p>}
            {note && <p className="note" role="status">{note}</p>}
            {steps && !owns && stateQ.data && <p className="note warn">This account belongs to {short(stateQ.data.owner)}. Connect that wallet to change it.</p>}
            <div className="actions">
              <button
                className="btn"
                type="button"
                disabled={!steps || !owns || tx.busy || (todo.length === 0 && !!steps) || (!wrongChain && !!limitError)}
                onClick={wrongChain ? () => switchChain({ chainId: rhcChain.id }) : follow}
              >
                {wrongChain ? `Switch to ${rhcChain.name}` : label}
              </button>
              {limitError && <span className="small">{limitError}</span>}
            </div>
          </>
        )}
      </EligibilityGate>
      <details className="sg-cast">
        <summary>The same approval from a terminal</summary>
        <pre>{`cast send $ACCOUNT "setMeasurement(bytes32,bool)" \\
  ${agent.measurement} true \\
  --rpc-url ${RPC} --private-key $OWNER_KEY`}</pre>
      </details>
    </section>
  );
}
