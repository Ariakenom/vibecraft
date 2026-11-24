# Terrain: hills, mountains, forests, ice and whales

Status: November 2026, built. The rules are kept simple on purpose.

## Hills

- A unit on a hilltop sees twice as far, and a unit that shoots (range
  over 1.5) reaches twice as far; on the slopes, in between (see
  Mountains). Buildings, boats and aircraft don't count.
- Going uphill (half a tile ahead is higher and on hill ground) a unit
  moves at half speed. Downhill and across are normal.
- From lower ground you can't see onto a hill past its foot.
- Sheep graze on hills: the ground round every sheep deposit is raised
  into one (`map::raise_sheep_hills`), on every kind of map.

## Mountains

- A mountain is two hills high (`map::MOUNTAIN`). Height goes by level:
  0 the lowland, 1 a hilltop, 2 a mountaintop. It grows gradually: from
  a hill's foot it rises to full height `RISE` (3) tiles in, and again from
  a mountain's edge (`Map::rise`, `Map::elevation`, smooth between tiles).
- A unit sees and shoots one more time as far for each level of height:
  twice on a hilltop, three times on a mountaintop, in between on the way
  up and down. From lower ground you can't see onto what is more than half
  a level higher. Climbing is half speed, as on hills.
- A mountain always stands in hills: any mountain tile with lowland round
  it becomes a hill (`map::settle_mountains`, the last change to every
  map's terrain), so the way up is lowland, hill, mountain. No trees grow
  on it.
- Skirmish and Frontier maps: where the hill noise is highest
  (`MOUNTAIN_ABOVE_HILL` over the hill line), away from the towns. The
  World and the Globe: along the real ranges (`map_world::RANGES`, drawn
  by hand: the Himalaya, Andes, Rockies, Alps and so on), broken by passes,
  with hills out to their edges.

## The Globe: a cube's faces

The Globe is a ball cut into the six faces of a cube, each a square grid
of 160 x 160 tiles (`cube.rs`). Until Nov 2026 it was a Mercator map from
pole to pole (640 x 492), where everything shrank toward the poles (to 41%
at 66°) and was squeezed thin past them (to 9% across at 85°).

- The atlas: two strips of three faces that really are side by side on the
  ball, one above the other with a gap of 96 rows between (480 x 416
  tiles). Within a strip the atlas is the ground. Every other edge is a
  **seam**: walk off it and you are on the face beyond, turned a quarter
  turn or more (`cube::resolve`, `map::wrap_pos`, which says how many
  quarter turns a heading picks up). Tiles past a seam are the tiles of the
  face beyond (`Map::idx`); distances go over seams where that's shorter
  (`map::delta`, `map::pdist`, `cube::delta_turn`), so paths, aiming,
  sight, the fog and the unit grid all work across them. Long offsets go
  by `map::travel`.
- Each face is drawn with equal angles per tile: a tile is drawn 0.67 to
  1.15 times its size (its area varies at most 1.4x), so Europe is as big
  as Africa. A straight walk across a seam bends a little on the ball away
  from the seam's middle (up to 30° by a corner), since two faces' grids
  meet at an angle there.
- Only near the cube's 8 corners are tiles skewed (up to 1.7x). The cube
  is turned (`map_world::TURN`) so every corner lies 4.5° or more out at
  sea: the Norwegian Sea, off Brazil, the Arabian Sea, the South Atlantic,
  the North and East Pacific, the Arafura Sea and the Ross Sea.
- The land comes from each tile's direction on the ball (`cube::dir`,
  `map_world::lat_lon`), with noise read in 3D (`map::fbm3`) so coasts
  join across seams. Towns, deposits and mountains keep off the seams;
  deposits round a town are placed over a seam if they fall past one.
- Ice (`map::ICE`): the Arctic from 72° north, sea and land alike, so the
  pole can be walked to from Siberia and Canada; Greenland's inland ice;
  Antarctica and its shelves. People walk on it; boats don't sail it;
  nothing is built, grows or lies on it.
- The page bends each face round the ball as the game does
  (render3d.js `cubeDir`, `globeAt`), and the camera goes over a seam onto
  the face beyond, still looking the same way on the ball (main.js
  `clampCam`), in steps of a few tiles so a long step can't land far past
  a seam. The minimap and the start screen's preview are world maps, north
  up (main.js `WorldMap`, lib.rs `map_preview`).
- Seams don't show: a corner on a seam is drawn by both faces with the
  same height and light (render3d.js `globeSeamTwins`); patterns drawn
  from the flat position (the sea's patches, foam and waves, the sand line,
  cloud shadows, the ground's colours) blend over the last `SEAM_W` tiles
  toward what the face beyond has, half and half at the seam, where both
  sides then agree (`globeSeamAt`, `globeSeamImages`). A unit crossing a
  seam turns with it at once; only the small bend between grids is eased.

## The World's land

The World and the Globe use Natural Earth's 1:50m coastlines and lakes,
rasterised to quarter degrees by `assets/earth.py` (`src/earth.rle`,
`src/lakes.rle`). Seas are the atlas's open water (the Caspian too); its
lakes, and ponds the noise makes, are shallow. Straits narrower than a tile
(Gibraltar, the Bosporus, the Danish straits, Bab-el-Mandeb, Hormuz,
Hudson Strait) are cut open so ships get through.

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
