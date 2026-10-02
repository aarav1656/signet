import { useEffect, useState, type ReactNode } from 'react';

/// Robinhood's Stock Token terms (robinhood.com/rhj/stocktokens): Stock Tokens "may not be offered,
/// sold, or delivered, directly or indirectly, in the United States or to, or for the account or
/// benefit of, U.S. persons", and Canada, the UK, Switzerland and the UAE are restricted. An account
/// here holds and trades Stock Tokens, so creating, funding and configuring one waits on an explicit
/// answer. Reading the chain does not. "US person" is stored and keeps the actions closed.
const KEY = 'chiron:stock-token-eligibility';
const EVENT = 'chiron-eligibility';
type Answer = 'clear' | 'excluded';

const read = (): Answer | undefined => {
  const v = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
  return v === 'clear' || v === 'excluded' ? v : undefined;
};

function useEligibility() {
  const [answer, setAnswer] = useState<Answer | undefined>(read);
  useEffect(() => {
    const sync = () => setAnswer(read());
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, []);
  const record = (a: Answer) => {
    localStorage.setItem(KEY, a);
    window.dispatchEvent(new Event(EVENT));
  };
  return { answer, record };
}

export function EligibilityGate({ children }: { children: ReactNode }) {
  const { answer, record } = useEligibility();
  if (answer === 'clear') return <>{children}</>;
  if (answer === 'excluded') {
    return (
      <p className="note gate-note" role="status">
        This device answered that it is a US person or a person of Canada, the UK, Switzerland or the UAE. Robinhood&apos;s Stock Token
        terms exclude them, so creating, funding and configuring an account stays closed here. Every chain read on this page stays open.
      </p>
    );
  }
  return (
    <div className="gate-ask" role="group" aria-labelledby="elig-h">
      <p id="elig-h" className="gate-q">
        An account holds and trades Robinhood Stock Tokens. Robinhood&apos;s{' '}
        <a href="https://robinhood.com/rhj/stocktokens/" target="_blank" rel="noreferrer">Stock Token terms</a> exclude US persons, and persons
        of Canada, the UK, Switzerland and the UAE.
      </p>
      <div className="actions">
        <button className="btn" type="button" onClick={() => record('clear')}>
          I am not a US person, and not a person of Canada, the UK, Switzerland or the UAE
        </button>
        <button className="btn line" type="button" onClick={() => record('excluded')}>
          I am a US person, or a person of one of those places
        </button>
      </div>
    </div>
  );
}
