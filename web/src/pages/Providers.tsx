import { useQuery } from '@tanstack/react-query';
import { getContract, type PublicClient } from 'viem';
import { usePublicClient } from 'wagmi';
import { ASSAY } from '../chain';
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
import { explorer } from '../chain';
import { fmtCountdown, fmtStamp, short } from '../lib/format';
import { Stamp } from '../components/Stamp';
import { HeroBanner } from '../components/HeroBanner';
import { useAtBlock } from '../hooks/useAtBlock';

type SignerRow = { signer: `0x${string}`; tx: `0x${string}` };

async function fetchRegistered(client: PublicClient): Promise<{ rows: SignerRow[]; logsFrom: bigint | null }> {
  const seed: SignerRow = { signer: SEED_SIGNER, tx: REGISTER_TX };
  try {
    const receipt = await client.getTransactionReceipt({ hash: ASSAY_DEPLOY_TX });
    const contract = getContract({ address: ASSAY, abi: assayAbi, client });
    const logs = await contract.getEvents.Registered({}, { fromBlock: receipt.blockNumber, toBlock: 'latest' });
    const seen = new Map<string, SignerRow>();
    seen.set(seed.signer.toLowerCase(), seed);
    for (const l of logs) {
      const signer = l.args.signer;
      if (!signer) continue;
      seen.set(signer.toLowerCase(), { signer, tx: l.transactionHash });
    }
    return { rows: [...seen.values()], logsFrom: receipt.blockNumber };
  } catch {
    return { rows: [seed], logsFrom: null };
  }
}

export function Providers() {
  const client = usePublicClient();
  const events = useQuery({
    queryKey: ['assay-registered', ASSAY],
    enabled: !!client,
    refetchInterval: 15_000,
    retry: 1,
    queryFn: () => fetchRegistered(client as PublicClient),
  });

  const signersKey = events.data?.rows.map((r) => r.signer).join(',') ?? '';
  const snapshot = useAtBlock(
    ['assay-signers', signersKey],
    async (c, block) => {
      const contract = getContract({ address: ASSAY, abi: assayAbi, client: c });
      const rows = events.data?.rows ?? [];
      const states = await Promise.all(
        rows.map(async (r) => {
          const [measurement, expiry] = await contract.read.signers([r.signer], { blockNumber: block });
          const approved = await contract.read.approvedMeasurement([measurement], { blockNumber: block });
          return { ...r, measurement: measurement as `0x${string}`, expiry: expiry as bigint, approved: approved as boolean };
        }),
      );
      const attestationValidity = await contract.read.attestationValidity({ blockNumber: block });
      const channelTimeout = await contract.read.channelTimeout({ blockNumber: block });
      const challengeWindow = await contract.read.challengeWindow({ blockNumber: block });
      return { states, attestationValidity: attestationValidity as bigint, channelTimeout: channelTimeout as bigint, challengeWindow: challengeWindow as bigint };
    },
    !!client && !!events.data,
  );

  const verifiedCount = snapshot.data
    ? snapshot.data.value.states.filter((s) => s.approved && snapshot.data.timestamp <= s.expiry).length
    : undefined;

  return (
    <main>
      <HeroBanner verifiedSigners={verifiedCount} />

      <section className="section" aria-labelledby="prov-h">
        <div className="section-head">
          <h2 id="prov-h">Attested signers</h2>
        </div>
        <p className="sub">
          Each row is a gateway key whose quote the Stylus verifier checked onchain for a measurement on the
          allowlist. Expiry counts from the registration transaction.
        </p>
        {events.isPending && <div className="skel" aria-busy="true">Reading Registered events from Arbitrum Sepolia…</div>}
        {events.isError && (
          <div>
            <p className="note err" role="alert">
              Could not read the <b>Registered</b> event log ({String(events.error)}). The deployment record names
              one registration below; retry to refresh.
            </p>
          </div>
        )}
        {snapshot.isPending && events.data && (
          <div className="skel" aria-busy="true">Reading signer state at the latest block…</div>
        )}
        {snapshot.isError && (
          <p className="note err" role="alert">
            Could not read signer state ({String(snapshot.error)}). <button className="btn-ghost" onClick={() => snapshot.refetch()}>retry</button>
          </p>
        )}
        {snapshot.data && (
          <div>
            <div style={{ marginTop: 12 }}>
              <Stamp block={snapshot.data.block} />
            </div>
            {snapshot.data.value.states.length === 0 ? (
              <div className="empty">
                <h3>No registered signers found</h3>
                <p>
                  No <b>Registered</b> event was found from the Assay deployment block onward, and the deployment
                  record lists none either. A seller registers by calling <b>register</b> with a fresh quote from
                  the legacy attestation endpoint; until that transaction mines, there is nothing to list here.
                </p>
              </div>
            ) : (
              <div className="rows">
                {snapshot.data.value.states.map((s, i) => {
                  const expired = snapshot.data.timestamp > s.expiry;
                  const verified = s.approved && !expired;
                  return (
                    <div className="provider-card" key={s.signer}>
                      <div className="pc-top">
                        <span className="pc-idx">Signer {String(i + 1).padStart(2, '0')}</span>
                        <span
                          className={`verdict ${verified ? 'ok' : 'bad'}`}
                          role="status"
                          aria-label={verified ? 'measurement match, verified' : !s.approved ? 'measurement refused' : 'attestation expired'}
                        >
                          {verified ? 'Verified' : !s.approved ? 'Refused' : 'Expired'}
                        </span>
                      </div>
                      <div className="pc-grid">
                        <div className="pc-side">
                          <div className="lab">Registered measurement (MRTD)</div>
                          <div className="val">{s.measurement}</div>
                          <div className="meta">{s.approved ? 'on the allowlist' : 'NOT on the allowlist'}</div>
                        </div>
                        <span className="pc-arrow" aria-hidden="true">&harr;</span>
                        <div className="pc-side">
                          <div className="lab">Receipt signer</div>
                          <div className="val">
                            <a href={explorer.address(s.signer)} target="_blank" rel="noreferrer">{s.signer}</a>
                          </div>
                          <div className="meta">
                            expires {fmtStamp(s.expiry)} ({fmtCountdown(Number(s.expiry) - Number(snapshot.data.timestamp))})
                          </div>
                        </div>
                      </div>
                      <div className="pc-foot">
                        <span>Short form {short(s.signer)}</span>
                        <a className="tx" href={explorer.tx(s.tx)} target="_blank" rel="noreferrer">
                          registration {short(s.tx)}
                        </a>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {events.data?.logsFrom === null && (
              <p className="note">
                The event log could not be read, so this list shows only the registration named in the deployment
                record ({short(REGISTER_TX)}). Retry logic runs every 15 seconds.
              </p>
            )}
          </div>
        )}
      </section>

      <section className="section" aria-labelledby="verified-h">
        <div className="section-head">
          <h2 id="verified-h">What is verified</h2>
        </div>
        <div className="verified-grid">
          <div>
            <h3>What TDX attestation proves</h3>
            <p>
              The serving gateway booted inside genuine Intel TDX hardware, its quote chains to Intel&apos;s DCAP
              root, and the quote&apos;s measurement registers pin the exact serving image, so the registered signer
              is the gateway&apos;s own receipt key for that measured image.
            </p>
          </div>
          <div>
            <h3>What it does not prove</h3>
            <p>
              That the pinned image loads the model weights the seller advertises, since the quote carries no
              separate weight hash. There is no GPU evidence in this attestation, and TCB or QE identity revocation
              is not checked. A swapped image or a quote that does not chain to Intel&apos;s root fails registration
              before any USDG moves.
            </p>
          </div>
        </div>
      </section>

      <section className="section" aria-labelledby="cfg-h">
        <div className="section-head">
          <h2 id="cfg-h">Contract constants</h2>
        </div>
        <p className="sub">Immutable at construction. Read live where the contract exposes a getter.</p>
        <dl className="kv">
          <dt>Assay</dt>
          <dd className="mono"><a href={explorer.address(ASSAY)} target="_blank" rel="noreferrer">{ASSAY}</a></dd>
          <dt>Stylus verifier</dt>
          <dd className="mono"><a href={explorer.address(VERIFIER_ADDRESS)} target="_blank" rel="noreferrer">{VERIFIER_ADDRESS}</a></dd>
          <dt>USDG</dt>
          <dd className="mono"><a href={explorer.address(USDG_ADDRESS)} target="_blank" rel="noreferrer">{USDG_ADDRESS}</a> <span style={{ color: 'var(--color-dim)' }}>(real Paxos USDG, 6 decimals, EIP-2612 permit)</span></dd>
          <dt>Attestation validity</dt>
          <dd>
            <span className="num">{snapshot.data ? Number(snapshot.data.value.attestationValidity).toLocaleString('en-US') : ATTESTATION_VALIDITY.toLocaleString('en-US')}</span> seconds
            {snapshot.data && <Stamp block={snapshot.data.block} />}
          </dd>
          <dt>Channel timeout</dt>
          <dd>
            <span className="num">{snapshot.data ? Number(snapshot.data.value.channelTimeout).toLocaleString('en-US') : CHANNEL_TIMEOUT.toLocaleString('en-US')}</span> seconds
            {snapshot.data && <Stamp block={snapshot.data.block} />}
          </dd>
          <dt>Challenge window</dt>
          <dd>
            <span className="num">{snapshot.data ? Number(snapshot.data.value.challengeWindow).toLocaleString('en-US') : CHALLENGE_WINDOW.toLocaleString('en-US')}</span> seconds
            <span style={{ color: 'var(--color-dim)' }}> (requestClose to finalizeClose; the provider may still redeem inside it)</span>
            {snapshot.data && <Stamp block={snapshot.data.block} />}
          </dd>
          <dt>Allowlisted measurements</dt>
          <dd className="mono">
            {APPROVED_MEASUREMENTS.map((m) => (
              <div key={m}>{m}</div>
            ))}
          </dd>
        </dl>
      </section>
    </main>
  );
}
