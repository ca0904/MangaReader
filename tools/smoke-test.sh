#!/bin/sh
# Starts the server on a throwaway library and checks that it serves the reader,
# a chapter and its pages, and refuses what it must: a chapter outside the
# library and a request not addressed to localhost. Usage: tools/smoke-test.sh
set -e
cd "$(dirname "$0")/.."
port=${PORT:-4199}
lib=$(mktemp -d)
outside=$(mktemp -d)
pid=
# wait reports the server as killed; with set -e that would replace our status
trap 'if [ -n "$pid" ]; then kill "$pid"; wait "$pid" || true; fi 2>/dev/null; rm -rf "$lib" "$outside"' EXIT

# A two-page chapter of 40x60 PNGs, and the same chapter outside the library
mkdir -p "$lib/Series"
python3 - "$lib/Series/001.cbz" "$outside/elsewhere.cbz" <<'PY'
import struct, sys, zipfile, zlib

def png(w, h):
    raw = b"".join(b"\x00" + b"\xff" * (w * 3) for _ in range(h))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")

for path in sys.argv[1:]:
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("01.png", png(40, 60))
        z.writestr("02.png", png(40, 60))
PY

PORT=$port node server.js "$lib" >/dev/null &
pid=$!
tries=0
until curl -s -o /dev/null "http://localhost:$port/"; do
  tries=$((tries + 1))
  [ $tries -gt 50 ] && { echo "the server didn't start"; exit 1; }
  sleep 0.1
done

status=0
url() { python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$1"; }
check() { # expected status, description, curl arguments
  want=$1 what=$2
  shift 2
  got=$(curl -s -o /dev/null -w '%{http_code}' "$@")
  if [ "$got" = "$want" ]; then echo "ok    $what ($got)"; else echo "FAIL  $what: got $got, want $want"; status=1; fi
}

base="http://localhost:$port"
chapter=$(url "$lib/Series/001.cbz")
check 200 "reader page" "$base/"
check 200 "chapter" "$base/api/chapter?path=$chapter"
check 200 "page image" "$base/api/page?path=$chapter&n=1"
check 404 "chapter outside the library" "$base/api/chapter?path=$(url "$outside/elsewhere.cbz")"
check 403 "request not addressed to localhost" -H "Host: evil.com:$port" "http://127.0.0.1:$port/"

pages=$(curl -s "$base/api/chapter?path=$chapter" | python3 -c 'import json, sys; print(len(json.load(sys.stdin)["pages"]))')
if [ "$pages" = 2 ]; then echo "ok    chapter has 2 pages"; else echo "FAIL  chapter has $pages pages, want 2"; status=1; fi

exit $status
