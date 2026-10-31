#!/bin/sh
# Chrome-ul boților: profil separat (logările tale rămân aici), fereastră vizibilă pe ecranul xrdp,
# portul de debug doar pe 127.0.0.1; containerul emag-boti ajunge la el prin relay.js.
export DISPLAY="${BOT_CHROME_DISPLAY:-:10.0}"
export XAUTHORITY="${XAUTHORITY:-$HOME/.Xauthority}"
exec /usr/bin/google-chrome \
  --user-data-dir="$HOME/.config/emag-bot-chrome" \
  --remote-debugging-port=9223 \
  --no-first-run \
  --no-default-browser-check \
  --restore-last-session \
  --window-size=1400,1000 \
  about:blank
