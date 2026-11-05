# Frontier: a game mode of exploring and barbarians

Status: sketch, November 2026. Nothing built yet.

## The idea

A second game mode beside the normal one. The map is far bigger, almost
nothing you need is next to home, and the land is full of barbarians that
get stronger the further in you go. You have to explore, push out and fight
your way to what you need.

It stays a game between players. Alliances aren't part of the rules: players
agree them among themselves.

## Rules

- **Map:** 10× the area of today's maps. Land of about 380×380 for two
  players and about 455×455 for three or four (today 120 and 144), plus the
  open sea round it.
- **Starts** are near the edges. The map centre is the most dangerous part.
- **Resources by distance:**
  - near home only wood (and fish at sea);
  - stone, grain, fruit and clay further out on the same land;
  - the later eras' resources only on other continents, so boats and
    outposts (extra Capitols) become necessary.
- **The start** is as today: a Capitol making 2 wood, 1 stone, 1 grain and
  1 fruit, and 2 workers. That trickle has to carry a town until its first
  stone and food are found; check it doesn't stall.
- **Barbarians** are computer players run by the ordinary AI, with a cap:
  - **Sites** are placed when the map is made. Each site has a level set by
    its distance to the map centre: low near the edges, high in the middle.
  - Around each site the map places what a town of that level needs, so
    barbarians never have to explore or sail.
  - A site's level caps its era and its army size. Within the cap it grows
    like any town.
  - **New camps** appear all game, only at free sites, and only where no
    player can see.
  - It's free for all: barbarians fight players and each other.
  - Barbarians never win. They don't count for victory.
- **Computer players** in seats stay possible, even though they will
  probably stall (they can't sail to other continents). That keeps seats
  open for people who join late.
- **Winning:** as now, the last player with a Capitol.
- **The challenge:** ever stronger barbarians further in, while small camps
  near home raid on several fronts at once.

## What it costs: measurements

`cargo test --release diag_big_map -- --ignored --nocapture` (native, not
wasm; seed 7; every player run by the AI; sizes include the open sea):

| Map            | New game | Tick at 5 / 10 min | Copy the game | Save   |
|----------------|----------|--------------------|---------------|--------|
| 2p 156² (today)| 4 ms     | 0.2 / 0.4 ms       | 0.5 ms        | 0.4 MB |
| 2p 306²        | 17 ms    | 0.6 / 1.3 ms       | 1.2 ms        | 1.3 MB |
| 2p 416² (10×)  | 37 ms    | 1.0 / 0.7 ms       | 3.0 ms        | 2.4 MB |
| 4p 180² (today)| 6 ms     | 0.7 / 1.5 ms       | 0.2 ms        | 0.6 MB |
| 4p 491² (10×)  | 51 ms    | 2.5 / 2.5 ms       | 3.3 ms        | 3.4 MB |

The towns on the big maps had fewer entities (the AI finds less), so ticks
there are mostly the per-tile work. A tick has 50 ms; even at 2–3× slower
wasm that's fine. Copying (multiplayer does it on every correction) is
fine too.

What needs work:
- **Pathfinding gives up after 5000 tiles** (`path.rs`). Today that's plenty;
  across a 10× map, round lakes and coasts, a unit gets only part of the
  way. Needs a higher cap for long trips, or paths in two levels (regions,
  then tiles).
- **Save, replay and spectator snapshot sizes** grow with the map (3.4 MB
  before gzip). The map can be rebuilt from its seed, so saving only what
  changed (craters, explored tiles) would shrink them.
- **Drawing is not measured yet:** 240,000 tiles of terrain, water, fog and
  the minimap. That's the most likely real limit. Measure in a browser
  before building.

## Order of work

1. Measure drawing at 10×; settle the size.
2. The map: size, starts at the edges, resources by distance, barbarian
   sites with what they need, other continents.
3. Barbarians: a player kind with a level cap, spawning at free unseen
   sites.
4. Long paths.
5. The mode on the start screen, and saves/replays that know it.
