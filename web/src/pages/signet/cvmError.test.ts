import { describe, expect, it } from 'vitest';
import { cvmError } from './cvmError';

describe('cvmError', () => {
  it('names the host when the fetch itself failed', () => {
    expect(cvmError(new TypeError('Failed to fetch'), 'https://abc-8080.dstack-pha-prod5.phala.network')).toContain('abc-8080.dstack-pha-prod5.phala.network');
    expect(cvmError(new TypeError('fetch failed'), 'not a url')).toContain('not a url');
  });
  it('passes a Verifier or CVM answer through untouched', () => {
    expect(cvmError(new Error('The Verifier proves key 0xaa, but the CVM reports 0xbb\nmore'), 'https://x')).toBe('The Verifier proves key 0xaa, but the CVM reports 0xbb');
  });
});
