================================================================================
CURB - BASESCAN VERIFICATION INPUTS: FeeHook, Graduator, PositionLock
================================================================================
STATUS: PREPARED 18 October 2026. NOTHING HAS BEEN SUBMITTED. The owner
        submits these by hand on Basescan's Verify & Publish form,
        basescan.org/verifyContract.
        Sourcify already serves FeeHook and Graduator as exact matches
        (ADDRESSES.txt, EXPLORER VERIFICATION); Basescan does not, and the
        Uniswap hook allowlist wants a block explorer [PRE_MAINNET C7].
        PositionLock cannot be verified yet: no launch has graduated, so no
        lock exists (PositionLock, below).

WHAT IS HERE
  FeeHook.standard-json-input.json       the file to upload, one per contract
  Graduator.standard-json-input.json
  PositionLock.standard-json-input.json
  FeeHook.constructor-args.txt           the form's "Constructor Arguments
  Graduator.constructor-args.txt         ABI-encoded" field: hex, no 0x
  check.js                               compares all of it with the chain
                                         (WHAT WAS CHECKED)
  PONS_V2_COMPAT.txt                     a separate finding: CURB's curve
                                         against the Pons V2 curve 0x lists on
                                         Robinhood Chain

WHERE THE INPUTS CAME FROM
  The deployment's toolchain, base-forge 1.6.0-v1.1.0 (ADDRESSES.txt,
  "toolchain"), run in WSL in a checkout of a1a9d694:
    base-forge verify-contract <address> src/curb/<Name>.sol:<Name> \
      --chain 8453 --show-standard-json-input --compiler-version 0.8.30 \
      --num-of-optimizations 200 --via-ir --evm-version cancun \
      --compilation-profile default
  src/, lib/, foundry.toml and remappings.txt are unchanged between the
  deployed commit c26d22ac and a1a9d694 (git diff --stat is empty), and the
  metadata hash below is the deployed one, which settles it for these three
  files. Forge printed one log line ahead of the JSON (a missing cache file);
  that line was cut off and nothing else was changed.
  Inside every file: solc 0.8.30, optimizer on, 200 runs, viaIR true,
  evmVersion cancun, bytecodeHash ipfs, and forge's fifteen auto-detected
  remappings. KEEP THEM EXACTLY AS THEY ARE: the remappings and every source
  path are part of the metadata hash at the end of the deployed code, so a
  tidied file compiles to the same code with a different hash, and Basescan
  then reports a partial match at best.

THE FORM - THE SAME TWO PAGES FOR EACH CONTRACT
  Page 1, basescan.org/verifyContract:
    Contract Address               the address below
    Compiler Type                  Solidity (Standard-Json-Input)
    Compiler Version               v0.8.30+commit.73712a01
    Open Source License Type       MIT License (MIT) - the contract's own
                                   file (src/curb/<Name>.sol) says SPDX MIT;
                                   some library files inside the JSON say
                                   otherwise (Graduator's include v4-core's
                                   Pool.sol and Position.sol, BUSL-1.1), and
                                   the form asks for one licence
    I agree to the terms of service  a required checkbox on page 1; ticking
                                   it is the owner's acceptance, not ours
  Page 2:
    Standard-Input-Json file       <Name>.standard-json-input.json
    Constructor Arguments          the contents of <Name>.constructor-args.txt
    ABI-encoded                    (one line of hex, no 0x)
    contract name, if the page     src/curb/<Name>.sol:<Name>
    asks for one
  Optimization, runs, EVM version and via-IR are not asked on this path: the
  JSON carries them. Tick the explorer only when it shows the source, as
  ADDRESSES.txt says, not when the request is accepted.

  BLOCKSCOUT (base.blockscout.com) takes the same files with no account or
  key, through its page https://base.blockscout.com/address/<address>/contract-verification:
  method "Solidity (Standard JSON input)", compiler v0.8.30+commit.73712a01,
  upload <Name>.standard-json-input.json, licence MIT, automatic constructor
  arguments OFF and <Name>.constructor-args.txt pasted. Its API answers
  scripts with a Cloudflare challenge, so the page is the way.

  FeeHook     0xF85Ce05c2Ba8533d79f009fd3A3c8517aaBda0cC
    name      src/curb/FeeHook.sol:FeeHook
    upload    FeeHook.standard-json-input.json
    args      FeeHook.constructor-args.txt, 160 bytes, in constructor order:
                poolManager_        0x498581fF718922c3f8e6A244956aF099B2652b2b
                platformRecipient_  0x6724eb5C59D617B1c65d88Cc6734B19b9E0eB7eE
                registry_           0x86e9a01F3959A96469051AE1a73D5C09b0BaC110
                poolOpener_         0xA9865e07Ce4EC0cCf7A521B98640031285C92712
                owner_              0x97D3be57653B4E14ECEe182Bf0B754AAAF47BfcE
    CREATED THROUGH THE CREATE2 DEPLOYER 0x4e59b44847b379578588920cA78FbF26c0B4956C
    (salt 0x...2bea, tx 0xedd4296d1f3ffed26a86d2530e3538f3bd602aef4c4ee834c6fde6e444a24e99).
    The transaction's input starts with the salt, so the explorer may not
    find the arguments by itself: paste them.

  Graduator   0xA9865e07Ce4EC0cCf7A521B98640031285C92712
    name      src/curb/Graduator.sol:Graduator
    upload    Graduator.standard-json-input.json
    args      Graduator.constructor-args.txt, 160 bytes, in constructor order:
                poolManager_        0x498581fF718922c3f8e6A244956aF099B2652b2b
                positionManager_    0x7C5f5A4bBd8fD63184577525326123B519429bDc
                permit2_            0x000000000022D473030F116dDEE9F6B43aC78BA3
                registry_           0x86e9a01F3959A96469051AE1a73D5C09b0BaC110
                sharingCatalog_     0xD337d59a1e300bf88F5566395C71Df7d5651c5eF
    A plain creation by the deployer (tx
    0xfee92de7b93b6c11011060a985ad02821ddaef3332d1c60060374d97146049c3).

  PositionLock - NOT YET. See the next section.
    name      src/curb/PositionLock.sol:PositionLock
    upload    PositionLock.standard-json-input.json
    args      none prepared: they belong to a lock that does not exist yet

POSITIONLOCK: ONE PER LAUNCH, MADE AT GRADUATION
  The Graduator creates each lock with `new PositionLock(...)` when a launch
  graduates. At Base block 52,745,772 registry.launchCount() was 1 ($CURB)
  and Graduator.lockOf($CURB's token) was the zero address, so there is
  nothing to verify. The input is ready and checked against the code every
  lock will be created from (WHAT WAS CHECKED).
  WHEN THE FIRST LAUNCH GRADUATES:
    1. The lock's address: Graduator.lockOf(<launch token>), or the `lock`
       topic of the Graduator's Graduated(launchToken, lock, tokenId,
       sqrtPriceX96, liquidity) event.
    2. node deploy/verify/check.js <dir> --lock <address>
       (<dir> as in WHAT WAS CHECKED). It checks that lockOf names the lock,
       that its sharingSource is the Graduator and that its code is this
       build's with its immutables masked, and prints the 320-byte argument
       string read from the lock's own getters: positionManager,
       beneficiary, the pool key's five words (poolKeyView), tokenId,
       sharingSource, launchToken. That path has NOT been run against a
       lock - there is none - so read what it prints before pasting it.
    3. The form as above, with that string as the arguments.
  Every later lock is the same code with other immutables. Basescan may then
  match them by itself; if it does not, each one is a submission of its own
  with its own arguments.

WHAT WAS CHECKED, 18 October 2026, against Base mainnet (Tenderly's keyless
gateway, block 52,746,446)
  Each JSON file here was compiled exactly as it is with the stand-alone
  solc 0.8.30+commit.73712a01 (sha256 of the Linux binary f3e987dc...c428f7),
  and check.js compared the result with the chain:

  FeeHook
    CREATION   the creating transaction went to the CREATE2 deployer; its
               input is the salt 0x...2bea, then the compiled creation code
               (12,096 bytes), then FeeHook.constructor-args.txt (160 bytes):
               byte for byte. That also checks the arguments.
    RUNTIME    eth_getCode is 11,248 bytes, the build's too. Equal once the
               3 immutables (poolManager, registry, poolOpener; 20 places)
               are zeroed on both sides, and they differ nowhere else. The
               values at those places are constructor words 0, 2 and 3.
    METADATA   the trailer is identical, ipfs hash 1220 9ecaed8a...e64bd8bd
               and solc 0.8.30: a full match, sources and settings included.
  Graduator
    CREATION   a plain CREATE; its input is the compiled creation code
               (19,935 bytes) then Graduator.constructor-args.txt (160
               bytes): byte for byte.
    RUNTIME    19,389 bytes on both sides. Equal once the 5 immutables (30
               places) are zeroed, and nowhere else different; their values
               are constructor words 0 to 4.
    METADATA   identical, ipfs hash 1220 c69f580c...d2ad6cae, solc 0.8.30.
  PositionLock
    The compiled creation code, metadata included (4,918 bytes), is inside
    the deployed Graduator's runtime code verbatim, at byte 14,386 - the
    code every lock will be created from. So the first lock should be a
    full match with this input; only its arguments are still unknown.
  Both argument files are the record's arguments
  (deployments/base-mainnet/run.json), encoded, as well as what the chain's
  creating transactions carried.

  THE CHECK WAS SHOWN TO FAIL. Fed three outputs each wrong by one byte - a
  FeeHook runtime byte outside the immutables, a Graduator creation byte,
  a byte of PositionLock's metadata hash - it printed FAIL on exactly those
  three lines and exited 1. With --lock pointed at a contract that is not a
  lock (the FeeHook) it stops on the reverted getter and exits 1.

  TO RUN IT AGAIN. In WSL, with the solc forge installed, compiling FROM AN
  EMPTY DIRECTORY over stdin: inside the checkout solc quietly reads any
  source missing from the JSON off disk, so a file Basescan would refuse as
  incomplete still compiled (shown with PoolId.sol taken out of
  PositionLock's JSON: from the checkout it compiled to the same code, from
  an empty directory it failed "Source ... not found"):
    S=~/.local/share/svm/0.8.30/solc-0.8.30; O=/mnt/c/dev/tmp/verify-out
    C="$PWD"; mkdir -p $O
    for n in FeeHook Graduator PositionLock; do
      (cd "$(mktemp -d)" && $S --standard-json < "$C/deploy/verify/$n.standard-json-input.json") > $O/$n.out.json
    done
  then from the checkout in Windows (node 22, which has fetch):
    node deploy/verify/check.js C:/dev/tmp/verify-out
  It ends "check: ok" or names each failure and exits 1. It sends
  eth_blockNumber, eth_getCode, eth_getTransactionByHash and, with --lock,
  eth_call. Nothing else.
