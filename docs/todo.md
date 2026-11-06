# To do

Ideas and fixes waiting their turn. Newest at the bottom of each list.
When one is done, move it to "Done" with the commit or PR.

Messages to Claude that start with "todo:" come here, to be done later,
not straight away (see `CLAUDE.md`).

## Waiting

- **"Not enough undefined" when upgrading a hut.** Reported Nov 2026. Not
  reproduced yet: in a 16-minute computer-played game every upgrade message
  came out right (wood, stone, brick, steel, the era and goods messages).
  Needs: the exact text, where it showed (the Upgrade button's tip, a
  message at the top, the house's panel) and which version. (Since Nov 6
  an unknown code reads "Can't do that" instead.)
- **More garbage to cut**: about 20 MB a second is left, mostly three.js
  setting uniforms and the unit animation (`animateRig`).
- **Barbarians without the extra yield.** Camps' land yields 40% more per
  era of their site (`CAMP_YIELD_PER_ERA`, PR #41): that's the AI cheating.
  Find other ways for the central camps to reach their eras. What held them
  back was room: a camp builds only round its site, so it ran out of
  places for quarries and brickworks. Ideas: bigger or richer deposits at
  central sites, a wider building range there, an AI that builds more
  compactly or picks better producers (a Kiln as soon as it can), camps
  that start at their site's era. `diag_camp` with `VC_CENTRAL=1` shows a
  central camp's buildings and what the AI is waiting for.

- **A loaded game's checksum can differ from the saved one** (found Nov
  2026; makes `frontier.mjs`'s save check fail now and then). Loading works
  out players' supply again from the buildings as they are, while the
  running game still has the supply from the start of the tick: a camp
  settled or a building finished since then. The next tick works it out
  again, so play is the same, but checksums (multiplayer compares them)
  disagree for a tick. In a 2-player small Frontier game, 4 of 40 save
  points differed. Fix: recount at the end of each tick, or save supply.

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
- **Central barbarians grow up**: they stalled in the Medieval era all game
  (room for only so many quarries round a site, so never the bricks the
  next houses need). Now a camp's land yields 40% more per era of its site
  (`CAMP_YIELD_PER_ERA`), sites from the Medieval era on have two more stone
  patches, and no camp enters an era before `CAMP_ERA_AT` (Medieval at 5
  minutes, Gunpowder 12, Industrial 20, Modern 30, Atomic 45). In a
  computer game the Modern-capped camps reached Gunpowder at 15 minutes,
  Industrial at 25 and Modern at 30. Wants a playtest.
- **Barbarian names**: each camp is named after its site, from the random
  players' names (`campName` in main.js; the same on every computer).
- **Carriers don't attack themselves**: no guns of their own, they fight
  only through their aircraft.
