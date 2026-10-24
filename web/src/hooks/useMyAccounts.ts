import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';
import { useConnection, usePublicClient } from 'wagmi';
import { factoryAbi } from '../abi/AgentAccount.generated';
import { rhcChain } from '../chain';
import { inWindows } from '../lib/logs';
import { FACTORIES, RHC_DEPLOY_BLOCK } from '../lib/rhc.generated';

/** Every account the connected wallet owns, from the AccountCreated stream of all factories. */
export function useMyAccounts() {
  const conn = useConnection();
  const client = usePublicClient({ chainId: rhcChain.id });
  return useQuery({
    queryKey: ['mine', conn.address],
    enabled: !!conn.address && !!client,
    refetchInterval: 15_000,
    queryFn: async (): Promise<Address[]> => {
      const head = await client!.getBlockNumber();
      const logs = await Promise.all(
        FACTORIES.map((address) =>
          inWindows(RHC_DEPLOY_BLOCK, head, (fromBlock, toBlock) =>
            client!.getContractEvents({ address, abi: factoryAbi, eventName: 'AccountCreated', args: { owner: conn.address }, fromBlock, toBlock }),
          ),
        ),
      );
      return logs.flat().map((l) => l.args.account as Address);
    },
  });
}
