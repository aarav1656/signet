// Source of truth for everything onchain:
//   addresses + register tx: contracts/deployments/421614.json
//   ABI: contracts/out/Assay.sol/Assay.json (field "abi").
// Agent account on Robinhood Chain testnet:
//   addresses + tx hashes: contracts/deployments/46630.json
//   ABI: contracts/out/AgentAccount.sol and AgentAccountFactory.sol (forge inspect equivalents).
// Run: npm run sync
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const contractsRoot = join(webRoot, '..', 'contracts');

const depRaw = readFileSync(join(contractsRoot, 'deployments', '421614.json'), 'utf8');
const dep = JSON.parse(depRaw);
const assay = dep.contracts?.Assay;
const verifier = dep.contracts?.Verifier;
// The token Assay is bound to is its immutable usdg_ constructor arg; pick the entry with that address.
const usdg = Object.values(dep.contracts ?? {}).find(
  (c) => c?.address && c.address.toLowerCase() === assay?.constructorArgs?.usdg_?.toLowerCase(),
);
if (!assay?.address || !verifier?.address || !usdg?.address) {
  throw new Error('deployments/421614.json is missing Assay, Verifier, or the token at Assay.constructorArgs.usdg_');
}

const abiRaw = readFileSync(join(contractsRoot, 'out', 'Assay.sol', 'Assay.json'), 'utf8');
const { abi } = JSON.parse(abiRaw);
if (!Array.isArray(abi)) throw new Error('Expected field "abi" to be an array in Assay.json');

const cycle = dep.liveCycle_wp12_realUSDG ?? dep.liveCycle;
const seedSigner = cycle?.register?.signer ?? cycle?.quoteVerifierDryRunCheck?.returnedSigner;
const registerTx = cycle?.register?.tx;
if (!seedSigner || !registerTx) {
  throw new Error('deployments/421614.json liveCycle is missing register.signer or register.tx');
}

mkdirSync(join(webRoot, 'src', 'abi'), { recursive: true });
mkdirSync(join(webRoot, 'src', 'lib'), { recursive: true });

const abiOut = `// Generated from contracts/out/Assay.sol/Assay.json - do not edit by hand.\n// Regenerate with: npm run sync\n\nexport const assayAbi = ${JSON.stringify(abi)} as const;\n`;
writeFileSync(join(webRoot, 'src', 'abi', 'Assay.generated.ts'), abiOut);

const addrOut = `// Generated from contracts/deployments/421614.json - do not edit by hand.\n// Regenerate with: npm run sync\nimport type { Address } from 'viem';\n\nexport const CHAIN_ID = ${dep.chainId} as const;\nexport const RPC_URL = ${JSON.stringify(dep.rpc)} as const;\nexport const EXPLORER_URL = 'https://sepolia.arbiscan.io' as const;\nexport const ASSAY_ADDRESS = ${JSON.stringify(assay.address)} as Address;\nexport const VERIFIER_ADDRESS = ${JSON.stringify(verifier.address)} as Address;\nexport const USDG_ADDRESS = ${JSON.stringify(usdg.address)} as Address;\nexport const USDG_DECIMALS = ${usdg.decimals} as const;\nexport const ASSAY_DEPLOY_TX = ${JSON.stringify(assay.deployTx)} as const;\nexport const REGISTER_TX = ${JSON.stringify(registerTx)} as const;\nexport const SEED_SIGNER = ${JSON.stringify(seedSigner)} as Address;\nexport const APPROVED_MEASUREMENTS = ${JSON.stringify(assay.constructorArgs.approvedMeasurements_)} as readonly \`0x\${string}\`[];\nexport const ATTESTATION_VALIDITY = ${assay.constructorArgs.attestationValidity_} as const;\nexport const CHANNEL_TIMEOUT = ${assay.constructorArgs.channelTimeout_} as const;\nexport const CHALLENGE_WINDOW = ${assay.constructorArgs.challengeWindow_} as const;\n`;
writeFileSync(join(webRoot, 'src', 'lib', 'addresses.generated.ts'), addrOut);

console.log(`wrote src/abi/Assay.generated.ts (${abi.length} ABI entries)`);
console.log(`wrote src/lib/addresses.generated.ts (assay ${assay.address})`);

// ---- AgentAccount on Robinhood Chain testnet (46630) ----
const rhc = JSON.parse(readFileSync(join(contractsRoot, 'deployments', '46630.json'), 'utf8'));
const need = ['AgentAccount', 'AgentAccountFactory', 'Assay', 'TestUSDG', 'TSLA', 'PoolManager', 'Verifier', 'ReceiptVerifier'];
for (const k of need) if (!rhc.contracts?.[k]) throw new Error(`deployments/46630.json is missing contracts.${k}`);
const registerStep = rhc.liveCycle?.find((x) => x.step?.startsWith('Assay.register ('));
if (!registerStep || !rhc.gatewayMeasurement || !rhc.modelId || !rhc.block) {
  throw new Error('deployments/46630.json is missing the gateway register step, gatewayMeasurement, modelId or block');
}
// Calls the account refused (reverted): a revert emits no log, so the web reads these hashes from the explorer.
const refusalTxs = [...(rhc.liveCycle ?? []), ...(rhc.revokeDemo ?? [])].filter((x) => /execute/.test(x.step) && /revert/i.test(x.step)).map((x) => x.hash);
if (refusalTxs.length === 0) throw new Error('deployments/46630.json names no reverted execute transaction');
const abiOf = (name) => {
  const j = JSON.parse(readFileSync(join(contractsRoot, 'out', `${name}.sol`, `${name}.json`), 'utf8'));
  if (!Array.isArray(j.abi)) throw new Error(`${name}.json has no abi array`);
  return j.abi;
};
const accountAbi = abiOf('AgentAccount');
const factoryAbi = abiOf('AgentAccountFactory');
writeFileSync(
  join(webRoot, 'src', 'abi', 'AgentAccount.generated.ts'),
  `// Generated from contracts/out/AgentAccount.sol and AgentAccountFactory.sol - do not edit by hand.\n// Regenerate with: npm run sync\n\nexport const accountAbi = ${JSON.stringify(accountAbi)} as const;\n\nexport const factoryAbi = ${JSON.stringify(factoryAbi)} as const;\n`,
);
const c = rhc.contracts;
writeFileSync(
  join(webRoot, 'src', 'lib', 'rhc.generated.ts'),
  `// Generated from contracts/deployments/46630.json - do not edit by hand.
// Regenerate with: npm run sync
import type { Address } from 'viem';

export const RHC_CHAIN_ID = ${rhc.chainId} as const;
export const RHC_EXPLORER_URL = ${JSON.stringify(rhc.explorer)} as const;
export const RHC_DEPLOY_BLOCK = ${rhc.block}n;
export const DEMO_ACCOUNT = ${JSON.stringify(c.AgentAccount)} as Address;
export const FACTORY = ${JSON.stringify(c.AgentAccountFactory)} as Address;
export const RHC_ASSAY = ${JSON.stringify(c.Assay)} as Address;
export const TEST_USDG = ${JSON.stringify(c.TestUSDG)} as Address;
export const TSLA = ${JSON.stringify(c.TSLA)} as Address;
export const RHC_VERIFIER = ${JSON.stringify(c.Verifier)} as Address;
export const RHC_RECEIPT_VERIFIER = ${JSON.stringify(c.ReceiptVerifier)} as Address;
export const GATEWAY_MEASUREMENT = ${JSON.stringify(rhc.gatewayMeasurement)} as \`0x\${string}\`;
export const MODEL_ID = ${JSON.stringify(rhc.modelId)} as const;
export const GATEWAY_REGISTER_TX = ${JSON.stringify(registerStep.hash)} as const;
export const RHC_REFUSAL_TXS = ${JSON.stringify(refusalTxs)} as readonly \`0x\${string}\`[];
`,
);
console.log(`wrote src/abi/AgentAccount.generated.ts (${accountAbi.length} + ${factoryAbi.length} ABI entries)`);
console.log(`wrote src/lib/rhc.generated.ts (account ${c.AgentAccount})`);
