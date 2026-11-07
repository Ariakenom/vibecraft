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
  - Two shapes, half the seeds each (`layout_of`):
    - **Continents:** a home continent per start, in a corner; a central
      continent; islands half way along each edge (and, for two players,
      in the empty corners).
    - **Landmass:** one big landmass, a coast round the edge and lakes
      inland. Land all the way from each start to the middle, harder the
      further in (the camps' eras). The deposits go to the same places as
      on the continents.
  - **Shallows** (people wade them, boats sail them): every lake, and on
    the continents fords across the straits from each home continent to
    the middle and to the islands. Every start can walk to the middle's
    camps, the long way round; boats are the quick way.
- **Resources by distance:**
  - by the town only wood (and fish at sea);
  - on the home continent, in bands: stone, grain fields and game 26–58
    tiles out (horses too), clay, sheep hills and iron 58–80, saltpeter,
    iron and clay 80–100;
  - coal, saltpeter and iron on the islands (or, on a landmass, the far
    edges between the starts); oil, bauxite, uranium and coal in the
    middle. On the continents they're across the water: by boat, or the
    long way over the fords.
- **The start** is as in Skirmish: a Capitol making 2 wood, 1 stone, 1 grain
  and 1 fruit.
- **Barbarians** (`src/barbarians.rs`) are computer towns run by the
  ordinary AI, in owner slots after the seats (up to 16 at once):
  - **Sites** come with the map, about 26 for two players and 40 for four. A
    site's era goes by its distance to the map centre: Ancient near the
    starts, Atomic in the middle (`site_era`). Round each site the map puts
    a forest, two patches each of stone, fields and game, and the deposits
    of every era up to its own; from the Medieval era on two more of stone,
    and further in more of what the later chains eat (iron, coal, clay,
    oil, bauxite), so a camp there can reach its era by itself.
  - A camp **never passes its site's era**, nor enters one before
    `CAMP_ERA_AT` (Medieval at 5 minutes, Gunpowder 12, Industrial 20,
    Modern 30, Atomic 45). Out by the starts (Ancient and Medieval sites)
    it keeps at most `6 + 5 × era` soldiers; further in, as many as it
    likes. It builds and knows the ground only within 36 tiles of its site,
    and raids buildings within 70 tiles that it can walk to.
  - It plays by the same rules as a seat (no extra yield). With no docks it
    has no fish, so it may build three more of each other goods producer
    than the plan.
  - Further in it keeps more Capitols (`camp_capitols`: two from a
    Gunpowder site, three from a Modern one), so a camp there falls only
    when all are taken.
  - It never builds docks, airfields or silos, so it never sails, flies or
    launches nukes.
  - **Free for all:** camps fight players and each other.
  - **Camps come and go:** 8 at the start, then one every 90 s on a free
    site that no player has anything within 32 tiles of, all game. A camp
    that loses its last Capitol is gone, and its site is free again.
  - Barbarians never win and don't count for victory.
  - They think once a second (towns twice).
- **Computer players** in seats are allowed. They may stall (they don't
  sail to other continents), which leaves seats for people who join late.
  In Frontier they attack only Capitols they can walk to.
- **Winning:** as in Skirmish, the last seat with a Capitol.
- **Paths** may search 30,000 tiles (Skirmish 5,000): random trips over 80
  tiles on a home continent all arrive (84% did at 5,000), the slowest in
  1.3 ms.
- **Saves** carry the sites and camps (save `VERSION` 19; 20 adds players'
  supply). Replays and
  spectators start from a save, so they carry them too.

## How it plays (computer only)

`cargo test --release diag_frontier -- --ignored --nocapture` plays a game
with the computer in every seat and prints the camps minute by minute (seed
7, two players):

- By minute 10 most camps have 60–80 people; a central one 145.
- Central camps (Nov 2026, after the changes in "Barbarians"): on seed 7
  (continents) the Modern-capped camp is Gunpowder at 15 minutes with 35
  soldiers, Industrial at 25 with 350 people and 57 soldiers, Modern at
  30. On seed 2 (landmass) a Modern-capped camp is Industrial at 25 with
  50 soldiers. Some central camps still stall (fought down, or short of
  room): `diag_camp` with VC_SEED and VC_SITE shows why.
- Camps fall in fights and new ones settle; 10–16 are alive at a time.
- The computer seats grow slower now the camps hit back harder.

Other tools: `diag_camp` (one camp's buildings, houses and the AI's
reasons: VC_SEED, VC_SITE or VC_CENTRAL, VC_MINUTES, VC_LOG_TICKS), `diag_frontier_time` (where a tick's time
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
