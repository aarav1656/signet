import { BaseError, ContractFunctionRevertedError, decodeErrorResult, type Address, type Hex, type PublicClient } from 'viem';
import { rhcChain, rhcExplorer } from '../../chain';
import { accountAbi } from '../../abi/AgentAccount.generated';
import { Code, HexValue, Stamp } from '../../components/Stamp';
import { useAtBlock } from '../../hooks/useAtBlock';
import sim from '../../lib/refusal-sim.json';
import { DEMO_ACCOUNT, GATEWAY_MEASUREMENT, GATEWAY_REGISTER_TX } from '../../lib/rhc.generated';
import { short } from '../../lib/format';
import { ZERO_ADDR, ZERO_HASH } from './read';

/** A key that was never attested. Any address works: the refusal comes before anything reads the arguments. */
const STRANGER = '0x000000000000000000000000000000000000dEaD' as Address;
const RPC = 'https://rpc.testnet.chain.robinhood.com';

type Live = {
  notAgent: { reverted: boolean; name?: string; selector?: string };
  agent: Address;
  gatewayApproved: boolean;
};

async function readRefusals(c: PublicClient, block: bigint): Promise<Live> {
  const zeroTrade = {
    key: { currency0: ZERO_ADDR, currency1: ZERO_ADDR, fee: 0, tickSpacing: 0, hooks: ZERO_ADDR },
    zeroForOne: true,
    amountIn: 1n,
    minOut: 1n,
    deadline: 1n,
  } as const;
  let notAgent: Live['notAgent'];
  try {
    await c.simulateContract({
      address: DEMO_ACCOUNT,
      abi: accountAbi,
      functionName: 'execute',
      args: [zeroTrade, { pubkey: ZERO_HASH, receiptBytes: '0x', signature: '0x' }],
      account: STRANGER,
      blockNumber: block,
    });
    notAgent = { reverted: false };
  } catch (e) {
    const r = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : undefined;
    if (!(r instanceof ContractFunctionRevertedError)) throw e;
    notAgent = { reverted: true, name: r.data?.errorName, selector: r.raw?.slice(0, 10) };
  }
  const [agent, gatewayApproved] = await c.multicall({
    allowFailure: false,
    blockNumber: block,
    contracts: [
      { address: DEMO_ACCOUNT, abi: accountAbi, functionName: 'agent' },
      { address: DEMO_ACCOUNT, abi: accountAbi, functionName: 'approvedMeasurement', args: [GATEWAY_MEASUREMENT] },
    ],
  });
  return { notAgent, agent, gatewayApproved };
}

export const useRefusals = (enabled = true) => useAtBlock(['refusals', DEMO_ACCOUNT], readRefusals, enabled, rhcChain.id);

const recorded = decodeErrorResult({ abi: accountAbi, data: sim.registerAgentRevertData as Hex });
const recordedMeasurement = (recorded.errorName === 'MeasurementNotApproved' ? recorded.args?.[0] : undefined) as Hex | undefined;

const CAST_NOT_AGENT = `RPC=${RPC}
ACCOUNT=${DEMO_ACCOUNT}
A=0x0000000000000000000000000000000000000000
cast call $ACCOUNT "execute(((address,address,uint24,int24,address),bool,uint128,uint128,uint64),(bytes32,bytes,bytes))" \\
  "(($A,$A,0,0,$A),true,1,1,1)" "($(printf '0x%064d' 0),0x,0x)" \\
  --from ${STRANGER} --rpc-url $RPC
# execution reverted, data: 0x0d9ab13f   (NotAgent())`;

const CAST_REGISTER = `RPC=${RPC}
ACCOUNT=${DEMO_ACCOUNT}
REF=$(( $(cast block-number --rpc-url $RPC) - 1 ))
NONCE=$(cast call $ACCOUNT "attestNonce(uint256)(bytes32)" $REF --rpc-url $RPC)
QUOTE=0x$(curl -s "https://inference.phala.com/v1/attestation/report?nonce=\${NONCE#0x}&signing_algo=ecdsa" | jq -r .intel_quote | sed 's/^0x//')
cast call $ACCOUNT "registerAgent(bytes,uint256)" $QUOTE $REF --rpc-url $RPC
# execution reverted, data: ${sim.registerAgentRevertData}
#   0x98085a9f = MeasurementNotApproved(bytes32), then the measurement`;

export function Refusals({ q }: { q: ReturnType<typeof useRefusals> }) {
  const live = q.data?.value;
  const block = q.data?.block;
  const notAgentOk = !!live && live.notAgent.reverted && live.notAgent.name === 'NotAgent';
  const agentLabel = !live ? 'reading' : live.agent === ZERO_ADDR ? 'no one yet' : short(live.agent);

  return (
    <section className="section" aria-labelledby="ref-h">
      <div className="section-head">
        <h2 id="ref-h" className="t-section">Refused on chain</h2>
        {block && <Stamp block={block} url={rhcExplorer.block} />}
      </div>
      <p className="section-intro">
        Two calls the account turns away. Both are <b>simulated calls</b> (<Code>eth_call</Code>): a node runs the call against
        chain state and returns the revert, and no transaction is sent. Each one shows the command that reproduces it.
      </p>

      {q.isError && (
        <div className="alarm" role="alert">
          <b>Could not read the chain.</b>
          <span>{String(q.error).slice(0, 180)}</span>
          <button className="textbtn" onClick={() => q.refetch()}>Read again</button>
        </div>
      )}
      {live && !notAgentOk && block && (
        <div className="alarm" role="alert">
          <b>{live.notAgent.reverted ? `The call reverted with ${live.notAgent.name ?? 'an undecoded error'}, not NotAgent.` : 'The call did not revert.'}</b>
          <span>The refusal below is not happening at block {block.toLocaleString('en-US')}.</span>
        </div>
      )}

      <div className="refusals">
        <figure className="board refusal" aria-busy={q.isPending}>
          <figcaption className="t-subject">
            A key with no attestation calls <Code>execute</Code>. Only the registered agent may.
          </figcaption>
          <div className={live ? 'face run' : 'face'}>
            <div className="doc sheet">
              <div className="doc-head">
                <span className="t-label">Caller</span>
                <span className="small">a key that was never attested, <HexValue value={STRANGER} head={6} tail={4} /></span>
              </div>
              <div className="doc-key">
                <span className="t-label key-label">Calls</span>
                <span className="t-diff">execute()</span>
              </div>
            </div>
            <div className={live ? 'connector' : 'connector whole'} aria-hidden="true">
              <span className="wire a" />
              <span className="cut" />
              <span className="wire b" />
              {live && <span className="cut-label">NotAgent()<br />simulated</span>}
            </div>
            <div className="doc sheet receipt">
              <div className="doc-head">
                <span className="t-label">Agent slot</span>
                <span className="small"><Code>agent()</Code> on the account, read live</span>
              </div>
              <div className="doc-key">
                <span className="t-label key-label">Admits only</span>
                <span className="t-diff">{agentLabel}</span>
              </div>
            </div>
          </div>
          <p className="small refusal-note">
            Re-run live every 15 s from this page{block && <> at block <a href={rhcExplorer.block(block)} target="_blank" rel="noreferrer">{block.toLocaleString('en-US')}</a></>}. The account&apos;s own owner gets the same <Code>NotAgent()</Code>, because the owner is never the agent.
          </p>
          <details className="bytes">
            <summary>Reproduce this call</summary>
            <pre>{CAST_NOT_AGENT}</pre>
          </details>
        </figure>

        <figure className="board refusal" aria-busy={q.isPending}>
          <figcaption className="t-subject">
            A genuine Phala TDX quote asks to become the agent. Its measurement is not on the owner&apos;s list.
          </figcaption>
          <div className={live ? 'face run' : 'face'}>
            <div className="doc sheet">
              <div className="doc-head">
                <span className="t-label">Phala gateway quote</span>
                <span className="small">a real Intel TDX quote, {sim.quoteBytes.toLocaleString('en-US')} bytes, bound to this account&apos;s <Code>attestNonce</Code></span>
              </div>
              <div className="doc-key">
                <span className="t-label key-label">Carries the measurement</span>
                <span className="t-diff" title={recordedMeasurement}>{recordedMeasurement ? `${recordedMeasurement.slice(0, 6)}…${recordedMeasurement.slice(-4)}` : 'unreadable'}</span>
              </div>
            </div>
            <div className="connector" aria-hidden="true">
              <span className="wire a" />
              <span className="cut" />
              <span className="wire b" />
              <span className="cut-label">Measurement<br />NotApproved()</span>
            </div>
            <div className="doc sheet receipt">
              <div className="doc-head">
                <span className="t-label">Approved measurements</span>
                <span className="small"><Code>approvedMeasurement()</Code> on the account, read live</span>
              </div>
              <div className="doc-key">
                <span className="t-label key-label">Owner has approved it</span>
                <span className="t-diff">{!live ? 'reading' : live.gatewayApproved ? 'yes' : 'no'}</span>
              </div>
            </div>
          </div>
          <p className="small refusal-note">
            Simulated at block <a href={rhcExplorer.block(BigInt(sim.block))} target="_blank" rel="noreferrer">{sim.block.toLocaleString('en-US')}</a> against a
            quote fetched for reference block {sim.refBlock.toLocaleString('en-US')}. The Stylus verifier accepted the quote and its nonce, and only the owner&apos;s
            list stopped it, so <Code>agent()</Code> stays empty. The same gateway&apos;s quote registers on Assay in
            transaction <HexValue value={GATEWAY_REGISTER_TX} head={6} tail={4} href={rhcExplorer.tx(GATEWAY_REGISTER_TX)} />, so the quote is genuine.
          </p>
          <details className="bytes">
            <summary>Reproduce this call</summary>
            <pre>{CAST_REGISTER}</pre>
          </details>
        </figure>
      </div>
    </section>
  );
}
