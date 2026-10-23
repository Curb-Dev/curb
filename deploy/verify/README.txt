================================================================================
CURB - EXPLORER INPUTS: FeeHook, Graduator, PositionLock, CurbRouter
================================================================================
STATUS: READ OFF THE EXPLORERS' OWN PAGES ON 19 OCTOBER 2026 - Basescan's
        basescan.org/address/<address>#code and Blockscout's
        base.blockscout.com/address/<address>?tab=contract, each opened and
        its verification line read, nothing submitted from here:

                                      Basescan        Blockscout
        FeeHook                       Exact Match     exact match
        Graduator                     Exact Match     exact match
        LaunchRegistry                Exact Match     exact match
        LaunchLens                    Exact Match     exact match
        SharingCatalog                Exact Match     exact match (1)
        HolderDistributorFactory      Exact Match     exact match (2)
        $CURB token (CurbLaunchToken) Exact Match     exact match
        $CURB curve (PonsV2BondingCurve)
                                      Exact Match     partial match (3)
        WETH factory (CurbLaunchFactory)
                                      Exact Match     exact match
        CurbRouter                    Exact Match     partial match (4)
                                      (23 October, from
                                      CurbRouter.standard-json-input.json)

        Every Basescan line names the contract, v0.8.30+commit.73712a01,
        "Yes with 200 runs", cancun and LICENSE "-NA-". Every Blockscout
        match says "verified using Blockscout Bytecode Database". The
        Blockscout times are the page's clock, UTC+3.
        (1) "Contract creation code" and "Verify & publish" on the first
            visit; exact match minutes later, "Verified at Oct 19, 2026
            0:18:38". Blockscout looks a contract up in its bytecode
            database when its page is read, and that can take a while.
        (2) The same, slower: on three visits Blockscout labelled it
            "Proxy" ("detected via Generic Proxy - implementation()
            getter": the factory's implementation() names the distributor
            it clones) and showed only its creation code and "Verify &
            publish"; on the fourth, still "Proxy", exact match, "Verified
            at Oct 19, 2026 0:20:22", src/curb/sharing/
            HolderDistributorFactory.sol.
        (3) Not this build's source: solc 0.8.35+commit.47b9dedd,
            contracts/src/v2/PonsV2BondingCurve.sol - the same runtime code
            from another submission (ADDRESSES.txt, EXPLORER VERIFICATION).
        (4) "This contract has been partially verified using Blockscout
            Bytecode Database": CurbRouter, 0.8.30+commit.73712a01, cancun,
            200 runs, src/curb/CurbRouter.sol, "Verified at Oct 18, 2026
            23:54:06".
        Basescan's CurbRouter page said "Are you the contract creator?
        Verify and Publish your contract source code today!" until the
        owner submitted THE FORM, CurbRouter, on 23 October 2026: Basescan
        answered "Successfully generated matching Bytecode and ABI" and the
        page shows "Source Code Verified (Exact Match)".
        LEFT FOR THE OWNER: on Blockscout CurbRouter's partial match may be
        submitted again with the
        same file (THE FORM, BLOCKSCOUT). PositionLock waits for the first
        graduation (POSITIONLOCK, below). Tick ADDRESSES.txt only from what
        the page shows.

WHAT IS HERE
  FeeHook.standard-json-input.json       the file to upload, one per contract
  Graduator.standard-json-input.json
  PositionLock.standard-json-input.json
  CurbRouter.standard-json-input.json
  FeeHook.constructor-args.txt           the form's "Constructor Arguments
  Graduator.constructor-args.txt         ABI-encoded" field: hex, no 0x
  CurbRouter.constructor-args.txt        EMPTY (0 bytes): the router has no
                                         constructor, so there is nothing to
                                         paste - leave the field empty
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

  CURBROUTER, 19 October 2026, the same toolchain in a checkout of 7453eccd,
  with the router's own profile:
    base-forge verify-contract 0xEa20C3266229a01cd0f45D9c7921a45d5b359561 \
      src/curb/CurbRouter.sol:CurbRouter --chain 8453 \
      --show-standard-json-input --compiler-version 0.8.30 \
      --num-of-optimizations 200 --via-ir --evm-version cancun \
      --compilation-profile router
  The router was sent from c26d22ac (deployments/base-mainnet/router-run.json,
  "commit"), and src/, lib/, foundry.toml and remappings.txt are unchanged
  between c26d22ac and 7453eccd (git diff --stat is empty). Its profile has
  no metadata hash (foundry.toml), so here the proof is the bytecode alone:
  the creation input and the runtime code are equal byte for byte (WHAT WAS
  CHECKED). Forge printed nothing ahead of the JSON this time; its trailing
  newline was dropped, as the other three files end, and nothing else was
  changed. Inside: eleven sources (src/curb/CurbRouter.sol and ten
  OpenZeppelin files, every one SPDX MIT), solc 0.8.30, optimizer on, 200
  runs, viaIR true, evmVersion cancun, metadata bytecodeHash "none" with
  appendCBOR true, and the same fifteen remappings. Keep it as it is too:
  without "none" the build ends in an ipfs hash the chain does not have.

THE FORM - THE SAME TWO PAGES FOR EACH CONTRACT
  Page 1, basescan.org/verifyContract (?a=<address> fills the address in):
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
    then "Continue"
  Page 2:
    Standard-Input-Json file       <Name>.standard-json-input.json
    Constructor Arguments          the contents of <Name>.constructor-args.txt
    ABI-encoded                    (one line of hex, no 0x)
    contract name, if the page     src/curb/<Name>.sol:<Name>
    asks for one
  Optimization, runs, EVM version and via-IR are not asked on this path: the
  JSON carries them. Tick the explorer only when it shows the source, as
  ADDRESSES.txt says, not when the request is accepted.
  Page 1 was read again on 19 October 2026 at
  basescan.org/verifyContract?a=0xEa20C3266229a01cd0f45D9c7921a45d5b359561:
  the address filled in, "Solidity (Standard-Json-Input)" among the compiler
  types, v0.8.30+commit.73712a01 among the versions, "3) MIT License (MIT)"
  among the licences, the terms checkbox and "Continue". Page 2 is behind
  "Continue" and was not opened.

  BLOCKSCOUT (base.blockscout.com) takes the same files with no account or
  key, through its page https://base.blockscout.com/address/<address>/contract-verification:
  "Contract license" MIT License (MIT), "Verification method (compiler
  type)" Solidity (Standard JSON input), "Compiler" v0.8.30+commit.73712a01,
  "Standard Input JSON" <Name>.standard-json-input.json, then "Verify &
  publish". For CurbRouter, on 19 October, those four fields were all the
  page showed once the method was chosen - no constructor-arguments field
  and no contract name (not submitted). For a contract with arguments, if
  the page offers automatic constructor arguments, turn it OFF and paste
  <Name>.constructor-args.txt. Its API answers scripts with a Cloudflare
  challenge, so the page is the way.

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
    DONE: Exact Match on Basescan and on Blockscout (STATUS).

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
    DONE: Exact Match on Basescan and on Blockscout (STATUS).

  CurbRouter  0xEa20C3266229a01cd0f45D9c7921a45d5b359561  DONE ON BASESCAN (23 October 2026)
    Contract Address     0xEa20C3266229a01cd0f45D9c7921a45d5b359561
    Compiler Type        Solidity (Standard-Json-Input)
    Compiler Version     v0.8.30+commit.73712a01
    Licence              MIT License (MIT) - src/curb/CurbRouter.sol says
                         SPDX MIT, and so do all ten library files in the JSON
    upload               CurbRouter.standard-json-input.json
    name, if asked       src/curb/CurbRouter.sol:CurbRouter
    Constructor          LEAVE IT EMPTY. CurbRouter has no constructor;
    Arguments            CurbRouter.constructor-args.txt is empty and the
                         record's arguments are null.
    Optimizer and the rest are not asked: the JSON carries them - enabled,
    200 runs, viaIR true, evmVersion cancun, and metadata.bytecodeHash
    "none", the "router" profile (foundry.toml). Do not edit the file to
    change any of it.
    CREATED THROUGH THE CREATE2 DEPLOYER 0x4e59b44847b379578588920cA78FbF26c0B4956C
    by the deployer 0xf7bbb6559EcB5cBb0aFf372413a316C26b280426 (nonce 79),
    tx 0xd067dae04d9729baa4ff80a51946aabd3e59b5dad3b3e13be6b6b65f6edfccc6,
    block 52,664,234, salt
    0x088fbe04e4b31e7ab7b495d4bdd4f817062afb40ec511c1728d6da45b92e2483.
    The transaction's input is that salt followed by the creation code and
    nothing else, so there are no arguments for the explorer to find or for
    anyone to paste. Basescan's page already knows the creator ("created by
    the contract code at 0x4e59..."), as it did for the FeeHook.
    NO METADATA HASH: its code ends a164736f6c634300081e000a, which is
    CBOR for {"solc": 0.8.30} and nothing else. A match therefore proves the
    bytecode, not the comments or file paths (foundry.toml says why the
    router is built so). What label the explorer gives such a match is the
    explorer's; read it off the page and write that down.

  PositionLock - NOT YET. See the next section.
    name      src/curb/PositionLock.sol:PositionLock
    upload    PositionLock.standard-json-input.json
    args      none prepared: they belong to a lock that does not exist yet

POSITIONLOCK: ONE PER LAUNCH, MADE AT GRADUATION
  The Graduator creates each lock with `new PositionLock(...)` when a launch
  graduates. At Base block 52,745,772 registry.launchCount() was 1 ($CURB)
  and Graduator.lockOf($CURB's token) was the zero address, so there is
  nothing to verify; read again on 19 October 2026 at block 52,784,579: still
  1 and the zero address. The input is ready and checked against the code
  every lock will be created from (WHAT WAS CHECKED).
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

WHAT WAS CHECKED, 19 October 2026, against Base mainnet (Tenderly's keyless
gateway, block 52,784,386)
  Each of the four JSON files here was compiled exactly as it is with the
  stand-alone solc 0.8.30+commit.73712a01 (sha256 of the Linux binary
  f3e987dc...c428f7), each from a new empty directory, and check.js compared
  the result with the chain. It ended "check: ok". The first three are as on
  18 October (block 52,746,446), and printed the same again:

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
  CurbRouter
    ARGUMENTS  CurbRouter.constructor-args.txt is empty and the record
               (router-run.json) has no arguments.
    CREATION   the creating transaction went to the CREATE2 deployer; its
               input is the salt 0x088fbe04...2483, then the compiled
               creation code (7,867 bytes), then nothing (0 bytes of
               arguments): byte for byte.
    RUNTIME    7,841 bytes on both sides, equal byte for byte - it has no
               immutables, so nothing is masked.
    METADATA   NONE TO COMPARE. Both trailers are a164736f6c634300081e000a,
               the compiler version alone; check.js says so and checks that
               shape on both sides instead of comparing a hash.
    ADDRESS    besides check.js, base-cast in WSL on the compiled output:
               the CREATE2 address from 0x4e59...4956C, that salt and the
               creation code is 0xEa20C3266229a01cd0f45D9c7921a45d5b359561,
               and keccak256 of the compiled runtime code is
               0x25814dde01efddddcc582ba476471c80ce6de85154d1ee6a357f28cb67b37c5e,
               the runtime code hash ADDRESSES.txt and DEPLOY.txt STEP 4A pin.
  PositionLock
    The compiled creation code, metadata included (4,918 bytes), is inside
    the deployed Graduator's runtime code verbatim, at byte 14,386 - the
    code every lock will be created from. So the first lock should be a
    full match with this input; only its arguments are still unknown.
  The FeeHook and Graduator argument files are the record's arguments
  (deployments/base-mainnet/run.json), encoded, as well as what the chain's
  creating transactions carried.

  THE CHECK WAS SHOWN TO FAIL. On 18 October, fed three outputs each wrong
  by one byte - a FeeHook runtime byte outside the immutables, a Graduator
  creation byte, a byte of PositionLock's metadata hash - it printed FAIL on
  exactly those three lines and exited 1. With --lock pointed at a contract
  that is not a lock (the FeeHook) it stops on the reverted getter and exits
  1. On 19 October, the router's compiled output changed by one byte at a
  time, each run on its own and the file restored after it (same sha256):
    a runtime byte (byte 4,000)          FAIL on "runtime == compiled
                                         runtime", 1 FAILED, exit 1
    a creation byte (byte 4,000)         FAIL on "creation input ==", 1
                                         FAILED, exit 1
    the trailer's solc version byte      FAIL on the runtime line and on
                                         "NO METADATA HASH", 2 FAILED, exit 1

  TO RUN IT AGAIN. In WSL, with the solc forge installed, compiling FROM AN
  EMPTY DIRECTORY over stdin: inside the checkout solc quietly reads any
  source missing from the JSON off disk, so a file Basescan would refuse as
  incomplete still compiled (shown with PoolId.sol taken out of
  PositionLock's JSON: from the checkout it compiled to the same code, from
  an empty directory it failed "Source ... not found"):
    S=~/.local/share/svm/0.8.30/solc-0.8.30; O=/mnt/c/dev/tmp/verify-out
    C="$PWD"; mkdir -p $O
    for n in FeeHook Graduator PositionLock CurbRouter; do
      (cd "$(mktemp -d)" && $S --standard-json < "$C/deploy/verify/$n.standard-json-input.json") > $O/$n.out.json
    done
  then from the checkout in Windows (node 22, which has fetch):
    node deploy/verify/check.js C:/dev/tmp/verify-out
  It ends "check: ok" or names each failure and exits 1. It sends
  eth_blockNumber, eth_getCode, eth_getTransactionByHash and, with --lock,
  eth_call. Nothing else.
