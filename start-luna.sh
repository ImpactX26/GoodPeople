#!/usr/bin/env bash
# Start Luna on this laptop, over HTTPS, reachable from a phone on the same Wi-Fi.
#
#   ./start-luna.sh           website on this laptop, data on Railway (same data on every device)
#   ./start-luna.sh --local   everything on this laptop, data in memory (resets on restart)
#
# The website runs on https://<laptop-wifi-address>:3000 and forwards /luna-api and /ngo-api to the
# API and the food checker, so the phone talks to a single HTTPS address. Ctrl+C stops everything.
#
# Needs: Node 22+. With --local also Python 3.10+ and Gemini keys in .env at the repo root
# (GEMINI_API_KEY, optional GEMINI_API_KEY_2). On Railway the keys are Railway variables.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$PWD"

RAILWAY_API="https://api-production-a32be.up.railway.app"
RAILWAY_FOOD="https://food-agent-production-4c53.up.railway.app"
LOCAL=0
case "${1:-}" in
  --local) LOCAL=1 ;;
  "") ;;
  *) echo "Usage: ./start-luna.sh [--local]"; exit 1 ;;
esac

# ---------- first-run setup ----------
if [ "$LOCAL" = 1 ] && [ ! -x .venv/bin/python ]; then
  echo "Setting up the Python environment (first run only)…"
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi
[ "$LOCAL" = 0 ] || [ -d api/node_modules ] || (echo "Installing API packages…" && cd api && npm install --silent)
[ -d web/node_modules ] || (echo "Installing website packages…" && cd web && npm install --silent)
[ "$LOCAL" = 0 ] || [ -f .env ] || echo "Note: no .env with GEMINI_API_KEY, so the food check grades from time and storage only (photo not judged)."

# ---------- HTTPS certificate for this laptop's Wi-Fi address ----------
IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || true)"
[ -n "$IP" ] || { echo "Couldn't find this laptop's Wi-Fi address. Are you connected to Wi-Fi?"; exit 1; }
HOST="$(scutil --get LocalHostName 2>/dev/null || hostname -s).local"

MKCERT="$(command -v mkcert || ls "$HOME"/Library/Caches/mkcert/mkcert-* 2>/dev/null | head -1 || true)"
if [ -z "$MKCERT" ]; then
  echo "mkcert is needed to make the HTTPS certificate:  brew install mkcert"; exit 1
fi
CERTS="$ROOT/web/certificates"; mkdir -p "$CERTS"
KEY="$CERTS/lan-key.pem"; CRT="$CERTS/lan.pem"; STAMP="$CERTS/lan.hosts"
WANT="localhost 127.0.0.1 ::1 $IP $HOST"
if [ ! -f "$CRT" ] || [ "$(cat "$STAMP" 2>/dev/null)" != "$WANT" ]; then
  echo "Making an HTTPS certificate for: $WANT"
  # shellcheck disable=SC2086
  "$MKCERT" -key-file "$KEY" -cert-file "$CRT" $WANT >/dev/null 2>&1
  echo "$WANT" > "$STAMP"
fi
CAROOT="$("$MKCERT" -CAROOT)"
# The phone downloads this (public) certificate once to trust the laptop. The private key never leaves the laptop.
cp "$CAROOT/rootCA.pem" "$ROOT/web/public/luna-dev-ca.crt"

# ---------- run ----------
# The website calls the API through itself (same HTTPS origin), so nothing on the phone needs plain http.
printf 'NEXT_PUBLIC_API_URL=/luna-api\nNEXT_PUBLIC_NGO_API_URL=/ngo-api\n' > web/.env.development.local

pids=()
cleanup() {
  echo; echo "Stopping Luna…"
  kill "${pids[@]}" 2>/dev/null || true
  rm -f "$ROOT/web/.env.development.local" "$ROOT/web/public/luna-dev-ca.crt"
}
trap cleanup EXIT INT TERM

if [ "$LOCAL" = 1 ]; then
  API_TARGET="http://127.0.0.1:8787"; NGO_TARGET="http://127.0.0.1:8000"
  DATA_NOTE="Data resets when you restart (--local keeps it in memory)."
  DEMO_LINE="  Ready-made donor / NGO / delivery accounts: https://$IP:3000/demo"
  (.venv/bin/python run.py --host 127.0.0.1 --port 8000 2>&1 | sed 's/^/[food-check] /') & pids+=($!)
  (cd api && HOST=127.0.0.1 PORT=8787 SHOW_DEV_OTP=1 ENABLE_TRIP_DEMO=1 FOOD_AGENT_URL=http://127.0.0.1:8000 \
    node --watch --experimental-strip-types src/index.ts 2>&1 | sed 's/^/[api] /') & pids+=($!)
else
  API_TARGET="$RAILWAY_API"; NGO_TARGET="$RAILWAY_FOOD"
  DATA_NOTE="Data lives on Railway: every phone and laptop sees the same listings, and nothing resets."
  DEMO_LINE="  Sign in as a donor, an NGO and a delivery partner with three different numbers."
  curl -fsS -m 10 "$RAILWAY_API/health" >/dev/null 2>&1 || echo "Warning: the Railway API isn't answering yet ($RAILWAY_API)."
fi
(cd web && LUNA_LOCAL_PROXY=1 LUNA_API_TARGET="$API_TARGET" LUNA_NGO_TARGET="$NGO_TARGET" LUNA_DEV_ORIGINS="$IP,$HOST" \
  npx next dev -H 0.0.0.0 -p 3000 --experimental-https --experimental-https-key certificates/lan-key.pem --experimental-https-cert certificates/lan.pem \
  2>&1 | sed 's/^/[web] /') & pids+=($!)

cat <<EOF

  Luna is starting (give it ~15 seconds):

    On this laptop   https://localhost:3000
    On your phone    https://$IP:3000        (same Wi-Fi)

  Sign in with any 10-digit number starting 6–9. The code is 123456.
$DEMO_LINE

  First time on a phone, trust the laptop once (needed for "Use my location"):
    1. Open https://$IP:3000/luna-dev-ca.crt and allow the download
       (if the browser warns first, tap Advanced → Proceed).
    2. iPhone: Settings → Profile Downloaded → Install, then
               Settings → General → About → Certificate Trust Settings → turn on "mkcert".
       Android: Settings → Security → Encryption & credentials → Install a certificate → CA certificate → pick the file.
    3. Reopen https://$IP:3000 — no warning now.

  Backend: $API_TARGET
  $DATA_NOTE
  Ctrl+C stops everything.

EOF
wait
