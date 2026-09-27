import { useState } from 'react';
import { decodeFunctionResult, encodeFunctionData, isAddress, isAddressEqual, type Hex } from 'viem';
import { usePublicClient } from 'wagmi';
import { ASSAY, assayChain, explorer } from '../chain';
import { assayAbi } from '../abi/Assay.generated';
import {
  APPROVED_MEASUREMENTS,
  REGISTER_TX,
  VERIFIER_ADDRESS,
} from '../lib/addresses.generated';
import { short } from '../lib/format';
import { Stamp } from '../components/Stamp';
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
      const nonce = await c.readContract({ address: ASSAY, abi: assayAbi, functionName: 'nextRegisterNonce', args: [effectiveProvider as Hex], blockNumber: block });
      return { nonce: nonce as Hex };
    },
    providerOk,
  );

  const contractNonce = nonceSnap.data?.value.nonce;
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
    if (phalaUrl) setUrl(phalaUrl);
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
    setRegisterBusy(true);
    setRegisterReport('');
    setRegisterBad(false);
    try {
      const hex = parsed.quoteHex.startsWith('0x') ? parsed.quoteHex : `0x${parsed.quoteHex}`;
      await client.simulateContract({
        address: ASSAY,
        abi: assayAbi,
        functionName: 'register',
        args: [hex as Hex],
        account: chain.address,
      });
      setRegisterReport('Simulation passed from the connected account: register() would not revert with this quote.');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const m = msg.match(/0x[0-9a-fA-F]+/);
      const decoded = m ? asciiString(m[0]) : null;
      setRegisterBad(true);
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
      <div className="page-head">
        <div>
          <h1>Verify an attestation</h1>
          <p className="lede">
            Registration is nonce first. Read the contract-issued nonce for the registering address, fetch the legacy
            endpoint report with exactly that nonce, then send <b>register</b> from the same address. The page parses
            the report fields and dry-runs the Stylus verifier with a local <b>eth_call</b>, so nothing is submitted
            onchain until you transact.
          </p>
        </div>
        <div className="device">
          <h3>Verifying on</h3>
          <div className="stat">
            <div className="lab">Network</div>
            <div className="val">{assayChain.name}</div>
          </div>
          <div className="stat">
            <div className="lab">Assay contract</div>
            <div className="val mono" style={{ fontSize: 13 }}>
              <a href={explorer.address(ASSAY)} target="_blank" rel="noreferrer">{short(ASSAY)}</a>
            </div>
          </div>
          <div className="stat">
            <div className="lab">Stylus verifier</div>
            <div className="val mono" style={{ fontSize: 13 }}>
              <a href={explorer.address(VERIFIER_ADDRESS)} target="_blank" rel="noreferrer">{short(VERIFIER_ADDRESS)}</a>
            </div>
          </div>
        </div>
      </div>

      <section className="section" aria-labelledby="v-nonce">
        <div className="section-head">
          <h2 id="v-nonce">Contract-issued nonce</h2>
        </div>
        <p className="sub">
          <b>nextRegisterNonce</b> binds the next quote this address may register. Each accepted register advances
          the counter, so a quote fetched now can never be replayed later.
        </p>
        {!chain.ready && <p className="note">{chain.reason} You can still paste any provider address below to read its nonce.</p>}
        <div className="form">
          <div className="field">
            <label htmlFor="v-provider">Registering provider address</label>
            <input
              id="v-provider"
              value={provider}
              onChange={(e) => { setProvider(e.target.value); setDryRun(null); }}
              placeholder={chain.address ?? '0x…'}
              spellCheck={false}
            />
            <span className="hint">
              {provider.trim()
                ? (providerOk ? 'Reading the nonce for this address.' : 'Not a valid address yet.')
                : chain.address
                  ? 'Empty, so the connected wallet is used.'
                  : 'Enter the address that will send register().'}
            </span>
          </div>
        </div>
        {providerOk && nonceSnap.isPending && <div className="skel" aria-busy="true">Reading nextRegisterNonce…</div>}
        {providerOk && nonceSnap.isError && (
          <p className="note err" role="alert">
            Could not read the nonce ({String(nonceSnap.error)}). <button className="btn-ghost" onClick={() => nonceSnap.refetch()}>retry</button>
          </p>
        )}
        {providerOk && nonceSnap.data && contractNonce && (
          <div>
            <div style={{ marginTop: 12 }}><Stamp block={nonceSnap.data.block} /></div>
            <dl className="kv">
              <dt>nextRegisterNonce</dt>
              <dd className="mono">{contractNonce}</dd>
              <dt>Fetch URL</dt>
              <dd className="mono">
                <a href={phalaUrl} target="_blank" rel="noreferrer">{phalaUrl}</a>
              </dd>
            </dl>
            <div className="actions">
              <button className="btn ghost" onClick={fillContractNonceUrl} type="button">Use this URL for the fetch</button>
            </div>
            <p className="note">
              The nonce in the URL has no 0x prefix. The quote returned binds it at report_data[32:64] with
              report_data[20:32] zeroed, and register() must arrive from {short(effectiveProvider)} before any other
              register from that address consumes this counter value.
            </p>
          </div>
        )}
        {!providerOk && (
          <div className="empty">
            <h3>No provider address yet</h3>
            <p>Enter the address that will call register(), or connect a wallet, to read its contract-issued nonce and build the exact fetch URL.</p>
          </div>
        )}
      </section>

      <section className="section" aria-labelledby="v-in">
        <div className="section-head">
          <h2 id="v-in">Attestation input</h2>
        </div>
        <div className="form">
          <div className="field">
            <label htmlFor="v-url">Fetch from URL (optional)</label>
            <input id="v-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" spellCheck={false} />
            <span className="hint">Fetch with the nonce URL from section 02, never a reused or random nonce.</span>
          </div>
          <div className="actions">
            <button className="btn ghost" onClick={fillContractNonceUrl} disabled={!phalaUrl} type="button">Use the nonce URL from section 02</button>
            <button className="btn ghost" onClick={fetchFromUrl} type="button" disabled={!url.trim() || fetchState === 'loading'}>
              {fetchState === 'loading' ? 'Fetching…' : 'Fetch'}
            </button>
          </div>
          {fetchState === 'error' && <p className="note err" role="alert">{fetchError}</p>}
          <div className="field">
            <label htmlFor="v-json">Attestation JSON</label>
            <textarea
              id="v-json"
              value={text}
              onChange={(e) => { setText(e.target.value); setDryRun(null); }}
              placeholder='Paste the endpoint response body here…'
              spellCheck={false}
              aria-invalid={parseError ? true : undefined}
              aria-describedby="v-json-hint"
            />
            <span className="hint" id="v-json-hint">
              {parseError ?? 'Parsed locally in your browser; nothing leaves this page until you dry-run.'}
            </span>
          </div>
        </div>
      </section>

      {parsed && (
        <section className="section" aria-labelledby="v-fields">
          <div className="section-head">
            <h2 id="v-fields">Parsed fields</h2>
          </div>
          <dl className="kv">
            <dt>signing_address</dt>
            <dd className="mono">
              {parsed.signingAddress ?? <span style={{ color: 'var(--color-dim)' }}>absent</span>}
              {parsed.signingAddress && (
                <> <a href={explorer.address(parsed.signingAddress)} target="_blank" rel="noreferrer">{short(parsed.signingAddress)}</a></>
              )}
            </dd>
            <dt>nonce</dt>
            <dd className="mono">{parsed.nonce ?? <span style={{ color: 'var(--color-dim)' }}>absent (expected under nvidia_payload.nonce)</span>}</dd>
            {reportNonceMatches !== undefined && (
              <>
                <dt>nonce matches section 02</dt>
                <dd className={reportNonceMatches ? 'sig-ok' : 'sig-bad'}>
                  {reportNonceMatches
                    ? 'yes. This report was fetched with the current contract nonce.'
                    : 'NO. This report binds a different nonce and register() would revert NonceMismatch. Fetch again with the URL in section 02.'}
                </dd>
              </>
            )}
            <dt>measurement</dt>
            <dd>
              Not a field of this JSON. The measurement is <b>keccak256(MRTD ‖ RTMR0..3)</b> derived onchain by the
              verifier from the quote bytes below, and is only accepted when it matches the allowlist.
            </dd>
            <dt>tee_type</dt>
            <dd className="mono">{parsed.teeType ?? 'absent'}</dd>
            <dt>signing_algo</dt>
            <dd className="mono">{parsed.signingAlgo ?? 'absent'}</dd>
            <dt>workload_keyset_digest</dt>
            <dd className="mono">{parsed.workloadKeysetDigest ?? 'absent'}</dd>
            <dt>intel_quote</dt>
            <dd className="mono">
              {parsed.quoteHex ? `${(parsed.quoteHex.length / 2 - (parsed.quoteHex.startsWith('0x') ? 1 : 0)).toLocaleString('en-US')} bytes, 0x${parsed.quoteHex.replace(/^0x/, '').slice(0, 24)}…` : 'absent'}
            </dd>
          </dl>
        </section>
      )}

      {parsed?.quoteHex && (
        <section className="section" aria-labelledby="v-dry">
          <div className="section-head">
            <h2 id="v-dry">Contract dry run</h2>
          </div>
          <p className="sub">
            Calls <b>verify(bytes, bytes32)</b> on the Stylus verifier ({short(VERIFIER_ADDRESS)}) via eth_call with
            the report&apos;s quote bytes and {contractNonce ? 'the nonce from section 02' : 'a contract-issued nonce'}.
            A success returns the signer and measurement the chain would derive; a revert carries the same failure a{' '}
            <b>register</b> transaction would hit.
          </p>
          {!contractNonce && <p className="note">Set a provider address in section 02 first, so the dry run can pass its current nonce.</p>}
          <div className="actions">
            <button className="btn" onClick={dryRunVerify} disabled={dryRunBusy || !client || !contractNonce} type="button">
              {dryRunBusy ? 'Calling…' : 'Dry-run verify'}
            </button>
            <button className="btn ghost" onClick={simulateRegister} disabled={registerBusy || !client || !chain.ready} type="button">
              {registerBusy ? 'Simulating…' : 'Simulate register'}
            </button>
          </div>
          {!client && <p className="note">Connect a wallet to enable the dry run (reads only, no signature).</p>}
          {dryRun && <p className={dryRun.status === 'ok' && dryRun.approved ? 'note ok' : 'note err'} role={dryRun.status === 'ok' && dryRun.approved ? 'status' : 'alert'}>{plainStatusLine(dryRun)}</p>}
          {dryRun?.status === 'ok' && (
            <div className="panel">
              <h3>Verifier result <Stamp block={dryRun.block} /></h3>
              <div className="match">
                <div className="side">
                  <div className="label">Derived signer</div>
                  <div className="val">{dryRun.signer}</div>
                </div>
                <div className="arrow">&harr;</div>
                <div className="side">
                  <div className="label">Derived measurement</div>
                  <div className="val">{dryRun.measurement}</div>
                </div>
                <div className="verdict">
                  <span className={`verdict ${dryRun.approved ? 'ok' : 'bad'}`}>
                    {dryRun.approved ? 'Match' : 'Refused'}
                  </span>
                </div>
              </div>
              <dl className="kv">
                <dt>signer</dt>
                <dd className="mono">{dryRun.signer}</dd>
                <dt>matches JSON signing_address</dt>
                <dd className={dryRun.matchesJson ? 'sig-ok' : 'sig-bad'}>
                  {dryRun.matchesJson ? 'yes' : 'NO. The quote does not bind the address this report claims.'}
                </dd>
                <dt>measurement</dt>
                <dd className="mono">{dryRun.measurement}</dd>
                <dt>on allowlist</dt>
                <dd className={dryRun.approved ? 'sig-ok' : 'sig-bad'}>
                  {dryRun.approved ? 'yes. register() would store this signer.' : 'NO. register() would revert MeasurementNotApproved().'}
                </dd>
                <dt>nonce passed</dt>
                <dd className="mono">{dryRun.nonce}</dd>
              </dl>
            </div>
          )}
          {dryRun?.status === 'reverted' && (
            <p className="note err" role="alert">
              The verifier call reverted with <b>{dryRun.data}</b>.{dryRun.help ? ` ${dryRun.help}` : ` ${dryRun.detail}`} A{' '}
              <b>register</b> transaction with this quote would fail the same way and only cost gas.
            </p>
          )}
          {registerReport && <p className={registerBad ? 'note err' : 'note ok'} role={registerBad ? 'alert' : 'status'}>{registerReport}</p>}
        </section>
      )}

      <section className="section" aria-labelledby="v-reg">
        <div className="section-head">
          <h2 id="v-reg">How registration works</h2>
        </div>
        <p className="sub">
          Three steps in order. First read <b>nextRegisterNonce</b> for the address that will send the transaction
          (section 02). Then fetch the legacy endpoint with exactly that nonce (report_data[32:64] must equal it,
          report_data[20:32] must be zero). Then call <b>register(bytes quote)</b> from the same address: it calls
          the verifier with that nonce, requires the derived measurement to be one of{' '}
          {APPROVED_MEASUREMENTS.length} allowlisted value(s), rejects any quote hash already used
          (QuoteAlreadyUsed), and stores signer to measurement plus expiry (now plus validity). Anyone may call it
          for any provider, since the signer comes from the quote itself. A stale quote reverts NonceMismatch and
          consumes nothing. The live registration ran in{' '}
          <a href={explorer.tx(REGISTER_TX)} target="_blank" rel="noreferrer">this transaction</a>.
        </p>
      </section>
    </main>
  );
}
