#!/bin/sh
# Build the Rust game to WebAssembly and embed it into a single HTML file.
#
# On your own machine you only need:   rustup target add wasm32-unknown-unknown
# and then:  cargo build --release --target wasm32-unknown-unknown
# (This script also works in environments without that target installed by
#  building std from source with -Zbuild-std; set BUILD_STD=1 for that.)
set -e
cd "$(dirname "$0")"
if [ "$BUILD_STD" = "1" ]; then
  RUSTC_BOOTSTRAP=1 cargo build --release --target wasm32-unknown-unknown -Zbuild-std=std,panic_abort
else
  cargo build --release --target wasm32-unknown-unknown
fi
mkdir -p dist
python3 - <<'PY'
import base64, re
wasm = open("target/wasm32-unknown-unknown/release/rts.wasm", "rb").read()
html = open("web/index.html", encoding="utf-8").read()
# Inline our own scripts (not the three.js one from the CDN).
def inline(m):
    src = m.group(1)
    if "://" in src:
        return m.group(0)
    return "<script>\n" + open("web/" + src, encoding="utf-8").read() + "\n</script>"
html = re.sub(r'<script src="([^"]+)"></script>', inline, html)
html = html.replace("/*WASM_BASE64*/", base64.b64encode(wasm).decode())
# What this build is, for replays and traces: the game's rules (a hash of the
# wasm: the same hash plays a replay out the same), and the commit it was
# built on (the build is committed after it, so this is its parent).
import hashlib, json, subprocess
def git(*a):
    try: return subprocess.run(["git", *a], capture_output=True, text=True, check=True).stdout.strip()
    except Exception: return ""
info = {"sim": hashlib.sha256(wasm).hexdigest()[:12], "base": git("rev-parse", "--short=10", "HEAD")}
html = html.replace("/*BUILD_INFO*/null", json.dumps(info))
# The 3D models from Blender (assets/models.py writes web/models.glb).
import os
if os.path.exists("web/models.glb"):
    html = html.replace("/*MODELS_BASE64*/", base64.b64encode(open("web/models.glb", "rb").read()).decode())
open("dist/vibecraft.html", "w", encoding="utf-8").write(html)
print(f"dist/vibecraft.html  ({len(wasm)//1024} KB wasm, {len(html)//1024} KB page)")
PY
