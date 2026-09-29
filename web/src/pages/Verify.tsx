import { useEffect, useState } from 'react';
import { decodeFunctionResult, encodeFunctionData, isAddress, isAddressEqual, type Hex } from 'viem';
import { usePublicClient } from 'wagmi';
import { ASSAY, explorer } from '../chain';
import { assayAbi } from '../abi/Assay.generated';
import {
  APPROVED_MEASUREMENTS,
  REGISTER_TX,
  VERIFIER_ADDRESS,
} from '../lib/addresses.generated';
import { short } from '../lib/format';
import demo from '../lib/refusal-demo.json';
import { Code, HexValue, Num, Stamp, TitleBlock } from '../components/Stamp';
import { KeysSection } from './Overview';
import { useOnChain } from '../components/Wallet';
import { useAtBlock } from '../hooks/useAtBlock';

type Parsed = {
  signingAddress?: string;
  nonce?: string;
  teeType?: string;
  workloadKeysetDigest?: string;
  signingAlgo?: string;
  quoteHex?: string;
};

function parseReport(text: string): { parsed?: Parsed; error?: string } {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return { error: 'That is not valid JSON. Paste the full response body of the legacy attestation endpoint.' };
  }
  if (typeof j !== 'object' || j === null) return { error: 'Expected a JSON object at the top level.' };
  const o = j as Record<string, unknown>;
  const att = o.attestation as Record<string, unknown> | undefined;
  const nvidia = o.nvidia_payload as Record<string, unknown> | string | undefined;
  let nonce: string | undefined;
  if (typeof nvidia === 'object' && nvidia && typeof nvidia.nonce === 'string') {
    nonce = nvidia.nonce as string;
  } else if (typeof nvidia === 'string') {
    try {
      const inner = JSON.parse(nvidia) as Record<string, unknown>;
      if (typeof inner.nonce === 'string') nonce = inner.nonce;
    } catch {
      nonce = undefined;
    }
  }
  const parsed: Parsed = {
    signingAddress: typeof o.signing_address === 'string' ? o.signing_address : undefined,
    nonce,
    teeType: att && typeof att.tee_type === 'string' ? (att.tee_type as string) : undefined,
    workloadKeysetDigest: typeof o.workload_keyset_digest === 'string' ? o.workload_keyset_digest : undefined,
    signingAlgo: typeof o.signing_algo === 'string' ? o.signing_algo : undefined,
    quoteHex: typeof o.intel_quote === 'string' ? o.intel_quote : undefined,
  };
  if (!parsed.signingAddress && !parsed.quoteHex) {
    return { error: 'No signing_address and no intel_quote found. This does not look like a legacy endpoint report (GET /v1/attestation/report?nonce=...).' };
  }
  return { parsed };
}

type DryRun =
  | { status: 'ok'; signer: string; measurement: string; matchesJson: boolean; approved: boolean; block: bigint; nonce: string }
  | { status: 'reverted'; data: string; detail: string; help?: string };

const VERIFY_ABI = [
  { type: 'function', name: 'verify', stateMutability: 'nonpayable', inputs: [{ name: 'quote', type: 'bytes' }, { name: 'nonce', type: 'bytes32' }], outputs: [{ name: 'signer', type: 'address' }, { name: 'measurement', type: 'bytes32' }] },
] as const;

/** Raw ASCII revert strings the Stylus verifier returns (not ABI custom errors). */
const VERIFIER_HELP: Record<string, string> = {
  NonceMismatch: 'The quote binds a nonce that is not this provider and counter. Fetch a fresh report with the URL above, then retry before anything else registers from that address.',
  DebugAttributeSet: 'The quote has the TDX DEBUG attribute bit set. Only production, non-debug quotes register.',
  SignatureInvalid: 'A signature inside the quote chain does not verify. The quote bytes may be truncated or edited.',
  BadSigEncoding: 'A signature inside the quote chain is malformed. The quote bytes may be truncated or edited.',
  BadPubkey: 'A certificate public key inside the quote chain is malformed. The quote bytes may be truncated or edited.',
};

function asciiString(hex: string): string | null {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length === 0 || h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) return null;
  const bytes = h.match(/../g)!.map((b) => parseInt(b, 16));
  if (!bytes.every((b) => b >= 32 && b < 127)) return null;
  return String.fromCharCode(...bytes);
}

/** Assay's own ABI-encoded custom errors, as opposed to the Stylus verifier's raw ASCII revert
 * strings (VERIFIER_HELP above). Both nextRegisterNonce (read here) and register (simulated
 * below) can revert this way. */
const ASSAY_ERROR_HELP: Record<string, string> = {
  StaleRefBlock: "The refBlock this nonce or registration used fell outside Arbitrum's 256-block window (about 66 seconds). Read a fresh nextRegisterNonce and register immediately, or run the agent CLI (cd agent && npm run register), which does all three steps inside that window.",
  QuoteAlreadyUsed: 'This exact quote was already submitted to register. Fetch a fresh quote with the current nonce.',
  MeasurementNotApproved: 'The measurement this quote attests to is not on the allowlist.',
};

function assayErrorName(e: unknown): string | null {
  const seen = new Set<unknown>();
  const stack: unknown[] = [e];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    const o = cur as Record<string, unknown>;
    if (typeof o.errorName === 'string') return o.errorName;
    for (const v of Object.values(o)) {
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return null;
}

const normHex = (s: string) => s.trim().toLowerCase().replace(/^0x/, '');

/** One plain-language status line per dry-run state, same pattern as VERIFIER_HELP: no
 * cryptography terms, just what a non-cryptographer buyer needs to know happened. */
function plainStatusLine(r: DryRun): string {
  if (r.status === 'ok') {
    return r.approved
      ? "This provider's serving image passed a live Intel hardware check."
      : "This provider's serving image was read from a real quote, but its measurement is not on the allowlist: payment would be blocked before funds moved.";
  }
  if (r.data === 'SignerNotRegistered') {
    return 'This signer was never registered: payment blocked before funds moved.';
  }
  return "This quote did not pass the live Intel hardware check, so register() and any payment against it would be blocked before funds moved.";
}

export function Verify() {
  const client = usePublicClient();
  const chain = useOnChain();
  useEffect(() => {
    document.title = 'Chiron: verify a TDX attestation and register';
  }, []);
  const [provider, setProvider] = useState('');
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [fetchState, setFetchState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [fetchError, setFetchError] = useState('');
  const [dryRun, setDryRun] = useState<DryRun | null>(null);
  const [dryRunBusy, setDryRunBusy] = useState(false);
  const [registerBusy, setRegisterBusy] = useState(false);
  const [registerReport, setRegisterReport] = useState('');
  const [registerBad, setRegisterBad] = useState(false);

  const effectiveProvider = provider.trim() || chain.address || '';
  const providerOk = isAddress(effectiveProvider);

  const nonceSnap = useAtBlock(
    ['assay-register-nonce', effectiveProvider.toLowerCase()],
    async (c, block) => {
      // refBlock must satisfy ArbSys.arbBlockHash's window (and blockhash's, on its
      // fallback): a recent, already-mined block, not the pending current one.
      const refBlock = block - 1n;
      const nonce = await c.readContract({
        address: ASSAY,
        abi: assayAbi,
        functionName: 'nextRegisterNonce',
        args: [effectiveProvider as Hex, refBlock],
        blockNumber: block,
      });
      return { nonce: nonce as Hex, refBlock };
    },
    providerOk,
  );

  // The live read refetches every 15 s; a quote binds the nonce of one refBlock, so the
  // nonce is pinned when its URL is taken and every later step uses that pinned pair.
  const [pin, setPinned] = useState<{ nonce: Hex; refBlock: bigint; provider: string } | null>(null);
  // A pin belongs to one registering address; switching address drops it.
  const pinned = pin && pin.provider === effectiveProvider.toLowerCase() ? pin : null;
  const contractNonce = pinned?.nonce ?? nonceSnap.data?.value.nonce;
  const contractRefBlock = pinned?.refBlock ?? nonceSnap.data?.value.refBlock;
  const phalaUrl = contractNonce ? `https://inference.phala.com/v1/attestation/report?nonce=${normHex(contractNonce)}` : '';

  const { parsed, error: parseError } = text.trim() ? parseReport(text) : { parsed: undefined, error: undefined };
  const reportNonceMatches =
    parsed?.nonce && contractNonce ? normHex(parsed.nonce) === normHex(contractNonce) : undefined;

  async function fetchFromUrl() {
    if (!url.trim()) return;
    setFetchState('loading');
    setFetchError('');
    try {
      const res = await fetch(url.trim());
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      setText(await res.text());
      setFetchState('idle');
    } catch (e) {
      setFetchState('error');
      setFetchError(
        `Fetch failed (${e instanceof Error ? e.message : String(e)}). The endpoint may not allow browser cross-origin reads; fetch the URL with curl and paste the body instead.`,
      );
    }
  }

  function fillContractNonceUrl() {
    if (!phalaUrl || !contractNonce || contractRefBlock === undefined) return;
    setPinned({ nonce: contractNonce, refBlock: contractRefBlock, provider: effectiveProvider.toLowerCase() });
    setUrl(phalaUrl);
  }

  async function dryRunVerify() {
    if (!client || !parsed?.quoteHex || !contractNonce) return;
    setDryRunBusy(true);
    setDryRun(null);
    try {
      const hex = parsed.quoteHex.startsWith('0x') ? parsed.quoteHex : `0x${parsed.quoteHex}`;
      const quote = hex as Hex;
      const data = encodeFunctionData({ abi: VERIFY_ABI, functionName: 'verify', args: [quote, contractNonce] });
      const block = await client.getBlock();
      const res = await client.call({ to: VERIFIER_ADDRESS, data, blockNumber: block.number });
      if (!res.data) throw new Error('Empty return data from verifier call.');
      const [signer, measurement] = decodeFunctionResult({ abi: VERIFY_ABI, functionName: 'verify', data: res.data }) as unknown as [string, string];
      const approved = await client.readContract({
        address: ASSAY,
        abi: assayAbi,
        functionName: 'approvedMeasurement',
        args: [measurement as Hex],
        blockNumber: block.number,
      });
      setDryRun({
        status: 'ok',
        signer,
        measurement,
        matchesJson: !!parsed.signingAddress && isAddressEqual(signer as `0x${string}`, parsed.signingAddress as `0x${string}`),
        approved: approved as boolean,
        block: block.number,
        nonce: contractNonce,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const m = msg.match(/0x[0-9a-fA-F]+/);
      const raw = m?.[0] ?? 'no revert data';
      const decoded = asciiString(raw);
      setDryRun({
        status: 'reverted',
        data: decoded ?? raw,
        detail: msg.slice(0, 500),
        help: decoded ? VERIFIER_HELP[decoded] : undefined,
      });
    } finally {
      setDryRunBusy(false);
    }
  }

  async function simulateRegister() {
    if (!client || !parsed?.quoteHex || !chain.address) {
      setRegisterReport('Connect a wallet on Arbitrum Sepolia to simulate.');
      setRegisterBad(true);
      return;
    }
    if (contractRefBlock === undefined) {
      setRegisterReport('Still reading nextRegisterNonce for this address; try again in a moment.');
      setRegisterBad(true);
      return;
    }
    setRegisterBusy(true);
    setRegisterReport('');
    setRegisterBad(false);
    try {
      const hex = parsed.quoteHex.startsWith('0x') ? parsed.quoteHex : `0x${parsed.quoteHex}`;
      await client.simulateContract({
        address: ASSAY,
        abi: assayAbi,
        functionName: 'register',
        args: [hex as Hex, contractRefBlock],
        account: chain.address,
      });
      setRegisterReport('Simulation passed from the connected account: register() would not revert with this quote.');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setRegisterBad(true);
      const assayName = assayErrorName(e);
      if (assayName && ASSAY_ERROR_HELP[assayName]) {
        setRegisterReport(`Simulation reverts with ${assayName}(). ${ASSAY_ERROR_HELP[assayName]}`);
        return;
      }
      const m = msg.match(/0x[0-9a-fA-F]+/);
      const decoded = m ? asciiString(m[0]) : null;
      if (decoded && VERIFIER_HELP[decoded]) {
        setRegisterReport(`Simulation reverts with ${decoded}. ${VERIFIER_HELP[decoded]}`);
      } else {
        setRegisterReport(`Simulation reverts: ${msg.slice(0, 500)}`);
      }
    } finally {
      setRegisterBusy(false);
    }
  }

  return (
    <main>
      <TitleBlock
        cells={[
          { label: 'Network', value: 'Arbitrum Sepolia, live' },
          { label: 'Registering', value: providerOk ? <HexValue value={effectiveProvider} /> : 'choose in step 1', lead: true },
          ...(contractNonce && nonceSnap.data
            ? [
                { label: 'Nonce', value: pinned ? `pinned to block ${pinned.refBlock.toLocaleString('en-US')}` : 'live, re-read every 15 s' },
                {
                  label: 'Read at',
                  value: <>block <a href={explorer.block(nonceSnap.data.block)} target="_blank" rel="noreferrer">{nonceSnap.data.block.toLocaleString('en-US')}</a></>,
                },
              ]
            : []),
        ]}
      />

      <header className="pagehead">
        <h1 className="t-title">Verify a gateway, then register its key</h1>
        <p className="gloss" style={{ maxWidth: '84ch', marginBottom: 0 }}>
          <b>Attestation report:</b> a report signed by the gateway&apos;s TEE hardware (an Intel TDX quote) saying which
          software it runs and which key it holds. <b>Nonce:</b> a one-time number the contract issues, so an old report
          cannot be reused. Every check here is a read-only call; nothing is sent until you transact.
        </p>
        <div className="actions">
          <a className="btn" href="#v-nonce" onClick={() => setProvider(demo.provider)}>Read the nonce for the live provider</a>
        </div>
      </header>

      <KeysSection title="Gateway keys the contract accepts now" drawn />


      <section className="section" aria-labelledby="v-steps">
        <div className="section-head">
          <h2 id="v-steps" className="t-section">Register a gateway key in three steps</h2>
        </div>
      <ol className="steps">
        <li className="step" aria-labelledby="v-nonce">
          <Num n={1} mark={contractNonce ? 'pass' : 'plain'} />
          <div className="step-body">
            <h2 id="v-nonce" className="t-section">Read the contract-issued nonce</h2>
            <p className="prose">
              <Code>nextRegisterNonce</Code> binds the next quote this address may register. Each accepted register
              advances the counter, so a quote fetched now can never be replayed later.
            </p>
            {!chain.ready && !provider.trim() && <p className="note warn">{chain.reason} Or paste any provider address below to read its nonce.</p>}
            <div className="fields">
              <div className="field">
                <label className="label" htmlFor="v-provider">Registering address</label>
                <input
                  id="v-provider"
                  className="hexin"
                  value={provider}
                  onChange={(e) => { setProvider(e.target.value); setDryRun(null); }}
                  placeholder={chain.address ?? '0x…'}
                  spellCheck={false}
                  aria-invalid={provider.trim() && !providerOk ? true : undefined}
                />
                <span className="hint">
                  {provider.trim()
                    ? (providerOk ? 'Reading the nonce for this address.' : 'Not a valid address yet.')
                    : chain.address
                      ? 'Empty, so the connected wallet is used.'
                      : 'The address that will send register().'}
                </span>
              </div>
            </div>
            {!providerOk && (
              <div className="actions">
                <button className="btn line" type="button" onClick={() => setProvider(demo.provider)}>
                  Use the live provider
                </button>
                <span className="hex">{short(demo.provider)}</span>
              </div>
            )}
            {providerOk && nonceSnap.isPending && <p className="small" aria-busy="true">Reading nextRegisterNonce.</p>}
            {providerOk && nonceSnap.isError && (
              <div className="alarm" role="alert">
                <span>
                  {(() => {
                    const name = assayErrorName(nonceSnap.error);
                    return name && ASSAY_ERROR_HELP[name]
                      ? `${name}(). ${ASSAY_ERROR_HELP[name]}`
                      : `Could not read the nonce (${String(nonceSnap.error)}).`;
                  })()}
                </span>
                <button className="textbtn" onClick={() => nonceSnap.refetch()}>Read again</button>
              </div>
            )}
            {providerOk && nonceSnap.data && contractNonce && (
              <>
                <dl className="kvs">
                  <dt>nextRegisterNonce</dt>
                  <dd><HexValue value={contractNonce} head={10} tail={8} /></dd>
                  <dt>refBlock</dt>
                  <dd>{contractRefBlock?.toLocaleString('en-US')} <span className="small">{pinned ? 'pinned' : 'live, updates every 15 s'}</span></dd>
                  <dt>Report URL</dt>
                  <dd><a href={phalaUrl} target="_blank" rel="noreferrer" style={{ overflowWrap: 'anywhere', fontSize: 13 }}>{phalaUrl}</a></dd>
                </dl>
                <div className="actions">
                  <button className="btn line" onClick={fillContractNonceUrl} type="button">Pin this nonce and use the URL</button>
                  {pinned && <button className="btn line" onClick={() => setPinned(null)} type="button">Unpin</button>}
                </div>
                {pinned && (
                  <p className="note warn">
                    Pinned to block {pinned.refBlock.toLocaleString('en-US')}. Arbitrum answers for that block hash only for
                    the next 256 blocks, about 66 seconds on Arbitrum Sepolia, so the register transaction has to land
                    inside that window. The agent CLI does all three steps in one run: <Code>npm run register</Code>.
                  </p>
                )}
                <p className="note">
                  The nonce in the URL has no 0x prefix. The returned quote binds it at report_data[32:64] with
                  report_data[20:32] zeroed, and register() must arrive from {short(effectiveProvider)} before any other
                  register from that address consumes this counter value.
                </p>
              </>
            )}
          </div>
        </li>

        <li className="step" aria-labelledby="v-in">
          <Num n={2} mark={parsed ? 'pass' : 'plain'} />
          <div className="step-body">
            <h2 id="v-in" className="t-section">Fetch the attestation report</h2>
            <div className="fields">
              <div className="field">
                <label className="label" htmlFor="v-url">Report URL, optional</label>
                <input id="v-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" spellCheck={false} />
                <span className="hint">Use the nonce URL from step 1, never a reused or random nonce.</span>
              </div>
            </div>
            <div className="actions">
              <button className="btn line" onClick={fillContractNonceUrl} disabled={!phalaUrl} type="button">Use the nonce URL from step 1</button>
              <button className="btn line" onClick={fetchFromUrl} type="button" disabled={!url.trim() || fetchState === 'loading'}>
                {fetchState === 'loading' ? 'Fetching' : 'Fetch'}
              </button>
            </div>
            {fetchState === 'error' && <p className="note warn" role="alert">{fetchError}</p>}
            <div className="fields">
              <div className="field">
                <label className="label" htmlFor="v-json">Attestation JSON</label>
                <textarea
                  id="v-json"
                  value={text}
                  onChange={(e) => { setText(e.target.value); setDryRun(null); }}
                  placeholder={'{ "signing_address": "0x…", "intel_quote": "040002008100…", "nvidia_payload": "{\\"nonce\\": \\"…\\"}" }'}
                  spellCheck={false}
                  aria-invalid={parseError ? true : undefined}
                  aria-describedby="v-json-hint"
                />
                <span className="hint" id="v-json-hint">
                  {parseError ?? 'Parsed here in your browser; nothing leaves this page until you dry-run.'}
                </span>
              </div>
            </div>
            {parsed && (
              <dl className="kvs" aria-label="Parsed fields">
                <dt>signing_address</dt>
                <dd>{parsed.signingAddress ? <HexValue value={parsed.signingAddress} href={explorer.address(parsed.signingAddress)} /> : 'absent'}</dd>
                <dt>nonce</dt>
                <dd>{parsed.nonce ? <HexValue value={parsed.nonce} head={10} tail={8} /> : 'absent; expected under nvidia_payload.nonce'}</dd>
                {reportNonceMatches !== undefined && (
                  <>
                    <dt>Matches step 1</dt>
                    <dd>
                      {reportNonceMatches
                        ? 'yes. This report was fetched with the current contract nonce.'
                        : 'no. This report binds a different nonce and register() would revert NonceMismatch. Fetch again with the URL in step 1.'}
                    </dd>
                  </>
                )}
                <dt>measurement</dt>
                <dd>
                  Not a field of this JSON. The measurement is keccak256(MRTD ‖ RTMR0..3), derived onchain by the verifier
                  from the quote bytes, and accepted only when it is on the allowlist.
                </dd>
                <dt>tee_type</dt>
                <dd>{parsed.teeType ?? 'absent'}</dd>
                <dt>signing_algo</dt>
                <dd>{parsed.signingAlgo ?? 'absent'}</dd>
                <dt>workload_keyset_digest</dt>
                <dd>{parsed.workloadKeysetDigest ? <HexValue value={parsed.workloadKeysetDigest} head={10} tail={8} /> : 'absent'}</dd>
                <dt>intel_quote</dt>
                <dd>
                  {parsed.quoteHex
                    ? `${(parsed.quoteHex.length / 2 - (parsed.quoteHex.startsWith('0x') ? 1 : 0)).toLocaleString('en-US')} bytes`
                    : 'absent'}
                </dd>
              </dl>
            )}
          </div>
        </li>

        <li className="step" aria-labelledby="v-dry">
          <Num n={3} mark={dryRun?.status === 'ok' && dryRun.approved ? 'pass' : 'plain'} />
          <div className="step-body">
            <h2 id="v-dry" className="t-section">Dry-run verify, then simulate register</h2>
            <p className="prose">
              Calls <Code>verify(bytes, bytes32)</Code> on the Stylus verifier with the report&apos;s quote bytes and{' '}
              {contractNonce ? 'the nonce from step 1' : 'a contract-issued nonce'}. A success returns the signer and
              measurement the chain would derive; a revert carries the same failure a <Code>register</Code> transaction
              would hit.
            </p>
            {!contractNonce && <p className="note">Set a registering address in step 1 first, so the dry run can pass its current nonce.</p>}
            {contractNonce && !parsed?.quoteHex && <p className="note">Paste or fetch the attestation report in step 2 first; the dry run needs its quote bytes.</p>}
            <div className="actions">
              <button className="btn" onClick={dryRunVerify} disabled={dryRunBusy || !client || !contractNonce || !parsed?.quoteHex} type="button">
                {dryRunBusy ? 'Calling' : 'Check the quote onchain'}
              </button>
              <button className="btn line" onClick={simulateRegister} disabled={registerBusy || !client || !chain.ready || !parsed?.quoteHex} type="button">
                {registerBusy ? 'Simulating' : 'Simulate register'}
              </button>
            </div>
            {!client && <p className="note">Connect a wallet to enable the dry run. It only reads; there is no signature.</p>}
            {dryRun && (
              <div className={dryRun.status === 'ok' && dryRun.approved ? 'result' : 'result bad'} role={dryRun.status === 'ok' && dryRun.approved ? 'status' : 'alert'}>
                <span className="rl">{dryRun.status === 'ok' && dryRun.approved ? 'Verified' : 'Blocked'}</span>
                <span className="rv">{plainStatusLine(dryRun)}</span>
              </div>
            )}
            {dryRun?.status === 'ok' && (
              <dl className="kvs">
                <dt>Signer</dt>
                <dd><HexValue value={dryRun.signer} /> <span className="small">{dryRun.matchesJson ? 'matches signing_address' : 'does NOT match signing_address: the quote does not bind the address this report claims'}</span></dd>
                <dt>Measurement</dt>
                <dd><HexValue value={dryRun.measurement} /> <span className="small">{dryRun.approved ? 'on the allowlist: register() would store this signer' : 'not on the allowlist: register() would revert MeasurementNotApproved()'}</span></dd>
                <dt>Nonce passed</dt>
                <dd><HexValue value={dryRun.nonce} head={10} tail={8} /></dd>
                <dt>Read at</dt>
                <dd><Stamp block={dryRun.block} label="block" /></dd>
              </dl>
            )}
            {dryRun?.status === 'reverted' && (
              <div className="result bad" role="alert">
                <span className="rl">Reverted</span>
                <span className="rv">
                  The verifier call reverted with <Code>{dryRun.data}</Code>.{dryRun.help ? ` ${dryRun.help}` : ` ${dryRun.detail}`} A
                  register transaction with this quote would fail the same way and only cost gas.
                </span>
              </div>
            )}
            {registerReport && (
              <div className={registerBad ? 'result bad' : 'result'} role={registerBad ? 'alert' : 'status'}>
                <span className="rl">{registerBad ? 'Reverts' : 'Passes'}</span>
                <span className="rv">{registerReport}</span>
              </div>
            )}
          </div>
        </li>
      </ol>
      </section>

      <section className="section" aria-labelledby="v-reg">
        <div className="section-head">
          <h2 id="v-reg" className="t-section">How registration works</h2>
        </div>
        <p className="section-intro">
          Three steps in order. Read <Code>nextRegisterNonce</Code> for the address that will send the transaction.
          Fetch the gateway report with exactly that nonce (report_data[32:64] must equal it, report_data[20:32] must be
          zero). Then call <Code>register(quote, refBlock)</Code> from the same address: it calls the verifier with that
          nonce, requires the derived measurement to be{' '}
          {APPROVED_MEASUREMENTS.length === 1 ? 'the one allowlisted value' : `one of the ${APPROVED_MEASUREMENTS.length} allowlisted values`}, rejects
          any quote already used (<Code>QuoteAlreadyUsed</Code>), and stores the signer with its measurement and an
          expiry of now plus the validity. Anyone may call it for any provider, since the signer comes from the quote
          itself. A stale quote reverts <Code>NonceMismatch</Code> and consumes nothing. The live registration ran in{' '}
          <a href={explorer.tx(REGISTER_TX)} target="_blank" rel="noreferrer">this transaction</a>.
        </p>
        <p className="section-intro">
          The agent CLI does all three steps inside the 256-block window in one run: <Code>cd agent &amp;&amp; npm run register</Code>.
        </p>
      </section>

    </main>
  );
}
