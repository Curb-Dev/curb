web/vendor/ - THIRD-PARTY CODE THE SITE SERVES, EACH FILE AS ITS PACKAGE SHIPS IT
==============================================================================

Nothing here is loaded until a visitor picks "Phone wallet" in the site bar's
wallet picker (topbar.js, walletconnect.js), and the picker offers it only once
web/config.js names a WalletConnect project id (walletConnectProjectId) - "" as
committed, so as committed none of these files is ever requested.

Every file is the npm release's own, byte for byte: never edited, never
minified again, never bundled. This README is not published (web/.vercelignore,
web/_redirects); LICENSE.md and LICENSE are.

THE HASHES. Each line is a file's sha256 and its path from web/vendor/. The
browser tests check every file here against these lines and fail on any file
missing from them (web/e2e/wallets.spec.js "vendored files"):

  329526bcd71e0e9a794ba51b911228b981a637e3228a96f26d6c3e718bf1d7c3  walletconnect/universal-provider-2.25.0.umd.js
  1cb6f8cfe21f54ab1105105717eaa2ba08343037a2a9c41dfd5ab09e3ce270fc  walletconnect/LICENSE.md
  0ce41cd6f92cc23cf057a1df7e1b3876767d678665dd65af4e1d22b4fad967dc  lean-qr-2.7.4/index.mjs
  dc672b829e054d6c102da8776d327f26f27edc1f88740c1878a7ca5b9f74da73  lean-qr-2.7.4/LICENSE


walletconnect/universal-provider-2.25.0.umd.js
----------------------------------------------
  package     @walletconnect/universal-provider@2.25.0 (published 2026-09-14)
  tarball     https://registry.npmjs.org/@walletconnect/universal-provider/-/universal-provider-2.25.0.tgz
  integrity   sha512-5Qnwrjm2caX0WB1ZyG14oWxBGCz0X4jmRxpMYOtin6NNT82Da7ARMAZQFp1gt1GLGrQIP3FfH4BSDXFQXRfQ3g==
  file        package/dist/index.umd.js (468,304 bytes), kept with its last line, a
              sourceMappingURL comment; the map itself is not shipped
  sha384      XFSULDkJ0sKFAAvDdHzYguloXXQhcfBhJ/CKFLVUJVGE4TLNDlrJyh4C55oGVp3Z
              (base64) - walletconnect.js UMD_SRI, the integrity the browser
              checks as it loads the file
  licence     "SEE LICENSE IN LICENSE.md": the WalletConnect Community License
              Agreement (Reown, Inc., 20 August 2025), shipped beside it as
              walletconnect/LICENSE.md (package/LICENSE.md), with the notice
              "Portions (c) 2025 Reown, Inc. All Rights Reserved" on terms.html.
              Not an open-source licence. Every release since 2.21.9 carries it.
  why this    The latest stable release was 2.26.0, ten days old when this was
  version     vendored (2026-10-18); 2.25.0 is the newest more than two weeks
              old, with the same API. Self-contained: the UMD factory takes only
              `exports` and sets globalThis["@walletconnect/universal-provider"].
              Searched: no eval, no new Function, no WebAssembly, no worker, no
              innerHTML.
  hosts       wss://relay.walletconnect.org        the relay (relayUrl, named in
                                                   walletconnect.js and in the
                                                   policy's connect-src)
              https://verify.walletconnect.org     the Verify frame (frame-src) and
                                                   its /v3 public key (https:)
              https://verify.walletconnect.com     the Verify list (https:)
              https://pulse.walletconnect.org      telemetry - switched off
                                                   (telemetryEnabled: false)
              https://rpc.walletconnect.org        Reown's RPC - unused: every read
                                                   goes to config.js's rpc
              https://echo.walletconnect.com       push - a wallet's, not a site's
              https://oxlib.sh, https://t.me       an error message's link, and
                                                   Telegram mini-app links - neither
                                                   is fetched by this site

lean-qr-2.7.4/index.mjs
-----------------------
  package     lean-qr@2.7.4 (published 2026-09-07)
  tarball     https://registry.npmjs.org/lean-qr/-/lean-qr-2.7.4.tgz
  integrity   sha512-tlMPFfqhAAZN7+j/djRSvl/2+AYT2+7RRuyq8bvcbV8gMiENiscquQ9WTfCSyeEdxsVaEB+tU7e9nFZC63BFnQ==
  file        package/index.mjs (6,900 bytes), an ES module with no imports;
              walletconnect.js imports it to draw the pairing code
  licence     MIT (David Evans), shipped beside it as lean-qr-2.7.4/LICENSE
              (package/LICENSE)
  hosts       none


TO VENDOR A NEW VERSION (or to check these again)
-------------------------------------------------
  1. Take a release at least two weeks old, and read its advisories.
  2. In an empty folder:   npm pack <package>@<version> --ignore-scripts
     and compare the tarball's sha512 (openssl dgst -sha512 -binary <tgz> |
     base64) with `npm view <package>@<version> dist.integrity`.
  3. Extract it (tar -xzf) and copy the file named above, unchanged, under its
     new versioned name; copy the licence beside it. Read the licence again.
  4. sha256sum each file into the list at the top; for the UniversalProvider,
     openssl dgst -sha384 -binary <file> | base64 into walletconnect.js
     UMD_SRI, and the new file name into walletconnect.js UMD.
  5. Search the new file for every host it names - grep -oE 'wss?://[a-z0-9.-]+'
     and grep for createElement("iframe") - and check each against the policy in
     web/_headers and web/vercel.json (connect-src, frame-src): a relay host
     that moved stops WalletConnect, a Verify host that moved slows every request
     by 5 s. The browser tests check the relay and frame hosts too.
  6. Run web/e2e/wallets.spec.js and prod.spec.js, then the manual checks in
     web/REAL_WALLET_TEST.txt ("WalletConnect").
