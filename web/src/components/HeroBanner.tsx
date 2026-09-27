import { ASSAY } from '../chain';
import { assayAbi } from '../abi/Assay.generated';
import { fmtUsdg } from '../lib/format';
import { useAtBlock } from '../hooks/useAtBlock';
import { Stamp } from './Stamp';

type ChannelTotals = { totalSettled: bigint; openCount: number; channelCount: number };

/**
 * Page-level helper (not a hook in src/hooks): sums every channel's cumulative `paid`
 * (the contract's own settlement bookkeeping, monotonic per channel) and counts
 * channels still open. Reads channelCount() then every channels(i) at one pinned
 * block via the existing useAtBlock composition.
 */
function useChannelTotals() {
  return useAtBlock<ChannelTotals>(['assay-channel-totals', ASSAY], async (client, block) => {
    const count = (await client.readContract({
      address: ASSAY,
      abi: assayAbi,
      functionName: 'channelCount',
      blockNumber: block,
    })) as bigint;
    const n = Number(count);
    const rows = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        client.readContract({ address: ASSAY, abi: assayAbi, functionName: 'channels', args: [BigInt(i)], blockNumber: block }),
      ),
    );
    let totalSettled = 0n;
    let openCount = 0;
    for (const raw of rows) {
      const [, , , paid, , , , closed] = raw as unknown as readonly [
        string, string, bigint, bigint, bigint, bigint, bigint, boolean,
      ];
      totalSettled += paid;
      if (!closed) openCount += 1;
    }
    return { totalSettled, openCount, channelCount: n };
  });
}

/**
 * Portal-style blue promo banner (arbitrum-portal "Start Earning Today" pattern):
 * headline copy on the left, a small dark UI-within-UI stat device on the right,
 * carrying live chain-read figures instead of the portal's illustrative APY mockup.
 */
export function HeroBanner({ verifiedSigners }: { verifiedSigners?: number }) {
  const totals = useChannelTotals();
  return (
    <section className="hero-banner">
      <div className="hero-banner-copy">
        <h1>Registered providers</h1>
        <p>
          Chiron settles USDG in payment channels once a provider&apos;s Intel TDX quote verifies onchain. The
          figures beside this are read live from the Assay contract on Arbitrum Sepolia, not a cached index.
        </p>
      </div>
      <div className="device hero-banner-device">
        <h3>Live on Arbitrum Sepolia</h3>
        <div className="stat">
          <div className="lab">Verified signers</div>
          <div className="val num">{verifiedSigners ?? '…'}</div>
        </div>
        <div className="stat">
          <div className="lab">USDG settled</div>
          <div className="val num">{totals.data ? fmtUsdg(totals.data.value.totalSettled) : '…'}</div>
        </div>
        <div className="stat">
          <div className="lab">Channels open</div>
          <div className="val num">{totals.data ? totals.data.value.openCount : '…'}</div>
        </div>
        {totals.data && <Stamp block={totals.data.block} />}
      </div>
    </section>
  );
}
