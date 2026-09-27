// Live gateway-signer check: signers(address) plus approvedMeasurement(bytes32)
// on the deployed Assay contract. Reused before every call (behaviour 1) and
// before every payment (behaviour 2, over the real recovered enclave signer).
import type { Address, PublicClient } from 'viem';
import { assayAbi } from '../../web/src/abi/Assay.generated.ts';
import { assay as assayAddress } from './config.ts';

export type GatewaySignerStatus = {
  signer: Address;
  measurement: `0x${string}`;
  expiry: bigint;
  now: bigint;
  registered: boolean;
  approved: boolean;
  unexpired: boolean;
  ok: boolean;
};

export async function checkGatewaySigner(client: PublicClient, signer: Address): Promise<GatewaySignerStatus> {
  const [[measurement, expiry], block] = await Promise.all([
    client.readContract({ address: assayAddress, abi: assayAbi, functionName: 'signers', args: [signer] }),
    client.getBlock(),
  ]);
  const now = block.timestamp;
  const zeroMeasurement = `0x${'0'.repeat(64)}`;
  const registered = measurement !== zeroMeasurement;
  const approved = registered
    ? await client.readContract({ address: assayAddress, abi: assayAbi, functionName: 'approvedMeasurement', args: [measurement] })
    : false;
  const unexpired = registered && now <= expiry;
  return {
    signer,
    measurement,
    expiry,
    now,
    registered,
    approved,
    unexpired,
    ok: registered && approved && unexpired,
  };
}

export function explainRefusal(status: GatewaySignerStatus): string {
  if (!status.registered) return `signer ${status.signer} is not registered on Chiron (signers() returned an empty measurement)`;
  if (!status.approved) return `signer ${status.signer} has measurement ${status.measurement}, which is not on the approved-measurement allowlist`;
  if (!status.unexpired) return `signer ${status.signer} attestation expired at ${status.expiry} (now ${status.now})`;
  return `signer ${status.signer} is registered, approved and unexpired`;
}
