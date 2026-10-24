# Signet: the twelve hardest questions

Answers cite the repo as file:line at the commit that holds this file. Where the code does not do something, the answer says what it does instead.

## 1. What stops a creator changing the strategy under the same measurement?

The measurement is keccak256 of nine TD report fields: mr_seam, td_attributes, xfam, MRTD, mr_config_id and RTMR0 to RTMR3 (verifier/src/lib.rs:640-660). On Phala, RTMR3 carries the compose-hash, so a new image digest or a new compose file gives a new measurement, and the account refuses it with MeasurementNotApproved (contracts/src/AgentAccount.sol:265). The image is pinned by digest in agent-cvm/docker-compose.yml:7 and the comment at the top of that file says the pinned fields are measured.

What the measurement does not cover: data the enclave receives after boot. Strategy parameters delivered as sealed environment values or fetched at runtime sit outside it. Signet's position is that this is the correct split. The code that decides what an agent is allowed to do is attested; tunable parameters are not, and the follower's caps and approval threshold are what bound them (AgentAccount.sol:290-293). A creator who wants a record that proves the parameters too puts them in the compose file, and they enter RTMR3. The track record then reads as per measurement, so a changed measurement starts a new record.

## 2. Why a TEE and not zk?

The claim to prove is "this exact private program, with a model call, produced this trade". A zk proof of an LLM-driven trading loop at current proving costs does not fit in a trade's latency or a creator's budget, and a zk proof reveals nothing about which model answered. A TDX quote proves the program identity cheaply, and the model receipt (Phala Ed25519 over request and response hashes) ties the trade to a served model (AgentAccount.sol:399-414). The TEE trust assumption is real and is stated in question 3. The design keeps the verifier replaceable: the account reaches its verifier through the IAssayVerifier interface set at construction (AgentAccount.sol:221-237), so an account created later can point at a different verifier, a zk one included, with the trade path unchanged.

## 3. What if Intel TDX is broken?

A compromised enclave could sign a key for arbitrary code with a valid measurement. Three things limit that in the code. First, per-trade, daily and approval limits are enforced by the account in the same transaction as the swap (AgentAccount.sol:290-293, 371-387), and settlement is checked by balance delta (AgentAccount.sol:428+). Second, the follower can revoke immediately: unapproving the measurement de-admits the agent in that transaction (AgentAccount.sol:526-530) and revokeAgent does it directly (AgentAccount.sol:561). Third, registrations expire after 24 hours (AgentAccount.sol:107).

What the verifier does not do: it checks the PCK chain to Intel's root, the QE report, the quote signature, the PCK validity window and the DEBUG attribute (verifier/src/lib.rs:586, 606), but TCB status, QE identity and CRL checks need live Intel PCCS collateral that the contract does not fetch (verifier/src/lib.rs:25-26, 606-608). A platform whose TCB Intel has since marked out of date is not rejected by the verifier today. The follower's caps are the answer to that residual risk, which is why the product leads with limits as the safety net.

## 4. Who are the first ten users?

Hosted-agent operators who today take a client's key into their own backend. The repo's research names 39 agents hosted by Agents Hood on Robinhood Chain and Bankr routing $178.66M of Robinhood Chain volume in 30 days (README.md:56, sourced there to docs/research/chiron-pivot-verdict.md, which is not in this branch). The first ten are five such operators and five independent agent builders who want a record they can show without publishing the strategy. Distribution is direct: the operator already has the clients, and each client's account is the thing the operator asks them to open. The names and conversations belong in gtm/, which is owned by another lane; this document does not invent them.

## 5. How is this different from Robinhood Agents?

Robinhood Agents is a dedicated agentic account for eligible U.S. customers with trade approvals on by default and user-set limits, and Robinhood's own announcement states it does not control, supervise, monitor, recommend or audit agents (README.md:25). That is the right shape for custody-side controls. It does not answer which software holds the key. Signet is the layer that answers it, onchain and for Stock Tokens on Robinhood Chain: the account trades only for a key whose TDX measurement the owner approved, and every trade event carries that measurement. The two compose: limits from the account holder, identity of the software from the attestation.

## 6. How do you make money?

Today the contracts take no fee. AgentAccount has no protocol take; the swap fee is the pool's fee tier, which goes to liquidity providers (AgentAccount.sol:151, 521). The revenue the model supports is on the operator side: the operator pays for one CVM and for keeping each client's admission fresh, measured at about 2.43 million gas per registerAgent on the testnet (README.md:56), and charges the client for the agent. Signet's business is the hosted attestation service around that: the keeper that renews admissions every 24 hours (agent-cvm/keeper.sh:1-8), measurement publishing and the track-record index, sold per account per month to operators. The pay-per-call inference channel (Assay) is a second place a fee can sit. None of this is charged yet; it is the pricing the GTM canvas should state.

## 7. Why would a follower trust a creator at all?

They do not have to trust the creator's claims, only the chain's. The follower reads TradeExecuted events and sees, per measurement, every trade and its model hash, and then decides whether to approve that measurement. Their downside is capped by what they put in the account and the caps they set. This is the difference from copy-trading: the follower chooses a verified program and a loss budget, not a person.

## 8. Can the creator front-run or trade against followers?

The agent supplies a typed Trade, never calldata, with minOut and a deadline, and the account derives tokenIn and tokenOut from the pool key (AgentAccount.sol:338-352). Only pools the owner allowed and only hookless pools are usable (AgentAccount.sol:510-514). A creator who runs a strategy in the enclave sees the same mempool everyone sees. What an operator running many accounts from one key can do is order their own accounts' trades; that ordering is visible in the events but is not prevented onchain.

## 9. What does the receipt actually prove?

That the model call named in the trade was served under a registered, unexpired Phala gateway key whose own measurement the owner pinned, for the model the owner pinned, and that the request and response hashes were never used before (AgentAccount.sol:399-414). It proves the model call happened and which model answered. It does not prove the trade is a function of that response. The link between the two is the attested program, which is the thing the measurement identifies.

## 10. Is the smart contract code safe enough to hold money?

It is built for it and tested hard, with caveats. The suite is 314 forge tests across 21 suites from a fresh clone, plus 27 agent, 18 receipt-verifier and 22 verifier tests (docs/SECURITY.md:13). A mutation run removes or weakens 110 guards one at a time and 109 are killed; the remaining mutant is documented as behavior-equivalent (docs/security/agent-account-mutations.md:3-7). The account uses OpenZeppelin Ownable2Step and ReentrancyGuardTransient, disables renounceOwnership (AgentAccount.sol:640) and refuses the owner as agent (AgentAccount.sol:270). Reviews so far are internal, by sessions separate from the author (docs/SECURITY.md). There is no third-party audit; it is testnet code, and the mainnet runbook (docs/mainnet-runbook.md) gates deployment.

## 11. Why would an agent builder use this instead of just running a bot?

A bot's record is a screenshot. With Signet the creator gets a record that each follower can verify, so they can raise capital or earn fees against it without revealing the strategy. The cost to the creator is one CVM and keeping the admission fresh, which the keeper automates (agent-cvm/keeper.sh). The creator who has no edge gains nothing, and that is the point: the record exposes that too.

## 12. What happens when a Stock Token has a split or corporate action?

ERC-8056 Stock Tokens publish a multiplier change ahead of time and a pool's price does not move with it. The account blocks the agent from trading a token while a change is pending and for a one-day cooldown after it takes effect, and the owner can still approve a proposal manually (AgentAccount.sol:356-369, 109). This is the guard that a general-purpose agent wallet does not have, and it is why the account is specific to Stock Tokens on Robinhood Chain.
