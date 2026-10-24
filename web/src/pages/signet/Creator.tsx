import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePublicClient } from 'wagmi';
import { rhcChain, rhcExplorer } from '../../chain';
import { HexValue } from '../../components/Stamp';
import { DEMO_ACCOUNT, OPERATOR_CVM_URL } from '../../lib/rhc.generated';
import { agentByMeasurement, TRACK } from '../../lib/track';
import { readOperatorQuote, type OperatorQuote } from '../account/operator';
import { cvmError } from './cvmError';
import { agentPath } from './Leaderboard';
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
              ? <>Listed with {listed.trades.length} attested {listed.trades.length === 1 ? 'trade' : 'trades'}. <Link to={agentPath(listed.measurement)}>Open its profile</Link>.</>
              : 'No trade has landed under this measurement yet. The first one lists it, and the profile page for this measurement opens then.'}
          </dd>
        </dl>
      )}
    </div>
  );
}

const STEPS: { title: string; body: string }[] = [
  { title: 'Run the agent in a TDX CVM', body: 'The agent generates its trading key inside the enclave and asks the CVM for a quote that commits to that key and to the account it will trade for.' },
  { title: 'Read the measurement', body: 'The Stylus Verifier parses the quote to Intel\'s root and returns the key and the measurement. That 32-byte value is your agent\'s identity. It changes when the code changes.' },
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
        <p className="lede">Your prompts and strategy stay sealed in the enclave. What goes on chain is the measurement of your code, the model hash, and hashes of each request and response.</p>
      </div>

      <section className="section" aria-labelledby="cr-read">
        <div className="section-head"><h2 id="cr-read" className="t-section">Your measurement</h2></div>
        <p className="section-intro">Ask your agent for a quote and see what the Verifier proves about it. This is the value followers approve.</p>
        <ReadMeasurement />
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
            <dd>The prompt, the strategy logic, the model&apos;s inputs and its reasoning.</dd>
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
            follower&apos;s owner signs. The account contracts enforce the code, the model and the limits; they do not collect the fee.
          </p>
          <p className="prose">
            Signet earns a share of that fee for the listing, the verification and the follow flow.
          </p>
        </div>
      </section>
    </>
  );
}
