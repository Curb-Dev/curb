================================================================================
web/app.html - the whole flow, and what it found missing
================================================================================

WHAT WAS THERE BEFORE, AND WHAT WAS NOT
  web/launch.html reads one launch's state and completes a waiting one. That is
  all it has ever done. It cannot create a launch, cannot trade, has nothing to
  say once a launch has graduated, and shows neither the LP lock nor the burn.
  So there was no point at which a person could see the product work.

  web/app.html is that path end to end: create a launch, trade the curve, cross
  the threshold, complete the move into the pool, trade the pool through the
  official router, and read the lock and the burn. Every button sends a
  transaction that is mined, and every result is taken from the receipt or from
  balances before and after.

    bash script/b20/start-node.sh
    bash script/b20/demo-app.sh          # deploys, funds two accounts, prints the addresses
    python -m http.server 8777 --bind 127.0.0.1 --directory web
    http://127.0.0.1:8777/app.html?factory=...&lens=...&rpc=http://127.0.0.1:8546

  launch.html stays as it is. It is the narrow, hardened page for the one
  transition that a stranger might have to complete, and eighteen scenarios and
  the Playwright gate are written against it.

FOUR THINGS THE FIRST VERSION OF THIS PAGE GOT WRONG
  Found by reading it, not by the tests, and all four were mine rather than the
  contracts'. Each is now covered by a test that fails when the fix is reverted.

  IT NEVER COMPARED THE WALLET'S CHAIN WITH THE RPC'S. Reads come from the RPC
  box and sends go through the wallet. The page quoted from one and sent to the
  other without ever asking whether they were the same network, and then looked
  for the receipt on the RPC - so a mismatch meant a transaction on one chain
  and a search on another. beginAction() now reads both and refuses a mismatch,
  the identity is PINNED for the whole action, the chain and account are
  re-checked immediately before dispatch, and the receipt is polled through the
  provider the transaction actually went through.

  NOTHING WAS RECORDED, so a reload lost the hash - which launch.html had been
  fixed for twice. The send now writes a pending record and resumePending()
  announces anything unaccounted for on the next load.

  A CLEARED FIELD LEFT A LIVE AMOUNT. The quote was stashed on the button's
  dataset and the action read it back: type 10, clear the box, press the button,
  and it spent ten NVDAc that was no longer on screen. The quote is now
  RECOMPUTED from the form at the moment of sending - both the preview and the
  action go through one function - and the button is disabled whenever there is
  no valid quote.

  THE GRADUATOR WAS READ ONCE, at load. Change the lens afterwards and the page
  went on offering to complete the move through the old deployment's graduator.
  It is re-read whenever the lens on screen changes.

  AND THE LAST BUY WAS PREVIEWED WRONG. A buy that takes the rest of the curve's
  allocation is not priced like the others: the contract prices that fill from
  the token side, grosses it back up so the fees still come out of the input,
  spends only that, and REFUNDS the difference. The preview clamped the token
  output but went on charging fees against the whole amount offered. It now
  shows offered, actually spent, refunded and charged as the four different
  numbers they are, and the end-to-end test compares all of them against the
  chain.

THE SEND-PATH PROTECTIONS ARE SHARED - web/tx-core.js
  The pending-record store, the preparation claim, the send lock and the receipt
  poll were written for launch.html one correction at a time. app.html needs
  every one of them, and a second copy would drift - the wallet stub already
  taught that lesson, where two runners tested different wallets while claiming
  to test one page. Both pages load tx-core.js.
    Nothing in it keeps state that belongs to a page: the page id and the send
    lock are handed out per context and the disposed flag is passed in, because
    the in-page harness evaluates launch.js repeatedly to make independent
    contexts and a shared id would quietly make two tabs into one.

WHAT BUILDING IT TURNED UP - open items in the CONTRACTS
  [x] launch() WAS OWNER-ONLY - CLOSED. It reverted with NotTheOwner for
      anyone but the factory's owner. It is open to anyone now (PRE_MAINNET
      A5): the caller is the creator, or names one in creatorWallet.
  [ ] THE CURVE HAS NO QUOTE FUNCTION. There is no previewBuy/previewSell, so
      every interface has to reimplement the pricing - fee, tax, constant
      product, and the clamp at the last fill - and stay in step with it by
      hand. web/app.js mirrors it and the end-to-end test asserts predicted
      against realised to the wei on a real trade, which is the only thing that
      keeps the copy honest. A view function on the curve would remove the
      problem rather than police it.
  [x] THE GRADUATOR STORED NEITHER THE LOCK NOR THE BURN - CLOSED. Both were
      only emitted, so every client had to scan logs for them against public
      endpoints that cap eth_getLogs at a 2,000-block range. The two getters
      this asked for exist now - Graduator.lockOf(token) and burnedOf(token) -
      and app.html reads them.
  [x] THE FEE HOOK'S RECIPIENT WAS THE DEPLOYER - CLOSED in the script. It is
      CURB_PLATFORM_RECIPIENT now, required and never inferred
      [DeployCurb.platformRecipient]. The local runners still set it to the
      deploying account (anvil's account 0), so on the fork a trade made from
      that account lands the swap output and the hook's fee in one balance - a
      first reading of the pool quote looked 1% wrong for exactly that reason
      and the quote was right. The demo trades from a second account that
      collects nothing, which is also the honest way to show that trading
      needs no privilege.
  Known before this round, and load-bearing here:
      the deployed UniversalRouter REJECTS the ExactInputSingle layout in our
      vendored periphery (ROUTER_ACCESS.txt). app.js builds the legacy layout,
      without minHopPriceX36. A page built against the vendored ABI would fail
      every swap.

WHAT HAD TO BE BUILT TO MAKE ANY OF IT POSSIBLE
  web/abi.js     a small ABI coder. The factory's launch() takes a ten-field
                 struct (LaunchConfig) with three strings; the router's execute() nests a
                 dynamic tuple inside bytes[]. Neither is hand-writable, and a
                 wrong offset reverts inside someone else's contract with no
                 hint that the calldata was the problem.
  web/keccak.js  keccak-256. The pool id is keccak(abi.encode(PoolKey)) - no
                 pool id, no price, no quote, no honest minimum-output bound.
                 Event topics are how a mined create's LaunchCreated is found
                 - in its own receipt, or through eth_getLogs when a replaced
                 create is adopted (TX.findReplacement in web/tx-core.js) - and
                 how a trade's receipt is read back (Transfer, CurveBuy,
                 CurveSell, Swap). The lock and the burn are NOT found this
                 way any more: app.html reads Graduator.lockOf and burnedOf
                 (above); this line said topics found them after the getters
                 had replaced the log scan.
                 Selectors are derived from signatures here rather than pasted.
  Both are checked byte for byte against `cast` in
  script/b20/selftest-abi.sh, including a pool id end to end through both.

A LAUNCH'S OWN PAGE: /token/0x...
  The same app.html, in its token view. The host rewrites /token/<address> to
  app.html (web/e2e/serve.js here; web/_redirects for Netlify or Cloudflare
  Pages, web/vercel.json for Vercel), and a script first in app.html's <head>
  sets html.tokenView and a <base> at the site's root. Its assets are linked
  from the root for the same reason, so the site is served from a domain's
  root.
  web/token.js draws the view: the token's name, picture and links; its price
  and market cap (the curve's reserve ratio, the pool's price after); a chart,
  the recent trades and the holders, from the chain's own events (CurveBuy,
  CurveSell, the PoolManager's Swap, Transfer); and what the creator has earned
  (FeesSwept, FeesRescued, the hook's FeeCharged) beside what is claimable now.
  It sends nothing itself: the swap card writes app.js's own fields and presses
  its own buttons, and the claim buttons are app.js's #owedBox, moved into the
  fees card. There is no indexer, so the history is read with eth_getLogs a
  window at a time from the launch's creation, up to about 46 days back; on a
  local fork (anvil_metadata says where it forked) never below the fork block.
  Dollar figures on every pair: each quote asset's own Chainlink feed on Base
  (prices.js USD_FEEDS - Coinbase's per-stock feeds, ZEC / USD, cbBTC / USD,
  CBXRP / USD, USDC / USD, VIRTUAL / USD, AERO / USD, ETH / USD), used once the
  feed's description() on chain names it; failing that, the asset priced in
  WETH through its Uniswap v3 market and ETH / USD; failing both, the asset's
  own units. The map was read back on chain on 2026-09-28, feed by feed,
  against each asset's symbol(), and the USDC, VIRTUAL and AERO rows on
  2026-10-15.
  ETHER BACK FROM A WETH SALE: the curve pays WETH, so app.js unwraps exactly
  what a sale paid (or a buy's refund) straight after, as its own send
  (unwrapPaid), after simulating it from the account - WETH9 pays with 2,300
  gas, and a contract wallet that cannot take that is told so instead of being
  asked to sign a revert. #unwrap ("Unwrap to ETH") turns any WETH held on a
  WETH pair's page into ether; token.js moves it into the swap card.
  web/e2e/token.spec.js tests it, the notices and the ETH default.

HOLDER SHARING - web/sharing.js, web/sharing-token.js, /sharing
  The launch form's "Who earns your tax" card, with Holders chosen, puts the
  SharingCatalog's recommended distributor version into LaunchConfig's last
  field (holderShareFactory; zero with You chosen), and reads the catalog again
  right before
  the send - a version retired while the form was open is not sent. On a
  launch's page, sharing-token.js draws the "Holders earn" card once its switch
  is on (the Graduator's holderDistributorOf, never the lens's word 15): the
  distributor's received / paid / keeper / unallocated figures, the payout in
  force or waiting out its veto hour, vetoes, every announced change to the
  roles behind it (the vetoer removals and catalog proposals from a bounded
  nine-day log read), Push pending payouts, the holder's own share with Claim
  and Claim to another address (offered when the issuer blocks the holder, or
  a simulated claim to them is refused), the history walked back file by file,
  and the check of a payout's file. For the creator wallet: the switch behind a
  typed confirmation, then the lock's held fees, and that the principal stays
  locked forever. Every send goes
  through app.js's beginAction / withSendLock / send.
  EPOCH FILES are used only when their sha256 is the contentHash the
  distributor holds: from the site's /sharing/<chain>/<distributor>/<epoch>.json
  first, then IPFS gateways for the URI in RootPublished. The check is
  services/sharer's own calculator: web/curb-share.mjs is a byte-for-byte copy
  of services/sharer/browser/curb-share.mjs (sharing.spec.js fails when it is
  stale - copy it again after `npm run bundle` there). The site's
  /sharing/<chain>/... path must be rewritten by the host to wherever the
  keeper publishes the files; /sharing itself is sharing.html (web/_redirects,
  web/vercel.json, web/e2e/serve.js).
  web/e2e/sharing.spec.js computes real payouts from the run's own chain with
  that calculator, publishes them with the deployment's publisher key, and
  serves their files to the page.

THE WALLET STUB NOW SENDS FOR REAL
  web/wallet-stub.js gained `forward: true`: eth_sendTransaction and the receipt
  call go straight to the node, which holds the key and signs. A hash coming
  back then means a transaction happened.
    This is the difference between demonstrating a page and demonstrating a
    product. Everything the stub answers itself can only test what the PAGE
    does; a transaction the chain executed is the only thing that tests whether
    the calldata the page built was right.
  It is off by default, because the eighteen in-page scenarios are about the
  page's behaviour AROUND a send - a rejection, a switched network, a lost
  record - and those need a send they control.

WHAT THE END-TO-END RUN ASSERTS - web/e2e/app.spec.js
  Seven steps, one session, real transactions throughout:
    the owner creates a launch      the token address comes from the
                                    LaunchCreated event, and the whole supply is
                                    really in the curve the lens names
    a curve buy                     the balance delta equals the quoted output
                                    EXACTLY - same integers, not "about right"
    a curve sell                    likewise, with the fee lines on screen
    Waiting, then completed         the threshold is crossed on a tight gas
                                    limit so the waiting state can be SEEN, the
                                    page reads it, and the permissionless button
                                    finishes it. Supply falls to 750,000,000
    the lock and the burn           read from the graduation's own events, and
                                    the lock address really is a contract
    a pool swap                     through the official UniversalRouter with
                                    the real two-step Permit2 flow; the delta
                                    equals the quoted output exactly
    and back out again              the same in the other direction

  Ten steps now, and EVERY ONE OF THEM PRESSES THE BUTTON. They used to call
  page.evaluate(() => CurbApp.curveAction()), which skips the onclick wiring and
  guard() entirely - unbind every button and the suite stayed green. Demonstrated:
  with the curve button unwired, the trade test fails.
    Three more: a cleared amount disables the button and sends nothing, a wallet
    on a different chain than the RPC cannot send, and the last buy's preview
    matches what the chain does with it.

  MUTATION-TESTED, each failing only the test that describes it:
    the curve button left unwired          the button-driven trade test
    the quote stashed on the button again  the cleared-amount test
    the wallet/RPC chain check removed     the other-chain test
    fees charged on the whole offer        the clamped-buy test
    app.js not using the shared send lock  the two-app-tabs test
    recovery gated on a token again        the created-and-reloaded test
    the storage warning overwritten        the would-not-store test

    app.js reading through the form again    the endpoint-routing test
    the create record cleared on receipt     the unstorable-address test
    the create's event found by the form's   the moved-on test
      factory instead of the pinned one
    results and read errors sharing a line   the moved-on test
    the hook and owner taken from the        the pinned-config test
      cached ctx instead of the pinned
      factory
    the graduator cache keyed on the form    the late-reply test
      after the await instead of on the
      lens the question went to
    one message for every send failure       the error-shapes test
    a refusal decided by the error's TEXT    the text-not-code test
    the graduator cache keyed on the lens    the two-answers test
      address without the endpoint

  Each pair is run from the same prepared state: the test passing first, then
  the mutation failing, and the failure read to check it was the assertion and
  not an empty account. app.spec.js checks the trading balance before anything
  else and says to restart the node, because an exhausted account once produced
  a failure I wrongly reported as a mutation being caught.

  THE PINNED-CONFIG TEST NEEDS TWO REAL DEPLOYMENTS. demo-waiting.sh and
  demo-app.sh each deploy their own stack and their hooks are different mined
  addresses, so the cache is poisoned with a value that genuinely belongs
  somewhere else. The assertion reads the calldata that was DISPATCHED rather
  than waiting for the transaction to succeed: with the wrong hook the chain
  rejects it, and "reverted on chain" does not say which hook was in it.

  A CLAIM THAT WAS WRONG, AND THE BUG IT HID. This file used to say the stale
  graduator could not be reached, because beginAction reads the launch through
  the lens on screen and refuses on NotFound. That missed where the staleness
  comes from. readGraduator sent its question to the lens in the form and then
  recorded the cache KEY after the await - the form's value when the ANSWER
  arrived. Move the lens to B and back to A while B's reply is in flight and B's
  Graduator was filed as A's, with the key saying A so every later refresh short
  circuited and kept it. NotFound never fires: the token really is registered in
  A. The send no longer used that value, but the lock panel still reads its logs
  from it - so the panel would go looking in a Graduator that never graduated
  anything.
    readGraduator now files an answer under what it was ASKED of - the lens AND
    the endpoint, because a lens address is not unique to a network - and
    discards one where either has changed since. The test parks B's reply, goes
    back to A, releases it, and then WAITS FOR THAT READ - not for a guess at
    how long it takes, and not for something else that finishes around the same
    time.
      THREE ATTEMPTS AT THAT WAIT, AND ONLY THE THIRD IS A GUARANTEE. A fixed
      sleep let the old code look correct simply by not having got round to
      storing the answer yet. Turning the event loop twice was a guess at how
      many turns the body read and the continuation take. Starting a NEW
      refresh and awaiting that was an argument about scheduling - its round
      trip OUGHT to outlast the continuation - and another network call
      finishing says nothing about whether this one's continuation has run.
      What the test keeps now is the promise of a refresh started while the
      lens was B. Its readGraduator asks lens B, blocks on the parked reply,
      and cannot resolve before the continuation that would file the answer has
      run; awaiting it is therefore a fact about this read rather than a race
      won. The change handler throws its own refresh away, so a second one is
      started in the same turn and both are parked - under the mutation both
      file the same wrong value, so the one that is awaited having finished is
      enough for the write to have happened.
    The assertion is positive, that what the page holds IS this lens's
    Graduator, since "not B's" is also true of an answer nobody has processed.

    THE ENDPOINT IN THE KEY IS TESTED AS BEHAVIOUR, not as the key's shape. An
    earlier version went to a dead port and back - where every other read fails
    too, and the old value looks right again on return - and then asserted on
    the shape of the key. Now TWO endpoints answer the SAME lens address with
    DIFFERENT Graduators, both through the interceptor and with no second node:
    switching from one to the other must change what the page holds, and
    switching back must change it again. With the key on the address alone the
    second endpoint's answer is never used, which is what the mutation shows.

  TWO MESSAGE AREAS. What a transaction did and what the page could not read are
  different kinds of thing, and they shared one line - so pointing the form at
  something that is not a factory wiped the address of the launch just created.
  Results stay in #msg; reading complaints go to #readmsg.

  THE ENDPOINT TEST, SECOND ATTEMPT. The first one changed the RPC field
  mid-action and asserted no buy happened - and passed with the pin removed, so
  it was deleted. The replacement gives the page TWO endpoint names, intercepts
  both, and records which URL every call went to; the form is moved from one to
  the other mid-action and the action must still be reading the first. The move
  waits for the wallet to ACTUALLY be asked - the stub exposes how many sends
  are in flight - rather than for a number of milliseconds, which on a slow
  machine is a coin flip between moving before the action pinned anything and
  moving after the send is already done.
    IT IS NOT A CHAIN TEST. Both endpoints are the same node behind an
    interceptor, so what it checks is ROUTING - where each call was sent - and
    not that two chains would give different answers. A second node that
    answered differently would test more.
    IT NAMES THE CALL. "A was used at all" is satisfied by any read, so the
    interceptor records the target and the calldata too, and the assertion is
    about the exact balanceOf(trader) ON THE TOKEN THE BUY DELIVERS - without
    the target in the filter it also matched the NVDAc balance in the header,
    a different read with its own reasons to move. Not "all of them went to A" -
    the rendering reads the same balances and correctly follows the form to B.
    The point is that once the form has moved, nothing in the rendering can
    reach A any more, so an A there can only be the action reading through its
    pin.

  TWO TESTS PASSED FOR THE WRONG REASON BEFORE THIS ROUND, and both were found
  by mutation rather than by reading. The created-and-reloaded test reloaded in
  place and was exercising the ordinary path, because the token was still
  remembered; it now runs on a fresh page and asserts its own setup - that
  nothing remembers the token and that the record to recover is present - before
  asserting anything else.

  THE REAL-WALLET RUN - DONE ONCE, WITH METAMASK, AND WHAT IT SHOWED.
    web/REAL_WALLET_TEST.txt is the checklist and script/b20/wallet-session.sh
    is what decided whether it passed. It passed: 13 of 13, exit 0. One person
    drove a real MetaMask through create, buy, sell, a decline, a wrong-network
    attempt, the crossing buy on a tight gas limit, the permissionless button
    and a pool trade. Everything below is what that run answered; the setup
    notes follow.

    WHAT IT RAN AGAINST - and these are two separate facts, which is why they
    are written separately:
      wallet        MetaMask 13.41.0
      fork ORIGIN   Base mainnet, block 51171034,
                    hash 0x7bfea0b62586ce94188b32d84f6037333fc6a0ac2d826f4bd2c3d7987075b35f
      chain id SERVED  84530, DELIBERATELY NOT Base's 8453
      other chain   an empty local chain at id 31337, for the network step
    The state is Base's; the id the node answers with is not, and was changed on
    purpose part-way through the setup - see THE NETWORK TO ADD below for what
    8453 did to MetaMask and why. Where the state came from is settled by the
    fork block and hash, never by the id.

    THE TRANSACTIONS, so the claims here can be checked against the chain:
      launch       0xba7b8213e6529b325438e3f11209d2772686e8622547aaebd86a9628466aeab5
      buy 1        0xe81c5983be018425d9f8d4651097b2076f4a471425d27ef8fa936caaaae0b10a
      buy 2        0x0e0824ad3b146a109bdc93e0279689bc6b0c831a57aa011bb52385500d5548de
      sell         0xb56481d87b075bf218a4dd27808d891ed4642fcf61852a9171f06301e863f115
      crossing buy 0x249f512f84a1c0492e8091627930a73773401e0d420b9db0b6bd8911130fb073
      graduate     0x6c953ff47ce6877aa86d93b58ee0b136bf7010b41c6714bd397fd0b811911376
      pool swap    0x19eca41bc5c3712ae55d89fd28b94a9b07db1e0ae51737cf0b97d10d7a5918f3
    with an approve before each trade and the two Permit2 approvals before the
    swap - 15 in the window, all from the wallet, which is the gate's first
    check and only means anything because prepare had locked the address again.

    A DECLINE REALLY IS 4001. This was the open question the whole file was
    hedged around: app.js treats EIP-1193 code 4001 as the only thing that means
    "nothing was sent", deliberately refusing to read the message text, and
    nobody knew what a real wallet sends. MetaMask sent 4001. The page said
    "Nothing was sent: you declined approve 10 NVDAc to the curve in the wallet"
    and the wallet's nonce did not move, on either chain.
      ONE WALLET, ONE VERSION, ONE KIND OF FAILURE. It says nothing about other
      wallets, and nothing about the failures that are NOT declines - a dropped
      connection or a provider erroring mid-send is still unobserved.

    THE WRONG NETWORK NEVER REACHED THE WALLET. With MetaMask on the scratch
    chain and the RPC box left alone, the page refused with "Your wallet is on
    chain 31337 and the RPC endpoint serves chain 84530", and the confirmation
    dialog NEVER OPENED - which the chain cannot show and the person watching
    could. Nothing entered a block on either chain.

    A CROSSING BUY ON A HAND-SET GAS LIMIT WORKED FROM A REAL WALLET. MetaMask
    let the limit be set to 900000 by hand, the curve's own graduation attempt
    FAILED - AutoGraduationFailed is on chain, carrying 28938 as the gas left in
    the catch, which is not a reason and not the gas the attempt was given - and
    the launch sat in Waiting with the reserve at exactly 60.0000 of 60. The clamped fill
    behaved: 66 NVDAc offered, 15.607880 spent, 50.392120 refunded, summing to
    the offer exactly.

    THE WAITING STATE AND THE PERMISSIONLESS BUTTON, DONE WITH A REAL WALLET.
      The first attempt at this missed it: the crossing buy went out with a gas
      limit of 9000000 rather than 900000 - a digit - and the curve's own
      graduation attempt had room to finish, so the launch went straight to
      Graduated and the state this button exists for never happened.
      Done again on the same stack, with a second launch rather than a fresh
      node, so the earlier transactions stayed readable.

      THE CROSSING BUY  0xd01f10cb4fad52aaf96605155bfaf18b1ee14d94359164d815b62fa0c434e531
        gas limit 900000, used 881521, status 0x1 - and at THAT receipt's block:
        readyToGraduate() true, graduated() false, the lens reporting 2, reserve
        6000000002 against a threshold of 6000000000. AutoGraduationFailed is
        in the logs with gasRemaining 12443. The page's clamped-fill preview
        had said the same shape beforehand - 45 offered, 17.5 spent, 27.5
        refunded, 16.8 into the curve onto a reserve of 43.2, landing exactly
        on 60.

        WHAT 12443 IS, AND WHAT IT IS NOT. An earlier version of this paragraph
        read it as "the curve tried, and 12443 was not enough". That does not
        follow from the event. gasleft() is evaluated INSIDE THE CATCH, after
        the failed call has already returned - so 12443 is what was left in the
        curve's own frame at that moment. It is not the gas forwarded to
        graduate(), and it is not a reason. The catch takes no data at all, so
        THE REVERT REASON WAS NOT RECORDED IN THIS EVENT OR IN THE RECEIPT.
        That is a statement about what was written down, NOT about what is
        knowable: a trace of the transaction can still be asked what the inner
        call did. Nobody has traced this one, so nothing here names a reason.
          TWO NUMBERS WORTH RECORDING, AND NOT MORE THAN THAT: the whole buy
          was capped at 900000, and graduate() sent on its own a moment later
          cost 1418962. They are not the same measurement. A nested call runs
          in a different context from a top-level one - no intrinsic cost, and
          storage the buy has already warmed - so the second number does not
          establish what the first attempt needed. Both are recorded; neither
          is a cause.
        What IS established by this transaction: the automatic attempt failed
        and the buy stood, with nothing mocked or injected anywhere in it.

      THE BUTTON  0x48b174d429b8abeb80bf2aafc6acb25d1b58099163ce660340841c9603af5d94
        graduate(), 1418962 gas, status 0x1. Afterwards: the lens reports 3, the
        lock at 0x0b38b389cb3324733389e0df48ed2091ff49a374 holds position 3047640
        with liquidity 1224744871711363585 until 1804686515 (2027-03-10 13:48
        UTC), and its beneficiary is the wallet.
        THE BURN IS MEASURED, not read off the event: RemainderBurned says
        249999999955559629528051149 and total supply moved
        1000000000000000000000000000 -> 750000000044440370471948851. The
        difference is the same number.

      WHAT 900000 IS: the value that produced this outcome in this environment,
      on this curve, at this point on it. It is not a guarantee of the Waiting
      state - the gas a buy needs moves with the state it runs against - and the
      receipt is what decides, which is why the check above reads the curve at
      the receipt's own block rather than trusting the number.

    THE ETH LEGS, DONE WITH THE SAME WALLET, AND THEY RECONCILE TO THE WEI.
      ETH -> token   0xe6bec2cdeb870089ac41f078da77e162d2e2f6e4f5056dda06376cdf9e933863
                     value 10000000000000000000, feeL2 444924917555934, and the
                     account fell by 10000444924917555934 - the value plus the
                     fee, exactly, nothing else.
      token -> ETH   0x082151be8beee600934a53867d013dce0067b75af3b06ebfd1f561911519c263
                     unwrapped 692467555169365252, feeL2 273003089090130, and
                     the balance rose by 692194552080275122. Unwrapped minus fee
                     is 692194552080275122: the same number.
      l1Fee is absent from this node's receipts in both, and the page says
      UNKNOWN rather than zero, which is the answer that is true here.
      So the page's two statements - what the TRANSACTION did, and what the
      BALANCE did - hold against a real wallet at full precision.
      THAT IS A CLAIM ABOUT THE ETH AND FEE ARITHMETIC IT REPORTS, and nothing
      wider. It does not say a previewed token output equalled the realised one
      on these trades - that was never compared here - and it certainly does not
      say the whole flow through a real wallet is sound, since the same run
      contains a wallet reporting failure for transactions that succeeded.

    AND A MESSAGE SAYING "FAILED" WAS SEEN, TWICE, WHOSE SOURCE IS UNKNOWN.
      Once on a curve buy: the page reported the buy, MetaMask reported a
      failure, the person retried, and BOTH buys are on chain with status 0x1 -
      20 NVDAc spent for one intended purchase. Once again on the ETH route,
      where four successful execute() calls were reported as failures.
      WHAT THE CHAIN SHOWS, and it is only this: nonces 10 to 31, contiguous,
      every one status 0x1. Two buys of ten NVDAc each on the curve, twenty
      NVDAc spent. No failed transaction, no gap.

      WHAT THE WALLET'S RECORD SHOWS: its activity list was checked afterwards
      and holds no failed entry.

      WHAT IS SAID RATHER THAN SHOWN: that a message reading "failed" appeared
      twice, that one purchase was intended, and that the second was sent
      because of that message. That comes from the person at the keyboard, and
      it is the only account of it there is. The two records above are
      consistent with it and do not establish it.

      SO THE SIGHTING STAYS OPEN. Source, wording and timing are all unknown -
      nothing was captured, and the absence of a failed row afterwards does not
      say what was on screen at the time, only what is there now. This file does
      not call it transient, a mis-report, a prediction, or anything else,
      because it has no grounds to. The runbook says to capture it and read the
      chain before resending; that is what would settle it.
        The second sighting was not seen again after the gas limit was returned
        to the wallet's own estimate, a manual one having been left over from
        the tight-limit step. A sequence, not a cause - and silent about the
        first, whose limits were the wallet's own.
      What the page did was right in every case: it reads the receipt, so it
      said the trade had happened because it had.

    WHAT MATCHED, AND AT WHAT PRECISION - stated carefully, because the first
    version of this paragraph got it wrong.

      EXACT, IN RAW UNITS: the sell's CurveSell.quoteOut is 470742214 and the
      wallet's NVDAc balance moved 198000000000 -> 198470742214, a delta of
      470742214. Event and balance agree exactly. Fee was 1.0000% and creator
      tax 3.0000% of the gross, both in NVDAc.

      NOT ESTABLISHED: whether a QUOTE equalled its realisation. The page prints
      six decimals and the raw quote is not recorded anywhere, so the comparison
      can only be made at the resolution of a display. At that resolution they
      agree, and that is all this run shows.

      AND A RETRACTION. This file first said the pool quote's 4045403.871017
      "arrived as 4045403.871018", reported as a one-unit difference. There was
      no difference. The realised net output is 4045403871017936841026317 raw;
      the page TRUNCATES it to 4045403.871017 and the script that checked it
      ROUNDED it to 4045403.871018. Two display conventions applied to one
      number, reported as a measurement. It was also called "1 wei", which at 18
      decimals would have been 10^12 times smaller than the figure quoted.
        The lesson is the reason for the fix below: a page that prints six
        decimals of an eighteen-decimal amount cannot be checked against the
        chain by reading it.

    AND ONE REAL FINDING ABOUT THE PAGE: ITS SUCCESS MESSAGE CAN MISLEAD.
    After the pool swap it said "You received 4,086,266.536381 tokens, measured
    from your balance before and after". True, and not what the swap gave. The
    PoolManager made TWO transfers to that address: 4045403.871018 of swap
    output and 40862.665364 of HOOK FEE, because DeployCurb makes the deployer
    the fee recipient and prepare deploys from the wallet under test. The number
    on screen is swap output plus fee income added together with no sign that
    they are different things.
      demo-app.sh already trades from a SEPARATE account for exactly this
      reason and says why. The page had no such protection and showed the
      conflated number to whoever was looking.

      FIXED. Both trade paths now report from THIS TRANSACTION'S RECEIPT.
        the curve   from its own CurveBuy / CurveSell event - what went in, what
                    came out, the fee and the creator tax, and the refund when
                    a buy was clamped
        the pool    from the PoolManager's Swap event for this pool. The hook
                    emits NOTHING - it pays by calling poolManager.take, which
                    looks like any other transfer - so what it charged is
                    recomputed from the gross and its own feeBps, and then
                    CHECKED against the receipt's transfers rather than assumed.
      Three numbers, said separately: what the swap produced, what the hook took
      and where it went, and what this transaction moved into the account. When
      they do not reconcile the page says so and tells the reader to go to the
      transaction, rather than choosing whichever figure it likes.
        THE BALANCE IS STILL READ on the curve path, through the pinned
        endpoint, as a CHECK - and it is what the pinned-reads test observes.
        A disagreement with the event is now reported as what it is: this token
        moved for some other reason too.
      AND THE EXACT FIGURES ARE ON SCREEN, in the smallest unit, beside the
      readable ones. That is not decoration: fmt() truncates to six decimals,
      which is how the first report of this run compared a truncation against a
      rounding and called the artefact a measurement.

      AND THE CHECK ON THE HOOK'S FEE IS A CHECK NOW. The first version compared
      net + fee against what arrived. That is not a test: net IS gross - fee, so
      for an account that is ALSO the fee recipient the fee cancels and the
      whole thing reduces to gross === credited. A fee computed from the wrong
      bps takes the same amount out of net and puts it back in, and passes - in
      exactly the account the reading exists for.
        Each payment the PoolManager made is now matched to a PAYEE and an
        AMOUNT: the net output to the trader, the fee to the recipient the hook
        names, and nothing else. The same address means two payments still have
        to be there, with those two amounts, rather than one of their sum.

      Covered by four tests.
        BOTH DIRECTIONS FROM BOTH ACCOUNTS - one that is the fee recipient and
        one that is not - requiring the page's own exact figures to satisfy
        net + fee = gross, to agree with an independently measured balance
        delta, and for the recipient to show the total as strictly greater than
        the swap. Mutated by taking the swap output from the credits again,
        which is the original bug: it fails with "net + fee should be the
        gross", expected 3986707189658867586406940, received
        4026574261555456262271009 - the fee counted twice.
        A LIE ABOUT feeBps, intercepted on the way to the hook: 500 where it
        charges 100. The page must refuse to print figures it cannot account
        for. Mutated back to the sum check, this is what it passed with:
          gross     3745354315091808313296076
          hook fee   187267715754590415664803   five times the real fee
          net       3558086599337217897631273
          credited  3745354315091808313296076   = net + fee
        The page said the hook took 187,267.7 tokens when it took 37,453.5, and
        the old check had nothing to say about it.
        A READ THAT FAILS AFTER THE SEND. The hook's settings are read to
        report, after the receipt. Letting that throw put the page on the
        generic error path - and a person who has just paid, reading "something
        failed", sends it again. It now says the transaction SUCCEEDED, that the
        result could not be read, and gives the hash; the test also checks the
        balance really did move, so "succeeded" is not being said about nothing.
        THE CURVE'S OWN NUMBERS, against the event and against a balance.

    THE BURN AND THE SUPPLY ARE SHOWN ROUNDED. The page said 249,999,999 burned
    and a supply of 750,000,000; the amounts are 249999999.913893 and
    750000000.086107. Not wrong, just coarser than the numbers it is reporting
    from, and the burn is the one figure a reader might want exactly.

  WHAT THE RUN NEEDS, AND WHAT IT MUST NOT BE GIVEN.

    NEVER A WALLET THAT HOLDS ANYTHING. Use a browser profile with a throwaway
    wallet and nothing else in it. The account this demo funds is an anvil dev
    account whose private key is published in anvil's own startup output and in
    its documentation - it is public, every one of these keys is, and anything
    ever sent to it on a real network is gone. It exists to sign against a local
    fork and for nothing else.

    THE NETWORK TO ADD
      name      Curb local fork
      RPC       http://127.0.0.1:8546
      chain id  84530, from SERVE_CHAIN_ID - NOT 8453
      currency  ETH

    WHY NOT BASE'S OWN ID, WHICH IS WHAT THE FORK OTHERWISE REPORTS. A real
    wallet cannot tell 8453 from 8453. MetaMask merged the localhost endpoint
    into its existing Base entry, labelled the network Base, priced gas in
    dollars - and ran its own HOSTED transaction simulation against the PUBLIC
    chain, where a contract deployed on this fork does not exist. Every
    confirmation came up "this transaction is likely to fail".
      That warning was false: the node's own eth_estimateGas succeeded every
      time, and nothing was ever broadcast. But a wallet that cries wolf on all
      ten steps is a wallet whose warnings cannot be read, and reading them is
      most of what the run is for - step 8 starves the gas limit on purpose, and
      steps 4 and 6 are about refusals.
      SERVE_CHAIN_ID makes the node answer with an id of its own, so the wallet
      treats it as a custom network: no fiat pricing, no hosted simulation, and
      no way to mistake the public chain for this one. start-node.sh passes it
      to anvil and verify-fork.sh requires the node to serve exactly it.

    WHAT PINS THIS NODE TO BASE IS THE FORK BLOCK AND HASH, not the chain id -
    and verify-fork.sh's chain check never said otherwise, though its message
    did. anvil_metadata's forkedNetwork.chainId follows --chain-id rather than
    reporting the network the state came from, so comparing it to a literal
    8453 and failing with "expected 8453 (Base)" read as evidence of where the
    state came from and was nothing of the kind. It now compares to
    SERVE_CHAIN_ID, and eth_chainId - which is what a wallet actually sees - is
    asked separately and must agree.

    WHAT IT IS FOR - the things the stub cannot answer
      gas estimation            the stub never estimates; a real wallet does,
                                and a launch or a graduation is a large call
      replacement transactions  speeding up or cancelling from the wallet, and
                                what this page then shows for the old hash
      the wallet's error shapes app.html separates a decline - EIP-1193 code
                                4001, AND NOTHING ELSE - from every other
                                failure, which it reports as NOT CERTAIN
                                NOTHING WAS BROADCAST. The text is deliberately
                                not consulted: a provider failing for its own
                                reasons can wrap a message that says "user
                                rejected" while the transaction went out
                                anyway. Which codes a real wallet actually
                                sends is the open question
      the confirm dialog        left open for minutes, and a network switched
                                inside it

    THE TWO PAGES ARE NOT THE SAME, and an earlier draft of this section
    credited app.html with launch.html's work. launch.html has the
    uncertainChain flag - a chainChanged seen WHILE the confirm dialog is open,
    which no test has ever triggered - and judges a settled transaction against
    the snapshot it was sent with. app.html has neither. It distinguishes the
    decline from the uncertain failure, which is the part that stops a user
    paying twice, and nothing more; a switch inside its dialog is caught by the
    receipt poll noticing the wrong chain, not by a flag.

    HOW TO DRIVE IT
      export SERVE_CHAIN_ID=84530       # see THE NETWORK TO ADD above
      bash script/b20/start-node.sh
      bash script/b20/scratch-node.sh   # the OTHER chain, for the network step
      node web/e2e/serve.js
      bash script/b20/wallet-session.sh prepare --wallet 0xYOURTESTADDRESS
    SERVE_CHAIN_ID has to be set for prepare too: it calls verify-fork.sh, which
    now requires the node to serve exactly that id and refuses otherwise.
    then follow web/REAL_WALLET_TEST.txt and finish with

      bash script/b20/wallet-session.sh verify

    THE WALLET DEPLOYS THE STACK here, rather than the trader account
    demo-app.sh prints, and is its platform recipient and policy owner, so the
    fees the run earns come back to the wallet that signed it. (This used to
    say it had to be the factory's owner because launch() was owner-only; it
    has been open to anyone since PRE_MAINNET A5.)

    THE OTHER NETWORK IS A LOCAL ONE ON PURPOSE. Checking that the page refuses
    when the wallet is on a different chain means switching the wallet to
    another chain, and the obvious ones are real. A page that turned out to have
    the bug would then broadcast to Ethereum or to Base mainnet, with a real
    wallet, for real - the test would have caused the thing it was looking for.
    scratch-node.sh is an empty chain with a chain id that is not the fork's.

    AND THE CHECK LOOKS AT BOTH CHAINS, because that is where a mistaken send
    would have gone. Reading only the fork was the first version and it had the
    fault backwards: a page that wrongly sent while the wallet was on the other
    network would leave the fork untouched, and the step would pass for the one
    reason it must not. The session records the scratch chain, `mark` reads the
    wallet's nonce and height on both, and the wallet is FUNDED on the scratch
    chain on purpose - an unfunded account is refused by the node, and the check
    would then pass because the node said no rather than because the page did.
    A session prepared while that chain was down makes the step FAIL, rather
    than pass on the fork alone.

    WHAT THOSE TWO CHECKS ARE ABOUT IS WHAT ENTERED A BLOCK, and they say so.
    They are not evidence that the wallet's dialog never opened, that no request
    left the page, or that the button was pressed at all: a transaction can sit
    in a mempool or be refused by a node and leave nothing behind. The person
    following the runbook saw those things; the chain did not.

    AN ACCOUNT UNLOCKED BY prepare IS LOCKED AGAIN EVEN WHEN prepare DIES. The
    stopImpersonating calls used to sit inline after the work, so `set -e` made
    "the deployment failed" and "the funding failed" both end with the account
    still unlocked - the one outcome that voids the gate's first claim, reached
    by the most ordinary path there is. They are in an EXIT trap now, and the
    self-test injects a failure at each of those two stages and then asks the
    node whether it will still accept a transaction from the address.

    WHAT DECIDES WHETHER IT PASSED IS NOT THE PAGE. `verify` reads the chain
    afterwards - which transactions were mined, who sent them, what they called
    and what moved - and exits non-zero if any required step is missing. The
    page's own account of what happened is the thing under test, so it is not
    evidence. `prepare` turns anvil's impersonation back off before the session
    starts, which is what lets "every transaction came from the wallet" mean
    the wallet's key signed it.

    THE THREE STATES ARE READ AT REAL BLOCKS, not inferred from the page:
    Selling at the block of the first buy, Waiting in the block BEFORE the
    button was pressed, Graduated now. The burn is measured as the difference in
    total supply either side of the graduation block and required to equal
    exactly what RemainderBurned says - the event on its own is not the
    measurement.

    THE GATE ITSELF IS TESTED. script/b20/selftest-wallet-gate.sh replays the
    flow one step at a time with script/SelfTestWalletFlow.s.sol and requires
    the gate to refuse at every point where a step has not happened yet - and
    then, from ONE green session, mutates it four times: a transaction between
    the refusal marks on the fork, one on the OTHER chain (which reading the
    fork alone cannot see), a session with no other chain recorded at all, and a
    transaction from an address that is not the wallet. Each must turn the gate
    red for its own check while the rest still passes, and the green session is
    re-run in between to show the failure came from the mutation and not from
    the extra transaction.
      That flow is BROADCAST FROM AN UNLOCKED ANVIL ACCOUNT, not signed by a
      wallet. The gate cannot tell the difference, which is the whole reason
      `prepare` turns impersonation off - and the reason the self-test is a
      test OF the gate rather than a substitute FOR the real run.

    GRADUATION IS AUTOMATIC ON THE BUY THAT CROSSES, and this cost a first
    draft of the self-test: a loop that bought until readyToGraduate() found the
    launch already Graduated and the next buy reverting with CurveGraduated.
    Waiting only exists when that automatic attempt runs out of gas, so the
    crossing buy is sent on a gas limit of 900000 - and the runbook asks the
    person to set that in the wallet's own advanced settings, because otherwise
    the permissionless button never has anything to do.

  NOT covered: a real wallet. The confirm dialog, the signing and the broadcast
  are still the stub's, even when it forwards - what a real wallet does about
  gas estimation, replacement transactions and its own error shapes is untested.
  The harness above is ready for that run; it has not been done.

  EVERY RUN BRINGS ITS OWN NODE, ON ITS OWN PORT (8549 by default,
  CURB_E2E_RPC_PORT). global-setup stops whatever is there, starts a fresh fork
  pinned to the same block, prepares against it, and global-teardown stops it
  again. Nothing has to be cleaned up by hand between runs, and a hand-driven
  wallet session on 8546 is left alone.
    WHY, RATHER THAN MORE FUNDING. demo-waiting.sh and demo-app.sh together hand
    out more NVDAc than the whale this fork borrows from holds twice over - it
    has about 5,797 and they fund four accounts with 2,000 each - so a second
    run on the same node failed IN SETUP with InsufficientBalance, and a run
    started on a used node failed somewhere in the middle for the same reason.
    Handing out more would postpone that; runs not spending each other's
    balances ends it.
    Measured: two consecutive `npx playwright test` runs, 36 of 36 each, with no
    cleanup in between, and the node on 8546 still answering afterwards.

  FAST RUNS. Set CURB_RPC / CURB_LENS / CURB_TOKEN / CURB_APP_FACTORY /
  CURB_APP_LENS and global-setup attaches to stacks that are already deployed
  instead of deploying two more - seconds rather than minutes, which is what
  makes a mutation run per fix practical.

================================================================================
web/launch.html - the launch state page
================================================================================

WHY IT IS A LOCAL FILE AND NOT A PUBLISHED PAGE
  It has to talk to an RPC endpoint and to a wallet. A published artifact
  cannot: its content security policy blocks fetch and XHR to everything, so a
  page that reads a chain cannot be one. This is a file you serve and open.

RUNNING IT AGAINST THE LOCAL FORK
  1. bash script/b20/start-node.sh
  2. A=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
     FOUNDRY_BROADCAST=broadcast/local CURB_DEMO_LAUNCH=true \
     CURB_PLATFORM_RECIPIENT=$A CURB_ALLOW_EOA_RECIPIENT=true \
     CURB_ALLOW_EOA_POLICY_OWNER=true CURB_ALLOW_SAME_RECIPIENT_AND_OWNER=true \
       base-forge script script/DeployCurb.s.sol --rpc-url http://127.0.0.1:8546 \
       --broadcast --unlocked --sender $A
     Every variable is needed: the recipient is required, and anvil's account
     is one key, which the script refuses as recipient and as policy owner
     unless told (the command here used to have none, and reverted).
     FOUNDRY_BROADCAST keeps this run out of broadcast/DeployCurb.s.sol/8453/,
     where the mainnet run records itself (DEPLOY.txt STEP 1).
     Take LaunchLens and the demo launch token from the output. The page reads
     the Graduator from the lens; it is not typed. This moves the pinned node
     off its block, so restart it before the Solidity fork suite.
  3. Serve this directory - it must not be opened as file://, because a page
     on a file origin cannot fetch an http RPC:
       python -m http.server 8777 --bind 127.0.0.1
     then open http://127.0.0.1:8777/launch.html
  4. Paste the lens and token addresses and the RPC endpoint. Reading needs
     no wallet.

THE BROWSER SCENARIOS ARE NOW A FILE, NOT A STORY
  web/tests.html runs web/launch.js - the real page logic, loaded from the same
  file the page loads, not a copy - against a stub wallet and the real fork.
  Every scenario gets a fresh page: every context the suite has created is
  RETIRED first, the markup is re-inserted from launch.html, storage is cleared
  and launch.js is re-evaluated. Retiring matters as much as the rest - a
  receipt poll started by one scenario outlives the DOM it was drawing to, and
  for a while it was writing its messages into the next scenario's page.
  Earlier the evidence for all of this lived only in a chat transcript.

    python -m http.server 8777 --bind 127.0.0.1 --directory web
    http://127.0.0.1:8777/tests.html?lens=...&token=...&rpc=...&auto=1

  The launch must be in the Waiting state first; the suite checks that and
  skips the rest rather than passing vacuously if it is not.

  Eighteen scenarios, all passing:
    the launch under test is Waiting
    a user rejection sends nothing
    a network change during preparation aborts before sending
    a network change inside the confirm dialog makes the outcome uncertain
    a rejection names the token it was FOR, not the one in the form
    an unresolved transaction is shown after a reload with NO wallet
    a second send is refused while one is unresolved
    the error path does not read the launch on a different chain
    two page contexts sending at once produce ONE transaction
    a browser that cannot store the hash says so
    the lock is released when a state check refuses the send
    a record another tab wrote is seen INSIDE the lock, not before it
    two different launches recording at once keep BOTH records
    a browser without Web Locks is told the guard is weaker
    a record written WHILE the lock is being taken still stops the send
    a migration that cannot store anything keeps the old records
    a store too damaged to parse is kept, and the user is told where it is
    a record for the same token under ANOTHER lens does not outrank this one

  The last four came out of the round that followed. The first two were the
  same complaint twice: an existing test was not carrying the weight its name
  claimed. Test 12 wrote the other tab's record BEFORE the send started, so a
  check placed before the lock would have seen it too - it could not tell the
  two orderings apart; test 15 plants the record while the lock is being
  granted, which only a check inside the lock can catch. Test 16 came from the
  migration writing the new keys and deleting the old one without looking.
  Tests 17 and 18 are the two data-loss paths found by reading afterwards: a
  store too damaged to parse was being treated as empty and deleted, and a
  pending record was matched on chainId + token while identity everywhere else
  is chainId + lens + token.

  Each of the four was mutation-tested: with the fix reverted, that scenario -
  and only that scenario - fails.

  IT FOUND A REAL BUG WHILE BEING WRITTEN. With a transaction in flight, a
  chainChanged event ran the page's own resumePending(), which announced that
  very transaction as "unaccounted for from a previous visit" and overwrote the
  message describing what had just happened to it. Records this page created,
  and records it is currently settling, are now excluded from that path.

FOUR MORE, FOUND ON A LATER READ
  4. THE NETWORK CHECK HAD A GAP BETWEEN CHECKING AND SENDING. chainId was read
     once, several round trips happened, then the transaction went out - so a
     switch in between would send to a target verified on a different chain.
     The provider object was re-read on every call too, so a wallet swapped
     underneath could answer half the checks and receive the send.
     Now: the provider object is pinned for the whole preparation, and the
     chain AND account are re-read immediately before dispatch. A change
     between them aborts with nothing sent.
  5. A REJECTED SEND STILL READ THE FORM. The error path called refresh(),
     which reads whatever token the form holds now - so declining A's
     transaction while the form had moved to a graduated B could report
     "someone else completed it", about B. The error path now reads the PINNED
     token, and says when that is no longer the one on screen.
     It also distinguishes three outcomes instead of one: a failure BEFORE the
     wallet was asked (nothing was sent, definitely), a user rejection
     (nothing was sent), and anything else after dispatch (it is NOT certain
     nothing was broadcast).
  6. THE TRANSACTION RECORD WAS ONLY IN MEMORY, so "the hash is kept" was true
     only until the tab was reloaded - which is exactly when someone goes
     looking for it. The chain, token, target and hash are now persisted, and
     on the next visit the page picks the transaction back up and finishes
     judging it.
  7. AND IT WAS ONLY SHOWN TO USERS WHO ALREADY HAD AN UNLOCKED WALLET.
     resumePending() ran only when a connected account was found at load, which
     is the least likely state after a reload. It now runs on every load, on
     connect, and on chainChanged - with or without a wallet.
     Records are also a LIST keyed by chainId + hash rather than one slot, so a
     second send cannot silently overwrite the first, and a send is refused
     outright while an earlier one for the same launch is unresolved - read
     back from storage, so another tab's transaction counts too.

WHAT THE LAST ROUND CHANGED
  CONCURRENCY, SECOND PASS. The first attempt had four holes, all found by
  reading rather than by the tests, and all now covered by them:

    THE LOCK LEAKED. Two branches - "already graduated" and "not Waiting" -
    returned from inside the locked section while still holding the Web Lock
    and the claim. A Web Lock is held until its page releases it or closes, so
    that made the launch un-sendable in every other tab, and the claim's
    three-minute expiry did nothing about a lock. Everything after acquisition
    is now one try/finally, and a test asserts the lock is free after a refusal.

    THE PENDING CHECK WAS OUTSIDE THE LOCK. A tab could read "none outstanding",
    lose the race, wait for the lock to free, and then send on that stale
    reading. The order is now: take the lock, THEN re-read the records, the
    chain, the account and the state, then send, then release in the finally.

    THE PENDING LIST HAD THE SAME LOST-UPDATE. One key holding a list is a
    read-modify-write, and two tabs sending for DIFFERENT launches hold
    differently-named locks, so nothing excluded them - the second write simply
    dropped the first record. There is now ONE STORAGE KEY PER TRANSACTION, so
    there is no shared cell to lose. Old single-list records are migrated on
    load rather than stranded.

    NO WEB LOCKS MEANT NO PROTECTION, SILENTLY. The code returned success when
    the API was missing and also when it threw, while the write-up said two tabs
    could not both send. Now: a missing or throwing API is reported as
    unsupported, the page says so in the confirm message, and the guarantee is
    scoped to browsers that have it. In the others the storage claim is all
    there is, and two tabs interleaving inside it can still both send.

  CONCURRENCY. "Another tab counts too" was only true of a tab that had already
  received a hash. Two tabs could both look, find no record, and both open a
  confirm dialog - the record is only written once a hash comes back. A claim
  is now taken BEFORE the dialog opens.
    The localStorage claim alone is NOT a mutex, and the test proved it: both
    contexts read an empty list and the second write clobbered the first, so
    the read-back check could not see the conflict. localStorage has no
    compare-and-set to fix that with. navigator.locks is the primary gate -
    real mutual exclusion between contexts of one origin - and the storage
    claim stays for what a lock cannot do: outlive the page, expire on its own
    (three minutes, so a tab closed mid-dialog does not lock a launch forever),
    and let the other tab SAY what is happening instead of just failing.

  WHICH RECORD IS TRACKED. resumePending() took all[0], so a stale record on
  another chain could hide a newer one on the chain the user is actually on -
  permanently, since nothing here would ever resolve it. Records are now sorted
  by whether they match the current chain and the launch on screen, and the
  others are listed rather than left invisible.
    "The launch on screen" means chainId + lens + token, which is what identity
    means everywhere else in the file. The first version scored on chainId +
    token alone, so a record belonging to a DIFFERENT LaunchLens deployment
    could outrank the one for the launch actually being looked at - the same
    token address exists under both. The message also names the lens when it is
    not the one on screen; without that, two such records read as one.

  STORAGE THAT KEEPS NOTHING. savePending() swallowed the failure while the
  page went on implying the hash would survive a reload. It returns whether the
  record is actually on disk - written is not stored, so it reads back to check
  - and when it is not, the page says the hash will be LOST and shows it to
  copy. That warning is carried into every later message rather than being
  overwritten by the next one, which is how the first attempt failed its test.

A NOTE ON ONE DEFENCE THAT HAS NOT FIRED
  The uncertainChain flag - set if the wallet reports a network change while
  the confirm dialog is open - has never been the thing that caught a switch in
  testing, because the receipt poll notices the wrong chain first and reports
  it. It is kept for the case the poll cannot see: a switch away and back again
  while the dialog is open. That case is not tested.

A CLAIM NARROWED
  Reading graduator() from the lens through the wallet does NOT prove which
  network you are on. A fork carries the same addresses as the chain it forked
  from, so a fork and its mainnet are indistinguishable this way. What the
  check catches is a network where this deployment is ABSENT, or where it is a
  DIFFERENT one. Reported as that, not as network identity.

THREE THINGS THE FIRST VERSION GOT WRONG
  1. It never checked that the wallet was on the network the displayed state
     came from, and the Graduator was typed into the form independently of the
     lens. A chainId check alone would not have been enough either: a local
     fork answers 8453 exactly as Base mainnet does. So before sending, the
     page now reads graduator() FROM THE LENS THROUGH THE WALLET. If the lens
     is not deployed on the wallet's network the call returns nothing and the
     send is refused; if it is deployed but reports a different Graduator than
     the displayed state did, the send is refused as well. The Graduator field
     is read-only and populated from the lens.
  2. A transaction in flight was not pinned to anything. The token, lens, RPC
     and wallet network could all change before the receipt landed, and the
     result was then checked against whatever the form said - so A's
     transaction could be confirmed by B's state. Every send now captures
     {chainId, lens, token, graduator, account} and the outcome is judged
     against that snapshot, saying so explicitly when the form has moved on.
  3. The error message lived inside the state card, which is hidden whenever
     reading fails - so the first connection or RPC error was invisible
     exactly when it mattered. It is now outside the card. And a receipt that
     does not arrive is no longer reported as a failure: the hash is kept, the
     reason is named, and the page warns that sending again could pay for the
     same move twice.

WHAT WAS ACTUALLY EXERCISED, AND WHAT WAS NOT
  Verified against the fork, through the page:
    Selling      progress read from the curve and rendered - 0%, then 32.00%
                 after a 20 NVDAc buy
    Waiting      reached by A REAL FAILED ATTEMPT, not by injection - nothing
                 was mocked: the crossing buy was sent with a 900,000 gas limit,
                 while graduate() sent on its own measures about 1.5 million -
                 a different call context, so not a measurement of what the
                 nested attempt needed. The buy succeeded, the curve emitted
                 AutoGraduationFailed carrying 29,483 (gasleft() inside the
                 catch, after the call returned - not the gas the attempt was
                 given, and no reason: the catch keeps none, and neither the
                 event nor the receipt records one), and the launch sat
                 ready-but-ungraduated. The page showed Waiting, offered the
                 button, and disabled it with no wallet connected.
    Graduated    an UNRELATED account completed the move (1,470,274 gas) and
                 received nothing for it. The page refreshed to Graduated, with
                 the supply down to 750,000,000 - the quarter that was burned -
                 and the pool key it should route to.

  The wallet paths were then driven with a STUBBED window.ethereum against the
  real fork - the chain reads and the chain state are genuine, the wallet
  interaction is simulated. Each of these was run, not read:

    user rejects            "Nothing was sent: User rejected the request." with
                            zero transactions sent and the button re-enabled
    receipt never arrives   the hash is kept and the message says it may still
                            be mined, NOT that it failed
    network switch in       "Could not confirm <hash>: the wallet switched
    flight                  networks while the transaction was in flight"
    form changed in flight  the result names the token it was SENT for and says
                            it is no longer the one in the form
    someone else finished   the pre-send check reads the chain, finds it
    first                   Graduated and sends NOTHING - the user's gas is not
                            spent on a move that already happened
    the send target         went to the Graduator read from the lens, never a
                            typed address
    network switch DURING   caught by the re-check immediately before dispatch:
    preparation             "Nothing was sent - the wallet changed networks
                            while this was being prepared", zero transactions
    A rejected while the     "Nothing was sent (for 0x68f8ac…, no longer the one
    form moved to B         in the form): you declined it in the wallet" - about
                            A, and explicitly NOT "someone else completed it"
    page reloaded with a    the hash survived in storage and the page picked it
    transaction in flight   up: first "still not been mined", then - once the
                            receipt landed - judged and cleared from storage

  IT IS NOW A COMMAND THAT CAN FAIL - see the next section.

  NOT exercised: a REAL wallet. The browser used has no injected provider, so
  the stub stands in for the confirm dialog, the signing and the broadcast.
  What a real wallet does differently - gas estimation, replacement
  transactions, its own error shapes - is untested.

THE BROWSER CHECKS AS A GATE - web/e2e
  One command. It prepares its own launch, runs everything in a real browser,
  and exits non-zero if anything fails.

    cd web/e2e && npm install && npm test

  WHAT IT DOES FOR ITSELF
    global-setup.js prepares TWO starting points, because the two suites need
    different ones:
      demo-waiting.sh  a launch already WAITING, for launch.spec.js and the
                       eighteen in-page scenarios
      demo-app.sh      a stack with no launch and two funded accounts, because
                       app.spec.js creates its own launch from the page - one
                       factory per DeployCurb.quoteAssets() entry, the USDC,
                       VIRTUAL and AERO ones assets.spec.js uses among them
    Each deploys its own stack; sharing one would let a step in either suite
    leave state the other silently depends on. Addresses are read back out of
    what the scripts reported. Preparing the stage by hand was the reason these
    checks were never a gate. The fork node has to be up already:
    bash script/b20/start-node.sh.

    A STUCK TRANSACTION POOL IS NOW REFUSED UP FRONT. A queued transaction is a
    nonce gap, and every later send from that account collides with it - anvil
    calls that "replacement transaction underpriced", thirty seconds into a
    deploy, with nothing in the message about the cause. It cost a run here,
    left behind by a browser session driving the node by hand, so verify-fork.sh
    checks txpool_status and says what to do.
    serve.js serves web/ with cache-control: no-store, started by Playwright.

    AND THE NODE IS PROVED BEFORE ANYTHING IS PUT ON IT. Answering block-number
    is not evidence of being the pinned fork: a node forked from any other
    block answers it perfectly well, and everything measured afterwards would
    then be about a chain nobody chose. demo-waiting.sh runs verify-fork.sh
    first, which reads the node's OWN fork metadata - origin chain, fork block
    AND fork block hash - and refuses to deploy on a mismatch. --identity is a
    mode that skips the B20-versus-mainnet comparison further down that file,
    because a check that has to pass before every automated run should not
    depend on Base mainnet being reachable.

    IT VERIFIES THE NODE IT DEPLOYS TO, which took two goes to get right. The
    first version verified whatever env.sh named - always 127.0.0.1:8546 -
    while the deployment went to demo-waiting.sh's own overridable $RPC. Point
    RPC at another node and node A was checked while node B received the
    deployment, and the gate reported success. verify-fork.sh now takes
    --rpc <url>, parsed AFTER env.sh is sourced so the default cannot win, and
    demo-waiting.sh passes the RPC it is about to use.
      It does NOT demand a fresh node, and nothing here claims one: this script
      deploys its own stack, so it works at any height at or above the fork
      block. REQUIRE_FRESH=1 adds that demand for callers who do need it - the
      Solidity fork tests do, because they assert on constants measured from
      the starting state. Read as a VALUE: the first version used
      ${REQUIRE_FRESH:+--fresh}, which turned REQUIRE_FRESH=0 into a demand for
      a fresh node.

    THE GATE HAS ITS OWN TEST: script/b20/selftest-fork-gate.sh. It starts a
    second node forked from a different block and requires that the pinned node
    still passes, that the wrong one is rejected, and that demo-waiting.sh with
    RPC pointed at it refuses. With the --rpc plumbing removed it fails at
    exactly that step, reporting that demo-waiting.sh deployed to a node that is
    not the pinned fork.

      EVERY REJECTION IS CHECKED FOR ITS REASON, not merely for failing. "The
      node is not the pinned fork" is printed for a metadata mismatch AND for a
      node that cannot be reached at all, so a test that only looked for that
      string would pass just as happily when the node it meant to reject had
      simply gone away - measured: pointing RPC at a dead port produces exactly
      that sentence. The wrong-node cases now require the fork-point line
      naming both blocks, and the fresh case requires "--fresh requires an
      untouched node".

      WHAT THE UNCHANGED HEIGHT SHOWS, EXACTLY. The node mines a block per
      transaction, so a height that does not move means no transaction of ours
      was INCLUDED. That is not the same as "no send was attempted" - proving
      that needs a record of the RPC calls made, which nothing here keeps. The
      narrower claim is the one the test makes.

    It also checks all three readings of REQUIRE_FRESH - unset, 0 and 1 - using
    CHECK_ONLY=1 to stop demo-waiting.sh straight after the gate rather than
    paying for a deployment to find out which mode was chosen. The unset case
    runs under `env -u REQUIRE_FRESH`, because a value inherited from whoever
    ran the script would otherwise decide it, and it would be the one case that
    silently tested something else. All three pin RPC to the good node: they
    are about the MODE, and a mode test that drifted onto another node would
    prove nothing about it.
      It leaves the pinned node one block further on - telling 0 from 1 needs a
      node that is not fresh - so restart the node before running the Solidity
      fork suite.

  THE BROWSER. Microsoft Edge by default, through Playwright's `channel`, so
  `npm install` pulls three packages and no browser build. CURB_E2E_BROWSER=
  chromium uses the bundled one instead, after `npx playwright install
  chromium`.

  ESCAPE HATCHES
    CURB_LENS / CURB_TOKEN / CURB_RPC   skip preparation, attach to a launch
                                        that is already Waiting
    CURB_PREPARE_CMD                    run something else to prepare it
    CURB_WSL_DISTRO                     the default command on Windows goes
                                        through `wsl` because base-forge lives
                                        there and Node does not
    CURB_E2E_PORT                       default 8778

  FOURTEEN TESTS ACROSS TWO SPEC FILES. app.spec.js is the whole user flow
  described at the top of this file - seven steps, real transactions - and
  launch.spec.js is the seven below, about the narrow completion page.

  THE SEVEN IN launch.spec.js, AND WHY THEY ARE NOT THE EIGHTEEN AGAIN
    the eighteen in-page scenarios all pass
        Drives tests.html and reads window.__testResults. Skips are failures
        here: eighteen skipped scenarios would otherwise look like a clean run.
    launch.html wires its own script and reads the chain
        tests.html evaluates launch.js itself and never loads launch.html as a
        page, so a broken <script src> leaves all eighteen green. Demonstrated:
        with the tag pointed at a filename that does not exist, the tests here
        fail and the in-page eighteen still pass.
    an already-permitted wallet is recognised at load, with no click
        init() reads eth_accounts itself - the path a returning visitor takes.
        Every other test clicks connect first, so a broken auto-detect would
        hide behind that click in all of them.
    a wallet that has NOT granted permission is not treated as connected
        The other half of the same behaviour, and the reason the first is not
        vacuous: an auto-detect that always reported an account would pass the
        test above. The stub models the real permission split now -
        eth_accounts returns [] until eth_requestAccounts grants it.
    a connected wallet sends one transaction, to the Graduator the lens reported
    an unresolved transaction survives an actual page reload
        A new document and a new script run, not a re-evaluation standing in
        for one.
    two real tabs produce ONE transaction
        Two pages of one context: one origin, one localStorage, one Web Locks
        namespace. tests.html says outright that it cannot build this - "they
        cannot have separate DOMs here" - and asserts on the wallet instead.

  MUTATION-TESTED, because a gate that has never failed is not a gate. Each one
  fails ONLY the test that describes it:
    <script src> pointed at a missing file   the page tests fail, exit 1, and
                                             the in-page 18 stay green - which
                                             is exactly the gap this closes
    both cross-tab guards disabled           the two-tabs test AND the in-page
                                             gate fail, exit 1
    the lens dropped from record scoring     only the in-page gate fails, and
                                             it names the scenario, exit 1
    init() stops reading eth_accounts        only the load-time recognition
                                             test fails, exit 1
    init() asks permission on every load     only the not-permitted test fails,
      (eth_requestAccounts at load)          exit 1
    the fork pin moved to another block      demo-waiting.sh refuses to deploy,
      or another hash                        exit 1 before anything is sent

  ONE FIX WITH NO TEST BEHIND IT, said plainly: the provider used to be set up
  in a second addInitScript that called what the first one defined. Playwright
  does not define the order in which separate init scripts run, so that worked
  by luck rather than by rule. It is one script now. Nothing here can
  demonstrate the difference - an undefined order cannot be made to fail on
  demand - so this is correctness by construction, not by measurement.

  STILL SIMULATED: the wallet. web/wallet-stub.js is shared by both runners -
  one file, so they cannot drift - and it forwards eth_call to the fork, so
  chain reads and chain state are real while the confirm dialog, the signing
  and the broadcast are not.

THE GAS QUESTION, NOW PARTLY ANSWERED
  The open item asked whether enough gas survives the 63/64 rule for the
  curve's catch to run. At a 900,000 limit it did, with 29,483 left. That is
  one data point at one limit, not a proof for all of them.

  THE NONCES OF THAT RUN, kept because they are what the wallet's own activity
  list has to be compared against: 10 to 31, contiguous, every one of them
  status 0x1. No transaction failed on that chain at any point, while the wallet
  reported failures twice. So either it mis-reported transactions it had sent,
  or it refused to send ones that never took a nonce - and which of those it was
  is the question the next attempt has to answer, by recording the message and
  matching it to a nonce before anything is sent again.
