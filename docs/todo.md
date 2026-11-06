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
  with 3 to 11 soldiers: every camp starts from nothing and grows at an
  ordinary town's pace, so it never gets near its cap. Ideas: camps start
  at their site's era with a garrison, or grow faster the higher their cap.
- **Pointing at the ground tests every triangle of the terrain.** Found in
  the traces (Nov 2026): `screenToGround` and `pickAt` raycast the whole
  terrain mesh (49k triangles on Skirmish, 187k on Frontier small, 346k on
  large): 12 / 15 / 27 ms each in the test browser, and the cursor check
  does it about 11 times a second while units are selected; placing a
  building does it on every mouse move. Walking the ray over the height
  grid instead would cost the same on any map.
- **A ~40 ms frame about once a second on the large map** (~27 ms on the
  small one), often followed by an ~80 ms one. It's in the drawing but not
  in any part the trace times, so likely the browser cleaning up memory or
  work done when a building is placed (flattening the ground recomputes the
  normals of the whole terrain, `flattenUnder` in render3d.js). Firefox's
  clock is coarse (1 ms), so short parts show as 0 there: a Chrome trace
  would also show memory.

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
