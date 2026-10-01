export function Compare() {
  return (
    <section className="section" aria-labelledby="cmp-h">
      <div className="section-head">
        <h2 id="cmp-h" className="t-section">How it compares</h2>
      </div>
      <div className="twocol">
        <div>
          <h3>Robinhood Agents</h3>
          <p className="prose">
            Announced at HOOD Summit on September 29, 2026. An agent trades in a dedicated brokerage account that holds only the
            funds placed in it, and the customer can require manual approval of each trade. Robinhood states that it does not
            control, supervise, monitor, recommend, or audit agents.
          </p>
          <p className="small" style={{ marginTop: 8 }}>
            Source: <a href="https://robinhood.com/us/en/newsroom/hood-summit-2026/" target="_blank" rel="noreferrer">Robinhood newsroom, HOOD Summit 2026</a>.
          </p>
        </div>
        <div>
          <h3>Chiron</h3>
          <p className="prose">
            The account admits an agent key only after a Stylus verifier checks the agent&apos;s hardware attestation on chain against
            a measurement the owner approved. Every trade then carries a verified receipt naming the model the gateway served,
            inside the owner&apos;s caps.
          </p>
          <p className="small" style={{ marginTop: 8 }}>
            Robinhood does not audit the agent. Chiron verifies its hardware attestation on chain before any trade.
          </p>
        </div>
      </div>
    </section>
  );
}
