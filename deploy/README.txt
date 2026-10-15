deploy/ - VALUES THE MAINNET RUN READS FROM A FILE

curb-first-uri.txt
  $CURB's token URI, CURB_FIRST_URI (DEPLOY.txt decision 6), passed as
    CURB_FIRST_URI="$(cat deploy/curb-first-uri.txt)"
  One line, nothing else in the file: $(cat ...) drops only trailing newlines,
  so a note in it would go into the token for good. It is written into the
  token at launch and can never change.

  WHAT IT HOLDS - data:application/json;base64, then the base64 of
    {"name":"Curb","symbol":"CURB","description":"Real pairs. Open launches.",
     "image":"data:image/webp;base64,...","website":"https://curbfun.xyz",
     "twitter":"https://x.com/CurbFun","telegram":"https://t.me/CurbCommunity"}
  in the create form's own key order (web/app.js buildTokenUri), 1,697
  characters of printable ASCII.

  HOW IT WAS MADE, 16 October 2026 - the way the site's create form makes
  one, so the token page decodes it as it decodes any launch's:
    1. web/curb-mark.svg drawn at its own 400x400 into a canvas in Microsoft
       Edge and saved as PNG. The form takes png, jpeg, webp or gif, not svg
       (app.html's #nImageFile accept list), which is what the owner would
       have done by hand.
    2. That PNG given to the create form's own picker on app.html: its
       handler (shrinkToDataUri) crops it to a square, draws it at 128x128
       and keeps the first WebP of quality 0.82, 0.7, 0.55, 0.4 under 24 KiB
       - here 0.82, 1,059 characters ("2 KB stored in the token, 128x128",
       the form's own note). The image is the string the picker's preview
       then showed, byte for byte.
    3. The JSON above, empty fields dropped, base64 of its UTF-8 bytes.
  Made twice, byte-identical both times, and again by make-curb-uri.js
  below. sha256 of the file:
    5b5e4d9c4dc80bfae7d42a4a096835e991775896b53617961a4e8fe01ee18c63
  ADDRESSES.txt records the file and this hash with $CURB's other settings.

  CHECKED on a fork of live Base the same day, in the deploy rehearsal:
  $CURB launched with it inside the run, its tokenURI() was this file byte
  for byte, and the site served against that fork showed it as a visitor
  would - the Launches page's hero and grid card with the image and the
  three links, and /token/<$CURB> with the name, the description, the image
  and Website, X and Telegram, through web/token-meta.js parseMeta.

  THE TELEGRAM LINK IS IN IT FOR GOOD. If https://t.me/CurbCommunity is not
  the project's own group on the day, make the file again without it
  (make-curb-uri.js --no-telegram, below; another link is an edit of its
  WORDS) in a commit of its own before STEP 2, and record the new hash:
  nothing can change it after the broadcast.

make-curb-uri.js
  The three steps above as one command, from a Windows PowerShell in the
  checkout (it drives Edge through web/e2e's Playwright, as STEP 1's browser
  suite does; PREP 2's `cd web\e2e; npm ci` installs it):
    node deploy/make-curb-uri.js --check
  makes the URI again and says "same" or "DIFFERENT" against the committed
  file (shown failing on 16 October for a description one comma apart and
  for an image that did not come through the form's picker). And
    node deploy/make-curb-uri.js --out deploy/curb-first-uri.txt --no-telegram
  writes it without the Telegram link (1,645 characters). The words are
  decision 6's, written in the script once.
