# CURB Security Audit — 23 September 2026

**Status:** Findings only. No product code was changed and none of the findings below was fixed as part of this review.

## Scope and snapshot

- Reviewed commit: `774485c98b5ea454cea1a8cb6c91978098261808`
- The working tree was not clean. In particular, `web/app.js`, `web/e2e/app.spec.js` and `script/b20/demo-app.sh` contained uncommitted WETH-route work. This report reviews that working-tree code where applicable.
- Primary scope: `src/curb`, the vendored bonding curve used by CURB, deployment/preflight scripts, transaction construction and reporting in `web/app.js`, and the tests that claim the relevant properties.
- Existing audit documents were treated as leads, not as proof. Findings below were checked against current source. The full test suite was not independently rerun for this report.
- Severity means impact, not certainty. A finding marked **High** has a concrete source-level path or an existing reproduction. Governance/design risks are separated from exploitable defects.

## Executive result

No direct, permissionless theft of curve reserves or locked LP principal was established in this review. Two high-severity problems were established:

1. A creator-chosen ETH fee recipient can stop every swap in its graduated WETH pool by re-entering the unlocked Uniswap v4 `PoolManager` during fee delivery.
2. The create form can parse the creator's first buy with the wrong decimals and without its ceiling when factory context has not rendered, causing a materially wrong transaction; on a 6-decimal asset, `1` is interpreted as `100` units.

The most important medium findings are an incorrect failure result after successful WETH-pool trades, a v4 quote model that stops being exact after anyone adds concentrated liquidity, route selection that equates token custody with executable depth, and deployment controls that do not actually enforce the Safe configuration described by the project.

## Findings

### H-01 — A creator-chosen ETH fee recipient can permanently halt its graduated WETH market

**Severity:** High  
**Type:** Availability / external-call reentrancy  
**Affected:** `src/curb/FeeHook.sol:127`, `:608-610`, `test/fork/B20Graduation.t.sol:260-279`, `:7491-7519`

For a WETH-quoted pool, the hook takes WETH from `PoolManager`, unwraps it, then calls the platform and creator recipients with 30,000 gas. The comment says this amount cannot re-enter anything useful. That assumption is false for Uniswap v4.

While an unlock is active, `PoolManager.take()` is gated only by `onlyWhenUnlocked`. It accounts the new debt to `msg.sender`; it does not require that caller to be the original locker. A creator can therefore choose a recipient whose `receive()` calls `PoolManager.take(..., 1)` and returns normally. The hook sees `sent == true`, so its WETH fallback does not run. At the end of the outer unlock, the attacker's unsettled delta makes the entire trader swap revert.

The repository already contains exactly this receiver (`TakingReceiver`) and an expected-revert fork test. That is proof of the impact, not a mitigation. The test uses a bare `expectRevert`, so it does not by itself authenticate the terminal selector, but the source path explains why the nonzero delta survives to `unlock()`'s final settlement check.

**Impact:** A malicious creator can sell through the curve, graduate, and leave holders with a pool in which every swap reverts. The LP NFT is locked and the creator recipient stored for the pool has no update path. This is a market-wide denial of service chosen before users enter.

**Recommendation:** Do not make an external native-ETH call from the swap hook. Account or transfer WETH during the hook callback and let recipients unwrap or claim outside the PoolManager unlock. If native payout remains, it needs a design that cannot call arbitrary recipient code while PoolManager is unlocked; changing the stipend is not a reliable security boundary.

### H-02 — The create form can spend 100× the requested amount on a 6-decimal quote asset

**Severity:** High  
**Type:** Wrong transaction / user loss  
**Affected:** `web/app.js:2204-2227`

`createLaunch()` correctly obtains a pinned factory context through `beginAction("create")`, including the factory's quote token, decimals and threshold. It then ignores those pinned values when parsing the developer buy:

```js
const devBuy = readDevBuy(ctx ? ctx.quoteDecimals : 8, ctx ? ctx.threshold : 0n);
```

`ctx` belongs to rendering and may still be null after a slow/failed refresh even though `beginAction()` has just read a valid `pin`. In that state, decimals default to 8 and threshold to zero. Both the 75% ceiling and the below-threshold check are skipped.

- On WETH, `1` becomes `1e8` wei instead of `1e18`, silently defeating the intended first buy.
- On 6-decimal cbXRP, `1` becomes `1e8` raw units: **100 cbXRP**, and the factory can pull that amount if the wallet approves it.

The contract enforces its ceiling but has no way to know what human-readable amount the user intended. A wrong-scale value below that ceiling is valid on chain.

**Recommendation:** Parse exclusively with `pin.quoteDecimals` and validate against `pin`'s freshly read threshold. Disable submission until the pinned factory reads succeed; do not use display cache or a guessed decimal count in a send path.

### M-01 — Successful WETH-pool trades are reported as unreconciled failures

**Severity:** Medium  
**Type:** Receipt/accounting UI correctness  
**Affected:** `src/curb/FeeHook.sol:630-647`, `web/app.js:2618-2724`

For ordinary ERC-20 quote assets, the hook calls `PoolManager.take()` separately to the platform and creator. The page's receipt reconciler expects those transfers.

For WETH, the hook instead makes one aggregate `PoolManager -> FeeHook` WETH transfer, unwraps it, and pays the two recipients in native ETH (or WETH fallback). The page still calls `paidIn(inToken)` and tries to match two PoolManager-to-recipient WETH transfers. They do not exist, so `reconciles` is false even when the transaction succeeded and paid both legs correctly.

The current uncommitted browser tests check the packed WETH-route commands, but not this post-transaction report path.

**Impact:** The primary ETH-paired launch can complete successfully and then show a red “figures do not match” result. That undermines the page's central protection against duplicate sends and makes correct fees look suspicious.

**Recommendation:** Reconcile WETH pools using `FeeCharged` plus the hook's `PaidAsNative`/`PaidAsWrapped` events and the aggregate PoolManager-to-hook WETH transfer. Continue treating the native balance movement and gas as separate measurements.

### M-02 — The v4 quote is exact only while no additional initialized ticks are crossed

**Severity:** Medium  
**Type:** Quote/slippage accuracy  
**Affected:** `web/app.js:921-982`, `src/curb/FeeHook.sol` liquidity-permission design

`quotePoolSwap()` reads only current `sqrtPriceX96` and current active liquidity, then applies a single-range formula. Its comment argues this is exact because the graduation position is full range.

That ceases to be true as soon as any third party adds concentrated liquidity. The hook deliberately has no add/remove-liquidity permissions, so anyone may add a position whose range begins or ends at another tick. A swap that crosses such a tick must update active liquidity and continue with a new value. The page never reads the initialized ticks and therefore prices the rest of the trade with the wrong liquidity.

**Impact:** The displayed output and total execution cost can be wrong. The final minimum-output value generally protects funds, but an overquote causes avoidable reverts and gas loss; an underquote gives weaker price protection than the user could have received.

**Recommendation:** Quote the actual v4 swap through a trusted on-chain quoter/simulation that executes tick traversal, or implement tick walking from canonical pool state. Do not describe the single-active-range formula as exact after the pool becomes publicly composable.

### M-03 — ETH route selection treats pool custody as depth and can choose a materially worse tier

**Severity:** Medium  
**Type:** Economic routing  
**Affected:** `web/app.js:1646-1749`

For each pair, `v3PoolsBetween()` sorts pools by how much of one token the pool contract holds. `v3Candidates()` keeps only `direct[0]` and `toQuote[0]`; only then does `bestV3Leg()` ask QuoterV2 which retained route returns more.

In concentrated-liquidity AMMs, total token custody is not the same as active liquidity near the current price. A pool holding less total inventory can quote the user's size better because its liquidity is concentrated around the current tick or because it charges a lower tier. Those discarded tiers are never quoted.

**Impact:** The page can build a valid but inferior route and make the user receive less than another already deployed Uniswap v3 route would return.

**Recommendation:** Feed every discovered viable tier/path to QuoterV2 at the actual amount and select by returned output. Use custody only as an impossibility bound or informational signal, not as a pre-filter for execution quality.

### M-04 — The registry deployer remains a permanent, immediate canonical-list administrator

**Severity:** Medium  
**Type:** Governance / trust boundary  
**Affected:** `src/curb/LaunchRegistry.sol:281-319`

Multi-RWA support changed the registry from one write-once launcher to an add-only launcher set. The immutable `deployer` can call `addLauncher()` forever, without a delay, cap, ownership transfer or renunciation path.

The loop check proves a new factory points to the shared graduator/hook/PoolManager. It does not prove the factory enforces CURB's product rules. Once admitted, a launcher may register arbitrary records that satisfy the registry's structural bounds. Those records enter the canonical browse list and can use the shared hook and graduator.

**Impact:** A compromised deployer key cannot rewrite an existing launch, but can permanently add a malicious/spam launcher and poison canonical discovery. A lost key also prevents adding future RWA factories forever.

**Recommendation:** Treat this as a protocol governance role, not a deployment convenience. Put it behind an explicitly verified multisig and delayed/addition-only process, or finalize the launcher set and irreversibly disable additions before public launch.

### M-05 — Mainnet preflight defaults to bypassing the project's Safe requirement

**Severity:** Medium  
**Type:** Deployment safety  
**Affected:** `script/b20/preflight-mainnet.sh:112`, `:140`; `script/DeployCurb.s.sol:263-303`

The deploy script refuses a no-code platform recipient unless `CURB_ALLOW_EOA_RECIPIENT=true`. The mainnet preflight, however, supplies `${CURB_ALLOW_EOA_RECIPIENT:-true}` both during simulation and in the printed broadcast command. The safe default is therefore reversed at the exact layer intended to protect the real deployment.

For a contract recipient, the deploy script merely prints owners/threshold if the address happens to answer `getOwners()` and `getThreshold()`. It does not compare them with any committed expected owner set or threshold, and a non-Safe contract only produces a warning.

**Impact:** The preflight can end green and print a broadcast command that intentionally bypasses A6, or accept the wrong Safe-shaped contract. Several revenue and policy decisions then depend on an address that was never programmatically authenticated.

**Recommendation:** Default the preflight override to false, require a Safe-shaped recipient for production, and compare exact code/proxy identity, threshold and normalized owner set against explicit deployment inputs. A warning must fail a production preflight.

### M-06 — A mutable fee recipient can halt every new launch

**Severity:** Medium  
**Type:** Availability / trusted-role external call  
**Affected:** `src/curb/CurbLaunchFactory.sol:492-551`

When a launch fee is nonzero, `launch()` sends it to the hook's current platform recipient using an unrestricted-gas call before deploying the curve/token. A recipient that rejects ETH stops all launches. A recipient can also re-enter `launch()` with a zero dev buy and recycle the same fee to itself until gas exhaustion, reverting the outer creation.

This is a trusted-role risk because changing the recipient requires the hook policy owner and delay. It still matters operationally: the policy role can redirect existing pool revenue and unintentionally or deliberately disable launch creation at the same time.

**Recommendation:** Pull/claim launch fees or send them to a minimal vault with no arbitrary callback. At minimum, protect `launch()` against reentrancy and validate the recipient's ability to accept the launch-fee delivery before activating it.

### L-01 — The dev-buy ceiling is duplicated in the page

**Severity:** Low  
**Type:** Future configuration drift  
**Affected:** `web/app.js:2362`, `src/curb/CurbLaunchFactory.sol` public `MAX_DEV_BUY_BPS`

The page hardcodes 7500 even though the public contract constant has a getter. A later contract change can make the page reject valid actions or promise transactions that revert.

**Recommendation:** Read the getter from the pinned factory alongside the other immutable terms.

### L-02 — Launch description is silently truncated

**Severity:** Low  
**Type:** Permanent metadata mismatch  
**Affected:** `web/app.js` metadata builder; `web/app.html` description field

The page slices the description to 300 characters without a matching `maxlength` or visible warning, while the pre-submit summary can show the full typed string. The token metadata is immutable, so the lost suffix cannot be restored.

**Recommendation:** Enforce and display the same limit in the field and summary, or reject rather than silently mutate the creator's data.

### L-03 — Public read surfaces have unbounded work requested by the caller

**Severity:** Low  
**Type:** RPC/front-end availability  
**Affected:** `src/curb/LaunchLens.sol:142-154`, permissionless metadata strings

`launchPage(start,count)` allocates and loops over caller-supplied `count` (bounded only by the remaining registry size) and performs multiple external reads per launch. Launch metadata strings are also creator-controlled and only bounded in the official page, not in the factory. A public RPC can be forced into expensive `eth_call` responses, and a discovery page can stall on pathological metadata.

This does not change chain state and is not a reserve risk, but it should not be exposed as an unrestricted public indexing primitive.

**Recommendation:** Cap page size in the lens, impose contract-level metadata bounds appropriate to the product, and isolate/fail individual metadata reads in discovery.

## Deliberate or unresolved risks (not classified as code defects)

### R-01 — Very large pool buys are intentionally fail-closed

The fee hook taxes input in `beforeSwap` and rejects a buy if the v4 swap later partially fills. A trade that reaches a supplied price limit or the pool's own range bound reverts completely. This avoids taxing unspent input but sets a real maximum executable buy size.

### R-02 — All measured B20 equities share issuer policy 5

Adding more stock tickers diversifies market exposure but not issuer/policy risk. One policy action can restrict several supported quote assets together. The rescue path handles a blocked escrow, not a blocked protocol/creator recipient or a globally halted token.

### R-03 — Reference-price and market-hours protection remains out of scope

The curve and graduated pool price only against their own reserves. They do not enforce an external stock reference, staleness window or market-hours mode. That is a declared product choice, but users can trade far from the underlying equity's reference price.

### R-04 — Mutable fee policy affects existing pools and future curves differently

A hook owner may change the platform recipient and platform split after an announced delay. Existing graduated pools read the live hook values; already-created curves retain their launch-time snapshot. Total tax remains fixed, but recipient/split continuity across graduation depends on when the change executes. This is governance behaviour that must be visible in the product and audit scope.

### R-05 — Current working tree and mainnet state are not release evidence

The audit snapshot includes uncommitted route changes and generated artifacts. No mainnet deployment was established. A clean, identified commit, full independent test run, bytecode/source verification, role read-back and external professional audit remain release gates.

## Positive controls observed

- Launch records are write-once and graduations read economic terms from the registry rather than caller arguments.
- Curve buys and sells use minimum-output checks, measured ERC-20 balance deltas and guarded accounting.
- Graduation measures received reserves, binds the pool before minting, locks the exact position NFT and verifies total-supply reduction on the burned remainder.
- `FeeEscrow` uses checks-effects-interactions plus a reentrancy guard, and bounds both claimant receipt and escrow asset loss for token payouts.
- Pool taxes fail closed for unconfigured pools and exact-output swaps.
- Transaction sending pins chain/account/factory context and distinguishes explicit wallet rejection from uncertain provider failure.

These controls reduce several common failure modes; they do not neutralize the findings above.

## Source cross-checks

- Vendored Uniswap v4 `PoolManager.unlock()` performs a final nonzero-delta check; `take()` is callable by any address while unlocked and books the delta to `msg.sender`: `lib/v4-core/src/PoolManager.sol`.
- Uniswap's official unlock/delta guide describes `take` as producing a negative delta that must be resolved before unlock completes: https://developers.uniswap.org/docs/protocols/v4/guides/unlock-callback-and-deltas
- Uniswap's official concentrated-liquidity documentation states that swaps consume liquidity within the current tick interval and update as initialized ticks are crossed: https://developers.uniswap.org/docs/get-started/concepts/liquidity-providers/concentrated-liquidity
- Solidity's security guidance states that reentrancy can arise from any external call, not only Ether transfer, and recommends checks-effects-interactions: https://docs.soliditylang.org/en/latest/security-considerations.html

## Priority order

1. H-01 — remove arbitrary recipient execution from the unlocked hook path.
2. H-02 — build the dev-buy transaction only from the pinned factory context.
3. M-01 — make WETH/native receipt reconciliation truthful before presenting WETH as the primary pair.
4. M-02 and M-03 — replace approximate v4 pricing and custody-based route preselection.
5. M-04 through M-06 — close deployment/governance availability risks before audit freeze.

