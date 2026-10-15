WHERE THESE CAME FROM
=====================

The paired-asset cards, the swap card and "Paired:" on a launch's page look
for assets/<symbol>.svg, lowercased and stripped to letters and digits (app.js
assetLogo). An asset with no file here keeps the coloured tile the card draws
from its own address, so adding an asset never requires adding a picture first.

ROUND BADGES, SINCE 29 SEPTEMBER 2026 (the owner's call, after PONS): each
file is a 64x64 disc in the brand's colour with the brand's square mark centred
on it, so every asset reads at 13, 18 and 28 pixels on the page's near-black.
The files they replaced were wordmarks for four of the equities (NVIDIA,
Google, Microsoft, Meta - 512 pixels wide, cropped to "IV", "OO", "icr" in a
28-pixel circle) and solid black for SpaceX and XRP, invisible on this page.

The badges were BUILT FROM THE MARKS ALREADY HERE, not redrawn: scratchpad
script make_badges.cjs cut the icon part out of each earlier file by element
and centred it on its disc. So each mark keeps the provenance below:

    nvdac.svg   the eye from the NVIDIA wordmark, #76B900 on black
    metac.svg   the infinity mark from the Meta wordmark, its own blues on white
    msftc.svg   the four squares from the Microsoft wordmark, on white
    googlc.svg  Google's four-colour "G", as Google publishes it for sign-in
                buttons, on white
    aaplc.svg   the Apple mark, white on black
    spcxc.svg   the SpaceX mark, white on black
    amznc.svg   the Amazon mark, #FF9900 on #232F3E
    cbxrp.svg   the XRP mark, white on #23292F
    cbzec.svg   the Zcash mark, near-black on Zcash gold #F4B728
    weth.svg    the Ethereum diamond (ours, see below), white facets on #627EEA
    cbbtc.svg   unchanged: gilbarbara/logos (CC0), already a round coin

The earlier files - the upstream marks as fetched - are in git history
(before 29 September 2026). To rebuild a badge from an upstream mark, run the
script against that copy, not against a badge.

THE EQUITY MARKS were Simple Icons (simpleicons.org) and wordmarks fetched on
22 September 2026. Simple Icons releases its files under CC0-1.0. The marks
themselves remain the trademarks of the companies that own them and are used
here only to identify the tokenized equity a launch is priced against - the
same use a broker's ticker list makes of them. They are not ours and they do
not imply any endorsement, association or sponsorship. If one of these
companies asks for its mark to come off, delete the file: the card falls back
to its tile and nothing else changes.

tslac/mstrc/sndkc/coinc are NOT here: those assets are not deployed, because no
pool on Base holds enough of them to price a threshold against. See
AUDIT_2026-09-23.txt.

AND TWO ARE RASTERS, BECAUSE NO ICON SET HAS THEM:

    cbhype.png  <- hyperliquid.xyz/apple-touch-icon.png, 180x180
    cbmega.png  <- megaeth.com/favicon.ico, which is really a 48x48 PNG

NEITHER OF THOSE TWO IS REACHED TODAY. cbHYPE and cbMEGA are not deployed, for
the same reason as the four equities above. web/app.js carries a two-entry
ASSET_FILE map so these two are asked for as .png; everything else is
<symbol>.svg.

THE ETHEREUM DIAMOND IS OURS, constructed from its geometry rather than traced
from a file: six facets, apex at the top, waist at 212.3, lower pyramid from
236.6. On its badge the facets are white at different opacities. Ethereum's
name and logo are not trademarked.

WHEN A FILE CHANGES, bump ASSET_VERSION in web/app.js: the files are cached,
and the version is on every request for one.
