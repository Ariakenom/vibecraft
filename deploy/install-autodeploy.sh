#!/bin/sh
# One-time setup on ginnu. From your PC:
#   ssh -t ginnu 'curl -fsSL https://raw.githubusercontent.com/Ariakenom/vibecraft/main/deploy/install-autodeploy.sh | sudo sh'
# Run it again to pick up changes to the autodeploy files themselves.
set -eu
REPO=/opt/vibecraft/repo
command -v git >/dev/null || apt-get install -y git
if [ ! -d "$REPO/.git" ]; then
  git clone -q --depth 1 https://github.com/Ariakenom/vibecraft "$REPO"
else
  git -C "$REPO" fetch -q --depth 1 origin main
  git -C "$REPO" -c advice.detachedHead=false checkout -q --force FETCH_HEAD
fi
install -m 755 "$REPO/deploy/autodeploy.sh" /usr/local/sbin/vibecraft-autodeploy
install -m 644 "$REPO/deploy/vibecraft-autodeploy.service" "$REPO/deploy/vibecraft-autodeploy.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now vibecraft-autodeploy.timer
systemctl start vibecraft-autodeploy.service
journalctl -u vibecraft-autodeploy -n 15 --no-pager
echo "Done. Live version: https://ginnu.freemyip.com/vibecraft/version.txt"
