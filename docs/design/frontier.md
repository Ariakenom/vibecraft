# Frontier: a game mode of exploring and barbarians

Status: November 2026. Built and tested on branch `frontier`: natively,
in wasm (`node test/wasm.mjs`) and in headless Chromium
(`test/browser/frontier.mjs`). Not yet played by a person, and not timed on
a real GPU (the tests use software WebGL).

## The idea

A second game mode beside Skirmish. The map is far bigger, almost nothing
you need is next to home, and the land is full of barbarians that get
stronger the further in you go. You have to explore, push out and fight
your way to what you need.

It stays a game between players. Alliances aren't part of the rules: players
agree them among themselves.

## Rules, as built

- **Choosing it:** "Mode" on the start screen (Skirmish or Frontier), kept
  in the browser. The host's choice goes to the guests with the start
  (`mode` in the start message, `NET.PROTOCOL` 35).
- **Map** (`src/map_frontier.rs`): 10× a Skirmish map's area, land of
  380×380 for two players and 455×455 for three or four, plus the open sea
  round it. Symmetric like Skirmish, so every start gets the same.
  - A **home continent** per start, in a corner.
  - A **central continent**, and **islands** half way along each edge (and,
    for two players, in the empty corners).
- **Resources by distance:**
  - by the town only wood (and fish at sea);
  - on the home continent, in bands: stone, grain fields and game 26–58
    tiles out (horses too), clay, sheep hills and iron 58–80, saltpeter,
    iron and clay 80–100;
  - coal, saltpeter and iron on the islands; oil, bauxite, uranium and coal
    in the middle. The later eras need boats.
- **The start** is as in Skirmish: a Capitol making 2 wood, 1 stone, 1 grain
  and 1 fruit.
- **Barbarians** (`src/barbarians.rs`) are computer towns run by the
  ordinary AI, in owner slots after the seats (up to 16 at once):
  - **Sites** come with the map, about 26 for two players and 40 for four. A
    site's era goes by its distance to the map centre: Ancient near the
    starts, Atomic in the middle (`site_era`). Round each site the map puts
    a forest, two patches each of stone, fields and game, and the deposits
    of every era up to its own.
  - A camp **never passes its site's era**, keeps at most `6 + 5 × era`
    soldiers, builds and knows the ground only within 36 tiles of its site,
    and raids buildings within 70 tiles that it can walk to.
  - It never builds docks, airfields, silos or a second Capitol, so it never
    sails, flies or launches nukes.
  - **Free for all:** camps fight players and each other.
  - **Camps come and go:** 8 at the start, then one every 90 s on a free
    site that no player has anything within 32 tiles of, all game. A camp
    that loses its Capitol is gone, and its site is free again.
  - Barbarians never win and don't count for victory.
  - They think once a second (towns twice).
- **Computer players** in seats are allowed. They may stall (they don't
  sail to other continents), which leaves seats for people who join late.
  In Frontier they attack only Capitols they can walk to.
- **Winning:** as in Skirmish, the last seat with a Capitol.
- **Paths** may search 30,000 tiles (Skirmish 5,000): random trips over 80
  tiles on a home continent all arrive (84% did at 5,000), the slowest in
  1.3 ms.
- **Saves** carry the sites and camps (save `VERSION` 19). Replays and
  spectators start from a save, so they carry them too.

## How it plays (computer only)

`cargo test --release diag_frontier -- --ignored --nocapture` plays a game
with the computer in every seat and prints the camps minute by minute (seed
7, two players):

- By minute 10 most camps have 60–80 people; Medieval camps reach the
  Medieval era, a central one Gunpowder by minute 20.
- Camps fall in fights and new ones settle; 10–16 are alive at a time.
- The two computer seats reach the Industrial era by minute 30.
- Camps grow slowly: a camp capped at Modern is still Medieval at minute
  30. Whether that's right is for playtesting.

Other tools: `diag_camp` (one camp's buildings, houses and the AI's
reasons: VC_SITE, VC_MINUTES), `diag_frontier_time` (where a tick's time
goes), `prof_frontier` (save a game at a minute, or load one and tick it,
for a profiler), `frontier_picture` (the map as text: VC_SEED, VC_PLAYERS).

## What it costs

Native (wasm is likely 1.5–2× slower), seed 7, two players, computer in
every seat:

| Minute | Tick   |
|--------|--------|
| 5      | 1.5 ms |
| 10     | 2.4 ms |
| 20     | 6.3 ms |
| 25     | 7.6 ms |

A tick has 50 ms. Most of it is the AI (16 camps and 2 towns) and settling
slots and houses (`resolve`). Making these fit took four speed-ups, none of
which change a Skirmish game (`diag_same_game` gives the same checksums
before and after):
- campfires found in one pass, not one per player, when placing a building
  and when recruiting;
- Capitols looked up on the tiles round a footprint instead of among every
  entity;
- claimed fishing spots kept in a table (they were deposits × entities);
- in Frontier only, the AI tries only deposits its workers can reach (a
  computer seat that had seen the far shore spent 57 ms a turn on them).

Saves are 2.4–3.4 MB before gzip.

## In the browser

`test/browser/frontier.mjs` checks the Mode choice and preview, starting a
game, barbarians in black, a save that loads back as the same game, and no
page errors. In wasm (`test/wasm.mjs`, `FRONTIER_MINUTES=25`): two copies
stay identical, a tick costs 1.7 ms at minute 5 and 9.7 ms at minute 25, a
copy 0.65 ms.

The ground texture is one canvas of 32 px per tile, which at 416 tiles was
13,312 px square (about 700 MB), past the 8192 px most GPUs take. Maps over
256 tiles now get fewer px per tile (19 for two players, 16 for four), so
it stays within 8192; Skirmish is unchanged. Building it takes 1.9 s in the
test browser (Skirmish 0.6 s).

## Not done yet

- **Play it.** A person playing a whole game: whether it's fun, how it
  feels to explore, whether camps are too slow or too hard.
- **Frame times on a real GPU.** Software WebGL takes 1.5 s a frame even in
  Skirmish, so the tests can't tell. The page's own work is 4 ms a frame.
- **Multiplayer cost.** A correction re-runs several ticks; at about 10 ms
  a tick in wasm late in a game, that may show online. Measure with the
  trace (F8).
- **Snapshot size.** Spectators and late joiners get a save of 226 KB and
  more through the relay. The map can be rebuilt from its seed; saving only
  what changes would shrink it.
- **Balance.** How fast camps grow, how often they come, how hard they hit,
  and whether the Capitol's trickle carries a town to its first stone.
