import { describe, expect, it } from 'vitest';
import { filterAllowedConnectors, walletLabel, connectHint } from './Wallet';

const conn = (rdns?: string | string[]) => ({ rdns });

describe('filterAllowedConnectors', () => {
  it('drops wallets outside the allowlist', () => {
    const out = filterAllowedConnectors([
      conn('io.rabby'),
      conn('com.evil.phish'),
      conn(undefined),
    ]);
    expect(out.map((c) => c.rdns)).toEqual(['io.rabby']);
  });

  it('orders by the allowlist, not discovery order', () => {
    const out = filterAllowedConnectors([
      conn('app.phantom'),
      conn('com.coinbase.wallet'),
      conn('io.metamask'),
      conn('io.rabby'),
    ]);
    expect(out.map((c) => c.rdns)).toEqual([
      'io.rabby',
      'io.metamask',
      'com.coinbase.wallet',
      'app.phantom',
    ]);
  });

  it('returns empty when nothing is allowlisted', () => {
    expect(filterAllowedConnectors([conn('com.evil.phish')])).toEqual([]);
    expect(filterAllowedConnectors([])).toEqual([]);
  });

  it('matches a multi-rdns connector on its allowlisted entry', () => {
    const out = filterAllowedConnectors([conn(['com.evil.phish', 'io.metamask'])]);
    expect(out).toHaveLength(1);
  });
});

describe('wagmi EIP-6963 connectors', () => {
  it('are matched by id, which wagmi sets to the rdns, and generic injected is hidden', () => {
    const out = filterAllowedConnectors([{ id: 'injected' }, { id: 'app.phantom' }, { id: 'io.rabby' }, { id: 'com.evil.phish' }]);
    expect(out.map((c) => c.id)).toEqual(['io.rabby', 'app.phantom']);
  });
});

describe('walletLabel', () => {
  it('names each allowlisted wallet', () => {
    expect(walletLabel('io.rabby')).toBe('Rabby');
    expect(walletLabel('io.metamask')).toBe('MetaMask');
    expect(walletLabel('com.coinbase.wallet')).toBe('Coinbase Wallet');
    expect(walletLabel('app.phantom')).toBe('Phantom');
  });
});

describe('connectHint', () => {
  it('tells the person to unlock and approve on a 4001, including a wrapped one', () => {
    expect(connectHint({ code: 4001 }, 'Rabby')).toMatch(/Open Rabby, unlock it if it is locked, approve the connection/);
    expect(connectHint({ message: 'x', cause: { code: 4001 } }, 'Rabby')).toMatch(/unlock it/);
  });
  it('points at the waiting request on -32002', () => {
    expect(connectHint({ code: -32002 }, 'MetaMask')).toMatch(/already waiting in MetaMask/);
  });
  it('never falls back to a bare failure line', () => {
    expect(connectHint(new Error('boom'), 'Rabby')).toMatch(/Open Rabby, check it is unlocked/);
  });
});
