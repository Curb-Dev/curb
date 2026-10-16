<!-- Writing rules, the facts this page must keep, and the markdown subset it may use: DOCS_STYLE.txt at the repository root. -->

# CURB documentation

CURB is a token launchpad on Base. Anyone can launch a coin priced against ETH, USDC, another coin such as cbBTC
or AERO, or a tokenized stock such as NVDAc. Each launch trades on its own bonding curve until it raises its
graduation threshold, then moves into a Uniswap v4 pool whose liquidity is locked forever. The creator picks
a trading tax of 1% to 5%; the platform takes a share of it (0.50% at deployment) and the creator keeps the rest -
or gives it to the launch's holders, for good.

> **Note:** Nothing here is financial advice. A launch token can lose all of its value. Read the
> [terms](terms.html) before you launch or trade.

---

## Quick start

1. **Connect.** Use a wallet on Base with a little ETH for gas. If it is on another network, the site says so
   and offers to switch - to Base only: nothing is sent on any other network.
2. **Launch.** Open [Launch a token](app.html#create-launch). Add a name, symbol, image and links, pick a creator
   tax and a paired asset (ETH unless you choose another), add a dev buy if you want one, and turn on **Share fees
   with holders** if your creator share should go to your holders. Press **Create the launch** and confirm. Launching costs gas only, plus the dev buy if you chose one. When it is
   mined, the site takes you to your launch's page, with its swap box ready for a first trade.
3. **Trade.** Find a launch on [Launches](browse.html) or with the search in the top bar, and buy or sell on its
   page. Each card on Launches shows the token, its paired asset, its market cap in dollars, how close it is to
   graduating and how long ago it launched; sort by newest, just bought, oldest, market cap or progress, or keep
   only the last 24 hours or 7 days of what is loaded. **Just bought** lists the launches still on their curve,
   the most recently bought first, says how long ago each was bought, and re-orders about every 15 seconds; it
   reads the buys of roughly the last hour, and a launch with no buy seen in that time comes after, newest first. You can pay with ETH on every pair: the swap box starts on ETH, and
   its asset button switches to the pair's own asset if you hold that instead. Through the CURB router, a curve buy
   with ETH is one confirmation on every pair, and a curve sale can pay you ETH on every pair too: the first time
   you sell a token that way your wallet asks twice - once to let the router move that token, then the sale - and
   after that once.
   After graduation a pool trade takes or pays ETH in one transaction.
4. **Claim.** If you created a launch, connect the creator wallet and press **Claim** on its page; it sweeps
   what the curve still holds for you first, and claims what every launch paying that address in that asset owes
   it. If you hold a launch that shares its fees, your share is sent to you; **Claim** on
   [Holder fees](sharing.html) takes it sooner. That page lists, for your connected wallet, every token you earned
   holder fees from - earned, paid and claimable, in the pair's asset and in dollars - with the total.

Each approval the site asks for is for the exact amount of the action in front of you, with one exception: to
sell a token for ETH, it asks once to let the CURB router move that token, with no limit, so that later sales of it
are one confirmation. The router has no owner, and it moves a token only from the wallet that calls it, during that
wallet's own sale, so nobody else can use the allowance. You can revoke it at any time by setting it to zero in
your wallet or with a token-approval tool.

The site is a static page with no CURB server. It reads everything from Base through an RPC endpoint and sends
every transaction through your wallet. A token's name, image and links are stored on chain with it.

A link can name another RPC endpoint (`?rpc=`), for a fork or a review. A page read through any endpoint but the
site's own says so under the top bar and sends nothing: what a transaction is built from - its minimum, its route
and the contract it goes to - would be that endpoint's word. To send, open the page without the link's endpoint.

---

## How a launch works

Every launch starts on its own bonding curve, priced in its paired asset, at a market cap of about $4,000. About
73% of the supply, roughly 730,000,000 tokens, is for sale on the curve. The price starts low, rises with every
buy and falls with every sale. When the last of those tokens is sold, the price is about 14 times where it
started, a market cap of about $55,000, and the curve holds its graduation threshold.

Then the launch graduates, normally in the same transaction:

- a Uniswap v4 pool opens at the curve's last price, with about one threshold of the paired asset and about
  197,000,000 tokens;
- that liquidity is locked forever;
- the leftover tokens, about 73,000,000, are burned, which leaves a supply of about 927,000,000.

**A buy bigger than what is left on the curve** is filled up to the threshold, and the rest of your payment comes
back in the same transaction. When you pay with ETH, it comes back as ETH on an ETH pair and in the paired asset
on other pairs.

**Waiting.** If the move into the pool does not complete by itself, the launch shows as Waiting. It cannot be
traded until someone presses **Complete the move** on its page. Anyone can; it costs only gas. On Launches, a
waiting launch's card has a **Graduate it** button that goes straight there.

---

## Paired assets

When you launch, you choose the asset your coin is priced against. Buyers pay in it, fees are charged in it, and
it sets the graduation threshold. The choice is permanent.

| Asset | What it is | Graduation threshold |
|---|---|---|
| ETH | Ether, held as WETH | 4.47 WETH |
| USDC | Circle's dollar stablecoin | 10,800 USDC |
| cbBTC | Coinbase-wrapped BTC | 0.132 cbBTC |
| VIRTUAL | Virtuals Protocol's token | 16,100 VIRTUAL |
| AERO | Aerodrome's token | 11,600 AERO |
| cbXRP | Coinbase-wrapped XRP | 8,150 cbXRP |
| cbZEC | Coinbase-wrapped ZEC | 8.74 cbZEC |
| NVDAc | Tokenized stock | 50 NVDAc |
| GOOGLc | Tokenized stock | 31.1 GOOGLc |
| SPCXc | Tokenized stock | 74.5 SPCXc |
| AMZNc | Tokenized stock | 42.9 AMZNc |
| MSFTc | Tokenized stock | 20.1 MSFTc |
| AAPLc | Tokenized stock | 31.5 AAPLc |
| METAc | Tokenized stock | 14.7 METAc |

The thresholds were set in October 2026 prices so that every launch starts at about $4,000 and graduates at
about $55,000, whatever it is paired with. Each is fixed in its own units, so in dollars they drift apart as prices
move.

A launch is only as easy to trade as its paired asset: if the asset is hard to buy or sell, so is the launch, and
a launch on a thin asset may never reach its threshold. The launch form checks this when you pick an asset.

Every tokenized stock here sits under the same issuer policy and the same admin: picking a different stock
changes your price exposure, not who can restrict trading in it.

> **Warning:** The site shows prices and market caps in dollars, but a launch is priced in its paired asset. If
> the asset falls, the launch can fall in dollars even while its price in the asset rises. Check both: on a
> launch's page, the figure in the paired asset is in the tooltip on the price and the market cap.

Dollar figures come from each asset's Chainlink price feed on Base. Where an asset has none, they come from its
Uniswap price in ETH times ETH/USD. They are for display only. Stock feeds follow US market hours, so outside
them they show the last close.

---

## Fees

| Fee | Rate | Goes to |
|---|---|---|
| Trading tax, on every buy and sell | 1% to 5%, set by the creator at launch | Split in two, below |
| Platform share of the tax | 0.50% at deployment, 0.80% at most | The platform |
| Creator share of the tax | The rest, at least 0.20% | The creator, or the launch's holders when it shares its fees |
| Pool LP fee, pool trades only | 0.05% | The pool's liquidity, mostly the locked position (its fees go to the creator, or to the holders) |

**Launching costs gas only.** There is no launch fee.

The tax is charged in the paired asset, on the curve and in the pool: it comes off what you pay when you buy, and
off what you receive when you sell. On the curve it is the whole trading fee. In the pool, the 0.05% LP fee and
price impact come on top; and a holder who trades through liquidity of their own in a narrow range of the pool (a
range order) pays no tax on that side, a Uniswap v4 limitation CURB accepts. Paying or receiving ETH on a pair
that is not ETH also passes through Uniswap pools
between ETH and the paired asset, which charge their own fees and move their own prices. Some of those pools are
shallow: the site compares what that swap pays with the market price from Chainlink, warns above 5% and strongly
above 15%, and sends nothing when it would pay more than half below it, or when the price cannot be read to
compare - pay or receive the paired asset itself, or trade a smaller amount. Gas is extra.

The platform share can never be more than 0.80%; a change is announced 24 hours ahead and applies only to
launches created after it, because every launch keeps the terms in force when it was made.

---

## Creator earnings

Your share of the tax builds up from the first trade, in the paired asset. Press **Claim** on your launch's page
with the creator wallet to collect it, whether it was earned on the curve or in the pool; on an ETH pair you are
paid in ETH, and your wallet may ask you to confirm more than once. The 0.05% LP fee earned by the locked position
is not part of Claim, and the site has no button for it: anyone can collect it on the launch's lock contract, for
example from a block explorer, and it goes to the creator wallet (see [Functions](#functions)) - or to the holders,
once the launch shares its fees.

---

## Holder sharing

A creator can give their whole creator share to the launch's holders, for good: with **Share fees with holders**
when launching, or **Enable holder sharing** on the launch's page later. Nobody can turn it off, CURB included.

- The creator share becomes 0%. The holders get it, on the curve and in the pool, plus the locked position's LP
  fees.
- What the creator earned before stays theirs to claim. The LP principal stays locked forever, as on every launch.

**Who gets what.** About every hour, CURB's keeper splits what the launch's distributor received among everyone who
held the token, by how much each held and for how long, and publishes the split. The creator's own tokens earn like
anyone's. Pools, the curve, the lock and CURB's contracts are left out, so tokens held through them, including
claims inside Uniswap v4, earn nothing. At most 2% of each payout covers the keeper's gas; the cap is in the
contract.

**The safety hour.** Every payout waits one hour before it pays, and the CURB multisig or an independent vetoer can
stop it in that hour. A distributor never pays out more than it received.

**Getting paid.** Shares are sent automatically once they are worth the gas (about $0.05 or more); a smaller share
builds up until it is. You can claim yours on [Holder fees](sharing.html) at any time, and it never expires. If a
paired asset's issuer blocks your address, your share waits, and you can claim it to another address of yours on
the launch's holder details (its page with `#holders` at the end of the address).

**Checking it.** Every payout's file is public and its sha256 is on chain. **Check the payout files yourself** on
the launch's holder details (its page with `#holders` at the end of the address) fetches a file from this site or IPFS, checks its
hash, rebuilds its Merkle tree, adds up what it allocates, checks the keeper's 2% and finds your leaf and proof;
[Holder sharing contracts](#holder-sharing-contracts) has the command that recomputes a payout from the chain. The
holder details warn about any change announced to the roles behind its payouts (a new publisher or keeper payee,
removing a vetoer, ending a freeze: each waits 48 hours, then anyone may carry it out within 7 days). The
distributor versions a creator may switch to are the ones the catalog approves; a new one waits 7 days after it
is proposed, and retiring one stops only new switches to it.

**What CURB cannot do:** turn sharing off, take a distributor's funds, pay out more than it received, or take more
than 2% for gas. CURB does compute the split, so holders rely on it; every split can be checked and stopped.
Payouts also need CURB's keeper to keep publishing them: nobody else can, and if it stopped, what arrived after the
last payout would wait in the distributor, unpaid - it never expires.

---

## Dev buy

A dev buy is an optional first purchase made inside the launch transaction, so nobody can buy before it. You pay
it in the paired asset, it pays the same tax as any buy, and the tokens go to the creator wallet. The form takes
it as an amount or as a percentage of the supply.

- A dev buy can get at most 20% of the 1,000,000,000 minted, 200,000,000 tokens. The limit is on the tokens, so it
  is the same on every pair. In the paired asset it is about 0.42 WETH on an ETH pair, a little more at a higher
  tax because the tax comes off the payment first. The form shows the maximum for your pair and tax and does not
  send more. After graduation 200,000,000 is about 22% of the roughly 927,000,000 left, which is how the holders
  list shows it.
- The limit covers only the dev buy. The curve is open to everyone as soon as the launch exists, so a creator can
  buy more in the same block.

> **Tip:** Before you buy a launch, look at its holders list and how much the creator wallet holds.

---

## What is permanent

Fixed for each launch when it is created, and not changeable by anyone, CURB included:

- the token's name, symbol, image, description, links and its 1,000,000,000 supply;
- the creator wallet, which receives the creator's fees and owns the locked liquidity - its fees can be switched
  to the launch's holders once, and that switch is for good;
- the paired asset and the graduation threshold;
- the tax and the platform's share of it;
- the 0.05% pool fee and the lock, which is forever.

The token has no owner: nobody can mint more of it, pause it or block its holders. The paired asset's issuer can
still restrict its own token; see [Risks](#risks).

**Liquidity is locked forever.** When a launch graduates, its pool position goes into a lock contract that has no
unlock date and no withdrawal. Nobody can take the liquidity out - not the creator, not CURB, not anyone, at any
time. The lock only collects the position's LP fees, for the creator wallet or, once the launch shares its fees, for
its holders (see [Functions](#functions)).

**What can change:** the platform's share and who receives it, for launches created later. Existing launches are
not affected.

---

## Risks

- **Total loss.** A launch token can go to zero. Trading may never happen.
- **Concentration.** A maximum dev buy gets 20% of the 1,000,000,000 minted, about 22% of the roughly 927,000,000
  left after graduation, and a creator can buy more in the same block.
- **The paired asset.** Its price moves your launch's dollar value, and a thin asset may keep a launch from
  filling.
- **Issuers.** Tokenized stocks and wrapped coins are issued by others, not CURB. An issuer can block an address
  or pause its token, which can stop trading, graduation and claims for launches paired with it. The site sends
  no buy into a launch whose graduation such a block would stop. A launch token gives no claim on any share or
  company.
- **Waiting.** Between reaching the threshold and the move into the pool, nothing can be traded.
- **Keys.** A creator's fees and locked position belong to the creator wallet. A lost key cannot be recovered.
- **Dollar figures** are for display only. Nothing trades at them.
- **Holder sharing.** CURB's keeper computes each split off chain. The contracts cap what it can do, and every
  split can be checked and stopped within its hour, but a wrong split nobody stops would pay holders wrongly.
- **Smart contracts** can have bugs. They have been reviewed in house only.
- **No pause, no upgrade.** Nothing in the contracts can be paused, upgraded or reversed, and no admin can recover
  funds. A bug in a contract every launch shares would affect launches that already exist. The CURB multisig can
  add a new paired asset at any time, effective at once; it cannot change an existing launch.
- **Future terms.** The platform share can change for new launches, within 0.80% and after 24 hours' notice.

---

## FAQ

### Can the creator take the liquidity?

No. The graduated pool's liquidity is locked forever, and nobody can withdraw it. The creator cannot mint tokens,
pause trading, block holders or take the curve's funds, but can sell tokens they hold like anyone else. Check the
creator's holdings before you buy.

### Can the fees on a launch change?

No. The tax, the platform's share and the pool fee are fixed when a launch is created. A change to the platform
share applies only to launches created after it.

### Why was my trade refused?

The message at the top of the screen says why. The usual reasons:

- the price moved more than your slippage setting allows;
- the launch is Waiting (see [How a launch works](#how-a-launch-works));
- the curve is full, so selling to it is closed until the move into the pool;
- a pool buy could only have been partly filled;
- the issuer of a tokenized stock has restricted your address;
- your balance is too small.

### Why did my wallet ask me to confirm twice?

Most trades are one confirmation. These are two:

- the first time you sell a token for ETH: once to let the CURB router move that token, then the sale;
- a trade that spends a token when your current allowance is short: an approval for the exact amount first.

Where the site cannot use the CURB router, the trade says so and takes the longer way: paying ETH on a pair that
is not ETH is a swap and then the buy; on an ETH pair a buy wraps your ETH first, then approves and buys, and the
WETH the curve pays is unwrapped into ETH straight after. A sale on a pair that is not ETH then pays the pair's asset only. If you decline the unwrap you keep WETH,
and **Unwrap to ETH** on the launch's page converts it later.

### Can I change my token's name, image or links later?

No. They are written into the token when it is created, and there is no way to change them.

### Can I launch for someone else?

Yes. Put their address in **Creator wallet** under **Advanced**. They receive the creator fees, the dev buy's
tokens and the locked position's LP fees; you pay gas and any dev buy. The address cannot be changed later;
only its fees can be switched to the holders, once.

### Is $CURB live?

Yes. $CURB, the platform's own token, launched on Base on 16 October 2026 as the platform's first launch, paired
with ETH: `0xf8bdCD06F7a5939c8b2340E27419FaCDF16A407e`. Any other token using the name is not ours. Its supply of
1,000,000,000 went onto its curve at launch, like every launch's: no team allocation, no presale, no airdrop and
no dev buy. Its tax is 1%, all of it to the platform's treasury, which is its creator wallet; holder sharing is
off. Holding it gives no vote and no claim on the platform's income. The platform's treasury policy, decided on
22 September 2026, is to spend 80% of its fee income buying $CURB and burning it, and 20% running the platform.
That is a policy carried out by hand when enough has built up, not something the contracts do, and no burn has
happened yet. See the [$CURB page](curb.html).

---

## Developers

This part is for integrators. It describes the contracts as written. Amounts are in the paired asset's own units
unless it says otherwise, and bps means basis points (100 bps is 1%).

### Contracts

Shared by every launch:

- **LaunchRegistry** lists the factories and the launches, and keeps each launch's write-once record.
- **Graduator** moves a full curve into its pool and locks the position.
- **FeeHook** is the Uniswap v4 hook on every pool. It charges the tax in the pool and holds the platform policy
  for future launches.
- **LaunchLens** is read-only: one launch's state, or a page of launches.
- **SharingCatalog** lists the holder distributor versions a launch may switch to (below).

One set per paired asset:

- **CurbLaunchFactory** creates launches. It fixes the supply, threshold, pool settings and launch fee.
- **FeeEscrow** holds swept curve fees until each owner claims them. It has no owner.
- **FeePolicy** publishes the deployment's fee terms. It has no owner and no setters.
- **PonsV2BuybackVault** is deployed with each factory (`buybackVault()`). Buyback is off for every launch, so
  nothing is ever paid into it.

One set per launch:

- **CurbLaunchToken**, a plain ERC-20 with 18 decimals and 1,000,000,000 tokens minted once to the curve. No
  owner, no further minting, no pause, no blacklist, no transfer hook. Holders can `burn` their own tokens.
- **PonsV2BondingCurve**, the launch's curve.
- **PositionLock**, created at graduation. It holds the pool position forever and has no owner.

And one for every pair, which the site trades through: **CurbRouter**, below. Holder sharing adds a
**HolderDistributorFactory** per version, and one **HolderFeeDistributor** per launch that shares, described in
[Holder sharing contracts](#holder-sharing-contracts).

### Functions

**Launching.** `CurbLaunchFactory.launch(cfg)` is open to anyone and costs gas only: `launchFee()` is 0 on every
CURB factory, and a launch that sends ETH is refused. `cfg` is a tuple of these fields, in this order: `name, symbol, tokenUri, salt,
quoteRefundTo, totalTaxBps, devBuy, creatorWallet, expectedPlatformBps, expectedPlatformRecipient,
holderShareFactory`.

- `totalTaxBps` is 100 to 500.
- `devBuy` is the amount of the paired asset the first buy spends, and must be below `graduationThreshold()`
  (`DevBuyTooLarge`). The tokens it receives may be at most `MAX_DEV_BUY_BPS` (2,000 bps, 20%) of the supply, or
  the launch reverts with `DevBuyAboveShare`. The caller approves the factory for it; the tokens go to the creator.
- `creatorWallet` of zero means the caller. The creator receives the curve's creator fees and the pool's, and is
  the lock's beneficiary. It cannot be changed; its income can be switched to the launch's holders once (below).
- `expectedPlatformBps` and `expectedPlatformRecipient` are what `currentPlatformPolicy()` returned. If either
  has changed by the time the launch is mined, it reverts with `PlatformPolicyMoved`.
- `quoteRefundTo` receives any paired asset left over at graduation, normally none.
- `holderShareFactory` of zero launches without holder sharing. Otherwise it must be a distributor factory the
  `SharingCatalog` approves (`recommended()` is the one the site uses): sharing is then switched on inside the
  launch, before the dev buy, so the dev buy's tax already goes to holders. An unapproved one reverts the launch
  with the Graduator's `FactoryNotApproved`.

**The curve.** `buy(quoteIn, minTokensOut, recipient)` after approving the curve for `quoteIn`, and
`sell(tokensIn, minQuoteOut, recipient)`. A buy that would pass the sellable supply (`sellableTokens()`, about 73%) is trimmed and the unspent part
is refunded to `msg.sender` in the same call; `minTokensOut` is checked as a price, so a trimmed fill still has
to meet it. Selling closes once `readyToGraduate()` is true. The curve pays and refunds in the paired asset, so on
an ETH pair it pays WETH. Reads: `getReserves()`, `realQuoteReserve()`, `graduationThreshold()`,
`sellableTokens()`, `readyToGraduate()`, `graduated()`, `phantomQuote()`. The curve prices as if it already
held `phantomQuote()` of the paired asset (a virtual reserve that is never paid out, about 37% of the threshold),
so it starts at phantomQuote ÷ 1,000,000,000 per token and ends at about 14 times that.

**Graduation.** It runs inside the buy that takes the last sellable token. If that attempt fails, anyone can call
`Graduator.graduate(launchToken)` (the factory has the same passthrough). If an issuer has blocked the fee
escrow, `Graduator.rescueCurveFees(launchToken)` pays the curve's pending fees straight to the platform recipient
and the creator, and graduation can then complete. The curve's creator-fee recipient and the platform recipient
can call it at any time. Anyone else only once the launch has sat full and ungraduated for `RESCUE_DELAY()` (one
hour) after `Graduator.noteReady(launchToken)` recorded it so - anyone may make that note, and `readySince(launchToken)`
reads it; before then the call reverts with `RescueNotOpenYet(caller, opensAt)`, `opensAt` zero while nobody has
noted it. Full alone is not enough because the buyer who fills a curve can starve its automatic graduation in the
same transaction; for the hour after the note, anyone can complete the move instead. Graduation opens the pool
at the curve's last price (fee 500, which is 0.05%, tick spacing 10, the FeeHook), mints a full-range position,
locks it forever, refunds leftover paired asset to `refundTo` and burns the leftover tokens.

**The pool.** Its key is the two currencies in address order, fee 500, tick spacing 10 and the FeeHook;
`LaunchLens.launchState(token).poolKey` returns it. Swaps must be exact-input (`ExactOutputNotSupported`), and a
buy the pool could only partly fill reverts (`PartialFillNotSupported`).

**Claiming.** `FeeEscrow.claimToken(asset)` and `FeeHook.claim(asset)` pay the caller what it is owed in that
asset, across all its launches on it. There is no claim on someone else's behalf.

**The lock.** `Graduator.lockOf(token)` gives a graduated launch's PositionLock (zero before graduation; it is
also the `lock` in its `Graduated` event). The lock has no unlock time and no withdrawal. On the lock,
`feeRecipient()` is where its LP fees go: the beneficiary (the creator wallet), or the launch's distributor once
its holder sharing is on - read live, with no setter. `claimFees()` can be called by anyone: it collects the fees
into the lock and pays them to `feeRecipient()`, or holds them for it (`held(party, i)`) when the transfer is
refused; `release(party)` pays what is held to that party. `lockedLiquidity()` is the liquidity it holds, which
never goes down.

**Reading.** `LaunchRegistry`: `launchCount()`, `launchAt(i)`, `launchSlice(start, count)`, `launchOf(token)`,
`isRegistered(token)`, `launcherCount()`, `launcherAt(i)`; a record's last field, `launchedAt`, is the time the
registry wrote it, by its own clock. `LaunchLens.launchState(token)` returns the status (0 not found, 1 Selling, 2
Waiting, 3 Graduated), curve, paired asset, creator, reserves, progress, supply and pool key, then `launchedAt`
(word 14) and the holder distributor (word 15, zero while sharing is off): 16 words, all static.
`launchPage(start, count)` returns up to 50; read the record length off the answer, as a lens from before the two
last words returns 14. `Graduator`: `lockOf(token)`, `burnedOf(token)`,
`hasGraduated(token)`. Balances: `FeeEscrow.balanceOfToken(owner, asset)`, `FeeHook.owed(owner, asset)`.

**Platform policy.** `FeeHook.platformFeeBps()` and `platformRecipient()` are what the next launch will be
created with; a launch's own values are `platformBps` and `platformRecipient` in its record. The hook's owner
changes them with `announcePlatformFeeBps(next)` or `announcePlatformRecipient(next)`, then `execute…` after
`POLICY_CHANGE_DELAY` (24 hours) and within `POLICY_CHANGE_WINDOW` (7 days), or `cancel…`. The share is capped at
`maxPlatformFeeBps()`, which is 80. Pending changes: `pendingFeeBps`, `pendingFeeReadyAt`, `pendingRecipient`,
`pendingRecipientReadyAt`.

### CURB router

`CurbRouter` trades a launch's curve in ETH in one transaction, on every pair. It has no owner, no settings, no
pause and no storage; WETH, Uniswap's SwapRouter02 and Base's B20 precompiles are constants in its code. It is
deployed with CREATE2 through the deterministic deployment proxy
(`0x4e59b44847b379578588920cA78FbF26c0B4956C`), so it has one address on Base and on any fork of it:

- address: `0xEa20C3266229a01cd0f45D9c7921a45d5b359561`
- runtime code hash: `0x25814dde01efddddcc582ba476471c80ce6de85154d1ee6a357f28cb67b37c5e`

The site sends nothing to it unless `eth_getCode` at that address hashes to that value on the chain it reads,
asked again right before each transaction to it. Otherwise it uses the longer flows: a swap and then the buy, or
approve, sell and unwrap.

- `buyWithEth(registry, token, path, minQuoteOut, minTokensOut, recipient, deadline)` is payable. It wraps the
  ETH sent, swaps it along `path` (a Uniswap v3 path from WETH to the paired asset, empty on an ETH pair) and buys
  on the curve for `recipient`. On a pair that is not ETH, `minQuoteOut` may not be 0. A refund past the threshold
  goes to the caller: ETH on an ETH pair (WETH if the caller refuses ETH), the paired asset otherwise.
- `sellForEth(registry, token, tokensIn, minQuoteOut, path, minEthOut, recipient, deadline)` takes `tokensIn` from
  the caller, which needs an allowance to the router, sells them on the curve, swaps the proceeds along `path` to
  WETH and pays `recipient` in ETH, or in WETH if it refuses ETH. `minEthOut` may not be 0.
- The curve and the paired asset are read from the registry named, which must record the token. On a tokenized
  stock pair the caller, the recipient and the router itself must each pass the issuer's sender and receiver
  policies, or the call reverts with `IssuerForbids(account, scope, policyId)` before anything moves. On a cbBTC,
  cbXRP or USDC pair none of the three may be on the issuer's blacklist for that coin (`isBlacklisted`), or it
  reverts with `BlacklistedBy(asset, account)`. These are the rules a trade by hand meets; on a sale, and for a
  recipient, the router is stricter than a trade by hand would be, so that an issuer has no reason to block it.
- It reports `BoughtWithEth(buyer, token, recipient, registry, ethIn, quoteIn, tokensOut, quoteRefund,
  ethRefund)` and `SoldForEth(seller, token, recipient, registry, tokensIn, quoteOut, ethOut, paidAsWeth)`.
- Anything sent to it outside a call stays there for good. Never use it as a launch's creator wallet or refund
  address; the site refuses it there, as it refuses WETH and SwapRouter02.

### Holder sharing contracts

**The switch.** `Graduator.enableHolderSharing(token, factory)` is the beneficiary's alone, once, one way;
`factory` must be one the `SharingCatalog` approves (`isApproved(f)`; `recommended()`). The Graduator builds that
factory's distributor for the token (`factory.deploy(token)`, at `predict(token)`), checks that it is one, pays the
creator what was pending (the curve's unswept fees, or the lock's accrued LP fees, best effort), records the switch
(`holderDistributorOf(token)`, `sharingSince(token)`, write-once) and moves the creator legs to it. The catalog
admits a new version 7 days after it is proposed and retires one at once; retiring stops new switches only.

**The distributor** (`HolderFeeDistributor`, one per launch, no owner, not upgradeable) takes in the launch's fees
with `harvest()`, which anyone may call: the curve's pending fees, its escrow credit, the hook's debt and the lock's
fees. `received0()` (the paired asset; ETH and WETH together on an ETH pair) and `received1()` (the launch token)
count everything it ever took in. Payouts are cumulative Merkle roots: `active()` and `pending()` return
`(merkleRoot, contentHash, cumHolders0, cumHolders1, cumKeeper0, fromBlock, toBlock, epoch, payableAt)`. A root is
published through the factory by its publisher, waits `VETO_WINDOW` (1 hour) as `pending`, can be vetoed in that
hour, and becomes `active` on `activate()` or on the next `push`, `claim` or `payKeeper`. On chain: a pending root
is never replaced, epochs go up by one, block ranges are contiguous, totals never fall, nothing is allocated beyond
`received`, and the keeper's part of each epoch's new paired-asset allocation is at most `MAX_KEEPER_FEE_BPS` (200).

- `push(leaves, proof, flags)`: anyone; pays many leaves of the active root with one multiproof. A refused token
  transfer is skipped (`PushSkipped`) and stays claimable; refused ETH is paid as WETH.
- `claim(cum0, cum1, proof, to)`: the caller's own leaf, paid to `to` (zero means the caller).
- `paid0(a)`, `paid1(a)`, `claimable(a, cum0, cum1)`, `isExcluded(a)`, `leafOf(a, cum0, cum1)`, `totalPaid0()`,
  `totalPaid1()`, `keeperPaid0()`, `lastProposedEpoch()`; `payKeeper()` pays the factory's `keeperPayee()`.

**The leaf** is OpenZeppelin's StandardMerkleTree leaf over `["address","address","uint256","uint256"]` =
`[distributor, account, cum0, cum1]`: `keccak256(bytes.concat(keccak256(abi.encode(distributor, account, cum0,
cum1))))`, so a proof is valid on one distributor only.

**The factory** (`HolderDistributorFactory`, owned by the platform's multisig) holds the roles: `publisher()`,
`keeperPayee()`, `isVetoer(a)`, `frozen()`. `freeze()` (the owner or a vetoer) stops publishing at once and holds
every pending root; `veto` and `vetoMany` stop pending roots. A new publisher or keeper payee, removing a vetoer
and unfreezing are announced first and can be carried out by anyone after `ROLE_DELAY` (48 hours), within
`ROLE_WINDOW` (7 days): `pendingPublisher`, `pendingPublisherAt`, `pendingKeeperPayee`, `pendingKeeperPayeeAt`,
`vetoerRemovalAt(a)`, `pendingUnfreezeAt`.

**The epoch file** (`curb.sharing.epoch/1`) is canonical JSON - sorted keys, every number a decimal string - and
its sha256 is the root's `contentHash`. The site serves it at `/sharing/<chainId>/<distributor>/<epoch>.json` and
the `uri` in `RootPublished` is its IPFS address. It holds the window, the rules and exclusions, the income, the
keeper's transactions (512 at most) and price, `W` and the weight floor, and one row per listed account,
`{a, w, s0, s1, cum0, cum1, b}`: its weight, its share of each asset, its cumulative totals - the leaf - and its
balance at the end. Listed are the accounts that take a share and every account that ever took one. An account
weighs only if it held at least a millionth of the supply on average over the window (the floor: `supply / 10^6`
times the window's seconds); below that it takes no share and costs the file no row. The complete balances after
the epoch are not listed: `stateAtEnd` commits to them (their count, sum and sha256 digest), and the next epoch
opens from that state.

Up to 512 rows the file holds them itself. Past that it is an index: the rows are in chunk files
(`curb.sharing.chunk/1`) of 512 consecutive accounts in address order, served at
`/sharing/<chainId>/<distributor>/chunks/<sha256>.json` and on IPFS under the CID their sha256 makes, and the
index names each chunk by its first and last account, its row count, byte length, sha256, tree root and sums. A
chunk is trusted only through the sha256 its index gives, as the index is only through the chain. The tree is cut
the same way: each chunk is a StandardMerkleTree, and the root is the SimpleMerkleTree of the chunk roots, so a
claim proof is the chunk's proof followed by the chunk root's (one chunk: the plain StandardMerkleTree, as before).
The page reads the index and the one chunk that holds the connected account; a verifier reads every chunk.

**The split** (CURB-SHARE v1, exact integer arithmetic): an account's weight is its balance times the seconds it
was held, block by block, from the epoch's first block to its harvest block; excluded accounts weigh nothing. The
epoch's new income, less the keeper's fee - the gas of its transactions, priced by Chainlink, at most 2% - is split
in proportion to weight, rounding down; dust joins the next epoch. The full rules and golden test vectors are in
`services/sharer/spec` in the repository. To recompute a payout from the chain and compare it byte for byte, run
this in `services/sharer` of the repository at `https://github.com/Curb-Dev/curb/tree/c26d22acd2fa7faca115d43a3eeb656cc4e7f84e/services/sharer`,
with Node 22.18 or later, after `npm ci --omit=dev`:

```
node src/cli.ts verify --distributor <address> --epoch <n> --rpc <your RPC> --rpc <a second RPC> \
  --config https://<this site>/sharing/8453/config.json --site https://<this site>
```

It prints a verdict line - OK, MISMATCH or UNVERIFIABLE - with every problem it found below it. The exit code is 0
for OK, 1 for a mismatch and 2 when it could not check (UNVERIFIABLE).

### Events

- **CurbLaunchFactory:** `LaunchCreated(launchToken, curve, creator, supply, totalTaxBps)` when a launch is
  created. The registry emits `LaunchRegistered(launchToken, curve, beneficiary)` in the same transaction.
- **Curve:** `CurveBuy(buyer, recipient, quoteIn, tokensOut, fee, tax)` and
  `CurveSell(seller, recipient, tokensIn, quoteOut, fee, tax)`, where `fee` is the platform's share and `tax` the
  creator's. `CurveBuyRefunded(buyer, refund)` for a buy trimmed at the threshold.
  `FeesSwept(protocolAmount, buybackAmount, creatorAmount)` when fees move to the escrow, and
  `FeesRescued(protocolRecipient, creatorRecipient, protocolAmount, creatorAmount)` when the rescue pays them out
  directly. `AutoGraduationFailed(token, gasRemaining)` when the automatic move failed and the launch is Waiting.
- **Graduator:** `Graduated(launchToken, lock, tokenId, sqrtPriceX96, liquidity)` when the pool opens
  and its position is locked, and `RemainderBurned(launchToken, amount)` for the leftover tokens.
  `ReadyNoted(launchToken, at)` when a launch is first noted full and ungraduated, which opens its fee rescue to
  anyone `RESCUE_DELAY()` later.
- **FeeHook:** on every taxed pool swap, `FeePaidDirect(to, token, amount)` or `FeeAccrued(to, token, amount)`
  for each leg that is not zero, paid out or recorded as owed, then
  `FeeCharged(poolId, quoteToken, base, platformAmount, creatorAmount)`. `FeeClaimed(to, token, amount)` when owed
  fees are claimed; on WETH it comes with `PaidAsNative(to, amount)`, or `PaidAsWrapped(to, amount)` when the
  claimant refused ETH. `PlatformFeeBpsAnnounced(previous, next, readyAt)` and
  `PlatformRecipientAnnounced(previous, next, readyAt)` when a policy change is announced, and the matching
  `…Updated` or `…Cancelled` when it is applied or withdrawn.
- **FeeEscrow:** `Credited(recipient, token, amount)` and `Claimed(recipient, token, amount)`. On WETH, `Claimed`
  comes with `ClaimedAsNative(recipient, amount)`, or `ClaimedAsWrapped(recipient, amount)` when the claimant
  refused ETH.
- **PositionLock:** `PositionLocked(tokenId)` when it takes the position at graduation,
  `FeesClaimed(tokenId, to, amount0, amount1)` when LP fees are collected, `FeesHeld(party, currencyIndex,
  amount)` when a transfer of them was refused and they are held, and `FeesReleased(party, amount0, amount1)` when
  held fees are paid.
- **Holder sharing:** the Graduator's `HolderSharingEnabled(launchToken, distributor, factory, by, graduated,
  sinceBlock)`; the hook's `CreatorRedirected(poolId, launchToken, previous, distributor)` and the curve's
  `CreatorFeeRecipientUpdated`. The distributor's `Harvested(received0, received1)`, `RootPublished(epoch,
  merkleRoot, fromBlock, toBlock, dH0, dH1, dK, contentHash, uri, payableAt)`, `RootVetoed(epoch, reason)`,
  `RootActivated(epoch, root)`, `Paid(account, to, amount0, amount1, pushed)`, `PushSkipped(account, asset)`,
  `ExcludedLeaf(account)` and `KeeperPaid(payee, amount)`. The factory's `PublisherAnnounced`,
  `PublisherUpdated`, `PublisherRevoked`, `KeeperPayeeAnnounced`, `KeeperPayeeUpdated`, `VetoerSet`,
  `VetoerRemovalAnnounced`, `Frozen`, `UnfreezeAnnounced`, `UnfreezeCancelled` (a freeze that cancelled an
  announced unfreeze), `Unfrozen` and `PendingCancelled`; the catalog's `FactoryAdmitted`, `FactoryProposed`,
  `FactoryCancelled`, `FactoryRetired` and `RecommendedSet`.

### Fee routes

**On the curve**, the platform's share and the creator's share of each trade stay inside the curve. The creator
moves them to the escrow with `sweepFees(0)`, and graduation sweeps them automatically. In the escrow, which is
one per paired asset, each owner claims its own balance with `claimToken(asset)`. The rescue above is the only
other way out, and it pays both owners directly.

**In the pool**, the hook charges the tax on the paired-asset side: on a buy, on the whole input, before the swap;
on a sell, on the gross output, after it. Each leg is rounded down on its own: `base × bps ÷ 10,000`. On every
pair except WETH both legs are paid out in the swap, and a leg whose transfer is refused (for example by an
issuer) is recorded as owed instead of stopping the trade. On a WETH pool both legs are always recorded as owed.
Owners take what is owed with `FeeHook.claim(asset)`.

**WETH claims** from the escrow and the hook are paid as ETH. An address that refuses ETH gets WETH instead.

**The LP fee** stays in the locked position until `PositionLock.claimFees()` collects it for `feeRecipient()` -
the beneficiary, or the launch's distributor once it shares its fees - in both of the pool's tokens. On a WETH pool
that side arrives as WETH.

**With holder sharing on**, the curve's creator tax, the pool's creator leg and the LP fees all go to the launch's
distributor; the platform's share is unchanged.

**Buyback** is off: every launch records `buybackBurnBps` as 0, so no part of any fee goes to a buyback vault.
What the platform does with the fees it receives is a treasury decision, not contract code.

---

## Contracts and security

### CURB contracts

CURB is deployed on Base mainnet (chain id 8453), since 16 October 2026. These are its contracts; no other
contract is CURB's, whatever it claims.

| Contract | Address on Base |
|---|---|
| LaunchRegistry | `0x86e9a01F3959A96469051AE1a73D5C09b0BaC110` |
| Graduator | `0xA9865e07Ce4EC0cCf7A521B98640031285C92712` |
| FeeHook | `0xF85Ce05c2Ba8533d79f009fd3A3c8517aaBda0cC` |
| LaunchLens | `0xE6F85A3e97dD2F1a58acBA7A68a663E1f66C52c8` |
| SharingCatalog | `0xD337d59a1e300bf88F5566395C71Df7d5651c5eF` |
| HolderDistributorFactory | `0x3EBCCB246BA77D21a8a1f084CAF590c74FbC63b8` |
| CurbRouter | `0xEa20C3266229a01cd0f45D9c7921a45d5b359561` (see [CURB router](#curb-router)) |

Each paired asset's factory is listed by the registry (`launcherCount()`, `launcherAt(i)`). Each factory names
its own `quoteToken()`, `feeEscrow()`, `feePolicy()` and `buybackVault()`.

### Paired-asset addresses

These tokens are issued by others, not by CURB.

| Asset | Address on Base |
|---|---|
| WETH | `0x4200000000000000000000000000000000000006` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| cbBTC | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` |
| VIRTUAL | `0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b` |
| AERO | `0x940181a94A35A4569E4529A3CDfB74e38FD98631` |
| cbXRP | `0xcb585250f852C6c6bf90434AB21A00f02833a4af` |
| cbZEC | `0xB2000000000000000000008501b13360000cb2EC` |
| NVDAc | `0xb20000000000000000000078ee7ce2fE4908108C` |
| GOOGLc | `0xb2000000000000000000002D0BA3164cc74f58B7` |
| SPCXc | `0xb2000000000000000000007b9fcbd005511aCBd5` |
| AMZNc | `0xb200000000000000000000d9192b6B456483C2E8` |
| MSFTc | `0xB200000000000000000000Ab99cFa739E253872B` |
| AAPLc | `0xb200000000000000000000C2e324d24d7eEcd1fb` |
| METAc | `0xb2000000000000000000008bC8786B856E61707C` |

### Audits and security contact

The contracts were reviewed in house, with a final internal audit before the mainnet deployment. Its report
will be linked here. Like any contracts, they can still have bugs.

<!-- PLACEHOLDER (owner): the link to the final internal audit's report. -->

To report a vulnerability, write to **security@curbfun.xyz**. Please do not disclose it publicly until it is
fixed.
