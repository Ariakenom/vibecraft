# To do

Ideas and fixes waiting their turn. Newest at the bottom of each list.
When one is done, move it to "Done" with the commit or PR.

Messages to Claude that start with "todo:" come here, to be done later,
not straight away (see `CLAUDE.md`).

## Waiting

- **Barbarian names.** Give each barbarian camp a name, from the same
  scheme as random players' names.
- **"Not enough undefined" when upgrading a hut.** Reported Nov 2026. Not
  reproduced yet: in a 16-minute computer-played game every upgrade message
  came out right (wood, stone, brick, steel, the era and goods messages).
  Needs: the exact text, where it showed (the Upgrade button's tip, a
  message at the top, the house's panel) and which version.
- **Carriers don't attack themselves.** Remove the aircraft carrier's own
  attack: it fights only through its aircraft.
- **Middle barbarians are too weak** (playtest, Nov 2026, large Frontier
  map). In the replay, at minute 20 you were Industrial with 28 soldiers,
  while the central camps (capped Modern and Atomic) were still Medieval
  with 3 to 11 soldiers. Worse, they stay Medieval all game: at minute 65
  you were Atomic (tanks, bombers) and the central camps, capped Atomic and
  Modern, were Medieval with about 110 people each. So it's a stall, not
  just a slow start; worth finding what they lack for the Gunpowder era
  (`diag_camp` in barbarians.rs shows a camp's houses and the AI's reasons).
  Ideas besides fixing the stall: camps start at their site's era with a
  garrison, or grow faster the higher their cap.
- **More garbage to cut**: about 20 MB a second is left, mostly three.js
  setting uniforms and the unit animation (`animateRig`).

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
- **Less garbage**: 65 to 110 MB a second down to about 20. Most of it was
  three.js rebuilding shader settings because one material was drawn on
  both plain and skinned/instanced meshes, or with and without shadows.
  Now each kind has its own material (`entMats` in render3d.js), and
  `test/browser/garbage.mjs` profiles what a frame allocates.
- **Faster ticks in big games** (3-player Frontier playtest, Nov 2026: the
  others left over the lag). At minute 33 a tick took 12.4 ms, now 4.0
  (natively; the same game, checksum for checksum). Passes over every
  entity for each of the dozens of barbarian camps were most of it: each
  player's things are now listed by owner (`Game::own`), the buildings
  apart (`Game::blds`), and the AI counts a town's buildings once per
  question (`Game::tally`). `diag_save_time` times a save's ticks by part.
- **Placing a building no longer reshades the whole map**: only the
  corners round it (130 to 150 ms a time before), and a building seen
  again out of the fog doesn't level its ground again.
