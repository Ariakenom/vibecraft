# Economy and eras: design

Status: agreed direction, October 2026. Numbers marked *first guess* are
starting points for playtesting, not decisions.

The implementation plan is in `docs/plan/economy-and-eras-plan.md`. The
research behind this (Empire Earth, Civilization, Anno 1800, Age of Empires
IV, Stronghold) and the drafts we compared are on the planning page made in
the design conversation; the conclusions are all here.

## Goals

1. **Spears to nukes.** Six eras over a game of about **90 minutes**.
2. **No bonuses.** Nothing changes a hidden number. Every step forward is a
   new unit, building or good you can see on the map. The current `Bonuses`
   (Granary +20% food, Smithy ×1.2 attack, Temple regen, Market gold) go away.
3. **Population limited by variety and amount**, in the spirit of Anno:
   houses grow when you supply more different goods.
4. **Everything is borrowed; only people are spent.** There are no
   stockpiles and no gathering trips. Things you build or train hold
   resource slots while they exist and give them back when destroyed.
   What you really lose in a fight is people, who come back slowly.
5. **A city builder with an army, and exploration.** Production chains and
   branching trees are welcome. The map starts hidden, and finding deposits
   matters.

## Core rules

### Slots

Every resource is a number of **slots**. A player's **supply** of a resource
is what their working producers make; their **use** is what their buildings,
units, houses and converters hold. **Free = supply − use.**

- Placing a building or queueing a unit takes its cost in free slots at once.
  It holds them until it is destroyed or cancelled, then they are free again.
- There is no stockpile to save up. If you lack 2 stone, you need another
  quarry (or to tear something down), not to wait.
- Use can exceed supply when a producer is lost. See *Shortages*.

Example: a lumber camp makes 4 wood. A barracks costs 3 wood. While the
barracks stands, you have 1 wood free. If the barracks burns, 4 are free.

### Producers

- **Extractors** stand on or next to a deposit and make slots: a lumber camp
  next to a forest makes wood, a pasture on a horse deposit makes horses, an
  oil well on oil makes oil. Deposits never run out.
- **Converters** borrow input slots and make output slots: a bakery borrows
  2 grain and makes 4 bread. (From the Medieval era on, every producer makes
  twice what it first did: playtests needed far too many buildings. Ancient
  producers are as they were.) Converters form the production chains. If its
  inputs aren't free, a converter stands idle and makes nothing.
- **Service buildings** make a good from nothing but workers (for example a
  church making *worship*, if we add one). Optional.

Raw goods come straight from a deposit (a fishing hut makes fish). Crafted
goods have chains (wood → furniture; iron + coal → steel).

### People

Since the October 2026 playtest, **everyone is a unit you can see.** A
person is a **Worker** (or a soldier trained from one). Houses only count
beds; nobody sits inside them.

- **Houses** give beds. A house's **capacity** is 2 beds for each different
  house good it receives (see *House goods*). Total beds = the sum over all
  houses. Everyone alive holds a bed: workers + soldiers ≤ beds.
- **The campfire.** Each Capitol has a campfire in front of it with a
  marked circle around it (radius 3) where nothing can be built. Newcomers
  appear there, and workers with nothing to do go back there. **A worker
  standing idle in the circle is free**: the top bar's people chip counts
  them. So the number of free people is something you see, not a figure.
- **Growth.** While there's a free bed, a newcomer appears at the campfire
  every `40 / (4 + beds/4)` seconds: 10 s for a starting town, about 5 s at
  48 beds. It is the only way population grows.
- **Training.** Ordering a soldier sends the nearest free worker into the
  training building; training only runs while a recruit is inside. No free
  worker, no order. Cancelling sends the recruit back out as a worker.
- **Death** frees the bed. Someone new has to arrive to fill it, which is
  the real cost of losses.
- **Too few beds** (a house lost its food): free workers leave first, then
  workers at producers of things other than house goods, then anyone.
  Soldiers never leave.

**Why growth is not instant.** The playtest asked whether visible workers
make the slow growth unnecessary. They don't: a lost worker gives back his
slots and bed, so if beds refilled at once, killing workers would cost
nothing, and raids would be pointless again, which is exactly what the
visible workers are meant to fix. Growth now speeds up with the size of the
town instead, so a big city recovers in a reasonable time while a raid
still hurts.

### Workers

- Each producer needs a number of **workers** (*1–4, first guess*). They
  walk there and stand at the building; a producer makes its output only
  while its full crew is within 1 tile of it. Free workers are sent out by
  themselves: foundations and training first, then producers, house-good
  producers first.
- **Workers can be killed** where they work, so raiding a farm stops it
  until new workers walk over. Defending your workers matters.
- **Pausing.** Ordering a worker away from a producer pauses it: it hires
  nobody and makes nothing, but its inputs (other than workers) stay
  taken. Resume it from its panel (Z) or by right-clicking it with workers.
- This is what makes an army cost the economy: every soldier is a worker
  who isn't working.

### Builders

- A foundation needs a number of workers (1 for most, 3 for big ones,
  *first guess*). Free workers are sent by themselves, or you send them.
  While enough of them stand at it, the building rises over its build
  time. When it's done they **become its crew** (as many as it needs), and
  the rest go back to the campfire. (They used to be used up; changed after
  playtesting.)
- Workers can be killed on the way, so escorting them matters.
- Repair: not in the first version.

### House goods

A house good is something residents want: food, clothes, entertainment and
so on. Each good has an era.

- **Only the number of different goods matters, not which ones.** A house
  of tier *t* uses at most `3 + 2t` different goods, chosen from any goods
  of era ≤ *t* that you have free. More goods exist than a house can use,
  so you can skip the ones you can't get.
- A house holds **1 slot of each good it uses**, whatever its size. So a
  farm making 4 grain feeds 4 houses.
- **Goods are shared out evenly:** every house gets a first good, then a
  second, and so on, nearest the Capitol first. A house keeps goods it
  already had before taking new ones, and takes the newest era's goods
  first (a cottage takes bread before grain, leaving grain to huts). In a
  shortage the furthest houses lose their last good first.
- Capacity = 2 × goods used. A hut with 3 goods holds 6 people.

| Tier | House | Max goods | Max residents | Goods that unlock in this era |
|---|---|---|---|---|
| 0 Ancient | Hut | 3 | 6 | grain, fish, meat, fruit |
| 1 Medieval | Cottage | 5 | 10 | bread, clothes, beer |
| 2 Gunpowder | Townhouse | 7 | 14 | furniture, books, circus shows |
| 3 Industrial | Tenement | 9 | 18 | canned food, heating, newspapers |
| 4 Modern | Apartment | 11 | 22 | electricity, radios |
| 5 Atomic | Tower block | 13 | 26 | cars, TVs |

### House tiers and eras

- A house **upgrades** one tier when it is full, uses its maximum number of
  goods, and you have free slots for the upgrade's materials (a cottage
  holds more wood and stone than a hut). A house is made only of what the era
  before its own has, since that's when it grows: a tenement (which brings
  the Industrial era) takes more brick, not steel. Upgrading is **the
  player's call** (Upgrade, Z, on the selected houses; a green arrow marks
  the ones that are ready), since it holds more materials. The computer
  upgrades its own. (It was automatic until playtests.)
- Houses **never fall back**: a house that loses goods keeps its kind and
  its materials, with fewer beds until the goods return. (They used to drop
  a tier, which made losing a few buildings snowball: a lower house can't
  use the higher goods.)
- When **10 houses** reach a tier, the player enters that era: a badge,
  a fanfare, and that era's buildings and units unlock. The era is kept
  even if houses later drop back.
- There are no landmarks and no research.

### Shortages

When a producer is lost or loses workers, use can exceed supply.

- **Houses lose goods furthest from the Capitol first.** They shrink, and
  residents who no longer fit leave.
- **Converters** that can't get inputs stop, newest first, and their outputs
  vanish, which can cascade down a chain. That's intended: cutting the coal
  supply should be felt.
- **Buildings** keep standing and keep their slots. New things can't be
  built until there's free supply again.
- **Units** over a strategic limit become **unsupplied**, newest first:
  they slowly lose health (*1% of max health a second, first guess*), with
  a warning icon, until supply is back or enough of them have died to fit.
  This keeps strategic resources relevant all game: a tank with no oil is
  living on borrowed time. (Decided October 2026, replacing an earlier
  proposal of half speed and no attacks; still to be tuned in play.)

### Resolution order (every second)

Recomputed from scratch from entity state, so it is deterministic and
needs no save data of its own beyond house residents:

1. Residents at home = all residents (units are already subtracted).
2. Workers: producers in order (extractors first, then converters by era,
   then by entity id) each take their crew if enough residents are left.
3. Supply from crewed extractors.
4. Use by buildings, foundations, units and queued units (always counted).
5. Converters, earlier eras first, then oldest first, take their inputs if
   free (while they stand, crewed or not: a paused converter still holds
   them) and add their outputs if crewed.
6. Units over a strategic limit are marked unsupplied, newest first
   (they lose health until it fits again).
7. Houses, nearest the Capitol first (ties by id), take goods up to their
   tier's maximum, preferring goods they already had, to avoid churn.
   Capacity follows.
8. Residents over capacity leave, furthest houses first.

## Resources

About 30 kinds. Era is when they first matter.

| Resource | Era | From | Used by |
|---|---|---|---|
| wood | Ancient | lumber camp (forest) | buildings, archers, spears, furniture, books |
| stone | Ancient | quarry (stone) | buildings, house upgrades |
| grain | Ancient | farm (any grass) | houses, bread, beer |
| fish | Ancient | fishing hut (coast) | houses, canned food |
| meat | Ancient | hunting lodge (game) | houses, canned food |
| fruit | Ancient | orchard (fertile land) | houses |
| horses | Ancient | pasture (horse deposit) | riders, knights, dragoons, circus, field guns |
| wool | Medieval | sheep farm (hills) | clothes |
| iron | Medieval | iron mine | swords, crossbows, knights, muskets, cannon, steel |
| brick | Medieval | brickworks (clay) | buildings, house upgrades |
| bread, clothes, beer | Medieval | bakery, weaver, brewery | houses |
| nitrate | Gunpowder | saltpeter works (nitrate deposit); Haber–Bosch plant later | gunpowder, explosives |
| gunpowder | Gunpowder | powder mill (nitrate + wood) | muskets, cannon, dragoons, rifles |
| furniture, books | Gunpowder | carpenter, printer (wood) | houses |
| circus shows | Gunpowder | circus (horses, expensive) | houses |
| coal | Industrial | coal mine | steel, heating, power, explosives, Haber–Bosch |
| steel | Industrial | steel mill (iron + coal) | buildings, rifles, guns, tanks, cars |
| explosives | Industrial | explosives works (nitrate + coal) | shells for every modern gun, bombs, the nuke |
| canned food, heating, newspapers | Industrial | cannery, coal yard, press | houses |
| electricity | Modern | power plant (coal); reactor (uranium) | houses, factories, Haber–Bosch |
| oil | Modern | oil well | tanks, aircraft, cars |
| aluminum | Modern | bauxite mine | aircraft, TVs |
| radios | Modern | radio factory (steel + electricity) | houses |
| uranium | Atomic | uranium mine | reactor, the nuke |
| cars, TVs | Atomic | car plant (steel + oil), TV plant (aluminum + electricity) | houses |

Notes:
- **Nitrate runs through every era with guns**: saltpeter for gunpowder, then
  nitrate for explosives and modern shells. The **Haber–Bosch plant**
  (Modern) makes nitrate from coal and electricity, with no deposit. Whoever
  lacks a nitrate deposit has a catch-up route.
- **Horses never become useless**: riders and knights, then dragoons, then
  towing field guns, and the circus, a fairly expensive building that turns
  horses into a house good.
- **Uranium powers the city before it powers the bomb.**
- There is no gold. Markets and trade can come later.

## Units

Separate units, no kits or upgrade lines for now (that may come later).
**Older units never stop being trainable.** They stay useful because they
cost different, often cheaper, resources: spearmen need no gunpowder, horses
need no oil.

Counters work by **class**, so they carry across eras: anti-mounted beats
mounted, ranged beats line infantry, mounted beats ranged, siege beats
buildings. Newer units have better numbers within their class.

| Era | Line / anti-mounted | Ranged | Mounted / armor | Siege / artillery | Air |
|---|---|---|---|---|---|
| Ancient | Spearman (wood) | Archer (wood) | Horseman (horses) | | |
| Medieval | Swordsman (iron) | Crossbowman (wood, iron) | Knight (horses, iron) | Trebuchet (wood ×3) | |
| Gunpowder | Musketeer (iron, gunpowder) | | Dragoon (horses, gunpowder) | Cannon (iron ×2, gunpowder) | |
| Industrial | Rifleman (steel, gunpowder) | Machine gunner (steel, gunpowder ×2) | | Field gun (steel ×2, explosives, horses) | |
| Modern | Infantry (steel, explosives) | | Tank (steel ×2, oil, explosives) | | Fighter (aluminum, oil); Bomber (aluminum ×2, oil, explosives ×2) |
| Atomic | | | | Rocket artillery (steel ×2, oil, explosives ×2) | Jet (aluminum ×2, oil ×2) |

Plus the **Worker** (not trained; newcomers appear at the campfire) and the **Nuke**, launched from a
Missile silo (uranium ×2, explosives ×2), as the Atomic era's big moment.
Every unit also costs one resident. About 21 units in all.

**Navy waits until last**: it needs water maps and naval movement.

## Buildings by era (first draft)

- **Ancient:** Capitol, Hut, Lumber camp, Quarry, Farm, Fishing hut,
  Hunting lodge, Orchard, Pasture, Barracks, Range, Stable, Tower.
- **Medieval:** Sheep farm, Weaver, Bakery, Brewery, Iron mine,
  Brickworks, Siege workshop.
- **Gunpowder:** Saltpeter works, Powder mill, Carpenter, Printer, Circus.
- **Industrial:** Coal mine, Steel mill, Explosives works, Cannery, Coal
  yard, Press, Factory (field guns).
- **Modern:** Oil well, Bauxite mine, Power plant, Haber–Bosch plant, Radio
  factory, Tank works, Airfield.
- **Atomic:** Uranium mine, Reactor, Car plant, TV plant, Missile silo.

Settlement, Granary, Sawmill, Mason, Smithy, Market and Temple go away (drop
sites and bonuses no longer exist). The Wonder was removed (October 2026):
the only way to win is conquest.

**Air** (Modern): aircraft fly straight to where they're sent, over water
and buildings, without bumping into anything, high above the ground. Only
fighters, machine gunners, infantry, towers and the Capitol can hit them.
Fighters are their own class (2x against aircraft, 0.5x on the ground);
bombers are flying siege (3x against buildings) with a range of 1: they
fly over their target and drop their bombs.

## Map

- Deposits for every resource, placed with the map's existing symmetry.
  Ancient ones near each start; later ones further out and fewer, so they
  are fought over (*uranium: one or two in the middle*).
- The map starts hidden; scouting finds deposits.
- A 90-minute game with cities may need bigger maps than 80×80. Measure
  pathfinding cost before deciding.

## Start of a game (first guess)

Capitol (makes 4 wood, 2 stone, 2 grain and 2 fruit by itself, no
workers), 2 huts and 8 workers at the campfire. The two foods give each hut
4 beds: 8 for 8 workers. Enough to place a lumber camp, a
farm and a third hut straight away.

## What it should feel like

- Your city's size is visible: house models change with tier, and empty
  houses look empty.
- Building an army visibly drains the city: idle producers, smaller houses.
- Losing a coal mine is felt within seconds: chains stop, houses at the
  edge shrink, a tank stops.
- Each era arrives with a badge, a fanfare, new arrivals at the Capitol in
  a new way, and new models.

## Later, not now

- Visible workers walking to their jobs; residents walking out to enlist.
- Upgrading a veteran's kit at the armory.
- Navy and water maps.
- Markets and trade between players.
- Repairing buildings.
