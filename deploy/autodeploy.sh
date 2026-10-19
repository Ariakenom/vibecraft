#!/bin/sh
# Deploy the newest commit on GitHub's main branch to this server.
#
# Runs every minute from vibecraft-autodeploy.timer, as root. It only copies
# files; it never runs anything from the repository, so the repository can't
# run code on this server beyond the relay itself (server.js), which runs
# sandboxed as before.
#
# What it updates, each only when changed:
#   dist/vibecraft.html            -> /var/www/vibecraft/index.html
#   server.js                      -> /opt/vibecraft/server.js (relay restarted)
#   deploy/vibecraft-relay.service -> /etc/systemd/system/ (relay restarted)
#   deploy/nginx-vibecraft.conf    -> /etc/nginx/snippets/vibecraft.conf
#                                     (kept only if `nginx -t` passes)
# Then it writes /var/www/vibecraft/version.txt with the deployed commit.
set -eu

REPO=/opt/vibecraft/repo
STATE=/opt/vibecraft/deployed
BACKUP=/opt/vibecraft/backup
WWW=/var/www/vibecraft
BRANCH=main

cd "$REPO"
git fetch -q --depth 1 origin "$BRANCH"
new=$(git rev-parse FETCH_HEAD)
old=$(cat "$STATE" 2>/dev/null || echo none)
[ "$new" = "$old" ] && exit 0

git -c advice.detachedHead=false checkout -q --force FETCH_HEAD
echo "deploying $new (was $old)"
mkdir -p "$BACKUP"

# install SRC DEST: copy atomically, keeping the old file in the backup folder.
# Returns 1 (does nothing) when the file is unchanged.
install_file() {
  if [ -f "$2" ] && cmp -s "$1" "$2"; then return 1; fi
  [ -f "$2" ] && cp "$2" "$BACKUP/$(basename "$2")"
  cp "$1" "$2.new" && chmod 644 "$2.new" && mv "$2.new" "$2"
  echo "  updated $2"
}

# The page. Refuse anything that doesn't look like a complete build.
page=dist/vibecraft.html
size=$(wc -c < "$page")
if [ "$size" -lt 100000 ] || grep -q 'WASM_BASE64' "$page" || ! tail -c 200 "$page" | grep -q '</script>'; then
  echo "  $page looks broken ($size bytes); not deploying this commit" >&2
  exit 1
fi
install_file "$page" "$WWW/index.html" || true

# The relay.
restart_relay=no
if node --check server.js 2>/dev/null; then
  install_file server.js /opt/vibecraft/server.js && restart_relay=yes
else
  echo "  server.js has a syntax error under this server's Node; relay not updated" >&2
fi
if install_file deploy/vibecraft-relay.service /etc/systemd/system/vibecraft-relay.service; then
  systemctl daemon-reload
  restart_relay=yes
fi
[ "$restart_relay" = yes ] && systemctl restart vibecraft-relay && echo "  relay restarted"

# nginx: keep the new config only if nginx accepts it.
conf=/etc/nginx/snippets/vibecraft.conf
if install_file deploy/nginx-vibecraft.conf "$conf"; then
  if nginx -t 2>/dev/null; then
    systemctl reload nginx && echo "  nginx reloaded"
  else
    cp "$BACKUP/vibecraft.conf" "$conf"
    echo "  nginx rejected the new config; kept the old one" >&2
  fi
fi

printf '%s\n%s\n' "$new" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$WWW/version.txt.new"
mv "$WWW/version.txt.new" "$WWW/version.txt"
echo "$new" > "$STATE"
echo "deployed $new"
