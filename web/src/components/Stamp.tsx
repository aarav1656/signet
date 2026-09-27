import { useEffect, useState } from 'react';
import { explorer } from '../chain';

/** "read at block #312,982,847". Every on-chain number on screen sits next to one of these. */
export function Stamp({ block, label = 'read at block' }: { block: bigint; label?: string }) {
  return (
    <span className="stamp">
      {label}{' '}
      <a href={explorer.block(block)} target="_blank" rel="noreferrer">
        #{block.toLocaleString('en-US')}
      </a>
    </span>
  );
}

/** Byte-grouped hex: 9f 2a c1 … with the 0x prefix dimmed. Truncates past `max`
 *  bytes with an ellipsis; the full value rides in the title attribute. */
export function Hex({ value, max = 20 }: { value: string; max?: number }) {
  const clean = value.startsWith('0x') ? value.slice(2) : value;
  const bytes = clean.match(/../g) ?? [];
  const shown = bytes.slice(0, max);
  const cut = bytes.length > max;
  return (
    <span className={cut ? 'hex trunc' : 'hex'} title={cut ? value : undefined}>
      <span className="pre">0x</span>
      {shown.join(' ')}
      {cut ? ' …' : ''}
    </span>
  );
}

/** Count the readout from 0 to its target over ~500 ms, instantly when the user
 *  prefers reduced motion. */
function useTick(target: bigint | null, duration = 500): bigint | null {
  const [val, setVal] = useState<bigint | null>(null);
  useEffect(() => {
    if (target === null) {
      setVal(null);
      return;
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setVal(target);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / duration);
      setVal(p >= 1 ? target : BigInt(Math.floor(Number(target) * p)));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return val;
}

/** The board's hero instrument: the block every read on this page was taken at.
 *  Giant tabular mono, counted up on load, skeleton bar until the first read
 *  resolves. */
export function BoardFigure({ block, label = 'state read at block' }: { block: bigint | null; label?: string }) {
  const v = useTick(block);
  if (v === null) {
    return (
      <div className="hero-figure" aria-busy="true">
        <span className="hero-label">{label}</span>
        <i className="hero-bar" />
      </div>
    );
  }
  return (
    <div className="hero-figure">
      <span className="hero-label">{label}</span>
      <span className="hero-num num">#{v.toLocaleString('en-US')}</span>
    </div>
  );
}
