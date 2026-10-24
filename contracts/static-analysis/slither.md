**THIS CHECKLIST IS NOT COMPLETE**. Use `--show-ignored-findings` to show all the results.
Summary
 - [weak-prng](#weak-prng) (1 results) (High)
 - [reentrancy-balance](#reentrancy-balance) (3 results) (High)
 - [uninitialized-state](#uninitialized-state) (1 results) (High)
 - [reentrancy-no-eth](#reentrancy-no-eth) (5 results) (Medium)
 - [uninitialized-local](#uninitialized-local) (1 results) (Medium)
 - [unused-return](#unused-return) (7 results) (Medium)
 - [missing-zero-check](#missing-zero-check) (6 results) (Low)
 - [reentrancy-benign](#reentrancy-benign) (11 results) (Low)
 - [timestamp](#timestamp) (14 results) (Low)
 - [cyclomatic-complexity](#cyclomatic-complexity) (3 results) (Informational)
 - [low-level-calls](#low-level-calls) (4 results) (Informational)
## weak-prng
Impact: High
Confidence: Medium
 - [ ] ID-0
[AgentAccount._spendWindow(address,uint128,uint128)](src/AgentAccount.sol#L412-L427) uses a weak PRNG: "[slot = w[h % WINDOW_HOURS]](src/AgentAccount.sol#L421)" 

src/AgentAccount.sol#L412-L427


## reentrancy-balance
Impact: High
Confidence: Medium
 - [ ] ID-1
Reentrancy in [ChironGate._claimAndForward(IX402BatchSettlement.VoucherClaim,bytes32,address,address)](src/ChironGate.sol#L176-L199):
	External call allowing reentrancy:
	- [x402.settle(address(this),token)](src/ChironGate.sol#L193)
	Balance read before the call:
	- [gateBefore = IERC20(token).balanceOf(address(this))](src/ChironGate.sol#L192)
	Possible stale balance used after the call in a condition:
	- [IERC20(token).balanceOf(address(this)) - gateBefore != paid](src/ChironGate.sol#L194)
		- stale variable `gateBefore`

src/ChironGate.sol#L176-L199


 - [ ] ID-2
Reentrancy in [AgentAccount._swap(AgentAccount.Trade,address,address)](src/AgentAccount.sol#L469-L479):
	External call allowing reentrancy:
	- [poolManager.unlock(abi.encode(t.key,t.zeroForOne,t.amountIn))](src/AgentAccount.sol#L473)
	Balance read before the call:
	- [outBefore = IERC20(tokenOut).balanceOf(address(this))](src/AgentAccount.sol#L471)
	Possible stale balance used after the call in a condition:
	- [got < t.minOut](src/AgentAccount.sol#L478)
		- stale variable `got`

src/AgentAccount.sol#L469-L479


 - [ ] ID-3
Reentrancy in [AgentAccount._swap(AgentAccount.Trade,address,address)](src/AgentAccount.sol#L469-L479):
	External call allowing reentrancy:
	- [poolManager.unlock(abi.encode(t.key,t.zeroForOne,t.amountIn))](src/AgentAccount.sol#L473)
	Balance read before the call:
	- [inBefore = IERC20(tokenIn).balanceOf(address(this))](src/AgentAccount.sol#L470)
	Possible stale balance used after the call in a condition:
	- [spent > t.amountIn](src/AgentAccount.sol#L476)
		- stale variable `spent`

src/AgentAccount.sol#L469-L479


## uninitialized-state
Impact: High
Confidence: High
 - [ ] ID-4
[AgentAccount.window](src/AgentAccount.sol#L142) is never initialized. It is used in:
	- [AgentAccount._spendWindow(address,uint128,uint128)](src/AgentAccount.sol#L412-L427)
	- [AgentAccount.windowUsed(address)](src/AgentAccount.sol#L430-L436)

src/AgentAccount.sol#L142


## reentrancy-no-eth
Impact: Medium
Confidence: Medium
 - [ ] ID-5
Reentrancy in [Assay.registerReceiptKey(bytes,bytes,uint256,bytes32)](src/Assay.sol#L277-L292):
	External calls:
	- [measurement = verifier.verifyKeyset(quote,keysetBytes,nonce,pubkey)](src/Assay.sol#L285)
	State variables written after the call(s):
	- [registerNonce[msg.sender] += 1](src/Assay.sol#L288)
	[Assay.registerNonce](src/Assay.sol#L98) can be used in cross function reentrancies:
	- [Assay.nextRegisterNonce(address,uint256)](src/Assay.sol#L236-L240)
	- [Assay.registerNonce](src/Assay.sol#L98)
	- [usedQuote[quoteHash] = true](src/Assay.sol#L287)
	[Assay.usedQuote](src/Assay.sol#L101) can be used in cross function reentrancies:
	- [Assay.usedQuote](src/Assay.sol#L101)

src/Assay.sol#L277-L292


 - [ ] ID-6
Reentrancy in [Assay.redeemWithReceipt(uint256,uint256,bytes32,bytes32,bytes,bytes32,bytes,bytes)](src/Assay.sol#L439-L489):
	External calls:
	- [(ok,requestedModelHash,servedModelHash,receiptRequestHash,receiptResponseHash) = receiptVerifier.verifyReceipt(pubkey,receiptBytes,signature)](src/Assay.sol#L461-L467)
	State variables written after the call(s):
	- [c.paid = uint128(cumulativeAmount)](src/Assay.sol#L481)
	[Assay.channels](src/Assay.sol#L103) can be used in cross function reentrancies:
	- [Assay.channels](src/Assay.sol#L103)
	- [c.lastActivityAt = uint64(block.timestamp)](src/Assay.sol#L483)
	[Assay.channels](src/Assay.sol#L103) can be used in cross function reentrancies:
	- [Assay.channels](src/Assay.sol#L103)
	- [consumedReceipt[receiptKey] = true](src/Assay.sol#L482)
	[Assay.consumedReceipt](src/Assay.sol#L112) can be used in cross function reentrancies:
	- [Assay.consumedReceipt](src/Assay.sol#L112)

src/Assay.sol#L439-L489


 - [ ] ID-7
Reentrancy in [AgentAccount.registerAgent(bytes,uint256)](src/AgentAccount.sol#L276-L286):
	External calls:
	- [(signer,measurement) = verifier.verify(quote,attestNonce(refBlock))](src/AgentAccount.sol#L284)
	State variables written after the call(s):
	- [_admit(signer,measurement,quoteHash)](src/AgentAccount.sol#L285)
		- [epoch = ++ agentEpoch](src/AgentAccount.sol#L314)
	[AgentAccount.agentEpoch](src/AgentAccount.sol#L122) can be used in cross function reentrancies:
	- [AgentAccount._revokeAgent()](src/AgentAccount.sol#L622-L629)
	- [AgentAccount.agentEpoch](src/AgentAccount.sol#L122)
	- [AgentAccount.attestNonce(uint256)](src/AgentAccount.sol#L270-L272)
	- [_admit(signer,measurement,quoteHash)](src/AgentAccount.sol#L285)
		- [usedQuote[quoteHash] = true](src/AgentAccount.sol#L313)
	[AgentAccount.usedQuote](src/AgentAccount.sol#L124) can be used in cross function reentrancies:
	- [AgentAccount.usedQuote](src/AgentAccount.sol#L124)

src/AgentAccount.sol#L276-L286


 - [ ] ID-8
Reentrancy in [AgentAccount.registerAgentWithCollateral(bytes,uint256,bytes)](src/AgentAccount.sol#L293-L307):
	External calls:
	- [(signer,measurement,status) = ICollateralVerifier(address(verifier)).verifyWithCollateral(quote,attestNonce(refBlock),collateral,maxTcbStatus,minTcbEvaluation)](src/AgentAccount.sol#L301-L303)
	State variables written after the call(s):
	- [_admit(signer,measurement,quoteHash)](src/AgentAccount.sol#L305)
		- [epoch = ++ agentEpoch](src/AgentAccount.sol#L314)
	[AgentAccount.agentEpoch](src/AgentAccount.sol#L122) can be used in cross function reentrancies:
	- [AgentAccount._revokeAgent()](src/AgentAccount.sol#L622-L629)
	- [AgentAccount.agentEpoch](src/AgentAccount.sol#L122)
	- [AgentAccount.attestNonce(uint256)](src/AgentAccount.sol#L270-L272)
	- [_admit(signer,measurement,quoteHash)](src/AgentAccount.sol#L305)
		- [usedQuote[quoteHash] = true](src/AgentAccount.sol#L313)
	[AgentAccount.usedQuote](src/AgentAccount.sol#L124) can be used in cross function reentrancies:
	- [AgentAccount.usedQuote](src/AgentAccount.sol#L124)

src/AgentAccount.sol#L293-L307


 - [ ] ID-9
Reentrancy in [Assay.register(bytes,uint256)](src/Assay.sol#L252-L263):
	External calls:
	- [(signer,measurement) = verifier.verify(quote,nonce)](src/Assay.sol#L256)
	State variables written after the call(s):
	- [registerNonce[msg.sender] += 1](src/Assay.sol#L259)
	[Assay.registerNonce](src/Assay.sol#L98) can be used in cross function reentrancies:
	- [Assay.nextRegisterNonce(address,uint256)](src/Assay.sol#L236-L240)
	- [Assay.registerNonce](src/Assay.sol#L98)
	- [usedQuote[quoteHash] = true](src/Assay.sol#L258)
	[Assay.usedQuote](src/Assay.sol#L101) can be used in cross function reentrancies:
	- [Assay.usedQuote](src/Assay.sol#L101)

src/Assay.sol#L252-L263


## uninitialized-local
Impact: Medium
Confidence: Medium
 - [ ] ID-10
[AgentAccount._spendWindow(address,uint128,uint128).used](src/AgentAccount.sol#L415) is a local variable never initialized

src/AgentAccount.sol#L415


## unused-return
Impact: Medium
Confidence: Medium
 - [ ] ID-11
[ChironGate._claimAndForward(IX402BatchSettlement.VoucherClaim,bytes32,address,address)](src/ChironGate.sol#L176-L199) ignores return value by [(None,claimedBefore) = x402.channels(channelId)](src/ChironGate.sol#L182)

src/ChironGate.sol#L176-L199


 - [ ] ID-12
[AgentAccount.isValidSignature(bytes32,bytes)](src/AgentAccount.sol#L677-L692) ignores return value by [(recovered,err,None) = ECDSA.tryRecover(hash,agentSig)](src/AgentAccount.sol#L688)

src/AgentAccount.sol#L677-L692


 - [ ] ID-13
[ChironGate._payerSigned(IX402BatchSettlement.ChannelConfig,bytes32,bytes)](src/ChironGate.sol#L217-L227) ignores return value by [(recovered,None,None) = ECDSA.tryRecover(digest,sig)](src/ChironGate.sol#L223)

src/ChironGate.sol#L217-L227


 - [ ] ID-14
[AgentAccount.unlockCallback(bytes)](src/AgentAccount.sol#L481-L503) ignores return value by [poolManager.settle()](src/AgentAccount.sol#L499)

src/AgentAccount.sol#L481-L503


 - [ ] ID-15
[Assay._payerSigValid(Assay.Channel,uint256,uint256,bytes32,bytes32,bytes)](src/Assay.sol#L497-L511) ignores return value by [(recovered,err,None) = ECDSA.tryRecover(digest,payerSig)](src/Assay.sol#L508)

src/Assay.sol#L497-L511


 - [ ] ID-16
[AgentAccount._swap(AgentAccount.Trade,address,address)](src/AgentAccount.sol#L469-L479) ignores return value by [poolManager.unlock(abi.encode(t.key,t.zeroForOne,t.amountIn))](src/AgentAccount.sol#L473)

src/AgentAccount.sol#L469-L479


 - [ ] ID-17
[AgentAccount.isValidSignature(bytes32,bytes)](src/AgentAccount.sol#L677-L692) ignores return value by [(chAgent,None,None,None,None,None,None,closed,None,None) = assay.channels(channelId)](src/AgentAccount.sol#L686)

src/AgentAccount.sol#L677-L692


## missing-zero-check
Impact: Low
Confidence: Medium
 - [ ] ID-18
[AgentAccountFactory.constructor(address,address,address,address,address).poolManager_](src/AgentAccountFactory.sol#L18) lacks a zero-check on :
		- [poolManager = poolManager_](src/AgentAccountFactory.sol#L22)

src/AgentAccountFactory.sol#L18


 - [ ] ID-19
[AgentAccountFactory.constructor(address,address,address,address,address).verifier_](src/AgentAccountFactory.sol#L18) lacks a zero-check on :
		- [verifier = verifier_](src/AgentAccountFactory.sol#L19)

src/AgentAccountFactory.sol#L18


 - [ ] ID-20
[AgentAccount.withdrawETH(address,uint256).to](src/AgentAccount.sol#L638) lacks a zero-check on :
		- [(ok,None) = to.call{value: amount}()](src/AgentAccount.sol#L639)

src/AgentAccount.sol#L638


 - [ ] ID-21
[AgentAccountFactory.constructor(address,address,address,address,address).receiptVerifier_](src/AgentAccountFactory.sol#L18) lacks a zero-check on :
		- [receiptVerifier = receiptVerifier_](src/AgentAccountFactory.sol#L20)

src/AgentAccountFactory.sol#L18


 - [ ] ID-22
[AgentAccountFactory.constructor(address,address,address,address,address).usdg_](src/AgentAccountFactory.sol#L18) lacks a zero-check on :
		- [usdg = usdg_](src/AgentAccountFactory.sol#L23)

src/AgentAccountFactory.sol#L18


 - [ ] ID-23
[AgentAccountFactory.constructor(address,address,address,address,address).assay_](src/AgentAccountFactory.sol#L18) lacks a zero-check on :
		- [assay = assay_](src/AgentAccountFactory.sol#L21)

src/AgentAccountFactory.sol#L18


## reentrancy-benign
Impact: Low
Confidence: Medium
 - [ ] ID-24
Reentrancy in [AgentAccount.execute(AgentAccount.Trade,AgentAccount.Receipt)](src/AgentAccount.sol#L324-L343):
	External calls:
	- [(served,reqHash,respHash) = _consumeReceipt(r)](src/AgentAccount.sol#L337)
		- [(ok,requested,served,reqHash,respHash) = receiptVerifier.verifyReceipt(r.pubkey,r.receiptBytes,r.signature)](src/AgentAccount.sol#L443)
	- [amountOut = _swap(t,tokenIn,tokenOut)](src/AgentAccount.sol#L338)
		- [poolManager.unlock(abi.encode(t.key,t.zeroForOne,t.amountIn))](src/AgentAccount.sol#L473)
	State variables written after the call(s):
	- [amountOut = _swap(t,tokenIn,tokenOut)](src/AgentAccount.sol#L338)
		- [swapping = true](src/AgentAccount.sol#L472)
		- [swapping = false](src/AgentAccount.sol#L474)
	- [tradeId = ++ tradeCount](src/AgentAccount.sol#L339)

src/AgentAccount.sol#L324-L343


 - [ ] ID-25
Reentrancy in [Assay.register(bytes,uint256)](src/Assay.sol#L252-L263):
	External calls:
	- [(signer,measurement) = verifier.verify(quote,nonce)](src/Assay.sol#L256)
	State variables written after the call(s):
	- [signers[signer] = Signer(measurement,expiry)](src/Assay.sol#L261)

src/Assay.sol#L252-L263


 - [ ] ID-26
Reentrancy in [Assay.openChannelWithPermit(address,uint128,bytes32,bytes32,uint256,uint8,bytes32,bytes32)](src/Assay.sol#L315-L331):
	External calls:
	- [IERC20Permit(address(usdg)).permit(msg.sender,address(this),amount,deadline,v,r,s)](src/Assay.sol#L325-L328)
	State variables written after the call(s):
	- [channelId = _openChannel(provider,amount,measurement,requestedModelHash)](src/Assay.sol#L329)
		- [channelId = channelCount ++](src/Assay.sol#L339)
	- [channelId = _openChannel(provider,amount,measurement,requestedModelHash)](src/Assay.sol#L329)
		- [channels[channelId] = Channel({agent:msg.sender,provider:provider,deposit:amount,paid:0,openedAt:uint64(block.timestamp),lastActivityAt:0,closeRequestedAt:0,closed:false,measurement:measurement,requestedModelHash:requestedModelHash})](src/Assay.sol#L340-L351)

src/Assay.sol#L315-L331


 - [ ] ID-27
Reentrancy in [AgentAccount.propose(AgentAccount.Trade,AgentAccount.Receipt)](src/AgentAccount.sol#L345-L362):
	External calls:
	- [(served,reqHash,respHash) = _consumeReceipt(r)](src/AgentAccount.sol#L353)
		- [(ok,requested,served,reqHash,respHash) = receiptVerifier.verifyReceipt(r.pubkey,r.receiptBytes,r.signature)](src/AgentAccount.sol#L443)
	State variables written after the call(s):
	- [proposalId = ++ proposalCount](src/AgentAccount.sol#L358)
	- [proposals[proposalId] = Proposal(tradeHash,msg.sender,expiry,Status.Pending,m,served,reqHash,respHash)](src/AgentAccount.sol#L360)

src/AgentAccount.sol#L345-L362


 - [ ] ID-28
Reentrancy in [AgentAccount.registerAgentWithCollateral(bytes,uint256,bytes)](src/AgentAccount.sol#L293-L307):
	External calls:
	- [(signer,measurement,status) = ICollateralVerifier(address(verifier)).verifyWithCollateral(quote,attestNonce(refBlock),collateral,maxTcbStatus,minTcbEvaluation)](src/AgentAccount.sol#L301-L303)
	State variables written after the call(s):
	- [_admit(signer,measurement,quoteHash)](src/AgentAccount.sol#L305)
		- [agent = signer](src/AgentAccount.sol#L316)
	- [_admit(signer,measurement,quoteHash)](src/AgentAccount.sol#L305)
		- [agentExpiry = expiry](src/AgentAccount.sol#L318)
	- [_admit(signer,measurement,quoteHash)](src/AgentAccount.sol#L305)
		- [agentMeasurement = measurement](src/AgentAccount.sol#L317)

src/AgentAccount.sol#L293-L307


 - [ ] ID-29
Reentrancy in [AgentAccount.registerAgent(bytes,uint256)](src/AgentAccount.sol#L276-L286):
	External calls:
	- [(signer,measurement) = verifier.verify(quote,attestNonce(refBlock))](src/AgentAccount.sol#L284)
	State variables written after the call(s):
	- [_admit(signer,measurement,quoteHash)](src/AgentAccount.sol#L285)
		- [agent = signer](src/AgentAccount.sol#L316)
	- [_admit(signer,measurement,quoteHash)](src/AgentAccount.sol#L285)
		- [agentExpiry = expiry](src/AgentAccount.sol#L318)
	- [_admit(signer,measurement,quoteHash)](src/AgentAccount.sol#L285)
		- [agentMeasurement = measurement](src/AgentAccount.sol#L317)

src/AgentAccount.sol#L276-L286


 - [ ] ID-30
Reentrancy in [ChironGate.claimWithReceipt(IX402BatchSettlement.VoucherClaim,ChironGate.Pin,bytes32,bytes32,bytes,bytes32,bytes,bytes)](src/ChironGate.sol#L128-L170):
	External calls:
	- [(ok,requestedModel,servedModel,receiptRequest,receiptResponse) = receiptVerifier.verifyReceipt(pubkey,receiptBytes,receiptSig)](src/ChironGate.sol#L148-L149)
	State variables written after the call(s):
	- [consumed[channelId][callKey] = true](src/ChironGate.sol#L163)

src/ChironGate.sol#L128-L170


 - [ ] ID-31
Reentrancy in [AgentAccount.approveTrade(uint256,AgentAccount.Trade)](src/AgentAccount.sol#L507-L534):
	External calls:
	- [amountOut = _swap(t,tokenIn,tokenOut)](src/AgentAccount.sol#L518)
		- [poolManager.unlock(abi.encode(t.key,t.zeroForOne,t.amountIn))](src/AgentAccount.sol#L473)
	State variables written after the call(s):
	- [tradeId = ++ tradeCount](src/AgentAccount.sol#L519)

src/AgentAccount.sol#L507-L534


 - [ ] ID-32
Reentrancy in [Assay.registerReceiptKey(bytes,bytes,uint256,bytes32)](src/Assay.sol#L277-L292):
	External calls:
	- [measurement = verifier.verifyKeyset(quote,keysetBytes,nonce,pubkey)](src/Assay.sol#L285)
	State variables written after the call(s):
	- [receiptSigners[pubkey] = Signer(measurement,expiry)](src/Assay.sol#L290)

src/Assay.sol#L277-L292


 - [ ] ID-33
Reentrancy in [AgentAccount._consumeReceipt(AgentAccount.Receipt)](src/AgentAccount.sol#L440-L455):
	External calls:
	- [(ok,requested,served,reqHash,respHash) = receiptVerifier.verifyReceipt(r.pubkey,r.receiptBytes,r.signature)](src/AgentAccount.sol#L443)
	State variables written after the call(s):
	- [usedReceipt[key] = true](src/AgentAccount.sol#L454)

src/AgentAccount.sol#L440-L455


 - [ ] ID-34
Reentrancy in [AgentAccount._swap(AgentAccount.Trade,address,address)](src/AgentAccount.sol#L469-L479):
	External calls:
	- [poolManager.unlock(abi.encode(t.key,t.zeroForOne,t.amountIn))](src/AgentAccount.sol#L473)
	State variables written after the call(s):
	- [swapping = false](src/AgentAccount.sol#L474)

src/AgentAccount.sol#L469-L479


## timestamp
Impact: Low
Confidence: Medium
 - [ ] ID-35
[AgentAccount._consumeReceipt(AgentAccount.Receipt)](src/AgentAccount.sol#L440-L455) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp > expiry](src/AgentAccount.sol#L451)

src/AgentAccount.sol#L440-L455


 - [ ] ID-36
[Assay.redeemWithReceipt(uint256,uint256,bytes32,bytes32,bytes,bytes32,bytes,bytes)](src/Assay.sol#L439-L489) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp > rs.expiry](src/Assay.sol#L477)

src/Assay.sol#L439-L489


 - [ ] ID-37
[Assay.redeem(uint256,uint256,bytes32,bytes32,bytes,bytes)](src/Assay.sol#L380-L419) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp > s.expiry](src/Assay.sol#L409)

src/Assay.sol#L380-L419


 - [ ] ID-38
[AgentAccount._checkTrade(AgentAccount.Trade)](src/AgentAccount.sol#L379-L390) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp > t.deadline](src/AgentAccount.sol#L380)

src/AgentAccount.sol#L379-L390


 - [ ] ID-39
[AgentAccount.isValidSignature(bytes32,bytes)](src/AgentAccount.sol#L677-L692) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp > agentExpiry || paused](src/AgentAccount.sol#L690)

src/AgentAccount.sol#L677-L692


 - [ ] ID-40
[AgentAccount.approveTrade(uint256,AgentAccount.Trade)](src/AgentAccount.sol#L507-L534) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp > p.expiry](src/AgentAccount.sol#L510)

src/AgentAccount.sol#L507-L534


 - [ ] ID-41
[Assay.finalizeClose(uint256)](src/Assay.sol#L545-L559) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp < uint256(c.closeRequestedAt) + challengeWindow](src/Assay.sol#L551)

src/Assay.sol#L545-L559


 - [ ] ID-42
[AgentAccount._spendWindow(address,uint128,uint128)](src/AgentAccount.sol#L412-L427) uses timestamp for comparisons
	Dangerous comparisons:
	- [uint256(b.hour) + 24 >= h](src/AgentAccount.sol#L418)
	- [slot.hour != h](src/AgentAccount.sol#L422)

src/AgentAccount.sol#L412-L427


 - [ ] ID-43
[AgentAccount.windowUsed(address)](src/AgentAccount.sol#L430-L436) uses timestamp for comparisons
	Dangerous comparisons:
	- [uint256(w[i].hour) + 24 >= h](src/AgentAccount.sol#L434)

src/AgentAccount.sol#L430-L436


 - [ ] ID-44
[AgentAccount.propose(AgentAccount.Trade,AgentAccount.Receipt)](src/AgentAccount.sol#L345-L362) uses timestamp for comparisons
	Dangerous comparisons:
	- [t.deadline < ttlEnd](src/AgentAccount.sol#L356)

src/AgentAccount.sol#L345-L362


 - [ ] ID-45
[Assay.requestClose(uint256)](src/Assay.sol#L529-L539) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp < uint256(lastActivity) + channelTimeout](src/Assay.sol#L536)

src/Assay.sol#L529-L539


 - [ ] ID-46
[AgentAccount._requireAgent()](src/AgentAccount.sol#L372-L376) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp > agentExpiry](src/AgentAccount.sol#L374)

src/AgentAccount.sol#L372-L376


 - [ ] ID-47
[ChironGate.claimWithReceipt(IX402BatchSettlement.VoucherClaim,ChironGate.Pin,bytes32,bytes32,bytes,bytes32,bytes,bytes)](src/ChironGate.sol#L128-L170) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp > expiry](src/ChironGate.sol#L159)

src/ChironGate.sol#L128-L170


 - [ ] ID-48
[AgentAccount._requireNoCorporateAction(address)](src/AgentAccount.sol#L397-L408) uses timestamp for comparisons
	Dangerous comparisons:
	- [m != n || (e != 0 && block.timestamp < e + CORPORATE_ACTION_COOLDOWN)](src/AgentAccount.sol#L405)

src/AgentAccount.sol#L397-L408


## cyclomatic-complexity
Impact: Informational
Confidence: High
 - [ ] ID-49
[Assay.redeemWithReceipt(uint256,uint256,bytes32,bytes32,bytes,bytes32,bytes,bytes)](src/Assay.sol#L439-L489) has a high cyclomatic complexity (16).

src/Assay.sol#L439-L489


 - [ ] ID-50
[ChironGate.claimWithReceipt(IX402BatchSettlement.VoucherClaim,ChironGate.Pin,bytes32,bytes32,bytes,bytes32,bytes,bytes)](src/ChironGate.sol#L128-L170) has a high cyclomatic complexity (15).

src/ChironGate.sol#L128-L170


 - [ ] ID-51
[Assay.redeem(uint256,uint256,bytes32,bytes32,bytes,bytes)](src/Assay.sol#L380-L419) has a high cyclomatic complexity (12).

src/Assay.sol#L380-L419


## low-level-calls
Impact: Informational
Confidence: High
 - [ ] ID-52
Low level call in [AgentAccount.withdrawETH(address,uint256)](src/AgentAccount.sol#L638-L642):
	- [(ok,None) = to.call{value: amount}()](src/AgentAccount.sol#L639)

src/AgentAccount.sol#L638-L642


 - [ ] ID-53
Low level call in [AgentAccount._requireNoCorporateAction(address)](src/AgentAccount.sol#L397-L408):
	- [(okCur,cur) = token.staticcall(abi.encodeWithSignature(uiMultiplier()))](src/AgentAccount.sol#L398)
	- [(okNext,next) = token.staticcall(abi.encodeWithSignature(newUIMultiplier()))](src/AgentAccount.sol#L399)
	- [(okAt,at) = token.staticcall(abi.encodeWithSignature(effectiveAt()))](src/AgentAccount.sol#L400)

src/AgentAccount.sol#L397-L408


 - [ ] ID-54
Low level call in [AgentAccount._refBlockHash(uint256)](src/AgentAccount.sol#L262-L267):
	- [(ok,data) = ARBSYS.staticcall(abi.encodeWithSelector(ARBSYS_ARBBLOCKHASH_SELECTOR,refBlock))](src/AgentAccount.sol#L263)

src/AgentAccount.sol#L262-L267


 - [ ] ID-55
Low level call in [Assay._refBlockHash(uint256)](src/Assay.sol#L225-L230):
	- [(ok,data) = ARBSYS.staticcall(abi.encodeWithSelector(ARBSYS_ARBBLOCKHASH_SELECTOR,refBlock))](src/Assay.sol#L226)

src/Assay.sol#L225-L230


