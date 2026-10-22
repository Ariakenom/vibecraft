# Economy and eras: implementation plan

This turns `docs/design/economy-and-eras.md` into ordered work. Read the
design first, then the README's *Rules that must not break* and *Common
changes*. Each phase ends with something playable and its own tests.

## How to work

- **Branch.** Work on a long-lived branch `economy`, not `main`: pushes to
  `main` go live within a minute. Merge to `main` at the end of Phase 3,
  when the new game plays from start to finish in the Ancient era with the
  AI, and after each later phase.
- **Determinism.** Everything in the design is integer slot counts and
  fixed iteration orders (entity id, distance with id as tie-break). Keep
  it that way: no `HashMap` iteration, no floats in slot math.
- **Saves and network.** Every phase that changes saved state bumps
  `VERSION` in `src/save.rs`. Every phase that changes a command bumps
  `NET.PROTOCOL` in `web/net.js`.
- **Models.** Each new unit or building needs a fallback model in
  `web/render3d.js` (a simple shape is fine) before a Blender model in
  `assets/models.py`. Never block a phase on art.
- **Numbers.** All tuning lives in `src/defs.rs`. Values marked *first
  guess* in the design are starting points.
- **Building in the cloud.** See the project notes: `BUILD_STD=1
  ./build.sh` with the rust library source. Commit `dist/vibecraft.html`
  with source changes.

## Tests to keep green

`cargo test --release`, `node test/wasm.mjs` (two copies stay identical),
and `test/browser/run.sh` before merging to `main`. Each phase adds the
cargo tests listed under it.

---

## Phase 1: Slots replace stockpiles

**Goal:** resources become borrowed slots. Citizens stop gathering but keep
building (they become builders in Phase 2). Ancient content only.

**Status: done** (October 2026, branch `economy`). Where it differs from
the steps below:
- Supply and use are recounted **every tick**, not every second. It's cheap
  (a pass over the entities) and makes slots free the tick after something
  dies with no extra bookkeeping. Phase 2's heavier steps (workers, house
  goods) can still run once a second.
- **Lumber camps are free.** With every wood slot held and lumber camps
  costing wood, a player (or the AI) was stuck for good: nothing makes
  wood, and there's no demolish. A free lumber camp always gets you out.
- **Unsupplied units take damage** (1% of max health a second, newest
  first), done here rather than in Phase 4: it replaces starvation.
- The Capitol makes 4 wood, 2 stone, 4 grain; players start with 3
  citizens (each holds 1 grain), so one more can be trained at once.
- Kinds are numbered units 0–63, buildings 64+. Error codes: `Short(r)` is
  1000 + r, `Locked(k)` 2000 + k, `NoDeposit(d)` 20 + d.
- Deposits: forest, stone, fertile land (fruit bushes), horses and game,
  plus water for fishing huts. The AI skips a project it can't place
  (no spot) and moves on, so it never stalls waiting for it.
- Save `VERSION` 2, `NET.PROTOCOL` 8.

`src/defs.rs`
- Replace `Res` (4 kinds) with a resource enum of about 30 kinds (design,
  *Resources*). For this phase only wood, stone, grain, fish, meat, fruit
  and horses need producers. Give each an index, a name and an era.
- `Stats.cost` becomes a short list of `(Res, u16)` pairs, not `[u32; 4]`.
  A `&'static [(Res, u16)]` works well in the static tables.
- Add `Stats.produces: &'static [(Res, u16)]`,
  `Stats.consumes: &'static [(Res, u16)]` (converters, Phase 4),
  `Stats.workers: u8` (Phase 2) and `Stats.needs_deposit: Option<Deposit>`.
- Remove `Bonuses`, `gather_rate`, `upkeep` and the
  Granary/Sawmill/Mason/Smithy/Market/Temple/Settlement kinds.
- `Kind::is_building` uses a table, not `>= 10`: there will be more than 10
  unit kinds. Renumber freely, since saves bump `VERSION`. Check that
  `Census::have: [u32; 32]` in `ai.rs` grows to fit.

`src/map.rs`
- Deposits: add Ancient deposit kinds (forest, stone, game, fertile land,
  horses; fish uses water edges). Trees can stay as forest tiles that
  nothing removes. Place them with the existing symmetry.
- Drop `Resource.amount`; deposits never run out.

`src/game.rs`
- `Player.stock` becomes `supply: [u16; N]` and `used: [u16; N]`. Add
  `Game::recount_slots()`, called once a second from `every_second`. It runs
  steps 3–4 of the design's *Resolution order*: supply from extractors, use
  from every living building, foundation, unit and queued unit.
- `pay` checks free slots and does nothing else (holding is implied by the
  thing existing). Remove `refund`. `CmdError::Short(Res)` still works.
  Note: paying must also update `used` immediately, not wait for the next
  recount, or two commands in one tick could both pass. Simplest: after
  any successful `pay`, add to `used` straight away; `recount_slots`
  rebuilds from scratch every second anyway.
- `place` requires extractors to be on or next to their deposit
  (`can_place` gets the check).
- Remove gathering: `Order::Gather/Return`, `ResNode`, `do_gather`,
  `do_return`, drop sites, `CARRY_MAX`, income history, farms as walkable
  gather spots, `eat`/starving. Farms become ordinary extractors.
- Keep citizens and `do_build` as they are for now.

`src/lib.rs`, `web/main.js`
- Replace `stock(r)` with `supply(r)` and `used(r)`. The top bar shows
  `free / supply` for the resources the player has, red when over-used.
- Costs in tooltips list slots. "Not enough wood" stays.
- Remove the income panel and gather-rate tooltips.

`src/ai.rs`
- Minimal: build extractors until supply covers the next thing in its plan,
  then build that. Good enough to keep the AI alive until Phase 3.

`src/save.rs`: supply and used aren't saved, since they're recomputed.
Remove the fields that were removed, and bump `VERSION`.

**Tests (cargo):**
- a unit's slots are free again the tick after it dies;
- a destroyed extractor drops supply and leaves use above supply without a
  crash;
- two `Place` commands in one tick can't both spend the same free slot;
- save → load → same checksum after 2,000 ticks with slot changes.

**Done when:** you can build an economy and an army with slots only, and
the AI does too.

---

## Phase 2: People, houses, workers and builders

**Goal:** the population system. Citizens go away.

**Status: done** (October 2026, branch `economy`). Where it differs from
the steps below:
- The whole resolution order runs **every tick**, like Phase 1's slots.
  Saved: house residents and goods, `builders_in`, each player's arrival
  timer; everything else is recounted.
- House goods come **last**: building and training check `supply − used`
  only, and houses share what's left (`Player::spare`). A new building that
  needs grain takes it from the furthest house.
- Start: the Capitol makes 2 grain **and 2 fruit**, so both starting huts
  get 2 goods (8 beds) for the 6 residents and 2 builders.
- Builders needed: 1 for everything except the Wonder (3). The Wonder now
  rises in 240 s once its builders are in. A hut costs 1 wood.
- Cancelling training puts the person in the nearest house with a free
  bed (not necessarily the one they came from).
- **Demolish** (command 9, Del pressed twice, not the Capitol): added
  because a player could get stuck with every bed full, everyone working
  and no free resident to crew the food producer that would add beds.
- The arrival timer ticks every 10 s whether or not a bed is free.
- The AI keeps two residents free (builders and soldiers come from beyond
  them) and only builds a producer it can crew; otherwise it stalled.
- Hotkeys: Q hut, E farm, R lumber camp, T quarry, Y fishing hut, U
  hunting lodge, I orchard, O pasture, F barracks, G range, C stable, V
  tower, B wonder; `.` idle builder.
- Save `VERSION` 3, `NET.PROTOCOL` 9.

`src/defs.rs`
- Kinds: `Hut` (house, tier 0), `Builder` (unit, trained at the Capitol).
  Each building gets `builders_needed: u8` and `workers: u8`.
- House goods table: which resources count as house goods, and their era.
- Arrival interval, beds per good and per-tier caps as constants.

`src/game.rs`
- Entity fields for houses: `tier: u8`, `residents: u8`, and
  `goods: u32` (a bit set of the goods it holds). These are the only new
  saved state.
- `recount_slots` grows into the full *Resolution order* (steps 1–8):
  workers before supply, house goods nearest-first, residents over
  capacity leave furthest-first. Distance to the Capitol is measured in
  whole tiles (squared, integers) so it's exact.
- **Arrivals:** a timer per player; when residents + units < beds, spawn an
  arrival at the Capitol that walks to the nearest house with a free bed
  (pick the house when it spawns, re-pick if it's gone). On arrival:
  `residents += 1` and the arrival entity is removed. Arrivals don't hold a
  bed until they arrive (they're not counted as units).
- **Training** takes one resident from the house nearest the training
  building at queue time; if no resident is home, refuse with a new
  `CmdError::NoPeople`. Cancel puts them back in that house if it has room,
  otherwise the nearest one with room, otherwise they're lost.
- **Builders:** `place` lays a foundation (`built = 0`, slots held) and
  orders the chosen builders to it. A new `Entity.builders_in: u8` counts
  builders who reached it; arriving builders are removed. When
  `builders_in >= builders_needed`, the foundation rises at
  `DT / time` per tick with nobody present. Extra builders go idle beside it.
- Workers: producers without their crew make nothing; show a flag in the
  render buffer so the UI can draw an "idle" icon.
- Remove `Citizen`, `after_build`, the farm-taken logic and
  `select_idle_citizen` (repurpose the hotkey for "idle builder").
- Victory is unchanged: lose the Capitol, lose the game.

`src/lib.rs`, `web/main.js`
- HUD: people (`residents / beds`), units, free workers, arrivals pending.
- House tooltip: tier, residents, goods held, what a next good would add.
- Producer tooltip: workers needed, whether it's running, what it makes.
- New error text for `NoPeople`.

`web/render3d.js`
- Fallback models for Hut and Builder. Houses show fullness (for example
  lit windows or smoke per resident). Arrivals walk from the Capitol.
- An era-appropriate gathering spot at the Capitol (Ancient: a campfire).

**Tests (cargo):**
- beds = 2 × goods; a hut with 3 goods holds 6;
- losing a farm empties the furthest house's grain first;
- training takes a resident and the bed stays held until the unit dies;
- a building needing 3 builders doesn't start with 2 and starts with 3;
- workers are handed out in id order, so the same game gives the same
  idle producers on both copies (`node test/wasm.mjs`).

**Done when:** a player grows from 6 people by building huts and
food producers, and losing soldiers visibly slows the economy.

---

## Phase 3: AI, interface and merge (Ancient complete)

**Goal:** the new Ancient game is complete and replaces the old one on `main`.

**Status: done and merged to `main`** (October 2026). What came out of it:
- **AI fog:** an *explored* bit set per player (`Game::explored`, one bit
  per player per tile, saved), updated with the fog. The AI only builds on
  explored ground and uses deposits it has seen; its first soldier scouts a
  round of the map. It still sees enemy units, as before.
- **Crews: house goods first.** Producers of house goods get their workers
  before the rest. In id order alone, a big build (a Wonder taking food)
  set off a spiral: people left, the newest producers (food built for
  growth) lost their crews, so fewer beds, so more people left, down to
  zero. Now losing people idles lumber camps first.
- **Loads only count.** `Game::recount` works out supply, use, beds and so
  on after a load without settling houses or dealing damage; the next tick
  does that, exactly as in the saved game. (Before, save → load → save
  could change houses' goods.)
- The AI keeps two residents free, trains builders from the last one only
  when a foundation waits with none, alternates growing beds with its build
  plan, releases (demolishes) producers whose output nobody uses when
  everyone is at work, and caps attack waves at what its people can field.
- **Wonder cost:** 8 wood, 10 stone, 2 each of grain, meat, fruit and
  horses. Fish was dropped: not every map has water near a base.
- Tests: `normal_ais_play_a_game_to_the_end` (three seeds, an hour at
  most; they finish in 25–55 minutes), and `watch_the_ai` to watch one.
- Save `VERSION` 4, `NET.PROTOCOL` 10.

`src/ai.rs` (largely a rewrite)
- An economy loop: keep a Builder or two in stock; keep beds ahead of
  people; for the scarcest house good, build its producer; keep workers
  available for new producers.
- An army loop: train units from what is free, keeping a reserve of
  residents as workers (difficulty sets how many).
- Deposits: the AI uses only deposits it has seen (fog per AI player, or
  a simple "explored" bit set per player; decide here, keep it
  deterministic). Scouting: send the first unit around.
- Keep attack waves, defence and the target choice as they are.

Interface
- Tech tree panel (K): eras as columns, house tiers as the header, units
  and buildings below with their slot costs. Built from data exported by
  Rust, not a hand-kept list in `main.js`.
- Era badge in the top bar, driven by Rust (Phase 4 makes it change).
- Remove references to removed kinds from `K`, `NAMES`, `DESC`,
  `BUILD_MENU`, `ERAS`.

Docs: update the README's *The game* and *Common changes* sections.

**Done when:** the browser tests pass, a full game against the Normal AI
plays out, and Patrik has played it. Merge to `main`.

---

## Playtest round (October 22): people are units

**Status: done and merged to `main`.** From Patrik's playtest notes:
- Resource chips show what's **left** (free − held by houses) over supply;
  the people chip shows free / everyone.
- Houses show *Has* and *Wants* in their panel, and a floating icon above
  each house of the cheapest good it is missing.
- **People are units** (`src/people.rs`): `Kind::Worker` replaces Builder
  and Arrival. Residents are gone; newcomers spawn at the campfire, free =
  idle workers in its circle. Workers stand at producers (crew counted
  within 1 tile) and can be killed. Moving them pauses the producer
  (`hiring = false`, command 10 resumes). Training takes a worker who
  walks into the building (`recruits`).
- Growth kept but scaled with beds (`growth_interval`), see the design doc
  for why instant refill would make losses free.
- Tests moved to `src/sim_tests.rs` (24). Save `VERSION` 6, `NET.PROTOCOL` 11.
- Some AI-vs-AI seeds now raid each other for over 100 minutes without an
  end; the end-to-end test uses seeds that finish.

---

## Phase 4: House tiers, eras, chains and the Medieval era

**Goal:** the era engine, proven with one era of content.

**Status: done and merged to `main`** (October 2026). What came out of it:
- **Tiers:** a full hut with 3 goods becomes a cottage when its extra wood
  and stone are free (one house a tick, nearest first); a cottage below 3
  goods falls back, furthest first (`people.rs`, `house_tiers`). Houses can
  reach one tier past the player's era.
- **Eras:** `HOUSES_FOR_ERA` (10) houses past the era's tier raise it, with
  `Ev::EraReached` (fanfare and toast; others are told too). Never lowered.
  `Game::unlocked` checks the era; `Kind::requires` keeps the few real
  dependencies (Weaver needs a Sheep Farm, Siege Workshop a Barracks).
- **Goods are shared out evenly** (level by level, nearest first, keeping
  goods a house already had, newest era's goods first for new ones).
  Nearest-first in full made the closest cottages take a fourth food while
  far huts never reached the three they need to grow. Beds are 2 per good
  either way.
- **Converters** take their inputs while they stand, crewed or not (a
  paused bakery still holds its grain, as Patrik asked for paused
  producers); earlier eras first, then oldest first, so the newest stops
  first in a shortage. Flag 256 marks one short of inputs.
- **Classes** (`Class`): counters go by class, so swordsmen beat knights as
  spearmen beat horsemen. Trebuchets: 3x against buildings, 0.3x otherwise.
- **Medieval content:** Swordsman, Crossbowman, Knight (iron), Trebuchet;
  Cottage, Sheep Farm, Iron Mine, Brickworks, Bakery, Weaver, Brewery,
  Siege Workshop; deposits Iron, Clay, Hills, near every base (plus one
  neutral iron). Clusters turn water under them into land.
- Models for all of them in `assets/models.py` (rebuilt with the `bpy`
  module); trebuchets throw stones.
- **AI:** grows houses toward full goods (builds the producer of the
  scarcest good while houses lack goods, huts first until it has enough
  houses), makes upgrade materials, feeds converters from spare goods,
  trains the best unit its era allows, checks its workers can reach a spot
  (and cancels foundations nobody can reach), releases idle producers when
  fewer than 3 are free, and attacks with what it has when its town is
  full and stuck.
- Tests: tiers up and back, the era at exactly ten, era-locked commands,
  converters (paused, shortage), class counters, and both Normal AIs
  reaching the Medieval era in 45 minutes. Save `VERSION` 7, protocol 12.
- **Not done:** two equal AIs no longer finish each other off within the
  hour (they reach the Medieval era in 20 to 40 minutes, then raid each
  other). See open question 5.

- House upgrades (design, *House tiers and eras*): automatic when full, at
  max goods, with free upgrade materials. Cottage model.
- `Player.era: u8`, raised when 10 houses reach a tier; never lowered.
  `Kind::era()` replaces `Kind::requires()` as the unlock rule (keep
  `requires` for a few real dependencies, like Steel mill needing a Coal
  mine nearby if we want that). Event `EraReached` with fanfare and toast.
- Converters: `consumes` in `recount_slots` step 5, with the shortage rule
  (newest stop first).
- Unsupplied units (design, *Shortages*): done early, in Phase 1, since
  it replaces starvation: newest units over a shortage lose health, with an
  icon. The rate is a constant in `defs.rs` (0 switches it off).
- Damage multipliers by **class** instead of by kind (`damage_mult`).
- Medieval content: wool, iron, brick, bread, clothes, beer and their
  buildings; Swordsman, Crossbowman, Knight, Trebuchet; Siege workshop.
  Deposits for iron, clay and sheep hills.
- Arrivals at the Capitol switch to their Medieval look.
- AI: knows to upgrade houses and to take the era's new goods.

**Tests:** era reached at exactly 10 houses; converter shortage cascade;
unsupplied units are the newest; class counters.

---

## Phase 5: the Gunpowder era

**Status: done and merged to `main`** (October 2026).
- Townhouse (tier 2, 7 goods, 14 people): a full cottage with 5 goods grows
  into one from the Medieval era, if 1 more stone and 2 brick are free.
  Ten townhouses bring the Gunpowder era (`LAST_ERA` 2).
- Nitrate (saltpeter deposits near every base) → Saltpeter Works; Powder
  Mill (nitrate 2 + wood 1 → gunpowder 3); Carpenter (wood → furniture);
  Printer (wood → books); Circus (holds 2 horses, 4 shows, 3 workers).
- Musketeer (Line, shoots: iron + gunpowder), Dragoon (Mounted, shoots:
  horses + gunpowder), Cannon (Siege, range 10: iron 2 + gunpowder).
  Muskets crack and cannon boom (synthesized), with puffs of powder smoke;
  cannon balls fly flat, musket balls aren't drawn.
- Models in Blender; the unused Granary, Smithy, Market and Temple are no
  longer exported. The build menu packs 9 columns once it has more than
  22 buttons; the top bar squeezes when it shows many resources. Medieval
  and later buildings show in the menu (locked) once the next tier's first
  house stands.
- Tests: cottage → townhouse only from the Medieval era; the gunpowder
  chain stops without saltpeter. Save `VERSION` 8, protocol 13.
- Normal AIs don't reach the Gunpowder era in 90 minutes (they plateau at
  70 to 95 people in the Medieval era; see open question 5). Hard AIs end
  games by conquest in under 30 minutes.

## Phases 6–8: one era each

Each phase is content on top of the Phase 4 engine: resources, deposits,
buildings, units, models with fallbacks, sounds, AI plan entries and the
house goods for that tier.

| Phase | Era | New systems beyond content |
|---|---|---|
| 6 | Industrial | Steel, explosives, heating. Field guns borrow horses. Measure pathfinding on a bigger map and decide map size. |
| 7 | Modern | Air units: a flying movement layer that ignores pathing and blocking, and which only some units can hit. Haber–Bosch plant. Oil. |
| 8 | Atomic | Missile silo and the Nuke: a targeted area attack with a long launch visible to everyone, a flash, and a crater that stays on the map. Reactor. |

Balance pass after Phase 6, with timings from real games, aiming at about
15 minutes per era.

## Later

Navy and water maps; visible workers and enlisting; kit upgrades; repair;
markets and trade; deciding the Wonder's fate.

## Open questions to settle while building

1. Unsupplied units: decided, they take damage (Phase 1). Tune the rate
   in playtests.
2. AI fog: real per-AI fog, or an explored bit set? Phase 3.
3. Map size for 90-minute games: Phase 6 measurement.
4. Does a building under construction hold all its slots from the start
   (current plan) or fill them as it rises?
5. AI endgame: since people are units and houses grow tiers, two Normal
   AIs plateau around 60 to 100 people and raid each other without either
   winning. Options: siege in attack waves, a Medieval Wonder, waves sized
   by the enemy's army rather than our people, or cheaper wood.
   Measured with `ai_stats` (12 maps, 45 minutes): 20 of 24 Normal AIs
   reach the Medieval era, about 70 people each, no game over. Tried and
   dropped: lumber camps with 1 worker (bigger towns, but fewer reached
   the Medieval era: 16 of 24). Kept (October 22): every base gets a pond
   and wider fruit and game, so every start has four foods; the AI keeps
   the ground next to deposits for producers, doesn't let far-off
   foundations hold its town up, and takes a free worker for the army
   when it has under half its share.
