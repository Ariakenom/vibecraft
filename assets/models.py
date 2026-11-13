"""
VibeCraft 3D models, built in Blender.

Run with Blender 4.2 or newer (or the `bpy` Python module):

    blender --background --python assets/models.py
    # or:  python assets/models.py   (with `pip install bpy`)

It builds every unit, building and resource model from code, bakes ambient
occlusion into them, and writes web/models.glb. build.sh embeds that file
in the page. To touch a model up by hand, import web/models.glb into
Blender, edit it, and export it again as glTF Binary with "Custom
Properties"/"Attributes" on (see assets/README.md). Rerunning this script
overwrites such hand edits.

CONVENTIONS (the game relies on these)
- Coordinates in this file are the game's: x right, y UP, z toward the
  viewer. One unit is one map tile. P() turns them into Blender's Z-up.
- Buildings sit centred on their footprint with the ground at y = 0. A
  building of size s must fit in an s x s square.
- Units face +x, feet at y = 0. A unit's weapon or tool is a child object
  named "<Unit>.tool" whose origin is the pivot it swings around.
- TEAM ("#ff00ff") and TEAM_DARK ("#800080") are placeholder colours: the
  game paints them in each player's colours.
- Flag cloth gets a "_WAVE" value per vertex (0 at the pole, 1 at the free
  end) and the game's shader makes it wave.
- Vertex colour alpha holds the baked ambient occlusion (1 = fully lit).
"""
import bpy, bmesh, math, random, os, sys, zlib
from mathutils import Vector, Matrix

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "models.glb")
random.seed(7)

# --- Colours ---------------------------------------------------------------------
def lin(c):
    """'#rrggbb' -> linear RGB tuple (glTF vertex colours are linear)."""
    c = c.lstrip("#")
    out = []
    for i in range(3):
        v = int(c[i * 2:i * 2 + 2], 16) / 255
        out.append(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4)
    return tuple(out)

TEAM, TEAM_DARK = "#ff00ff", "#800080"
SKIN, WOOD, DARKWOOD = "#e0b48c", "#7a5532", "#4e3420"
STONE, STONE2, STONE3 = "#b0a793", "#8f8775", "#c4bca9"
IRON, GOLD, CLOTH = "#a2a8b0", "#e8c45a", "#efe6d1"
PLASTER, THATCH, TILE = "#d8c8a4", "#c4a25a", "#9a4a32"

# --- Geometry helpers ------------------------------------------------------------
def P(x, y, z):
    """Game coordinates (y up, z toward viewer) -> Blender (z up)."""
    return Vector((x, -z, y))

def rot(rx=0.0, ry=0.0, rz=0.0):
    """Rotation about the game's x, y, z axes, applied in that order."""
    return Matrix.Rotation(ry, 4, "Z") @ Matrix.Rotation(-rz, 4, "Y") @ Matrix.Rotation(rx, 4, "X")

def scale3(sx, sy, sz):
    return Matrix.Diagonal((sx, sz, sy, 1.0))


class Model:
    """Collects primitives into one mesh with per-face colours."""

    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.col = self.bm.loops.layers.float_color.new("Col")
        self.wave = self.bm.verts.layers.float.new("_WAVE")
        # Units: which bone of the skeleton each vertex follows (see UNIT_BONES), and
        # whether new faces are shaded smooth (round units) or flat (everything else).
        self.bone = self.bm.verts.layers.float.new("_BONE")
        self.cur_bone = 0
        self.smooth = False

    def part(self, bone, smooth=None):
        """Faces added from now on belong to this bone."""
        self.cur_bone = UNIT_BONES.index(bone)
        if smooth is not None:
            self.smooth = smooth
        return self

    # Copy a temporary bmesh into this model, transformed and coloured.
    def _take(self, tmp, color, m, vary=0.0, wave=None, bevel=0.0):
        if bevel > 0:
            bmesh.ops.bevel(tmp, geom=list(tmp.edges), offset=bevel, segments=1, affect="EDGES", profile=0.5, clamp_overlap=True)
        bmesh.ops.transform(tmp, matrix=m, verts=tmp.verts)
        base = lin(color) if isinstance(color, str) else color
        vmap = {}
        for v in tmp.verts:
            nv = self.bm.verts.new(v.co)
            nv[self.bone] = self.cur_bone
            if wave:
                nv[self.wave] = wave(v.co)
            vmap[v] = nv
        for f in tmp.faces:
            try:
                nf = self.bm.faces.new([vmap[v] for v in f.verts])
            except ValueError:
                continue
            nf.smooth = self.smooth
            k = 1.0 + (random.random() * 2 - 1) * vary
            c = (min(1, base[0] * k), min(1, base[1] * k), min(1, base[2] * k), 1.0)
            for l in nf.loops:
                l[self.col] = c
        tmp.free()
        return self

    def box(self, w, h, d, color, x=0, y=0, z=0, rx=0, ry=0, rz=0, bevel=0.0, vary=0.03, taper=None):
        """A box centred at (x, y, z). `taper` shrinks the top face (0..1)."""
        t = bmesh.new()
        bmesh.ops.create_cube(t, size=1.0)
        if taper:
            for v in t.verts:
                if v.co.z > 0:
                    v.co.x *= taper; v.co.y *= taper
        return self._take(t, color, Matrix.Translation(P(x, y, z)) @ rot(rx, ry, rz) @ scale3(w, h, d), vary, bevel=bevel)

    def cyl(self, r1, r2, h, color, x=0, y=0, z=0, seg=8, rx=0, ry=0, rz=0, bevel=0.0, vary=0.03, caps=True):
        """A cylinder (or cone when r2 = 0) along y, centred at (x, y, z). r1 is the bottom."""
        t = bmesh.new()
        bmesh.ops.create_cone(t, cap_ends=caps, cap_tris=False, segments=seg, radius1=r1, radius2=max(r2, 0.0), depth=1.0)
        return self._take(t, color, Matrix.Translation(P(x, y, z)) @ rot(rx, ry, rz) @ scale3(1, h, 1), vary, bevel=bevel)

    def ball(self, r, color, x=0, y=0, z=0, sub=1, sx=1, sy=1, sz=1, jitter=0.0, vary=0.04, ry=0):
        t = bmesh.new()
        bmesh.ops.create_icosphere(t, subdivisions=sub, radius=r)
        if jitter:
            for v in t.verts:
                v.co *= 1.0 + (random.random() * 2 - 1) * jitter
        return self._take(t, color, Matrix.Translation(P(x, y, z)) @ rot(0, ry, 0) @ scale3(sx, sy, sz), vary)

    def rock(self, r, color, x=0, y=0, z=0, flat=0.7, jitter=0.28, vary=0.08):
        t = bmesh.new()
        bmesh.ops.create_icosphere(t, subdivisions=1, radius=r)
        for v in t.verts:
            v.co *= 1.0 + (random.random() * 2 - 1) * jitter
        # merge nearly flat neighbours into bigger facets, like split stone
        bmesh.ops.dissolve_limit(t, angle_limit=0.3, verts=list(t.verts), edges=list(t.edges))
        bmesh.ops.triangulate(t, faces=list(t.faces))
        return self._take(t, color, Matrix.Translation(P(x, y + r * flat * 0.55, z)) @ rot(0, random.random() * 6.28, 0) @ scale3(1, flat, 1), vary)

    def boulder(self, r, color, x=0, y=0, z=0, flat=0.65, sx=1.0, sz=1.0, lumps=4, flecks=None, vary=0.06, facets=0.3):
        """One big rock: a lumpy, faceted boulder rather than a pile of small ones.
        `flecks` = (colour, share) paints that share of its facets another colour
        (rust, ore), so streaks are part of the rock instead of loose pebbles."""
        t = bmesh.new()
        bmesh.ops.create_icosphere(t, subdivisions=2, radius=1.0)
        # A few broad bulges, so it isn't a ball...
        dirs = []
        for _ in range(lumps):
            a, e = random.random() * 6.28, (random.random() - 0.2) * 1.0
            dirs.append((Vector((math.cos(a) * math.cos(e), math.sin(a) * math.cos(e), math.sin(e))), 0.1 + random.random() * 0.15))
        for v in t.verts:
            n = v.co.normalized()
            k = 1.0 + sum(w * max(0.0, n.dot(d)) ** 2 for d, w in dirs) + (random.random() * 2 - 1) * 0.05
            v.co = n * k
        # ...then sliced by a few planes: the broad flat faces of split stone.
        for i in range(5):
            a = random.random() * 6.28 + i * 1.3
            e = 1.2 if i == 0 else (random.random() - 0.1) * 0.9   # one cut across the top
            d = Vector((math.cos(a) * math.cos(e), math.sin(a) * math.cos(e), math.sin(e)))
            o = 0.68 + random.random() * 0.2
            for v in t.verts:
                s = v.co.dot(d)
                if s > o:
                    v.co -= (s - o) * d
        for v in t.verts:  # a flat underside, sitting on the ground
            v.co.z = max(v.co.z, -0.35)
        # Keep the footprint the asked-for size whatever the bulges did: one tile's worth.
        cx = sum(v.co.x for v in t.verts) / len(t.verts); cy = sum(v.co.y for v in t.verts) / len(t.verts)
        reach = max(math.hypot(v.co.x - cx, v.co.y - cy) for v in t.verts)
        for v in t.verts:
            v.co.x = (v.co.x - cx) / reach; v.co.y = (v.co.y - cy) / reach
        # Merge nearly flat neighbours into bigger facets, like split stone.
        bmesh.ops.dissolve_limit(t, angle_limit=facets, verts=list(t.verts), edges=list(t.edges))
        bmesh.ops.triangulate(t, faces=list(t.faces))
        n0 = len(self.bm.faces)
        self._take(t, color, Matrix.Translation(P(x, y + r * flat * 0.3, z)) @ rot(0, random.random() * 6.28, 0) @ scale3(r * sx, r * flat, r * sz), vary)
        if flecks:
            fc, share = flecks
            base = lin(fc)
            self.bm.faces.ensure_lookup_table()
            up = []
            for i in range(n0, len(self.bm.faces)):
                f = self.bm.faces[i]; f.normal_update()
                if f.normal.z > -0.2:
                    up.append(f)
            random.shuffle(up)   # a fixed share of the facets, so no rock comes out all bare
            for f in up[:max(3, round(len(up) * share))]:
                k = 1.0 + (random.random() * 2 - 1) * 0.1
                c = (min(1, base[0] * k), min(1, base[1] * k), min(1, base[2] * k), 1.0)
                for l in f.loops:
                    l[self.col] = c
        return self

    def prism(self, length, width, height, color, x=0, y=0, z=0, ry=0, vary=0.03):
        """A gable roof: triangle cross-section in the yz plane, running along x. y is the eave line."""
        t = bmesh.new()
        hw, hl = width / 2, length / 2
        pts = [(-hw, 0), (hw, 0), (0, height)]
        a = [t.verts.new(P(-hl, py, pz)) for pz, py in pts]
        b = [t.verts.new(P(hl, py, pz)) for pz, py in pts]
        t.faces.new([a[0], a[1], a[2]]); t.faces.new([b[2], b[1], b[0]])
        for i in range(3):
            j = (i + 1) % 3
            t.faces.new([a[i], b[i], b[j], a[j]])
        bmesh.ops.recalc_face_normals(t, faces=list(t.faces))
        return self._take(t, color, Matrix.Translation(P(x, y, z)) @ rot(0, ry, 0), vary)

    def roof(self, length, width, height, color, x=0, y=0, z=0, ry=0, over=0.12, thick=0.06, rows=0, row_col=None):
        """A gable roof made of two sloping slabs with an overhang, plus a ridge beam."""
        hw = width / 2 + over
        ang = math.atan2(height, width / 2)
        slant = math.hypot(hw, height * hw / (width / 2))
        L = length + over * 2
        for s in (-1, 1):
            cz, cy = s * hw / 2, height - (hw / 2) * height / (width / 2)
            m = Matrix.Translation(P(x, y, z)) @ rot(0, ry, 0)
            t = bmesh.new()
            bmesh.ops.create_cube(t, size=1.0)
            self._take(t, color, m @ Matrix.Translation(P(0, cy, cz)) @ rot(s * ang, 0, 0) @ scale3(L, thick, slant), 0.05)
            # Rows of tiles or thatch: thin strips along the slope give the roof texture.
            for k in range(rows):
                f = (k + 0.5) / rows
                rz = s * hw * f
                ry_ = height - hw * f * height / (width / 2)
                t = bmesh.new()
                bmesh.ops.create_cube(t, size=1.0)
                self._take(t, row_col or color, m @ Matrix.Translation(P(0, ry_ + thick * 0.55, rz)) @ rot(s * ang, 0, 0) @ scale3(L * 0.995, thick * 0.6, slant / rows * 0.55), 0.08)
        self.box(L + 0.02, 0.07, 0.07, DARKWOOD, x, y + height + 0.01, z, ry=ry, vary=0)
        return self

    def flag(self, w, h, color, x, y, z, ry=0):
        """Flag cloth hanging from a pole at its left edge (x - w/2)."""
        t = bmesh.new()
        bmesh.ops.create_grid(t, x_segments=4, y_segments=1, size=0.5)  # 1 x 1, in Blender's xy
        bmesh.ops.transform(t, matrix=Matrix.Rotation(math.pi / 2, 4, "X"), verts=t.verts)  # stand it up
        bmesh.ops.solidify(t, geom=list(t.faces), thickness=0.02)
        m = Matrix.Translation(P(x, y, z)) @ rot(0, ry, 0) @ scale3(w, h, 1)
        x0 = P(x, y, z).x - w / 2
        return self._take(t, color, m, 0.0, wave=lambda co: max(0.0, min(1.0, (co.x - x0) / w)))

    def pole_flag(self, x, z, h, w=0.32, fh=0.2, color=TEAM, y0=0.0):
        self.cyl(0.022, 0.018, h, DARKWOOD, x, y0 + h / 2, z, seg=6, vary=0)
        self.ball(0.035, GOLD, x, y0 + h + 0.02, z, sub=0, vary=0)
        return self.flag(w, fh, color, x + w / 2, y0 + h - fh / 2 - 0.03, z)

    def object(self, parent=None, at=None):
        me = bpy.data.meshes.new(self.name)
        bmesh.ops.recalc_face_normals(self.bm, faces=list(self.bm.faces))
        self.bm.to_mesh(me)
        self.bm.free()
        ob = bpy.data.objects.new(self.name, me)
        bpy.context.scene.collection.objects.link(ob)
        if parent:
            ob.parent = parent
        if at is not None:
            ob.location = at
        return ob


# --- Building parts ----------------------------------------------------------------
def foundation(m, s, col=STONE2):
    """A stone plinth reaching into the ground, so slopes don't show under the building."""
    m.box(s * 0.94, 0.5, s * 0.94, "#6f6553", 0, -0.2, 0, vary=0.02)
    m.box(s * 0.9, 0.08, s * 0.9, col, 0, 0.05, 0, bevel=0.02)

def window(m, x, y, z, face="z", w=0.14, h=0.16):
    """A dark window with a wooden frame and sill, set into a wall facing +z (or +x)."""
    if face == "z":
        m.box(w, h, 0.03, "#2a221a", x, y, z, vary=0)
        m.box(w + 0.05, 0.03, 0.05, DARKWOOD, x, y - h / 2 - 0.01, z + 0.01, vary=0)
        m.box(0.025, h, 0.035, DARKWOOD, x, y, z + 0.005, vary=0)
    else:
        m.box(0.03, h, w, "#2a221a", x, y, z, vary=0)
        m.box(0.05, 0.03, w + 0.05, DARKWOOD, x + 0.01, y - h / 2 - 0.01, z, vary=0)

def door(m, x, z, w=0.26, h=0.42, y=0.0, face="z"):
    if face == "z":
        m.box(w, h, 0.03, DARKWOOD, x, y + h / 2, z, vary=0.02)
        m.box(w + 0.08, 0.05, 0.05, WOOD, x, y + h + 0.02, z + 0.01, vary=0)
        for s in (-1, 1):
            m.box(0.04, h, 0.05, WOOD, x + s * (w / 2 + 0.02), y + h / 2, z + 0.01, vary=0)
        m.box(w * 0.9, 0.025, 0.035, "#3a281a", x, y + h * 0.3, z + 0.012, vary=0)
        m.box(w * 0.9, 0.025, 0.035, "#3a281a", x, y + h * 0.7, z + 0.012, vary=0)

def timber_hall(m, w, h, d, wall, roof_col, rows_col=None, rows=4, y0=0.06, windows=2, roof_h=None, gable_front=False):
    """A timber-framed hall: plastered walls, dark posts and beams, a tiled gable roof.
    The roof ridge runs along x, or along z (gable over the door) with gable_front."""
    m.box(w, h, d, wall, 0, y0 + h / 2, 0, vary=0.02)
    for sx in (-1, 1):
        for sz in (-1, 1):
            m.box(0.08, h + 0.02, 0.08, DARKWOOD, sx * (w / 2), y0 + h / 2, sz * (d / 2), vary=0.04)
    # beams round the top and across the middle of the long walls
    for sz in (-1, 1):
        m.box(w + 0.04, 0.06, 0.06, DARKWOOD, 0, y0 + h - 0.03, sz * (d / 2 + 0.005), vary=0.04)
        m.box(w + 0.02, 0.05, 0.05, DARKWOOD, 0, y0 + h * 0.45, sz * (d / 2 + 0.005), vary=0.04)
        n = max(1, int(w / 0.55))
        for i in range(1, n):
            px = -w / 2 + i * w / n
            m.box(0.05, h, 0.05, DARKWOOD, px, y0 + h / 2, sz * (d / 2 + 0.006), vary=0.04)
    for sx in (-1, 1):
        m.box(0.06, 0.06, d + 0.04, DARKWOOD, sx * (w / 2 + 0.005), y0 + h - 0.03, 0, vary=0.04)
    # gable ends under the roof
    rh = roof_h if roof_h is not None else h * 0.75
    if gable_front:
        for sz in (-1, 1):
            m.prism(0.04, w, rh, wall, 0, y0 + h, sz * (d / 2 - 0.02), ry=math.pi / 2)
            m.box(0.05, rh * 0.8, 0.05, DARKWOOD, 0, y0 + h + rh * 0.4, sz * (d / 2 + 0.005), vary=0)
        m.roof(d, w, rh, roof_col, 0, y0 + h, 0, ry=math.pi / 2, rows=rows, row_col=rows_col)
    else:
        for sx in (-1, 1):
            m.prism(0.04, d, rh, wall, sx * (w / 2 - 0.02), y0 + h, 0, ry=0)
        m.roof(w, d, rh, roof_col, 0, y0 + h, 0, rows=rows, row_col=rows_col)
    door(m, 0, d / 2 + 0.015, y=y0)
    if windows:
        for sx in (-1, 1):
            window(m, sx * w * 0.3, y0 + h * 0.62, d / 2 + 0.02)
    return y0 + h + rh

def crate(m, x, z, s=0.18, y=0.0, ry=0.0):
    m.box(s, s, s, "#9a6f42", x, y + s / 2, z, ry=ry, bevel=0.012, vary=0.06)
    m.box(s * 1.02, s * 0.15, s * 1.02, "#6d4b2b", x, y + s * 0.5, z, ry=ry, vary=0)

def barrel(m, x, z, r=0.08, h=0.2, y=0.0):
    m.cyl(r * 0.85, r * 0.85, h, "#8a5f35", x, y + h / 2, z, seg=8, vary=0.04)
    m.cyl(r, r, h * 0.55, "#7d5631", x, y + h / 2, z, seg=8, vary=0.02)
    for yy in (0.18, 0.82):
        m.cyl(r * 0.92, r * 0.92, 0.02, IRON, x, y + h * yy, z, seg=8, vary=0)

def sack(m, x, z, y=0.0, s=1.0):
    m.ball(0.08 * s, "#d9c38f", x, y + 0.06 * s, z, sub=1, sy=0.75, sx=1.1, jitter=0.08)

def hay(m, x, z, s=1.0, y=0.0):
    m.cyl(0.12 * s, 0.12 * s, 0.22 * s, "#d8b860", x, y + 0.12 * s, z, seg=8, rx=math.pi / 2, vary=0.06)

def fence(m, x0, z0, x1, z1, posts, h=0.3, col=WOOD):
    for i in range(posts):
        f = i / max(1, posts - 1)
        m.box(0.05, h, 0.05, col, x0 + (x1 - x0) * f, h / 2, z0 + (z1 - z0) * f, vary=0.08)
    length = math.hypot(x1 - x0, z1 - z0)
    ang = -math.atan2(z1 - z0, x1 - x0)
    for yy in (0.4, 0.8):
        m.box(length, 0.035, 0.03, col, (x0 + x1) / 2, h * yy, (z0 + z1) / 2, ry=ang, vary=0.05)

def merlons(m, w, d, y, col, size=0.13, gap=0.3):
    for sx in (-1, 1):
        n = int(w / gap)
        for i in range(n + 1):
            m.box(size, size, size, col, -w / 2 + i * w / n, y + size / 2, sx * d / 2, vary=0.06)
    for sz in (-1, 1):
        n = int(d / gap)
        for i in range(1, n):
            m.box(size, size, size, col, sz * w / 2, y + size / 2, -d / 2 + i * d / n, vary=0.06)

def stone_bands(m, r, y0, y1, col, seg=10):
    """Rings of slightly proud stones up a round wall."""
    n = int((y1 - y0) / 0.28)
    for i in range(1, n):
        m.cyl(r + 0.015, r + 0.015, 0.05, col, 0, y0 + i * (y1 - y0) / n, 0, seg=seg, vary=0.05)


# --- Buildings -------------------------------------------------------------------------
def capitol():
    """The Capitol is a town square: this is its statue, on the one tile in the
    middle (the 5x5 paving round it is drawn by the game, `campfire` in
    render3d.js). A stepped plinth with team drapes, a bronze robed figure
    holding up a torch (the game puts a flame at (0.3, 2.6, 0)), and team
    flags at the square's corners.

    It leaves the random numbers as the keep it replaced did (1076 draws), so
    every model made after it, the trees and boulders among them, keeps its
    shape."""
    state = random.getstate()
    m = Model("Capitol")
    m.box(1.0, 0.1, 1.0, "#b5ab98", 0, 0.14, 0, bevel=0.01)
    m.box(0.8, 0.12, 0.8, "#a89f8c", 0, 0.25, 0, bevel=0.01)
    m.box(0.56, 0.62, 0.56, "#d8cfbb", 0, 0.62, 0, bevel=0.01, vary=0.02)
    for x, z, r in [(0, 0.285, 0), (0, -0.285, 0), (0.285, 0, math.pi / 2), (-0.285, 0, math.pi / 2)]:
        m.box(0.26, 0.4, 0.02, TEAM, x, 0.68, z, ry=r, vary=0)
        m.box(0.26, 0.03, 0.025, GOLD, x, 0.87, z, ry=r, vary=0)
    m.box(0.7, 0.1, 0.7, "#bfb6a2", 0, 0.98, 0, bevel=0.01)
    BRONZE, BRONZE2 = "#a67c3d", "#b98b45"
    m.cyl(0.28, 0.0, 0.8, BRONZE, 0, 1.43, 0, seg=10, vary=0.02)
    m.cyl(0.17, 0.12, 0.3, BRONZE2, 0, 1.76, 0, seg=8, vary=0.02)
    m.ball(0.12, "#c29650", 0, 2.01, 0, sub=1, vary=0.02)
    m.box(0.07, 0.34, 0.07, BRONZE2, 0.2, 2.0, 0, rz=-0.35, vary=0)
    m.cyl(0.03, 0.03, 0.34, "#6e4a26", 0.3, 2.24, 0, seg=6, vary=0)
    m.cyl(0.04, 0.07, 0.08, "#8a6330", 0.3, 2.42, 0, seg=8, vary=0)
    for x, z in [(2.3, 2.3), (-2.3, 2.3), (2.3, -2.3), (-2.3, -2.3)]:
        m.pole_flag(x, z, 1.3, w=0.4, fh=0.24)
    random.setstate(state)
    for _ in range(1076):
        random.random()
    return m

def barracks():
    m = Model("Barracks")
    foundation(m, 3)
    timber_hall(m, 2.3, 0.85, 1.5, PLASTER, TILE, "#843c28", rows=5)
    # weapon rack with spears and shields
    m.box(0.8, 0.05, 0.05, DARKWOOD, -0.65, 0.5, 1.15, vary=0)
    for sx in (-1, 1):
        m.box(0.05, 0.55, 0.05, DARKWOOD, -0.65 + sx * 0.38, 0.3, 1.15, vary=0)
    for i in range(5):
        m.cyl(0.012, 0.012, 0.8, WOOD, -0.95 + i * 0.15, 0.45, 1.1, seg=4, rx=-0.12, vary=0)
        m.cyl(0.025, 0.0, 0.09, IRON, -0.95 + i * 0.15, 0.88, 1.05, seg=4, vary=0)
    m.cyl(0.11, 0.11, 0.025, TEAM_DARK, 0.5, 0.22, 1.18, seg=10, rx=math.pi / 2 - 0.25, vary=0)
    m.cyl(0.03, 0.03, 0.035, GOLD, 0.5, 0.225, 1.2, seg=6, rx=math.pi / 2 - 0.25, vary=0)
    # training dummy
    m.cyl(0.03, 0.03, 0.6, WOOD, 0.95, 0.3, 1.15, seg=5)
    m.box(0.4, 0.04, 0.04, WOOD, 0.95, 0.48, 1.15)
    m.ball(0.09, "#d8c48c", 0.95, 0.42, 1.15, sub=1, sy=1.4, jitter=0.1)
    m.ball(0.06, "#d8c48c", 0.95, 0.65, 1.15, sub=1)
    # a square stone tower on the corner, with battlements and a long team banner
    m.box(0.78, 1.75, 0.78, STONE, -0.95, 0.93, -0.5, vary=0.04)
    for y in (0.5, 0.95, 1.4):
        m.box(0.8, 0.045, 0.8, STONE2, -0.95, y, -0.5, vary=0.05)
    m.box(0.9, 0.08, 0.9, STONE2, -0.95, 1.82, -0.5, vary=0.04)
    for sx in (-1, 0, 1):
        for sz in (-1, 0, 1):
            if sx or sz:
                m.box(0.17, 0.17, 0.17, STONE, -0.95 + sx * 0.36, 1.94, -0.5 + sz * 0.36, vary=0.06)
    m.box(0.12, 0.2, 0.03, "#2a221a", -0.95, 1.5, -0.1, vary=0)               # arrow slit
    m.box(0.3, 0.75, 0.025, TEAM, -0.95, 1.0, -0.095, vary=0)                # banner down its face
    m.box(0.3, 0.05, 0.03, GOLD, -0.95, 0.62, -0.093, vary=0)
    m.pole_flag(-0.95, -0.5, 0.75, w=0.4, fh=0.26, y0=1.86)
    for x in (-0.45, 0.45):                                                    # team shields by the door
        m.cyl(0.17, 0.17, 0.03, TEAM, x, 0.62, 0.78, seg=12, rx=math.pi / 2, vary=0)
        m.cyl(0.19, 0.19, 0.015, IRON, x, 0.62, 0.77, seg=12, rx=math.pi / 2, vary=0)
        m.ball(0.04, GOLD, x, 0.62, 0.8, sub=1, vary=0)
    m.pole_flag(1.25, 1.05, 1.4)
    return m


def stable():
    m = Model("Stable")
    foundation(m, 3)
    w, h, d = 2.4, 0.75, 1.0
    # back wall and sides; open stalls on the front
    m.box(w, h, 0.1, "#a5875a", 0, 0.06 + h / 2, -d / 2, vary=0.03)
    for sx in (-1, 1):
        m.box(0.1, h, d, "#a5875a", sx * w / 2, 0.06 + h / 2, 0, vary=0.03)
    for i in range(6):
        x = -w / 2 + i * w / 5
        m.box(0.07, h, 0.07, DARKWOOD, x, 0.06 + h / 2, d / 2, vary=0.04)
        if 0 < i < 5:
            m.box(0.04, h * 0.5, d * 0.9, WOOD, x, 0.06 + h * 0.25, 0, vary=0.05)
    m.box(w, 0.06, 0.06, DARKWOOD, 0, 0.06 + h, d / 2, vary=0)
    m.box(w * 0.98, 0.02, d * 0.95, "#c9ab5c", 0, 0.07, 0, vary=0.1)  # straw floor
    m.prism(0.04, d, 0.5, "#a5875a", w / 2 - 0.03, 0.06 + h, 0)
    m.prism(0.04, d, 0.5, "#a5875a", -w / 2 + 0.03, 0.06 + h, 0)
    m.roof(w, d, 0.5, "#b59a52", 0, 0.06 + h, 0, rows=4, row_col="#a88b45")
    fence(m, -1.3, 1.35, 1.3, 1.35, 9)
    fence(m, -1.3, 0.62, -1.3, 1.35, 3)
    fence(m, 1.3, 0.62, 1.3, 1.35, 3)
    m.box(0.5, 0.1, 0.16, WOOD, 0.6, 0.12, 0.95, vary=0.05)  # trough
    m.box(0.44, 0.02, 0.1, "#4a7894", 0.6, 0.17, 0.95, vary=0)
    hay(m, -0.95, 0.9, 1.1)
    # a horse in the yard, as big as the riders' (units are drawn 1.5 times their size)
    n = count(m); horse(m, "#9a5f33", "#5a3a22", "#2a1e14", sock="#e9e2d2", blaze="#e9e2d2"); placed(m, n, -0.1, 1.0, 0.0, 1.35)
    no_bones(m)
    m.pole_flag(1.25, -0.9, 1.4)
    return m

def tower():
    m = Model("Tower")
    m.box(1.7, 0.5, 1.7, "#6f6553", 0, -0.2, 0, vary=0.02)
    m.cyl(0.78, 0.74, 0.2, STONE2, 0, 0.1, 0, seg=12)
    m.cyl(0.66, 0.54, 2.1, STONE, 0, 1.15, 0, seg=12, vary=0.03)
    for i, yy in enumerate((0.5, 1.0, 1.5)):
        r = 0.66 - (yy - 0.1) / 2.1 * 0.12
        m.cyl(r + 0.02, r + 0.02, 0.06, STONE3, 0, yy, 0, seg=12, vary=0.03)
    m.cyl(0.66, 0.66, 0.14, STONE2, 0, 2.25, 0, seg=12)
    for i in range(10):
        a = i / 10 * math.tau
        m.box(0.16, 0.2, 0.14, STONE2, math.cos(a) * 0.6, 2.42, math.sin(a) * 0.6, ry=-a, vary=0.06)
    for sx in (-1, 1):
        m.box(0.035, 0.42, 0.035, DARKWOOD, sx * 0.35, 2.55, 0.35, vary=0)
        m.box(0.035, 0.42, 0.035, DARKWOOD, sx * 0.35, 2.55, -0.35, vary=0)
    m.cyl(0.62, 0.0, 0.62, TEAM, 0, 3.05, 0, seg=10, vary=0.02)
    for yy, ry in ((0.9, 0.0), (1.55, 1.2)):
        a = ry
        r = 0.66 - (yy - 0.1) / 2.1 * 0.12
        m.box(0.07, 0.24, 0.05, "#221b14", math.sin(a) * r, yy, math.cos(a) * r, ry=a, vary=0)
    door(m, 0, 0.66, w=0.24, h=0.4, y=0.2)
    m.pole_flag(0, 0, 0.5, w=0.3, fh=0.18, y0=3.3)
    return m


def farm():
    m = Model("Farm")
    m.box(2.9, 0.08, 2.9, "#6e5232", 0, 0.03, 0, vary=0.02)
    for i in range(7):
        z = -1.2 + i * 0.4
        m.box(2.6, 0.06, 0.2, "#5b4329", 0, 0.08, z, vary=0.04)
        for j in range(12):
            x = -1.15 + j * 0.21 + (random.random() - 0.5) * 0.05
            hh = 0.16 + random.random() * 0.08
            m.cyl(0.05, 0.0, hh, "#c9b14a" if (i + j) % 3 else "#a7b44a", x, 0.11 + hh / 2, z, seg=4, ry=random.random(), vary=0.08)
    for sx in (-1, 1):
        for sz in (-1, 1):
            m.box(0.08, 0.35, 0.08, TEAM, sx * 1.42, 0.17, sz * 1.42, vary=0)
    fence(m, -1.42, 1.42, 1.42, 1.42, 7, h=0.25)
    # scarecrow
    m.cyl(0.02, 0.02, 0.6, WOOD, 0.3, 0.3, 0.2, seg=5, vary=0)
    m.box(0.4, 0.03, 0.03, WOOD, 0.3, 0.48, 0.2, vary=0)
    m.box(0.14, 0.18, 0.08, TEAM_DARK, 0.3, 0.45, 0.2, vary=0)
    m.ball(0.05, "#d8c48c", 0.3, 0.6, 0.2, sub=1)
    m.cyl(0.09, 0.0, 0.07, THATCH, 0.3, 0.66, 0.2, seg=8, vary=0)
    return m

def granary():
    m = Model("Granary")
    foundation(m, 2)
    for x, z, r in [(-0.35, -0.2, 0.42), (0.42, 0.3, 0.34)]:
        m.cyl(r * 1.05, r * 1.05, 0.12, STONE2, x, 0.12, z, seg=12)
        m.cyl(r, r * 0.97, 0.95, "#d4c08f", x, 0.65, z, seg=12, vary=0.03)
        for yy in (0.35, 0.75, 1.05):
            m.cyl(r * 1.04, r * 1.04, 0.05, WOOD, x, yy, z, seg=12, vary=0.03)
        m.cyl(r * 1.25, 0.0, 0.55, THATCH, x, 1.39, z, seg=12, vary=0.06)
        m.cyl(r * 1.27, r * 1.15, 0.06, "#a88845", x, 1.13, z, seg=12, vary=0.05)
        m.box(0.14, 0.2, 0.03, DARKWOOD, x, 0.35, z + r, vary=0)
    # ladder against the big silo
    for sx in (-1, 1):
        m.box(0.025, 1.0, 0.025, WOOD, -0.35 + sx * 0.08, 0.55, 0.27, rx=-0.1, vary=0)
    for i in range(5):
        m.box(0.16, 0.02, 0.02, WOOD, -0.35, 0.2 + i * 0.18, 0.25 - i * 0.018, vary=0)
    for i, (x, z) in enumerate([(0.5, -0.5), (0.65, -0.45), (0.57, -0.62), (0.57, -0.52)]):
        sack(m, x, z, y=0.12 if i == 3 else 0.0)
    m.pole_flag(-0.78, 0.65, 1.0)
    return m



def smithy():
    m = Model("Smithy")
    foundation(m, 2)
    timber_hall(m, 1.05, 0.64, 1.05, "#9c8a72", "#4b4038", "#40362f", rows=4, windows=1, roof_h=0.42, gable_front=True)
    m.box(0.28, 1.15, 0.28, STONE2, 0.38, 0.85, -0.22, vary=0.06)  # chimney: smoke comes out at the top
    m.box(0.32, 0.06, 0.32, STONE, 0.38, 1.44, -0.22, vary=0)
    m.box(0.16, 0.03, 0.16, "#ff7a2a", 0.38, 1.42, -0.22, vary=0)
    # open forge under a lean-to, with the anvil out front
    m.box(0.4, 0.3, 0.3, STONE2, -0.62, 0.21, 0.55)
    m.box(0.3, 0.04, 0.2, "#ff8a3a", -0.62, 0.37, 0.55, vary=0)
    m.box(0.2, 0.12, 0.1, "#2e2e33", -0.15, 0.24, 0.7, vary=0)
    m.box(0.08, 0.12, 0.07, "#2e2e33", -0.15, 0.12, 0.7, vary=0)
    m.box(0.12, 0.04, 0.06, "#2e2e33", -0.03, 0.29, 0.7, vary=0)
    barrel(m, 0.25, 0.68, r=0.09, h=0.18)
    m.box(0.15, 0.015, 0.15, "#4a7894", 0.25, 0.25, 0.68, vary=0)
    m.pole_flag(0.78, 0.65, 1.0)
    return m

def market():
    m = Model("Market")
    m.box(2.85, 0.5, 2.85, "#6f6553", 0, -0.2, 0, vary=0.02)
    m.box(2.8, 0.06, 2.8, "#b8ab8c", 0, 0.03, 0, vary=0.02)
    # paving stones
    for i in range(40):
        x, z = (random.random() - 0.5) * 2.6, (random.random() - 0.5) * 2.6
        m.box(0.18, 0.02, 0.14, STONE3, x, 0.065, z, ry=random.random(), vary=0.08)
    goods = ["#c9473a", "#e6be4b", "#5d8c3a", "#d98a3a", "#8a5ac0"]
    for k, (x, z, ry) in enumerate([(-0.8, -0.55, 0), (0.8, -0.55, 0), (0, 0.75, 0), (-0.95, 0.55, math.pi / 2)]):
        mm = Matrix.Translation(P(x, 0, z)) @ rot(0, ry, 0)
        lx = lambda px, pz: (mm @ P(px, 0, pz))
        def at(px, pz):
            v = lx(px, pz)
            return v.x, -v.y
        cx, cz = at(0, 0)
        m.box(0.8, 0.3, 0.45, WOOD, cx, 0.2, cz, ry=ry, bevel=0.01)
        for px, pz in [(-0.38, -0.2), (0.38, -0.2), (-0.38, 0.2), (0.38, 0.2)]:
            ax, az = at(px, pz)
            m.box(0.045, 0.75, 0.045, DARKWOOD, ax, 0.42, az, vary=0.05)
        # striped awning: alternating team colour and cloth
        for i in range(5):
            ax, az = at(-0.36 + i * 0.18, 0.0)
            m.box(0.18, 0.025, 0.58, TEAM if i % 2 == 0 else CLOTH, ax, 0.83 - 0.0, az, ry=ry, rx=0.0 if ry else 0.16, rz=0.16 if ry else 0.0, vary=0)
        for j in range(3):
            gx, gz = at(-0.25 + j * 0.25, 0.05)
            m.ball(0.07, goods[(k + j) % 5], gx, 0.39, gz, sub=1, sy=0.6, jitter=0.15, vary=0.1)
        crate(m, *at(0.25, 0.4), s=0.15)
    # the well
    m.cyl(0.26, 0.28, 0.28, STONE, 0.2, 0.2, -0.05, seg=10)
    m.cyl(0.2, 0.2, 0.3, "#24343c", 0.2, 0.22, -0.05, seg=10, vary=0)
    for sx in (-1, 1):
        m.box(0.04, 0.45, 0.04, DARKWOOD, 0.2 + sx * 0.22, 0.5, -0.05, vary=0)
    m.prism(0.55, 0.42, 0.18, TILE, 0.2, 0.72, -0.05)
    sack(m, 0.9, 0.3); sack(m, 1.0, 0.4); barrel(m, -0.3, 0.2)
    m.pole_flag(1.25, 1.25, 1.2)
    return m

def temple():
    m = Model("Temple")
    m.box(1.9, 0.5, 1.9, "#6f6553", 0, -0.2, 0, vary=0.02)
    for i, (w, c) in enumerate([(1.9, STONE2), (1.75, STONE), (1.6, STONE3)]):
        m.box(w, 0.1, w, c, 0, 0.05 + i * 0.1, 0, bevel=0.01, vary=0.02)
    MARBLE = "#ece5d4"
    m.box(0.85, 0.75, 0.9, "#ddd3bd", 0, 0.68, 0, vary=0.02)  # the inner room
    m.box(0.3, 0.45, 0.02, DARKWOOD, 0, 0.53, 0.46, vary=0)
    cols = [(-0.66 + i * 0.44, z) for i in range(4) for z in (-0.66, 0.66)] + [(x, z) for x in (-0.66, 0.66) for z in (-0.22, 0.22)]
    for x, z in cols:
        m.box(0.17, 0.05, 0.17, MARBLE, x, 0.33, z, vary=0)
        m.cyl(0.07, 0.06, 0.82, MARBLE, x, 0.76, z, seg=8, vary=0.02)
        m.box(0.17, 0.06, 0.17, MARBLE, x, 1.2, z, vary=0)
    m.box(1.55, 0.1, 1.55, MARBLE, 0, 1.28, 0, vary=0.02)
    m.box(1.58, 0.05, 1.58, TEAM_DARK, 0, 1.35, 0, vary=0)
    m.prism(1.58, 1.58, 0.38, MARBLE, 0, 1.375, 0, ry=math.pi / 2, vary=0.01)
    m.roof(1.55, 1.55, 0.38, TEAM, 0, 1.39, 0, ry=math.pi / 2, over=0.06, thick=0.05, rows=4, row_col=TEAM_DARK)
    m.cyl(0.12, 0.12, 0.03, GOLD, 0, 1.52, 0.8, seg=10, rx=math.pi / 2, vary=0)  # a gold disc in the pediment
    # gold statue on the steps, braziers either side
    m.box(0.2, 0.2, 0.2, STONE3, 0, 0.4, 0.62, vary=0)
    m.ball(0.08, GOLD, 0, 0.58, 0.62, sub=1, sy=1.5, vary=0)
    m.ball(0.05, GOLD, 0, 0.73, 0.62, sub=1, vary=0)
    for sx in (-1, 1):
        m.cyl(0.03, 0.03, 0.35, IRON, sx * 0.45, 0.47, 0.88, seg=5, vary=0)
        m.cyl(0.04, 0.08, 0.06, IRON, sx * 0.45, 0.67, 0.88, seg=6, vary=0)
        m.cyl(0.05, 0.0, 0.08, "#ff9a3a", sx * 0.45, 0.73, 0.88, seg=5, vary=0)
    return m

def wonder():
    m = Model("Wonder")
    m.box(3.85, 0.5, 3.85, "#6f6553", 0, -0.2, 0, vary=0.02)
    steps = [3.7, 3.05, 2.4, 1.75, 1.1]
    for i, w in enumerate(steps):
        c = "#d6c9ad" if i % 2 else "#c8bba0"
        m.box(w, 0.52, w, c, 0, 0.26 + i * 0.52, 0, bevel=0.02, vary=0.015)
        m.box(w + 0.03, 0.05, w + 0.03, "#b8aa8c", 0, 0.5 + i * 0.52, 0, vary=0.01)
        if i < 4:
            for sx in (-1, 1):
                for sz in (-1, 1):
                    m.box(0.14, 0.16, 0.14, GOLD, sx * (w / 2 - 0.12), 0.6 + i * 0.52, sz * (w / 2 - 0.12), vary=0)
    # stairway up the front
    # one flight per step, each sticking out in front of its step's face
    for i, w in enumerate(steps):
        for k in range(4):
            y = i * 0.52 + k * 0.13 + 0.065
            m.box(0.5, 0.13, 0.12, "#bdb093", 0, y, w / 2 + 0.36 - k * 0.09, vary=0.03)
        for sx in (-1, 1):
            m.box(0.07, 0.6, 0.42, "#b0a385", sx * 0.285, i * 0.52 + 0.26, w / 2 + 0.2, vary=0.02)
    # the golden shrine on top
    top = 0.52 * 5
    m.box(0.8, 0.5, 0.8, GOLD, 0, top + 0.25, 0, bevel=0.02, vary=0.02)
    m.box(0.25, 0.32, 0.02, "#6a4a1a", 0, top + 0.18, 0.41, vary=0)
    for sx in (-1, 1):
        for sz in (-1, 1):
            m.cyl(0.05, 0.05, 0.5, "#f2d877", sx * 0.36, top + 0.25, sz * 0.36, seg=6, vary=0)
    m.cyl(0.52, 0.0, 0.55, "#f2d877", 0, top + 0.78, 0, seg=4, ry=math.pi / 4, vary=0.02)
    m.ball(0.07, "#fff2b0", 0, top + 1.1, 0, sub=1, vary=0)
    # obelisks with team banners at the corners
    for sx in (-1, 1):
        for sz in (-1, 1):
            x, z = sx * 1.68, sz * 1.68
            m.pole_flag(x, z, 1.4, w=0.4, fh=0.26)
    return m

# --- Resources ------------------------------------------------------------------------------
def pine():
    m = Model("Pine")
    m.cyl(0.08, 0.05, 0.6, DARKWOOD, 0, 0.3, 0, seg=6)
    tiers = [(0.5, 0.62, 0.42, "#24502e"), (0.4, 0.55, 0.78, "#2b5c36"), (0.3, 0.5, 1.1, "#336a3d"), (0.19, 0.42, 1.38, "#3f7a45")]
    for r, h, y, c in tiers:
        t = bmesh.new()
        bmesh.ops.create_cone(t, cap_ends=True, cap_tris=False, segments=8, radius1=r, radius2=0.0, depth=h)
        # a ragged, drooping lower edge
        for v in t.verts:
            if v.co.z < 0:
                v.co.z -= random.random() * 0.06
                k = 1 + (random.random() - 0.5) * 0.25
                v.co.x *= k; v.co.y *= k
        m._take(t, c, Matrix.Translation(P(0, y, 0)) @ rot(0, random.random() * 6.28, 0), 0.07)
    return m

def oak():
    m = Model("Oak")
    m.cyl(0.11, 0.07, 0.65, "#5a3c22", 0, 0.32, 0, seg=7)
    m.cyl(0.05, 0.03, 0.35, "#5a3c22", 0.12, 0.66, 0.02, seg=5, rz=-0.7)
    m.cyl(0.05, 0.03, 0.32, "#5a3c22", -0.1, 0.64, -0.05, seg=5, rz=0.7, rx=0.3)
    for i, (x, y, z, r, c) in enumerate([(0, 0.92, 0, 0.42, "#2c5426"), (0.22, 1.02, 0.08, 0.3, "#386628"), (-0.2, 1.0, -0.1, 0.3, "#3a6a2c"),
                                         (0.05, 1.22, -0.05, 0.28, "#4a7c34"), (-0.05, 0.86, 0.22, 0.26, "#335f2a")]):
        m.ball(r, c, x, y, z, sub=1, sy=0.85, jitter=0.12, vary=0.08)
    return m

def bush():
    m = Model("Bush")
    for x, z, r, c in [(0, 0, 0.27, "#3e6a2f"), (0.17, 0.1, 0.2, "#46783a"), (-0.14, 0.12, 0.18, "#3a6430")]:
        m.ball(r, c, x, r * 0.75, z, sub=1, sy=0.8, jitter=0.12, vary=0.08)
    for i in range(11):
        a = i * 2.4
        rr = 0.2 + (i % 3) * 0.03
        m.ball(0.035, "#c9353f", math.cos(a) * rr, 0.12 + (i % 4) * 0.07, math.sin(a) * rr, sub=0, vary=0.1)
    return m

def stone():
    """One big grey boulder. The game's shader paints a stony surface on the facets."""
    m = Model("Stone")
    m.boulder(0.46, "#99928a", 0, 0, 0, flat=0.7, sx=1.05, sz=0.95)
    return m

def gold():
    """The same boulder; the game's shader runs gold veins through it."""
    m = Model("Gold")
    m.boulder(0.45, "#948c80", 0, 0, 0, flat=0.68, flecks=("#d9b24a", 0.05))
    return m

# --- Units -----------------------------------------------------------------------------------
# Units are round and chunky, inspired by Totally Accurate Battle Simulator:
# an egg of a body, a big round head with dot eyes, sausage arms, stubby legs.
# Each part follows one bone of a small skeleton that the game animates
# (waddling, swinging, flinching, flopping over). UNIT_BONES is the bone
# order the game expects; each unit says where its bones' pivots are.
UNIT_BONES = ["hips", "body", "head", "armL", "armR", "legL", "legR", "legFL", "legFR", "legBL", "legBR", "neck", "tail"]

def sphere(m, r, color, x=0, y=0, z=0, sx=1, sy=1, sz=1, seg=10, rings=6, vary=0.0, rx=0, ry=0, rz=0):
    t = bmesh.new()
    bmesh.ops.create_uvsphere(t, u_segments=seg, v_segments=rings, radius=r)
    return m._take(t, color, Matrix.Translation(P(x, y, z)) @ rot(rx, ry, rz) @ scale3(sx, sy, sz), vary)

def sausage(m, r, length, color, x, y, z, rx=0, rz=0, seg=6):
    """A capsule hanging down from (x, y, z): a limb."""
    mm = Matrix.Translation(P(x, y, z)) @ rot(rx, 0, rz)
    t = bmesh.new()
    bmesh.ops.create_cone(t, cap_ends=False, segments=seg, radius1=r, radius2=r, depth=length)
    m._take(t, color, mm @ Matrix.Translation(P(0, -length / 2, 0)), 0)
    for yy in (0.0, -length):
        t = bmesh.new()
        bmesh.ops.create_uvsphere(t, u_segments=seg, v_segments=4, radius=r)
        m._take(t, color, mm @ Matrix.Translation(P(0, yy, 0)), 0)

HUMAN_PIVOTS = {"hips": (0, 0.2, 0), "body": (0, 0.22, 0), "head": (0, 0.47, 0), "armL": (0, 0.43, -0.13), "armR": (0, 0.43, 0.13),
                "legL": (0, 0.2, -0.055), "legR": (0, 0.2, 0.055)}

def tabs_person(m, tunic, belt=None, legs_col="#4a3a2a", skin=SKIN, sleeves=None):
    """The shared body: egg torso, round head with eyes and brows, arms, legs."""
    m.smooth = True
    for side, z in (("legL", -0.055), ("legR", 0.055)):
        m.part(side)
        sausage(m, 0.042, 0.13, legs_col, 0, 0.19, z)
        sphere(m, 0.05, "#3a2a1c", 0.02, 0.035, z, sx=1.3, sy=0.7, sz=0.95, seg=6, rings=4)  # boot
    m.part("body")
    sphere(m, 0.13, tunic, 0, 0.33, 0, sx=0.95, sy=1.15, sz=1.05)
    if belt:
        m.cyl(0.128, 0.128, 0.035, belt, 0, 0.27, 0, seg=14, vary=0)
    for side, z in (("armL", -0.13), ("armR", 0.13)):
        m.part(side)
        sausage(m, 0.035, 0.13, sleeves or tunic, 0, 0.43, z)
        sphere(m, 0.04, skin, 0, 0.29, z, seg=6, rings=4)  # hand
    m.part("head")
    sphere(m, 0.105, skin, 0, 0.56, 0)
    m.smooth = False
    for z in (-0.036, 0.036):
        sphere(m, 0.016, "#1a1410", 0.096, 0.575, z, seg=6, rings=4)
        m.box(0.012, 0.012, 0.04, "#3a2a1c", 0.095, 0.605, z * 1.1, rz=0.0, rx=(0.35 if z > 0 else -0.35), vary=0)
    m.smooth = True

def dome(m, r, col, y, x=0.0, sy=0.85):
    """A helmet or cap: the top half of a sphere."""
    t = bmesh.new()
    bmesh.ops.create_uvsphere(t, u_segments=10, v_segments=6, radius=r)
    bmesh.ops.delete(t, geom=[v for v in t.verts if v.co.z < -0.001], context="VERTS")
    m._take(t, col, Matrix.Translation(P(x, y, 0)) @ scale3(1, sy, 1), 0)

def straw_hat(m, y=0.6, r=0.2):
    m.part("head", smooth=False)
    m.cyl(r, r * 0.95, 0.025, "#d9b85c", 0, y, 0, seg=14, vary=0.04)          # brim
    m.cyl(0.1, 0.03, 0.12, "#e0c46a", 0, y + 0.07, 0, seg=12, vary=0.04)       # crown
    m.cyl(0.102, 0.098, 0.03, TEAM, 0, y + 0.025, 0, seg=12, vary=0)           # team band

def citizen():
    """A farmer: straw hat with a team band, team scarf, sleeves rolled up; a hoe."""
    m = Model("Citizen")
    tabs_person(m, "#c9ad78", belt="#7a5532", sleeves=SKIN)
    m.part("body"); m.cyl(0.11, 0.125, 0.04, TEAM, 0, 0.45, 0, seg=12, vary=0)  # scarf
    m.box(0.03, 0.12, 0.06, TEAM, 0.06, 0.41, 0.06, rz=0.2, vary=0)            # its loose end
    straw_hat(m)
    t = Model("Citizen.tool")
    t.cyl(0.014, 0.014, 0.5, WOOD, 0, 0.12, 0, seg=6, vary=0)
    t.box(0.12, 0.025, 0.05, IRON, 0.05, 0.36, 0, vary=0)
    return dict(body=m, tool=t, tool_at=(0.0, 0.29, 0.13), tool_bone="armR", pivots=HUMAN_PIVOTS)

def spearman():
    m = Model("Spearman")
    tabs_person(m, TEAM, belt="#5a4632", sleeves=TEAM_DARK)
    m.part("body"); sphere(m, 0.12, IRON, 0.02, 0.37, 0, sx=0.9, sy=0.7, sz=1.05)  # breastplate
    m.part("head"); dome(m, 0.112, IRON, 0.58)
    for i in range(5):  # a tall crest across the helmet, like a fan
        a = (i - 2) * 0.42
        m.box(0.035, 0.11, 0.06, TEAM, -0.01, 0.685 + math.cos(a) * 0.05, math.sin(a) * 0.13, rx=a, vary=0)
    m.box(0.015, 0.06, 0.02, IRON, 0.105, 0.56, 0, vary=0)  # nose guard
    m.part("armL", smooth=False)  # the shield rides on the left arm
    m.cyl(0.12, 0.12, 0.03, TEAM_DARK, 0.04, 0.33, -0.18, seg=14, rx=math.pi / 2, vary=0)
    m.cyl(0.13, 0.13, 0.02, IRON, 0.04, 0.33, -0.172, seg=14, rx=math.pi / 2, vary=0)
    m.ball(0.035, GOLD, 0.04, 0.33, -0.2, sub=1, vary=0)
    t = Model("Spearman.tool")
    t.cyl(0.015, 0.015, 0.95, WOOD, 0, 0.1, 0, seg=6, vary=0)
    t.cyl(0.035, 0.0, 0.14, IRON, 0, 0.64, 0, seg=4, vary=0)
    return dict(body=m, tool=t, tool_at=(0.0, 0.29, 0.13), tool_bone="armR", pivots=HUMAN_PIVOTS)

def archer():
    m = Model("Archer")
    tabs_person(m, "#617040", belt=TEAM, legs_col="#4a3a28")
    m.part("head"); dome(m, 0.115, "#4f5a30", 0.575, sy=1.0)
    m.cyl(0.06, 0.0, 0.12, "#4f5a30", -0.08, 0.6, 0, seg=6, rz=1.2, vary=0)  # hood tip
    m.part("body"); m.cyl(0.11, 0.12, 0.04, TEAM, 0, 0.45, 0, seg=12, vary=0)  # scarf
    m.cyl(0.04, 0.035, 0.26, DARKWOOD, -0.12, 0.4, 0.04, seg=8, rz=0.3, vary=0)  # quiver
    for i in range(3):
        m.box(0.012, 0.08, 0.012, CLOTH, -0.17 + i * 0.012, 0.55, 0.02 + i * 0.02, rz=0.3, vary=0)
    t = Model("Archer.tool")  # the bow, held upright in the left hand
    for i in range(9):
        a = -1.25 + i * (2.5 / 8)
        t.box(0.025, 0.065, 0.025, "#6b4a2a", math.cos(a) * 0.18 - 0.12, math.sin(a) * 0.21, 0, rz=a, vary=0)
    t.cyl(0.004, 0.004, 0.4, CLOTH, -0.12, 0, 0, seg=3, vary=0)
    return dict(body=m, tool=t, tool_at=(0.02, 0.29, -0.13), tool_bone="armL", pivots=HUMAN_PIVOTS)


# --- Build, bake and export --------------------------------------------------------------------
# --- Medieval ---------------------------------------------------------------------------
BRICK, BRICK2, CLAY = "#a8452e", "#c8664a", "#b9764a"
WOOL = "#ece6d6"

def kite_shield(m, x, y, z, col=TEAM, trim=IRON):
    """A kite shield on the left arm: round top, pointed bottom, a cross on it."""
    m.box(0.03, 0.2, 0.17, col, x, y + 0.03, z, vary=0)
    m.cyl(0.085, 0.085, 0.03, col, x, y + 0.13, z, seg=12, rz=math.pi / 2, vary=0)
    m.cyl(0.085, 0.0, 0.16, col, x, y - 0.14, z, seg=4, rz=math.pi, ry=math.pi / 4, vary=0)
    m.box(0.035, 0.3, 0.03, trim, x + 0.005, y, z, vary=0)
    m.box(0.035, 0.03, 0.16, trim, x + 0.005, y + 0.06, z, vary=0)

def great_helm(m, y, x=0.0, plume=TEAM):
    """A flat-topped iron helm with an eye slit, closed over the face."""
    m.cyl(0.112, 0.112, 0.15, IRON, x, y, 0, seg=12, vary=0)
    m.cyl(0.112, 0.095, 0.025, "#8b929b", x, y + 0.087, 0, seg=12, vary=0)
    m.box(0.02, 0.018, 0.15, "#1a1410", x + 0.108, y + 0.015, 0, vary=0)  # eye slit
    m.box(0.02, 0.07, 0.012, "#1a1410", x + 0.108, y - 0.035, 0, vary=0)   # breathing holes
    if plume:
        m.ball(0.05, plume, x - 0.01, y + 0.13, 0, sub=1, sy=1.3, sx=0.8, vary=0)

def swordsman():
    m = Model("Swordsman")
    tabs_person(m, TEAM, belt="#3a2c20", legs_col="#5b5f66", sleeves="#7d848c")  # mail sleeves and leggings
    m.part("body")
    sphere(m, 0.125, IRON, 0.02, 0.36, 0, sx=0.95, sy=0.8, sz=1.07)  # breastplate
    m.box(0.02, 0.2, 0.05, TEAM_DARK, 0.135, 0.34, 0, vary=0)        # tabard stripe
    m.part("head", smooth=False)
    great_helm(m, 0.58)
    m.part("armL", smooth=False)
    kite_shield(m, 0.05, 0.3, -0.19)
    t = Model("Swordsman.tool")  # an arming sword, point up out of the fist
    t.box(0.022, 0.034, 0.022, "#3a2a1c", 0, 0.0, 0, vary=0)        # grip
    t.ball(0.02, GOLD, 0, -0.03, 0, sub=0, vary=0)                    # pommel
    t.box(0.025, 0.02, 0.13, GOLD, 0, 0.03, 0, vary=0)               # crossguard
    t.box(0.012, 0.36, 0.04, "#d8dde3", 0, 0.22, 0, vary=0)          # blade
    t.cyl(0.02, 0.0, 0.05, "#d8dde3", 0, 0.425, 0, seg=4, vary=0)    # point
    return dict(body=m, tool=t, tool_at=(0.0, 0.29, 0.13), tool_bone="armR", pivots=HUMAN_PIVOTS)

def crossbowman():
    m = Model("Crossbowman")
    tabs_person(m, "#b9a27a", belt=TEAM, legs_col="#4a3a28", sleeves="#a38e68")  # quilted jacket
    m.part("body")
    for i in range(4):
        m.cyl(0.13 - abs(i - 1.5) * 0.012, 0.13 - abs(i - 1.5) * 0.012, 0.012, "#8f7a56", 0, 0.27 + i * 0.05, 0, seg=12, vary=0)  # quilting
    m.cyl(0.11, 0.12, 0.04, TEAM, 0, 0.45, 0, seg=12, vary=0)       # collar
    m.box(0.07, 0.16, 0.08, DARKWOOD, -0.13, 0.36, 0.06, rz=0.2, vary=0)  # bolt case
    m.part("head", smooth=False)
    dome(m, 0.112, IRON, 0.585)                                       # kettle hat
    m.cyl(0.18, 0.17, 0.02, IRON, 0, 0.6, 0, seg=14, vary=0)         # its wide brim
    t = Model("Crossbowman.tool")  # the crossbow, held level, pointing forward
    t.box(0.34, 0.035, 0.035, WOOD, 0.1, 0.0, 0, vary=0)             # stock
    t.box(0.025, 0.025, 0.36, "#5b4a3a", 0.25, 0.01, 0, vary=0)      # the bow (prod)
    t.cyl(0.003, 0.003, 0.32, CLOTH, 0.19, 0.01, 0, seg=3, rx=math.pi / 2, vary=0)  # string
    t.box(0.03, 0.06, 0.02, "#3a2a1c", -0.03, -0.04, 0, vary=0)      # trigger
    t.box(0.04, 0.04, 0.012, IRON, 0.28, 0.0, 0, vary=0)             # stirrup
    return dict(body=m, tool=t, tool_at=(0.02, 0.32, 0.13), tool_bone="armR", pivots=HUMAN_PIVOTS)


def trebuchet():
    """A siege engine on wheels. The throwing arm is its tool (it swings when
    it attacks); no skeleton: the whole engine just rolls."""
    m = Model("Trebuchet")
    for z in (-0.17, 0.17):
        m.box(0.7, 0.05, 0.05, WOOD, 0, 0.1, z, vary=0.04)                 # base beams
        for x in (-0.24, 0.24):
            m.cyl(0.075, 0.075, 0.035, DARKWOOD, x, 0.075, z * 1.18, seg=10, rx=math.pi / 2, vary=0)  # wheels
            m.cyl(0.02, 0.02, 0.04, IRON, x, 0.075, z * 1.28, seg=6, rx=math.pi / 2, vary=0)
        for sx in (-1, 1):
            m.box(0.04, 0.5, 0.04, WOOD, sx * 0.11, 0.33, z, rz=sx * 0.35, vary=0.04)  # A-frame legs
    m.box(0.05, 0.05, 0.42, DARKWOOD, 0, 0.55, 0, vary=0)                 # the axle the arm swings on
    for x in (-0.3, 0.3):
        m.box(0.05, 0.05, 0.4, WOOD, x, 0.1, 0, vary=0.04)                 # cross beams
    m.box(0.16, 0.05, 0.3, "#8c6238", -0.24, 0.14, 0, vary=0.04)           # a platform
    m.ball(0.05, STONE2, -0.25, 0.2, 0.06, sub=1, vary=0.05)              # ammunition
    m.ball(0.045, STONE2, -0.2, 0.2, -0.05, sub=1, vary=0.05)
    m.box(0.03, 0.18, 0.03, DARKWOOD, 0.33, 0.2, 0.17, vary=0)
    m.flag(0.14, 0.09, TEAM, 0.4, 0.25, 0.17)
    t = Model("Trebuchet.tool")  # the arm: long end back and up, counterweight down at the front
    t.box(0.04, 0.7, 0.04, "#8c6238", 0, 0.2, 0, rz=0.9, vary=0)
    t.box(0.13, 0.13, 0.13, "#5a5148", 0.11, -0.11, 0, vary=0.05)          # counterweight box
    t.box(0.14, 0.03, 0.14, DARKWOOD, 0.11, -0.04, 0, vary=0)
    t.cyl(0.004, 0.004, 0.2, CLOTH, -0.3, 0.32, 0, seg=3, vary=0)           # the sling
    t.ball(0.04, "#5a5148", -0.3, 0.22, 0, sub=1, vary=0.05)
    return dict(body=m, tool=t, tool_at=(0.0, 0.55, 0.0), tool_bone="body", pivots={})

def cottage():
    """A hut grown up: a timber-framed cottage with a thatched roof and a chimney."""
    m = Model("Cottage")
    foundation(m, 2)
    timber_hall(m, 1.15, 0.55, 0.9, PLASTER, THATCH, "#b08d48", rows=5, windows=2, roof_h=0.55)
    m.box(0.15, 0.55, 0.15, STONE2, -0.38, 0.95, -0.2, vary=0.06)  # chimney: smoke comes out at the top
    m.box(0.19, 0.05, 0.19, STONE, -0.38, 1.24, -0.2, vary=0)
    # a garden with a fence, a bench and a water butt
    fence(m, -0.85, 0.78, 0.85, 0.78, 8, h=0.2)
    for i in range(4):
        m.ball(0.05, "#5c8c34" if i % 2 else "#6f9e3a", -0.6 + i * 0.13, 0.08, 0.66, sub=0)
    m.ball(0.035, "#d8573e", -0.47, 0.13, 0.66, sub=0)
    barrel(m, 0.72, 0.5, r=0.08, h=0.18)
    m.box(0.3, 0.04, 0.1, WOOD, 0.35, 0.16, 0.55, vary=0)
    for x in (0.23, 0.47):
        m.box(0.04, 0.14, 0.08, DARKWOOD, x, 0.08, 0.55, vary=0)
    m.box(0.24, 0.2, 0.18, "#8a6438", -0.72, 0.1, -0.55, vary=0.05)  # woodpile
    m.pole_flag(0.8, -0.6, 1.0)
    return m

def sheep(m, x, z, a=0.0, s=1.0):
    """A woolly sheep facing +x turned by a: a fluffy body, a dark face and legs."""
    c, sn = math.cos(a), math.sin(a)
    def at(px, pz):
        return x + (px * c - pz * sn) * s, z + (px * sn + pz * c) * s
    for px, pz in ((0.08, 0.04), (0.08, -0.04), (-0.07, 0.04), (-0.07, -0.04)):
        lx, lz = at(px, pz)
        m.box(0.025 * s, 0.1 * s, 0.025 * s, "#2a221c", lx, 0.05 * s, lz, vary=0)
    bx, bz = at(0, 0)
    m.ball(0.12 * s, WOOL, bx, 0.16 * s, bz, sub=1, sx=1.35, sy=0.85, sz=0.95, jitter=0.12, ry=a, vary=0.04)
    hx, hz = at(0.16, 0)
    m.ball(0.055 * s, "#2a221c", hx, 0.19 * s, hz, sub=1, sx=1.3, sy=0.9, sz=0.85, ry=a, vary=0)
    ex, ez = at(0.13, 0)
    m.ball(0.05 * s, WOOL, ex, 0.24 * s, ez, sub=0, vary=0.04)

def sheep_farm():
    m = Model("SheepFarm")
    m.box(2.9, 0.06, 2.9, "#7a9a44", 0, 0.03, 0, vary=0.03)
    for x0, z0, x1, z1 in ((-1.4, -1.4, 1.4, -1.4), (-1.4, 1.4, 1.4, 1.4), (-1.4, -1.4, -1.4, 1.4), (1.4, -1.4, 1.4, 0.4)):
        fence(m, x0, z0, x1, z1, 8, h=0.3)
    # the shepherd's shed, with fleeces drying and bales of wool
    m.box(0.9, 0.5, 0.6, "#a08058", -0.8, 0.3, -0.8, vary=0.03)
    m.roof(0.9, 0.6, 0.3, THATCH, -0.8, 0.55, -0.8, rows=3, row_col="#b08d48")
    door(m, -0.8, -0.49, w=0.2, h=0.34, y=0.05)
    for i in range(3):
        m.box(0.2, 0.16, 0.16, WOOL, -0.15 + i * 0.22, 0.14, -1.05, vary=0.05)
        m.box(0.21, 0.02, 0.17, "#b8a77a", -0.15 + i * 0.22, 0.14, -1.05, vary=0)
    m.box(0.04, 0.4, 0.04, DARKWOOD, 0.5, 0.2, -1.1, vary=0)
    m.box(0.04, 0.4, 0.04, DARKWOOD, 0.9, 0.2, -1.1, vary=0)
    m.box(0.44, 0.03, 0.03, DARKWOOD, 0.7, 0.38, -1.1, vary=0)
    m.box(0.16, 0.18, 0.02, WOOL, 0.62, 0.27, -1.1, vary=0)
    m.box(0.14, 0.16, 0.02, "#d9cfb5", 0.8, 0.28, -1.1, vary=0)
    # The game draws units and grazing animals 1.5 times their size: so are these sheep.
    for x, z, a in ((0.25, 0.3, 0.4), (0.85, 0.75, 2.5), (-0.55, 0.75, -0.6), (0.7, -0.3, 1.2)):
        sheep(m, x, z, a, s=1.5)
    m.box(0.5, 0.12, 0.18, WOOD, -0.6, 0.12, 0.1, vary=0)  # a trough
    m.box(0.44, 0.02, 0.13, "#4f87a0", -0.6, 0.18, 0.1, vary=0)
    m.pole_flag(1.25, -1.25, 1.0)
    return m

def iron_mine():
    m = Model("IronMine")
    foundation(m, 2, col="#7a7064")
    # a rocky knoll with a timbered adit cut into it
    for x, z, r in ((-0.35, -0.3, 0.55), (0.25, -0.45, 0.45), (-0.65, 0.2, 0.32), (0.55, 0.05, 0.3)):
        m.rock(r, "#857b6e", x, 0.02, z, flat=0.75, vary=0.06)
    for x, y, z in ((-0.5, 0.45, -0.1), (0.1, 0.5, -0.5), (0.45, 0.25, 0.1), (-0.2, 0.62, -0.35)):
        m.ball(0.05, "#8a4a32", x, y, z, sub=0, jitter=0.2, vary=0.1)  # rusty ore
    m.box(0.42, 0.42, 0.25, "#151210", -0.05, 0.27, 0.12, vary=0)       # the dark entrance
    for sx in (-1, 1):
        m.box(0.07, 0.5, 0.07, WOOD, -0.05 + sx * 0.24, 0.3, 0.27, vary=0.04)
    m.box(0.6, 0.08, 0.09, WOOD, -0.05, 0.57, 0.27, vary=0.04)
    # rails out to a cart full of ore, and the heap it tips onto
    for sz in (-1, 1):
        m.box(0.03, 0.025, 0.7, "#5a5148", -0.05 + sz * 0.09, 0.08, 0.6, vary=0)
    for i in range(5):
        m.box(0.26, 0.02, 0.05, DARKWOOD, -0.05, 0.07, 0.3 + i * 0.15, vary=0)
    m.box(0.28, 0.16, 0.22, "#5a4a3a", -0.05, 0.2, 0.75, taper=1.15, vary=0.04)
    for x, z in ((-0.13, 0.75), (0.03, 0.75), (-0.05, 0.7)):
        m.ball(0.06, "#6e3e2c", x, 0.29, z, sub=0, jitter=0.2, vary=0.1)
    for x, z in ((-0.14, 0.66), (0.04, 0.66), (-0.14, 0.84), (0.04, 0.84)):
        m.cyl(0.035, 0.035, 0.02, "#2e2a26", x, 0.11, z + (0.0), seg=8, rz=math.pi / 2, vary=0)
    for x, z, r in ((0.6, 0.55, 0.16), (0.72, 0.4, 0.12), (0.5, 0.7, 0.1)):
        m.rock(r, "#7a4632", x, 0.05, z, flat=0.6, vary=0.1)
    m.box(0.18, 0.3, 0.05, DARKWOOD, -0.7, 0.2, 0.62, vary=0)  # pick and shovel leaning on a post
    m.pole_flag(0.75, -0.75, 1.1)
    return m

def brickworks():
    m = Model("Brickworks")
    foundation(m, 2)
    # a domed kiln with a tall chimney, glowing at the firing hole
    m.cyl(0.42, 0.42, 0.45, BRICK, -0.25, 0.3, -0.2, seg=14, vary=0.05)
    sphere(m, 0.42, BRICK2, -0.25, 0.52, -0.2, sy=0.75, vary=0.05)
    for y in (0.15, 0.32, 0.49):
        m.cyl(0.425, 0.425, 0.02, "#7a3020", -0.25, y, -0.2, seg=14, vary=0)
    m.box(0.16, 0.14, 0.06, "#ff7a2a", -0.25, 0.17, 0.21, vary=0)
    m.box(0.2, 0.18, 0.04, "#3a1a10", -0.25, 0.18, 0.2, vary=0)
    m.box(0.16, 0.9, 0.16, BRICK, 0.15, 0.75, -0.55, vary=0.05)  # chimney: smoke comes out at the top
    m.box(0.2, 0.05, 0.2, "#7a3020", 0.15, 1.22, -0.55, vary=0)
    # stacks of fired bricks, and green ones drying under a little roof
    for k in range(3):
        for j in range(3):
            m.box(0.2, 0.06, 0.1, BRICK if (j + k) % 2 else BRICK2, 0.55, 0.11 + k * 0.065, 0.2 + j * 0.11, vary=0.06)
    for i in range(2):
        for j in range(3):
            m.box(0.12, 0.05, 0.07, CLAY, 0.35 + j * 0.15, 0.13 + i * 0.12, 0.75, vary=0.06)
    for sx in (-1, 1):
        m.box(0.04, 0.45, 0.04, WOOD, 0.5 + sx * 0.28, 0.25, 0.75, vary=0)
    m.box(0.7, 0.04, 0.3, THATCH, 0.5, 0.48, 0.75, rx=0.15, vary=0.05)
    m.box(0.36, 0.1, 0.3, "#8a5a3a", -0.6, 0.11, 0.6, vary=0.05)  # a clay pit's barrow load
    m.pole_flag(-0.8, -0.7, 1.0)
    return m


def weaver():
    m = Model("Weaver")
    foundation(m, 2)
    timber_hall(m, 0.95, 0.58, 0.95, "#cdbb98", "#6f7a5a", "#5d6649", rows=4, windows=1, roof_h=0.42, gable_front=True)
    # a loom out front with cloth on it, in the team colour
    for sx in (-1, 1):
        for sz in (-1, 1):
            m.box(0.035, 0.42, 0.035, WOOD, 0.55 + sx * 0.2, 0.21, 0.6 + sz * 0.13, vary=0)
    m.box(0.44, 0.035, 0.035, DARKWOOD, 0.55, 0.42, 0.47, vary=0)
    m.box(0.44, 0.035, 0.035, DARKWOOD, 0.55, 0.25, 0.73, vary=0)
    m.box(0.36, 0.015, 0.26, TEAM, 0.55, 0.33, 0.6, rx=0.55, vary=0)
    for i in range(6):
        m.box(0.004, 0.2, 0.004, CLOTH, 0.4 + i * 0.06, 0.34, 0.54, rx=0.55, vary=0)
    # bolts of cloth and bales of wool
    for i, col in enumerate((TEAM_DARK, "#4f7aa8", "#a8452e")):
        m.cyl(0.06, 0.06, 0.32, col, -0.6, 0.08 + i * 0.12, 0.62, seg=8, rx=math.pi / 2, vary=0)
    for x, z in ((0.65, -0.55), (0.65, -0.3)):
        m.box(0.2, 0.18, 0.2, WOOL, x, 0.15, z, bevel=0.02, vary=0.04)
    # dyed cloth drying on two lines high across the yard: the weaver's mark from afar
    for z, cols in ((0.86, (TEAM, "#d9b24a", "#b8402e", CLOTH, TEAM_DARK)), (-0.8, ("#b8402e", CLOTH, TEAM, "#d9b24a"))):
        for sx in (-1, 1):
            m.box(0.045, 1.0, 0.045, DARKWOOD, sx * 0.84, 0.56, z, vary=0)
        m.box(1.68, 0.015, 0.015, "#c9b88f", 0, 1.03, z, vary=0)
        w = 1.5 / len(cols)
        for i, col in enumerate(cols):
            m.box(w * 0.86, 0.36 + (i % 2) * 0.1, 0.02, col, -0.75 + w * (i + 0.5), 0.84 - (i % 2) * 0.05, z, vary=0.03)
    for x, col in ((-0.62, "#3a5a9a"), (-0.36, "#a8342a")):                    # dye vats
        m.cyl(0.1, 0.085, 0.14, "#7d5631", x, 0.15, 0.42, seg=10, vary=0.04)
        m.cyl(0.085, 0.085, 0.01, col, x, 0.225, 0.42, seg=10, vary=0)
    m.pole_flag(-0.8, -0.3, 1.0)
    return m


def siege_workshop():
    m = Model("SiegeWorkshop")
    foundation(m, 3)
    # a big open-sided shed of heavy timbers
    for x in (-1.1, 0.0, 1.1):
        for z in (-0.9, 0.9):
            m.box(0.12, 1.0, 0.12, WOOD, x, 0.55, z, vary=0.04)
    for z in (-0.9, 0.9):
        m.box(2.36, 0.1, 0.12, DARKWOOD, 0, 1.05, z, vary=0.03)
    m.roof(2.3, 1.85, 0.55, "#6b4d2d", 0, 1.1, 0, rows=5, row_col="#5c4126")
    m.box(2.2, 0.03, 1.7, "#8c6a46", 0, 0.08, 0, vary=0.05)  # plank floor
    # a trebuchet being built inside: its frame up, the arm on trestles
    for z in (-0.25, 0.25):
        m.box(1.1, 0.07, 0.07, WOOD, -0.2, 0.15, z, vary=0.04)
        for sx in (-1, 1):
            m.box(0.06, 0.75, 0.06, WOOD, -0.2 + sx * 0.17, 0.48, z, rz=sx * 0.35, vary=0.04)
    m.box(0.07, 0.07, 0.6, DARKWOOD, -0.2, 0.82, 0, vary=0)
    for x in (0.55, 0.95):
        for sx in (-1, 1):
            m.box(0.04, 0.3, 0.04, WOOD, x + sx * 0.1, 0.22, 0.45, rz=sx * 0.3, vary=0)
    m.box(1.0, 0.07, 0.07, "#8c6238", 0.75, 0.39, 0.45, vary=0.04)
    for i in range(3):
        m.cyl(0.07, 0.07, 1.1, "#8c6238", 0.4 + i * 0.16, 0.16, -0.6, seg=7, rz=math.pi / 2, vary=0.05)
    m.cyl(0.14, 0.14, 0.05, DARKWOOD, 1.25, 0.18, 0.4, seg=12, rx=math.pi / 2, vary=0)  # a spare wheel
    m.pole_flag(-1.35, 1.2, 1.3)
    return m

def iron_ore():
    """Iron ore: one dark boulder streaked with rust."""
    m = Model("IronOre")
    m.boulder(0.44, "#6e655c", 0, 0, 0, flat=0.68, sx=1.05, sz=0.95, flecks=("#9a4a2c", 0.15))
    return m

def clay_pit():
    """A clay pit: one broad, low mound of wet, reddish clay, cut flat on top."""
    m = Model("ClayPit")
    m.boulder(0.47, CLAY, 0, 0, 0, flat=0.4, lumps=3, flecks=("#8a5236", 0.25), facets=0.35)
    return m

def sheep_herd():
    """Sheep grazing on a hillside: a deposit tile of the sheep hills."""
    m = Model("Sheep")
    m.smooth = True
    sheep(m, -0.12, -0.08, 0.5, s=1.0)
    sheep(m, 0.18, 0.14, 2.7, s=0.9)
    return m


# --- Gunpowder ---------------------------------------------------------------------------
def tricorne(m, y, x=0.0, col="#2a2420", trim=GOLD):
    m.cyl(0.16, 0.15, 0.03, col, x, y, 0, seg=3, ry=math.pi, vary=0)  # three-cornered brim
    m.cyl(0.1, 0.085, 0.09, col, x, y + 0.05, 0, seg=10, vary=0)
    m.cyl(0.161, 0.161, 0.012, trim, x, y + 0.012, 0, seg=3, ry=math.pi, vary=0)

def musket_tool(name, length=0.62):
    t = Model(name)  # a musket, level, pointing forward from the hand
    t.box(length, 0.03, 0.03, "#4e3420", length / 2 - 0.12, 0.0, 0, vary=0)       # stock
    t.cyl(0.012, 0.012, length * 0.75, "#5b6169", length * 0.55, 0.02, 0, seg=6, rz=math.pi / 2, vary=0)  # barrel
    t.box(0.08, 0.055, 0.035, "#4e3420", -0.12, -0.02, 0, vary=0)                 # butt
    t.cyl(0.006, 0.0, 0.12, "#c9ced5", length - 0.05, 0.02, 0, seg=4, rz=-math.pi / 2, vary=0)  # bayonet
    return t

def musketeer():
    m = Model("Musketeer")
    tabs_person(m, TEAM, belt="#e8e2d0", legs_col="#e8e2d0", sleeves=TEAM)  # coat, white breeches
    m.part("body")
    for z in (-1, 1):
        m.box(0.02, 0.3, 0.035, "#e8e2d0", 0.115, 0.36, z * 0.035, rx=z * 0.55, vary=0)  # cross belts
    m.cyl(0.135, 0.15, 0.08, TEAM_DARK, 0, 0.23, 0, seg=12, vary=0)  # coat skirts
    for y in (0.3, 0.36, 0.42):
        m.ball(0.012, GOLD, 0.125, y, 0, sub=0, vary=0)  # buttons
    m.part("head", smooth=False)
    tricorne(m, 0.63)
    t = musket_tool("Musketeer.tool")
    return dict(body=m, tool=t, tool_at=(0.02, 0.3, 0.13), tool_bone="armR", pivots=HUMAN_PIVOTS)


def cannon():
    """A field cannon on a two-wheeled carriage. The barrel is its tool (it
    kicks back when it fires); no skeleton."""
    m = Model("Cannon")
    for z in (-0.16, 0.16):
        m.cyl(0.16, 0.16, 0.04, "#4e3420", 0.02, 0.16, z, seg=12, rx=math.pi / 2, vary=0)  # wheels
        m.cyl(0.13, 0.13, 0.045, "#7a5532", 0.02, 0.16, z, seg=12, rx=math.pi / 2, vary=0)
        m.cyl(0.03, 0.03, 0.05, IRON, 0.02, 0.16, z * 1.15, seg=6, rx=math.pi / 2, vary=0)
        for k in range(4):
            m.box(0.02, 0.24, 0.02, "#4e3420", 0.02, 0.16, z, rz=k * math.pi / 4, vary=0)  # spokes
    m.box(0.05, 0.05, 0.36, DARKWOOD, 0.02, 0.16, 0, vary=0)  # axle
    for z in (-0.06, 0.06):
        m.box(0.5, 0.06, 0.04, "#6b4d2d", -0.2, 0.12, z, rz=0.32, vary=0.04)  # trail
    m.box(0.1, 0.04, 0.16, "#6b4d2d", -0.42, 0.04, 0, vary=0)
    m.box(0.12, 0.1, 0.1, "#3a2416", -0.25, 0.2, 0.0, vary=0)  # ammunition box
    for x, z in ((-0.1, 0.3), (-0.02, 0.32), (-0.06, 0.38)):
        m.ball(0.035, "#2e2e33", x, 0.035, z, sub=1, vary=0)
    m.box(0.03, 0.2, 0.03, DARKWOOD, -0.42, 0.15, 0.08, vary=0)
    m.flag(0.12, 0.08, TEAM, -0.35, 0.21, 0.08)
    t = Model("Cannon.tool")  # the barrel on its trunnions, pointing forward
    t.cyl(0.07, 0.05, 0.55, "#5b5148", 0.15, 0.0, 0, seg=10, rz=-math.pi / 2, vary=0)
    t.cyl(0.075, 0.075, 0.05, "#7c6a3a", -0.1, 0.0, 0, seg=10, rz=-math.pi / 2, vary=0)
    t.cyl(0.06, 0.06, 0.03, "#7c6a3a", 0.4, 0.0, 0, seg=10, rz=-math.pi / 2, vary=0)
    t.ball(0.05, "#5b5148", -0.14, 0.0, 0, sub=1, vary=0)
    return dict(body=m, tool=t, tool_at=(0.02, 0.25, 0.0), tool_bone="body", pivots={})

def townhouse():
    """A Gunpowder-era home: two floors of brick, a tiled roof, chimneys."""
    m = Model("Townhouse")
    foundation(m, 2)
    m.box(1.25, 1.0, 0.95, BRICK, 0, 0.56, 0, vary=0.03)
    m.box(1.29, 0.06, 0.99, STONE3, 0, 0.58, 0, vary=0)  # string course between the floors
    m.box(1.29, 0.07, 0.99, STONE3, 0, 1.06, 0, vary=0)
    for sx in (-1, 1):
        m.box(0.07, 1.0, 0.07, STONE3, sx * 0.62, 0.56, 0.47, vary=0)  # quoins
    m.prism(1.3, 1.0, 0.45, TILE, 0, 1.08, 0)
    m.roof(1.25, 0.95, 0.45, TILE, 0, 1.08, 0, rows=5, row_col="#7e3a26")
    for x in (-0.35, 0.35):
        window(m, x, 0.37, 0.485)
        window(m, x, 0.82, 0.485)
    window(m, 0.0, 0.82, 0.485)
    door(m, 0, 0.49, w=0.24, h=0.38, y=0.06)
    m.box(0.32, 0.04, 0.12, STONE3, 0, 0.5, 0.55, vary=0)  # door hood
    for x in (-0.35, 0.35):
        m.box(0.14, 0.5, 0.14, BRICK2, x, 1.45, -0.2, vary=0.05)  # chimneys: smoke from the right one
        m.box(0.17, 0.05, 0.17, STONE3, x, 1.71, -0.2, vary=0)
    for x in (-0.45, -0.2, 0.2, 0.45):
        m.box(0.1, 0.12, 0.07, "#6e8c3a", x, 0.49, 0.55, vary=0.2)  # window boxes
    m.pole_flag(0.78, 0.7, 1.0)
    return m

def saltpeter_works():
    m = Model("SaltpeterWorks")
    foundation(m, 2)
    # a long low shed over the nitre beds, and boiling pans out front
    m.box(1.1, 0.42, 0.6, "#a08058", -0.2, 0.27, -0.45, vary=0.03)
    m.roof(1.1, 0.6, 0.28, "#6b4d2d", -0.2, 0.48, -0.45, rows=3, row_col="#5c4126")
    for x in (-0.4, 0.1):
        m.box(0.42, 0.12, 0.3, "#5a5148", x, 0.12, 0.25, vary=0.04)       # brick hearth
        m.cyl(0.17, 0.15, 0.1, "#8b929b", x, 0.23, 0.25, seg=10, vary=0)  # pan
        m.cyl(0.15, 0.15, 0.02, "#f2efe6", x, 0.27, 0.25, seg=10, vary=0) # crystals
    for x, z, r in ((0.55, 0.55, 0.16), (0.7, 0.3, 0.12), (0.6, 0.0, 0.1)):
        m.cyl(r, 0.0, r * 1.2, "#ece8dc", x, 0.06 + r * 0.6, z, seg=7, vary=0.05)  # heaps of saltpeter
    barrel(m, 0.65, -0.55); barrel(m, 0.45, -0.6, r=0.07, h=0.17)
    m.pole_flag(-0.8, 0.65, 1.0)
    return m


def circus():
    """A big top: a striped tent in team colours and white, pennants, a ring outside."""
    m = Model("Circus")
    m.box(2.85, 0.5, 2.85, "#6f6553", 0, -0.2, 0, vary=0.02)
    m.box(2.8, 0.06, 2.8, "#c8b78c", 0, 0.03, 0, vary=0.03)
    n = 16
    for i in range(n):
        a = i / n * math.pi * 2
        col = TEAM if i % 2 else CLOTH
        # wall panels and the conical roof in alternating stripes
        m.box(0.62, 0.6, 0.03, col, math.cos(a) * 1.15, 0.36, math.sin(a) * 1.15, ry=-a + math.pi / 2, vary=0)
    m.cyl(1.25, 0.0, 0.95, CLOTH, 0, 1.1, 0, seg=16, vary=0)
    for i in range(0, n, 2):
        a = (i + 0.5) / n * math.pi * 2
        m.box(0.05, 1.0, 0.3, TEAM, math.cos(a) * 0.62, 1.06, math.sin(a) * 0.62, ry=-a, rz=0.0, rx=0.0, vary=0)
    m.cyl(1.27, 1.27, 0.08, TEAM_DARK, 0, 0.66, 0, seg=16, vary=0)
    m.cyl(0.03, 0.03, 0.5, DARKWOOD, 0, 1.7, 0, seg=6, vary=0)
    m.flag(0.3, 0.18, TEAM, 0.15, 1.85, 0)
    m.box(0.4, 0.5, 0.05, "#2a221a", 0, 0.3, 1.17, vary=0)  # the entrance
    for x in (-1.2, 1.2):
        m.pole_flag(x, 1.25, 0.9)
    m.cyl(0.32, 0.32, 0.06, "#a8452e", 0.9, 0.05, -1.0, seg=14, vary=0)  # a little ring with a drum
    m.cyl(0.08, 0.08, 0.14, "#c9a24a", 0.9, 0.1, -1.0, seg=10, vary=0)
    return m

def saltpeter():
    """A saltpeter deposit: one big mound crusted white."""
    m = Model("Saltpeter")
    m.boulder(0.45, "#ece8dc", 0, 0, 0, flat=0.48, sx=1.05, sz=0.95, flecks=("#b8af9c", 0.15), vary=0.04)
    return m


# --- Industrial ----------------------------------------------------------------------------
COALC, STEEL = "#26262a", "#7d8792"

def peaked_cap(m, y, col=TEAM_DARK):
    m.cyl(0.1, 0.105, 0.07, col, 0, y + 0.03, 0, seg=12, vary=0)
    m.cyl(0.115, 0.1, 0.03, col, 0.005, y + 0.08, 0, seg=12, vary=0)
    m.box(0.08, 0.012, 0.13, "#1a1410", 0.09, y + 0.0, 0, vary=0)  # the peak



def field_gun():
    """A steel field gun with a shield. The barrel is its tool; no skeleton."""
    m = Model("FieldGun")
    for z in (-0.18, 0.18):
        m.cyl(0.17, 0.17, 0.04, "#3e3f3a", 0.0, 0.17, z, seg=14, rx=math.pi / 2, vary=0)
        m.cyl(0.14, 0.14, 0.045, "#5b5e52", 0.0, 0.17, z, seg=14, rx=math.pi / 2, vary=0)
        m.cyl(0.035, 0.035, 0.05, STEEL, 0.0, 0.17, z * 1.15, seg=6, rx=math.pi / 2, vary=0)
        for k in range(6):
            m.box(0.018, 0.26, 0.018, "#3e3f3a", 0.0, 0.17, z, rz=k * math.pi / 6, vary=0)
    m.box(0.05, 0.05, 0.4, "#2e2f2a", 0.0, 0.17, 0, vary=0)
    m.box(0.04, 0.3, 0.44, "#5b5e52", 0.08, 0.36, 0, vary=0)    # gun shield
    m.box(0.045, 0.06, 0.12, "#2a2c30", 0.081, 0.42, 0, vary=0)  # its slot
    m.box(0.55, 0.06, 0.06, "#4a4c42", -0.28, 0.1, 0, rz=0.28, vary=0)  # split trail
    m.box(0.08, 0.04, 0.16, "#4a4c42", -0.52, 0.03, 0, vary=0)
    m.box(0.12, 0.1, 0.1, "#3a3d30", -0.25, 0.22, 0.13, vary=0)  # shell box
    for k in range(3):
        m.cyl(0.02, 0.0, 0.07, "#c9a24a", -0.29 + k * 0.04, 0.3, 0.13, seg=6, vary=0)
    m.box(0.03, 0.2, 0.03, DARKWOOD, -0.5, 0.13, 0.1, vary=0)
    m.flag(0.12, 0.08, TEAM, -0.43, 0.2, 0.1)
    t = Model("FieldGun.tool")  # the barrel and its cradle
    t.cyl(0.045, 0.035, 0.62, "#3e4146", 0.22, 0.0, 0, seg=10, rz=-math.pi / 2, vary=0)
    t.box(0.22, 0.08, 0.1, "#2e3034", -0.03, -0.01, 0, vary=0)
    t.cyl(0.05, 0.05, 0.03, "#2e3034", 0.52, 0.0, 0, seg=10, rz=-math.pi / 2, vary=0)
    return dict(body=m, tool=t, tool_at=(0.02, 0.33, 0.0), tool_bone="body", pivots={})

def tenement():
    """An Industrial-era home: four floors of brick with a flat roof."""
    m = Model("Tenement")
    foundation(m, 2)
    m.box(1.35, 1.75, 1.15, "#8e3e2a", 0, 0.93, 0, vary=0.03)
    for y in (0.5, 0.92, 1.34):
        m.box(1.39, 0.05, 1.19, STONE3, 0, y, 0, vary=0)  # floor bands
    m.box(1.43, 0.1, 1.23, STONE2, 0, 1.84, 0, vary=0)    # cornice
    for y in (0.3, 0.72, 1.14, 1.56):
        for x in (-0.42, 0.0, 0.42):
            if not (y < 0.4 and x == 0.0):
                window(m, x, y, 0.585, w=0.16, h=0.2)
        for z in (-0.3, 0.3):
            window(m, 0.685, y, z, face="x", w=0.16, h=0.2)
    door(m, 0, 0.585, w=0.26, h=0.38, y=0.06)
    for x in (-0.4, 0.4):
        m.box(0.18, 0.4, 0.18, "#7a3424", x, 2.08, -0.2, vary=0.05)  # chimneys: smoke from the right one
        m.box(0.21, 0.05, 0.21, STONE2, x, 2.29, -0.2, vary=0)
    m.box(0.5, 0.25, 0.04, "#cfc8b6", -0.3, 1.97, 0.3, vary=0)  # laundry on the roof
    m.box(0.02, 0.35, 0.02, DARKWOOD, -0.56, 2.0, 0.3, vary=0)
    m.box(0.02, 0.35, 0.02, DARKWOOD, -0.04, 2.0, 0.3, vary=0)
    m.pole_flag(0.75, 0.75, 0.9)
    return m

def coal_mine():
    """A pithead: a timber headframe with its wheel, a winding house, a coal heap."""
    m = Model("CoalMine")
    foundation(m, 2, col="#5a5248")
    for sx in (-1, 1):
        for sz in (-1, 1):
            m.box(0.06, 1.3, 0.06, "#4e3420", -0.25 + sx * 0.22, 0.68, sz * 0.22, rz=-sx * 0.12, rx=sz * 0.12, vary=0.04)
    m.box(0.36, 0.06, 0.36, "#4e3420", -0.25, 1.3, 0, vary=0)
    m.cyl(0.2, 0.2, 0.04, STEEL, -0.25, 1.45, 0, seg=14, rx=math.pi / 2, vary=0)  # the winding wheel
    m.cyl(0.04, 0.04, 0.08, "#2e2e33", -0.25, 1.45, 0, seg=6, rx=math.pi / 2, vary=0)
    m.box(0.012, 1.1, 0.012, "#2e2e33", -0.05, 0.9, 0, vary=0)  # the cable
    m.box(0.55, 0.45, 0.5, BRICK, 0.5, 0.29, -0.4, vary=0.04)     # winding house
    m.roof(0.55, 0.5, 0.2, "#3a3a3a", 0.5, 0.52, -0.4)
    m.box(0.1, 0.5, 0.1, BRICK, 0.68, 0.78, -0.55, vary=0)
    for x, z, r in ((0.45, 0.45, 0.28), (0.7, 0.25, 0.18), (0.25, 0.6, 0.15)):
        m.cyl(r, 0.0, r * 0.9, COALC, x, 0.06 + r * 0.45, z, seg=7, vary=0.08)  # coal heaps
    m.box(0.22, 0.14, 0.16, "#5a4a3a", -0.65, 0.15, 0.55, vary=0.04)  # a tub of coal
    m.cyl(0.1, 0.0, 0.06, COALC, -0.65, 0.25, 0.55, seg=6, vary=0.1)
    m.pole_flag(-0.8, -0.7, 1.1)
    return m

def steel_mill():
    """Long brick sheds, two tall chimneys, a glowing furnace mouth."""
    m = Model("SteelMill")
    foundation(m, 3, col="#6a6258")
    m.box(2.2, 0.85, 1.2, "#7a3a2a", 0.1, 0.48, 0.2, vary=0.03)
    m.roof(2.2, 1.2, 0.35, "#3e4146", 0.1, 0.9, 0.2, rows=6, row_col="#33363a")
    for x in (-0.6, 0.1, 0.8):
        m.box(0.4, 0.5, 0.03, "#2a221a", x, 0.33, 0.815, vary=0)  # big doors
    m.box(0.3, 0.2, 0.04, "#ff7a2a", 0.1, 0.25, 0.83, vary=0)       # the furnace glow
    for x, h in ((-0.9, 2.3), (-0.45, 2.0)):
        m.cyl(0.13, 0.11, h, "#7a3424", x, h / 2 + 0.06, -0.8, seg=10, vary=0.03)  # chimneys
        m.cyl(0.14, 0.14, 0.06, STONE2, x, h + 0.06, -0.8, seg=10, vary=0)
    m.cyl(0.32, 0.28, 0.9, "#5b5148", 0.95, 0.5, -0.7, seg=12, vary=0.03)  # blast furnace
    m.cyl(0.2, 0.2, 0.12, "#3e4146", 0.95, 1.0, -0.7, seg=12, vary=0)
    for x in (0.3, 0.5, 0.7):
        m.box(0.16, 0.06, 0.5, STEEL, x - 1.4, 0.09, 1.1, vary=0.03)  # steel billets
    m.pole_flag(1.3, 1.25, 1.2)
    return m

def explosives_works():
    """Low bunkers behind an earth bank, red warning flags."""
    m = Model("ExplosivesWorks")
    foundation(m, 2)
    for x in (-0.35, 0.4):
        m.box(0.6, 0.38, 0.5, STONE2, x, 0.25, -0.3, vary=0.04)
        m.box(0.66, 0.06, 0.56, "#5b5e52", x, 0.47, -0.3, vary=0)
        m.box(0.18, 0.28, 0.03, "#2a221a", x, 0.2, -0.04, vary=0)
        m.box(0.12, 0.12, 0.02, "#c8453a", x + 0.18, 0.32, -0.035, vary=0)
    m.box(1.6, 0.18, 0.14, "#7a6a4a", 0, 0.12, 0.5, vary=0.05)  # an earth bank
    for x, z in ((-0.6, 0.25), (-0.4, 0.25)):
        barrel(m, x, z, r=0.07, h=0.15)
    for k in range(3):
        m.box(0.16, 0.1, 0.12, "#4a5a3a", 0.35 + k * 0.17, 0.11, 0.25, vary=0.04)  # crates of shells
    m.box(0.02, 0.6, 0.02, DARKWOOD, 0.75, 0.36, 0.7, vary=0)
    m.flag(0.2, 0.13, "#c8453a", 0.86, 0.6, 0.7)
    m.pole_flag(-0.8, 0.7, 1.0)
    return m


def coal_yard():
    m = Model("CoalYard")
    foundation(m, 2)
    m.box(0.6, 0.45, 0.5, "#9a8a6a", -0.45, 0.28, -0.45, vary=0.03)  # the office
    m.roof(0.6, 0.5, 0.22, "#3a3a3a", -0.45, 0.5, -0.45)
    door(m, -0.45, -0.19, w=0.18, h=0.3, y=0.06)
    for x, z, r in ((0.35, -0.3, 0.32), (0.45, 0.35, 0.26), (-0.2, 0.45, 0.2)):
        m.cyl(r, 0.0, r * 0.85, COALC, x, 0.06 + r * 0.42, z, seg=7, vary=0.08)
    for x in (-0.65, -0.5):
        sack(m, x, 0.6, s=0.9)
    m.box(0.3, 0.12, 0.2, "#5a4a3a", 0.0, 0.12, 0.0, vary=0.04)  # a cart
    for z in (-0.12, 0.12):
        m.cyl(0.06, 0.06, 0.02, DARKWOOD, 0.0, 0.07, z, seg=8, rx=math.pi / 2, vary=0)
    m.box(0.16, 0.2, 0.03, TEAM, -0.45, 0.62, -0.19, vary=0)
    m.pole_flag(0.8, -0.7, 1.0)
    return m


def factory():
    """A works with a sawtooth roof and a tall chimney; a field gun outside."""
    m = Model("Factory")
    foundation(m, 3, col="#6a6258")
    m.box(2.3, 0.9, 1.6, "#8a4a36", 0, 0.51, 0, vary=0.03)
    for k in range(5):  # the sawtooth roof: glass on the steep faces
        x = -0.92 + k * 0.46
        m.box(0.46, 0.04, 1.62, "#4a4c52", x, 1.06, 0, rz=0.5, vary=0)
        m.box(0.03, 0.24, 1.62, "#a9c6d6", x + 0.21, 1.08, 0, vary=0)
    for x in (-0.6, 0.6):
        m.box(0.6, 0.55, 0.03, "#3e4146", x, 0.34, 0.815, vary=0)  # sliding doors
    m.cyl(0.16, 0.13, 2.2, "#7a3424", 1.0, 1.16, -0.9, seg=10, vary=0.03)  # chimney: smoke comes out at the top
    m.cyl(0.17, 0.17, 0.06, STONE2, 1.0, 2.26, -0.9, seg=10, vary=0)
    for k in range(3):
        m.cyl(0.09, 0.09, 0.5, STEEL, -1.2 + k * 0.0, 0.1 + k * 0.17, 1.15, seg=8, rz=math.pi / 2, vary=0.03)  # gun barrels waiting
    m.pole_flag(1.3, 1.25, 1.2)
    return m

def coal_seam():
    """A coal deposit: one big black boulder breaking through the turf."""
    m = Model("CoalSeam")
    m.boulder(0.44, COALC, 0, 0, 0, flat=0.6, sx=1.05, sz=0.95, vary=0.1)
    return m


# --- Modern -------------------------------------------------------------------------------
OLIVE, OLIVE2, CONCRETE, GLASS = "#5f6a44", "#4d5737", "#b9b5aa", "#9fc3d6"


def tank():
    """A tank: hull, tracks, a turret with its gun (the tool: it kicks when it
    fires). No skeleton."""
    m = Model("Tank")
    for z in (-0.2, 0.2):
        m.box(0.72, 0.16, 0.12, "#2e2f2a", 0, 0.1, z, bevel=0.03, vary=0)   # tracks
        for k in range(5):
            m.cyl(0.055, 0.055, 0.125, "#4a4c42", -0.26 + k * 0.13, 0.08, z, seg=10, rx=math.pi / 2, vary=0)
    m.box(0.66, 0.16, 0.34, OLIVE, 0, 0.24, 0, bevel=0.02, vary=0.02)      # hull
    m.box(0.2, 0.08, 0.34, OLIVE2, 0.3, 0.2, 0, rz=0.4, vary=0)            # glacis
    m.box(0.12, 0.08, 0.1, "#3a3a2a", -0.28, 0.35, 0.1, vary=0)            # engine deck box
    m.box(0.18, 0.03, 0.16, TEAM, -0.2, 0.325, -0.06, vary=0)              # team marking
    m.cyl(0.17, 0.15, 0.12, OLIVE, -0.02, 0.38, 0, seg=12, vary=0.02)      # turret ring and turret
    m.cyl(0.07, 0.07, 0.04, OLIVE2, -0.06, 0.46, 0.06, seg=10, vary=0)     # hatch
    m.box(0.02, 0.18, 0.02, "#2a2c30", -0.12, 0.52, -0.08, vary=0)         # aerial
    t = Model("Tank.tool")  # the gun, pointing forward from the turret
    t.cyl(0.03, 0.025, 0.42, "#3e4146", 0.24, 0.0, 0, seg=8, rz=-math.pi / 2, vary=0)
    t.box(0.12, 0.08, 0.1, OLIVE2, 0.06, 0.0, 0, vary=0)                   # mantlet
    t.cyl(0.035, 0.035, 0.05, "#2a2c30", 0.44, 0.0, 0, seg=8, rz=-math.pi / 2, vary=0)
    return dict(body=m, tool=t, tool_at=(0.05, 0.38, 0.0), tool_bone="body", pivots={})

def fighter():
    """A single-engine fighter, nose +x. The propeller is its tool (the game
    spins it). No skeleton: the game flies it high above the ground."""
    m = Model("Fighter")
    m.smooth = True
    sphere(m, 0.07, "#8a9098", 0.0, 0.0, 0, sx=4.2, sy=1.0, sz=1.0)        # fuselage
    m.smooth = False
    m.box(0.18, 0.02, 0.78, "#8a9098", 0.04, -0.02, 0, taper=None, vary=0) # wings
    for z in (-0.3, 0.3):
        m.cyl(0.05, 0.05, 0.022, TEAM, 0.04, -0.005, z, seg=12, vary=0)    # roundels
        m.cyl(0.025, 0.025, 0.024, CLOTH, 0.04, -0.004, z, seg=10, vary=0)
    m.box(0.08, 0.015, 0.28, "#8a9098", -0.26, 0.01, 0, vary=0)            # tailplane
    m.box(0.09, 0.1, 0.015, TEAM, -0.27, 0.07, 0, vary=0)                  # fin, team coloured
    sphere(m, 0.045, GLASS, 0.06, 0.05, 0, sx=1.8, sy=0.9, sz=0.9, vary=0) # canopy
    m.cyl(0.045, 0.04, 0.05, "#3e4146", 0.29, 0.0, 0, seg=10, rz=-math.pi / 2, vary=0)  # cowling
    t = Model("Fighter.tool")  # the propeller: three blades and a spinner
    t.cyl(0.025, 0.0, 0.05, "#c8453a", 0.02, 0.0, 0, seg=8, rz=-math.pi / 2, vary=0)
    for k in range(3):
        a = k * 2 * math.pi / 3
        t.box(0.01, 0.13, 0.025, "#2a2c30", 0.0, math.cos(a) * 0.065, math.sin(a) * 0.065, rx=-a, vary=0)
    return dict(body=m, tool=t, tool_at=(0.32, 0.0, 0.0), tool_bone="body", pivots={})

def bomber():
    """A twin-engine bomber, nose +x. Its tool is the glazed nose (round, so
    the game's spin doesn't show); the propellers are drawn as discs."""
    m = Model("Bomber")
    m.smooth = True
    sphere(m, 0.095, "#6e7660", 0.0, 0.0, 0, sx=4.4, sy=1.0, sz=1.0)
    m.smooth = False
    m.box(0.24, 0.025, 1.2, "#6e7660", 0.03, 0.0, 0, vary=0)               # wings
    for z in (-0.28, 0.28):
        m.cyl(0.05, 0.045, 0.26, "#5b624e", 0.1, 0.0, z, seg=10, rz=-math.pi / 2, vary=0)  # engines
        m.cyl(0.09, 0.09, 0.006, "#c9ced5", 0.24, 0.0, z, seg=14, rz=-math.pi / 2, vary=0)  # prop discs
        m.cyl(0.055, 0.055, 0.027, TEAM, 0.0, 0.006, z * 1.6, seg=12, vary=0)  # roundels
        m.cyl(0.028, 0.028, 0.029, CLOTH, 0.0, 0.007, z * 1.6, seg=10, vary=0)
    m.box(0.1, 0.02, 0.4, "#6e7660", -0.36, 0.02, 0, vary=0)               # tailplane
    for z in (-0.17, 0.17):
        m.box(0.1, 0.13, 0.015, TEAM, -0.37, 0.08, z, vary=0)              # twin fins
    sphere(m, 0.05, GLASS, 0.18, 0.07, 0, sx=1.6, sy=0.8, sz=0.9, vary=0)  # cockpit
    m.box(0.12, 0.02, 0.1, "#2e2f2a", 0.0, -0.09, 0, vary=0)               # bomb bay doors
    t = Model("Bomber.tool")
    t.ball(0.07, GLASS, 0.0, 0.0, 0, sub=2, sx=1.1, vary=0)
    return dict(body=m, tool=t, tool_at=(0.4, 0.0, 0.0), tool_bone="body", pivots={})

def apartment():
    """A Modern home: a concrete block of flats, balconies, a flat roof."""
    m = Model("Apartment")
    foundation(m, 2, col=CONCRETE)
    m.box(1.4, 2.5, 1.2, "#d6d0c2", 0, 1.31, 0, vary=0.02)
    for k in range(5):
        y = 0.35 + k * 0.48
        for x in (-0.45, 0.0, 0.45):
            m.box(0.22, 0.24, 0.03, "#5d7a8c", x, y, 0.605, vary=0.05)       # windows
            m.box(0.3, 0.03, 0.12, CONCRETE, x, y - 0.14, 0.66, vary=0)      # balconies
            m.box(0.3, 0.08, 0.01, TEAM if (k + int(x * 10)) % 3 == 0 else "#8a8478", x, y - 0.1, 0.72, vary=0)
        for z in (-0.3, 0.3):
            m.box(0.03, 0.24, 0.22, "#5d7a8c", 0.705, y, z, vary=0.05)
    m.box(1.44, 0.08, 1.24, "#9a958a", 0, 2.6, 0, vary=0)                  # roof edge
    m.box(0.3, 0.25, 0.3, "#9a958a", 0.3, 2.75, -0.2, vary=0)              # lift housing
    m.cyl(0.015, 0.015, 0.4, "#3e4146", -0.4, 2.85, 0.2, seg=5, vary=0)    # aerial for the radios
    m.box(0.22, 0.015, 0.015, "#3e4146", -0.4, 2.98, 0.2, vary=0)
    door(m, 0, 0.605, w=0.3, h=0.36, y=0.06)
    m.pole_flag(0.8, 0.75, 0.9)
    return m

def oil_well():
    """A pumpjack nodding over the oil, and a storage tank."""
    m = Model("OilWell")
    foundation(m, 2, col="#5a5248")
    m.box(0.5, 0.06, 0.25, "#2e2f2a", -0.2, 0.09, 0.2, vary=0)             # base skid
    for z in (0.12, 0.28):
        m.box(0.05, 0.6, 0.05, "#3e4146", -0.2, 0.4, z, rx=(0.15 if z > 0.2 else -0.15), vary=0)  # A-frame
    m.box(0.85, 0.07, 0.07, "#c8453a", -0.15, 0.72, 0.2, rz=0.15, vary=0)  # walking beam
    m.box(0.12, 0.2, 0.1, "#c8453a", 0.28, 0.66, 0.2, rz=0.15, vary=0)     # horse head
    m.box(0.02, 0.6, 0.02, "#2a2c30", 0.33, 0.34, 0.2, vary=0)             # polished rod
    m.box(0.16, 0.16, 0.1, "#2e2f2a", -0.55, 0.42, 0.2, vary=0)            # counterweight
    m.cyl(0.32, 0.32, 0.55, "#c9ced5", 0.4, 0.33, -0.45, seg=14, vary=0.02)  # storage tank
    m.cyl(0.33, 0.33, 0.04, "#8a939e", 0.4, 0.62, -0.45, seg=14, vary=0)
    m.box(0.3, 0.08, 0.02, TEAM, 0.4, 0.38, -0.12, vary=0)
    m.cyl(0.04, 0.04, 0.6, "#3e4146", -0.25, 0.08, -0.45, seg=6, rz=math.pi / 2, vary=0)  # pipe
    m.pole_flag(-0.8, -0.7, 1.1)
    return m

def bauxite_mine():
    """An open pit of red-brown earth with a conveyor and a small smelter."""
    m = Model("BauxiteMine")
    foundation(m, 2, col="#7a5a46")
    m.cyl(0.6, 0.45, 0.06, "#8a4a32", -0.2, 0.08, 0.15, seg=12, vary=0.04)  # the pit
    m.cyl(0.42, 0.3, 0.05, "#6e3a28", -0.2, 0.1, 0.15, seg=12, vary=0.04)
    for x, z, r in ((0.55, 0.55, 0.18), (0.68, 0.3, 0.12)):
        m.cyl(r, 0.0, r, "#b86a4a", x, 0.06 + r * 0.5, z, seg=7, vary=0.08)
    m.box(0.9, 0.04, 0.1, "#3e4146", 0.2, 0.35, -0.3, rz=0.35, vary=0)      # conveyor
    for x in (-0.15, 0.55):
        m.box(0.03, 0.4, 0.03, "#3e4146", x, 0.2, -0.3, vary=0)
    m.box(0.45, 0.5, 0.4, "#9a958a", 0.55, 0.31, -0.55, vary=0.03)          # smelter
    m.cyl(0.07, 0.06, 0.6, "#7a7468", 0.68, 0.85, -0.62, seg=8, vary=0)
    m.box(0.25, 0.04, 0.15, "#d7dde4", 0.2, 0.08, 0.7, vary=0)              # aluminum ingots
    m.box(0.25, 0.04, 0.15, "#c9ced5", 0.2, 0.12, 0.7, vary=0)
    m.pole_flag(-0.8, -0.7, 1.1)
    return m


def haber_bosch():
    """A chemical works: tall reactor columns, pipes and spherical tanks."""
    m = Model("HaberBosch")
    foundation(m, 2, col=CONCRETE)
    for x, h in ((-0.45, 1.3), (-0.15, 1.0)):
        m.cyl(0.13, 0.13, h, "#c9ced5", x, h / 2 + 0.06, -0.35, seg=12, vary=0.02)
        m.cyl(0.14, 0.14, 0.04, "#8a939e", x, h + 0.06, -0.35, seg=12, vary=0)
    m.ball(0.22, "#d7dde4", 0.4, 0.32, 0.35, sub=2, vary=0)                 # spherical tank
    for sx in (-1, 1):
        for sz in (-1, 1):
            m.box(0.025, 0.2, 0.025, "#3e4146", 0.4 + sx * 0.13, 0.12, 0.35 + sz * 0.13, vary=0)
    m.box(0.5, 0.4, 0.4, "#a8a294", 0.35, 0.26, -0.4, vary=0.02)           # control house
    for y in (0.5, 0.75):
        m.cyl(0.025, 0.025, 0.9, "#8a6a4a", -0.1, y, 0.0, seg=6, rz=math.pi / 2, vary=0)  # pipes
    m.cyl(0.025, 0.025, 0.6, "#c8453a", -0.45, 0.3, 0.2, seg=6, vary=0)
    m.box(0.3, 0.12, 0.03, TEAM, 0.35, 0.36, -0.19, vary=0)
    m.pole_flag(-0.8, 0.7, 1.0)
    return m


def tank_works():
    """A big assembly hall with a gantry crane and a tank rolling out."""
    m = Model("TankWorks")
    foundation(m, 3, col=CONCRETE)
    m.box(2.3, 1.0, 1.4, "#8a8a7c", 0, 0.56, -0.3, vary=0.02)
    m.box(2.32, 0.08, 1.42, "#5b5e52", 0, 1.1, -0.3, vary=0)
    for k in range(4):
        m.box(0.5, 0.05, 1.42, "#6e7066", -0.86 + k * 0.57, 1.18, -0.3, rx=0.0, vary=0)
    m.box(0.9, 0.75, 0.03, "#3e4146", -0.4, 0.44, 0.415, vary=0)           # the big door
    m.box(0.6, 0.18, 0.03, TEAM, 0.65, 0.85, 0.415, vary=0)
    for x in (0.55, 1.05):  # an outdoor gantry crane
        m.box(0.05, 0.9, 0.05, "#c8a23a", x, 0.5, 0.8, vary=0)
    m.box(0.6, 0.06, 0.06, "#c8a23a", 0.8, 0.95, 0.8, vary=0)
    m.box(0.012, 0.3, 0.012, "#2a2c30", 0.8, 0.78, 0.8, vary=0)
    m.box(0.5, 0.12, 0.3, OLIVE, -0.4, 0.13, 0.85, bevel=0.02, vary=0)    # a hull outside
    m.pole_flag(-1.35, 1.25, 1.2)
    return m

def airfield():
    """A runway, a hangar with an arched roof, a control tower, a windsock."""
    m = Model("Airfield")
    m.box(3.85, 0.5, 3.85, "#6f6553", 0, -0.2, 0, vary=0.02)
    m.box(3.8, 0.06, 3.8, "#7a9a44", 0, 0.03, 0, vary=0.03)
    m.box(3.7, 0.03, 0.9, "#4a4a48", 0, 0.07, 1.1, vary=0.01)            # the runway
    for k in range(7):
        m.box(0.3, 0.01, 0.06, CLOTH, -1.5 + k * 0.5, 0.09, 1.1, vary=0)
    for k in range(9):  # the hangar: an arch of ribs
        a = k / 8 * math.pi
        m.box(1.6, 0.06, 0.32, "#8a939e", -0.6 + 0.0, 0.07 + math.sin(a) * 0.65, -0.8 + math.cos(a) * 0.75, rx=a - math.pi / 2, vary=0.02)
    m.box(1.6, 0.6, 0.03, "#3e4146", -0.6, 0.35, -0.8 + 0.76, vary=0)    # its door (open, dark)
    m.box(0.3, 0.9, 0.3, CONCRETE, 1.4, 0.5, -1.2, vary=0.02)            # control tower
    m.box(0.42, 0.25, 0.42, GLASS, 1.4, 1.07, -1.2, vary=0)
    m.box(0.46, 0.04, 0.46, "#5b5e52", 1.4, 1.21, -1.2, vary=0)
    m.box(0.02, 0.5, 0.02, "#3e4146", 1.6, 0.3, 0.3, vary=0)             # windsock
    m.cyl(0.05, 0.02, 0.22, "#e8742c", 1.7, 0.52, 0.3, seg=8, rz=math.pi / 2, vary=0)
    m.box(0.5, 0.12, 0.03, TEAM, -0.6, 0.95, -0.03, vary=0)
    m.pole_flag(-1.75, -1.75, 1.2)
    return m

def oil_field():
    """An oil deposit: a black seep in a sandy hollow."""
    m = Model("OilField")
    m.cyl(0.42, 0.38, 0.04, "#a8946a", 0, 0.02, 0, seg=10, vary=0.04)
    m.cyl(0.28, 0.26, 0.03, "#121214", 0.02, 0.045, -0.02, seg=10, vary=0.02)
    m.cyl(0.12, 0.12, 0.032, "#2a2a30", -0.06, 0.047, 0.05, seg=8, vary=0)  # a sheen
    for x, z in ((0.3, 0.2), (-0.25, -0.25)):
        m.rock(0.08, "#8a7a5a", x, 0, z, vary=0.06)
    return m

def bauxite():
    """Bauxite: one big red-brown, earthy boulder."""
    m = Model("Bauxite")
    m.boulder(0.44, "#b0603e", 0, 0, 0, flat=0.62, sx=1.05, sz=0.95, flecks=("#8e4a30", 0.15), vary=0.08)
    return m


# --- Atomic -------------------------------------------------------------------------------
URANIUM_GREEN = "#9ed14a"

def rocket_artillery():
    """A truck carrying a rack of rockets. The rack is its tool (it kicks
    when it fires); no skeleton."""
    m = Model("RocketArtillery")
    for x in (-0.25, 0.0, 0.3):
        for z in (-0.17, 0.17):
            m.cyl(0.08, 0.08, 0.06, "#1e1e22", x, 0.08, z, seg=10, rx=math.pi / 2, vary=0)
    m.box(0.8, 0.08, 0.3, "#3a3d30", 0.0, 0.17, 0, vary=0)                # chassis
    m.box(0.22, 0.22, 0.3, OLIVE, 0.3, 0.3, 0, bevel=0.02, vary=0)        # cab
    m.box(0.02, 0.1, 0.24, GLASS, 0.41, 0.34, 0, vary=0)
    m.box(0.12, 0.04, 0.14, TEAM, 0.3, 0.42, 0, vary=0)
    m.box(0.45, 0.06, 0.3, OLIVE2, -0.15, 0.24, 0, vary=0)                # bed
    t = Model("RocketArtillery.tool")  # the launcher: a box of rocket tubes, raised
    t.box(0.5, 0.16, 0.26, OLIVE2, 0.12, 0.0, 0, rz=0.4, vary=0)
    for r in range(2):
        for c in range(4):
            t.cyl(0.025, 0.025, 0.02, "#1e1e22", 0.355, 0.1 - r * 0.06 + 0.0, -0.09 + c * 0.06, seg=6, rz=-math.pi / 2 + 0.4, vary=0)
    return dict(body=m, tool=t, tool_at=(-0.2, 0.3, 0.0), tool_bone="body", pivots={})

def jet():
    """A swept-wing jet fighter, nose +x. Its tool is the round intake cone,
    so the game's spin doesn't show. No skeleton."""
    m = Model("Jet")
    m.smooth = True
    sphere(m, 0.07, "#9aa1aa", 0.0, 0.0, 0, sx=5.0, sy=0.9, sz=1.0)
    m.smooth = False
    for z in (-1, 1):
        m.box(0.3, 0.02, 0.36, "#9aa1aa", -0.05, -0.01, z * 0.2, ry=z * 0.6, vary=0)   # swept wings
        m.box(0.1, 0.015, 0.14, "#9aa1aa", -0.3, 0.01, z * 0.08, ry=z * 0.6, vary=0)    # tailplanes
        m.cyl(0.045, 0.045, 0.02, TEAM, -0.08, 0.005, z * 0.25, seg=12, vary=0)
    m.box(0.16, 0.14, 0.015, TEAM, -0.3, 0.09, 0, rz=0.4, vary=0)          # fin
    sphere(m, 0.04, GLASS, 0.14, 0.05, 0, sx=2.2, sy=0.9, sz=0.9, vary=0)  # canopy
    m.cyl(0.05, 0.05, 0.04, "#2a2c30", -0.36, 0.0, 0, seg=10, rz=-math.pi / 2, vary=0)  # exhaust
    t = Model("Jet.tool")
    t.cyl(0.05, 0.0, 0.1, "#3e4146", 0.02, 0.0, 0, seg=10, rz=-math.pi / 2, vary=0)
    return dict(body=m, tool=t, tool_at=(0.34, 0.0, 0.0), tool_bone="body", pivots={})

def tower_block():
    """An Atomic-era home: a high-rise of concrete and glass."""
    m = Model("TowerBlock")
    foundation(m, 2, col=CONCRETE)
    m.box(1.2, 3.4, 1.1, "#c9c4b8", 0, 1.76, 0, vary=0.02)
    for k in range(8):
        y = 0.35 + k * 0.41
        m.box(1.22, 0.24, 1.12, "#6d8fa6", 0, y, 0, vary=0.03)              # bands of windows
    for x in (-0.6, 0.6):
        for z in (-0.55, 0.55):
            m.box(0.1, 3.4, 0.1, "#b9b5aa", x, 1.76, z, vary=0)             # corners
    m.box(1.26, 0.1, 1.16, "#8a8478", 0, 3.5, 0, vary=0)
    m.box(0.36, 0.3, 0.36, "#8a8478", -0.25, 3.7, 0.15, vary=0)            # lift housing
    m.box(0.14, 0.35, 0.14, "#8a8478", 0.35, 3.7, -0.25, vary=0)           # chimney: smoke comes out at the top
    m.cyl(0.012, 0.012, 0.45, "#3e4146", 0.2, 3.8, 0.3, seg=5, vary=0)     # TV aerial
    for a in range(3):
        m.box(0.2, 0.012, 0.012, "#3e4146", 0.2, 3.9 + a * 0.08, 0.3, ry=a * 0.5, vary=0)
    door(m, 0, 0.555, w=0.36, h=0.36, y=0.06)
    m.box(0.5, 0.15, 0.03, TEAM, 0, 0.55, 0.57, vary=0)
    m.pole_flag(0.8, 0.75, 0.9)
    return m

def uranium_mine():
    m = Model("UraniumMine")
    foundation(m, 2, col="#6a6258")
    m.box(0.7, 0.45, 0.6, "#a8a294", -0.3, 0.29, -0.3, vary=0.03)           # sealed building
    m.box(0.72, 0.06, 0.62, "#5b5e52", -0.3, 0.54, -0.3, vary=0)
    m.box(0.3, 0.3, 0.03, "#2a2c30", -0.3, 0.23, 0.01, vary=0)
    m.cyl(0.08, 0.08, 0.02, "#f4c542", -0.3, 0.45, 0.02, seg=10, rx=math.pi / 2, vary=0)  # warning sign
    m.cyl(0.03, 0.03, 0.022, "#1e1e22", -0.3, 0.45, 0.025, seg=8, rx=math.pi / 2, vary=0)
    for x in (0.5, 0.7):
        for z in (0.4, 0.6):
            m.cyl(0.08, 0.08, 0.2, "#f4c542", x, 0.16, z, seg=10, vary=0)     # yellow drums
            m.cyl(0.081, 0.081, 0.02, "#1e1e22", x, 0.2, z, seg=10, vary=0)
    for x, z, r in ((0.45, -0.45, 0.2), (0.7, -0.25, 0.14)):
        m.rock(r, "#5b5a3a", x, 0.05, z, flat=0.6, vary=0.08)
    m.ball(0.04, URANIUM_GREEN, 0.5, 0.2, -0.4, sub=1, vary=0)
    for k in range(3):
        m.box(0.03, 0.03, 0.9, "#3e4146", -0.75 + k * 0.25, 0.08, 0.5, vary=0)  # fence posts / rails
    m.pole_flag(-0.8, 0.7, 1.1)
    return m

def reactor():
    """A nuclear power station: a domed containment and a cooling tower."""
    m = Model("Reactor")
    foundation(m, 3, col=CONCRETE)
    m.cyl(0.55, 0.55, 0.8, "#d6d0c2", -0.5, 0.46, 0.2, seg=20, vary=0.01)    # containment
    sphere(m, 0.55, "#d6d0c2", -0.5, 0.86, 0.2, sy=0.75, seg=20, rings=10, vary=0)
    m.box(0.8, 0.5, 0.6, "#a8a294", 0.35, 0.31, 0.6, vary=0.02)               # turbine hall
    m.cyl(0.5, 0.38, 1.6, "#c9c4b8", 0.7, 0.86, -0.6, seg=18, vary=0.02)      # cooling tower
    m.cyl(0.39, 0.44, 0.3, "#c9c4b8", 0.7, 1.8, -0.6, seg=18, vary=0.02)
    m.box(0.3, 0.12, 0.03, TEAM, 0.35, 0.45, 0.91, vary=0)
    for k in range(3):
        m.box(0.03, 0.6, 0.03, "#3e4146", -1.25, 0.36, -0.7 + k * 0.6, vary=0)
        m.box(0.2, 0.02, 0.02, "#3e4146", -1.25, 0.64, -0.7 + k * 0.6, vary=0)
    m.pole_flag(1.3, 1.25, 1.1)
    return m

def car_plant():
    m = Model("CarPlant")
    foundation(m, 2, col=CONCRETE)
    m.box(1.3, 0.75, 0.9, "#b9b5aa", 0, 0.44, -0.2, vary=0.02)
    for k in range(3):
        m.box(0.44, 0.04, 0.92, "#6e7066", -0.44 + k * 0.44, 0.86, -0.2, rz=0.4, vary=0)  # sawtooth
        m.box(0.02, 0.18, 0.92, GLASS, -0.24 + k * 0.44, 0.88, -0.2, vary=0)
    m.box(0.6, 0.45, 0.03, "#3e4146", -0.2, 0.3, 0.255, vary=0)                # door
    for k, col in enumerate(("#c8453a", "#4f7aa8", "#e8c45a")):               # new cars outside
        x = -0.55 + k * 0.42
        m.box(0.3, 0.08, 0.15, col, x, 0.13, 0.65, bevel=0.02, vary=0)
        m.box(0.16, 0.07, 0.13, col, x - 0.02, 0.2, 0.65, vary=0)
        m.box(0.12, 0.05, 0.135, GLASS, x - 0.02, 0.21, 0.65, vary=0)
        for dx in (-0.09, 0.09):
            for z in (-0.075, 0.075):
                m.cyl(0.035, 0.035, 0.02, "#1e1e22", x + dx, 0.08, 0.65 + z, seg=8, rx=math.pi / 2, vary=0)
    m.pole_flag(0.8, -0.7, 1.0)
    return m


def missile_silo():
    """A concrete pad with blast doors, the nose of a missile showing, a
    bunker and a radar dish."""
    m = Model("MissileSilo")
    foundation(m, 3, col=CONCRETE)
    m.cyl(0.7, 0.75, 0.15, "#9a958a", -0.3, 0.12, 0.1, seg=20, vary=0.01)     # the silo collar
    for z in (-1, 1):
        m.box(0.62, 0.05, 0.6, "#5b5e52", -0.3, 0.22, 0.1 + z * 0.3, vary=0)    # blast doors, ajar
    m.cyl(0.16, 0.0, 0.35, "#d8dde3", -0.3, 0.36, 0.1, seg=12, vary=0)        # the missile's nose
    m.box(0.02, 0.4, 0.4, "#f4c542", 0.45, 0.06, 0.1, vary=0)                 # hazard stripes
    m.box(0.6, 0.35, 0.5, "#8a8a7c", 0.75, 0.24, -0.75, vary=0.02)            # bunker
    m.box(0.62, 0.05, 0.52, "#5b5e52", 0.75, 0.43, -0.75, vary=0)
    m.box(0.03, 0.4, 0.03, "#3e4146", 0.9, 0.65, 0.8, vary=0)                 # radar mast
    sphere(m, 0.22, "#c9ced5", 0.9, 0.9, 0.8, sx=0.3, sy=1.0, sz=1.0, vary=0)
    m.box(0.3, 0.12, 0.03, TEAM, 0.75, 0.3, -0.49, vary=0)
    m.pole_flag(-1.3, -1.2, 1.2)
    return m

def uranium_ore():
    """Uranium ore: one dark boulder with sickly green-yellow flecks."""
    m = Model("UraniumOre")
    m.boulder(0.44, "#4a4a38", 0, 0, 0, flat=0.66, flecks=(URANIUM_GREEN, 0.08))
    return m


# --- October 2026: the basics in bulk, and air defense -------------------------
# Each new model draws from its own seeded generator, so adding them doesn't
# shift the random wobble of every model made after them.
def own_seed(seed):
    def wrap(mk):
        def run():
            state = random.getstate()
            random.seed(seed)
            try:
                return mk()
            finally:
                random.setstate(state)
        run.__name__ = mk.__name__
        return run
    return wrap

@own_seed(114)
def lumber_mill():
    """A big timber mill (3x3): a long hall, a water wheel turning the saws,
    a log pond and stacks of sawn planks."""
    m = Model("Lumbermill")
    foundation(m, 3)
    timber_hall(m, 1.9, 0.75, 1.1, "#b49064", "#6b4d2d", "#5c4126", rows=5, windows=2, roof_h=0.5)
    # the water wheel on the side, in a little channel
    m.box(0.25, 0.08, 1.2, "#4f7f9a", 1.12, 0.05, 0.0, vary=0.02)
    m.cyl(0.42, 0.42, 0.14, "#6b4d2d", 1.1, 0.48, 0.0, seg=16, rx=math.pi / 2, vary=0.02)
    for k in range(8):
        a = k * math.pi / 4
        m.box(0.06, 0.18, 0.16, WOOD, 1.1 + math.cos(a) * 0.4, 0.48 + math.sin(a) * 0.4, 0.0, rz=a, vary=0.04)
    m.cyl(0.06, 0.06, 0.3, IRON, 1.0, 0.48, 0.0, seg=8, rx=math.pi / 2, vary=0)
    # logs waiting, and sawn planks in stacks
    for i in range(4):
        m.cyl(0.09, 0.09, 0.9, "#8c6238", -0.55 + i * 0.2, 0.1, 0.95, seg=8, rz=math.pi / 2, ry=math.pi / 2, vary=0.06)
    for k in range(4):
        for j in range(2):
            m.box(0.7, 0.05, 0.14, "#d2ab74", -0.75 + j * 0.85, 0.08 + k * 0.06, -1.0, vary=0.05)
    m.cyl(0.24, 0.24, 0.02, IRON, -0.2, 0.55, 0.57, seg=16, rx=math.pi / 2, vary=0)  # the big saw blade
    m.pole_flag(-1.3, 1.2, 1.2)
    return m

@own_seed(115)
def stoneworks():
    """A stone works (3x3): a cutting shed, a big wooden crane, dressed
    blocks in rows and a rubble heap."""
    m = Model("Stoneworks")
    foundation(m, 3, col=STONE)
    timber_hall(m, 1.3, 0.62, 1.0, STONE3, "#6f6a62", "#625d56", rows=4, windows=1, roof_h=0.42)
    m.box(1.3, 0.02, 1.0, "#6f6a62", 0.0, 0.05, 0.0, vary=0)
    # rows of cut blocks
    for i in range(3):
        for j in range(3):
            sz = 0.2 + 0.03 * ((i + j) % 2)
            m.box(sz, sz * 0.75, sz, STONE if (i + j) % 2 else STONE3, 0.65 + i * 0.27, 0.08 + sz * 0.37, 0.55 + j * 0.27, ry=random.random() * 0.3, bevel=0.01, vary=0.05)
    # a rubble heap
    for k in range(6):
        m.rock(0.12 + random.random() * 0.06, STONE2, -0.85 + random.random() * 0.4, 0.06, 0.75 + random.random() * 0.4)
    # the crane: a mast, a jib and a block on the hook
    m.box(0.07, 1.6, 0.07, WOOD, -0.95, 0.8, -0.85, vary=0)
    for a in (0.0, 2.1, 4.2):
        m.box(0.04, 0.9, 0.04, WOOD, -0.95 + math.cos(a) * 0.25, 0.4, -0.85 + math.sin(a) * 0.25, rx=math.sin(a) * 0.28, rz=-math.cos(a) * 0.28, vary=0)
    m.box(1.2, 0.05, 0.05, WOOD, -0.45, 1.55, -0.85, rz=-0.12, vary=0)
    m.cyl(0.008, 0.008, 0.6, "#c9b88f", 0.05, 1.18, -0.85, seg=3, vary=0)
    m.box(0.22, 0.16, 0.22, STONE, 0.05, 0.82, -0.85, bevel=0.01, vary=0.05)
    m.pole_flag(1.3, -1.25, 1.2)
    return m

@own_seed(117)
def kiln():
    """A brick kiln works (3x3): three bottle kilns, a drying shed and
    stacks of brick."""
    m = Model("Kiln")
    foundation(m, 3)
    for x, z, s in ((-0.75, -0.6, 1.0), (0.1, -0.75, 0.85), (0.85, -0.45, 0.9)):
        # a bottle kiln: a wide body narrowing to a chimney
        m.cyl(0.42 * s, 0.38 * s, 0.6 * s, BRICK, x, 0.36 * s, z, seg=16, vary=0.04)
        m.cyl(0.36 * s, 0.14 * s, 0.55 * s, BRICK2, x, 0.93 * s, z, seg=16, vary=0.04)
        m.cyl(0.14 * s, 0.13 * s, 0.35 * s, BRICK, x, 1.37 * s, z, seg=12, vary=0.04)
        m.cyl(0.43 * s, 0.43 * s, 0.03, "#7a3020", x, 0.62 * s, z, seg=16, vary=0)
        m.box(0.16, 0.18, 0.05, "#ff7a2a", x, 0.17, z + 0.4 * s, vary=0)  # the firing mouth
    # the drying shed: an open roof on posts over rows of green brick
    for sx in (-1, 1):
        for sz in (-1, 1):
            m.box(0.05, 0.5, 0.05, WOOD, -0.3 + sx * 0.55, 0.28, 0.75 + sz * 0.3, vary=0)
    m.box(1.3, 0.05, 0.8, THATCH, -0.3, 0.55, 0.75, rx=0.08, vary=0.05)
    for i in range(3):
        for j in range(4):
            m.box(0.18, 0.05, 0.08, CLAY, -0.75 + j * 0.3, 0.1 + i * 0.07, 0.75, vary=0.06)
    for k in range(3):
        for j in range(3):
            m.box(0.22, 0.07, 0.11, BRICK if (j + k) % 2 else BRICK2, 0.75 + j * 0.0, 0.1 + k * 0.075, 0.55 + j * 0.12, vary=0.06)
    m.pole_flag(1.3, 1.25, 1.2)
    return m

@own_seed(116)
def air_defense():
    """A fixed missile battery (2x2), like a Patriot site in an old RTS: an
    octagonal concrete emplacement with a sandbagged rim, a turret ring,
    and a heavy launcher box of four missiles raised to the sky, with a
    radar panel on a mast behind it. Nothing on wheels: it's built to stay."""
    m = Model("AirDefense")
    foundation(m, 2, col=CONCRETE)
    STEEL_D, STEEL_M = "#3e4146", "#5b6066"
    # the emplacement: an octagon of concrete, a lip, and sandbags round it
    m.cyl(0.86, 0.8, 0.16, CONCRETE, 0, 0.17, 0, seg=8, ry=math.pi / 8, vary=0.02)
    m.cyl(0.74, 0.74, 0.03, "#a8a499", 0, 0.26, 0, seg=8, ry=math.pi / 8, vary=0.01)
    for k in range(16):
        a = k / 16 * 2 * math.pi
        if 0.6 < a < 1.0:  # a gap for the crew
            continue
        m.box(0.2, 0.08, 0.1, "#9a8a64", math.cos(a) * 0.8, 0.29 + (k % 2) * 0.02, math.sin(a) * 0.8, ry=-a + math.pi / 2, bevel=0.02, vary=0.08)
    # the turret: a steel ring, a pedestal and two side arms holding the box
    m.cyl(0.38, 0.42, 0.1, STEEL_D, 0, 0.32, 0, seg=16, vary=0.02)
    m.cyl(0.3, 0.3, 0.06, STEEL_M, 0, 0.39, 0, seg=16, vary=0.02)
    m.box(0.34, 0.22, 0.42, OLIVE2, 0.05, 0.52, 0, bevel=0.02, vary=0.02)
    for dz in (-0.27, 0.27):
        m.box(0.3, 0.32, 0.06, OLIVE, 0.0, 0.66, dz, bevel=0.015, vary=0.02)
    # the launcher: a big box tipped up toward -x, four tubes facing the sky
    tilt = 0.75
    ca, sa = math.cos(tilt), math.sin(tilt)
    cx, cy = -0.05, 0.86
    m.box(0.95, 0.42, 0.46, OLIVE, cx, cy, 0, rz=-tilt, bevel=0.03, vary=0.02)
    m.box(0.97, 0.06, 0.48, OLIVE2, cx + 0.02 * sa, cy + 0.02 * ca, 0, rz=-tilt, vary=0)  # a seam round the middle
    # the front face, out along the box's long axis (toward -x, up)
    fx, fy = cx - 0.475 * ca, cy + 0.475 * sa
    m.box(0.03, 0.44, 0.48, "#2f3324", fx, fy, 0, rz=-tilt, vary=0)
    for row in (-1, 1):
        for col in (-1, 1):
            # each tube's mouth, and the white nose of the missile inside
            ox, oy = fx - 0.01 * ca + row * 0.1 * sa, fy - 0.01 * sa + row * 0.1 * ca
            m.box(0.02, 0.17, 0.17, "#1e1f1c", ox, oy, col * 0.11, rz=-tilt, vary=0)
            m.cyl(0.055, 0.0, 0.08, "#eeeae0", ox - 0.03 * ca, oy + 0.03 * sa, col * 0.11, seg=8, rz=math.pi / 2 - tilt, vary=0)
    m.box(0.5, 0.06, 0.47, TEAM, cx + 0.12 * ca, cy - 0.12 * sa + 0.2, 0, rz=-tilt, vary=0)  # team stripe on top
    # the radar: a mast at the back with a flat panel and a little dish
    m.box(0.06, 0.6, 0.06, STEEL_D, 0.55, 0.58, -0.45, vary=0)
    m.box(0.05, 0.38, 0.5, "#4b5232", 0.55, 0.98, -0.45, rz=0.25, bevel=0.01, vary=0)
    m.box(0.02, 0.32, 0.42, "#6d7a50", 0.525, 0.99, -0.45, rz=0.25, vary=0)
    m.cyl(0.03, 0.03, 0.12, STEEL_D, 0.55, 0.32, 0.55, vary=0)
    m.cyl(0.12, 0.03, 0.05, "#c9c6bd", 0.55, 0.42, 0.55, rz=0.5, seg=12, vary=0)
    # a low ammunition locker by the gap
    m.box(0.24, 0.14, 0.16, OLIVE2, 0.45, 0.33, 0.48, bevel=0.01, vary=0.03)
    m.pole_flag(-0.75, 0.75, 0.8)
    return m

# --- November 2026: the animals, redrawn ------------------------------------------
# One horse for everything that has a horse in it: the three riders, the wild
# herds on horse deposits, the stable's yard and the pasture. It is a third
# bigger than the first one was (a rider now sits well above the foot
# soldiers), with a deep chest, a long face, a mane and a tail that hangs.
def placed(m, n0, x=0.0, z=0.0, turn=0.0, k=1.0):
    """Move everything added to m since it had n0 vertices: scaled by k, turned
    about y, then set down at (x, z). For animals standing about in a model."""
    m.bm.verts.ensure_lookup_table()
    M = Matrix.Translation(P(x, 0, z)) @ rot(0, turn, 0) @ Matrix.Scale(k, 4)
    bmesh.ops.transform(m.bm, matrix=M, verts=m.bm.verts[n0:])

def count(m):
    return len(m.bm.verts)

def seg2(m, ra, rb, a, b, col, seg=8):
    """A tapered round bar in the x-y plane from point a (radius ra) to point b (radius rb)."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    m.cyl(ra, rb, math.hypot(dx, dy), col, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0, seg=seg, rz=math.atan2(-dx, dy), vary=0)

def no_bones(m):
    """Animals standing in a building or on a deposit aren't animated: all on bone 0."""
    for v in m.bm.verts:
        v[m.bone] = 0
    m.cur_bone = 0
    return m

HORSE_PIVOTS = {"hips": (0, 0.56, 0), "body": (-0.02, 0.765, 0), "head": (-0.02, 0.925, 0), "armL": (-0.02, 0.905, -0.11), "armR": (-0.02, 0.905, 0.11),
                "legFL": (0.2, 0.46, -0.085), "legFR": (0.2, 0.46, 0.085), "legBL": (-0.24, 0.46, -0.085), "legBR": (-0.24, 0.46, 0.085),
                "neck": (0.27, 0.64, 0), "tail": (-0.4, 0.66, 0)}
RIDER_Y = 0.145   # how much higher a rider sits than on the first horse

def horse(m, coat, dark, hair, sock=None, blaze=None, grazing=False):
    """A horse facing +x, hooves on the ground, 0.75 tall at the back. Its parts
    follow the hips, the four leg bones, the neck and the tail."""
    m.smooth = True
    m.part("hips")
    sphere(m, 0.2, coat, -0.01, 0.57, 0, sx=1.75, sy=0.93, sz=0.82, seg=12, rings=8)   # barrel
    sphere(m, 0.165, coat, 0.21, 0.585, 0, sx=1.0, sy=1.08, sz=0.95)          # chest
    sphere(m, 0.175, coat, -0.23, 0.6, 0, sx=1.0, sy=1.03, sz=0.97)           # rump
    for leg, x, front in (("legFL", 0.2, True), ("legFR", 0.2, True), ("legBL", -0.24, False), ("legBR", -0.24, False)):
        z = -0.085 if leg.endswith("L") else 0.085
        m.part(leg, smooth=True)
        if front:
            sausage(m, 0.052, 0.2, coat, x, 0.46, z)                           # forearm
            sausage(m, 0.033, 0.2, sock or coat, x, 0.26, z)                   # cannon
        else:
            sausage(m, 0.066, 0.2, coat, x, 0.48, z, rz=-0.22)                 # thigh, sloping back
            sausage(m, 0.034, 0.21, sock or coat, x - 0.045, 0.27, z, rz=0.2)  # down and forward to the hoof
        m.smooth = False
        m.cyl(0.05, 0.04, 0.065, hair, x, 0.033, z, seg=8, vary=0)            # hoof
    m.part("neck", smooth=True)
    if grazing:   # head down in the grass
        seg2(m, 0.105, 0.068, (0.25, 0.62), (0.52, 0.4), coat)                 # neck, reaching down
        sphere(m, 0.08, coat, 0.53, 0.4, 0, sx=1.0, sy=1.0, sz=0.85)
        seg2(m, 0.046, 0.076, (0.6, 0.13), (0.535, 0.39), coat)                # the long face, nose to the grass
        sphere(m, 0.052, dark, 0.6, 0.12, 0, sx=1.0, sy=0.95, sz=1.05)
        ear, eye, mane_at = (0.49, 0.45), (0.585, 0.33), (0.42, 0.575, math.atan2(0.27, 0.22) - math.pi)
    else:
        m.cyl(0.105, 0.066, 0.4, coat, 0.37, 0.775, 0, seg=8, rz=-0.57, vary=0)  # neck, arched up and forward
        sphere(m, 0.082, coat, 0.485, 0.925, 0, sx=1.0, sy=1.0, sz=0.85)         # poll and cheek
        m.cyl(0.046, 0.076, 0.3, coat, 0.565, 0.85, 0, seg=8, rz=0.8, vary=0)    # the long face
        sphere(m, 0.052, dark, 0.665, 0.755, 0, sx=1.0, sy=0.95, sz=1.05)        # muzzle
        ear, eye, mane_at = (0.455, 1.0), (0.535, 0.925), (0.3, 0.825, -0.57)
    m.smooth = False
    if blaze and not grazing:
        m.box(0.012, 0.2, 0.035, blaze, 0.6, 0.875, 0, rz=0.8, vary=0)         # a white stripe down the face
    for z in (-1, 1):
        m.cyl(0.024, 0.0, 0.1, coat, ear[0], ear[1] + 0.03, z * 0.045, seg=5, rx=z * 0.25, vary=0)
        sphere(m, 0.014, "#1a1410", eye[0], eye[1], z * 0.064, seg=6, rings=4)
    m.box(0.075, 0.44, 0.045, hair, mane_at[0], mane_at[1], 0, rz=mane_at[2], vary=0)   # mane along the crest
    if not grazing:
        m.box(0.05, 0.09, 0.05, hair, 0.5, 0.985, 0, rz=0.5, vary=0)           # forelock
    m.part("tail", smooth=True)
    seg2(m, 0.04, 0.03, (-0.47, 0.63), (-0.39, 0.67), hair, seg=8)             # dock
    seg2(m, 0.012, 0.042, (-0.52, 0.3), (-0.47, 0.63), hair, seg=8)            # the long hair, hanging
    m.part("hips", smooth=False)

def rider(m, coat, sleeves, hands, legs, boots, breast=None, head=True):
    """The person in the saddle: legs down the horse's sides, torso, arms, head."""
    Y = RIDER_Y
    m.part("hips", smooth=True)
    for z in (-0.16, 0.16):
        sausage(m, 0.038, 0.15, legs, 0.04, 0.6 + Y, z, rx=(0.3 if z > 0 else -0.3))
        sphere(m, 0.044, boots, 0.06, 0.445 + Y, z * 1.3, sx=1.3, sy=0.8)
    m.part("body")
    sphere(m, 0.11, coat, -0.02, 0.69 + Y, 0, sx=0.95, sy=1.15, sz=1.05)
    if breast:
        sphere(m, 0.103, breast, 0.0, 0.715 + Y, 0, sx=0.93, sy=0.75, sz=1.06)
    for side, z in (("armL", -0.11), ("armR", 0.11)):
        m.part(side)
        sausage(m, 0.032, 0.11, sleeves, -0.02, 0.76 + Y, z)
        sphere(m, 0.036, hands, -0.02, 0.64 + Y, z)
    m.part("head")
    if head:
        sphere(m, 0.09, SKIN, -0.02, 0.87 + Y, 0)
        m.smooth = False
        for z in (-0.03, 0.03):
            sphere(m, 0.014, "#1a1410", 0.062, 0.875 + Y, z, seg=6, rings=4)
    m.smooth = False

def horseman():
    """A light rider on a chestnut horse with white socks: iron cap, round shield, a lance."""
    m = Model("Horseman")
    horse(m, "#9a5f33", "#5a3a22", "#2a1e14", sock="#e9e2d2", blaze="#e9e2d2")
    Y = RIDER_Y
    m.box(0.3, 0.035, 0.37, TEAM, -0.02, 0.735, 0, vary=0)                      # saddle cloth
    m.box(0.31, 0.012, 0.38, GOLD, -0.02, 0.718, 0, vary=0)
    m.box(0.05, 0.16, 0.39, TEAM, -0.16, 0.66, 0, vary=0)                       # its ends hanging down the flanks
    rider(m, TEAM, TEAM_DARK, SKIN, "#5a4632", "#2a1e14", breast=IRON)
    m.part("head", smooth=False)
    dome(m, 0.097, IRON, 0.885 + Y, x=-0.02)
    m.box(0.03, 0.05, 0.14, TEAM, -0.03, 0.98 + Y, 0, vary=0)
    m.part("armL", smooth=False)                                                # a round shield on the left arm
    m.cyl(0.11, 0.11, 0.025, TEAM_DARK, -0.01, 0.7 + Y, -0.17, seg=12, rx=math.pi / 2, vary=0)
    m.cyl(0.12, 0.12, 0.015, IRON, -0.01, 0.7 + Y, -0.164, seg=12, rx=math.pi / 2, vary=0)
    m.ball(0.03, GOLD, -0.01, 0.7 + Y, -0.19, sub=1, vary=0)
    t = Model("Horseman.tool")  # a lance with a pennant, couched under the right arm
    t.cyl(0.016, 0.016, 1.0, WOOD, 0.3, 0.05, 0, seg=6, rz=-1.35, vary=0)
    t.cyl(0.032, 0.0, 0.13, IRON, 0.8, 0.165, 0, seg=4, rz=-1.35, vary=0)
    t.flag(0.14, 0.08, TEAM, 0.64, 0.2, 0.0)
    return dict(body=m, tool=t, tool_at=(-0.02, 0.64 + Y, 0.11), tool_bone="armR", pivots=HORSE_PIVOTS)

def knight():
    """A dark war horse under a team caparison down to its knees, an iron face
    plate, and a rider in full armour: great helm, kite shield, a heavy lance."""
    m = Model("Knight")
    horse(m, "#4a3a30", "#2e2420", "#17110d")
    Y = RIDER_Y
    m.part("neck", smooth=False)
    m.cyl(0.05, 0.08, 0.27, IRON, 0.578, 0.868, 0, seg=6, rz=0.8, vary=0)      # chanfron over the face
    m.cyl(0.02, 0.0, 0.09, GOLD, 0.56, 0.96, 0, seg=5, rz=-0.6, vary=0)        # its spike
    m.cyl(0.125, 0.085, 0.3, TEAM, 0.36, 0.76, 0, seg=8, rz=-0.57, vary=0)     # cloth on the neck
    m.cyl(0.128, 0.128, 0.03, GOLD, 0.29, 0.64, 0, seg=8, rz=-0.57, vary=0)
    m.part("hips", smooth=False)
    # The caparison: front and back halves, split at the saddle, gold along the hem.
    for x, w in ((0.19, 0.3), (-0.2, 0.36)):
        m.box(w, 0.4, 0.37, TEAM, x, 0.56, 0, bevel=0.03, vary=0)
        m.box(w + 0.01, 0.035, 0.38, GOLD, x, 0.375, 0, vary=0)
    for x in (0.19, -0.2):
        for z in (-1, 1):
            m.box(0.11, 0.11, 0.012, TEAM_DARK, x, 0.55, z * 0.19, rz=math.pi / 4, vary=0)   # a lozenge on each flank
    m.box(0.2, 0.06, 0.3, "#5a3a24", -0.01, 0.75, 0, vary=0)                   # saddle
    m.box(0.04, 0.12, 0.26, "#5a3a24", -0.12, 0.8, 0, vary=0)                  # its high back
    rider(m, TEAM, "#7d848c", "#5b5f66", "#7d848c", "#5b5f66", breast=IRON, head=False)
    m.part("armL", smooth=False)
    kite_shield(m, 0.0, 0.7 + Y, -0.17)
    m.part("head", smooth=False)
    great_helm(m, 0.89 + Y, x=-0.02)
    t = Model("Knight.tool")  # a heavier lance, couched like the horseman's
    t.cyl(0.022, 0.017, 1.1, "#c9b07a", 0.33, 0.055, 0, seg=6, rz=-1.35, vary=0)
    t.cyl(0.055, 0.02, 0.08, IRON, -0.12, -0.04, 0, seg=8, rz=-1.35, vary=0)   # vamplate
    t.cyl(0.034, 0.0, 0.14, IRON, 0.87, 0.18, 0, seg=4, rz=-1.35, vary=0)
    t.flag(0.16, 0.09, TEAM, 0.7, 0.225, 0.0)
    return dict(body=m, tool=t, tool_at=(-0.02, 0.64 + Y, 0.11), tool_bone="armR", pivots=HORSE_PIVOTS)

def dragoon():
    """A black horse, a rider in a team coat with white cross belts and a tall
    brass helmet with a horsehair plume, a carbine, a rolled cloak behind the saddle."""
    m = Model("Dragoon")
    horse(m, "#33261f", "#1f1713", "#0f0b09", blaze="#e9e2d2")
    Y = RIDER_Y
    m.box(0.42, 0.03, 0.37, TEAM_DARK, -0.04, 0.735, 0, vary=0)               # shabraque: long, pointed at the back
    m.box(0.43, 0.012, 0.38, GOLD, -0.04, 0.72, 0, vary=0)
    m.box(0.16, 0.2, 0.385, TEAM_DARK, -0.2, 0.64, 0, vary=0)
    m.box(0.17, 0.02, 0.39, GOLD, -0.2, 0.54, 0, vary=0)
    m.box(0.2, 0.05, 0.25, "#3a2416", -0.01, 0.76, 0, vary=0)                  # saddle
    m.cyl(0.045, 0.045, 0.3, "#b7b0a0", -0.15, 0.79, 0, seg=8, rx=math.pi / 2, vary=0)  # rolled cloak
    rider(m, TEAM, TEAM, SKIN, "#e8e2d0", "#1a1410")
    m.part("body", smooth=False)
    for z in (-1, 1):
        m.box(0.02, 0.22, 0.03, "#e8e2d0", 0.085, 0.7 + Y, z * 0.03, rx=z * 0.6, vary=0)  # cross belts
    m.part("head", smooth=False)
    dome(m, 0.097, "#c9a24a", 0.89 + Y, x=-0.02, sy=1.15)                      # brass helmet
    m.box(0.05, 0.02, 0.1, "#c9a24a", 0.07, 0.89 + Y, 0, vary=0)               # its peak
    m.box(0.17, 0.07, 0.03, "#c9a24a", -0.03, 1.02 + Y, 0, vary=0)             # the comb
    m.box(0.05, 0.2, 0.035, "#1a1410", -0.14, 0.97 + Y, 0, rz=-0.35, vary=0)   # horsehair hanging behind
    t = musket_tool("Dragoon.tool", length=0.5)
    return dict(body=m, tool=t, tool_at=(-0.02, 0.64 + Y, 0.11), tool_bone="armR", pivots=HORSE_PIVOTS)

def wild_horse():
    """The horse deposit: one horse grazing, drawn as big as a rider's (the game
    draws units 1.5 times their size; deposits come as they are)."""
    m = Model("Horse")
    horse(m, "#8a5c36", "#5a3a22", "#2a1e14", sock="#2a1e14", grazing=True)
    placed(m, 0, k=1.5)
    return no_bones(m)

def deer(m, stag=True, coat="#b0703c"):
    """A deer facing +x: slim legs, an upright neck, big ears, a white rump and
    tail; a stag carries antlers."""
    PALE, BONE, NOSE = "#ead9bb", "#efe4c8", "#2a1e14"
    m.smooth = True
    sphere(m, 0.12, coat, 0, 0.42, 0, sx=1.75, sy=0.88, sz=0.75)               # body
    sphere(m, 0.1, coat, 0.13, 0.44, 0, sx=1.0, sy=1.05, sz=0.85)              # chest
    sphere(m, 0.09, PALE, 0.0, 0.375, 0, sx=1.5, sy=0.6, sz=0.7)               # pale belly
    sphere(m, 0.07, "#f4eedd", -0.175, 0.44, 0, sx=0.7, sy=1.0, sz=0.9)        # white rump
    m.cyl(0.012, 0.03, 0.1, "#f4eedd", -0.25, 0.47, 0, seg=5, rz=-0.6, vary=0) # tail, held up
    for x, back in ((0.13, False), (-0.15, True)):
        for z in (-0.05, 0.05):
            if back:
                sausage(m, 0.036, 0.13, coat, x, 0.38, z, rz=-0.3)
                sausage(m, 0.017, 0.21, coat, x - 0.04, 0.25, z, rz=0.18)
            else:
                sausage(m, 0.028, 0.13, coat, x, 0.37, z)
                sausage(m, 0.016, 0.2, coat, x, 0.24, z)
            m.cyl(0.024, 0.018, 0.04, NOSE, x, 0.02, z, seg=6, vary=0)
    m.cyl(0.062, 0.04, 0.3, coat, 0.215, 0.6, 0, seg=8, rz=-0.3, vary=0)       # neck
    m.cyl(0.05, 0.03, 0.14, PALE, 0.245, 0.55, 0, seg=6, rz=-0.3, vary=0)      # pale throat
    sphere(m, 0.058, coat, 0.275, 0.755, 0, sx=1.15, sy=1.0, sz=0.9)           # head
    m.cyl(0.022, 0.042, 0.13, coat, 0.36, 0.725, 0, seg=6, rz=1.25, vary=0)    # snout
    sphere(m, 0.02, NOSE, 0.425, 0.705, 0)
    m.smooth = False
    for z in (-1, 1):
        sphere(m, 0.012, "#1a1410", 0.31, 0.775, z * 0.048, seg=6, rings=4)
        m.cyl(0.03, 0.0, 0.11, coat, 0.23, 0.82, z * 0.075, seg=4, rx=z * 0.9, vary=0)   # ears, out to the sides
        if stag:
            # an antler: a beam sweeping up and back, three tines forward off it
            for (x, y, zz, ln, rz, rx) in ((0.24, 0.875, 0.055, 0.16, 0.45, 0.45), (0.2, 0.99, 0.12, 0.13, 0.0, 0.3),
                                           (0.285, 0.865, 0.075, 0.09, -1.0, 0.5), (0.25, 0.955, 0.115, 0.1, -0.9, 0.3), (0.235, 1.045, 0.14, 0.08, -0.7, 0.4)):
                m.cyl(0.013, 0.008, ln, BONE, x, y, z * zz, seg=4, rz=rz, rx=z * rx, vary=0)

def deer_herd():
    """The game deposit: a stag and a doe on a tile."""
    m = Model("Deer")
    n = count(m); deer(m, True); placed(m, n, -0.08, -0.25, 0.25, 1.15)
    n = count(m); deer(m, False, "#c08a58"); placed(m, n, 0.1, 0.27, 3.5, 0.95)
    return m

def pasture():
    """A fenced paddock (3x3) where horses are kept: two of them, a shelter
    with hay in it, a trough, a gate."""
    m = Model("Pasture")
    m.box(2.9, 0.06, 2.9, "#7fa046", 0, 0.03, 0, vary=0.03)
    m.box(1.0, 0.012, 0.8, "#96895a", 0.55, 0.062, 0.75, vary=0.05)            # ground worn bare by the trough
    for x0, z0, x1, z1 in ((-1.4, -1.4, 1.4, -1.4), (-1.4, 1.4, 0.5, 1.4), (-1.4, -1.4, -1.4, 1.4), (1.4, -1.4, 1.4, 1.4)):
        fence(m, x0, z0, x1, z1, 8 if abs(x1 - x0) + abs(z1 - z0) > 2 else 6, h=0.42, col=DARKWOOD)
    for x in (0.5, 1.4):                                                        # gate posts, the gate ajar
        m.box(0.09, 0.6, 0.09, DARKWOOD, x, 0.3, 1.4, vary=0)
    fence(m, 1.4, 1.4, 0.75, 1.75, 3, h=0.4, col=WOOD)
    # an open shelter on posts with a thatched roof, hay inside
    for x in (-1.2, -0.3):
        for z in (-1.2, -0.55):
            m.box(0.08, 0.7, 0.08, DARKWOOD, x, 0.38, z, vary=0.04)
    m.box(1.0, 0.6, 0.06, "#9b7a4a", -0.75, 0.36, -1.22, vary=0.04)
    m.roof(1.05, 0.8, 0.32, "#b59a52", -0.75, 0.72, -0.875, rows=3, row_col="#a88b45")
    hay(m, -1.0, -0.9, 1.3); hay(m, -0.6, -0.95, 1.2); hay(m, -0.8, -0.9, 1.1, y=0.26)
    m.box(0.7, 0.16, 0.24, WOOD, 0.75, 0.14, 1.0, vary=0.05)                    # trough
    m.box(0.62, 0.02, 0.17, "#4f87a0", 0.75, 0.215, 1.0, vary=0)
    n = count(m); horse(m, "#9a5f33", "#5a3a22", "#2a1e14", sock="#e9e2d2"); placed(m, n, 0.45, -0.35, 0.5, 1.5)
    n = count(m); horse(m, "#cfc6b4", "#8a8272", "#6e675c", grazing=True); placed(m, n, -0.45, 0.6, 2.9, 1.5)
    no_bones(m)
    m.pole_flag(1.25, -1.25, 1.2)
    return m


# --- November 2026: the later foot soldiers, told apart ----------------------------
# Musketeer, rifleman, machine gunner and infantry were the same figure in
# four hats. Each now has its own colour and outline: the rifleman a grey
# greatcoat, a spiked helmet and a team blanket roll across the chest; the
# machine gunner sand-coloured, with a wide tin hat, brass belts and a gun
# half his size; the infantryman dark green with a pack and a radio aerial.
def rifleman():
    m = Model("Rifleman")
    GREY, GREY2 = "#6f747c", "#575b62"
    tabs_person(m, GREY, belt="#2a2420", legs_col=GREY2, sleeves=GREY)             # greatcoat
    m.part("body", smooth=False)
    m.cyl(0.14, 0.17, 0.14, GREY, 0, 0.21, 0, seg=12, vary=0)                      # its long skirts
    m.cyl(0.112, 0.122, 0.045, TEAM, 0, 0.45, 0, seg=12, vary=0)                   # team collar
    # a rolled blanket in the team colour, slung from the left shoulder to the right hip
    m.box(0.05, 0.36, 0.075, TEAM, 0.118, 0.36, 0, rx=0.7, bevel=0.015, vary=0)
    m.box(0.05, 0.36, 0.075, TEAM, -0.118, 0.36, 0, rx=-0.7, bevel=0.015, vary=0)
    m.box(0.07, 0.11, 0.13, "#5a4a32", -0.13, 0.33, 0, vary=0)                     # pack
    for y in (0.3, 0.38):
        m.ball(0.012, GOLD, 0.127, y, 0.03, sub=0, vary=0)
    for side, z in (("armL", -0.13), ("armR", 0.13)):
        m.part(side, smooth=False)
        m.cyl(0.04, 0.04, 0.035, TEAM, 0, 0.33, z, seg=8, vary=0)                  # team cuffs
    m.part("head", smooth=False)
    dome(m, 0.115, "#2a2c30", 0.585, sy=0.95)                                      # a black leather helmet
    m.box(0.07, 0.012, 0.13, "#2a2c30", 0.1, 0.59, 0, vary=0)                      # its peak
    m.cyl(0.035, 0.035, 0.012, GOLD, 0, 0.695, 0, seg=8, vary=0)
    m.cyl(0.02, 0.0, 0.11, GOLD, 0, 0.75, 0, seg=6, vary=0)                        # the brass spike
    m.box(0.012, 0.05, 0.05, GOLD, 0.112, 0.63, 0, vary=0)                         # badge
    t = musket_tool("Rifleman.tool", length=0.6)
    return dict(body=m, tool=t, tool_at=(0.02, 0.3, 0.13), tool_bone="armR", pivots=HUMAN_PIVOTS)

def machine_gunner():
    m = Model("MachineGunner")
    SAND, SAND2 = "#b39a62", "#8f7a4c"
    tabs_person(m, SAND, belt="#5a4632", legs_col=SAND2, sleeves=SAND)
    m.part("body", smooth=False)
    for z in (-1, 1):   # belts of cartridges crossed over the chest
        for i in range(6):
            f = i / 5 - 0.5
            m.box(0.03, 0.05, 0.04, "#d9b24a", 0.125 - abs(f) * 0.03, 0.36 + f * 0.24, z * f * 0.17, rx=z * 0.6, vary=0)
    m.box(0.09, 0.2, 0.17, "#6e6a4a", -0.13, 0.36, 0, vary=0)                      # ammunition boxes on the back
    m.box(0.095, 0.02, 0.175, "#4a4a3a", -0.13, 0.4, 0, vary=0)
    m.cyl(0.11, 0.12, 0.04, TEAM, 0, 0.45, 0, seg=12, vary=0)                      # team scarf
    m.part("head", smooth=False)
    dome(m, 0.1, "#7a7448", 0.6, sy=0.6)                                           # a tin hat: shallow crown,
    m.cyl(0.19, 0.175, 0.018, "#7a7448", 0, 0.6, 0, seg=14, vary=0)                # very wide brim
    m.cyl(0.103, 0.103, 0.02, TEAM, 0, 0.615, 0, seg=12, vary=0)
    t = Model("MachineGunner.tool")  # a heavy water-cooled machine gun, carried level in both arms
    t.cyl(0.05, 0.05, 0.36, "#3a3d42", 0.16, 0.0, 0, seg=10, rz=math.pi / 2, vary=0)   # water jacket
    for x in (0.02, 0.16, 0.3):
        t.cyl(0.054, 0.054, 0.02, "#c9a24a", x, 0.0, 0, seg=10, rz=math.pi / 2, vary=0) # brass bands
    t.cyl(0.016, 0.016, 0.14, "#2a2c30", 0.4, 0.0, 0, seg=6, rz=math.pi / 2, vary=0)    # muzzle
    t.cyl(0.03, 0.022, 0.04, "#2a2c30", 0.47, 0.0, 0, seg=6, rz=math.pi / 2, vary=0)    # flash cone
    t.box(0.16, 0.085, 0.07, "#2a2c30", -0.08, 0.0, 0, vary=0)                          # receiver
    t.box(0.03, 0.09, 0.1, "#4e3420", -0.17, 0.0, 0, vary=0)                            # spade grips
    t.box(0.07, 0.05, 0.12, "#d9b24a", -0.06, 0.03, 0.08, vary=0)                       # the belt feeding in
    t.box(0.1, 0.1, 0.06, "#6e6a4a", -0.06, -0.05, 0.14, vary=0)                        # its box
    for a in (-0.5, 0.5):
        t.box(0.018, 0.2, 0.018, "#3a3d42", 0.1, -0.1, a * 0.14, rx=a * 0.8, vary=0)    # tripod legs, folded down
    t.box(0.018, 0.2, 0.018, "#3a3d42", 0.02, -0.1, 0, rz=0.5, vary=0)
    return dict(body=m, tool=t, tool_at=(0.02, 0.32, 0.13), tool_bone="armR", pivots=HUMAN_PIVOTS)

def infantry():
    m = Model("Infantry")
    GREEN, GREEN2, PATCH = "#4c5a34", "#3b4729", "#6f7a48"
    tabs_person(m, GREEN, belt="#2a2c22", legs_col=GREEN2, sleeves=GREEN)
    m.part("body", smooth=False)
    for x, y, z, r in ((0.09, 0.4, 0.07, 0.035), (0.1, 0.31, -0.06, 0.04), (0.0, 0.38, 0.125, 0.035), (-0.02, 0.33, -0.125, 0.04)):
        sphere(m, r, PATCH, x, y, z, sx=0.5, seg=6, rings=4)                         # camouflage patches
    m.box(0.11, 0.24, 0.19, GREEN2, -0.14, 0.38, 0, bevel=0.015, vary=0)             # a tall pack
    m.cyl(0.04, 0.04, 0.21, "#7a7448", -0.14, 0.52, 0, seg=8, rx=math.pi / 2, vary=0)  # bedroll on top
    m.box(0.06, 0.1, 0.08, "#2a2c22", -0.16, 0.42, 0.11, vary=0)                     # the radio
    m.cyl(0.005, 0.004, 0.42, "#1a1c18", -0.16, 0.68, 0.11, seg=4, rz=0.12, vary=0)  # its aerial
    m.ball(0.012, TEAM, -0.185, 0.89, 0.11, sub=0, vary=0)
    m.cyl(0.11, 0.12, 0.04, TEAM, 0, 0.45, 0, seg=12, vary=0)                        # team scarf
    for z in (-0.06, 0.0, 0.06):
        m.box(0.03, 0.05, 0.04, "#2a2c22", 0.12, 0.28, z, vary=0)                    # pouches
    m.part("head", smooth=False)
    dome(m, 0.122, GREEN2, 0.575, sy=0.9)                                            # a deep helmet
    m.cyl(0.124, 0.124, 0.025, TEAM, 0, 0.6, 0, seg=14, vary=0)                      # team band round it
    m.box(0.03, 0.04, 0.1, "#1a1c18", 0.105, 0.6, 0, vary=0)                         # goggles pushed up
    t = Model("Infantry.tool")  # an assault rifle, level
    t.box(0.34, 0.035, 0.03, "#2a2c30", 0.08, 0.0, 0, vary=0)
    t.box(0.05, 0.08, 0.025, "#2a2c30", 0.05, -0.05, 0, rz=0.2, vary=0)   # magazine
    t.box(0.09, 0.05, 0.03, "#4e3420", -0.12, -0.01, 0, vary=0)           # stock
    t.cyl(0.008, 0.008, 0.1, "#2a2c30", 0.29, 0.01, 0, seg=5, rz=math.pi / 2, vary=0)
    return dict(body=m, tool=t, tool_at=(0.02, 0.32, 0.13), tool_bone="armR", pivots=HUMAN_PIVOTS)


# --- November 2026: the workshops, told apart ---------------------------------------
# Too many buildings were the same gabled house with a different roof colour
# and small props nobody sees from the air. Each of these now has one big
# thing of its own that shows from the camera: the range its targets, the
# lumber camp its log pile, the quarry a cut rock face, the hunting lodge a
# turf roof and antlers, the bakery a loaf, the brewery copper and hops, the
# carpenter a house frame, the printer a book, the powder mill a round house,
# the cannery a tin can, the press a newspaper, the radio factory a wireless
# set, the TV plant a screen, and the power plant twin stacks (the cooling
# tower is the reactor's alone).
def logs_x(m, x, y, z, r, length, dark="#7d5631", pale="#d2ac72"):
    """A log lying along x, with pale cut ends."""
    m.cyl(r, r, length, dark, x, y, z, seg=7, rz=math.pi / 2, vary=0.06)
    m.cyl(r * 0.82, r * 0.82, length + 0.012, pale, x, y, z, seg=7, rz=math.pi / 2, vary=0.04)

def archery_range():
    """An open range (3x3): three big straw targets before a wall of hay
    bales, sand lanes, the shooting line, a small bowyer's hut."""
    m = Model("Range")
    foundation(m, 3)
    m.box(2.6, 0.02, 2.6, "#7d9a48", 0, 0.1, 0, vary=0.03)                      # turf
    for i, x in enumerate((-0.85, 0.0, 0.85)):
        m.box(0.5, 0.012, 1.7, "#d6c594", x, 0.115, -0.05, vary=0.03)          # a sand lane
        for k in range(2):                                                      # the hay backstop
            hay(m, x - 0.2 + k * 0.4, -1.12, 1.55)
        hay(m, x, -1.12, 1.4, y=0.33)
        for sx in (-1, 1):
            m.box(0.05, 0.9, 0.05, DARKWOOD, x + sx * 0.2, 0.5, -0.86, rz=sx * -0.18)
        for r, c in ((0.37, "#e2d2a0"), (0.29, CLOTH), (0.21, TEAM), (0.13, CLOTH), (0.065, "#c9353f")):
            m.cyl(r, r, 0.05 + (0.37 - r) * 0.14, c, x, 0.68, -0.72, seg=14, rx=math.pi / 2 - 0.42, vary=0)
        m.cyl(0.008, 0.008, 0.2, CLOTH, x + 0.07 - i * 0.05, 0.77, -0.64, seg=3, rx=1.2, vary=0)   # an arrow in it
    fence(m, -1.25, 0.72, 0.35, 0.72, 7, h=0.28)                                # the shooting line
    # the bowyer's hut, low, in the front corner; bows on a rack beside it
    m.box(0.7, 0.42, 0.55, "#cdb98f", 0.9, 0.31, 1.0, vary=0.03)
    m.roof(0.7, 0.55, 0.3, "#7c7a3c", 0.9, 0.52, 1.0, rows=3, row_col="#6b6934")
    door(m, 0.9, 1.29, w=0.18, h=0.3, y=0.1)
    m.box(0.6, 0.04, 0.04, DARKWOOD, -0.9, 0.52, 1.1, vary=0)
    for sx in (-1, 1):
        m.box(0.04, 0.45, 0.04, DARKWOOD, -0.9 + sx * 0.28, 0.32, 1.1, vary=0)
    for i in range(4):
        m.box(0.02, 0.42, 0.02, "#6b4a2a", -1.1 + i * 0.13, 0.36, 1.13, rx=-0.15, vary=0)
    m.pole_flag(-1.28, -1.25, 1.5); m.pole_flag(1.28, -1.25, 1.5)
    return m

def sawmill():
    """The lumber camp (2x2): no house at all. A great pile of logs, an open
    lean-to, stumps, a log on the sawbuck with the two-man saw in it."""
    m = Model("Sawmill")
    foundation(m, 2, col="#7a6a50")
    m.box(1.75, 0.02, 1.75, "#8a7a55", 0, 0.1, 0, vary=0.05)                    # trodden earth and sawdust
    # the log pile: 4, 3, 2, 1
    for row, n in enumerate((4, 3, 2, 1)):
        for j in range(n):
            logs_x(m, 0.28, 0.22 + row * 0.2, -0.72 + (j + row * 0.5) * 0.235, 0.118, 1.15,
                   dark=("#7d5631", "#8c6238", "#6e4a2c")[(row + j) % 3])
    for z in (-0.86, 0.12):                                                      # stakes holding it
        for x in (-0.15, 0.7):
            m.box(0.05, 0.5, 0.05, DARKWOOD, x, 0.33, z, vary=0)
    # a lean-to on four posts, tools under it
    for x, h in ((-0.82, 0.62), (-0.36, 0.62)):
        for z in (-0.8, -0.3):
            m.box(0.06, h + (0.14 if z < -0.5 else 0), 0.06, DARKWOOD, x, 0.1 + (h + (0.14 if z < -0.5 else 0)) / 2, z, vary=0)
    m.box(0.62, 0.04, 0.72, "#6b4d2d", -0.59, 0.8, -0.55, rx=-0.27, vary=0.06)
    for i in range(3):
        m.box(0.6, 0.03, 0.2, "#5c4126", -0.59, 0.83 + 0.05 * (1 - i), -0.78 + i * 0.23, rx=-0.27, vary=0.06)
    m.box(0.3, 0.2, 0.3, "#8a6438", -0.6, 0.2, -0.6, vary=0.05)
    # stumps, one with an axe in it
    for x, z, r in ((-0.6, 0.62, 0.11), (-0.25, 0.8, 0.085), (0.75, 0.45, 0.09)):
        m.cyl(r * 1.15, r, 0.14, "#6e4a2c", x, 0.17, z, seg=8, vary=0.05)
        m.cyl(r * 0.85, r * 0.85, 0.01, "#d2ac72", x, 0.245, z, seg=8, vary=0.04)
    m.box(0.025, 0.3, 0.025, WOOD, -0.6, 0.38, 0.62, rz=0.5, vary=0)
    m.box(0.1, 0.07, 0.02, IRON, -0.55, 0.29, 0.62, rz=0.5, vary=0)
    # the sawbuck: a log across two X trestles, the saw standing in the cut
    for x in (0.1, 0.55):
        for sx in (-1, 1):
            m.box(0.04, 0.42, 0.04, WOOD, x, 0.27, 0.72, rx=sx * 0.5, vary=0)
    logs_x(m, 0.32, 0.4, 0.72, 0.085, 0.85)
    m.box(0.015, 0.2, 0.5, IRON, 0.32, 0.5, 0.72, vary=0)
    for sz in (-1, 1):
        m.box(0.03, 0.1, 0.03, DARKWOOD, 0.32, 0.62, 0.72 + sz * 0.24, vary=0)
    m.pole_flag(-0.82, 0.2, 1.1)
    return m

def mason():
    """The quarry (2x2): a rock face cut down in steps, squared blocks, a crane
    with a block on the rope, a mason's lean-to."""
    m = Model("Mason")
    foundation(m, 2, col="#8f8775")
    PALE = "#d2cab6"
    m.box(1.7, 1.0, 0.5, STONE, 0, 0.55, -0.62, bevel=0.03, vary=0.06)           # the uncut top of the face
    m.box(0.8, 0.22, 0.5, STONE2, -0.45, 1.12, -0.62, ry=0.06, bevel=0.03, vary=0.06)
    m.rock(0.3, STONE2, 0.5, 1.0, -0.62, flat=0.6)
    m.box(1.25, 0.66, 0.42, PALE, -0.22, 0.38, -0.2, bevel=0.02, vary=0.04)      # benches cut into it, fresh and pale
    m.box(0.7, 0.36, 0.4, PALE, -0.5, 0.23, 0.18, bevel=0.02, vary=0.04)
    for x in (-0.6, -0.2, 0.2):                                                   # drill lines down the face
        m.box(0.02, 0.6, 0.02, STONE2, x, 0.42, 0.012, vary=0)
    for x, z, sz, y in ((0.55, 0.55, 0.26, 0.0), (0.8, 0.3, 0.22, 0.0), (0.56, 0.28, 0.2, 0.0), (0.62, 0.45, 0.2, 0.19), (-0.1, 0.7, 0.2, 0.0)):
        m.box(sz, sz * 0.72, sz, STONE3, x, 0.09 + y + sz * 0.36, z, ry=random.random() * 0.5, bevel=0.012, vary=0.05)
    for x, z, r in ((0.1, 0.42, 0.07), (0.3, 0.75, 0.06), (-0.75, 0.6, 0.08), (0.82, 0.72, 0.05)):
        m.rock(r, STONE2, x, 0.09, z, flat=0.6)                                  # rubble
    # the crane: a tall tripod, a jib out over the yard, a block on the rope
    for a in (0, 2.1, 4.2):
        m.box(0.045, 1.5, 0.045, WOOD, 0.3 + math.cos(a) * 0.2, 0.82, -0.05 + math.sin(a) * 0.2, rx=math.sin(a) * 0.14, rz=-math.cos(a) * 0.14, vary=0)
    m.box(0.85, 0.045, 0.045, WOOD, 0.52, 1.5, 0.12, rz=0.22, ry=-0.5, vary=0)
    m.cyl(0.007, 0.007, 0.62, "#c9b88f", 0.86, 1.28, 0.31, seg=3, vary=0)
    m.box(0.2, 0.15, 0.2, STONE3, 0.86, 0.9, 0.31, vary=0.05)
    m.pole_flag(-0.8, 0.72, 1.0)
    return m

def settlement():
    """The hunting lodge (2x2): a log cabin under a turf roof, antlers over the
    door, a hide stretched on a frame, game hanging from a rack."""
    m = Model("Settlement")
    foundation(m, 2)
    timber_hall(m, 1.0, 0.58, 1.1, "#8a6238", "#5f8a3c", "#4f7a32", rows=4, windows=1, roof_h=0.5, gable_front=True)
    for i in range(5):                                                           # the log walls
        for sx in (-1, 1):
            m.cyl(0.058, 0.058, 1.16, "#6e4a2c" if i % 2 else "#7d5631", sx * 0.5, 0.12 + i * 0.105, 0, seg=6, rx=math.pi / 2, vary=0.05)
    for x, z in ((-0.3, 0.2), (0.28, -0.3), (0.1, 0.35), (-0.2, -0.25)):         # flowers in the turf
        m.ball(0.035, "#e8d85a", x * 0.9, 0.9 - abs(x) * 0.75, z, sub=0, vary=0)
    m.box(0.16, 0.6, 0.16, STONE2, 0.3, 0.86, -0.2, vary=0.06)  # chimney: smoke comes out at the top
    m.box(0.2, 0.05, 0.2, STONE, 0.3, 1.17, -0.2, vary=0)
    # antlers over the door
    m.box(0.1, 0.1, 0.03, "#5a3a22", 0, 0.82, 0.57, vary=0)
    for sx in (-1, 1):
        m.cyl(0.016, 0.01, 0.26, "#efe4c8", sx * 0.1, 0.93, 0.58, seg=4, rz=-sx * 0.75, vary=0)
        for k, (dx, dy) in enumerate(((0.1, 1.0), (0.17, 1.04))):
            m.cyl(0.012, 0.007, 0.12, "#efe4c8", sx * dx, dy, 0.58, seg=4, rz=sx * 0.1, vary=0)
    # a hide laced into a frame, leaning by the wall
    for sx in (-1, 1):
        m.box(0.035, 0.75, 0.035, WOOD, 0.72 + sx * 0.2, 0.45, 0.45, rx=-0.25, vary=0)
    for y in (0.16, 0.76):
        m.box(0.45, 0.035, 0.035, WOOD, 0.72, y + 0.02, 0.54 - y * 0.25, vary=0)
    m.box(0.3, 0.46, 0.015, "#c79a62", 0.72, 0.47, 0.44, rx=-0.25, vary=0.05)
    m.box(0.16, 0.2, 0.017, "#a87a48", 0.72, 0.5, 0.445, rx=-0.25, vary=0.05)
    # a rack with game hanging from it
    for sx in (-1, 1):
        m.box(0.04, 0.62, 0.04, DARKWOOD, -0.72, 0.4, 0.5 + sx * 0.22, vary=0)
    m.box(0.04, 0.04, 0.54, DARKWOOD, -0.72, 0.7, 0.5, vary=0)
    for z, col, ln in ((0.36, "#b0703c", 0.26), (0.5, "#8a6a52", 0.2), (0.64, "#b0703c", 0.24)):
        m.ball(0.055, col, -0.72, 0.68 - ln / 2 - 0.03, z, sub=1, sy=ln / 0.11, vary=0.05)
    barrel(m, -0.7, -0.5)
    m.pole_flag(0.8, -0.65, 1.1)
    return m

def bakery():
    """A whitewashed bakehouse: a big domed oven with its chimney, and a golden
    loaf the size of a cart for a sign."""
    m = Model("Bakery")
    foundation(m, 2)
    timber_hall(m, 0.95, 0.58, 1.0, "#eee4cc", TILE, "#7e3a26", rows=4, windows=1, roof_h=0.42, gable_front=True)
    # the bread oven: a big dome on the side, glowing at its mouth, with a chimney
    m.cyl(0.36, 0.36, 0.24, STONE2, 0.66, 0.2, -0.05, seg=12, vary=0.04)
    sphere(m, 0.36, "#d2a878", 0.66, 0.31, -0.05, sy=0.85, vary=0.04)
    m.box(0.2, 0.16, 0.05, "#3a1a10", 0.66, 0.26, 0.3, vary=0)
    m.box(0.15, 0.11, 0.05, "#ff8a3a", 0.66, 0.25, 0.31, vary=0)
    m.box(0.14, 0.68, 0.14, STONE2, 0.65, 0.52, -0.42, vary=0.06)  # chimney: smoke comes out at the top
    m.box(0.18, 0.05, 0.18, STONE, 0.65, 0.88, -0.42, vary=0)
    # the sign: a great loaf on an iron bracket over the door
    m.box(0.03, 0.5, 0.03, "#3a3d42", 0, 1.22, 0.42, vary=0)
    m.ball(0.2, "#e0a850", 0, 1.5, 0.42, sub=2, sx=1.5, sy=0.72, sz=0.85, vary=0.03)
    for x in (-0.14, 0.0, 0.14):
        m.box(0.035, 0.03, 0.26, "#b87a30", x, 1.635, 0.42, ry=0.5, vary=0)       # the slashes in its crust
    # a table of loaves out front, and sacks of flour
    m.box(0.44, 0.04, 0.22, WOOD, -0.55, 0.3, 0.7, vary=0)
    for sx in (-1, 1):
        m.box(0.04, 0.26, 0.04, DARKWOOD, -0.55 + sx * 0.18, 0.15, 0.7, vary=0)
    for i in range(4):
        m.ball(0.055, "#d9a25a", -0.7 + i * 0.1, 0.36, 0.7, sub=1, sx=1.3, sy=0.7, vary=0.06)
    sack(m, 0.3, 0.72); sack(m, 0.45, 0.78, s=0.9); sack(m, 0.36, 0.68, y=0.09, s=0.85)
    m.pole_flag(-0.8, -0.6, 1.0)
    return m

def brewery():
    """A brick brewhouse under a green copper roof, a copper kettle's dome and
    pipe standing out of it, casks stacked high, hops on tall poles."""
    m = Model("Brewery")
    foundation(m, 2)
    COPPER, VERDIGRIS = "#c47a46", "#5fa08a"
    timber_hall(m, 1.0, 0.6, 0.95, "#a8674a", VERDIGRIS, "#4f8a76", rows=4, windows=1, roof_h=0.42, gable_front=True)
    # the kettle: its copper dome comes through the roof at the back, with a tall pipe
    m.cyl(0.3, 0.3, 0.5, COPPER, -0.1, 0.92, -0.3, seg=12, vary=0.03)
    sphere(m, 0.3, "#d68a52", -0.1, 1.17, -0.3, sy=0.7, vary=0.03)
    m.cyl(0.305, 0.305, 0.03, "#8a5230", -0.1, 0.95, -0.3, seg=12, vary=0)
    m.cyl(0.05, 0.045, 0.5, COPPER, -0.1, 1.55, -0.3, seg=8, vary=0)
    m.cyl(0.075, 0.05, 0.05, COPPER, -0.1, 1.82, -0.3, seg=8, vary=0)
    # casks on their sides, three, two and one
    for row, n in enumerate((3, 2, 1)):
        for j in range(n):
            x = 0.42 + (j + row * 0.5) * 0.21
            m.cyl(0.1, 0.1, 0.3, "#8a5f35", x, 0.2 + row * 0.18, 0.66, seg=8, rx=math.pi / 2, vary=0.04)
            m.cyl(0.104, 0.104, 0.03, IRON, x, 0.2 + row * 0.18, 0.56, seg=8, rx=math.pi / 2, vary=0)
            m.cyl(0.104, 0.104, 0.03, IRON, x, 0.2 + row * 0.18, 0.76, seg=8, rx=math.pi / 2, vary=0)
            m.cyl(0.085, 0.085, 0.31, "#b98a55", x, 0.2 + row * 0.18, 0.66, seg=8, rx=math.pi / 2, vary=0.03)
    # hops climbing three tall poles
    for i, z in enumerate((-0.2, 0.15, 0.5)):
        m.cyl(0.02, 0.02, 1.25, DARKWOOD, -0.78, 0.7, z, seg=5, vary=0)
        for k in range(7):
            a = k * 1.9 + i
            m.ball(0.075, "#6f9e3a" if k % 2 else "#5c8c34", -0.78 + math.cos(a) * 0.045, 0.3 + k * 0.15, z + math.sin(a) * 0.045, sub=0, vary=0.08)
    m.box(0.22, 0.2, 0.03, TEAM, 0, 0.84, 0.51, vary=0)  # a sign: a tankard
    m.box(0.07, 0.09, 0.03, GOLD, 0, 0.83, 0.53, vary=0)
    m.pole_flag(0.8, -0.65, 1.0)
    return m

def carpenter():
    """A workshop with the frame of a house going up beside it in new timber,
    a cart wheel, and planks stacked to season."""
    m = Model("Carpenter")
    foundation(m, 2)
    NEW = "#e0bc80"
    # the workshop itself is small and set back, under pale new shingles
    m.box(0.8, 0.5, 0.6, "#c4a878", -0.42, 0.34, -0.55, vary=0.03)
    for sx in (-1, 1):
        m.box(0.06, 0.52, 0.06, DARKWOOD, -0.42 + sx * 0.4, 0.35, -0.25, vary=0)
    m.roof(0.8, 0.6, 0.32, "#b98a4e", -0.42, 0.59, -0.55, rows=3, row_col="#a67a40")
    door(m, -0.42, -0.24, w=0.2, h=0.34, y=0.09)
    # the frame: posts, plates, three pairs of rafters and a ridge, all bare
    fx, fz, w, d, h = 0.42, -0.1, 0.8, 1.1, 0.62
    for sx in (-1, 1):
        for k in range(3):
            m.box(0.055, h, 0.055, NEW, fx + sx * w / 2, 0.09 + h / 2, fz + (k - 1) * d / 2, vary=0.04)
        m.box(0.055, 0.055, d + 0.06, NEW, fx + sx * w / 2, 0.09 + h, fz, vary=0.04)
    for k in range(3):
        z = fz + (k - 1) * d / 2
        m.box(w + 0.06, 0.055, 0.055, NEW, fx, 0.09 + h, z, vary=0.04)
        for sx in (-1, 1):
            m.box(0.62, 0.05, 0.05, NEW, fx + sx * w / 4, 0.09 + h + 0.23, z, rz=-sx * 0.84, vary=0.04)
    m.box(0.055, 0.055, d + 0.1, NEW, fx, 0.09 + h + 0.47, fz, vary=0.04)
    # a cart wheel against the wall, a sawhorse, planks
    m.cyl(0.24, 0.24, 0.04, DARKWOOD, -0.6, 0.33, 0.12, seg=14, rx=math.pi / 2 - 0.2, vary=0)
    m.cyl(0.2, 0.2, 0.045, "#c9a06a", -0.6, 0.33, 0.125, seg=14, rx=math.pi / 2 - 0.2, vary=0)
    for a in range(4):
        m.box(0.44, 0.03, 0.05, DARKWOOD, -0.6, 0.33, 0.14, rz=a * math.pi / 4, rx=-0.2, vary=0)
    m.cyl(0.05, 0.05, 0.07, IRON, -0.6, 0.33, 0.15, seg=8, rx=math.pi / 2 - 0.2, vary=0)
    for i in range(5):
        m.box(0.75, 0.03, 0.14, "#d6b074" if i % 2 else "#c49c60", -0.45, 0.11 + i * 0.032, 0.68 + (i % 2) * 0.02, vary=0.04)
    m.pole_flag(-0.82, -0.82, 1.1)
    return m

def printer():
    """A slate-roofed print shop with a great open book on the ridge, bundles
    of paper and a press at the door."""
    m = Model("Printer")
    foundation(m, 2)
    top = timber_hall(m, 1.0, 0.62, 0.95, "#e6dfcd", "#5f6b6f", "#4f5a5e", rows=4, windows=2, roof_h=0.4, gable_front=False)
    # the sign: an open book, pages white, cover in the team colour
    for sx in (-1, 1):
        m.box(0.36, 0.035, 0.5, TEAM, sx * 0.17, top + 0.2, 0, rz=sx * 0.42, vary=0)
        m.box(0.33, 0.05, 0.46, "#f6f1e2", sx * 0.165, top + 0.235, 0, rz=sx * 0.42, vary=0)
        for k in range(4):
            m.box(0.22, 0.012, 0.03, "#3a3d42", sx * 0.17, top + 0.265 + 0.0, -0.15 + k * 0.1, rz=sx * 0.42, vary=0)   # lines of type
    m.box(0.04, 0.2, 0.04, "#3a3d42", 0, top + 0.06, 0, vary=0)
    # a printing press under the eaves, and paper
    for sx in (-1, 1):
        m.box(0.05, 0.5, 0.05, DARKWOOD, 0.6 + sx * 0.16, 0.34, 0.66, vary=0)
    m.box(0.4, 0.06, 0.14, DARKWOOD, 0.6, 0.58, 0.66, vary=0)
    m.box(0.3, 0.05, 0.2, "#3a2a1c", 0.6, 0.3, 0.66, vary=0)
    m.cyl(0.016, 0.016, 0.28, IRON, 0.6, 0.44, 0.66, seg=5, vary=0)  # the screw
    m.box(0.26, 0.016, 0.016, IRON, 0.6, 0.5, 0.66, vary=0)
    for k, col in enumerate(("#8a3a2a", "#4f7aa8", "#3a6a3a", "#a8452e")):
        m.box(0.18, 0.04, 0.13, col, -0.62, 0.11 + k * 0.042, 0.62, ry=k * 0.2, vary=0)
    for k in range(4):
        m.box(0.2, 0.06, 0.15, "#f2ecda", -0.36, 0.12 + k * 0.065, 0.68, vary=0.02)
    m.pole_flag(-0.8, -0.6, 1.0)
    return m

def powder_mill():
    """A round stone mill house under a pointed roof, two millstones on edge
    in a pan outside, and the kegs behind a bank of earth, well away."""
    m = Model("PowderMill")
    foundation(m, 2)
    m.cyl(0.5, 0.52, 0.62, STONE, 0.05, 0.4, -0.3, seg=12, vary=0.05)
    for y in (0.3, 0.52):
        m.cyl(0.53, 0.53, 0.04, STONE2, 0.05, y, -0.3, seg=12, vary=0.05)
    m.cyl(0.62, 0.0, 0.62, "#4b4038", 0.05, 1.02, -0.3, seg=12, vary=0.06)
    m.cyl(0.64, 0.6, 0.05, "#40362f", 0.05, 0.72, -0.3, seg=12, vary=0.04)
    door(m, 0.05, 0.22, w=0.22, h=0.36, y=0.09)
    m.box(0.15, 0.82, 0.15, STONE2, -0.45, 0.66, -0.45, vary=0.05)  # chimney: smoke comes out at the top
    m.box(0.19, 0.05, 0.19, STONE3, -0.45, 1.08, -0.45, vary=0)
    # the edge-runner mill: a round pan, two stones on edge, the beam that turns them
    m.cyl(0.34, 0.36, 0.1, STONE2, -0.45, 0.14, 0.5, seg=14, vary=0.03)
    m.cyl(0.29, 0.29, 0.02, "#2e2a26", -0.45, 0.195, 0.5, seg=14, vary=0)
    for sx in (-1, 1):
        m.cyl(0.2, 0.2, 0.09, "#b0a793", -0.45 + sx * 0.16, 0.4, 0.5, seg=12, rz=math.pi / 2, vary=0.03)
        m.cyl(0.05, 0.05, 0.1, DARKWOOD, -0.45 + sx * 0.16, 0.4, 0.5, seg=6, rz=math.pi / 2, vary=0)
    m.box(0.7, 0.05, 0.05, DARKWOOD, -0.45, 0.4, 0.5, vary=0)
    m.cyl(0.035, 0.035, 0.5, DARKWOOD, -0.45, 0.45, 0.5, seg=6, vary=0)
    # a grassy bank, and the powder behind it
    m.ball(0.3, "#6f8a44", 0.36, 0.1, 0.5, sub=2, sx=0.5, sy=0.95, sz=1.25, vary=0.06)
    for x, z in ((0.66, 0.4), (0.82, 0.55), (0.66, 0.7)):
        barrel(m, x, z, r=0.075, h=0.17, y=0.09)
        m.cyl(0.045, 0.045, 0.015, "#1a1410", x, 0.265, z, seg=6, vary=0)
    m.box(0.03, 0.5, 0.03, DARKWOOD, 0.8, 0.34, 0.82, vary=0)
    m.box(0.2, 0.2, 0.02, "#c8453a", 0.8, 0.56, 0.83, rz=math.pi / 4, vary=0)  # a warning sign
    m.pole_flag(0.8, -0.7, 1.0)
    return m

def cannery():
    """A whitewashed shed under a ribbed tin roof with a tin can as tall as a
    man on top of it; cans stacked in pyramids at the door."""
    m = Model("Cannery")
    foundation(m, 2)
    TIN, TIN2 = "#c3ccd4", "#9aa6b0"
    m.box(1.3, 0.62, 0.9, "#e2ddd0", 0, 0.4, -0.05, vary=0.03)
    m.box(1.32, 0.1, 0.92, BRICK, 0, 0.14, -0.05, vary=0.03)
    m.roof(1.3, 0.9, 0.26, TIN2, 0, 0.7, -0.05, rows=7, row_col=TIN)
    for x in (-0.4, 0.4):
        window(m, x, 0.44, 0.405, w=0.2, h=0.2)
    door(m, 0, 0.405, w=0.26, h=0.36, y=0.09)
    m.box(0.12, 0.8, 0.12, "#7a3424", 0.55, 1.15, -0.35, vary=0)  # chimney: smoke comes out at the top
    m.box(0.15, 0.05, 0.15, STONE2, 0.55, 1.55, -0.35, vary=0)
    # the can on the roof: tin, a label in the team colour, a fish on the label
    m.cyl(0.27, 0.27, 0.46, TIN, -0.22, 1.2, -0.05, seg=16, vary=0.02)
    m.cyl(0.275, 0.275, 0.28, TEAM, -0.22, 1.2, -0.05, seg=16, vary=0)
    for y in (0.975, 1.425):
        m.cyl(0.285, 0.285, 0.03, TIN2, -0.22, y, -0.05, seg=16, vary=0)
    m.ball(0.07, CLOTH, -0.22, 1.2, 0.225, sub=1, sx=1.7, sy=0.7, sz=0.3, vary=0)
    m.cyl(0.05, 0.0, 0.07, CLOTH, -0.36, 1.2, 0.2, seg=3, rz=-math.pi / 2, vary=0)
    for px in (-0.6, 0.55):                                                      # pyramids of cans
        for row, n in enumerate((3, 2, 1)):
            for j in range(n):
                m.cyl(0.05, 0.05, 0.09, TIN, px + (j + row * 0.5 - 1) * 0.11, 0.135 + row * 0.092, 0.7, seg=8, vary=0.03)
                m.cyl(0.052, 0.052, 0.04, TEAM if (row + j) % 2 else "#c8453a", px + (j + row * 0.5 - 1) * 0.11, 0.135 + row * 0.092, 0.7, seg=8, vary=0)
    crate(m, 0.0, 0.74, s=0.16, y=0.09)
    m.pole_flag(-0.8, -0.7, 1.0)
    return m

def press():
    """A newspaper's brick office: a flat roof with a parapet, the front page
    on a hoarding above it, an awning in the team colour, great rolls of paper."""
    m = Model("Press")
    foundation(m, 2)
    BR = "#9a6a50"
    m.box(1.15, 0.95, 0.9, BR, 0, 0.56, -0.1, vary=0.03)
    m.box(1.21, 0.07, 0.96, STONE3, 0, 1.05, -0.1, vary=0)
    for sx in (-1, 1):
        m.box(0.06, 0.12, 0.96, BR, sx * 0.575, 1.14, -0.1, vary=0.03)
    for sz in (-1, 1):
        m.box(1.21, 0.12, 0.06, BR, 0, 1.14, -0.1 + sz * 0.45, vary=0.03)
    m.box(1.1, 0.02, 0.85, "#4a4c50", 0, 1.1, -0.1, vary=0)
    for x in (-0.38, 0.38):
        window(m, x, 0.44, 0.355, w=0.18, h=0.24)
        window(m, x, 0.82, 0.355, w=0.18, h=0.16)
    window(m, 0, 0.82, 0.355, w=0.18, h=0.16)
    door(m, 0, 0.355, w=0.26, h=0.4, y=0.09)
    m.box(0.6, 0.03, 0.26, TEAM, 0, 0.6, 0.47, rx=0.35, vary=0)                  # awning
    m.box(0.6, 0.05, 0.02, CLOTH, 0, 0.555, 0.595, vary=0)
    # the hoarding: a front page, headline and columns
    for sx in (-1, 1):
        m.box(0.04, 0.6, 0.04, "#3a3d42", sx * 0.4, 1.4, -0.3, vary=0)
        m.box(0.03, 0.5, 0.03, "#3a3d42", sx * 0.4, 1.35, -0.45, rx=-0.5, vary=0)
    m.box(1.0, 0.62, 0.04, "#f4efe0", 0, 1.56, -0.28, vary=0.01)
    m.box(0.82, 0.1, 0.02, "#1a1410", 0, 1.76, -0.255, vary=0)
    m.box(0.3, 0.26, 0.02, "#8a8478", -0.26, 1.5, -0.255, vary=0)                # a picture
    for k in range(4):
        m.box(0.44, 0.03, 0.02, "#3a3d42", 0.2, 1.62 - k * 0.075, -0.255, vary=0)
    # rolls of newsprint on a dray, bundles of papers tied with string
    m.box(0.5, 0.05, 0.36, WOOD, 0.62, 0.17, 0.66, vary=0.04)
    for z in (0.56, 0.76):
        m.cyl(0.06, 0.06, 0.03, DARKWOOD, 0.45, 0.13, z, seg=8, rx=math.pi / 2, vary=0)
        m.cyl(0.06, 0.06, 0.03, DARKWOOD, 0.79, 0.13, z, seg=8, rx=math.pi / 2, vary=0)
    for k, (x, y) in enumerate(((0.52, 0.32), (0.73, 0.32), (0.625, 0.5))):
        m.cyl(0.115, 0.115, 0.34, "#f2ecda", x, y, 0.66, seg=12, rx=math.pi / 2, vary=0.02)
        m.cyl(0.03, 0.03, 0.345, "#8a6a42", x, y, 0.66, seg=6, rx=math.pi / 2, vary=0)
    for k in range(3):
        m.box(0.2, 0.07, 0.15, "#ece6d6", -0.62, 0.125 + k * 0.072, 0.66, ry=k * 0.15, vary=0.02)
        m.box(0.02, 0.075, 0.155, "#8a6a42", -0.62, 0.125 + k * 0.072, 0.66, ry=k * 0.15, vary=0)
    m.pole_flag(-0.82, -0.75, 1.0)
    return m

def power_plant():
    """A coal power station (3x3): a tall brick boiler house with twin striped
    stacks, coal carried up to it on a belt, a turbine hall, the switchyard."""
    m = Model("PowerPlant")
    foundation(m, 3, col=CONCRETE)
    m.box(1.4, 0.8, 1.0, "#a8a294", -0.5, 0.49, 0.5, vary=0.02)            # turbine hall
    m.prism(1.42, 1.0, 0.22, "#6e6a62", -0.5, 0.89, 0.5)
    for x in (-1.0, -0.66, -0.33, 0.0):
        m.box(0.2, 0.46, 0.03, "#5d7a8c", x, 0.5, 1.015, vary=0.05)
    m.box(1.0, 1.7, 1.0, "#8e5a44", 0.72, 0.94, 0.05, vary=0.03)           # the boiler house
    m.box(1.06, 0.08, 1.06, "#6e6a62", 0.72, 1.82, 0.05, vary=0)
    for y in (0.75, 1.3):
        for x in (0.42, 0.72, 1.02):
            m.box(0.18, 0.36, 0.03, "#ffb35a" if y < 1 else "#5d7a8c", x, y, 0.565, vary=0.05)   # the furnaces glow below
    for x in (0.5, 0.95):                                                    # twin stacks
        m.cyl(0.14, 0.11, 2.75, "#8a8478", x, 1.44, -0.72, seg=10, vary=0.02)
        for y in (2.15, 2.45, 2.72):
            m.cyl(0.135, 0.13, 0.1, "#c8453a", x, y, -0.72, seg=10, vary=0)
    # chimney: smoke comes out at the top (of the right-hand stack)
    for x, z, r in ((-1.0, -0.85, 0.34), (-0.55, -0.95, 0.26), (-0.75, -0.55, 0.22)):
        m.cyl(r, 0.0, r * 0.8, "#26262a", x, 0.09 + r * 0.4, z, seg=7, vary=0.08)  # coal
    m.box(1.3, 0.07, 0.2, "#4a4c50", -0.2, 0.75, -0.55, rz=0.62, ry=0.38, vary=0)   # the belt up from the heap
    for x, h in ((-0.45, 0.5), (0.0, 0.95)):
        m.box(0.04, h, 0.04, "#3e4146", x, 0.09 + h / 2, -0.62 + (x + 0.45) * 0.38, vary=0)
    for k in range(3):  # pylons and wires
        m.box(0.035, 0.75, 0.035, "#3e4146", -1.25, 0.46, -0.2 + k * 0.45, vary=0)
        m.box(0.26, 0.025, 0.025, "#3e4146", -1.25, 0.8, -0.2 + k * 0.45, vary=0)
        m.box(0.26, 0.025, 0.025, "#3e4146", -1.25, 0.66, -0.2 + k * 0.45, vary=0)
    m.box(0.012, 0.012, 0.95, "#1a1c18", -1.25, 0.8, 0.25, vary=0)
    m.pole_flag(-1.3, 1.25, 1.1)
    return m

def radio_factory():
    """A cream works with a rounded corner, a wireless set the size of a shed
    on its roof, and a tall red-and-white mast."""
    m = Model("RadioFactory")
    foundation(m, 2, col=CONCRETE)
    CREAM, GREEN = "#e6dcbf", "#3f7a68"
    m.box(1.25, 0.66, 0.95, CREAM, 0, 0.42, -0.05, vary=0.02)
    m.cyl(0.3, 0.3, 0.66, CREAM, 0.48, 0.42, 0.28, seg=12, vary=0.02)           # the rounded corner
    m.box(1.29, 0.06, 0.99, GREEN, 0, 0.78, -0.05, vary=0)
    m.cyl(0.32, 0.32, 0.06, GREEN, 0.48, 0.78, 0.28, seg=12, vary=0)
    m.box(1.27, 0.05, 0.97, GREEN, 0, 0.3, -0.05, vary=0)                        # a band round the walls
    for x in (-0.42, -0.08):
        m.box(0.26, 0.26, 0.03, "#5d7a8c", x, 0.52, 0.43, vary=0.05)
    door(m, 0.3, 0.425, w=0.2, h=0.34, y=0.09)
    # the wireless: a walnut cabinet with an arched top, a round speaker, a dial and two knobs
    m.box(0.62, 0.42, 0.3, "#7a4a2a", -0.22, 1.02, -0.1, bevel=0.03, vary=0.03)
    m.cyl(0.31, 0.31, 0.3, "#7a4a2a", -0.22, 1.2, -0.1, seg=14, rx=math.pi / 2, vary=0.03)
    m.cyl(0.19, 0.19, 0.04, "#d9c38f", -0.22, 1.22, 0.05, seg=14, rx=math.pi / 2, vary=0)
    for k in range(4):
        m.box(0.3, 0.02, 0.05, "#5a3a22", -0.22, 1.13 + k * 0.06, 0.06, vary=0)
    m.box(0.3, 0.07, 0.03, "#f2e2a0", -0.22, 0.96, 0.055, vary=0)
    for x in (-0.42, -0.02):
        m.cyl(0.035, 0.035, 0.04, "#1a1410", x, 0.88, 0.06, seg=8, rx=math.pi / 2, vary=0)
    # the mast: four legs leaning in, banded red and white, a light on top
    for k in range(6):
        y0, wd = 0.81 + k * 0.26, 0.2 - k * 0.028
        col = "#c8453a" if k % 2 == 0 else "#f2ecda"
        for sx in (-1, 1):
            for sz in (-1, 1):
                m.box(0.03, 0.27, 0.03, col, 0.42 + sx * wd / 2, y0 + 0.13, -0.32 + sz * wd / 2, vary=0)
        m.box(wd + 0.03, 0.02, wd + 0.03, col, 0.42, y0 + 0.26, -0.32, vary=0)
    m.cyl(0.012, 0.012, 0.3, "#3e4146", 0.42, 2.5, -0.32, seg=4, vary=0)
    m.ball(0.04, "#ff5a3a", 0.42, 2.67, -0.32, sub=1, vary=0)
    for k in range(3):
        crate(m, -0.62 + k * 0.18, 0.72, s=0.14, y=0.09)
    m.pole_flag(-0.82, -0.72, 1.0)
    return m

def tv_plant():
    """A white modern works with a glass front, a huge television on the roof
    showing colour bars, its aerial, and a dish."""
    m = Model("TvPlant")
    foundation(m, 2, col=CONCRETE)
    m.box(1.25, 0.72, 0.95, "#f1eee6", 0, 0.45, -0.1, vary=0.02)
    m.box(1.29, 0.06, 0.99, "#3e4a5a", 0, 0.84, -0.1, vary=0)
    m.box(1.1, 0.4, 0.03, GLASS, 0, 0.5, 0.385, vary=0.04)                       # a wall of glass
    for x in (-0.37, 0.0, 0.37):
        m.box(0.025, 0.4, 0.04, "#f1eee6", x, 0.5, 0.39, vary=0)
    door(m, 0.185, 0.395, w=0.2, h=0.3, y=0.09)
    # the television: a dark set on two legs, the test card on its screen
    m.box(0.86, 0.6, 0.14, "#2a2c30", -0.1, 1.3, -0.15, bevel=0.03, vary=0)
    for i, col in enumerate(("#f2f2f2", "#f0d83a", "#3ad0e0", "#4ac04a", "#d04ac0", "#e04a3a", "#3a5ae0")):
        m.box(0.105, 0.44, 0.02, col, -0.415 + i * 0.105, 1.32, -0.075, vary=0)
    for x in (-0.4, 0.2):
        m.box(0.05, 0.16, 0.05, "#3e4146", x, 0.94, -0.15, vary=0)
    for sx in (-1, 1):
        m.cyl(0.008, 0.008, 0.5, "#c3ccd4", -0.1 + sx * 0.12, 1.82, -0.15, seg=4, rz=-sx * 0.5, vary=0)   # the aerial
    # a dish on the corner
    m.cyl(0.02, 0.02, 0.3, "#3e4146", 0.48, 1.0, -0.42, seg=5, vary=0)
    m.cyl(0.03, 0.2, 0.08, "#e8e6e0", 0.48, 1.2, -0.38, seg=12, rx=0.9, vary=0.02)
    m.cyl(0.006, 0.006, 0.16, "#3e4146", 0.48, 1.26, -0.3, seg=4, rx=0.9, vary=0)
    for k in range(3):
        crate(m, -0.55 + k * 0.2, 0.68, s=0.15, y=0.09)
    m.pole_flag(-0.82, -0.72, 1.0)
    return m


def clear_scene():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for me in list(bpy.data.meshes):
        bpy.data.meshes.remove(me)

def bake_ao(objects, distance):
    """Bake ambient occlusion into a temporary colour layer, then move it into Col's alpha."""
    scn = bpy.context.scene
    scn.render.engine = "CYCLES"
    scn.cycles.device = "CPU"
    scn.cycles.samples = 48
    if scn.world is None:
        scn.world = bpy.data.worlds.new("World")
    scn.world.light_settings.distance = distance
    mat = bpy.data.materials.get("bake") or bpy.data.materials.new("bake")
    for ob in objects:
        if not ob.data.materials:
            ob.data.materials.append(mat)
        ob.data.color_attributes.new("AO", "FLOAT_COLOR", "CORNER")
        ob.data.color_attributes.active_color = ob.data.color_attributes["AO"]
    bpy.ops.object.select_all(action="DESELECT")
    for ob in objects:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.bake(type="AO", target="VERTEX_COLORS")
    for ob in objects:
        me = ob.data
        ao, col = me.color_attributes["AO"], me.color_attributes["Col"]
        for i in range(len(col.data)):
            c = col.data[i].color
            a = ao.data[i].color[0]
            col.data[i].color = (c[0], c[1], c[2], max(0.45, min(1.0, a)))
        me.color_attributes.remove(ao)
        me.color_attributes.active_color = me.color_attributes["Col"]
        me.materials.clear()

def pack_glb(path):
    """Shrink the exported file: normals as bytes (KHR_mesh_quantization),
    colours as bytes, and no _WAVE where a mesh has no flags. Blender
    and the game both read the result; it's about half the size."""
    import json, struct
    raw = open(path, "rb").read()
    jlen = struct.unpack_from("<I", raw, 12)[0]
    gj = json.loads(raw[20:20 + jlen])
    bin0 = 20 + jlen + 8
    FMT = {5120: "b", 5121: "B", 5122: "h", 5123: "H", 5125: "I", 5126: "f"}
    N = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}

    def values(i):
        a = gj["accessors"][i]; bv = gj["bufferViews"][a["bufferView"]]
        n, f = N[a["type"]], FMT[a["componentType"]]
        size = struct.calcsize(f)
        stride = bv.get("byteStride", n * size)
        base = bin0 + bv.get("byteOffset", 0) + a.get("byteOffset", 0)
        out = []
        for k in range(a["count"]):
            v = struct.unpack_from("<" + f * n, raw, base + k * stride)
            if a.get("normalized"):
                mx = {"B": 255, "H": 65535, "b": 127, "h": 32767}[f]
                v = tuple(max(x / mx, -1.0) for x in v)
            out.append(v)
        return out

    blob = bytearray()
    views, accs = [], []

    def add(vals, ctype, atype, normalized=False, target=None, stride=None, minmax=False):
        f = FMT[ctype]
        n = N[atype]
        while len(blob) % 4:
            blob.append(0)
        off = len(blob)
        for v in vals:
            if normalized:
                mx = {"B": 255, "b": 127}[f]
                v = [round(max(-1.0, min(1.0, x)) * mx) for x in v]
            blob.extend(struct.pack("<" + f * n, *v))
            if stride:
                blob.extend(b"\0" * (stride - n * struct.calcsize(f)))
        view = {"buffer": 0, "byteOffset": off, "byteLength": len(blob) - off}
        if stride:
            view["byteStride"] = stride
        if target:
            view["target"] = target
        views.append(view)
        acc = {"bufferView": len(views) - 1, "componentType": ctype, "count": len(vals), "type": atype}
        if normalized:
            acc["normalized"] = True
        if minmax:
            acc["min"] = [min(v[c] for v in vals) for c in range(n)]
            acc["max"] = [max(v[c] for v in vals) for c in range(n)]
        accs.append(acc)
        return len(accs) - 1

    for mesh in gj["meshes"]:
        for prim in mesh["primitives"]:
            at = prim["attributes"]
            na = {}
            na["POSITION"] = add(values(at["POSITION"]), 5126, "VEC3", target=34962, minmax=True)
            na["NORMAL"] = add(values(at["NORMAL"]), 5120, "VEC3", normalized=True, target=34962, stride=4)
            if "COLOR_0" in at:
                na["COLOR_0"] = add(values(at["COLOR_0"]), 5121, "VEC4", normalized=True, target=34962)
            for name in ("_WAVE", "_BONE"):
                if name in at:
                    w = values(at[name])
                    if any(v[0] > 0 for v in w):
                        na[name] = add(w, 5126, "SCALAR", target=34962)  # float: Blender's importer needs it, and with padding it's no bigger
            idx = [v[0] for v in values(prim["indices"])]
            ct = 5123 if max(idx) < 65536 else 5125
            prim["indices"] = add([(i,) for i in idx], ct, "SCALAR", target=34963)
            prim["attributes"] = na
    gj["accessors"], gj["bufferViews"] = accs, views
    while len(blob) % 4:
        blob.append(0)
    gj["buffers"] = [{"byteLength": len(blob)}]
    gj.setdefault("extensionsUsed", []).append("KHR_mesh_quantization")
    gj.setdefault("extensionsRequired", []).append("KHR_mesh_quantization")
    js = json.dumps(gj, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    out = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(blob))
    out += struct.pack("<II", len(js), 0x4E4F534A) + js + struct.pack("<II", len(blob), 0x004E4942) + bytes(blob)
    open(path, "wb").write(out)


def main():
    clear_scene()
    # A ground plane so the bake darkens where things meet the ground. Not exported.
    bpy.ops.mesh.primitive_plane_add(size=200, location=(40, -20, 0))
    ground = bpy.context.active_object
    ground.name = "ground"
    ground.data.materials.append(bpy.data.materials.new("bake"))

    spacing = 7.0
    groups = {
        # (granary, smithy, market and temple are kept above but no longer exported: no kind uses them.)
        # (wonder is kept above but no longer exported: the Wonder is gone.)
        "buildings": [capitol, barracks, archery_range, stable, tower, settlement, farm, sawmill, mason,
                      cottage, sheep_farm, iron_mine, brickworks, bakery, weaver, brewery, siege_workshop,
                      townhouse, saltpeter_works, powder_mill, carpenter, printer, circus,
                      tenement, coal_mine, steel_mill, explosives_works, cannery, coal_yard, press, factory,
                      apartment, oil_well, bauxite_mine, power_plant, haber_bosch, radio_factory, tank_works, airfield,
                      tower_block, uranium_mine, reactor, car_plant, tv_plant, missile_silo,
                      lumber_mill, stoneworks, kiln, air_defense, pasture],
        "resources": [pine, oak, bush, stone, gold, iron_ore, clay_pit, sheep_herd, saltpeter, coal_seam, oil_field, bauxite, uranium_ore, wild_horse, deer_herd],
        "units": [citizen, spearman, archer, horseman, swordsman, crossbowman, knight, trebuchet, musketeer, dragoon, cannon,
                  rifleman, machine_gunner, field_gun, infantry, tank, fighter, bomber, rocket_artillery, jet],
    }
    ao_dist = {"buildings": 0.5, "resources": 0.2, "units": 0.1}
    all_objs, pivots_all = [], []
    for row, (g, makers) in enumerate(groups.items()):
        objs = []
        for i, mk in enumerate(makers):
            at = Vector((i * spacing, -row * spacing * 2, 0))
            random.seed(zlib.crc32(mk.__name__.encode()))   # its own wobble, whatever is made before it
            r = mk()
            if isinstance(r, dict):
                # A unit: the body, its tool (origin at the hand that holds it), and
                # an empty per bone named "<Unit>.<bone>" at that bone's pivot.
                ob = r["body"].object(at=at)
                tob = r["tool"].object(parent=ob, at=P(*r["tool_at"]))
                tob["bone"] = r["tool_bone"]
                for bone, pv in r["pivots"].items():
                    e = bpy.data.objects.new(f"{ob.name}.{bone}", None)
                    bpy.context.scene.collection.objects.link(e)
                    e.parent = ob
                    e.location = P(*pv)
                    pivots_all.append(e)
                objs += [ob, tob]
            else:
                objs.append(r.object(at=at))
        bake_ao(objs, ao_dist[g])
        all_objs += objs
        print(f"{g}: {len(objs)} objects baked", flush=True)

    bpy.data.objects.remove(ground, do_unlink=True)
    bpy.ops.object.select_all(action="DESELECT")
    for ob in all_objs + pivots_all:
        ob.select_set(True)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=OUT, export_format="GLB", use_selection=True,
        export_yup=True, export_apply=True, export_normals=True, export_texcoords=False,
        export_materials="NONE", export_vertex_color="ACTIVE", export_all_vertex_colors=False,
        export_attributes=True, export_extras=False, export_animations=False, export_skins=False, export_morph=False,
    )
    pack_glb(OUT)
    tris = sum(sum(len(p.vertices) - 2 for p in ob.data.polygons) for ob in all_objs)
    print(f"wrote {OUT}: {os.path.getsize(OUT) // 1024} KB, {tris} triangles in {len(all_objs)} meshes")
    if "--blend" in sys.argv:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(os.path.dirname(OUT), "..", "assets", "models.blend"))


main()
