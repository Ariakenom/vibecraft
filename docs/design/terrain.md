# Terrain: hills, forests and whales

Status: November 2026, built. The rules are kept simple on purpose.

## Hills

- A unit standing on hill ground sees twice as far, and a unit that shoots
  (range over 1.5) reaches twice as far. Buildings, boats and aircraft
  don't count.
- Going uphill (half a tile ahead is higher and on hill ground) a unit
  moves at half speed. Downhill and across are normal.
- From lower ground you can't see onto a hill.
- Sheep graze on hills: the ground round every sheep deposit is raised
  into one (`map::raise_sheep_hills`), on every kind of map.

## Forests

- Trees stand on two tiles in five, a knight's-move lattice whose gaps all
  join up, with one in ten more left out (`map::thin_forests`). Units walk
  in the gaps, so a crowd has to string out to get through. No slowdown
  beyond that.
- Trees block sight: among trees, at either end, sight reaches only
  `FOREST_SIGHT` (3) tiles, the same looking into a forest, out of one and
  within one (`Map::cover`: tree tiles and open tiles with two or more trees
  round them). The first rule hid a forest completely from outside (and
  showed all of it from inside), so its edge stayed unseen right up to it.

## Who the sight rules apply to

`Game::sees` decides, and right next to something (1.5 tiles) you always
see it. It's used for:
- the player's fog of war (what's visible now; exploring the ground still
  goes by plain distance, so deposits on hills and in forests are found);
- units picking targets by themselves, and giving up a fight when the
  target slips out of sight.

Aircraft see and are seen past everything, buildings see past everything
(they're tall) and can't hide. The computer still sees enemy units through
the fog for its plans, as before; its units follow the same sight rules as
everyone's.

## Whalers

- Whale pods lie far out on the open sea (`map::place_whales`): one per
  start on Skirmish maps, more on Frontier, 30 on the World and the Globe.
- A Whaler (Industrial, from the Dock, 2 wood and 1 iron) lying still at a
  pod makes 3 oil and 3 meat, one whaler to a pod, like a fishing boat at
  a shoal. The computer keeps two when there are whales.

## Globe and World starts

Spread out like Frontier: only wood by the town; stone, fields and game
26 to 58 tiles out (horses too); clay, sheep and iron 58 to 80; saltpeter,
iron and clay 80 to 100; coal, oil, bauxite and uranium only 100 tiles or
more from every town.
