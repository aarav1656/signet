import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  hashMessage,
  isAddress,
  isHex,
  keccak256,
  parseSignature,
  parseUnits,
  recoverAddress,
  recoverTypedDataAddress,
  toHex,
  type Hex,
} from 'viem';
import { usePublicClient, useSignTypedData, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import { ASSAY, assayChain, explorer } from '../chain';
import { assayAbi } from '../abi/Assay.generated';
import { APPROVED_MEASUREMENTS, CHANNEL_TIMEOUT, USDG_ADDRESS } from '../lib/addresses.generated';
import { fmtCountdown, fmtStamp, fmtUsdg, short } from '../lib/format';
import { Code, HexValue, Num, Stamp, TitleBlock } from '../components/Stamp';
import { ChannelsSection } from './Overview';
import { useAtBlock } from '../hooks/useAtBlock';
import { useOnChain } from '../components/Wallet';

const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex;
const DEFAULT_MODEL_ID = 'meta-llama/llama-3.3-70b-instruct';

const erc20Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'nonces', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

const ERROR_HELP: Record<string, string> = {
  PayerNotAgent: 'payerSig failed: it does not recover to the channel agent.',
  SignerNotRegistered: 'enclaveSig failed: it recovers to an address with no registration.',
  MeasurementNotApproved: 'enclaveSig failed: the recovered signer is registered under a measurement off the allowlist.',
  AttestationExpired: 'enclaveSig failed: the recovered signer is registered but its attestation expired.',
  AmountNotIncreasing: 'Neither signature is at fault: cumulativeAmount must be above what was already paid.',
  AmountExceedsDeposit: 'Neither signature is at fault: cumulativeAmount is above the deposit.',
  MeasurementMismatch: 'enclaveSig failed: the recovered signer is registered under a different measurement than the one this channel was opened against.',
  TimeoutNotElapsed: 'Neither signature is at fault: the channel timeout has not elapsed since the last activity, so requestClose is not yet callable.',
  CloseAlreadyRequested: 'Close was already requested on this channel. Wait out the challenge window, then finalize.',
  CloseNotRequested: 'Neither signature is at fault: requestClose has not been called yet, so finalizeClose cannot run.',
  ChallengeWindowActive: 'Neither signature is at fault: the challenge window is still active. The provider may still redeem before finalizeClose.',
  ReceiptAlreadyConsumed: 'Neither signature is at fault: this provider and request/response pair was already paid on another channel.',
  QuoteAlreadyUsed: 'Neither signature is at fault: this exact quote was already submitted to register. Fetch a fresh quote with the current nonce.',
  ModelMismatch: 'This channel accepts only one redemption path: a model-pinned channel refuses the legacy signature-only redeem, and a legacy (unpinned) channel can never match redeemWithReceipt. Use the path this channel was opened for.',
  RequestHashMismatch: "redeemWithReceipt failed: the receipt's own request hash does not equal this voucher's requestHash. The provider must submit the receipt for the exact request this voucher pays for.",
  StaleRefBlock: "The refBlock used for a registration nonce fell outside Arbitrum's 256-block window (about 66 seconds). Read a fresh nextRegisterNonce and register immediately, or run the agent CLI (cd agent && npm run register), which does all three steps inside that window.",
  NotAgent: 'The caller is not the channel agent. Only the agent may call this.',
  NotProvider: 'The caller is not the channel provider. Only the provider address may call redeem.',
  ChannelClosedErr: 'The channel is closed.',
  BadParams: 'The channel does not exist (provider is zero) or a parameter is zero.',
  ECDSAInvalidSignature: 'A signature is malformed and recovery itself throws.',
  ECDSAInvalidSignatureLength: 'A signature is not 64 or 65 bytes long.',
  ECDSAInvalidSignatureS: 'A signature has an malleable s value outside the half order.',
  SafeERC20FailedOperation: 'Neither signature is at fault: the USDG transfer failed. Check balance and allowance.',
  TransferShort: 'Neither signature is at fault: the token transfer returned short.',
  ReentrancyGuardReentrantCall: 'Neither signature is at fault: a reentrant call was blocked.',
  InvalidShortString: 'Neither signature is at fault: an internal short string is invalid.',
  StringTooLong: 'Neither signature is at fault: an internal string exceeds its bound.',
  StringsInsufficientHexLength: 'Neither signature is at fault: a hex value is shorter than its target length.',
  NonceMismatch: 'The quote binds a stale nonce. Fetch a fresh report with the current nextRegisterNonce and retry.',
  DebugAttributeSet: 'The quote has the TDX DEBUG attribute bit set. Only production, non-debug quotes register.',
  SignatureInvalid: 'A signature inside the quote chain does not verify.',
  BadSigEncoding: 'A signature inside the quote chain is malformed.',
  BadPubkey: 'A certificate public key inside the quote chain is malformed.',
};

function asciiString(hex: string): string | null {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length === 0 || h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) return null;
  const bytes = h.match(/../g)!.map((b) => parseInt(b, 16));
  if (!bytes.every((b) => b >= 32 && b < 127)) return null;
  return String.fromCharCode(...bytes);
}

function errorNameFrom(e: unknown): string | null {
  const seen = new Set<unknown>();
  const stack: unknown[] = [e];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    const o = cur as Record<string, unknown>;
    if (typeof o.errorName === 'string') return o.errorName;
    if (typeof o.shortMessage === 'string') {
      const m = o.shortMessage.match(/^([A-Za-z_][A-Za-z0-9_]*)\(/);
      if (m && ERROR_HELP[m[1]]) return m[1];
    }
    if (typeof o.message === 'string') {
      for (const name of Object.keys(ERROR_HELP)) {
        if (o.message.includes(`${name}(`) || o.message.includes(`"${name}"`) || o.message.includes(` ${name} `)) return name;
      }
      const hexes = o.message.match(/0x[0-9a-fA-F]+/g) ?? [];
      for (const hx of hexes) {
        const decoded = asciiString(hx);
        if (decoded && ERROR_HELP[decoded]) return decoded;
        const sel = hx.slice(0, 10).toLowerCase();
        for (const name of Object.keys(ERROR_HELP)) {
          const computed = keccak256(toHex(`${name}()`)).slice(0, 10).toLowerCase();
          if (computed === sel) return name;
        }
      }
    }
    for (const v of Object.values(o)) {
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return null;
}

function validBytes32(s: string): s is Hex {
  return isHex(s) && s.length === 66;
}

function enclaveText(req: Hex, resp: Hex): string {
  return `${req.slice(2).toLowerCase()}:${resp.slice(2).toLowerCase()}`;
}

export function Channel() {
  const chain = useOnChain();
  const publicClient = usePublicClient();
  const { signTypedDataAsync } = useSignTypedData();
  const [params, setParams] = useSearchParams();
  const [channelId, setChannelIdState] = useState(() => (/^\d+$/.test(params.get('id') ?? '') ? (params.get('id') as string) : '0'));
  const setChannelId = (v: string) => {
    setChannelIdState(v);
    if (/^\d+$/.test(v.trim())) setParams({ id: v.trim() }, { replace: true });
  };
  useEffect(() => {
    document.title = `Chiron: channel ${channelId}`;
  }, [channelId]);
  const [provider, setProvider] = useState('');
  const [deposit, setDeposit] = useState('100');
  const [pinMode, setPinMode] = useState<'receipt' | 'legacy'>('receipt');
  const [modelId, setModelId] = useState(DEFAULT_MODEL_ID);
  const [actionError, setActionError] = useState('');
  const [permitBusy, setPermitBusy] = useState(false);

  const chanId = /^\d+$/.test(channelId.trim()) ? BigInt(channelId.trim()) : null;

  const snapshot = useAtBlock(
    ['assay-channel', channelId.trim()],
    async (c, block) => {
      if (chanId === null) throw new Error('bad-id');
      const raw = await c.readContract({ address: ASSAY, abi: assayAbi, functionName: 'channels', args: [chanId], blockNumber: block });
      const [agent, provider, deposit, paid, openedAt, lastActivityAt, closeRequestedAt, closed, measurement, requestedModelHash] = raw as unknown as readonly [
        string, string, bigint, bigint, bigint, bigint, bigint, boolean, string, string,
      ];
      const ch = { agent, provider, deposit, paid, openedAt, lastActivityAt, closeRequestedAt, closed, measurement, requestedModelHash };
      const timeout = await c.readContract({ address: ASSAY, abi: assayAbi, functionName: 'channelTimeout', blockNumber: block });
      const challenge = await c.readContract({ address: ASSAY, abi: assayAbi, functionName: 'challengeWindow', blockNumber: block });
      return { ch, timeout: timeout as bigint, challenge: challenge as bigint };
    },
    chanId !== null,
  );

  // Model-swap-refusal display: every RedeemedWithReceipt this channel has ever emitted, each
  // one already proof-checked onchain (redeemWithReceipt reverts ModelMismatch before emitting,
  // see contracts/src/Assay.sol), so requested always equals served by the time it lands here --
  // this reads that proof back, it does not perform it. `getLogs` over the whole chain can hit a
  // public RPC's block-range cap; a failure here degrades to "no receipt redemptions read" rather
  // than breaking the channel-state read above, which is a separate query.
  const receiptRedeems = useAtBlock(
    ['assay-redeemed-with-receipt', channelId.trim()],
    async (c, block) => {
      if (chanId === null) throw new Error('bad-id');
      try {
        const logs = await c.getContractEvents({
          address: ASSAY,
          abi: assayAbi,
          eventName: 'RedeemedWithReceipt',
          args: { channelId: chanId },
          fromBlock: 'earliest',
          toBlock: block,
        });
        return logs;
      } catch {
        return [];
      }
    },
    chanId !== null,
  );

  const funds = useAtBlock(
    ['usdg-funds', chain.address ?? 'none'],
    async (c, block) => {
      if (!chain.address) throw new Error('no-wallet');
      const bal = await c.readContract({ address: USDG_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [chain.address], blockNumber: block });
      const allow = await c.readContract({ address: USDG_ADDRESS, abi: erc20Abi, functionName: 'allowance', args: [chain.address, ASSAY], blockNumber: block });
      return { bal: bal as bigint, allow: allow as bigint };
    },
    !!chain.address && chain.ready,
  );

  const channelCountSnap = useAtBlock(
    ['assay-channel-count'],
    async (c, block) => (await c.readContract({ address: ASSAY, abi: assayAbi, functionName: 'channelCount', blockNumber: block })) as bigint,
    true,
  );

  const { writeContractAsync, data: txHash, isPending: writing } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: txHash });

  async function run(label: string, fn: () => Promise<unknown>) {
    setActionError('');
    try {
      await fn();
      snapshot.refetch();
      funds.refetch();
    } catch (e) {
      const name = errorNameFrom(e);
      setActionError(
        name && ERROR_HELP[name]
          ? `${label} failed: ${name}. ${ERROR_HELP[name]}`
          : `${label} failed: ${e instanceof Error ? e.message.slice(0, 400) : String(e).slice(0, 400)}`,
      );
    }
  }

  async function openWithPermit() {
    const owner = chain.address;
    if (!publicClient || !owner || amountWei === null || !isAddress(provider)) return;
    setPermitBusy(true);
    await run('Open with permit', async () => {
      const nonce = (await publicClient.readContract({
        address: USDG_ADDRESS,
        abi: erc20Abi,
        functionName: 'nonces',
        args: [owner],
      })) as bigint;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const sig = await signTypedDataAsync({
        domain: { name: 'Global Dollar', version: '1', chainId: assayChain.id, verifyingContract: USDG_ADDRESS },
        types: {
          Permit: [
            { name: 'owner', type: 'address' },
            { name: 'spender', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'nonce', type: 'uint256' },
            { name: 'deadline', type: 'uint256' },
          ],
        },
        primaryType: 'Permit',
        message: { owner, spender: ASSAY, value: amountWei, nonce, deadline },
      });
      const { v, r, s: sSig } = parseSignature(sig);
      return writeContractAsync({
        address: ASSAY,
        abi: assayAbi,
        functionName: 'openChannelWithPermit',
        args: [provider as Hex, amountWei, APPROVED_MEASUREMENTS[0], requestedModelHash, deadline, Number(v), r, sSig],
      });
    });
    setPermitBusy(false);
  }

  const MAX_UINT128 = (1n << 128n) - 1n;
  const amountWei = (() => {
    try {
      return parseUnits(deposit.trim() || '0', 6);
    } catch {
      return null;
    }
  })();
  const amountOk = amountWei !== null && amountWei > 0n && amountWei <= MAX_UINT128;

  const modelIdTrimmed = modelId.trim();
  const requestedModelHash = pinMode === 'receipt' && modelIdTrimmed ? keccak256(toHex(modelIdTrimmed)) : ZERO_HASH;
  const modelChoiceOk = pinMode === 'legacy' || modelIdTrimmed.length > 0;

  const ch = snapshot.data?.value.ch;
  const exists = !!ch && ch.provider !== '0x0000000000000000000000000000000000000000';
  const lastActivity = ch ? (ch.lastActivityAt !== 0n ? ch.lastActivityAt : ch.openedAt) : 0n;
  const deadline = ch ? Number(lastActivity) + Number(snapshot.data?.value.timeout ?? BigInt(CHANNEL_TIMEOUT)) : 0;
  const challengeSecs = snapshot.data ? Number(snapshot.data.value.challenge) : 0;
  const finalizeAt = ch && ch.closeRequestedAt !== 0n ? Number(ch.closeRequestedAt) + challengeSecs : 0;
  const selfTest = !!ch && ch.agent.toLowerCase() === ch.provider.toLowerCase();
  const timedOut = !!ch && !ch.closed && snapshot.data !== undefined && Number(snapshot.data.timestamp) > deadline;

  const legacyCh = !!ch && ch.requestedModelHash === ZERO_HASH;
  const pinnedName = ch && !legacyCh && ch.requestedModelHash.toLowerCase() === keccak256(toHex(DEFAULT_MODEL_ID)).toLowerCase() ? DEFAULT_MODEL_ID : null;

  return (
    <main>
      <TitleBlock
        cells={[
          { label: 'Channel', value: chanId === null ? 'not a channel id' : channelId.trim(), lead: true },
          { label: 'Path', value: snapshot.data && exists ? (legacyCh ? 'legacy signature' : 'receipt-only') : '--' },
          {
            label: 'Read at',
            value: snapshot.data ? <>block <a href={explorer.block(snapshot.data.block)} target="_blank" rel="noreferrer">{snapshot.data.block.toLocaleString('en-US')}</a></> : 'reading',
          },
        ]}
      />

      <header className="pagehead">
        <h1 className="t-title">Lock USDG for one model, then pay per call</h1>
        <p className="gloss" style={{ maxWidth: '84ch', marginBottom: 0 }}>
          <b>Channel:</b> USDG an agent locks with one provider, who draws from it call by call. <b>Pinned model:</b>{' '}
          the one model the channel pays for; every receipt is compared against it, and a receipt naming another model
          is refused.
        </p>
        <div className="actions">
          <a className="btn" href="#c-open">Open a new channel</a>
        </div>
      </header>

      <section aria-labelledby="c-lookup">
        <div className="picker" role="group" aria-label="Choose a channel">
          <span className="t-label" id="c-lookup">Showing channel</span>
          {channelCountSnap.data &&
            Array.from({ length: Number(channelCountSnap.data.value) }, (_, i) => String(i)).map((id) => (
              <button key={id} type="button" aria-pressed={id === channelId.trim()} onClick={() => setChannelId(id)}>
                {id}
              </button>
            ))}
          <label className="sr-only" htmlFor="c-id">Channel id</label>
          <input
            id="c-id"
            value={channelCountSnap.data && /^\d+$/.test(channelId.trim()) && BigInt(channelId.trim()) < channelCountSnap.data.value ? '' : channelId}
            onChange={(e) => setChannelId(e.target.value)}
            inputMode="numeric"
            placeholder="other id"
            aria-describedby="c-id-hint"
          />
          <span className="small" id="c-id-hint">
            {channelCountSnap.data
              ? `${channelCountSnap.data.value.toString()} ${channelCountSnap.data.value === 1n ? 'channel' : 'channels'} on this contract`
              : 'counting channels'}
          </span>
        </div>
        {snapshot.isPending && <p className="section-intro small" aria-busy="true">Reading channel {channelId}.</p>}
        {snapshot.isError && snapshot.error.message !== 'bad-id' && (
          <div className="alarm" role="alert" style={{ marginTop: 16 }}><b>Could not read this channel.</b> <span>{String(snapshot.error).slice(0, 200)}</span></div>
        )}
        {snapshot.data && !exists && (
          <p className="section-intro">
            No channel was ever opened under id {channelId}: its provider slot is still the zero address. Pick an id
            above, or open one below.
          </p>
        )}
        {snapshot.data && exists && ch && (
          <>
            {selfTest && <p className="section-intro note warn">Self-test channel: the agent and the provider are the same wallet, {short(ch.agent)}.</p>}
            <div className="board" style={{ marginTop: 12 }}>
              <div className="doc single">
                <div className="doc-head">
                  <span className="t-label">Channel {channelId.trim()}</span>
                  <span className="small">live, read from the contract at the block in the title bar</span>
                </div>
                <div className="doc-key">
                  <span className="t-label">{legacyCh ? 'Pins no model' : 'Pays only for'}</span>
                  {legacyCh ? (
                    <span className="small">
                      Its model hash is zero, so a receipt can never match it; only the older signature-only path can pay it.
                    </span>
                  ) : (
                    <span className="t-diff">{pinnedName ?? 'an unrecognised model id'}</span>
                  )}
                </div>
                <div className="drow"><span className="t-label">Left to pay</span><span className="v">{fmtUsdg(ch.deposit - ch.paid)} of {fmtUsdg(ch.deposit)} USDG</span></div>
                <div className="drow"><span className="t-label">State</span><span className="v">{ch.closed ? 'closed' : timedOut ? 'open; idle long enough that the agent may close it' : 'open'}</span></div>
              </div>
            </div>
            <details className="more">
              <summary>Clock, addresses, the model hash and the enclave fingerprint</summary>
              <dl className="kvs">
                <dt>Paid so far</dt>
                <dd>{fmtUsdg(ch.paid)} USDG</dd>
                <dt>Last activity</dt>
                <dd>{fmtStamp(lastActivity)}</dd>
                <dt>Close opens</dt>
                <dd>{fmtStamp(BigInt(deadline))}, {fmtCountdown(deadline - Number(snapshot.data.timestamp))}</dd>
                <dt>Close requested</dt>
                <dd>
                  {ch.closeRequestedAt !== 0n
                    ? `${fmtStamp(ch.closeRequestedAt)}; finalize after ${fmtStamp(BigInt(finalizeAt))}, ${ch.closed ? 'finalized' : fmtCountdown(finalizeAt - Number(snapshot.data.timestamp))}`
                    : 'not requested'}
                </dd>
                <dt>Agent</dt>
                <dd><HexValue value={ch.agent} href={explorer.address(ch.agent)} /> <span className="small">signs vouchers, may close</span></dd>
                <dt>Provider</dt>
                <dd><HexValue value={ch.provider} href={explorer.address(ch.provider)} /> <span className="small">the only address that may redeem</span></dd>
                <dt>Model hash</dt>
                <dd>{legacyCh ? 'zero: no model pinned' : <><HexValue value={ch.requestedModelHash} /> <span className="small">keccak256 of the model id, read from <Code>{`channels(${channelId.trim()})`}</Code></span></>}</dd>
                <dt>Measurement</dt>
                <dd>
                  <HexValue value={ch.measurement} />{' '}
                  <span className="small">
                    the enclave fingerprint this channel accepts;{' '}
                    {APPROVED_MEASUREMENTS.some((m) => m.toLowerCase() === ch.measurement.toLowerCase()) ? 'on the allowlist' : 'not on the allowlist'}
                  </span>
                </dd>
                <dt>Contract</dt>
                <dd><HexValue value={ASSAY} href={explorer.address(ASSAY)} /> <span className="small">Assay</span></dd>
              </dl>
            </details>
            {!legacyCh && (
              <div className="section">
                <div className="section-head"><h2 className="t-section">Paid through receipts</h2></div>
                <p className="section-intro">
                  Each row is a <Code>RedeemedWithReceipt</Code> event. <Code>redeemWithReceipt</Code> reverts{' '}
                  <Code>ModelMismatch()</Code> before it can emit one whose served model differs from the pinned model, so
                  this list reads back payments that already passed the check. The live refusal is on the Refusal page.
                </p>
                {receiptRedeems.isPending && <p className="small" aria-busy="true">Reading receipt redemptions.</p>}
                {receiptRedeems.data && receiptRedeems.data.value.length === 0 && (
                  <p className="note">No redeemWithReceipt payment on this channel yet: paid is {fmtUsdg(ch.paid)} USDG.</p>
                )}
                {receiptRedeems.data && receiptRedeems.data.value.length > 0 && (
                  <table className="ledger">
                    <thead>
                      <tr><th>Block</th><th>Requested model</th><th>Served model</th><th>Paid</th><th>Match</th></tr>
                    </thead>
                    <tbody>
                      {receiptRedeems.data.value.map((log) => {
                        const args = log.args as { requestedModelHash?: string; servedModelHash?: string; paidNow?: bigint };
                        const match = args.requestedModelHash === args.servedModelHash;
                        return (
                          <tr key={`${log.transactionHash}-${log.logIndex}`}>
                            <td>{log.blockNumber?.toLocaleString('en-US')}</td>
                            <td>{args.requestedModelHash ? <HexValue value={args.requestedModelHash} /> : '--'}</td>
                            <td>{args.servedModelHash ? <HexValue value={args.servedModelHash} /> : '--'}</td>
                            <td>{args.paidNow !== undefined ? `${fmtUsdg(args.paidNow)} USDG` : '--'}</td>
                            <td className={match ? undefined : 'signal'}>{match ? 'match' : 'mismatch, which should be impossible'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </>
        )}
      </section>

      <ChannelsSection />

      <section className="section" aria-labelledby="c-open">
        <div className="section-head">
          <h2 id="c-open" className="t-section">Open a channel</h2>
          {funds.data && <Stamp block={funds.data.block} />}
        </div>
        <p className="section-intro">
          Real USDG, no test faucet in this app. Approve then open in two calls, or sign one EIP-2612 permit and open
          in a single transaction with <Code>openChannelWithPermit</Code>.
        </p>
        {!chain.ready && <p className="note warn">{chain.reason}</p>}
        {funds.data && (
          <p className="note">
            Wallet balance {fmtUsdg(funds.data.value.bal)} USDG. Allowance to Assay {fmtUsdg(funds.data.value.allow)} USDG.
          </p>
        )}
        <div className="fields" style={{ marginTop: 16 }}>
          <div className="field">
            <span className="label" id="c-path-l">Payment path</span>
            <div className="choice" role="radiogroup" aria-labelledby="c-path-l">
              <button type="button" role="radio" aria-checked={pinMode === 'receipt'} onClick={() => setPinMode('receipt')}>
                <span className="dot" />
                <span>Receipt-only, pinned to a model</span>
                <small>Only redeemWithReceipt can pay this channel. A gateway receipt whose served model differs from the pinned model is refused.</small>
              </button>
              <button type="button" role="radio" aria-checked={pinMode === 'legacy'} onClick={() => setPinMode('legacy')}>
                <span className="dot" />
                <span>Legacy signature only</span>
                <small>Only the legacy redeem() ECDSA enclave signature can pay this channel. redeemWithReceipt can never match a zero model hash.</small>
              </button>
            </div>
          </div>
          {pinMode === 'receipt' && (
            <div className="field">
              <label className="label" htmlFor="c-model">Model id</label>
              <input id="c-model" value={modelId} onChange={(e) => setModelId(e.target.value)} spellCheck={false} aria-invalid={!modelChoiceOk || undefined} />
              <span className="hint">Pinned as keccak256 of the UTF-8 model id: <span className="hex" title={requestedModelHash}>{requestedModelHash.slice(0, 10)}…{requestedModelHash.slice(-8)}</span></span>
            </div>
          )}
          <div className="field">
            <label className="label" htmlFor="c-provider">Provider address</label>
            <input id="c-provider" className="hexin" value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="0x…" spellCheck={false} />
            <span className="hint">The address allowed to call redeem on this channel.</span>
          </div>
          <div className="field">
            <label className="label" htmlFor="c-deposit">Deposit, USDG</label>
            <input id="c-deposit" value={deposit} onChange={(e) => setDeposit(e.target.value)} inputMode="decimal" aria-invalid={!amountOk || undefined} />
            <span className="hint">Whole USDG; 6 decimals are applied for you.</span>
          </div>
        </div>
        <div className="actions" style={{ marginTop: 20 }}>
          <button className="btn line" type="button" disabled={!chain.ready || writing || !amountOk}
            onClick={() => run('Approve', () => writeContractAsync({ address: USDG_ADDRESS, abi: erc20Abi, functionName: 'approve', args: [ASSAY, amountWei as bigint] }))}>
            Approve
          </button>
          <button className="btn" type="button" disabled={!chain.ready || writing || !isAddress(provider) || !amountOk || !modelChoiceOk}
            onClick={() => run('Open channel', () => writeContractAsync({ address: ASSAY, abi: assayAbi, functionName: 'openChannel', args: [provider as Hex, amountWei as bigint, APPROVED_MEASUREMENTS[0], requestedModelHash] }))}>
            Open channel with {amountOk ? deposit.trim() : '?'} USDG
          </button>
          <button className="btn line" type="button" disabled={!chain.ready || writing || permitBusy || !isAddress(provider) || !amountOk || !modelChoiceOk}
            onClick={openWithPermit}>
            {permitBusy ? 'Signing permit' : 'Open with one signature (permit)'}
          </button>
        </div>
        {!modelChoiceOk && <p className="note warn" role="alert" style={{ marginTop: 12 }}>Enter a model id, or switch to legacy signature only.</p>}
        {amountWei !== null && funds.data && amountWei > funds.data.value.allow && (
          <p className="note" style={{ marginTop: 12 }}>The allowance is below this deposit; approve first, or open with the permit.</p>
        )}
      </section>

      <section className="section" aria-labelledby="c-pay">
        <div className="section-head">
          <h2 id="c-pay" className="t-section">Pay for a call, then close</h2>
        </div>
        <ol className="steps" style={{ marginTop: 16 }}>
          <VoucherPanel agent={exists && ch ? ch.agent : undefined} channelIdDefault={channelId} />
          <RedeemPanel channelIdDefault={channelId} agent={exists && ch ? ch.agent : undefined} />
          <li className="step" aria-labelledby="c-close">
            <Num n={3} mark="plain" />
            <div className="step-body">
              <h3 id="c-close" className="t-section">Close the channel</h3>
              <p className="prose">
                Two calls, both from the agent. <Code>requestClose</Code> starts the challenge window once the timeout has
                passed since the last redeem, or since opening if never redeemed. <Code>finalizeClose</Code> refunds the
                unredeemed balance after the challenge window
                ({snapshot.data ? challengeSecs.toLocaleString('en-US') : '…'} seconds). The provider may still redeem a
                pending voucher any time before finalize.
              </p>
              {snapshot.data && exists && ch && (
                <p className="note" role="status">
                  {ch.closed
                    ? `Channel ${channelId} is finalized and closed.`
                    : ch.closeRequestedAt !== 0n
                      ? `The challenge window ends ${fmtStamp(BigInt(finalizeAt))}, ${fmtCountdown(finalizeAt - Number(snapshot.data.timestamp))}.`
                      : `requestClose opens ${fmtStamp(BigInt(deadline))}, ${fmtCountdown(deadline - Number(snapshot.data.timestamp))}.`}
                </p>
              )}
              <div className="actions">
                <button className="btn line" type="button" disabled={!chain.ready || writing || chanId === null}
                  onClick={() => run('Request close', () => writeContractAsync({ address: ASSAY, abi: assayAbi, functionName: 'requestClose', args: [chanId as bigint] }))}>
                  Request close
                </button>
                <button className="btn line" type="button" disabled={!chain.ready || writing || chanId === null}
                  onClick={() => run('Finalize close', () => writeContractAsync({ address: ASSAY, abi: assayAbi, functionName: 'finalizeClose', args: [chanId as bigint] }))}>
                  Finalize close
                </button>
              </div>
            </div>
          </li>
        </ol>
      </section>

      {(txHash || actionError || receipt.isSuccess) && (
        <section className="section" aria-labelledby="c-tx">
          <div className="section-head">
            <h2 id="c-tx" className="t-section">Last transaction</h2>
          </div>
          {txHash && (
            <div className="result">
              <span className="rl">Transaction</span>
              <span className="rv"><HexValue value={txHash} head={10} tail={8} href={explorer.tx(txHash)} /> {receipt.isSuccess ? 'mined' : receipt.isError ? 'reverted onchain' : 'pending'}</span>
            </div>
          )}
          {actionError && (
            <div className="result bad" role="alert">
              <span className="rl">Refused</span>
              <span className="rv">{actionError}</span>
            </div>
          )}
        </section>
      )}
    </main>
  );
}

function VoucherPanel({ agent, channelIdDefault }: { agent?: string; channelIdDefault: string }) {
  const chain = useOnChain();
  const [cid, setCid] = useState(channelIdDefault);
  const [cumulative, setCumulative] = useState('');
  const [req, setReq] = useState('');
  const [resp, setResp] = useState('');
  const [localCheck, setLocalCheck] = useState('');
  const { signTypedDataAsync, isPending } = useSignTypedData();
  const [payerSig, setPayerSig] = useState('');

  const valid =
    /^\d+$/.test(cid.trim()) && /^\d+$/.test(cumulative.trim()) && validBytes32(req.trim() as string) && validBytes32(resp.trim() as string);

  async function sign() {
    setLocalCheck('');
    setPayerSig('');
    try {
      const sig = await signTypedDataAsync({
        domain: { name: 'Assay', version: '1', chainId: assayChain.id, verifyingContract: ASSAY },
        types: {
          Voucher: [
            { name: 'channelId', type: 'uint256' },
            { name: 'cumulativeAmount', type: 'uint256' },
            { name: 'requestHash', type: 'bytes32' },
            { name: 'responseHash', type: 'bytes32' },
          ],
        },
        primaryType: 'Voucher',
        message: {
          channelId: BigInt(cid.trim()),
          cumulativeAmount: BigInt(cumulative.trim()),
          requestHash: req.trim() as Hex,
          responseHash: resp.trim() as Hex,
        },
      });
      setPayerSig(sig);
      const recovered = await recoverTypedDataAddress({
        domain: { name: 'Assay', version: '1', chainId: assayChain.id, verifyingContract: ASSAY },
        types: {
          Voucher: [
            { name: 'channelId', type: 'uint256' },
            { name: 'cumulativeAmount', type: 'uint256' },
            { name: 'requestHash', type: 'bytes32' },
            { name: 'responseHash', type: 'bytes32' },
          ],
        },
        primaryType: 'Voucher',
        message: {
          channelId: BigInt(cid.trim()),
          cumulativeAmount: BigInt(cumulative.trim()),
          requestHash: req.trim() as Hex,
          responseHash: resp.trim() as Hex,
        },
        signature: sig,
      });
      setLocalCheck(
        agent && recovered.toLowerCase() === agent.toLowerCase()
          ? `Recovered ${recovered}: matches the channel agent. This payerSig passes the agent check.`
          : agent
            ? `Recovered ${recovered}: does NOT match the channel agent ${agent}. redeem would revert PayerNotAgent().`
            : `Recovered ${recovered}. Connect the channel state above to compare against its agent.`,
      );
    } catch (e) {
      setLocalCheck(`Signing failed: ${e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300)}`);
    }
  }

  return (
    <li className="step" aria-labelledby="c-voucher">
      <Num n={1} mark="plain" />
      <div className="step-body">
        <h3 id="c-voucher" className="t-section">Sign the agent voucher</h3>
        <p className="prose">
          The connected wallet signs an EIP-712 <Code>Voucher</Code> (Assay, version 1, this chain, this contract). Sign
          with the channel&apos;s agent key; anyone else&apos;s signature fails the payer check.
        </p>
        {!chain.ready && <p className="note warn">{chain.reason}</p>}
        <div className="fields">
          <div className="field">
            <label className="label" htmlFor="v-cid">Channel id</label>
            <input id="v-cid" value={cid} onChange={(e) => setCid(e.target.value)} inputMode="numeric" />
          </div>
          <div className="field">
            <label className="label" htmlFor="v-cum">Cumulative amount, base units</label>
            <input id="v-cum" value={cumulative} onChange={(e) => setCumulative(e.target.value)} inputMode="numeric" placeholder="50000000 is 50.00 USDG" />
            <span className="hint">Must be above what the channel has paid and at most its deposit.</span>
          </div>
          <div className="field">
            <label className="label" htmlFor="v-req">Request hash, bytes32</label>
            <input id="v-req" className="hexin" value={req} onChange={(e) => setReq(e.target.value)} placeholder="0x…" spellCheck={false} />
          </div>
          <div className="field">
            <label className="label" htmlFor="v-resp">Response hash, bytes32</label>
            <input id="v-resp" className="hexin" value={resp} onChange={(e) => setResp(e.target.value)} placeholder="0x…" spellCheck={false} />
            <span className="hint">Must differ from the channel&apos;s last redeemed response hash.</span>
          </div>
        </div>
        <div className="actions">
          <button className="btn" type="button" disabled={!chain.ready || !valid || isPending} onClick={sign}>
            {isPending ? 'Signing' : 'Sign voucher'}
          </button>
        </div>
        {payerSig && (
          <div className="field">
            <label className="label" htmlFor="v-sig">Signature (payerSig)</label>
            <input id="v-sig" className="hexin" value={payerSig} readOnly spellCheck={false} />
            <span className="hint">Paste this into step 2.</span>
          </div>
        )}
        {localCheck && (
          <div className="result">
            <span className="rl">Checked</span>
            <span className="rv">{localCheck}</span>
          </div>
        )}
      </div>
    </li>
  );
}

function RedeemPanel({ channelIdDefault, agent }: { channelIdDefault: string; agent?: string }) {
  const chain = useOnChain();
  const publicClient = usePublicClient();
  const { writeContractAsync, isPending } = useWriteContract();
  const [cid, setCid] = useState(channelIdDefault);
  const [cumulative, setCumulative] = useState('');
  const [req, setReq] = useState('');
  const [resp, setResp] = useState('');
  const [payerSig, setPayerSig] = useState('');
  const [enclaveSig, setEnclaveSig] = useState('');
  const [report, setReport] = useState('');
  const [reportBad, setReportBad] = useState(false);
  const [busy, setBusy] = useState(false);

  const pinCheckId = /^\d+$/.test(cid.trim()) ? BigInt(cid.trim()) : null;
  const pinCheck = useAtBlock(
    ['assay-redeem-pin-check', cid.trim()],
    async (c, block) => {
      if (pinCheckId === null) throw new Error('bad-id');
      const raw = await c.readContract({ address: ASSAY, abi: assayAbi, functionName: 'channels', args: [pinCheckId], blockNumber: block });
      const [, chProvider, , , , , , , , chRequestedModelHash] = raw as unknown as readonly [
        string, string, bigint, bigint, bigint, bigint, bigint, boolean, string, string,
      ];
      return { provider: chProvider, requestedModelHash: chRequestedModelHash };
    },
    pinCheckId !== null,
  );
  const pinExists = pinCheck.data && pinCheck.data.value.provider !== '0x0000000000000000000000000000000000000000';
  const pinnedChannel = pinExists ? pinCheck.data!.value.requestedModelHash !== ZERO_HASH : undefined;

  async function diagnose() {
    setReport('');
    setReportBad(false);
    if (!publicClient) {
      setReport('No chain client. Connect a wallet first.');
      setReportBad(true);
      return;
    }
    if (!/^\d+$/.test(cid.trim()) || !/^\d+$/.test(cumulative.trim()) || !validBytes32(req.trim() as string) || !validBytes32(resp.trim() as string)) {
      setReport('Fill every field first: numeric channel id and cumulative amount, 0x-prefixed 32-byte hashes.');
      setReportBad(true);
      return;
    }
    if (!isHex(payerSig.trim()) || !isHex(enclaveSig.trim())) {
      setReport('Both signatures must be 0x-prefixed hex.');
      setReportBad(true);
      return;
    }
    setBusy(true);
    try {
      const lines: string[] = [];
      const channelId = BigInt(cid.trim());
      const chRaw = await publicClient.readContract({ address: ASSAY, abi: assayAbi, functionName: 'channels', args: [channelId] });
      const [chAgent, chProvider, chDeposit, chPaid, , , chCloseRequestedAt, chClosed, chMeasurement, chRequestedModelHash] = chRaw as unknown as readonly [
        string, string, bigint, bigint, bigint, bigint, bigint, boolean, string, string,
      ];
      const ch = {
        agent: chAgent,
        provider: chProvider,
        deposit: chDeposit,
        paid: chPaid,
        closeRequestedAt: chCloseRequestedAt,
        closed: chClosed,
        measurement: chMeasurement,
        requestedModelHash: chRequestedModelHash,
      };
      if (ch.provider === '0x0000000000000000000000000000000000000000') {
        setReport('BadParams: this channel id was never opened.');
        setReportBad(true);
        return;
      }
      if (ch.requestedModelHash !== ZERO_HASH) {
        lines.push('Channel is model-pinned: redeem() reverts ModelMismatch() before checking either signature. Only redeemWithReceipt can pay this channel.');
      }
      const cum = BigInt(cumulative.trim());
      const reqH = req.trim() as Hex;
      const respH = resp.trim() as Hex;

      let payerAddr = '';
      try {
        payerAddr = await recoverTypedDataAddress({
          domain: { name: 'Assay', version: '1', chainId: assayChain.id, verifyingContract: ASSAY },
          types: {
            Voucher: [
              { name: 'channelId', type: 'uint256' },
              { name: 'cumulativeAmount', type: 'uint256' },
              { name: 'requestHash', type: 'bytes32' },
              { name: 'responseHash', type: 'bytes32' },
            ],
          },
          primaryType: 'Voucher',
          message: { channelId, cumulativeAmount: cum, requestHash: reqH, responseHash: respH },
          signature: payerSig.trim() as Hex,
        });
        lines.push(payerAddr.toLowerCase() === ch.agent.toLowerCase()
          ? `payerSig recovers to ${payerAddr}: matches the channel agent. Payer check passes.`
          : `payerSig recovers to ${payerAddr}: NOT the channel agent ${ch.agent}. redeem reverts PayerNotAgent().`);
      } catch {
        lines.push('payerSig is malformed: recovery itself throws (ECDSAInvalidSignature).');
      }

      let enclaveAddr = '';
      try {
        const digest = hashMessage(enclaveText(reqH, respH));
        enclaveAddr = await recoverAddress({ hash: digest, signature: enclaveSig.trim() as Hex });
        const sRaw = await publicClient.readContract({ address: ASSAY, abi: assayAbi, functionName: 'signers', args: [enclaveAddr as Hex] });
        const [sMeasurement, sExpiry] = sRaw as unknown as readonly [string, bigint];
        const s = { measurement: sMeasurement, expiry: sExpiry };
        const now = BigInt(Math.floor(Date.now() / 1000));
        if (s.measurement === '0x0000000000000000000000000000000000000000000000000000000000000000') {
          lines.push(`enclaveSig recovers to ${enclaveAddr}: never registered. redeem reverts SignerNotRegistered().`);
        } else if (s.measurement.toLowerCase() !== ch.measurement.toLowerCase()) {
          lines.push(`enclaveSig recovers to ${enclaveAddr}: registered under measurement ${s.measurement}, but this channel was opened against ${ch.measurement}. redeem reverts MeasurementMismatch().`);
        } else if (now > s.expiry) {
          lines.push(`enclaveSig recovers to ${enclaveAddr}: registered but expired at ${fmtStamp(s.expiry)}. redeem reverts AttestationExpired().`);
        } else {
          lines.push(`enclaveSig recovers to ${enclaveAddr}: registered, matches this channel's pinned measurement, unexpired. Enclave check passes.`);
        }
      } catch {
        lines.push('enclaveSig is malformed: recovery itself throws (ECDSAInvalidSignature).');
      }

      if (ch.closed) lines.push('Channel is closed: redeem reverts ChannelClosedErr() before either signature is checked.');
      else if (ch.closeRequestedAt !== 0n) lines.push('Close was requested but finalize has not run: redeem still succeeds inside the challenge window.');
      if (cum <= ch.paid) lines.push(`Cumulative ${cum.toString()} is not above paid ${ch.paid.toString()}: redeem reverts AmountNotIncreasing().`);
      if (cum > ch.deposit) lines.push(`Cumulative ${cum.toString()} is above the deposit ${ch.deposit.toString()}: redeem reverts AmountExceedsDeposit().`);

      const wouldFail = lines.some((l) => l.includes('revert'));
      setReportBad(wouldFail);
      setReport(lines.join(' '));
    } finally {
      setBusy(false);
    }
  }

  async function simulate() {
    setReport('');
    setReportBad(false);
    if (!publicClient || !chain.address) {
      setReport('Connect a wallet to simulate.');
      setReportBad(true);
      return;
    }
    setBusy(true);
    try {
      await publicClient.simulateContract({
        address: ASSAY,
        abi: assayAbi,
        functionName: 'redeem',
        args: [BigInt(cid.trim()), BigInt(cumulative.trim()), req.trim() as Hex, resp.trim() as Hex, payerSig.trim() as Hex, enclaveSig.trim() as Hex],
        account: chain.address,
      });
      setReport('Simulation passed from the connected account: the call would not revert.');
    } catch (e) {
      const name = errorNameFrom(e);
      setReportBad(true);
      setReport(name && ERROR_HELP[name]
        ? `Simulation reverts with ${name}(). ${ERROR_HELP[name]}`
        : `Simulation reverts: ${e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500)}`);
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    setReport('');
    setReportBad(false);
    try {
      const h = await writeContractAsync({
        address: ASSAY,
        abi: assayAbi,
        functionName: 'redeem',
        args: [BigInt(cid.trim()), BigInt(cumulative.trim()), req.trim() as Hex, resp.trim() as Hex, payerSig.trim() as Hex, enclaveSig.trim() as Hex],
      });
      setReport(`Submitted: ${h}. Only the provider ${agent ?? ''} can succeed; anyone else reverts NotProvider().`);
    } catch (e) {
      const name = errorNameFrom(e);
      setReportBad(true);
      setReport(name && ERROR_HELP[name]
        ? `Rejected with ${name}(). ${ERROR_HELP[name]}`
        : `Rejected: ${e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500)}`);
    }
  }

  return (
    <li className="step" aria-labelledby="c-redeem">
      <Num n={2} mark="plain" />
      <div className="step-body">
        <h3 id="c-redeem" className="t-section">Redeem with both signatures</h3>
        <p className="prose">
          Diagnose recovers each signature locally and names the one that fails. Simulate runs the exact call against
          the chain without sending it. Send submits from the connected wallet, which must be the provider. This form
          builds the legacy <Code>redeem()</Code> call only.
        </p>
        {pinExists && (
          <p className={pinnedChannel ? 'note warn' : 'note'} role={pinnedChannel ? 'alert' : 'status'}>
            {pinnedChannel
              ? 'This channel is model-pinned: it accepts redeemWithReceipt only, with a gateway-signed receipt. The contract refuses a model-blind payment on a pinned channel, so redeem() below always reverts ModelMismatch. Send is disabled.'
              : 'This channel is legacy-only: it accepts redeem() with an ECDSA enclave signature, and can never be paid through redeemWithReceipt.'}{' '}
            {pinCheck.data && <Stamp block={pinCheck.data.block} />}
          </p>
        )}
        <div className="fields">
          <div className="field">
            <label className="label" htmlFor="r-cid">Channel id</label>
            <input id="r-cid" value={cid} onChange={(e) => setCid(e.target.value)} inputMode="numeric" />
          </div>
          <div className="field">
            <label className="label" htmlFor="r-cum">Cumulative amount, base units</label>
            <input id="r-cum" value={cumulative} onChange={(e) => setCumulative(e.target.value)} inputMode="numeric" />
          </div>
          <div className="field">
            <label className="label" htmlFor="r-req">Request hash, bytes32</label>
            <input id="r-req" className="hexin" value={req} onChange={(e) => setReq(e.target.value)} placeholder="0x…" spellCheck={false} />
          </div>
          <div className="field">
            <label className="label" htmlFor="r-resp">Response hash, bytes32</label>
            <input id="r-resp" className="hexin" value={resp} onChange={(e) => setResp(e.target.value)} placeholder="0x…" spellCheck={false} />
          </div>
          <div className="field">
            <label className="label" htmlFor="r-payer">payerSig, the EIP-712 voucher</label>
            <input id="r-payer" className="hexin" value={payerSig} onChange={(e) => setPayerSig(e.target.value)} placeholder="0x…" spellCheck={false} />
          </div>
          <div className="field">
            <label className="label" htmlFor="r-enclave">enclaveSig, personal_sign</label>
            <input id="r-enclave" className="hexin" value={enclaveSig} onChange={(e) => setEnclaveSig(e.target.value)} placeholder="0x…" spellCheck={false} />
            <span className="hint">The legacy gateway format: a signature over the text &quot;requestHash:responseHash&quot;, 64 lowercase hex characters each, no 0x.</span>
          </div>
        </div>
        <div className="actions">
          <button className="btn line" type="button" disabled={busy} onClick={diagnose}>Diagnose signatures</button>
          <button className="btn line" type="button" disabled={busy || !chain.ready} onClick={simulate}>Simulate redeem</button>
          <button className="btn" type="button" disabled={isPending || busy || !chain.ready || pinnedChannel === true} onClick={send}>Send redeem</button>
        </div>
        {pinnedChannel === true && <p className="note">Send is disabled: this channel is model-pinned and only redeemWithReceipt can pay it.</p>}
        {report && (
          <div className={reportBad ? 'result bad' : 'result'} role={reportBad ? 'alert' : 'status'}>
            <span className="rl">{reportBad ? 'Reverts' : 'Result'}</span>
            <span className="rv">{report}</span>
          </div>
        )}
      </div>
    </li>
  );
}

