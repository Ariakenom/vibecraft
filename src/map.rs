//! The tile map: terrain, which tiles are blocked, and where deposits sit.
//! Also the procedural map generator.

use crate::defs::Dep;

pub const MAP_W: i32 = 120;
pub const MAP_H: i32 = 120;
/// How far apart a base's deposits are, against the first maps (80 tiles).
const SPREAD: f32 = 1.5;
/// Tiles of sea along every edge of the map.
const COAST: i32 = 3;

pub const GRASS: u8 = 0;
pub const WATER: u8 = 1;
pub const SAND: u8 = 2;
pub const HILL: u8 = 3;
/// Where a nuke fell: blocked for good.
pub const CRATER: u8 = 4;

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
    pub fn passable_at(&self, x: f32, y: f32) -> bool {
        self.passable(x.floor() as i32, y.floor() as i32)
    }

    /// Can a unit of radius ~0.25 walk in a straight line from a to b?
    /// Used to straighten the zig-zag tile paths that A* returns.
    pub fn line_clear(&self, a: (f32, f32), b: (f32, f32)) -> bool {
        let (dx, dy) = (b.0 - a.0, b.1 - a.1);
        let len = (dx * dx + dy * dy).sqrt();
        let steps = (len / 0.2).ceil().max(1.0) as i32;
        const R: f32 = 0.24;
        for s in 0..=steps {
            let t = s as f32 / steps as f32;
            let (x, y) = (a.0 + dx * t, a.1 + dy * t);
            for (ox, oy) in [(-R, -R), (R, -R), (-R, R), (R, R)] {
                if !self.passable_at(x + ox, y + oy) {
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
            let mut ht = fbm(cx as f32 / 15.0, cy as f32 / 15.0, seed);
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
            // The sea all round: a few tiles of water along every edge,
            // shelving up to the land (a little ragged).
            let edge = x.min(y).min(w - 1 - x).min(h - 1 - y);
            if edge < COAST + 3 {
                let wobble = hash(cx, cy, seed ^ 0x5EA) * 0.03;
                ht = ht.min(0.24 + 0.035 * edge as f32 + wobble);
            }
            terrain[i] = if ht < 0.34 {
                WATER
            } else if ht < 0.375 {
                SAND
            } else if ht > 0.70 {
                HILL
            } else {
                GRASS
            };
            shade[i] = (ht.clamp(0.0, 1.0) * 255.0) as u8;

            // Forests from a second noise layer.
            let f = fbm(cx as f32 / 7.0 + 40.0, cy as f32 / 7.0 + 40.0, seed ^ 0xBEEF);
            let near_base = all_bases.iter().any(|&b| dist(p, b) < 11.0);
            if (terrain[i] == GRASS || terrain[i] == HILL) && f > 0.6 && hash(cx, cy, seed ^ 7) < 0.82 && !near_base && road > 2.5 {
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
    let mut place = |cx: i32, cy: i32, f: Feat, r: f32| {
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
                        if terrain[i] == WATER || terrain[i] == SAND {
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
    for (dx, dy, f, r) in clusters {
        let s = |v: i32| (v as f32 * SPREAD).round() as i32;
        place(b1.0 + s(dx), b1.1 + s(dy), f, r);
    }
    for (x, y, f, r) in neutral {
        place(x * w / 80, y * h / 80, f, r);
    }
    // A pond by every base, so every start has fish: houses need three
    // different foods to grow, and the others are few.
    let pond = (b1.0 - 5, b1.1 + 12);
    for dy in -2..=2 {
        for dx in -2..=2 {
            let (x, y) = (pond.0 + dx, pond.1 + dy);
            if (dx * dx + dy * dy) as f32 > 2.6 || x < 1 || y < 1 || x >= w - 1 || y >= h - 1 {
                continue;
            }
            for (px, py) in images(x, y) {
                let i = (py * w + px) as usize;
                terrain[i] = WATER;
                shade[i] = shade[i].min(70);
                feat[i] = Feat::None;
            }
        }
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

    // Turn features into deposits and mark blocked tiles.
    let mut deps = Vec::new();
    let mut blocked = vec![false; n];
    let mut dep_at = vec![-1; n];
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) as usize;
            if terrain[i] == WATER {
                blocked[i] = true;
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
            };
            dep_at[i] = deps.len() as i32;
            blocked[i] = true;
            deps.push(Deposit { kind, tx: x, ty: y });
        }
    }

    let map = Map { w, h, terrain, shade, blocked, dep_at, bld_at: vec![-1; n] };
    (map, deps, bases)
}
