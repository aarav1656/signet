import { useState, type ReactNode } from 'react';
import { explorer } from '../chain';

/** "block 313,814,703", linked to the explorer. Every on-chain figure on screen sits next to one. */
export function Stamp({ block, label = 'read at block', url = explorer.block }: { block: bigint; label?: string; url?: (n: bigint) => string }) {
  return (
    <span className="stamp">
      {label}{' '}
      <a href={url(block)} target="_blank" rel="noreferrer">
        {block.toLocaleString('en-US')}
      </a>
    </span>
  );
}

/** A literal hex value: mono at 12px, middle-truncated, full value in the title and one click to copy. */
export function HexValue({ value, head = 4, tail = 4, href }: { value: string; head?: number; tail?: number; href?: string }) {
  const [copied, setCopied] = useState(false);
  const body = value.startsWith('0x') ? value.slice(2) : value;
  const cut = body.length > head + tail + 1;
  const shown = cut ? `${value.startsWith('0x') ? '0x' : ''}${body.slice(0, head)}…${body.slice(-tail)}` : value;
  const text = href ? (
    <a href={href} target="_blank" rel="noreferrer">
      {shown}
    </a>
  ) : (
    shown
  );
  return (
    <span className="hex" title={value}>
      {text}
      <button
        type="button"
        className="copy"
        aria-label={`Copy ${value}`}
        onClick={() => {
          navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </span>
  );
}

/** Code identifiers (function and error names), set in the mono face. */
export function Code({ children }: { children: ReactNode }) {
  return <code className="code">{children}</code>;
}

/** The ruled strip of labelled cells a route opens with: small label over value, ruled cells. */
export function TitleBlock({ cells }: { cells: { label: string; value: ReactNode; tone?: 'signal' | 'alarm'; lead?: boolean; mobileHide?: boolean }[] }) {
  return (
    <dl className="titleblock" style={{ ['--cells' as string]: cells.length }}>
      {cells.map((c) => (
        <div key={c.label} className={['tb-cell', c.tone, c.lead ? 'first' : '', c.mobileHide ? 'm-hide' : ''].filter(Boolean).join(' ')}>
          <dt>{c.label}</dt>
          <dd>{c.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Circled number: a check or step in its true order. */
export function Num({ n, mark = 'pass' }: { n: number; mark?: 'pass' | 'fail' | 'skip' | 'plain' }) {
  return (
    <span className={`n n-${mark}`} aria-hidden="true">
      {n}
    </span>
  );
}

/** A specification line: subject, then hairline-separated facts. */
export function Spec({ subject, children, action }: { subject: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="spec">
      <div className="spec-subject">{subject}</div>
      <div className="spec-facts">{children}</div>
      {action && <div className="spec-action">{action}</div>}
    </div>
  );
}

export function Fact({ label, children, wide }: { label?: string; children: ReactNode; wide?: boolean }) {
  return (
    <span className={wide ? 'fact wide' : 'fact'}>
      {label && <span className="fact-l">{label}</span>}
      {children}
    </span>
  );
}
