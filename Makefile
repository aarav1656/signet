# One command from a clean clone: `make test` fetches the pinned libraries, builds every Foundry
# profile the suite and the deploy scripts read, then runs the whole forge suite.
#   default  contracts and tests
#   v4       canonical Uniswap v4 PoolManager build (out-v4), deployed by the account tests
#   x402     canonical x402 BatchSettlement build (out-x402)
# Fork tests read Robinhood Chain testnet and Arbitrum Sepolia through their public RPCs, so
# `make test` needs network access. Override the Robinhood endpoint with RHC_FORK_URL.

OZ_TAG := v5.7.0
OZ_SHA := cab19933c33c2ad1d4c7a84864a3601dddfd16f3
FS_TAG := v1.16.2
FS_SHA := bf647bd6046f2f7da30d0c2bf435e5c76a780c1b
LIB := contracts/lib
RHC_FORK_URL ?= https://rpc.testnet.chain.robinhood.com

.PHONY: deps build test

deps:
	@mkdir -p $(LIB)
	@test "$$(git -C $(LIB)/openzeppelin-contracts rev-parse HEAD 2>/dev/null)" = $(OZ_SHA) || { rm -rf $(LIB)/openzeppelin-contracts; git clone -q --depth 1 --branch $(OZ_TAG) https://github.com/OpenZeppelin/openzeppelin-contracts.git $(LIB)/openzeppelin-contracts; }
	@test "$$(git -C $(LIB)/forge-std rev-parse HEAD 2>/dev/null)" = $(FS_SHA) || { rm -rf $(LIB)/forge-std; git clone -q --depth 1 --branch $(FS_TAG) https://github.com/foundry-rs/forge-std.git $(LIB)/forge-std; }
	@test "$$(git -C $(LIB)/openzeppelin-contracts rev-parse HEAD)" = $(OZ_SHA) && test "$$(git -C $(LIB)/forge-std rev-parse HEAD)" = $(FS_SHA)

build: deps
	cd contracts && forge build
	cd contracts && FOUNDRY_PROFILE=v4 forge build
	cd contracts && FOUNDRY_PROFILE=x402 forge build

test: build
	cd contracts && RHC_FORK_URL=$(RHC_FORK_URL) forge test
