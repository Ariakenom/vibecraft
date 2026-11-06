# To do

Ideas and fixes waiting their turn. Newest at the bottom of each list.
When one is done, move it to "Done" with the commit or PR.

## Waiting

- **Barbarian names.** Give each barbarian camp a name, from the same
  scheme as random players' names.
- **"Not enough undefined" when upgrading a hut.** Reported Nov 2026. Not
  reproduced yet: in a 16-minute computer-played game every upgrade message
  came out right (wood, stone, brick, steel, the era and goods messages).
  Needs: the exact text, where it showed (the Upgrade button's tip, a
  message at the top, the house's panel) and which version.

## Done

- **House goods: the most advanced houses first**, so building more houses
  is never a disadvantage to teching. The era's own tier and better houses
  share first; lower tiers get what's left. (Strictly best-first deadlocked
  the computer: houses already past the era took every good, so the last
  upgrade an era needs could never fill.) Wants a playtest.
- **Attack markers on the minimap**: a red ring where
  a warning came from (attacks, enemy silos, nukes), pulsing for 4 s and
  fading over 15 s.
- **Health bars for damaged units**: units already
  showed one once hurt; damaged finished buildings now do too.
- **GitHub Pages for every commit**: `deploy/pages.sh`
  and `.github/workflows/pages.yml`. After merging, turn Pages on in the
  repo's settings (source: the `gh-pages` branch), then run the Pages
  workflow by hand with "older" set to add past versions.
