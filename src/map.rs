//! The tile map: terrain, which tiles are blocked, and where deposits sit.
//! Also the procedural map generator.

use crate::defs::Dep;

pub const MAP_W: i32 = 120;
pub const MAP_H: i32 = 120;
/// How far apart a base's deposits are, against the first maps (80 tiles).
const SPREAD: f32 = 1.5;
/// Free tiles kept between the edges of two clusters of different kinds, so
/// a building fits next to each.
const CLUSTER_GAP: f32 = 4.0;
/// Tiles of open sea along every edge of the land (the shore shelves up to
/// the land over the next few). Boats sail round the map on it.
const SEA: i32 = 6;
/// How many maps have a river crossing the whole map (`generate`).
pub const CROSSING_RIVER_CHANCE: f32 = 0.4;
/// More open sea all round, outside the land: the whole map is this much
/// wider and taller on each side (about four times the sea there was).
pub const OPEN_SEA: i32 = 18;
/// Fishing spots by every base, and out on the open sea along each edge.
const FISH_NEAR_BASE: usize = 4;
const FISH_OPEN: i32 = 5;

pub const GRASS: u8 = 0;
pub const WATER: u8 = 1;
pub const SAND: u8 = 2;
pub const HILL: u8 = 3;
/// Where a nuke fell: blocked for good.
pub const CRATER: u8 = 4;
/// Shallow water: a ford across a river. Boats sail it and people wade it.
pub const SHALLOW: u8 = 5;
/// Where water meets land in `Map::shade` (0..1), whatever a map's water
/// level: the 3D view draws its waterline there (`elevOf` in render3d.js).
pub const SHADE_WATER: f32 = 0.36;
/// Ground lower than this in `Map::shade` is drawn as beach (the ground
/// shader's sand line wobbles up to elevation 0.22, which is 0.445).
pub const SHADE_BEACH: f32 = 0.45;

/// One tile of a deposit: a tree of a forest, a rock of a stone outcrop, a
/// fruit bush, grazing horses or game. Extractors are built next to them.
/// Deposits never run out, so they never change during a game.
#[derive(Clone)]
pub struct Deposit {
    pub kind: Dep,
    pub tx: i32,
    pub ty: i32,
}

impl Deposit {
    pub fn center(&self) -> (f32, f32) {
        (self.tx as f32 + 0.5, self.ty as f32 + 0.5)
    }
}

#[derive(Clone)]
pub struct Map {
    pub w: i32,
    pub h: i32,
    pub terrain: Vec<u8>,
    /// Height 0..255, used only for drawing (hills look darker).
    pub shade: Vec<u8>,
    pub blocked: Vec<bool>,
    /// Index into the deposit list, or -1.
    pub dep_at: Vec<i32>,
    /// Building entity id on this tile, or -1.
    pub bld_at: Vec<i32>,
}

impl Map {
    pub fn idx(&self, x: i32, y: i32) -> usize {
        (y * self.w + x) as usize
    }
    pub fn inside(&self, x: i32, y: i32) -> bool {
        x >= 0 && y >= 0 && x < self.w && y < self.h
    }
    pub fn passable(&self, x: i32, y: i32) -> bool {
        self.inside(x, y) && !self.blocked[self.idx(x, y)]
    }
    /// Water a boat can sail on, shallows too.
    pub fn sailable(&self, x: i32, y: i32) -> bool {
        self.inside(x, y) && matches!(self.terrain[self.idx(x, y)], WATER | SHALLOW)
    }
    /// Any water, deep or shallow.
    pub fn wet(&self, x: i32, y: i32) -> bool {
        self.sailable(x, y)
    }
    /// `passable` for land units, `sailable` for boats.
    pub fn passable_for(&self, naval: bool, x: i32, y: i32) -> bool {
        if naval { self.sailable(x, y) } else { self.passable(x, y) }
    }
    pub fn passable_for_at(&self, naval: bool, x: f32, y: f32) -> bool {
        self.passable_for(naval, x.floor() as i32, y.floor() as i32)
    }

    /// Can a unit of radius ~0.25 walk (or a boat sail, with `naval`) in a
    /// straight line from a to b? Used to straighten the zig-zag tile paths
    /// that A* returns.
    pub fn line_clear(&self, naval: bool, a: (f32, f32), b: (f32, f32)) -> bool {
        let (dx, dy) = (b.0 - a.0, b.1 - a.1);
        let len = (dx * dx + dy * dy).sqrt();
        let steps = (len / 0.2).ceil().max(1.0) as i32;
        const R: f32 = 0.24;
        for s in 0..=steps {
            let t = s as f32 / steps as f32;
            let (x, y) = (a.0 + dx * t, a.1 + dy * t);
            for (ox, oy) in [(-R, -R), (R, -R), (-R, R), (R, R)] {
                if !self.passable_for_at(naval, x + ox, y + oy) {
                    return false;
                }
            }
        }
        true
    }
}

// ---------------------------------------------------------------------------
// Noise: cheap "value noise" summed at several scales (fractal Brownian motion).

fn hash(x: i32, y: i32, seed: u32) -> f32 {
    let mut h = (x as u32).wrapping_mul(374_761_393) ^ (y as u32).wrapping_mul(668_265_263) ^ seed.wrapping_mul(2_246_822_519);
    h = (h ^ (h >> 13)).wrapping_mul(1_274_126_177);
    h ^= h >> 16;
    (h & 0x00ff_ffff) as f32 / 16_777_216.0
}

fn value_noise(x: f32, y: f32, seed: u32) -> f32 {
    let (xi, yi) = (x.floor() as i32, y.floor() as i32);
    let (fx, fy) = (x - x.floor(), y - y.floor());
    let s = |t: f32| t * t * (3.0 - 2.0 * t); // smoothstep, as a closure
    let (u, v) = (s(fx), s(fy));
    let a = hash(xi, yi, seed);
    let b = hash(xi + 1, yi, seed);
    let c = hash(xi, yi + 1, seed);
    let d = hash(xi + 1, yi + 1, seed);
    let top = a + (b - a) * u;
    let bot = c + (d - c) * u;
    top + (bot - top) * v
}

fn fbm(x: f32, y: f32, seed: u32) -> f32 {
    let (mut sum, mut amp, mut freq, mut norm) = (0.0, 0.5, 1.0, 0.0);
    for o in 0..4 {
        sum += value_noise(x * freq, y * freq, seed.wrapping_add(o * 101)) * amp;
        norm += amp;
        amp *= 0.5;
        freq *= 2.0;
    }
    sum / norm
}

fn dist(a: (f32, f32), b: (f32, f32)) -> f32 {
    ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt()
}

fn dist_to_segment(p: (f32, f32), a: (f32, f32), b: (f32, f32)) -> f32 {
    let (abx, aby) = (b.0 - a.0, b.1 - a.1);
    let t = (((p.0 - a.0) * abx + (p.1 - a.1) * aby) / (abx * abx + aby * aby)).clamp(0.0, 1.0);
    dist(p, (a.0 + abx * t, a.1 + aby * t))
}

/// Tile features placed during generation, before they become `Deposit`s.
#[derive(Clone, Copy, PartialEq)]
enum Feat {
    None,
    Tree,
    Fertile,
    Stone,
    Horses,
    Game,
    Iron,
    Clay,
    Hills,
    Nitrate,
    Coal,
    Oil,
    Bauxite,
    Uranium,
    /// A fish shoal: on the water.
    Fish,
}

/// A symmetry of the map: a way to turn it that lands it on itself.
/// Two players get 180° symmetry; three or four get 90° (four-way) symmetry,
/// so every starting position is identical, just turned.
#[derive(Clone, Copy)]
enum Sym {
    Id,
    Rot90,
    Rot180,
    Rot270,
}

impl Sym {
    fn apply(self, x: i32, y: i32, w: i32, h: i32) -> (i32, i32) {
        match self {
            Sym::Id => (x, y),
            Sym::Rot90 => (w - 1 - y, x),
            Sym::Rot180 => (w - 1 - x, h - 1 - y),
            Sym::Rot270 => (y, h - 1 - x),
        }
    }
}

/// The t-th point on the square ring of radius r around (0, 0) (8r points).
fn ring_point(r: i32, t: i32) -> (i32, i32) {
    let side = 2 * r;
    let (s, o) = (t / side, t % side);
    match s {
        0 => (-r + o, -r),
        1 => (r, -r + o),
        2 => (r - o, r),
        _ => (-r, r - o),
    }
}

/// Build a fair map for `players` (2 to 4). Returns the map, its deposits,
/// and one base centre tile per player.
pub fn generate(seed: u32, players: usize) -> (Map, Vec<Deposit>, Vec<(i32, i32)>) {
    let players = players.clamp(2, 4);
    let (w, h) = if players <= 2 { (MAP_W, MAP_H) } else { (144, 144) };
    let n = (w * h) as usize;
    let syms: &[Sym] = if players <= 2 { &[Sym::Id, Sym::Rot180] } else { &[Sym::Id, Sym::Rot90, Sym::Rot180, Sym::Rot270] };
    let images = |x: i32, y: i32| syms.iter().map(move |s| s.apply(x, y, w, h));
    // Base 1 sits in the bottom-left; the others are its turned images.
    // With 3 players, one of the four corners is simply left empty.
    let b1 = (21 + (w - MAP_W) / 12, h - 22 - (h - MAP_H) / 12);
    let base_order: &[Sym] = if players <= 2 { &[Sym::Id, Sym::Rot180] } else { &[Sym::Id, Sym::Rot180, Sym::Rot90, Sym::Rot270] };
    let bases: Vec<(i32, i32)> = base_order.iter().take(players).map(|s| s.apply(b1.0, b1.1, w, h)).collect();
    let all_bases: Vec<(f32, f32)> = images(b1.0, b1.1).map(|(x, y)| (x as f32 + 0.5, y as f32 + 0.5)).collect();
    let centre = (w as f32 / 2.0, h as f32 / 2.0);
    // Each seed has a character of its own (playtest: maps looked alike):
    // big lakes or small ponds, high or low water, hills, thick or thin
    // forest. `pick(k, lo, hi)` is a number of the seed's in lo..hi.
    let pick = |k: i32, lo: f32, hi: f32| lo + (hi - lo) * hash(k, 911, seed);
    let land_scale = pick(1, 10.0, 22.0);
    // (A little more water than before boats: bigger lakes.)
    let water_at = pick(2, 0.325, 0.375);
    let hill_at = pick(3, 0.66, 0.77);
    let wood_scale = pick(4, 5.0, 9.5);
    let wood_at = pick(5, 0.54, 0.66);

    // "Canonical" coordinates: a tile and all its images share one noise
    // sample, which is what makes the map symmetric.
    let canon = |x: i32, y: i32| images(x, y).min_by_key(|&(a, b)| b * w + a).unwrap();

    let mut terrain = vec![GRASS; n];
    let mut shade = vec![0u8; n];
    let mut feat = vec![Feat::None; n];

    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) as usize;
            let (cx, cy) = canon(x, y);
            let mut ht = fbm(cx as f32 / land_scale, cy as f32 / land_scale, seed);
            let p = (x as f32 + 0.5, y as f32 + 0.5);
            // Raise ground around every base and along roads to the middle,
            // so nobody spawns in a lake and the map is always connected.
            for &b in &all_bases {
                let d = dist(p, b);
                let r = 14.0 * SPREAD;
                if d < r {
                    ht = ht.max(0.46 + (r - d) / r * 0.1);
                }
            }
            let road = all_bases.iter().map(|&b| dist_to_segment(p, b, centre)).fold(f32::MAX, f32::min);
            if road < 5.0 {
                ht = ht.max(0.42);
            }
            // The sea all round: `SEA` tiles of water along every edge,
            // shelving up to the land (a little ragged).
            let edge = x.min(y).min(w - 1 - x).min(h - 1 - y);
            // Near a start the coast stays as narrow as it was before boats
            // (a few tiles), so the start's deposits keep their ground;
            // the open sea widens away from them, between the towns.
            if edge < SEA + 5 {
                let wobble = hash(cx, cy, seed ^ 0x5EA) * 0.03;
                let near = all_bases.iter().map(|&b| dist(p, b)).fold(f32::MAX, f32::min);
                let open = ((near - 26.0) / 10.0).clamp(0.0, 1.0);
                let narrow = 0.24 + 0.035 * edge as f32;
                let wide = water_at - 0.04 + 0.035 * (edge - SEA) as f32;
                ht = ht.min(narrow + (wide - narrow) * open + wobble);
            }
            terrain[i] = if ht < water_at {
                WATER
            } else if ht < water_at + 0.035 {
                SAND
            } else if ht > hill_at {
                HILL
            } else {
                GRASS
            };
            // Height for drawing, measured from this map's own water level
            // (the 3D view puts the waterline at 0.36). Measured from a fixed
            // level, a map with low water drew wide stretches of its lowest
            // grass flat at the waterline, as sand: dry lake beds.
            shade[i] = ((ht - water_at + SHADE_WATER).clamp(0.0, 1.0) * 255.0) as u8;

            // Forests from a second noise layer.
            let f = fbm(cx as f32 / wood_scale + 40.0, cy as f32 / wood_scale + 40.0, seed ^ 0xBEEF);
            let near_base = all_bases.iter().any(|&b| dist(p, b) < 11.0);
            if (terrain[i] == GRASS || terrain[i] == HILL) && f > wood_at && hash(cx, cy, seed ^ 7) < 0.82 && !near_base && road > 2.5 {
                feat[i] = Feat::Tree;
            }
        }
    }

    // Hand-placed starting deposits near base 1, copied to every base.
    // (dx, dy, feature, cluster radius)
    // Fruit and game are wide enough for a few orchards and lodges: houses
    // need three different foods to grow into cottages. The Medieval ones
    // (iron, clay, sheep hills) and saltpeter sit a little further out,
    // clear of the road to the middle.
    let clusters: [(i32, i32, Feat, f32); 13] = [
        (-8, -9, Feat::Tree, 3.4),
        (6, -6, Feat::Fertile, 2.4),
        (9, 4, Feat::Horses, 1.6),
        (-6, 6, Feat::Stone, 1.5),
        (2, 9, Feat::Game, 2.4),
        (-2, -14, Feat::Iron, 1.5),
        (14, 8, Feat::Clay, 1.5),
        (14, -2, Feat::Hills, 1.6),
        (-10, -2, Feat::Nitrate, 1.4),
        (2, -19, Feat::Coal, 1.5),
        (16, 4, Feat::Oil, 1.3),
        (-6, -19, Feat::Bauxite, 1.4),
        (18, -8, Feat::Uranium, 1.3),
    ];
    // Neutral deposits out on the map, in 80×80 coordinates (scaled to fit).
    // Each is copied to every symmetric image, so everyone gets the same.
    // Later eras' deposits too, so a town isn't held to its start's clay,
    // iron or coal: there's more out there to take (and to fight over).
    let neutral: [(i32, i32, Feat, f32); 14] = [
        (20, 40, Feat::Iron, 1.5),
        (31, 44, Feat::Horses, 1.6),
        (44, 66, Feat::Stone, 1.5),
        (24, 30, Feat::Game, 1.6),
        (52, 52, Feat::Fertile, 1.6),
        (36, 36, Feat::Stone, 1.5),
        (10, 46, Feat::Clay, 1.6),
        (40, 56, Feat::Clay, 1.6),
        (27, 52, Feat::Hills, 1.6),
        (55, 70, Feat::Coal, 1.5),
        (30, 20, Feat::Iron, 1.5),
        (48, 44, Feat::Nitrate, 1.4),
        (64, 58, Feat::Oil, 1.3),
        (16, 26, Feat::Bauxite, 1.4),
    ];
    let mirror = hash(6, 911, seed) < 0.5;
    let flip = |dx: i32, dy: i32| if mirror { (-dy, -dx) } else { (dx, dy) };
    // Rivers: from the sea up into the land, winding, three tiles wide
    // and too deep to wade, with shallow fords every few tiles (and where
    // one crosses a road to the middle) for people to cross. Two from the
    // first base's edges, and their turned images: every base gets the
    // same. (Before the clusters, so deposits keep clear of them.)
    let near_base = |x: f32, y: f32| all_bases.iter().map(|&b| dist((x, y), b)).fold(f32::MAX, f32::min);
    let near_road = |x: f32, y: f32| all_bases.iter().map(|&b| dist_to_segment((x, y), b, centre)).fold(f32::MAX, f32::min);
    let carve = |x: i32, y: i32, t: u8, terrain: &mut Vec<u8>, shade: &mut Vec<u8>, feat: &mut Vec<Feat>| {
        if x < 1 || y < 1 || x >= w - 1 || y >= h - 1 {
            return;
        }
        for (px, py) in images(x, y) {
            let i = (py * w + px) as usize;
            // A ford never fills in the sea: only river (and land) turns shallow.
            if t == SHALLOW && terrain[i] == WATER && shade[i] < 60 {
                continue;
            }
            terrain[i] = t;
            shade[i] = if t == WATER { shade[i].min(70) } else { 88 };
            feat[i] = Feat::None;
        }
    };
    let rivers = [
        // (start on an edge, heading in): along the bottom edge, and up the left.
        ((w as f32 * pick(60, 0.5, 0.66), h as f32 - 3.0), -std::f32::consts::FRAC_PI_2),
        ((2.0, h as f32 * pick(61, 0.34, 0.48)), 0.0),
    ];
    // (path, its inland steps, whether fords at roads are spaced out too)
    let mut paths: Vec<(Vec<(f32, f32)>, i32, bool)> = Vec::new();
    for (k, &((x0, y0), heading)) in rivers.iter().enumerate() {
        let len = pick(62 + k as i32, 26.0, 38.0) as i32;
        let (mut x, mut y, mut a) = (x0, y0, heading);
        let mut path: Vec<(f32, f32)> = Vec::new();
        let mut inland = 0;
        for step in 0..(len + 20) {
            // Wander, pulled back toward the way in, so it winds but goes on.
            a += (hash(step, 70 + k as i32, seed) - 0.5) * 0.7 + (heading - a) * 0.15;
            x += a.cos();
            y += a.sin();
            if near_base(x, y) < 16.0 || dist((x, y), centre) < 9.0 || x < 1.0 || y < 1.0 || x > w as f32 - 2.0 || y > h as f32 - 2.0 {
                break;
            }
            let i = (y as i32 * w + x as i32) as usize;
            if terrain[i] != WATER || inland > 0 {
                inland += 1;
            }
            path.push((x, y));
            if inland >= len {
                break;
            }
        }
        paths.push((path, inland, false));
    }
    // On some maps a great river crosses the whole map, sea to sea, through
    // the middle: from the middle of one edge to the centre, and its turned
    // images on to the other side (on four-player maps two of them, crossing
    // in the middle). Fords as on the others, every few tiles and wherever
    // it meets a road, so every town can still be reached on foot.
    if hash(66, 911, seed) < CROSSING_RIVER_CHANCE {
        let from_top = hash(67, 911, seed) < 0.5;
        let along = pick(68, 0.42, 0.58);
        let (mut x, mut y) = if from_top { (w as f32 * along, 1.0) } else { (1.0, h as f32 * along) };
        let mut a = if from_top { std::f32::consts::FRAC_PI_2 } else { 0.0 };
        let mut path: Vec<(f32, f32)> = Vec::new();
        let mut inland = 0;
        for step in 0..(w + h) {
            // Wander, pulled toward the centre, harder as it nears a town.
            let to_centre = (centre.1 - y).atan2(centre.0 - x);
            let mut turn = to_centre - a;
            while turn > std::f32::consts::PI {
                turn -= std::f32::consts::TAU;
            }
            while turn < -std::f32::consts::PI {
                turn += std::f32::consts::TAU;
            }
            let pull = if near_base(x, y) < 20.0 { 0.5 } else { 0.12 };
            a += (hash(step, 75, seed) - 0.5) * 0.7 + turn * pull;
            x += a.cos();
            y += a.sin();
            if dist((x, y), centre) < 1.5 {
                break;
            }
            let i = (y as i32 * w + x as i32) as usize;
            if terrain[i] != WATER || inland > 0 {
                inland += 1;
            }
            path.push((x, y));
        }
        path.push(centre);
        inland += 1;
        // (Near the middle every tile is near a road: unspaced, it would be one long ford.)
        paths.push((path, inland, true));
    }
    for (path, inland, spaced) in paths {
        // Deep water along it...
        for &(px, py) in &path {
            for (dx, dy) in [(0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)] {
                carve(px as i32 + dx, py as i32 + dy, WATER, &mut terrain, &mut shade, &mut feat);
            }
        }
        // ...then fords across it, and its head, shallow.
        let n = path.len();
        let mut last_ford = -100i32;
        for (j, &(px, py)) in path.iter().enumerate() {
            let land = j + 1 + inland as usize > n; // (the inland part: the last `inland` steps)
            let gap = j as i32 - last_ford;
            let at_road = near_road(px, py) < 4.0 && (!spaced || gap >= 6);
            let ford = land && ((gap >= 9 && j + 3 < n) || at_road || j + 3 >= n);
            if !ford {
                continue;
            }
            if j + 3 < n && (spaced || near_road(px, py) >= 4.0) {
                last_ford = j as i32;
            }
            for dy in -2..=2 {
                for dx in -2..=2 {
                    if dx * dx + dy * dy <= 4 {
                        let (tx, ty) = (px as i32 + dx, py as i32 + dy);
                        if tx >= 0 && ty >= 0 && tx < w && ty < h && terrain[(ty * w + tx) as usize] == WATER {
                            carve(tx, ty, SHALLOW, &mut terrain, &mut shade, &mut feat);
                        }
                    }
                }
            }
        }
    }
    // A cluster that would sit in a lake moves to the nearest dry ground
    // instead (playtest: deposits stood on islands of their own). Every
    // image of a spot looks the same, so checking one is enough.
    let dry = |terrain: &[u8], cx: i32, cy: i32, r: f32| {
        let ri = r.ceil() as i32 + 2;
        (-ri..=ri).all(|dy| {
            (-ri..=ri).all(|dx| {
                let (x, y) = (cx + dx, cy + dy);
                let d = ((dx * dx + dy * dy) as f32).sqrt();
                d > r + 2.0 || (x >= 1 && y >= 1 && x < w - 1 && y < h - 1 && !matches!(terrain[(y * w + x) as usize], WATER | SAND | SHALLOW))
            })
        })
    };
    // Room between clusters (playtest: clay right up against the sheep hills,
    // no space to put a building between them): no deposit of another kind
    // within `CLUSTER_GAP` tiles of a cluster's edge. Trees don't count;
    // they are cleared around a cluster anyway.
    // Round every image of the spot: a cluster is copied to each, and an
    // image can land next to another cluster's image though the spot itself
    // has room (a 4-player map put clay against sheep hills that way).
    let roomy = |feat: &[Feat], cx: i32, cy: i32, r: f32, f: Feat| {
        let ri = (r + CLUSTER_GAP).ceil() as i32;
        images(cx, cy).all(|(ix, iy)| {
            (-ri..=ri).all(|dy| {
                (-ri..=ri).all(|dx| {
                    let (x, y) = (ix + dx, iy + dy);
                    let d = ((dx * dx + dy * dy) as f32).sqrt();
                    d > r + CLUSTER_GAP || !(x >= 0 && y >= 0 && x < w && y < h) || matches!(feat[(y * w + x) as usize], Feat::None | Feat::Tree) || feat[(y * w + x) as usize] == f
                })
            })
        })
    };
    // The nearest dry spot with room around it (and true); failing that,
    // the nearest dry spot; failing that, where it was meant to go.
    let on_land = |terrain: &[u8], feat: &[Feat], cx: i32, cy: i32, r: f32, f: Feat| -> ((i32, i32), bool) {
        let mut dry_only = None;
        for ring in 0..=22 {
            for k in 0..(8 * ring).max(1) {
                let (dx, dy) = if ring == 0 { (0, 0) } else { ring_point(ring, k) };
                if dry(terrain, cx + dx, cy + dy, r) {
                    if roomy(feat, cx + dx, cy + dy, r, f) {
                        return ((cx + dx, cy + dy), true);
                    }
                    dry_only.get_or_insert((cx + dx, cy + dy));
                }
            }
        }
        (dry_only.unwrap_or((cx, cy)), false)
    };
    // A town's own deposits always go somewhere (`needed`); one out on the
    // map with no room for it anywhere near is left out instead, on every
    // image alike (a crossing river can leave the middle that crowded).
    let mut place = |cx: i32, cy: i32, f: Feat, r: f32, needed: bool| {
        let ((cx, cy), room) = on_land(&terrain, &feat, cx, cy, r, f);
        if !room && !needed {
            return;
        }
        let ri = r.ceil() as i32 + 2;
        for dy in -ri..=ri {
            for dx in -ri..=ri {
                let (x, y) = (cx + dx, cy + dy);
                if x < 1 || y < 1 || x >= w - 1 || y >= h - 1 {
                    continue;
                }
                let d = ((dx * dx + dy * dy) as f32).sqrt();
                // Ground under and around a cluster: no deposit in a lake,
                // nor buried in a forest, with room around it to build.
                if d <= r + 1.0 {
                    for (px, py) in images(x, y) {
                        let i = (py * w + px) as usize;
                        if matches!(terrain[i], WATER | SAND | SHALLOW) {
                            terrain[i] = GRASS;
                            shade[i] = shade[i].max(110); // drawn as grass, not as the lake bed
                        }
                    }
                }
                if d <= r + 2.2 && f != Feat::Tree {
                    for (px, py) in images(x, y) {
                        let i = (py * w + px) as usize;
                        if feat[i] == Feat::Tree {
                            feat[i] = Feat::None;
                        }
                    }
                }
                if d > r {
                    continue;
                }
                // Bushes and animals are sparse; trees a little ragged; rock is solid.
                let keep = match f {
                    Feat::Fertile | Feat::Horses | Feat::Game | Feat::Hills => (dx + dy) % 2 == 0,
                    Feat::Tree => hash(dx + cx, dy + cy, 3) < 0.88,
                    _ => true,
                };
                if keep {
                    for (px, py) in images(x, y) {
                        feat[(py * w + px) as usize] = f;
                    }
                }
            }
        }
    };
    // The start's layout differs from seed to seed: mirrored across the
    // line to the middle (which keeps the road clear) or not, and every
    // cluster turned and moved out or in a little. Every base still gets
    // the same, so it stays fair.
    for (k, &(dx, dy, f, r)) in clusters.iter().enumerate() {
        let (dx, dy) = flip(dx, dy);
        let turn = (hash(k as i32, 17, seed) - 0.5) * 0.5;
        let out = 0.9 + hash(k as i32, 23, seed) * 0.25;
        let (fx, fy) = (dx as f32 * out * SPREAD, dy as f32 * out * SPREAD);
        let (fx, fy) = (fx * turn.cos() - fy * turn.sin(), fx * turn.sin() + fy * turn.cos());
        place(b1.0 + fx.round() as i32, b1.1 + fy.round() as i32, f, r, true);
    }
    // Out on the map: the same spots, a little moved, and which deposit is
    // where shuffled.
    let mut kinds: Vec<(Feat, f32)> = neutral.iter().map(|&(_, _, f, r)| (f, r)).collect();
    for i in (1..kinds.len()).rev() {
        let j = (hash(i as i32, 31, seed) * (i + 1) as f32) as usize;
        kinds.swap(i, j.min(i));
    }
    for (k, (&(x, y, _, _), &(f, r))) in neutral.iter().zip(&kinds).enumerate() {
        let jx = ((hash(k as i32, 41, seed) - 0.5) * 10.0).round() as i32;
        let jy = ((hash(k as i32, 43, seed) - 0.5) * 10.0).round() as i32;
        place((x + jx).clamp(6, 74) * w / 80, (y + jy).clamp(6, 74) * h / 80, f, r, false);
    }
    // Clear the town sites themselves.
    for &(bx, by) in &all_bases {
        let (bx, by) = (bx as i32, by as i32);
        for y in by - 4..=by + 4 {
            for x in bx - 4..=bx + 4 {
                let i = (y * w + x) as usize;
                feat[i] = Feat::None;
                terrain[i] = GRASS;
            }
        }
    }

    // Tidy the shores: a tile of land with water nearly all round becomes
    // water, and a tile of water with land nearly all round becomes land
    // (sand). Such slivers can't be drawn as what they are. Every tile is
    // decided from the same before-picture, so the map stays symmetric.
    // Deposits and the town sites are left alone.
    for _ in 0..2 {
        let before = terrain.clone();
        let near_town = |x: i32, y: i32| all_bases.iter().any(|&(bx, by)| (x as f32 + 0.5 - bx).abs() <= 5.0 && (y as f32 + 0.5 - by).abs() <= 5.0);
        for y in 1..h - 1 {
            for x in 1..w - 1 {
                let i = (y * w + x) as usize;
                if feat[i] != Feat::None || near_town(x, y) || before[i] == SHALLOW {
                    continue;
                }
                let wet = [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)].iter().filter(|&&(dx, dy)| matches!(before[((y + dy) * w + x + dx) as usize], WATER | SHALLOW)).count();
                if before[i] != WATER && wet >= 6 {
                    terrain[i] = WATER;
                    shade[i] = shade[i].min(80);
                } else if before[i] == WATER && wet <= 2 {
                    terrain[i] = SAND;
                    shade[i] = shade[i].max(92);
                }
            }
        }
    }

    // Fishing spots, one tile each (one boat fishes a spot): the sea
    // nearest every base, a few tiles apart, and more out on the open sea
    // (placed once it's added, below). Only on water joined to the sea,
    // where a dock on the coast can send boats.
    let sea = {
        let mut seen = vec![false; n];
        let mut stack = vec![(0, 0)];
        seen[0] = terrain[0] == WATER;
        while let Some((x, y)) = stack.pop() {
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                let (nx, ny) = (x + dx, y + dy);
                if nx >= 0 && ny >= 0 && nx < w && ny < h && !seen[(ny * w + nx) as usize] && terrain[(ny * w + nx) as usize] == WATER {
                    seen[(ny * w + nx) as usize] = true;
                    stack.push((nx, ny));
                }
            }
        }
        seen
    };
    {
        let mut spots: Vec<(i32, i32)> = Vec::new();
        let mut near: Vec<(i32, i32, i32)> = (0..h)
            .flat_map(|y| (0..w).map(move |x| (x, y)))
            .filter(|&(x, y)| sea[(y * w + x) as usize])
            .map(|(x, y)| ((x - b1.0).pow(2) + (y - b1.1).pow(2), x, y))
            .collect();
        near.sort();
        for (_, x, y) in near {
            if spots.len() >= FISH_NEAR_BASE {
                break;
            }
            // A tile out from the shore, and apart from the others.
            let open = (-1..=1).all(|dy| (-1..=1).all(|dx| terrain[((y + dy).clamp(0, h - 1) * w + (x + dx).clamp(0, w - 1)) as usize] == WATER));
            if open && spots.iter().all(|&(sx, sy)| (sx - x).abs().max((sy - y).abs()) >= 4) {
                spots.push((x, y));
            }
        }
        for (x, y) in spots {
            for (px, py) in images(x, y) {
                feat[(py * w + px) as usize] = Feat::Fish;
            }
        }
    }

    // Half the maps are mirrored left to right, so the starts sit on the
    // other diagonal (top left and bottom right). Still symmetric and fair.
    let bases = if hash(7, 911, seed) < 0.5 {
        for y in 0..h {
            let row = (y * w) as usize..((y + 1) * w) as usize;
            terrain[row.clone()].reverse();
            shade[row.clone()].reverse();
            feat[row].reverse();
        }
        bases.into_iter().map(|(x, y)| (w - 1 - x, y)).collect()
    } else {
        bases
    };

    // The open sea all round: the land sits in the middle of a map
    // `OPEN_SEA` tiles wider on every side. (Still symmetric: the margin is.)
    let (iw, ih) = (w, h);
    let (w, h) = (iw + 2 * OPEN_SEA, ih + 2 * OPEN_SEA);
    let n = (w * h) as usize;
    let (mut t2, mut s2, mut f2) = (vec![WATER; n], vec![20u8; n], vec![Feat::None; n]);
    for y in 0..ih {
        for x in 0..iw {
            let (i, j) = (((y + OPEN_SEA) * w + x + OPEN_SEA) as usize, (y * iw + x) as usize);
            (t2[i], s2[i], f2[i]) = (terrain[j], shade[j], feat[j]);
        }
    }
    let (terrain, mut shade, mut feat) = (t2, s2, f2);
    let bases: Vec<(i32, i32)> = bases.into_iter().map(|(x, y)| (x + OPEN_SEA, y + OPEN_SEA)).collect();
    // Fishing spots out there: along each edge, half way out, and turned.
    let images = |x: i32, y: i32| syms.iter().map(move |s| s.apply(x, y, w, h));
    for k in 0..FISH_OPEN {
        let along = OPEN_SEA + iw * (2 * k + 1) / (2 * FISH_OPEN) + ((hash(k, 81, seed) - 0.5) * 6.0) as i32;
        for (x, y) in [(along, h - 1 - OPEN_SEA / 2), (OPEN_SEA / 2, along)] {
            for (px, py) in images(x, y) {
                feat[(py * w + px) as usize] = Feat::Fish;
            }
        }
    }

    // Turn features into deposits and mark blocked tiles.
    let mut deps = Vec::new();
    let mut blocked = vec![false; n];
    let mut dep_at = vec![-1; n];
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) as usize;
            if terrain[i] == WATER {
                blocked[i] = true;
                // (Boats sail over shoals: `sailable` goes by the terrain.)
                if feat[i] == Feat::Fish {
                    dep_at[i] = deps.len() as i32;
                    deps.push(Deposit { kind: Dep::Fish, tx: x, ty: y });
                }
                continue;
            }
            let kind = match feat[i] {
                Feat::None => continue,
                Feat::Tree => Dep::Forest,
                Feat::Fertile => Dep::Fertile,
                Feat::Stone => Dep::Stone,
                Feat::Horses => Dep::Horses,
                Feat::Game => Dep::Game,
                Feat::Iron => Dep::Iron,
                Feat::Clay => Dep::Clay,
                Feat::Hills => Dep::Hills,
                Feat::Nitrate => Dep::Nitrate,
                Feat::Coal => Dep::Coal,
                Feat::Oil => Dep::Oil,
                Feat::Bauxite => Dep::Bauxite,
                Feat::Uranium => Dep::Uranium,
                Feat::Fish => continue, // (only ever on water, above)
            };
            dep_at[i] = deps.len() as i32;
            blocked[i] = true;
            deps.push(Deposit { kind, tx: x, ty: y });
        }
    }

    // Beaches only by the water: the 3D view draws ground lower than
    // `SHADE_BEACH` as sand, so dips in the land that never reach the water
    // looked like dried-up lakes. Land more than two tiles from any water is
    // drawn at least that high. (Shade is for drawing only.)
    let floor = (SHADE_BEACH * 255.0).ceil() as u8;
    let wet = |x: i32, y: i32| x >= 0 && y >= 0 && x < w && y < h && matches!(terrain[(y * w + x) as usize], WATER | SHALLOW);
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) as usize;
            if !matches!(terrain[i], WATER | SHALLOW) && !(-2..=2).any(|dy| (-2..=2).any(|dx| wet(x + dx, y + dy))) {
                shade[i] = shade[i].max(floor);
            }
        }
    }

    let map = Map { w, h, terrain, shade, blocked, dep_at, bld_at: vec![-1; n] };
    (map, deps, bases)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deposits whose ground was water: an island of them in a lake.
    fn islands(seed: u32, players: usize) -> usize {
        let (m, deps, _) = generate(seed, players);
        deps.iter()
            .filter(|d| d.kind != Dep::Forest && d.kind != Dep::Fish)
            .filter(|d| {
                let mut wet = 0;
                for dy in -2..=2 {
                    for dx in -2..=2 {
                        let (x, y) = (d.tx + dx, d.ty + dy);
                        if m.inside(x, y) && m.terrain[m.idx(x, y)] == WATER {
                            wet += 1;
                        }
                    }
                }
                wet >= 6
            })
            .count()
    }

    /// Playtest: clay pits on an island in a lake. Deposits move to dry land.
    #[test]
    fn no_deposits_on_islands() {
        for seed in 0..40 {
            assert_eq!(islands(seed, 4) + islands(seed, 2), 0, "seed {seed}");
        }
    }

    /// Fewest free tiles between two deposits of different kinds (not trees).
    fn tightest(seed: u32, players: usize) -> f32 {
        let (_, deps, _) = generate(seed, players);
        // (Shoals are out on the water: nothing is built on them.)
        let d: Vec<_> = deps.iter().filter(|d| d.kind != Dep::Forest && d.kind != Dep::Fish).collect();
        let mut best = f32::MAX;
        for (i, a) in d.iter().enumerate() {
            for b in &d[i + 1..] {
                if a.kind != b.kind {
                    let (dx, dy) = ((a.tx - b.tx) as f32, (a.ty - b.ty) as f32);
                    best = best.min((dx * dx + dy * dy).sqrt());
                }
            }
        }
        best
    }

    /// Playtest: clay right next to the sheep hills. Different deposits keep
    /// room for a building between them.
    #[test]
    fn deposits_keep_their_distance() {
        let mut worst = f32::MAX;
        for seed in 0..40 {
            for players in [2, 4] {
                worst = worst.min(tightest(seed, players));
            }
        }
        println!("closest two different deposits: {worst:.1} tiles");
        assert!(worst >= 4.0, "two kinds of deposit only {worst:.1} tiles apart");
    }
}

#[cfg(test)]
mod dry_lakes {
    use super::*;
    /// No dried-up lakes: grass far from water is never drawn as beach (the
    /// 3D view draws ground below `SHADE_BEACH` as sand). Before, maps with
    /// low water had up to 600 such tiles, in wide sandy basins.
    #[test]
    fn grass_far_from_water_is_not_drawn_as_sand() {
        for players in [2usize, 4] {
            for seed in 1..=12u32 {
                let (m, _, _) = generate(seed, players);
                let mut n = 0;
                for y in 0..m.h {
                    for x in 0..m.w {
                        let i = m.idx(x, y);
                        let near_water = (-2..=2).any(|dy| (-2..=2).any(|dx| m.inside(x + dx, y + dy) && matches!(m.terrain[m.idx(x + dx, y + dy)], WATER | SHALLOW)));
                        if matches!(m.terrain[i], GRASS | HILL) && (m.shade[i] as f32) < SHADE_BEACH * 255.0 && !near_water {
                            n += 1;
                        }
                    }
                }
                assert_eq!(n, 0, "{players} players, seed {seed}: {n} tiles of grass far from water drawn as sand");
            }
        }
    }
}

#[cfg(test)]
mod crossing_rivers {
    use super::*;

    /// Tiles a walker can reach from (x, y), stepping to the four neighbours.
    fn walkable_from(m: &Map, x: i32, y: i32, fords: bool) -> Vec<bool> {
        let mut seen = vec![false; (m.w * m.h) as usize];
        let mut todo = vec![(x, y)];
        seen[m.idx(x, y)] = true;
        while let Some((x, y)) = todo.pop() {
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                let (nx, ny) = (x + dx, y + dy);
                if m.inside(nx, ny) && !seen[m.idx(nx, ny)] && !(m.terrain[m.idx(nx, ny)] == WATER || (!fords && m.terrain[m.idx(nx, ny)] == SHALLOW)) {
                    seen[m.idx(nx, ny)] = true;
                    todo.push((nx, ny));
                }
            }
        }
        seen
    }

    /// Some maps have a river from sea to sea through the middle, and every
    /// town can still walk to every other (over the fords).
    #[test]
    fn some_maps_have_a_river_across_and_every_town_is_still_reachable() {
        let mut crossed = 0;
        let mut maps = 0;
        for players in [2usize, 3, 4] {
            for seed in 1..=30u32 {
                let (m, _, bases) = generate(seed, players);
                maps += 1;
                let reach = walkable_from(&m, bases[0].0, bases[0].1, true);
                for &(bx, by) in &bases[1..] {
                    assert!(reach[m.idx(bx, by)], "{players} players, seed {seed}: a town can't be reached on foot");
                }
                // Without its fords, a river across cuts the first town off
                // from the next one round (the town on its other side).
                if hash(66, 911, seed) < CROSSING_RIVER_CHANCE {
                    crossed += 1;
                    let dry = walkable_from(&m, bases[0].0, bases[0].1, false);
                    assert!(bases[1..].iter().any(|&(bx, by)| !dry[m.idx(bx, by)]), "{players} players, seed {seed}: the river doesn't cross the map");
                }
            }
        }
        println!("{crossed} of {maps} maps have a river across");
        assert!(crossed > maps / 5 && crossed < maps * 2 / 3, "{crossed} of {maps}: not 'sometimes'");
    }
}

#[cfg(test)]
mod map_pictures {
    use super::*;
    /// Writes terrain pictures (PPM) for a look: VC_OUT dir, seeds 1..=8.
    #[test]
    #[ignore]
    fn draw_maps() {
        let out = std::env::var("VC_OUT").unwrap_or("/tmp".into());
        for players in [2usize, 4] {
            for seed in 1..=8u32 {
                let (m, deps, bases) = generate(seed, players);
                let mut px = vec![0u8; (m.w * m.h * 3) as usize];
                for i in 0..(m.w * m.h) as usize {
                    let c = match m.terrain[i] { WATER => [30, 80, 170], SHALLOW => [90, 170, 210], SAND => [210, 190, 120], HILL => [120, 140, 70], _ => [90, 170, 70] };
                    px[i * 3..i * 3 + 3].copy_from_slice(&c);
                }
                for d in &deps { let i = m.idx(d.tx, d.ty); px[i * 3..i * 3 + 3].copy_from_slice(&[60, 60, 60]); }
                for &(bx, by) in &bases { for dy in -1..=1 { for dx in -1..=1 { let i = m.idx(bx + dx, by + dy); px[i * 3..i * 3 + 3].copy_from_slice(&[230, 30, 30]); } } }
                let mut f = format!("P6 {} {} 255\n", m.w, m.h).into_bytes();
                f.extend_from_slice(&px);
                let cross = if hash(66, 911, seed) < CROSSING_RIVER_CHANCE { "x" } else { "" };
                std::fs::write(format!("{out}/map-{players}p-{seed}{cross}.ppm"), f).unwrap();
            }
        }
    }
}
