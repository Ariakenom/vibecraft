#!/bin/sh
# Every commit's game, playable: puts commits' dist/vibecraft.html on the
# gh-pages branch, which GitHub Pages serves at
#   https://ariakenom.github.io/vibecraft/            the latest
#   https://ariakenom.github.io/vibecraft/v/<commit>/  any commit (full or short id)
#   https://ariakenom.github.io/vibecraft/versions.html  the list
# Each distinct page is stored once (b/<blob>.html); a commit's address is a
# small page that forwards there. Run by .github/workflows/pages.yml on every
# push to main, or by hand:
#   deploy/pages.sh [commits...]     (default: HEAD)
# Leaves the result committed on the local gh-pages branch; the caller pushes.
set -e
cd "$(git rev-parse --show-toplevel)"
site=$(mktemp -d)
if git rev-parse -q --verify refs/heads/gh-pages >/dev/null || git fetch -q origin gh-pages:gh-pages 2>/dev/null; then
  git worktree add -q "$site" gh-pages
else
  git worktree add -q --detach "$site"
  (cd "$site" && git checkout -q --orphan gh-pages && git rm -rqf . && touch .nojekyll)
fi
[ $# -gt 0 ] || set -- HEAD
mkdir -p "$site/b" "$site/v"
for c in "$@"; do
  c=$(git rev-parse "$c^{commit}")
  blob=$(git rev-parse "$c:dist/vibecraft.html" 2>/dev/null) || { echo "skip $c: no dist/vibecraft.html"; continue; }
  [ -f "$site/b/$blob.html" ] || git cat-file blob "$blob" > "$site/b/$blob.html"
  short=$(git rev-parse --short=7 "$c")
  for d in "$c" "$short"; do
    mkdir -p "$site/v/$d"
    cat > "$site/v/$d/index.html" <<HTML
<!doctype html><meta charset="utf-8"><title>VibeCraft $short</title>
<script>location.replace("../../b/$blob.html" + location.search + location.hash)</script>
<p><a href="../../b/$blob.html">VibeCraft at $short</a></p>
HTML
  done
  line="$(git log -1 --format='%ct%x09%cs%x09%H%x09%s' "$c")"
  touch "$site/versions.tsv"
  grep -q "$c" "$site/versions.tsv" || echo "$line" >> "$site/versions.tsv"
done
# The latest is main's (or the last commit given).
cp "$site/b/$blob.html" "$site/index.html"
# The list, newest first.
{
  echo '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>VibeCraft versions</title>'
  echo '<style>body{font:15px system-ui;margin:2em auto;max-width:50em;padding:0 1em}td{padding:.2em .6em;vertical-align:top}code{font-size:13px}</style>'
  echo '<h1>VibeCraft, every version</h1><p><a href="./">Latest</a></p><table>'
  sort -rn "$site/versions.tsv" | while IFS="$(printf '\t')" read -r _ day sha subject; do
    subject=$(printf '%s' "$subject" | sed 's/&/\&amp;/g; s/</\&lt;/g')
    echo "<tr><td>$day</td><td><a href=\"v/${sha%"${sha#???????}"}/\"><code>${sha%"${sha#???????}"}</code></a></td><td>$subject</td></tr>"
  done
  echo '</table>'
} > "$site/versions.html"
cd "$site"
git add -A
git -c user.name="${GIT_NAME:-VibeCraft pages}" -c user.email="${GIT_EMAIL:-noreply@github.com}" commit -qm "Pages: $(git -C .. rev-parse --short HEAD 2>/dev/null || echo update)" || echo "nothing new"
cd - >/dev/null
git worktree remove --force "$site"
