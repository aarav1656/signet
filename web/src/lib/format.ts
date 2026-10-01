import { formatUnits } from 'viem';
import { USDG_DECIMALS } from './addresses.generated';

const usd6 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** USDG 6dp -> "100.00". */
export const fmtUsdg = (v: bigint) => usd6.format(Number(formatUnits(v, USDG_DECIMALS)));

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** "2026-09-26 13:50:11 UTC", or "never" for zero. */
export function fmtStamp(sec: bigint | number): string {
  if (Number(sec) === 0) return 'never';
  return new Date(Number(sec) * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

/** Signed countdown: "23h 59m 01s" or "expired 1h 02m ago". */
export function fmtCountdown(deltaSec: number): string {
  const neg = deltaSec < 0;
  let s = Math.abs(Math.floor(deltaSec));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  const body = d > 0 ? `${d}d ${pad(h)}h ${pad(m)}m` : `${pad(h)}h ${pad(m)}m ${pad(s)}s`;
  return neg ? `expired ${body} ago` : body;
}

/** Any token amount in its own decimals: "104.00", "1.0001", "0.01". */
export function fmtToken(v: bigint, decimals: number): string {
  const [whole, frac = ''] = formatUnits(v, decimals).split('.');
  return `${BigInt(whole).toLocaleString('en-US')}.${frac.slice(0, 6).replace(/0+$/, '').padEnd(2, '0')}`;
}
