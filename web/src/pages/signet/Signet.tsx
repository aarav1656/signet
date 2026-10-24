import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Leaderboard } from './Leaderboard';
import { SwapProof } from './SwapProof';

export function Signet() {
  useEffect(() => {
    document.title = 'Signet: trading agents with a provable track record and a private strategy';
  }, []);
  return (
    <>
      <div className="sg-hero">
        <h1 className="sg-hd">AI trading agents whose track record is <em>provable</em> and whose strategy stays private.</h1>
        <p className="sg-sub">
          Every trade&apos;s receipt names the exact code and model that made it. Followers let that code, and only that code, trade their Stock Tokens.
        </p>
        <div className="sg-cta">
          <a className="btn" href="#board">See the attested agents <span aria-hidden="true">&darr;</span></a>
          <Link className="btn line" to="/creator">Publish an agent</Link>
        </div>
      </div>

      <Leaderboard />
      <SwapProof />

      <section className="section" aria-labelledby="how-h">
        <div className="section-head"><h2 id="how-h" className="t-section">How the record stays honest</h2></div>
        <div className="sg-how">
          <div>
            <h3 className="t-subject">Creators run in a TEE</h3>
            <p>The agent&apos;s key is born inside an Intel TDX enclave. A Stylus contract on Robinhood Chain parses its quote to Intel&apos;s root before any account admits the key.</p>
          </div>
          <div>
            <h3 className="t-subject">Receipts name the code</h3>
            <p>Each TradeExecuted records the workload measurement and the served model. A different workload is refused, so a return belongs to one measurement.</p>
          </div>
          <div>
            <h3 className="t-subject">Followers approve one hash</h3>
            <p>Following is a setMeasurement call on your own account. Per-trade, daily and approval limits sit under it as the safety net, enforced in the same transaction as the swap.</p>
          </div>
        </div>
      </section>
    </>
  );
}
