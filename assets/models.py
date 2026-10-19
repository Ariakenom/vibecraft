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
import bpy, bmesh, math, random, os, sys
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
    m = Model("Capitol")
    s = 3
    m.box(2.85, 0.5, 2.85, "#6f6553", 0, -0.2, 0, vary=0.02)
    m.box(2.8, 0.18, 2.8, STONE2, 0, 0.09, 0, bevel=0.03)
    m.box(2.5, 0.12, 2.5, STONE, 0, 0.24, 0, bevel=0.02)
    # the keep
    m.box(1.8, 1.05, 1.8, STONE, 0, 0.82, 0, bevel=0.03, vary=0.02)
    for yy in (0.55, 0.95):
        m.box(1.84, 0.05, 1.84, STONE3, 0, yy, 0, vary=0.02)
    merlons(m, 1.8, 1.8, 1.35, STONE, size=0.12, gap=0.3)
    m.cyl(1.32, 0.0, 0.95, TEAM, 0, 1.82, 0, seg=4, ry=math.pi / 4, vary=0.02)
    m.cyl(0.08, 0.0, 0.3, GOLD, 0, 2.43, 0, seg=6, vary=0)
    # corner towers
    for sx in (-1, 1):
        for sz in (-1, 1):
            x, z = sx * 1.15, sz * 1.15
            m.cyl(0.3, 0.26, 1.45, STONE, x, 0.95, z, seg=10, vary=0.02)
            stone_bands(m, 0.27, 0.3, 1.6, STONE3)
            for i in range(6):
                a = i / 6 * math.tau
                m.box(0.09, 0.1, 0.09, STONE, x + math.cos(a) * 0.27, 1.72, z + math.sin(a) * 0.27, vary=0.05)
            m.cyl(0.34, 0.0, 0.55, TEAM_DARK, x, 1.98, z, seg=10, vary=0.02)
            if sz > 0:
                window(m, x, 1.15, z + 0.27, w=0.07, h=0.14)
    # walls between the towers
    for sz in (-1, 1):
        m.box(2.1, 0.55, 0.18, STONE2, 0, 0.55, sz * 1.15, vary=0.03)
        for i in range(-3, 4):
            m.box(0.12, 0.12, 0.2, STONE2, i * 0.3, 0.88, sz * 1.15, vary=0.06)
    for sx in (-1, 1):
        m.box(0.18, 0.55, 2.1, STONE2, sx * 1.15, 0.55, 0, vary=0.03)
        for i in range(-3, 4):
            m.box(0.2, 0.12, 0.12, STONE2, sx * 1.15, 0.88, i * 0.3, vary=0.06)
    # gatehouse with an arched door and banners
    m.box(0.75, 0.95, 0.35, STONE3, 0, 0.6, 1.2, bevel=0.02)
    merlons(m, 0.75, 0.35, 1.07, STONE3, size=0.1, gap=0.25)
    m.box(0.36, 0.5, 0.04, DARKWOOD, 0, 0.5, 1.38, vary=0.02)
    m.cyl(0.18, 0.18, 0.04, DARKWOOD, 0, 0.75, 1.38, seg=10, rx=math.pi / 2, vary=0)
    for sx in (-1, 1):
        m.box(0.14, 0.42, 0.02, TEAM, sx * 0.25, 0.68, 1.39, vary=0)
        m.box(0.14, 0.04, 0.025, GOLD, sx * 0.25, 0.47, 1.395, vary=0)
    # steps up to the gate
    for i in range(3):
        m.box(0.6, 0.06, 0.12, STONE3, 0, 0.27 - i * 0.07, 1.42 + i * 0.1, vary=0.04)
    for sx in (-1, 1):
        window(m, sx * 0.5, 1.0, 0.91, w=0.12, h=0.2)
    m.pole_flag(0, 0, 1.0, w=0.55, fh=0.32, y0=2.45)
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
    m.pole_flag(1.25, 1.05, 1.4); m.pole_flag(-1.25, 1.05, 1.4)
    return m

def archery_range():
    m = Model("Range")
    foundation(m, 3)
    timber_hall(m, 2.1, 0.72, 1.25, "#cdb98f", "#7c7a3c", "#6b6934", rows=4)
    for k, (x, z) in enumerate([(0.75, 1.05), (-0.15, 1.15)]):
        for sx in (-1, 1):
            m.box(0.04, 0.6, 0.04, DARKWOOD, x + sx * 0.12, 0.3, z - 0.05, rz=sx * -0.15)
        for r, c in [(0.25, "#d8c48c"), (0.19, CLOTH), (0.13, TEAM), (0.06, "#c9353f")]:
            m.cyl(r, r, 0.04 + (0.25 - r) * 0.12, c, x, 0.5, z, seg=12, rx=math.pi / 2 - 0.12, vary=0)
    hay(m, -0.75, 1.1); hay(m, -1.0, 1.0, 0.9)
    m.box(0.07, 0.3, 0.08, DARKWOOD, 1.15, 0.2, -0.85)
    m.pole_flag(-1.25, -1.0, 1.3)
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
    hay(m, -0.7, 0.95, 1.1)
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

def settlement():
    m = Model("Settlement")
    foundation(m, 2)
    timber_hall(m, 1.0, 0.58, 1.1, PLASTER, THATCH, "#b08d48", rows=4, windows=1, roof_h=0.5, gable_front=True)
    m.box(0.16, 0.6, 0.16, STONE2, 0.3, 0.86, -0.2, vary=0.06)  # chimney: smoke comes out at the top
    m.box(0.2, 0.05, 0.2, STONE, 0.3, 1.17, -0.2, vary=0)
    crate(m, 0.68, 0.55); crate(m, 0.62, 0.32, 0.14, ry=0.4); barrel(m, -0.68, 0.55)
    barrel(m, -0.7, -0.5)
    m.box(0.35, 0.02, 0.25, "#6d8c3a", 0.6, 0.075, -0.55, vary=0.2)  # a little garden
    for i in range(3):
        m.ball(0.04, "#5c8c34", 0.5 + i * 0.1, 0.11, -0.55, sub=0)
    m.pole_flag(-0.78, 0.0, 1.1)
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

def sawmill():
    m = Model("Sawmill")
    foundation(m, 2)
    timber_hall(m, 1.0, 0.62, 1.1, "#b49064", "#6b4d2d", "#5c4126", rows=4, windows=1, roof_h=0.42, gable_front=True)
    for i in range(3):
        for j in range(3 - i):
            m.cyl(0.085, 0.085, 0.75, "#7d5631" if (i + j) % 2 else "#8c6238", 0.75, 0.15 + i * 0.15, -0.45 + (j + i * 0.5) * 0.18, seg=7, rx=math.pi / 2, vary=0.05)
            m.cyl(0.07, 0.07, 0.755, "#c9a06a", 0.75, 0.15 + i * 0.15, -0.45 + (j + i * 0.5) * 0.18, seg=7, rx=math.pi / 2, vary=0.05)
    # sawhorse with a log being cut, and the big saw blade
    for sx in (-1, 1):
        m.box(0.04, 0.3, 0.04, WOOD, -0.55 + sx * 0.25, 0.2, 0.62, rz=sx * 0.3)
    m.cyl(0.08, 0.08, 0.7, "#8c6238", -0.55, 0.38, 0.62, seg=7, rz=math.pi / 2)
    m.cyl(0.2, 0.2, 0.02, IRON, -0.2, 0.36, 0.62, seg=14, rx=math.pi / 2, vary=0)
    m.box(0.25, 0.25, 0.08, DARKWOOD, -0.2, 0.2, 0.55)
    m.pole_flag(-0.8, -0.6, 1.0)
    return m

def mason():
    m = Model("Mason")
    foundation(m, 2)
    timber_hall(m, 1.0, 0.62, 1.05, STONE3, "#6f6a62", "#625d56", rows=4, windows=1, roof_h=0.42, gable_front=True)
    for x, z, sz in [(0.62, 0.5, 0.24), (0.8, 0.22, 0.2), (0.6, 0.25, 0.18), (0.82, 0.5, 0.18)]:
        m.box(sz, sz * 0.7, sz, STONE, x, 0.06 + sz * 0.35, z, ry=random.random(), bevel=0.01, vary=0.05)
    m.box(0.2, 0.14, 0.2, STONE2, 0.68, 0.27, 0.42, ry=0.3, bevel=0.01)
    # a wooden crane lifting a block
    for a in (0, 2.1, 4.2):
        m.box(0.035, 1.05, 0.035, WOOD, -0.6 + math.cos(a) * 0.18, 0.5, -0.45 + math.sin(a) * 0.18, rx=math.sin(a) * 0.17, rz=-math.cos(a) * 0.17, vary=0)
    m.box(0.6, 0.035, 0.035, WOOD, -0.42, 1.02, -0.45, rz=-0.2, vary=0)
    m.cyl(0.006, 0.006, 0.4, "#c9b88f", -0.15, 0.78, -0.45, seg=3, vary=0)
    m.box(0.16, 0.12, 0.16, STONE, -0.15, 0.53, -0.45, vary=0.05)
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
    """Grey boulders. The game's shader paints a stony surface on the facets."""
    m = Model("Stone")
    for x, z, r in [(0, 0, 0.33), (0.25, 0.13, 0.22), (-0.21, -0.14, 0.2), (0.05, -0.26, 0.14), (-0.16, 0.2, 0.11)]:
        m.rock(r, "#99928a", x, 0, z, vary=0.06)
    return m

def gold():
    """The same stone; the game's shader runs gold veins through it. A few loose nuggets."""
    m = Model("Gold")
    for x, z, r in [(0, 0, 0.33), (0.25, 0.13, 0.22), (-0.21, -0.14, 0.2), (0.08, -0.25, 0.13)]:
        m.rock(r, "#948c80", x, 0, z, vary=0.06)
    for x, y, z in [(-0.3, 0.04, 0.12), (0.34, 0.04, -0.1), (0.15, 0.04, 0.3)]:
        m.ball(0.045, "#f4d462", x, y, z, sub=0, jitter=0.25, vary=0.1)
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

def citizen():
    m = Model("Citizen")
    tabs_person(m, "#c4a676", belt=TEAM)
    m.part("head"); dome(m, 0.11, TEAM, 0.585); m.cyl(0.115, 0.115, 0.025, TEAM_DARK, 0, 0.585, 0, seg=12, vary=0)
    t = Model("Citizen.tool")  # a hammer, held in the right hand
    t.cyl(0.014, 0.014, 0.34, WOOD, 0, 0.1, 0, seg=6, vary=0)
    t.box(0.06, 0.06, 0.13, IRON, 0, 0.26, 0.03, bevel=0.008, vary=0)
    return dict(body=m, tool=t, tool_at=(0.0, 0.29, 0.13), tool_bone="armR", pivots=HUMAN_PIVOTS)

def spearman():
    m = Model("Spearman")
    tabs_person(m, TEAM, belt="#5a4632", sleeves=TEAM_DARK)
    m.part("body"); sphere(m, 0.12, IRON, 0.02, 0.37, 0, sx=0.9, sy=0.7, sz=1.05)  # breastplate
    m.part("head"); dome(m, 0.112, IRON, 0.58)
    m.box(0.03, 0.06, 0.16, TEAM, -0.01, 0.69, 0, vary=0)  # crest
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

HORSE_PIVOTS = {"hips": (0, 0.42, 0), "body": (-0.02, 0.62, 0), "head": (-0.02, 0.78, 0), "armL": (-0.02, 0.76, -0.11), "armR": (-0.02, 0.76, 0.11),
                "legFL": (0.17, 0.36, -0.07), "legFR": (0.17, 0.36, 0.07), "legBL": (-0.17, 0.36, -0.07), "legBR": (-0.17, 0.36, 0.07),
                "neck": (0.22, 0.5, 0), "tail": (-0.28, 0.5, 0)}

def horseman():
    m = Model("Horseman")
    HORSE, HDARK, HAIR = "#8a5c36", "#6a4528", "#2a1e14"
    m.smooth = True
    m.part("hips")
    sphere(m, 0.17, HORSE, 0, 0.44, 0, sx=1.7, sy=0.9, sz=0.85)  # a round barrel of a horse
    for leg, (x, z) in (("legFL", (0.17, -0.07)), ("legFR", (0.17, 0.07)), ("legBL", (-0.17, -0.07)), ("legBR", (-0.17, 0.07))):
        m.part(leg)
        sausage(m, 0.045, 0.27, HORSE, x, 0.36, z)
        m.cyl(0.05, 0.055, 0.05, HAIR, x, 0.045, z, seg=8, vary=0)  # hoof
    m.part("neck")
    sausage(m, 0.075, 0.2, HORSE, 0.22, 0.5, 0, rz=math.pi - 0.6)
    sphere(m, 0.085, HORSE, 0.42, 0.75, 0, sx=1.5, sy=0.85, sz=0.85, rz=-0.35)  # head
    sphere(m, 0.05, HDARK, 0.53, 0.71, 0, sx=1.1, sy=0.9, sz=1.3)  # muzzle
    m.smooth = False
    for z in (-0.04, 0.04):
        sphere(m, 0.013, "#1a1410", 0.46, 0.79, z * 1.6, seg=6, rings=4)
        m.cyl(0.02, 0.0, 0.08, HORSE, 0.36, 0.86, z, seg=5, vary=0)  # ears
    m.box(0.3, 0.06, 0.035, HAIR, 0.3, 0.7, 0, rz=-0.95, vary=0)  # mane
    m.part("tail")
    m.cyl(0.04, 0.015, 0.26, HAIR, -0.33, 0.4, 0, seg=6, rz=0.5, vary=0)
    m.part("hips")
    m.box(0.26, 0.04, 0.3, TEAM, 0, 0.58, 0, vary=0)  # saddle cloth
    m.box(0.27, 0.015, 0.31, GOLD, 0, 0.555, 0, vary=0)
    m.smooth = True
    for z in (-0.12, 0.12):  # rider's legs down the horse's sides
        sausage(m, 0.036, 0.13, "#5a4632", 0.04, 0.6, z, rx=(0.25 if z > 0 else -0.25))
        sphere(m, 0.042, HAIR, 0.06, 0.46, z * 1.25, sx=1.3, sy=0.7)
    m.part("body")
    sphere(m, 0.11, TEAM, -0.02, 0.69, 0, sx=0.95, sy=1.15, sz=1.05)
    sphere(m, 0.1, IRON, 0.0, 0.72, 0, sx=0.9, sy=0.7, sz=1.05)
    for side, z in (("armL", -0.11), ("armR", 0.11)):
        m.part(side)
        sausage(m, 0.032, 0.11, TEAM_DARK, -0.02, 0.76, z)
        sphere(m, 0.036, SKIN, -0.02, 0.64, z)
    m.part("head")
    sphere(m, 0.09, SKIN, -0.02, 0.87, 0)
    dome(m, 0.097, IRON, 0.885, x=-0.02)
    m.smooth = False
    m.box(0.03, 0.05, 0.14, TEAM, -0.03, 0.98, 0, vary=0)
    for z in (-0.03, 0.03):
        sphere(m, 0.014, "#1a1410", 0.062, 0.875, z, seg=6, rings=4)
    t = Model("Horseman.tool")  # a lance with a pennant, couched under the right arm
    t.cyl(0.016, 0.016, 0.9, WOOD, 0.25, 0.04, 0, seg=6, rz=-1.35, vary=0)
    t.cyl(0.032, 0.0, 0.13, IRON, 0.7, 0.13, 0, seg=4, rz=-1.35, vary=0)
    t.flag(0.12, 0.07, TEAM, 0.56, 0.17, 0.0)
    return dict(body=m, tool=t, tool_at=(-0.02, 0.64, 0.11), tool_bone="armR", pivots=HORSE_PIVOTS)


# --- Build, bake and export --------------------------------------------------------------------
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
        "buildings": [capitol, barracks, archery_range, stable, tower, settlement, farm, granary, sawmill, mason, smithy, market, temple, wonder],
        "resources": [pine, oak, bush, stone, gold],
        "units": [citizen, spearman, archer, horseman],
    }
    ao_dist = {"buildings": 0.5, "resources": 0.2, "units": 0.1}
    all_objs, pivots_all = [], []
    for row, (g, makers) in enumerate(groups.items()):
        objs = []
        for i, mk in enumerate(makers):
            at = Vector((i * spacing, -row * spacing * 2, 0))
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
