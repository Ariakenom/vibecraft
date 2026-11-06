//! The Frontier map: ten times the area of a Skirmish map, made of
//! continents. Every player's home continent has wood by the town and the
//! rest of the Ancient and Medieval deposits further out; later deposits are
//! only on the islands and the central continent, so a town has to sail.
//! Barbarian sites are scattered over every continent, each with the
//! deposits a town of its era needs; the nearer the middle, the higher the
//! era (see docs/design/frontier.md).
//!
//! Like Skirmish maps, it's symmetric: every start, island and site has its
//! turned images, so every player gets the same.

use crate::defs::Dep;
use crate::map::{dist, fbm, hash, ring_point, Deposit, Feat, Map, Sym, GRASS, HILL, OPEN_SEA, SAND, SHADE_BEACH, SHADE_WATER, WATER};

/// Land per side, before the open sea round it: ten times a Skirmish map's
/// area (120 and 144).
pub const LAND_2: i32 = 380;
pub const LAND_4: i32 = 455;
/// Fishing spots by every base.
const FISH_NEAR_BASE: usize = 6;
/// No barbarian site this close to a player's start.
const SITE_FROM_BASE: f32 = 48.0;
/// Barbarian sites at least this far apart.
const SITE_GAP: f32 = 34.0;

/// Where barbarians can settle, and the highest era a town there reaches.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Site {
    pub x: i32,
    pub y: i32,
    pub era: u8,
}

/// The era of a site at distance `d` from the map centre, where `far` is
/// the distance of a player's start: Ancient on the home continents,
/// Atomic in the middle.
pub fn site_era(d: f32, far: f32) -> u8 {
    ((1.0 - d / far) * 7.0 - 1.0).clamp(0.0, 5.0) as u8
}

/// Build a Frontier map for `players` (2 to 4). Returns the map, its
/// deposits, one base centre per player, and the barbarian sites.
pub fn generate_frontier(seed: u32, players: usize) -> (Map, Vec<Deposit>, Vec<(i32, i32)>, Vec<Site>) {
    let players = players.clamp(2, 4);
    let four = players > 2;
    let l = if four { LAND_4 } else { LAND_2 };
    let (w, h) = (l, l);
    let lf = l as f32;
    let n = (w * h) as usize;
    let syms: &[Sym] = if four { &[Sym::Id, Sym::Rot90, Sym::Rot180, Sym::Rot270] } else { &[Sym::Id, Sym::Rot180] };
    let images = |x: i32, y: i32| syms.iter().map(move |s| s.apply(x, y, w, h));
    let canon = |x: i32, y: i32| images(x, y).min_by_key(|&(a, b)| b * w + a).unwrap();
    let b1 = (30, h - 31);
    let base_order: &[Sym] = if four { &[Sym::Id, Sym::Rot180, Sym::Rot90, Sym::Rot270] } else { &[Sym::Id, Sym::Rot180] };
    let bases: Vec<(i32, i32)> = base_order.iter().take(players).map(|s| s.apply(b1.0, b1.1, w, h)).collect();
    let all_bases: Vec<(f32, f32)> = images(b1.0, b1.1).map(|(x, y)| (x as f32 + 0.5, y as f32 + 0.5)).collect();
    let centre = (lf / 2.0, lf / 2.0);
    let pick = |k: i32, lo: f32, hi: f32| lo + (hi - lo) * hash(k, 913, seed);
    let land_scale = pick(1, 14.0, 26.0);
    let water_at = 0.35;
    let hill_at = pick(3, 0.64, 0.72);
    let wood_scale = pick(4, 6.0, 10.0);
    let wood_at = pick(5, 0.54, 0.64);

    // The continents, (x, y, radius), in base 1's corner, then turned.
    // Home: round the start, leaning toward the middle. The middle. Islands
    // half way along each edge (and, on two-player maps, in the empty corners).
    let home = (b1.0 as f32 + 0.08 * lf, b1.1 as f32 - 0.08 * lf, if four { 0.24 } else { 0.26 } * lf);
    let mut canon_conts = vec![home, (centre.0, centre.1, 0.17 * lf), (lf / 2.0, 0.095 * lf, 0.10 * lf)];
    if !four {
        canon_conts.push((0.095 * lf, lf / 2.0, 0.10 * lf));
        canon_conts.push((0.2 * lf, 0.2 * lf, 0.11 * lf));
    }
    let turn = |x: f32, y: f32| syms.iter().map(move |s| s.apply(x as i32, y as i32, w, h)).map(|(a, b)| (a as f32, b as f32));
    let conts: Vec<(f32, f32, f32)> = canon_conts.iter().flat_map(|&(x, y, r)| turn(x, y).map(move |(a, b)| (a, b, r))).collect();
    // How far inside a continent a point is: 0 at its centre, 1 at its rim.
    let inside = |p: (f32, f32)| conts.iter().map(|&(x, y, r)| dist(p, (x, y)) / r).fold(f32::MAX, f32::min);

    let mut terrain = vec![WATER; n];
    let mut shade = vec![0u8; n];
    let mut feat = vec![Feat::None; n];
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) as usize;
            let (cx, cy) = canon(x, y);
            let p = (x as f32 + 0.5, y as f32 + 0.5);
            let noise = fbm(cx as f32 / land_scale, cy as f32 / land_scale, seed);
            let e = inside(p);
            // Land fades into sea toward a continent's rim, raggedly.
            let mut ht = noise * 0.55 + (1.0 - e) * 0.6 - 0.05;
            // Lakes inland, where the noise is low.
            if e < 0.6 && noise < 0.3 {
                ht = ht.min(water_at - 0.02);
            }
            // Dry ground round every start.
            let near = all_bases.iter().map(|&b| dist(p, b)).fold(f32::MAX, f32::min);
            if near < 24.0 {
                ht = ht.max(0.46 + (24.0 - near) / 24.0 * 0.1);
            }
            // Sea along the edges of the land.
            let edge = x.min(y).min(w - 1 - x).min(h - 1 - y);
            if edge < 4 {
                ht = ht.min(0.2);
            }
            let hills = fbm(cx as f32 / 9.0 + 70.0, cy as f32 / 9.0 + 70.0, seed ^ 0x411);
            terrain[i] = if ht < water_at {
                WATER
            } else if ht < water_at + 0.03 {
                SAND
            } else if hills > hill_at && near > 14.0 {
                HILL
            } else {
                GRASS
            };
            let drawn = if terrain[i] == WATER { ht } else { (water_at + 0.05 + (ht - water_at) * 0.4).min(0.62) + if terrain[i] == HILL { 0.18 } else { 0.0 } };
            shade[i] = ((drawn - water_at + SHADE_WATER).clamp(0.0, 1.0) * 255.0) as u8;
            let f = fbm(cx as f32 / wood_scale + 40.0, cy as f32 / wood_scale + 40.0, seed ^ 0xBEEF);
            if matches!(terrain[i], GRASS | HILL) && f > wood_at && hash(cx, cy, seed ^ 7) < 0.82 && near > 11.0 {
                feat[i] = Feat::Tree;
            }
        }
    }

    // Placing a cluster of a deposit on dry ground with room round it, on
    // every image alike. (As on Skirmish maps; `generate` in map.rs.)
    const GAP: f32 = 4.0;
    let dry = |terrain: &[u8], cx: i32, cy: i32, r: f32| {
        let ri = r.ceil() as i32 + 2;
        (-ri..=ri).all(|dy| {
            (-ri..=ri).all(|dx| {
                let (x, y) = (cx + dx, cy + dy);
                let d = ((dx * dx + dy * dy) as f32).sqrt();
                d > r + 2.0 || (x >= 1 && y >= 1 && x < w - 1 && y < h - 1 && !matches!(terrain[(y * w + x) as usize], WATER | SAND))
            })
        })
    };
    let roomy = |feat: &[Feat], cx: i32, cy: i32, r: f32, f: Feat| {
        let ri = (r + GAP).ceil() as i32;
        images(cx, cy).all(|(ix, iy)| {
            (-ri..=ri).all(|dy| {
                (-ri..=ri).all(|dx| {
                    let (x, y) = (ix + dx, iy + dy);
                    let d = ((dx * dx + dy * dy) as f32).sqrt();
                    d > r + GAP || !(x >= 0 && y >= 0 && x < w && y < h) || matches!(feat[(y * w + x) as usize], Feat::None | Feat::Tree) || feat[(y * w + x) as usize] == f
                })
            })
        })
    };
    // Spots that must stay clear (town and camp sites): no deposit within `r`.
    let mut keep_clear: Vec<(f32, f32, f32)> = all_bases.iter().map(|&(x, y)| (x, y, 10.0)).collect();
    let clear_of = |keep: &[(f32, f32, f32)], cx: i32, cy: i32, r: f32| {
        images(cx, cy).all(|(ix, iy)| keep.iter().all(|&(x, y, k)| dist((ix as f32, iy as f32), (x, y)) > k + r + 1.0))
    };
    let place = |terrain: &mut Vec<u8>, feat: &mut Vec<Feat>, keep: &[(f32, f32, f32)], cx: i32, cy: i32, f: Feat, r: f32, ring_max: i32| -> bool {
        let mut at = None;
        'search: for ring in 0..=ring_max {
            for k in 0..(8 * ring).max(1) {
                let (dx, dy) = if ring == 0 { (0, 0) } else { ring_point(ring, k) };
                let (x, y) = (cx + dx, cy + dy);
                if dry(terrain, x, y, r) && roomy(feat, x, y, r, f) && clear_of(keep, x, y, r) {
                    at = Some((x, y));
                    break 'search;
                }
            }
        }
        let Some((cx, cy)) = at else { return false };
        let ri = r.ceil() as i32 + 2;
        for dy in -ri..=ri {
            for dx in -ri..=ri {
                let (x, y) = (cx + dx, cy + dy);
                if x < 1 || y < 1 || x >= w - 1 || y >= h - 1 {
                    continue;
                }
                let d = ((dx * dx + dy * dy) as f32).sqrt();
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
                let keep = match f {
                    Feat::Fertile | Feat::Horses | Feat::Game | Feat::Hills => (dx + dy) % 2 == 0,
                    _ => true,
                };
                if keep {
                    for (px, py) in images(x, y) {
                        let i = (py * w + px) as usize;
                        if matches!(terrain[i], WATER | SAND) {
                            terrain[i] = GRASS;
                        }
                        feat[i] = f;
                    }
                }
            }
        }
        true
    };

    // The home continent: wood by the town, the rest in bands further out,
    // in the quarter that faces the middle.
    let bands: [(f32, f32, &[(Feat, f32)]); 4] = [
        (26.0, 40.0, &[(Feat::Stone, 1.5), (Feat::Fertile, 2.4), (Feat::Game, 2.2)]),
        (40.0, 58.0, &[(Feat::Stone, 1.5), (Feat::Fertile, 2.2), (Feat::Game, 2.0), (Feat::Horses, 1.6)]),
        (58.0, 80.0, &[(Feat::Clay, 1.6), (Feat::Hills, 1.6), (Feat::Iron, 1.5)]),
        (80.0, 100.0, &[(Feat::Nitrate, 1.4), (Feat::Iron, 1.5), (Feat::Clay, 1.6)]),
    ];
    let mut k = 0;
    for (lo, hi, kinds) in bands {
        for (j, &(f, r)) in kinds.iter().enumerate() {
            k += 1;
            // Spread over the quarter facing the middle (-95° to 5°, y down).
            let a = (-95.0 + 100.0 * (j as f32 + 0.25 + hash(k, 51, seed) * 0.5) / kinds.len() as f32).to_radians();
            let d = lo + (hi - lo) * hash(k, 53, seed);
            let (x, y) = (b1.0 + (a.cos() * d) as i32, b1.1 + (a.sin() * d) as i32);
            place(&mut terrain, &mut feat, &keep_clear, x, y, f, r, 14);
        }
    }
    // The islands and the middle: the later eras' deposits.
    let later: Vec<(usize, &[(Feat, f32)])> = {
        let side: &[(Feat, f32)] = &[(Feat::Coal, 1.5), (Feat::Coal, 1.5), (Feat::Nitrate, 1.4), (Feat::Iron, 1.5), (Feat::Stone, 1.5)];
        let mid: &[(Feat, f32)] = &[(Feat::Oil, 1.3), (Feat::Oil, 1.3), (Feat::Bauxite, 1.4), (Feat::Bauxite, 1.4), (Feat::Uranium, 1.3), (Feat::Uranium, 1.3), (Feat::Coal, 1.5)];
        let corner: &[(Feat, f32)] = &[(Feat::Coal, 1.5), (Feat::Oil, 1.3), (Feat::Bauxite, 1.4), (Feat::Stone, 1.5)];
        let mut v: Vec<(usize, &[(Feat, f32)])> = vec![(1, mid), (2, side)];
        if !four {
            v.push((3, side));
            v.push((4, corner));
        }
        v
    };
    for (c, kinds) in later {
        let (cx, cy, r) = canon_conts[c];
        for (j, &(f, fr)) in kinds.iter().enumerate() {
            k += 1;
            let a = (j as f32 / kinds.len() as f32 + hash(k, 55, seed) * 0.15) * std::f32::consts::TAU;
            let d = r * (0.3 + 0.3 * hash(k, 57, seed));
            place(&mut terrain, &mut feat, &keep_clear, (cx + a.cos() * d) as i32, (cy + a.sin() * d) as i32, f, fr, 16);
        }
    }

    // Barbarian sites: spots on land, apart from each other and from the
    // starts, each with the deposits a town of its era needs round it.
    let far = dist(all_bases[0], centre);
    let mut sites: Vec<Site> = Vec::new();
    let want = if four { 10 } else { 13 };
    let mut tries = 0;
    while sites.len() < want && tries < 4000 {
        tries += 1;
        let (x, y) = ((hash(tries, 61, seed) * lf) as i32, (hash(tries, 63, seed) * lf) as i32);
        let p = (x as f32 + 0.5, y as f32 + 0.5);
        if inside(p) > 0.66 || !matches!(terrain[(y * w + x) as usize], GRASS | HILL) || !dry(&terrain, x, y, 8.0) {
            continue;
        }
        let imgs: Vec<(f32, f32)> = images(x, y).map(|(a, b)| (a as f32 + 0.5, b as f32 + 0.5)).collect();
        let apart = imgs.iter().enumerate().all(|(i, &q)| imgs[i + 1..].iter().all(|&o| dist(q, o) >= SITE_GAP));
        let from_bases = imgs.iter().all(|&q| all_bases.iter().all(|&b| dist(q, b) >= SITE_FROM_BASE));
        let from_sites = imgs.iter().all(|&q| sites.iter().all(|s| images(s.x, s.y).all(|(a, b)| dist(q, (a as f32 + 0.5, b as f32 + 0.5)) >= SITE_GAP)));
        if !(apart && from_bases && from_sites) {
            continue;
        }
        sites.push(Site { x, y, era: site_era(dist(p, centre), far) });
    }
    for s in &sites {
        keep_clear.push((s.x as f32 + 0.5, s.y as f32 + 0.5, 6.0));
    }
    for (si, s) in sites.iter().enumerate() {
        // A forest first, as by a Skirmish start: wood is what every era
        // waits for.
        // Food for houses that want three kinds, as much as a start has.
        let mut kinds: Vec<(Feat, f32)> = vec![(Feat::Tree, 3.4), (Feat::Stone, 1.5), (Feat::Fertile, 2.4), (Feat::Game, 2.4), (Feat::Fertile, 2.2), (Feat::Game, 2.2), (Feat::Stone, 1.5)];
        if s.era >= 1 {
            kinds.extend([(Feat::Iron, 1.5), (Feat::Clay, 1.6), (Feat::Hills, 1.6), (Feat::Horses, 1.6), (Feat::Clay, 1.5)]);
        }
        if s.era >= 2 {
            kinds.push((Feat::Nitrate, 1.3));
        }
        if s.era >= 3 {
            kinds.push((Feat::Coal, 1.4));
        }
        if s.era >= 4 {
            kinds.extend([(Feat::Oil, 1.3), (Feat::Bauxite, 1.3)]);
        }
        if s.era >= 5 {
            kinds.push((Feat::Uranium, 1.3));
        }
        // Each round the site, trying other directions and distances until
        // one fits (sites near a coast have less room).
        for (j, &(f, r)) in kinds.iter().enumerate() {
            let a0 = (j as f32 / kinds.len() as f32 + hash(si as i32, 65, seed)) * std::f32::consts::TAU;
            'tries: for t in 0..40 {
                let a = a0 + t as f32 * 0.7;
                let d = 9.0 + 2.0 * ((j + t) % 6) as f32 + if t >= 24 { 4.0 } else { 0.0 };
                if place(&mut terrain, &mut feat, &keep_clear, s.x + (a.cos() * d) as i32, s.y + (a.sin() * d) as i32, f, r, 3) {
                    break 'tries;
                }
            }
        }
    }
    // Clear the town and camp sites themselves.
    let clear_round = |terrain: &mut Vec<u8>, feat: &mut Vec<Feat>, x: i32, y: i32, r: i32| {
        for (ix, iy) in images(x, y) {
            for yy in iy - r..=iy + r {
                for xx in ix - r..=ix + r {
                    if xx >= 1 && yy >= 1 && xx < w - 1 && yy < h - 1 {
                        let i = (yy * w + xx) as usize;
                        feat[i] = Feat::None;
                        terrain[i] = GRASS;
                    }
                }
            }
        }
    };
    clear_round(&mut terrain, &mut feat, b1.0, b1.1, 4);
    for s in &sites {
        clear_round(&mut terrain, &mut feat, s.x, s.y, 4);
    }

    // Tidy the shores (as in `generate`).
    for _ in 0..2 {
        let before = terrain.clone();
        for y in 1..h - 1 {
            for x in 1..w - 1 {
                let i = (y * w + x) as usize;
                if feat[i] != Feat::None {
                    continue;
                }
                let wet = [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)].iter().filter(|&&(dx, dy)| before[((y + dy) * w + x + dx) as usize] == WATER).count();
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
    clear_round(&mut terrain, &mut feat, b1.0, b1.1, 4);

    // Fishing spots: the sea nearest each start, and shoals scattered over
    // the open water between the continents.
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
    let open = |terrain: &[u8], x: i32, y: i32| (-1..=1).all(|dy| (-1..=1).all(|dx| terrain[((y + dy).clamp(0, h - 1) * w + (x + dx).clamp(0, w - 1)) as usize] == WATER));
    let mut spots: Vec<(i32, i32)> = Vec::new();
    let mut near: Vec<(i32, i32, i32)> = (0..h).flat_map(|y| (0..w).map(move |x| (x, y))).filter(|&(x, y)| sea[(y * w + x) as usize]).map(|(x, y)| ((x - b1.0).pow(2) + (y - b1.1).pow(2), x, y)).collect();
    near.sort();
    for (_, x, y) in near {
        if spots.len() >= FISH_NEAR_BASE {
            break;
        }
        if open(&terrain, x, y) && spots.iter().all(|&(sx, sy)| (sx - x).abs().max((sy - y).abs()) >= 4) {
            spots.push((x, y));
        }
    }
    let mut shoals = 0;
    for t in 0..3000 {
        if shoals >= l / 8 {
            break;
        }
        let (x, y) = ((hash(t, 71, seed) * lf) as i32, (hash(t, 73, seed) * lf) as i32);
        if x < 2 || y < 2 || x >= w - 2 || y >= h - 2 || !sea[(y * w + x) as usize] || !open(&terrain, x, y) {
            continue;
        }
        if spots.iter().all(|&(sx, sy)| images(sx, sy).all(|(a, b)| (a - x).abs().max((b - y).abs()) >= 12)) {
            spots.push((x, y));
            shoals += 1;
        }
    }
    for (x, y) in spots {
        for (px, py) in images(x, y) {
            feat[(py * w + px) as usize] = Feat::Fish;
        }
    }

    // The open sea all round, as on Skirmish maps.
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
    let (terrain, mut shade, feat) = (t2, s2, f2);
    let bases: Vec<(i32, i32)> = bases.into_iter().map(|(x, y)| (x + OPEN_SEA, y + OPEN_SEA)).collect();
    let sites: Vec<Site> = sites.iter().flat_map(|s| images(s.x, s.y).map(move |(x, y)| Site { x: x + OPEN_SEA, y: y + OPEN_SEA, era: s.era })).collect();

    let mut deps = Vec::new();
    let mut blocked = vec![false; n];
    let mut dep_at = vec![-1; n];
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) as usize;
            if terrain[i] == WATER {
                blocked[i] = true;
                if feat[i] == Feat::Fish {
                    dep_at[i] = deps.len() as i32;
                    deps.push(Deposit { kind: Dep::Fish, tx: x, ty: y });
                }
                continue;
            }
            let kind = match feat[i] {
                Feat::None | Feat::Fish => continue,
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
    // Beaches only by the water (as in `generate`).
    let floor = (SHADE_BEACH * 255.0).ceil() as u8;
    let wet = |x: i32, y: i32| x >= 0 && y >= 0 && x < w && y < h && terrain[(y * w + x) as usize] == WATER;
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) as usize;
            if terrain[i] != WATER && !(-2..=2).any(|dy| (-2..=2).any(|dx| wet(x + dx, y + dy))) {
                shade[i] = shade[i].max(floor);
            }
        }
    }
    let map = Map { w, h, terrain, shade, blocked, dep_at, bld_at: vec![-1; n] };
    (map, deps, bases, sites)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A picture of the map, one character per 4×4 tiles, for looking at.
    /// `cargo test --release frontier_picture -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn frontier_picture() {
        let env = |k: &str, d: u32| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
        let (m, deps, bases, sites) = generate_frontier(env("VC_SEED", 7), env("VC_PLAYERS", 2) as usize);
        let s = 4;
        for by in 0..m.h / s {
            let mut line = String::new();
            for bx in 0..m.w / s {
                let tiles: Vec<(i32, i32)> = (0..s).flat_map(|dy| (0..s).map(move |dx| (bx * s + dx, by * s + dy))).collect();
                let c = if bases.iter().any(|&(x, y)| x / s == bx && y / s == by) {
                    '@'
                } else if let Some(site) = sites.iter().find(|t| t.x / s == bx && t.y / s == by) {
                    (b'0' + site.era) as char
                } else if let Some(d) = tiles.iter().filter_map(|&(x, y)| deps.get(m.dep_at[m.idx(x, y)].max(0) as usize).filter(|_| m.dep_at[m.idx(x, y)] >= 0)).find(|d| !matches!(d.kind, Dep::Forest | Dep::Fish)) {
                    match d.kind {
                        Dep::Stone => 'S',
                        Dep::Fertile => 'F',
                        Dep::Game => 'G',
                        Dep::Horses => 'H',
                        Dep::Iron => 'I',
                        Dep::Clay => 'C',
                        Dep::Hills => 'h',
                        Dep::Nitrate => 'N',
                        Dep::Coal => 'K',
                        Dep::Oil => 'O',
                        Dep::Bauxite => 'B',
                        Dep::Uranium => 'U',
                        _ => '?',
                    }
                } else {
                    let wet = tiles.iter().filter(|&&(x, y)| m.terrain[m.idx(x, y)] == WATER).count();
                    let trees = tiles.iter().filter(|&&(x, y)| m.dep_at[m.idx(x, y)] >= 0).count();
                    if wet > 8 { '~' } else if trees > 6 { 't' } else { '.' }
                };
                line.push(c);
            }
            println!("{line}");
        }
        println!("{} sites: eras {:?}", sites.len(), sites.iter().map(|s| s.era).collect::<Vec<_>>());
    }

    /// Fair: every start sees the same deposits (turned), and has wood near,
    /// no stone, food or clay within 22 tiles, and the later deposits only
    /// across water.
    #[test]
    fn frontier_starts() {
        for players in [2, 4] {
            for seed in 0..6 {
                let (m, deps, bases, sites) = generate_frontier(seed, players);
                assert!(sites.len() >= 16, "seed {seed}: only {} sites", sites.len());
                for &(bx, by) in &bases {
                    let near = |r: f32, k: Dep| deps.iter().filter(|d| d.kind == k && dist((d.tx as f32, d.ty as f32), (bx as f32, by as f32)) < r).count();
                    assert!(near(16.0, Dep::Forest) > 10, "seed {seed}: no wood by the start");
                    for k in [Dep::Stone, Dep::Fertile, Dep::Game, Dep::Clay, Dep::Iron] {
                        assert_eq!(near(22.0, k), 0, "seed {seed}: {k:?} at the start");
                    }
                    assert!(near(60.0, Dep::Stone) > 0, "seed {seed}: no stone on the way out");
                    assert!(!m.blocked[m.idx(bx, by)]);
                }
                let count = |k: Dep| deps.iter().filter(|d| d.kind == k).count();
                for k in [Dep::Stone, Dep::Fertile, Dep::Game, Dep::Iron, Dep::Clay, Dep::Coal, Dep::Oil, Dep::Bauxite, Dep::Uranium] {
                    assert!(count(k) > 0, "seed {seed} {players}p: no {k:?} at all");
                }
            }
        }
    }
}

#[cfg(test)]
mod site_tests {
    use super::*;
    /// Every barbarian site has what its era needs within reach.
    #[test]
    fn sites_have_their_deposits() {
        let mut missing = Vec::new();
        for players in [2, 4] {
            for seed in 0..6 {
                let (_, deps, _, sites) = generate_frontier(seed, players);
                for (i, s) in sites.iter().enumerate() {
                    let mut need = vec![Dep::Forest, Dep::Stone, Dep::Fertile, Dep::Game];
                    if s.era >= 1 {
                        need.extend([Dep::Iron, Dep::Clay, Dep::Hills, Dep::Horses]);
                    }
                    for k in need {
                        if !deps.iter().any(|d| d.kind == k && dist((d.tx as f32, d.ty as f32), (s.x as f32, s.y as f32)) < 26.0) {
                            missing.push(format!("{players}p seed {seed} site {i} era {}: {k:?}", s.era));
                        }
                    }
                }
            }
        }
        assert!(missing.is_empty(), "{} missing:\n{}", missing.len(), missing.join("\n"));
    }
}
