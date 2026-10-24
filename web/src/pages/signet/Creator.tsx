import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePublicClient } from 'wagmi';
import { rhcChain, rhcExplorer } from '../../chain';
import { HexValue } from '../../components/Stamp';
import { DEMO_ACCOUNT, OPERATOR_CVM_URL } from '../../lib/rhc.generated';
import { agentByMeasurement, STRATEGIES, strategyById, TRACK } from '../../lib/track';
import { REQUESTED_MODEL_ID, REQUESTED_MODEL_HASH, SERVED_MODEL_ID } from '../../lib/venue';
import { readOperatorQuote, type OperatorQuote } from '../account/operator';
import { cvmError } from './cvmError';
import { agentPath, useVerdict } from './Leaderboard';
import { HashDiff } from './SwapProof';

function ReadMeasurement() {
  const client = usePublicClient({ chainId: rhcChain.id });
  const [url, setUrl] = useState<string>(OPERATOR_CVM_URL);
  const [read, setRead] = useState<OperatorQuote | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const listed = read ? agentByMeasurement(TRACK.agents, read.measurement) : undefined;

  async function check() {
    if (!client) return;
    setBusy(true);
    setErr('');
    setRead(null);
    try {
      // The nonce binds to one account; any account works for reading what the Verifier proves, and nothing is sent.
      setRead(await readOperatorQuote(client as never, url, DEMO_ACCOUNT));
    } catch (e) {
      setErr(cvmError(e, url));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sg-read">
      <div className="fields">
        <div className="field">
          <label className="label" htmlFor="cr-url">Your agent&apos;s CVM</label>
          <input id="cr-url" value={url} onChange={(e) => { setUrl(e.target.value); setRead(null); setErr(''); }} spellCheck={false} />
          <span className="hint">The agent&apos;s HTTPS endpoint on Phala Cloud. It answers <code>POST /quote?account=</code> with an Intel TDX quote.</span>
        </div>
      </div>
      <div className="actions">
        <button className="btn" type="button" disabled={busy || !url.trim() || !client} onClick={check}>{busy ? 'Asking the Verifier' : 'Read its measurement'}</button>
        <span className="small">An eth_call to the Stylus Verifier. Nothing is signed or sent.</span>
      </div>
      {err && <p className="note warn" role="alert">{err}</p>}
      {read && (
        <dl className="kvs sg-read-out">
          <dt>Agent key</dt>
          <dd><HexValue value={read.agent} head={8} tail={6} href={rhcExplorer.address(read.agent)} /></dd>
          <dt>Measurement</dt>
          <dd><HashDiff value={read.measurement} tone="ok" /></dd>
          <dt>Listing</dt>
          <dd>
            {listed
              ? <>Listed with {listed.trades.length} attested {listed.trades.length === 1 ? 'trade' : 'trades'}. <Link to={agentPath(listed.compose ?? listed.measurement)}>Open its profile</Link>.</>
              : 'No trade has landed under this measurement yet. The first one lists it, and the profile page for this measurement opens then.'}
          </dd>
        </dl>
      )}
    </div>
  );
}


const COMPOSE_HASH = /^(?:0x)?([0-9a-fA-F]{64})$/;

function ListingRow({ id }: { id: string }) {
  const s = strategyById(STRATEGIES, id);
  const v = useVerdict(s!);
  return (
    <>
      <dt>Listing</dt>
      <dd>
        Listed as <Link to={agentPath(s!.id)}>{s!.label}</Link> with {s!.trades.length} attested {s!.trades.length === 1 ? 'trade' : 'trades'} across {s!.boots.length} {s!.boots.length === 1 ? 'boot' : 'boots'}.
        Chain check: {v.text}.
      </dd>
    </>
  );
}

/** The strategy a creator publishes is its compose hash and its model. The board lists it the moment a trade under one of its boots lands. */
function PublishStrategy() {
  const [compose, setCompose] = useState('');
  const [model, setModel] = useState(REQUESTED_MODEL_ID);
  const m = COMPOSE_HASH.exec(compose.trim());
  const hash = m ? `0x${m[1].toLowerCase()}` : undefined;
  const listed = hash ? strategyById(STRATEGIES, hash) : undefined;
  const modelHash = model === REQUESTED_MODEL_ID ? REQUESTED_MODEL_HASH : undefined;
  return (
    <div className="sg-read">
      <div className="fields">
        <div className="field">
          <label className="label" htmlFor="cr-compose">Compose hash</label>
          <input id="cr-compose" value={compose} onChange={(e) => setCompose(e.target.value)} spellCheck={false} placeholder="64 hex characters, from your Phala CVM" aria-invalid={compose.trim() !== '' && !hash} />
          <span className="hint">The SHA-256 of your app-compose, which dstack extends into RTMR3. It is the same on every boot of your strategy, so it is what followers recognise.</span>
        </div>
        <div className="field">
          <label className="label" htmlFor="cr-model">Model</label>
          <select id="cr-model" value={model} onChange={(e) => setModel(e.target.value)}>
            <option value={REQUESTED_MODEL_ID}>{REQUESTED_MODEL_ID}</option>
          </select>
          <span className="hint">The id your agent requests. Followers pin keccak256 of it on their account, and every receipt names the model that served it.</span>
        </div>
      </div>
      {compose.trim() !== '' && !hash && <p className="note warn" role="alert">A compose hash is 32 bytes: 64 hexadecimal characters, with or without 0x.</p>}
      {hash && (
        <dl className="kvs sg-read-out">
          <dt>Strategy identity</dt>
          <dd><HashDiff value={hash as `0x${string}`} tone="ok" /></dd>
          <dt>Published model</dt>
          <dd>{model} {modelHash && <HexValue value={modelHash} head={8} tail={6} />}<span className="small"> served as {SERVED_MODEL_ID} on the receipts</span></dd>
          {listed ? <ListingRow id={hash} /> : (
            <>
              <dt>Listing</dt>
              <dd>The first TradeExecuted under any boot of this compose lists it. Each boot has its own measurement; followers approve the newest one, and the profile page for this hash opens then.</dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}

const STEPS: { title: string; body: string }[] = [
  { title: 'Run the agent in a TDX CVM', body: 'The agent generates its trading key inside the enclave and asks the CVM for a quote that commits to that key and to the account it will trade for.' },
  { title: 'Read the measurement', body: 'The Stylus Verifier parses the quote to Intel\'s root and returns the key and the measurement. That 32-byte value is your boot\'s identity. It changes when the code changes and on every boot, while your compose hash stays put.' },
  { title: 'Followers approve it', body: 'A follower\'s account calls setMeasurement with your value. Your key is admitted to that account only against a fresh quote that proves it.' },
  { title: 'Trades list you', body: 'Every TradeExecuted records your measurement and the served model. The track record behind the leaderboard and your profile is generated from those events, so a trade cannot be credited to other code.' },
];

export function Creator() {
  useEffect(() => {
    document.title = 'Signet: publish an agent by proving its code';
  }, []);
  return (
    <>
      <div className="pagehead">
        <h1 className="t-title">Publish an agent by proving its code</h1>
        <p className="lede">Your strategy text is sealed config inside the enclave, and the measured compose pins its SHA-256. What goes on chain is the measurement of your code, the model hash, and hashes of each request and response.</p>
      </div>

      <section className="section" aria-labelledby="cr-read">
        <div className="section-head"><h2 id="cr-read" className="t-section">Your measurement</h2></div>
        <p className="section-intro">Ask your agent for a quote and see what the Verifier proves about it. Each boot has its own measurement; the compose hash is the strategy's stable identity, and a follower approves the latest boot.</p>
        <ReadMeasurement />
      </section>

      <section className="section" aria-labelledby="cr-pub">
        <div className="section-head"><h2 id="cr-pub" className="t-section">Publish your strategy</h2></div>
        <p className="section-intro">A strategy is a compose hash and a model. Enter yours to see how the board identifies it and whether it already has a record.</p>
        <PublishStrategy />
      </section>

      <section className="section" aria-labelledby="cr-how">
        <div className="section-head"><h2 id="cr-how" className="t-section">From enclave to leaderboard</h2></div>
        <ol className="sg-flow">
          {STEPS.map((s, i) => (
            <li key={s.title}>
              <span className="n n-plain" aria-hidden="true">{i + 1}</span>
              <div><h3 className="t-subject">{s.title}</h3><p>{s.body}</p></div>
            </li>
          ))}
        </ol>
      </section>

      <section className="section sg-split" aria-labelledby="cr-sealed">
        <div>
          <h2 id="cr-sealed" className="t-section">What stays sealed, what is public</h2>
          <dl className="kvs">
            <dt>Sealed in the enclave</dt>
            <dd>The strategy text: its prompt, parameters and rules. The enclave refuses to boot unless it hashes to the SHA-256 pinned in the measured compose.</dd>
            <dt>On chain</dt>
            <dd>The measurement, the requested and served model hashes, the SHA-256 of each request and response body, and the trade itself.</dd>
            <dt>Checked by the account</dt>
            <dd>A different measurement is refused with MeasurementNotApproved. A receipt naming another model reverts ModelMismatch.</dd>
          </dl>
        </div>
        <div>
          <h2 className="t-section">Business model</h2>
          <p className="prose">
            Creators earn a performance fee, a share of the profit a follower&apos;s account makes through their code, charged above the follower&apos;s
            high-water mark so a creator is paid only for new profit. The fee is a term between creator and follower and settles as a transfer the
            follower&apos;s owner signs. The account contracts enforce the code, the model and the limits.
          </p>
          <p className="prose">
            Signet earns a share of that fee for the listing, the verification and the follow flow.
          </p>
        </div>
      </section>
    </>
  );
}
