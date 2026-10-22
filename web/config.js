// THE DEPLOYMENT THIS SITE READS WHEN A LINK NAMES NONE, AND ITS INCIDENT SWITCHES.
//
// One file, loaded first by every page, so the deployment is written in one
// place: the site bar (topbar.js config()), app.html's settings loader (app.js
// loadCfg) and its list of the contracts this product publishes (app.js
// CANONICAL) all read it. A link's own ?rpc=&lens= and a pair the person set on
// app.html still come first; a link that only restates what is written here is
// left plain, so the site's own links stay plain.
//
// EMPTY STRINGS ARE PLACEHOLDERS, filled on deploy day (DEPLOY.txt STEP 5) from
// ADDRESSES.txt. Empty, the pages fall back to a local node and no lens, which is
// what the browser tests and a local session expect; script/b20/check-publish-set.sh
// --addresses refuses to call a publish set ready while they are empty.
//
//   chainId          the chain the deployment is on (8453, Base)
//   rpc              the site's read endpoint: https, read-only, with any key in it
//                    restricted to this site's domain - it is in every visitor's
//                    browser and in every link a person copies from a page that
//                    carried it
//   logsRpc          where the pages send eth_getLogs while they read through rpc
//                    ("" sends them to rpc too): the free plan behind rpc answers
//                    no more than 10 blocks of logs, and the history, the chart,
//                    the holders and Just bought ask for 250 at the least
//                    (browse.js, token.js, sharing.js logsUrl). Keyless and
//                    public, read-only. A link or saved setting naming another
//                    endpoint sends its logs there as well.
//   logsBlocks       the most blocks logsRpc answers in one eth_getLogs (Tenderly's
//                    public gateway: 1000), so a page's first window is no wider
//                    and is not refused before the first answer (browse.js,
//                    token.js, sharing.js logsCeiling). 0 learns it from the
//                    refusals, as for any other endpoint.
//   lens             the LaunchLens address
//   registry         the LaunchRegistry address, as ADDRESSES.txt lists it
//   factories        every factory the registry admits, as ADDRESSES.txt lists them
//                    (a factory admitted later is added here in the same change)
//   explorer         where an address or a transaction is shown
//   featured         launch token addresses a ?featured= link may put in the
//                    front page's featured card; one naming any other is ignored
//   walletConnectProjectId
//                    the Reown (WalletConnect) project id, 32 hex characters, that
//                    lets a wallet on a phone connect: "Phone wallet" in the site
//                    bar's wallet picker (topbar.js, walletconnect.js). "" keeps
//                    WalletConnect off - not offered, and nothing of it fetched.
//                    Offered only once lens and rpc are set too. The id is public
//                    (it is in every visitor's browser); what holds it to this
//                    site is the domain allowlist on Reown's dashboard, which must
//                    be set before the id goes in (an empty list allows every site).
//                    Read the licence first: web/vendor/walletconnect/LICENSE.md.
//
// ONCE lens IS SET, NOTHING IS SENT ON ANY CHAIN BUT chainId, AND THE WALLET IS
// OFFERED A SWITCH TO chainId ONLY (topbar.js chainRefusal and switchChain,
// app.js chainVerdict); ON chainId NOTHING IS SENT TO A FACTORY OR A REGISTRY
// THESE DO NOT NAME (app.js beginAction). A link's ?rpc= decides what a page
// reads, and an endpoint can answer anything: so a page read through any
// endpoint but rpc sends nothing at all (app.js endpointRefusal, topbar.js
// endpointRefusal), and every page says which endpoint it reads under the site
// bar (topbar.js endpointNotice). rpc must be set for anything to be sent.
//
// THE SWAP ROUTERS A BUY PAID IN ETH MAY GO THROUGH ARE app.js CONSTANTS, NOT
// SETTINGS HERE: CURB_ROUTER and AERODROME.router, each pinned by address AND
// runtime code hash and read again from rpc right before every send to it
// (app.js routerStillThere, aeroStillThere). Nothing is sent to either when the
// code at the address hashes to anything else.
//
// THE HALT (PRE_MAINNET.txt D4): nothing on chain can stop a launch or a factory,
// so the site stops showing it. Each is applied by the site bar's helpers
// (window.CurbBar.incident) and takes effect on the next page load:
//   banner           one plain-text line shown under the site bar on every page
//                    ("" shows nothing)
//   hiddenFactories  factories left out of the create form's asset choices; their
//                    launches are left out of the Launches grid, its hero and the
//                    search, and their token pages say so
//   hiddenLaunches   launch token addresses left out of the same lists, whose own
//                    pages say so
// A token page still opens, and still trades and claims: holders of a hidden
// launch must be able to leave it.
window.CURB_SITE = {
  chainId: 8453,
  rpc: "https://base-mainnet.g.alchemy.com/v2/alch_pHLEFLyKJGS9aGggDpuTQ",
  logsRpc: "https://base.gateway.tenderly.co",
  logsBlocks: 1000,
  lens: "0xE6F85A3e97dD2F1a58acBA7A68a663E1f66C52c8",
  registry: "0x86e9a01F3959A96469051AE1a73D5C09b0BaC110",
  factories: [
    "0xE866bB6C86651cDc16F413f38468aa1aB0DbB479", // WETH
    "0xC27DAcEEdaB2183803Ff52583990C898a3625700", // USDC
    "0xB3D9489bEd1CC90Aa5ae4b95FF14c57B9E1b24E6", // cbBTC
    "0x0181320908D883EDf173c2bE73039864ea26Ac48", // cbXRP
    "0x3c7de020AE176Ea1A1DF600da6d24e7285A2E340", // cbZEC
    "0x92df0356C222b2e1C7969CDf36fFA7c92B944D80", // VIRTUAL
    "0xCc289D77E27302e6939866182eC04A68E0B7084C", // AERO
    "0xB508AE03e35dCF80afFBb3AdE3FA8344B8cC80B7", // GOOGLc
    "0xB0B5855E450da582A48a926aB48d9Cba679BDf63", // NVDAc
    "0xef88F9A5A6d7Cb6A03fdcFe490f55B3761c50Cc5", // SPCXc
    "0xB1D89CF60CeF341EDB072Af10F9564227508A5E9", // AMZNc
    "0xa19DbAF4a7B817d5b2096D92c8b5f15707cc5572", // MSFTc
    "0x4D1AcD603d551d279180AEc03AB936203abB14d3", // AAPLc
    "0xc20102c48Bf7421D7893afFE1005f55d4fAdf334", // METAc
  ],
  explorer: "https://basescan.org",
  featured: [],
  banner: "",
  hiddenFactories: [],
  hiddenLaunches: [],
  // Reown project "Curb", domain allowlist https://curbfun.xyz (22 October 2026).
  walletConnectProjectId: "787903628162d134681e13e3518a017d",
};
