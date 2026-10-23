# 3D models

`models.py` builds every unit, building and resource model in Blender and
writes `web/models.glb`. `build.sh` embeds that file in the page. If the
file is missing, the game falls back to the simpler models built in code
in `web/render3d.js`.

## Rebuilding

Blender 4.2 or newer:

    blender --background --python assets/models.py

or without the Blender app, with the `bpy` module (Python 3.11):

    python3.11 -m venv .bvenv && .bvenv/bin/pip install bpy==4.2.0
    .bvenv/bin/python assets/models.py

Add `--blend` to also save `assets/models.blend`.

The script bakes ambient occlusion with Cycles (a few seconds on a CPU),
then packs the file: normals and colours are stored as bytes using the
standard `KHR_mesh_quantization` extension, which roughly halves its size.

## Editing a model by hand

Import `web/models.glb` into Blender (File > Import > glTF 2.0). Keep these
conventions, which the game relies on:

- **One object per model**, named as the game expects: `Capitol`,
  `Barracks`, `Range`, `Stable`, `Tower`, `Settlement`, `Farm`,
  `Sawmill`, `Mason`, `Wonder`, `Pine`,
  `Oak`, `Bush`, `Stone`, `Gold`, `Citizen`, `Spearman`, `Archer`,
  `Horseman`; Medieval: `Cottage`, `SheepFarm`, `IronMine`, `Brickworks`,
  `Bakery`, `Weaver`, `Brewery`, `SiegeWorkshop`, `IronOre`, `ClayPit`,
  `Sheep`, `Swordsman`, `Crossbowman`, `Knight`, `Trebuchet`; Gunpowder:
  `Townhouse`, `SaltpeterWorks`, `PowderMill`, `Carpenter`, `Printer`,
  `Circus`, `Saltpeter`, `Musketeer`, `Dragoon`, `Cannon`; Industrial:
  `Tenement`, `CoalMine`, `SteelMill`, `ExplosivesWorks`, `Cannery`,
  `CoalYard`, `Press`, `Factory`, `CoalSeam`, `Rifleman`, `MachineGunner`,
  `FieldGun`; and `Lumbermill` (the Sawmill), `Stoneworks`, `Kiln`,
  `AirDefense`, which draw from their own random seed so adding them
  doesn't change the models made after them. (The Trebuchet, the Cannon and the Field Gun have no
  skeleton: no bone pivots, so the game rolls them whole and moves their
  tool, the arm or the barrel.) The object's own location doesn't matter.
- **Units** face +X with their feet at the ground. The weapon or tool is a
  child object named `<Unit>.tool`, with its origin in the hand that holds
  it (the right hand, or the left for the Archer's bow).
- **Unit skeletons:** every vertex of a unit has a `_BONE` float attribute,
  the index of the bone it follows in this list: hips, body, head, armL,
  armR, legL, legR, legFL, legFR, legBL, legBR, neck, tail. Each bone's
  pivot is an empty child object named `<Unit>.<bone>` (e.g.
  `Spearman.armR` at the shoulder). The game animates the bones itself
  (`animateRig` in `web/render3d.js`); there are no animation clips.
- **Buildings** are centred on their footprint (2, 3 or 4 tiles square,
  see `src/defs.rs`) with the ground at zero.
- **Team colours:** paint parts pure magenta `#ff00ff` (team colour) or
  `#800080` (darker team colour). The game repaints them per player.
- **Vertex colour alpha is ambient occlusion** (1 = fully lit).
- **Flags** wave when their vertices have a `_WAVE` float attribute:
  0 at the pole, 1 at the free end.

Export as glTF Binary with: Include > Data > Attributes on (for `_WAVE` and `_BONE`),
Mesh > Vertex Color "Active", Materials "No export", +Y up. Then rebuild the
page with `build.sh`. Rerunning `models.py` overwrites hand edits.
