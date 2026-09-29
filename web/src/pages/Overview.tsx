import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  BaseError,
  decodeErrorResult,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  hexToString,
  keccak256,
  recoverTypedDataAddress,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { usePublicClient } from 'wagmi';
import { ASSAY, assayChain, explorer } from '../chain';
import { assayAbi } from '../abi/Assay.generated';
import {
  APPROVED_MEASUREMENTS,
  ASSAY_DEPLOY_TX,
  ATTESTATION_VALIDITY,
  CHALLENGE_WINDOW,
  CHANNEL_TIMEOUT,
  REGISTER_TX,
  SEED_SIGNER,
  USDG_ADDRESS,
  VERIFIER_ADDRESS,
} from '../lib/addresses.generated';
import demo from '../lib/refusal-demo.json';
import { fmtCountdown, fmtStamp, fmtUsdg, short } from '../lib/format';
import { Code, Fact, HexValue, Num, Stamp, TitleBlock } from '../components/Stamp';
import { useAtBlock } from '../hooks/useAtBlock';

const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex;
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const PINNED_MODEL_ID = 'meta-llama/llama-3.3-70b-instruct';
const RECEIPT_KEY = '0x110f3824daeeef29dbeba9677a5794ffed257b1082d9fd4599b3c0819953aa0a' as Hex;

const receiptVerifierAbi = [
  {
    type: 'function',
    name: 'verifyReceipt',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'pubkey', type: 'bytes32' },
      { name: 'receiptBytes', type: 'bytes' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [
      { name: 'ok', type: 'bool' },
      { name: 'requestedModelHash', type: 'bytes32' },
      { name: 'servedModelHash', type: 'bytes32' },
      { name: 'requestHash', type: 'bytes32' },
      { name: 'responseHash', type: 'bytes32' },
    ],
  },
] as const;

type ChannelRow = {
  id: number;
  agent: Address;
  provider: Address;
  deposit: bigint;
  paid: bigint;
  openedAt: bigint;
  lastActivityAt: bigint;
  closed: boolean;
  measurement: Hex;
  requestedModelHash: Hex;
};

function toChannel(id: number, raw: unknown): ChannelRow {
  const [agent, provider, deposit, paid, openedAt, lastActivityAt, , closed, measurement, requestedModelHash] = raw as readonly [
    Address, Address, bigint, bigint, bigint, bigint, bigint, boolean, Hex, Hex,
  ];
  return { id, agent, provider, deposit, paid, openedAt, lastActivityAt, closed, measurement, requestedModelHash };
}

/** The receipt's upstream.verified event, read from the exact bytes the ReceiptVerifier checks. */
function upstreamEvent(receiptBytes: Hex): Record<string, unknown> | null {
  try {
    const r = JSON.parse(hexToString(receiptBytes)) as { event_log?: Record<string, unknown>[] };
    return r.event_log?.find((e) => e.type === 'upstream.verified') ?? null;
  } catch {
    return null;
  }
}

type Revert = { reverted: false } | { reverted: true; selector: Hex; name: string | null };

async function readRefusal(c: PublicClient, block: bigint) {
  const d = demo as unknown as {
    channelId: number; cumulativeAmount: string; requestHash: Hex; responseHash: Hex; payerSig: Hex;
    pubkey: Hex; receiptBytes: Hex; signature: Hex; provider: Address;
  };
  const channelId = BigInt(d.channelId);
  const amount = BigInt(d.cumulativeAmount);
  const [chRaw, receiptVerifier, channelTimeout] = await Promise.all([
    c.readContract({ address: ASSAY, abi: assayAbi, functionName: 'channels', args: [channelId], blockNumber: block }),
    c.readContract({ address: ASSAY, abi: assayAbi, functionName: 'receiptVerifier', blockNumber: block }) as Promise<Address>,
    c.readContract({ address: ASSAY, abi: assayAbi, functionName: 'channelTimeout', blockNumber: block }) as Promise<bigint>,
  ]);
  const ch = toChannel(d.channelId, chRaw);
  const receiptKey = keccak256(
    encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }, { type: 'bytes32' }], [ch.provider, d.requestHash, d.responseHash]),
  );
  const [consumed, testKeyReg] = await Promise.all([
    c.readContract({ address: ASSAY, abi: assayAbi, functionName: 'consumedReceipt', args: [receiptKey], blockNumber: block }) as Promise<boolean>,
    c.readContract({ address: ASSAY, abi: assayAbi, functionName: 'receiptSigners', args: [d.pubkey], blockNumber: block }) as Promise<readonly [Hex, bigint]>,
  ]);

  const vr = await c.call({
    to: receiptVerifier,
    data: encodeFunctionData({ abi: receiptVerifierAbi, functionName: 'verifyReceipt', args: [d.pubkey, d.receiptBytes, d.signature] }),
    blockNumber: block,
  });
  if (!vr.data) throw new Error('verifyReceipt returned no data.');
  const [ok, requestedModelHash, servedModelHash, receiptRequestHash, receiptResponseHash] = decodeFunctionResult({
    abi: receiptVerifierAbi,
    functionName: 'verifyReceipt',
    data: vr.data,
  });

  const voucherSigner = await recoverTypedDataAddress({
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
    message: { channelId, cumulativeAmount: amount, requestHash: d.requestHash, responseHash: d.responseHash },
    signature: d.payerSig,
  });

  let revert: Revert;
  try {
    await c.call({
      account: d.provider,
      to: ASSAY,
      data: encodeFunctionData({
        abi: assayAbi,
        functionName: 'redeemWithReceipt',
        args: [channelId, amount, d.requestHash, d.responseHash, d.payerSig, d.pubkey, d.receiptBytes, d.signature],
      }),
      blockNumber: block,
    });
    revert = { reverted: false };
  } catch (e) {
    const hit = e instanceof BaseError ? e.walk((x) => typeof (x as { data?: unknown }).data === 'string') : null;
    const data = (hit as { data?: string } | null)?.data;
    if (!data || !data.startsWith('0x')) throw e;
    let name: string | null = null;
    try {
      name = decodeErrorResult({ abi: assayAbi, data: data as Hex }).errorName;
    } catch {
      name = null;
    }
    revert = { reverted: true, selector: data.slice(0, 10) as Hex, name };
  }

  return {
    d, ch, amount, receiptVerifier, channelTimeout, consumed, testKeyRegistered: testKeyReg[0] !== ZERO_HASH,
    ok, requestedModelHash, servedModelHash, receiptRequestHash, receiptResponseHash, voucherSigner, revert,
    pinnedIsLlama: ch.requestedModelHash.toLowerCase() === keccak256(toHex(PINNED_MODEL_ID)).toLowerCase(),
    upstream: upstreamEvent(d.receiptBytes),
  };
}

type Mark = 'pass' | 'fail' | 'skip';

type ReceiptJson = { model?: string; event_log?: { type?: string; body_hash?: string; model_id?: string }[] };

/** The signed receipt JSON, read from the exact bytes the ReceiptVerifier checks. Display only. */
function receiptJson(receiptBytes: Hex): ReceiptJson | null {
  try {
    return JSON.parse(hexToString(receiptBytes)) as ReceiptJson;
  } catch {
    return null;
  }
}

/** Seconds since a timestamp in ms, re-rendered every second. */
function useAgo(ms: number | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return ms ? Math.max(0, Math.round((now - ms) / 1000)) : null;
}

const shortHash = (h: string) => (h.length > 20 ? `${h.slice(0, h.indexOf(':') + 5)}…` : h);

function Refusal() {
  const q = useAtBlock(['refusal-demo', ASSAY], readRefusal);
  const r = q.data?.value;
  const ago = useAgo(q.data ? q.dataUpdatedAt : undefined);
  const refused = !!r && r.revert.reverted && r.revert.name === 'ModelMismatch';
  const pinnedLabel = r ? (r.pinnedIsLlama ? PINNED_MODEL_ID : r.ch.requestedModelHash === ZERO_HASH ? 'no model (legacy channel)' : 'an unrecognised model hash') : PINNED_MODEL_ID;
  const servedId = typeof r?.upstream?.model_id === 'string' ? r.upstream.model_id : null;
  const servedMatchesBytes = !!r && !!servedId && keccak256(toHex(servedId)).toLowerCase() === r.servedModelHash.toLowerCase();
  const modelsEqual = !!r && r.servedModelHash.toLowerCase() === r.ch.requestedModelHash.toLowerCase();
  const rj = receiptJson(demo.receiptBytes as Hex);
  const reqBody = rj?.event_log?.find((e) => e.type === 'request.received')?.body_hash ?? '';
  const respBody = rj?.event_log?.find((e) => e.type === 'response.returned')?.body_hash ?? '';
  const idle = !!r && !!q.data && Number(q.data.timestamp) > Number(r.ch.lastActivityAt || r.ch.openedAt) + Number(r.channelTimeout);

  const checks: { label: string; read: string; mark: Mark }[] = r
    ? [
        {
          label: 'Channel 0 exists and is not closed',
          read: idle ? `closed is ${String(r.ch.closed)}; idle past the channel timeout, so the agent may request close` : `closed is ${String(r.ch.closed)}`,
          mark: r.ch.provider !== ZERO_ADDR && !r.ch.closed ? 'pass' : 'fail',
        },
        {
          label: 'The caller is the channel provider',
          read: `${short(r.d.provider)} calls; channel provider is ${short(r.ch.provider)}`,
          mark: r.ch.provider.toLowerCase() === r.d.provider.toLowerCase() ? 'pass' : 'fail',
        },
        {
          label: `${fmtUsdg(r.amount)} USDG is above paid and within the deposit`,
          read: `paid ${fmtUsdg(r.ch.paid)} of ${fmtUsdg(r.ch.deposit)} USDG`,
          mark: r.amount > r.ch.paid && r.amount <= r.ch.deposit ? 'pass' : 'fail',
        },
        { label: 'This receipt was not paid before', read: `consumedReceipt is ${String(r.consumed)}`, mark: r.consumed ? 'fail' : 'pass' },
        {
          label: 'The voucher is signed by the channel agent',
          read: `recovers to ${short(r.voucherSigner)}; agent is ${short(r.ch.agent)}`,
          mark: r.voucherSigner.toLowerCase() === r.ch.agent.toLowerCase() ? 'pass' : 'fail',
        },
        { label: 'The receipt signature verifies (Ed25519)', read: `verifyReceipt returns ok ${String(r.ok)}`, mark: r.ok ? 'pass' : 'fail' },
        {
          label: 'The served model equals the pinned model',
          read: modelsEqual ? 'served and pinned hashes are equal' : `${servedId ?? 'the served model'} is not ${pinnedLabel}`,
          mark: modelsEqual ? 'pass' : 'fail',
        },
        { label: 'Request and response hashes match the voucher', read: 'not evaluated: the call stopped at 7', mark: 'skip' },
        {
          label: 'The receipt key is registered under the channel measurement',
          read: r.testKeyRegistered ? 'not evaluated: the call stopped at 7' : 'not evaluated; the test key is unregistered and would stop here too',
          mark: 'skip',
        },
      ]
    : [];
  const mark = (n: number): Mark | 'plain' => (checks[n - 1] ? checks[n - 1].mark : 'plain');
  const nums = (...ns: number[]) => (
    <span className="ns">
      {ns.map((n) => (
        <span key={n} data-step={checks[n - 1] && checks[n - 1].mark !== 'skip' ? '' : undefined} style={{ ['--step' as string]: n }}>
          <Num n={n} mark={mark(n)} />
        </span>
      ))}
    </span>
  );
  const reading = <span className="small">reading</span>;

  const [inspectOpen, setInspectOpen] = useState(false);
  const verdictCell = q.isError
    ? { label: 'Verdict', value: 'Chain unreadable', tone: 'alarm' as const, lead: true }
    : !r
      ? { label: 'Verdict', value: 'Asking the contract', lead: true }
      : refused
        ? { label: 'Verdict', value: 'Payment refused', tone: 'signal' as const, lead: true }
        : { label: 'Verdict', value: r.revert.reverted ? 'Refused for another reason' : 'Not refused', tone: 'alarm' as const, lead: true };

  return (
    <>
      <TitleBlock
        cells={[
          { label: 'Network', value: `${assayChain.name}, live`, mobileHide: true },
          {
            label: 'Read live at',
            mobileHide: true,
            value: q.data ? (
              <span title={ago !== null ? `read ${ago} s ago; re-read every 15 s` : undefined}>
                block <a href={explorer.block(q.data.block)} target="_blank" rel="noreferrer">{q.data.block.toLocaleString('en-US')}</a>
              </span>
            ) : (
              'reading'
            ),
          },
          verdictCell,
        ]}
      />

      <header className="head">
        <h1 className="t-display">
          Your agent only pays when the provider&apos;s sealed gateway signs a receipt naming the model you picked.
        </h1>
        <div className="lede">
          <p className="gloss">
            <b>Sealed gateway:</b> the provider&apos;s server runs inside a TEE (Intel TDX), hardware that reports a
            fingerprint of its software; the contract checks it against an allowlist. <b>Receipt:</b> a statement that
            gateway signs for each call, naming the model that answered.
          </p>
          <Link className="btn" to="/channel">Open a channel pinned to a model</Link>
        </div>
      </header>

      {q.isError && (
        <div className="alarm" role="alert">
          <b>Could not read the chain.</b>
          <span>{String(q.error).slice(0, 180)}</span>
          <button className="textbtn" onClick={() => q.refetch()}>Read again</button>
        </div>
      )}
      {r && !refused && q.data && (
        <div className="alarm" role="alert">
          <b>{r.revert.reverted ? 'The call reverted, but not with ModelMismatch.' : 'The call did not revert.'}</b>
          <span>
            {r.revert.reverted
              ? `${r.revert.name ?? 'undecoded'}() ${r.revert.selector}; expected ModelMismatch() 0xa407e5f7 at block ${q.data.block.toLocaleString('en-US')}.`
              : `redeemWithReceipt would have paid at block ${q.data.block.toLocaleString('en-US')}. The refusal this page exists to show is not happening.`}
          </span>
        </div>
      )}

      <figure className="board verdict" aria-busy={q.isPending}>
        <figcaption className="t-subject">
          This receipt names a different model than the one channel 0 was opened for, so the contract refuses to pay.
        </figcaption>
        <div className={r ? 'face run' : 'face'}>
          <div className="doc">
            <div className="doc-head">
              <span className="t-label">Channel 0 was opened for</span>
              <span className="small">a channel is USDG an agent locks up front and pays out per call</span>
            </div>
            <div className="doc-key">
              <span className="t-diff">{pinnedLabel}</span>
            </div>
          </div>
          <div className={modelsEqual ? 'connector whole' : 'connector'} aria-hidden="true">
            <span className="wire a" />
            <span className="cut" />
            <span className="wire b" />
          </div>
          <div className="doc receipt">
            <svg className="tear" viewBox="0 0 400 10" preserveAspectRatio="none" aria-hidden="true">
              <path d={`M0 10 ${Array.from({ length: 40 }, (_, i) => `L${i * 10 + 5} 1 L${i * 10 + 10} 10`).join(' ')}`} fill="var(--ground)" stroke="var(--ink)" strokeWidth="1.25" vectorEffect="non-scaling-stroke" />
            </svg>
            <div className="doc-head">
              <span className="t-label">Test receipt says it served</span>
              <span className="small">signed with a test key, not by a registered gateway</span>
            </div>
            <div className="doc-key">
              <span className={modelsEqual ? 't-diff' : 't-diff served'}>{servedId ?? (r ? 'unreadable model id' : 'served-model')}</span>
            </div>
          </div>
        </div>
        <div className="outcome">
          <span className={refused ? 't-diff struck' : 't-diff'}>{r ? fmtUsdg(r.amount) : '1.00'} USDG</span>
          <span>
            {!r ? 'Asking the contract.' : refused ? 'not paid. It stays in channel 0.' : 'The refusal did not happen; see the alert above.'}
            <span className="small">
              {' '}A read-only call{q.data ? ` at block ${q.data.block.toLocaleString('en-US')}` : ''}: nothing was sent, and no real llama call was swapped.
            </span>
          </span>
        </div>
      </figure>

      <details className="inspect" onToggle={(e) => setInspectOpen((e.target as HTMLDetailsElement).open)}>
        <summary>
          <span className="t-section">Inspect the call</span>
          <span className="small">the nine checks the contract ran in order, the voucher, the receipt bytes and the raw revert</span>
        </summary>
      <section className="board" style={{ marginTop: 16 }} aria-labelledby="fig-h" aria-busy={q.isPending}>
        <h2 id="fig-h" className="sr-only">The voucher, channel 0 and the receipt, with the contract checks numbered on the fields they read</h2>
        <div className={r && inspectOpen ? 'figure run' : 'figure'}>
          <div className="doc channel">
            <div className="doc-head">
              <span className="t-label">Channel 0, live state</span>
              <span className="small"><Code>Assay.channels(0)</Code></span>
            </div>
            <div className="doc-key">
              <span className="t-label">{nums(7)} Pins</span>
              <span className="t-diff">{pinnedLabel}</span>
            </div>
            <div className="doc-rows">
              <div className="drow"><span className="t-label">Agent</span><span className="v">{r ? <HexValue value={r.ch.agent} /> : reading}</span>{nums(5)}</div>
              <div className="drow"><span className="t-label">Provider</span><span className="v">{r ? <HexValue value={r.ch.provider} /> : reading}</span>{nums(2)}</div>
              <div className="drow"><span className="t-label">Deposit</span><span className="v">{r ? `${fmtUsdg(r.ch.deposit)} USDG` : reading}</span>{nums(3)}</div>
              <div className="drow"><span className="t-label">Paid</span><span className="v">{r ? `${fmtUsdg(r.ch.paid)} USDG` : reading}</span>{nums(3)}</div>
              <div className="drow"><span className="t-label">State</span><span className="v">{r ? (r.ch.closed ? 'closed' : idle ? 'open, idle past timeout' : 'open') : reading}</span>{nums(1)}</div>
            </div>
          </div>

          <div className={modelsEqual ? 'connector whole' : 'connector'} aria-hidden="true">
            <span className="wire a" />
            <span className="cut" />
            <span className="wire b" />
            <span className="n-wrap"><span data-step="" style={{ ['--step' as string]: 7 }}><Num n={7} mark={mark(7)} /></span></span>
          </div>

          <div className="doc receipt">
            <svg className="tear" viewBox="0 0 400 10" preserveAspectRatio="none" aria-hidden="true">
              <path d={`M0 10 ${Array.from({ length: 40 }, (_, i) => `L${i * 10 + 5} 1 L${i * 10 + 10} 10`).join(' ')}`} fill="var(--ground)" stroke="var(--ink)" strokeWidth="1.25" vectorEffect="non-scaling-stroke" />
            </svg>
            <div className="doc-head">
              <span className="t-label">Receipt, test vector</span>
              <span className="small">signed by a test key, not by a registered gateway key</span>
            </div>
            <div className="doc-key">
              <span className="t-label">{nums(7)} Served, per upstream.verified</span>
              <span className={modelsEqual ? 't-diff' : 't-diff served'}>{servedId ?? (r ? 'unreadable model id' : 'served-model')}</span>
            </div>
            <div className="doc-rows">
              <div className="drow"><span className="t-label">Key</span><span className="v"><HexValue value={demo.pubkey} /></span>{nums(6, 9)}</div>
              <div className="drow"><span className="t-label">Request body</span><span className="v"><span className="hex" title={reqBody}>{shortHash(reqBody)}</span></span>{nums(4, 8)}</div>
              <div className="drow"><span className="t-label">Response body</span><span className="v"><span className="hex" title={respBody}>{shortHash(respBody)}</span></span>{nums(4, 8)}</div>
            </div>
          </div>

          <div className="doc voucher">
            <div className="doc-head">
              <span className="t-label">Voucher, EIP-712</span>
              <span className="small">a real voucher for channel 0, signed by its agent</span>
            </div>
            <div className="amount">
              <span className="t-label" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{nums(3)} Amount</span>
              <span className={refused ? 't-diff struck' : 't-diff'}>{r ? fmtUsdg(r.amount) : '1.00'} USDG</span>
              <span className="small">{r ? (refused ? `stays in channel 0, which holds ${fmtUsdg(r.ch.deposit - r.ch.paid)} USDG` : 'not refused') : reading}</span>
            </div>
            <div className="drow"><span className="t-label">Signed by</span><span className="v">{r ? <HexValue value={r.voucherSigner} /> : reading}</span>{nums(5)}</div>
            <div className="drow"><span className="t-label">Hashes</span><span className="v"><HexValue value={demo.requestHash} /> <HexValue value={demo.responseHash} /></span>{nums(8)}</div>
          </div>

          <div className="doc call">
            <div className="doc-head">
              <span className="t-label">The call</span>
              <span className="small">sent as eth_call, so nothing is broadcast and no funds can move</span>
            </div>
            <div className="drow"><span className="t-label">Function</span><span className="v"><Code>redeemWithReceipt(0, {r ? r.amount.toString() : '1000000'}, …)</Code></span></div>
            <div className="drow"><span className="t-label">From</span><span className="v"><HexValue value={demo.provider} /> {nums(2)}</span></div>
            <div className="drow"><span className="t-label">Verifier</span><span className="v">{r ? <HexValue value={r.receiptVerifier} href={explorer.address(r.receiptVerifier)} /> : reading}</span></div>
            <div className="drow">
              <span className="t-label">Returned</span>
              <span className={refused ? 'v signal' : 'v'}>
                {!r ? reading : r.revert.reverted ? <><Code>{r.revert.name ?? 'undecoded'}()</Code> <Code>{r.revert.selector}</Code></> : 'success, no revert'}
                {q.data && <span className="small"> at block {q.data.block.toLocaleString('en-US')}</span>}
              </span>
            </div>
          </div>
        </div>
      </section>

      <ol className="legend" aria-label="Checks, in the order the contract runs them">
        {(r ? checks : Array.from({ length: 9 }, () => null)).map((c, i) => (
          <li
            key={i}
            className={c ? `lrow ${c.mark}` : 'lrow'}
            data-step={c && c.mark !== 'skip' ? '' : undefined}
            style={{ ['--step' as string]: i + 1 }}
          >
            <Num n={i + 1} mark={c ? c.mark : 'plain'} />
            <span>{c ? c.label : 'reading'}</span>
            <span className="read">{c?.read}</span>
            <span className="res">
              {!c ? '' : c.mark === 'pass' ? 'passed' : c.mark === 'skip' ? 'not reached' : i === 6 && refused ? <>refused, <Code>ModelMismatch()</Code></> : 'failed'}
            </span>
          </li>
        ))}
      </ol>

      <p className="honesty">
        <strong>What this is, exactly.</strong> The receipt is the <Code>model_swap</Code> test vector from the receipt
        verifier&apos;s fixtures, signed by a test key (<HexValue value={demo.pubkey} />). Its served model is the
        string &quot;served-model&quot;. It is offered to live channel 0, which pins {PINNED_MODEL_ID}, with a real
        voucher signed by the channel&apos;s agent. No real llama call was swapped; this shows what the contract does
        when the served model differs from the pinned one.
      </p>
      {r?.upstream && (
        <details className="bytes">
          <summary>
            Where the served model comes from: the <Code>upstream.verified</Code> event inside the signed receipt bytes
            {servedMatchesBytes ? ', whose model_id hashes to the verifier output' : ', which does NOT hash to the verifier output'}
          </summary>
          <pre>
            {'{\n'}
            {Object.entries(r.upstream).map(([key, v], i, all) => (
              <span key={key} className={key === 'model_id' ? 'hl' : undefined}>
                {`  "${key}": ${JSON.stringify(v)}${i < all.length - 1 ? ',' : ''}\n`}
              </span>
            ))}
            {'}'}
          </pre>
        </details>
      )}
      </details>
    </>
  );
}

function ChannelsSection() {
  const q = useAtBlock(['overview-channels', ASSAY], async (c, block) => {
    const count = (await c.readContract({ address: ASSAY, abi: assayAbi, functionName: 'channelCount', blockNumber: block })) as bigint;
    const rows = await Promise.all(
      Array.from({ length: Number(count) }, (_, i) =>
        c.readContract({ address: ASSAY, abi: assayAbi, functionName: 'channels', args: [BigInt(i)], blockNumber: block }),
      ),
    );
    const timeout = (await c.readContract({ address: ASSAY, abi: assayAbi, functionName: 'channelTimeout', blockNumber: block })) as bigint;
    return { count, timeout, rows: rows.map((raw, i) => toChannel(i, raw)) };
  });
  const llamaHash = keccak256(toHex(PINNED_MODEL_ID)).toLowerCase();

  return (
    <section className="section" aria-labelledby="ch-h">
      <div className="section-head">
        <h2 id="ch-h" className="t-section">Channels on this contract</h2>
        {q.data && <span className="small">channelCount {q.data.value.count.toString()}</span>}
        {q.data && <Stamp block={q.data.block} />}
      </div>
      {q.isPending && <p className="section-intro small" aria-busy="true">Reading channelCount and every channel.</p>}
      {q.isError && (
        <div className="alarm" role="alert" style={{ marginTop: 16 }}>
          <b>Could not read channels.</b> <span>{String(q.error).slice(0, 200)}</span>
          <button className="textbtn" onClick={() => q.refetch()}>Read again</button>
        </div>
      )}
      {q.data && q.data.value.rows.length === 0 && (
        <p className="section-intro">channelCount is 0: no agent has opened a channel on this contract yet. The Channels page opens the first one.</p>
      )}
      {q.data &&
        q.data.value.rows.map((ch) => {
          const legacy = ch.requestedModelHash === ZERO_HASH;
          const allow = APPROVED_MEASUREMENTS.some((m) => m.toLowerCase() === ch.measurement.toLowerCase());
          const now = Number(q.data.timestamp);
          const idle = !ch.closed && now > Number(ch.lastActivityAt || ch.openedAt) + Number(q.data.value.timeout);
          return (
            <div className="spec" key={ch.id}>
              <div className="spec-subject">
                <Link to={`/channel?id=${ch.id}`} className="t-subject">Channel {ch.id}</Link>
                <span className="small">{legacy ? 'legacy signature path' : 'receipt-only'}</span>
              </div>
              <div className="spec-facts">
                <Fact label="Pins" wide>
                  {legacy ? 'no model; zero hash, so redeemWithReceipt can never pay it' : ch.requestedModelHash.toLowerCase() === llamaHash ? PINNED_MODEL_ID : <HexValue value={ch.requestedModelHash} />}
                </Fact>
                <Fact label="Deposit">{fmtUsdg(ch.deposit)} USDG</Fact>
                <Fact label="Paid">{fmtUsdg(ch.paid)} USDG</Fact>
                <Fact label="Agent"><HexValue value={ch.agent} /></Fact>
                <Fact label="Provider"><HexValue value={ch.provider} /></Fact>
                <Fact label="Measurement">{allow ? 'on the allowlist' : 'not on the allowlist'}</Fact>
                <Fact label="State" wide>{ch.closed ? 'closed' : idle ? 'open, idle past the timeout, so the agent may request close' : 'open'}</Fact>
              </div>
            </div>
          );
        })}
      {q.data && q.data.value.rows.length > 0 && <p className="note" style={{ marginTop: 12 }}>USDG has 6 decimals; amounts are shown in whole USDG.</p>}
    </section>
  );
}

async function latestTx(c: PublicClient, kind: 'Registered' | 'ReceiptKeyRegistered', match: string): Promise<Hex | null> {
  try {
    const receipt = await c.getTransactionReceipt({ hash: ASSAY_DEPLOY_TX });
    const logs = await c.getContractEvents({ address: ASSAY, abi: assayAbi, eventName: kind, fromBlock: receipt.blockNumber, toBlock: 'latest' });
    const hits = logs.filter((l) => {
      const a = l.args as { signer?: string; pubkey?: string };
      return (a.signer ?? a.pubkey ?? '').toLowerCase() === match.toLowerCase();
    });
    return hits.length ? (hits[hits.length - 1].transactionHash as Hex) : null;
  } catch {
    return null;
  }
}

export function KeysSection({ title = 'Registered gateway keys', drawn = false }: { title?: string; drawn?: boolean }) {
  const client = usePublicClient();
  const q = useAtBlock(['overview-keys', ASSAY], async (c, block) => {
    const [signer, receipt] = await Promise.all([
      c.readContract({ address: ASSAY, abi: assayAbi, functionName: 'signers', args: [SEED_SIGNER], blockNumber: block }) as Promise<readonly [Hex, bigint]>,
      c.readContract({ address: ASSAY, abi: assayAbi, functionName: 'receiptSigners', args: [RECEIPT_KEY], blockNumber: block }) as Promise<readonly [Hex, bigint]>,
    ]);
    return { signer, receipt };
  });
  const txs = useQuery({
    queryKey: ['overview-key-txs', ASSAY],
    enabled: !!client,
    staleTime: 60_000,
    queryFn: async () => {
      const c = client as PublicClient;
      const [s, r] = await Promise.all([latestTx(c, 'Registered', SEED_SIGNER), latestTx(c, 'ReceiptKeyRegistered', RECEIPT_KEY)]);
      return { s: s ?? REGISTER_TX, r };
    },
  });

  const rows = q.data
    ? [
        { kind: 'Gateway signer', algo: 'ECDSA; pays the legacy redeem()', call: 'signers', key: SEED_SIGNER as string, m: q.data.value.signer[0], exp: q.data.value.signer[1], tx: txs.data?.s ?? null },
        { kind: 'Receipt key', algo: 'Ed25519; pays redeemWithReceipt', call: 'receiptSigners', key: RECEIPT_KEY as string, m: q.data.value.receipt[0], exp: q.data.value.receipt[1], tx: txs.data?.r ?? null },
      ]
    : [];

  return (
    <section className="section" aria-labelledby="keys-h">
      <div className="section-head">
        <h2 id="keys-h" className="t-section">{title}</h2>
        {q.data && <Stamp block={q.data.block} />}
      </div>
      <p className="section-intro">
        Both keys were registered from fresh Intel TDX quotes that the Stylus verifier checked onchain, under the one
        allowlisted measurement. A key pays nothing after its expiry until it is registered again.
      </p>
      {q.isPending && <p className="small" aria-busy="true">Reading signers and receiptSigners.</p>}
      {q.isError && (
        <div className="alarm" role="alert">
          <b>Could not read key state.</b> <span>{String(q.error).slice(0, 200)}</span>
          <button className="textbtn" onClick={() => q.refetch()}>Read again</button>
        </div>
      )}
      {q.data && drawn && (
        <div className="board" style={{ marginTop: 8 }}>
          <div className="pair">
            {rows.map((k) => {
              const now = Number(q.data.timestamp);
              const unset = k.m === ZERO_HASH;
              const live = !unset && now <= Number(k.exp);
              return (
                <div className="doc" key={k.kind}>
                  <div className="doc-head">
                    <span className="t-label">{k.kind}</span>
                    <span className="small">{k.algo}</span>
                  </div>
                  <div className="doc-key">
                    <span className="t-label">{unset ? 'Status' : live ? 'Pays until' : 'Expired'}</span>
                    <span className="t-subject">{unset ? 'not registered' : `${fmtStamp(k.exp)}`}</span>
                    {!unset && <span className="small">{live ? `in ${fmtCountdown(Number(k.exp) - now)}` : fmtCountdown(Number(k.exp) - now)}</span>}
                  </div>
                  <div className="drow"><span className="t-label">Key</span><span className="v"><HexValue value={k.key} /></span></div>
                  <div className="drow"><span className="t-label">Read</span><span className="v"><Code>{k.call}(…)</Code></span></div>
                  <div className="drow">
                    <span className="t-label">Measurement</span>
                    <span className="v">{unset ? 'none' : <><HexValue value={k.m} /> {APPROVED_MEASUREMENTS.some((a) => a.toLowerCase() === k.m.toLowerCase()) ? 'on the allowlist' : 'not on the allowlist'}</>}</span>
                  </div>
                  <div className="drow">
                    <span className="t-label">Registered in</span>
                    <span className="v">{k.tx ? <HexValue value={k.tx} href={explorer.tx(k.tx)} /> : txs.isPending ? 'reading logs' : 'no registration log found'}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {q.data && !drawn &&
        rows.map((k) => {
          const now = Number(q.data.timestamp);
          const unset = k.m === ZERO_HASH;
          const live = !unset && now <= Number(k.exp);
          return (
            <div className="spec" key={k.kind}>
              <div className="spec-subject">
                <span className="t-subject">{k.kind}</span>
                <span className="small">{k.algo}</span>
              </div>
              <div className="spec-facts">
                <Fact label="Key"><HexValue value={k.key} /></Fact>
                <Fact label="Read"><Code>{k.call}(…)</Code></Fact>
                <Fact label="Measurement">
                  {unset ? 'none, not registered' : <><HexValue value={k.m} />{APPROVED_MEASUREMENTS.some((a) => a.toLowerCase() === k.m.toLowerCase()) ? ' on the allowlist' : ' not on the allowlist'}</>}
                </Fact>
                <Fact label="Expires" wide>
                  {unset ? 'not registered' : live ? `${fmtStamp(k.exp)}, in ${fmtCountdown(Number(k.exp) - now)}` : `${fmtStamp(k.exp)}, ${fmtCountdown(Number(k.exp) - now)}`}
                </Fact>
                <Fact label="Registered in">
                  {k.tx ? <HexValue value={k.tx} href={explorer.tx(k.tx)} /> : txs.isPending ? 'reading logs' : 'no registration log found'}
                </Fact>
              </div>
            </div>
          );
        })}
    </section>
  );
}

export function Overview() {
  useEffect(() => {
    document.title = 'Chiron: a swapped model is not paid';
  }, []);
  const constants = useAtBlock(['overview-constants', ASSAY], async (c, block) => {
    const [receiptVerifier, validity, timeout, challenge] = await Promise.all([
      c.readContract({ address: ASSAY, abi: assayAbi, functionName: 'receiptVerifier', blockNumber: block }) as Promise<Address>,
      c.readContract({ address: ASSAY, abi: assayAbi, functionName: 'attestationValidity', blockNumber: block }),
      c.readContract({ address: ASSAY, abi: assayAbi, functionName: 'channelTimeout', blockNumber: block }),
      c.readContract({ address: ASSAY, abi: assayAbi, functionName: 'challengeWindow', blockNumber: block }),
    ]);
    return { receiptVerifier, validity: validity as bigint, timeout: timeout as bigint, challenge: challenge as bigint };
  });
  const k = constants.data?.value;

  return (
    <main>
      <Refusal />

      <ChannelsSection />

      <KeysSection />

      <section className="section" aria-labelledby="covers-h">
        <div className="section-head">
          <h2 id="covers-h" className="t-section">What the proof covers</h2>
        </div>
        <div className="twocol">
          <div className="prose">
            <h3>Checked onchain, per call</h3>
            <p>
              The gateway&apos;s receipt key lives in an Intel TDX guest whose measurement is on the allowlist, under a
              quote chain that ends at Intel&apos;s root. The receipt names the model the upstream served for this exact
              request and response, and the payment reverts unless that model is the one the channel pinned.
            </p>
          </div>
          <div className="prose">
            <h3>Not proved</h3>
            <p>
              Which weights a model provider loaded behind the label the receipt carries. TCB status, QE identity and PCK
              revocation are not checked, since a contract cannot fetch Intel&apos;s live collateral. There is no GPU
              evidence in the attestation.
            </p>
          </div>
        </div>
      </section>

      <section className="section" aria-labelledby="cfg-h">
        <div className="section-head">
          <h2 id="cfg-h" className="t-section">Contract constants</h2>
          {constants.data && <Stamp block={constants.data.block} />}
        </div>
        <dl className="kvs" style={{ marginTop: 16 }}>
          <dt>Assay</dt>
          <dd><HexValue value={ASSAY} href={explorer.address(ASSAY)} /></dd>
          <dt>TDX quote verifier</dt>
          <dd><HexValue value={VERIFIER_ADDRESS} href={explorer.address(VERIFIER_ADDRESS)} /> <span className="small">Stylus</span></dd>
          <dt>Receipt verifier</dt>
          <dd>{k ? <><HexValue value={k.receiptVerifier} href={explorer.address(k.receiptVerifier)} /> <span className="small">Stylus</span></> : 'reading'}</dd>
          <dt>USDG</dt>
          <dd><HexValue value={USDG_ADDRESS} href={explorer.address(USDG_ADDRESS)} /> <span className="small">6 decimals, EIP-2612 permit</span></dd>
          <dt>Attestation validity</dt>
          <dd>{Number(k?.validity ?? BigInt(ATTESTATION_VALIDITY)).toLocaleString('en-US')} seconds</dd>
          <dt>Channel timeout</dt>
          <dd>{Number(k?.timeout ?? BigInt(CHANNEL_TIMEOUT)).toLocaleString('en-US')} seconds</dd>
          <dt>Challenge window</dt>
          <dd>{Number(k?.challenge ?? BigInt(CHALLENGE_WINDOW)).toLocaleString('en-US')} seconds</dd>
          <dt>Allowlisted measurement</dt>
          <dd>{APPROVED_MEASUREMENTS.map((m) => <HexValue key={m} value={m} />)}</dd>
        </dl>
      </section>
    </main>
  );
}
