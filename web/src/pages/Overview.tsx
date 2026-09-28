import { useEffect } from 'react';
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
import { Stamp } from '../components/Stamp';
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

function HashFace({ hash }: { hash: string }) {
  return (
    <div className="hashface">
      <span className="hf-head">{hash.slice(0, 10)}</span>
      <span className="hf-tail">{hash.slice(10)}</span>
    </div>
  );
}

function RefusalHero() {
  const q = useAtBlock(['refusal-demo', ASSAY], readRefusal);
  const r = q.data?.value;
  const refused = !!r && r.revert.reverted && r.revert.name === 'ModelMismatch';
  const pinnedLabel = r ? (r.pinnedIsLlama ? PINNED_MODEL_ID : r.ch.requestedModelHash === ZERO_HASH ? 'no model (legacy)' : 'unknown model id') : PINNED_MODEL_ID;
  const servedId = typeof r?.upstream?.model_id === 'string' ? r.upstream.model_id : null;
  const servedMatchesBytes = !!r && !!servedId && keccak256(toHex(servedId)).toLowerCase() === r.servedModelHash.toLowerCase();

  const checks: { label: string; detail: string; mark: Mark }[] = r
    ? [
        {
          label: 'Channel exists and is not closed',
          detail:
            q.data && Number(q.data.timestamp) > Number(r.ch.lastActivityAt || r.ch.openedAt) + Number(r.channelTimeout)
              ? `closed = ${String(r.ch.closed)}; idle past channelTimeout, so the agent may requestClose`
              : `channels(0).closed = ${String(r.ch.closed)}`,
          mark: r.ch.provider !== ZERO_ADDR && !r.ch.closed ? 'pass' : 'fail',
        },
        {
          label: 'Caller is the channel provider',
          detail: short(r.d.provider),
          mark: r.ch.provider.toLowerCase() === r.d.provider.toLowerCase() ? 'pass' : 'fail',
        },
        {
          label: `${fmtUsdg(r.amount)} USDG is above paid, within deposit`,
          detail: `paid ${fmtUsdg(r.ch.paid)} of ${fmtUsdg(r.ch.deposit)}`,
          mark: r.amount > r.ch.paid && r.amount <= r.ch.deposit ? 'pass' : 'fail',
        },
        { label: 'Receipt not already paid', detail: 'consumedReceipt = false', mark: r.consumed ? 'fail' : 'pass' },
        {
          label: 'Voucher signed by the channel agent',
          detail: `recovers to ${short(r.voucherSigner)}`,
          mark: r.voucherSigner.toLowerCase() === r.ch.agent.toLowerCase() ? 'pass' : 'fail',
        },
        { label: 'Receipt signature verifies (Ed25519)', detail: `verifyReceipt ok = ${String(r.ok)}`, mark: r.ok ? 'pass' : 'fail' },
        {
          label: 'Served model equals pinned model',
          detail: refused ? 'ModelMismatch()' : 'not the expected revert',
          mark: r.servedModelHash.toLowerCase() === r.ch.requestedModelHash.toLowerCase() ? 'pass' : 'fail',
        },
        { label: 'Request and response hashes match the voucher', detail: 'not reached', mark: 'skip' },
        {
          label: 'Receipt key registered under the channel measurement',
          detail: r.testKeyRegistered ? 'not reached' : 'not reached; the test key is unregistered and would stop here too',
          mark: 'skip',
        },
      ]
    : [];

  return (
    <div className="hero-grid">
      <section className="refusal" aria-labelledby="refusal-h" aria-busy={q.isPending}>
        <h2 id="refusal-h" className="sr-only">Model check on channel 0</h2>
        <div className="models">
          <div className="model">
            <div className="m-lab">Channel 0 pins</div>
            <div className="m-name">{pinnedLabel}</div>
            {r ? <HashFace hash={r.ch.requestedModelHash} /> : <i className="bar" />}
            <div className="m-src">channels(0).requestedModelHash</div>
          </div>
          <div className={`neq ${r ? (r.servedModelHash.toLowerCase() === r.ch.requestedModelHash.toLowerCase() ? 'eq' : '') : 'wait'}`} aria-hidden="true">
            {r && r.servedModelHash.toLowerCase() === r.ch.requestedModelHash.toLowerCase() ? '=' : '≠'}
          </div>
          <div className="model">
            <div className="m-lab">
              Test receipt served <span className="tag">test receipt</span>
            </div>
            <div className="m-name">{r ? (servedMatchesBytes ? `"${servedId}"` : 'unreadable model id') : '"served-model"'}</div>
            {r ? <HashFace hash={r.servedModelHash} /> : <i className="bar" />}
            <div className="m-src">verifyReceipt(...).servedModelHash</div>
          </div>
        </div>

        {q.isPending && (
          <div className="verdict-strip wait" role="status">
            <span className="v-word">Calling redeemWithReceipt</span>
            <span className="v-meta">eth_call from the channel provider, Arbitrum Sepolia</span>
          </div>
        )}
        {q.isError && (
          <div className="verdict-strip broken" role="alert">
            <span className="v-word">Could not read the chain</span>
            <span className="v-meta">{String(q.error).slice(0, 180)}</span>
            <button className="btn-ghost" onClick={() => q.refetch()}>retry</button>
          </div>
        )}
        {r && refused && q.data && (
          <div className="verdict-strip refused" role="status">
            <span className="v-word">Payment refused</span>
            <span className="v-meta mono">
              ModelMismatch() <span className="sel">{r.revert.reverted ? r.revert.selector : ''}</span>
            </span>
            <span className="v-stamp">
              eth_call redeemWithReceipt <Stamp block={q.data.block} label="at block" />
            </span>
          </div>
        )}
        {r && !refused && q.data && (
          <div className="verdict-strip broken" role="alert">
            <span className="v-word">{r.revert.reverted ? 'Unexpected revert' : 'Call did not revert'}</span>
            <span className="v-meta mono">
              {r.revert.reverted
                ? `${r.revert.name ?? 'undecoded'}() ${r.revert.selector}, expected ModelMismatch() 0xa407e5f7`
                : 'redeemWithReceipt would have paid. The refusal this page exists to show is not happening.'}
            </span>
            <span className="v-stamp"><Stamp block={q.data.block} label="at block" /></span>
          </div>
        )}

        {r?.upstream && (
          <figure className="receipt-src">
            <figcaption>
              Where the served hash comes from: the <span className="mono">upstream.verified</span> event inside the
              signed receipt bytes, keccak256 of its <span className="mono">model_id</span>
              {servedMatchesBytes ? ' matches the verifier output' : ' does NOT match the verifier output'}
            </figcaption>
            <pre className="mono">
              {'{\n'}
              {Object.entries(r.upstream).map(([key, v], i, all) => (
                <span key={key} className={key === 'model_id' ? 'hl' : undefined}>
                  {`  "${key}": ${JSON.stringify(v)}${i < all.length - 1 ? ',' : ''}\n`}
                </span>
              ))}
              {'}'}
            </pre>
          </figure>
        )}

        <p className="honesty">
          The receipt is receipt-verifier&apos;s <span className="mono">model_swap</span> test vector, signed by a test key
          ({short(demo.pubkey)}). Its served model is the string <span className="mono">served-model</span>. It is offered
          to live channel 0, which pins llama-3.3-70b, with a real voucher signed by the channel&apos;s agent. No real
          llama call was swapped; this shows what the contract does when the model differs.
        </p>
      </section>

      <aside className="ticket" aria-labelledby="ticket-h">
        <h2 id="ticket-h">redeemWithReceipt</h2>
        <dl className="t-kv">
          <dt>Channel</dt>
          <dd>0</dd>
          <dt>Amount</dt>
          <dd className="num">{r ? `${fmtUsdg(r.amount)} USDG` : '-'}</dd>
          <dt>Caller</dt>
          <dd className="mono">
            <a href={explorer.address(demo.provider)} target="_blank" rel="noreferrer">{short(demo.provider)}</a> provider
          </dd>
          <dt>Voucher</dt>
          <dd className="mono">{r ? `${short(r.voucherSigner)} agent` : '-'}</dd>
          <dt>Verifier</dt>
          <dd className="mono">
            {r ? <a href={explorer.address(r.receiptVerifier)} target="_blank" rel="noreferrer">{short(r.receiptVerifier)}</a> : '-'}
          </dd>
        </dl>
        <h3 className="t-sub">Checks, in contract order</h3>
        {q.isPending && <div className="checks-skel" aria-hidden="true" />}
        {r && (
          <ol className="checks">
            {checks.map((c, i) => (
              <li key={c.label} className={c.mark} style={{ ['--i' as string]: i }}>
                <span className="ck" role="img" aria-label={c.mark === 'pass' ? 'passed' : c.mark === 'fail' ? 'failed' : 'not reached'} />
                <span className="ck-text">
                  {c.label}
                  <small>{c.detail}</small>
                </span>
              </li>
            ))}
          </ol>
        )}
        <Link className="btn block" to="/channel">Open a pinned channel</Link>
      </aside>
    </div>
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
    return { count, rows: rows.map((raw, i) => toChannel(i, raw)) };
  });
  const llamaHash = keccak256(toHex(PINNED_MODEL_ID)).toLowerCase();

  return (
    <section className="section" aria-labelledby="ch-h">
      <div className="section-head">
        <h2 id="ch-h">Live channels</h2>
        {q.data && (
          <span className="count">
            channelCount <b className="num">{q.data.value.count.toString()}</b> <Stamp block={q.data.block} />
          </span>
        )}
      </div>
      {q.isPending && <div className="skel" aria-busy="true">Reading channelCount and every channel…</div>}
      {q.isError && (
        <p className="note err" role="alert">
          Could not read channels ({String(q.error).slice(0, 200)}). <button className="btn-ghost" onClick={() => q.refetch()}>retry</button>
        </p>
      )}
      {q.data && q.data.value.rows.length === 0 && (
        <div className="empty">
          <h3>No channel opened yet</h3>
          <p>channelCount is 0 on this contract. An agent opens one from the Channel page.</p>
        </div>
      )}
      {q.data && q.data.value.rows.length > 0 && (
        <div className="rowlist">
          <div className="rl-head ch-cols" aria-hidden="true">
            <span>Channel</span><span>Path</span><span>Pinned model</span><span>Deposit</span><span>Paid</span><span>Agent</span><span>Provider</span><span>Measurement</span>
          </div>
          {q.data.value.rows.map((ch) => {
            const legacy = ch.requestedModelHash === ZERO_HASH;
            const allow = APPROVED_MEASUREMENTS.some((m) => m.toLowerCase() === ch.measurement.toLowerCase());
            return (
              <Link to={`/channel?id=${ch.id}`} className="rl-row ch-cols" key={ch.id}>
                <span data-l="Channel" className="num strong">{ch.id}</span>
                <span data-l="Path"><span className={`tag ${legacy ? '' : 'on'}`}>{legacy ? 'legacy signature' : 'receipt-only'}</span></span>
                <span data-l="Pinned model" className="mono" title={ch.requestedModelHash}>
                  {legacy ? 'legacy, zero hash' : ch.requestedModelHash.toLowerCase() === llamaHash ? `llama-3.3-70b ${ch.requestedModelHash.slice(0, 10)}` : ch.requestedModelHash.slice(0, 18)}
                </span>
                <span data-l="Deposit" className="num">{fmtUsdg(ch.deposit)}</span>
                <span data-l="Paid" className="num">{fmtUsdg(ch.paid)}</span>
                <span data-l="Agent" className="mono">{short(ch.agent)}</span>
                <span data-l="Provider" className="mono">{short(ch.provider)}</span>
                <span data-l="Measurement" className="mono" title={ch.measurement}>
                  {ch.measurement.slice(0, 10)} {allow ? <em className="ok-t">allowlisted</em> : <em className="bad-t">not allowlisted</em>}
                </span>
              </Link>
            );
          })}
        </div>
      )}
      <p className="note">Deposits and payments in USDG, 6 decimals. {q.data?.value.rows.some((r) => r.closed) ? '' : 'Every channel is open.'}</p>
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

function KeysSection() {
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
        { kind: 'Gateway signer', algo: 'ECDSA, legacy redeem()', call: 'signers', key: SEED_SIGNER as string, m: q.data.value.signer[0], exp: q.data.value.signer[1], tx: txs.data?.s ?? null },
        { kind: 'Receipt key', algo: 'Ed25519, redeemWithReceipt', call: 'receiptSigners', key: RECEIPT_KEY as string, m: q.data.value.receipt[0], exp: q.data.value.receipt[1], tx: txs.data?.r ?? null },
      ]
    : [];

  return (
    <section className="section" aria-labelledby="keys-h">
      <div className="section-head">
        <h2 id="keys-h">Registered gateway keys</h2>
        {q.data && <Stamp block={q.data.block} />}
      </div>
      <p className="sub">
        Both keys were registered from fresh Intel TDX quotes that the Stylus verifier checked onchain, under the one
        allowlisted measurement. A key pays nothing after its expiry until it is registered again.
      </p>
      {q.isPending && <div className="skel" aria-busy="true">Reading signers and receiptSigners…</div>}
      {q.isError && (
        <p className="note err" role="alert">
          Could not read key state ({String(q.error).slice(0, 200)}). <button className="btn-ghost" onClick={() => q.refetch()}>retry</button>
        </p>
      )}
      {q.data && (
        <div className="rowlist">
          <div className="rl-head key-cols" aria-hidden="true">
            <span>Key</span><span>Read</span><span>Measurement</span><span>Expires</span><span>Registration</span>
          </div>
          {rows.map((k) => {
            const now = Number(q.data.timestamp);
            const unset = k.m === ZERO_HASH;
            const live = !unset && now <= Number(k.exp);
            return (
              <div className="rl-row key-cols" key={k.kind}>
                <span data-l="Key">
                  <span className="strong">{k.kind}</span>
                  <small className="dimline">{k.algo}</small>
                </span>
                <span data-l="Read" className="mono" title={k.key}>
                  {k.call}({short(k.key)})
                </span>
                <span data-l="Measurement" className="mono" title={k.m}>
                  {unset ? 'none' : k.m.slice(0, 10)}
                </span>
                <span data-l="Expires">
                  <span className={live ? 'ok-t' : 'bad-t'}>{unset ? 'not registered' : live ? 'live' : 'expired'}</span>
                  {!unset && <small className="dimline">{fmtStamp(k.exp)}, {fmtCountdown(Number(k.exp) - now)}</small>}
                </span>
                <span data-l="Registration" className="mono">
                  {k.tx ? <a href={explorer.tx(k.tx)} target="_blank" rel="noreferrer">{short(k.tx)}</a> : txs.isPending ? 'reading logs' : '-'}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function Overview() {
  useEffect(() => {
    document.title = 'Chiron: a swapped model is refused payment onchain';
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
      <header className="ov-head">
        <h1>A swapped model does not get paid</h1>
        <p className="lede">
          Chiron is a USDG payment channel on Arbitrum. An agent pins a model when it opens a channel; the provider is
          paid per call only against the gateway&apos;s TEE-signed receipt, checked onchain. Below, a live eth_call
          offers channel 0 a receipt that names a different model.
        </p>
      </header>

      <RefusalHero />

      <ChannelsSection />

      <KeysSection />

      <section className="section" aria-labelledby="verified-h">
        <div className="section-head">
          <h2 id="verified-h">What the proof covers</h2>
        </div>
        <div className="verified-grid">
          <div>
            <h3>What the contract checks, per call</h3>
            <p>
              The gateway&apos;s receipt key lives in an Intel TDX guest whose measurement is on the allowlist, under a
              quote chain that ends at Intel&apos;s root. The receipt names the model the upstream served for this exact
              request and response, and the payment reverts unless that model is the one the channel pinned.
            </p>
          </div>
          <div>
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
          <h2 id="cfg-h">Contract constants</h2>
          {constants.data && <Stamp block={constants.data.block} />}
        </div>
        <dl className="kv">
          <dt>Assay</dt>
          <dd className="mono"><a href={explorer.address(ASSAY)} target="_blank" rel="noreferrer">{ASSAY}</a></dd>
          <dt>TDX quote verifier (Stylus)</dt>
          <dd className="mono"><a href={explorer.address(VERIFIER_ADDRESS)} target="_blank" rel="noreferrer">{VERIFIER_ADDRESS}</a></dd>
          <dt>Receipt verifier (Stylus)</dt>
          <dd className="mono">
            {k ? <a href={explorer.address(k.receiptVerifier)} target="_blank" rel="noreferrer">{k.receiptVerifier}</a> : '-'}
          </dd>
          <dt>USDG</dt>
          <dd className="mono">
            <a href={explorer.address(USDG_ADDRESS)} target="_blank" rel="noreferrer">{USDG_ADDRESS}</a>{' '}
            <span className="dim">Paxos USDG, 6 decimals, EIP-2612 permit</span>
          </dd>
          <dt>Attestation validity</dt>
          <dd><span className="num">{Number(k?.validity ?? BigInt(ATTESTATION_VALIDITY)).toLocaleString('en-US')}</span> seconds</dd>
          <dt>Channel timeout</dt>
          <dd><span className="num">{Number(k?.timeout ?? BigInt(CHANNEL_TIMEOUT)).toLocaleString('en-US')}</span> seconds</dd>
          <dt>Challenge window</dt>
          <dd><span className="num">{Number(k?.challenge ?? BigInt(CHALLENGE_WINDOW)).toLocaleString('en-US')}</span> seconds</dd>
          <dt>Allowlisted measurement</dt>
          <dd className="mono">{APPROVED_MEASUREMENTS.join(', ')}</dd>
        </dl>
      </section>
    </main>
  );
}
