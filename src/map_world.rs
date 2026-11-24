//! The World map: the Earth's continents on a round map. It is the world as
//! seen from above the North Pole (an azimuthal map, like the one on the UN's
//! flag): the Arctic in the middle, Europe and Africa toward the bottom,
//! Asia on the right, the Americas on the left, and the map ends in a circle
//! at 58° south. Past the circle there is nothing (`EDGE`).
//!
//! The land is the real world's: Natural Earth's coastlines and lakes on a
//! grid of quarter degrees (`earth.rle`, `lakes.rle`, from
//! `assets/earth.py`), with the great mountain ranges drawn in by hand
//! (`RANGES`).
//!
//! Unlike the other maps it isn't symmetric: every player starts in a
//! different part of the world, with the same deposits laid round their
//! town; the rest of the world's deposits and its barbarian sites are
//! scattered, so some starts are better placed than others. It plays as a
//! Frontier game (barbarians, the big map's rules).
//!
//! The Globe (`Shape::Globe`) is the same world on a ball: the six faces
//! of a cube (cube.rs), each a square grid, turned (`TURN`) so the cube's
//! eight corners, where tiles are skewed most, lie out at sea. Things are
//! drawn between 0.67 and 1.15 times their size anywhere on it, so Europe
//! is as big as Africa. The page bends what it draws round the ball
//! (render3d.js, `GLOBE`). The poles are ordinary ground, the Arctic's pack
//! ice walkable from Siberia to Canada.

use crate::defs::Dep;
use crate::cube;
use crate::map::{fbm3, place_whales, raise_sheep_hills, settle_mountains, thin_forests, dist, fbm, hash, liking, reach, ring_point, shape_fits, shape_tiles, Deposit, Feat, Map, Sym, EDGE, GRASS, HILL, ICE, MOUNTAIN, SAND, SHADE_BEACH, SHADE_WATER, SHALLOW, WATER};
use crate::map_frontier::Site;

/// The map's radius in tiles, and the radius of 58° south (sea beyond it).
pub const RADIUS: i32 = 212;
const LAT_RADIUS: f32 = 200.0;
/// Latitudes the disc covers: the pole in the middle to this far south.
const SOUTH: f32 = -58.0;

/// How the Globe's cube is turned in the world: a direction in the cube's
/// frame (cube.rs) times this is one in the Earth's (y to the North Pole,
/// z to 0° east on the equator, x to 90° east). Found by a search for the
/// turn putting every corner furthest from land: all are 4.5° or more out
/// at sea (Norwegian Sea, off Brazil, Arabian Sea, South Atlantic, North
/// and East Pacific, Arafura Sea, Ross Sea).
pub const TURN: [[f32; 3]; 3] = [
    [-0.103_653_767, 0.729_875_374, -0.675_675_836],
    [-0.284_759_872, -0.672_675_043, -0.682_949_56],
    [-0.952_978_337, 0.121_615_07, 0.277_564_52],
];

/// The Earth's direction of a point of the Globe's atlas.
pub fn earth_dir(x: f32, y: f32) -> [f32; 3] {
    let d = cube::dir(x, y);
    [0, 1, 2].map(|i| (0..3).map(|j| TURN[i][j] * d[j]).sum())
}
/// Latitude and longitude (degrees) of a point of the Globe's atlas.
pub fn lat_lon(x: f32, y: f32) -> (f32, f32) {
    let e = earth_dir(x, y);
    (e[1].clamp(-1.0, 1.0).asin().to_degrees(), e[0].atan2(e[2]).to_degrees())
}
/// The point of the Globe's atlas at a latitude and longitude.
pub fn globe_tile(lat: f32, lon: f32) -> (f32, f32) {
    let (la, lo) = (lat.to_radians(), lon.to_radians());
    let e = [la.cos() * lo.sin(), la.sin(), la.cos() * lo.cos()];
    cube::at_dir([0, 1, 2].map(|j| (0..3).map(|i| TURN[i][j] * e[i]).sum()))
}

/// How the world is laid out.
#[derive(Clone, Copy, PartialEq)]
pub enum Shape {
    /// Round and flat, the North Pole in the middle.
    Disc,
    /// A cube's faces the page bends round a ball.
    Globe,
}

/// The Earth's land (not its lakes): Natural Earth's 1:50m on a grid of
/// quarter degrees (1440 x 720, from 180° west and 90° north), stored as
/// runs (`assets/earth.py` makes it).
static EARTH_RLE: &[u8] = include_bytes!("earth.rle");
const EARTH_COLS: usize = 1440;
const EARTH_ROWS: usize = 720;
const EARTH_STEP: f32 = 0.25;

/// The lakes (Natural Earth's), on the same grid.
static LAKES_RLE: &[u8] = include_bytes!("lakes.rle");

/// A grid from its runs, one bool a cell, row by row.
fn earth() -> Vec<bool> {
    decode(EARTH_RLE)
}
fn decode(rle: &[u8]) -> Vec<bool> {
    let mut grid = Vec::with_capacity(EARTH_COLS * EARTH_ROWS);
    let mut land = false;
    let mut in_row = 0;
    for run in rle.chunks_exact(2) {
        let n = u16::from_le_bytes([run[0], run[1]]) as usize;
        grid.extend(std::iter::repeat_n(land, n));
        in_row += n;
        land = !land;
        if in_row == EARTH_COLS {
            in_row = 0;
            land = false;
        }
    }
    debug_assert_eq!(grid.len(), EARTH_COLS * EARTH_ROWS);
    grid
}

/// How much of the ground at (lat, lon) is land, 0 to 1: the grid,
/// smoothed between its cells and over about half a degree round, so the
/// coast is soft enough for the noise to give it a little wobble.
fn land(grid: &[bool], lat: f32, lon: f32) -> f32 {
    let cell = |r: i32, c: i32| -> f32 {
        if r < 0 || r >= EARTH_ROWS as i32 {
            return 0.0;
        }
        grid[r as usize * EARTH_COLS + c.rem_euclid(EARTH_COLS as i32) as usize] as u8 as f32
    };
    let at = |lat: f32, lon: f32| {
        let (fr, fc) = ((90.0 - lat) / EARTH_STEP - 0.5, (lon + 180.0) / EARTH_STEP - 0.5);
        let (r0, c0) = (fr.floor(), fc.floor());
        let (tr, tc) = (fr - r0, fc - c0);
        let (r0, c0) = (r0 as i32, c0 as i32);
        let top = cell(r0, c0) * (1.0 - tc) + cell(r0, c0 + 1) * tc;
        let bottom = cell(r0 + 1, c0) * (1.0 - tc) + cell(r0 + 1, c0 + 1) * tc;
        top * (1.0 - tr) + bottom * tr
    };
    const R: f32 = 0.3;
    let wide = R / lat.to_radians().cos().max(0.2);
    (at(lat, lon) * 2.0 + at(lat + R, lon) + at(lat - R, lon) + at(lat, lon + wide) + at(lat, lon - wide)) / 6.0
}

/// The great mountain ranges and some lesser hill country, drawn by hand
/// from the atlas: each a line of (latitude, longitude) points, its half
/// width in degrees, and how high it stands (2: mountains in hills; 1:
/// hills only).
const RANGES: &[(&[(f32, f32)], f32, u8)] = &[
    // Himalaya, Karakoram and Hindu Kush, Kunlun, Tian Shan, Altai.
    (&[(35.5, 70.0), (35.8, 74.5), (34.0, 77.5), (30.5, 80.5), (28.3, 85.0), (27.8, 89.0), (28.0, 93.0), (28.3, 97.0)], 1.6, 2),
    (&[(34.5, 67.0), (36.0, 71.0), (36.0, 76.0)], 1.2, 2),
    (&[(36.2, 78.0), (35.8, 84.0), (35.6, 90.0), (35.0, 96.0)], 1.0, 2),
    (&[(41.0, 69.0), (42.0, 75.0), (42.8, 81.0), (43.3, 87.0)], 1.2, 2),
    (&[(50.5, 84.0), (49.0, 89.0), (47.0, 94.0)], 1.0, 2),
    // The Tibetan plateau: high hill country.
    (&[(32.0, 80.0), (33.0, 86.0), (32.5, 92.0)], 3.0, 1),
    // Pamir, Zagros, Elburz, Caucasus, Taurus.
    (&[(37.0, 44.0), (34.5, 47.0), (31.0, 50.5), (28.0, 55.0)], 1.0, 2),
    (&[(36.5, 50.5), (36.0, 53.5)], 0.6, 2),
    (&[(43.5, 40.0), (42.8, 44.0), (41.8, 47.5)], 0.8, 2),
    (&[(36.8, 30.0), (37.3, 34.0), (38.2, 38.5)], 0.7, 1),
    // Alps, Pyrenees, Carpathians, Balkans, Apennines, Scandinavia, Urals.
    (&[(43.9, 6.8), (45.9, 7.2), (46.5, 9.5), (46.9, 12.0), (47.3, 14.5)], 0.8, 2),
    (&[(42.8, -1.5), (42.6, 2.0)], 0.5, 2),
    (&[(49.2, 18.5), (48.8, 22.5), (47.5, 25.0), (45.6, 25.0), (45.0, 22.0)], 0.6, 1),
    (&[(45.5, 15.5), (43.5, 18.0), (42.0, 20.0), (40.0, 21.5)], 0.6, 1),
    (&[(44.2, 10.0), (42.5, 13.2), (40.5, 15.5), (38.8, 16.3)], 0.5, 1),
    (&[(69.5, 20.0), (67.0, 16.0), (64.0, 13.0), (61.5, 8.5)], 0.9, 2),
    (&[(67.5, 65.5), (63.0, 59.5), (58.0, 59.0), (53.0, 58.5)], 0.7, 1),
    // Atlas, Ethiopian highlands, Kilimanjaro, Ruwenzori, Drakensberg.
    (&[(30.5, -9.0), (32.0, -5.5), (34.0, -1.0), (35.5, 5.5)], 0.8, 2),
    (&[(13.5, 38.0), (10.0, 38.5), (7.0, 38.5)], 1.5, 2),
    (&[(-3.1, 37.4)], 0.6, 2),
    (&[(0.4, 29.9)], 0.5, 2),
    (&[(-27.5, 29.8), (-29.8, 29.0), (-31.8, 27.5)], 0.6, 2),
    // The Rockies, the Coast Mountains and Cascades and Sierra Nevada, the
    // Sierra Madre, the Alaska Range, the Brooks Range, the Appalachians.
    (&[(62.0, -130.0), (57.0, -124.0), (52.0, -117.5), (47.5, -113.5), (43.5, -110.0), (39.0, -106.0), (35.0, -106.0)], 1.6, 2),
    (&[(58.0, -131.0), (53.0, -126.5), (49.0, -121.5), (45.0, -121.8), (41.0, -122.0), (38.0, -119.5), (36.0, -118.3)], 0.8, 2),
    (&[(30.0, -108.0), (25.0, -105.5), (20.0, -102.0), (17.5, -97.5)], 1.0, 2),
    (&[(61.0, -153.0), (63.0, -149.0), (62.5, -143.0), (60.5, -140.0)], 1.0, 2),
    (&[(68.0, -160.0), (68.3, -152.0), (68.8, -144.0)], 0.8, 1),
    (&[(34.0, -84.5), (36.5, -81.5), (39.5, -78.5), (42.0, -75.0), (44.5, -71.5)], 0.9, 1),
    // The Andes.
    (&[(10.0, -72.5), (6.0, -75.5), (1.0, -77.5), (-4.0, -79.0), (-9.0, -77.5), (-14.0, -73.5), (-17.5, -69.5), (-22.0, -67.5), (-27.0, -68.5), (-32.5, -70.0), (-38.0, -71.0), (-43.0, -72.0), (-48.0, -73.0), (-52.0, -73.0)], 1.5, 2),
    // The Brazilian highlands, the Guiana highlands.
    (&[(-14.0, -47.0), (-18.0, -44.0), (-21.0, -44.5)], 2.0, 1),
    (&[(5.0, -62.0), (4.5, -58.0)], 1.5, 1),
    // Australia's Great Dividing Range, New Zealand's Southern Alps, Japan,
    // Kamchatka, New Guinea.
    (&[(-16.0, 145.0), (-21.0, 148.0), (-26.0, 151.0), (-31.0, 151.5), (-36.5, 148.5)], 0.8, 1),
    (&[(-41.5, 172.5), (-43.5, 170.5), (-45.0, 168.5)], 0.5, 2),
    (&[(35.5, 137.0), (36.5, 138.5), (39.0, 140.5)], 0.6, 2),
    (&[(56.0, 159.0), (53.5, 158.0)], 0.6, 1),
    (&[(-4.0, 136.0), (-5.0, 141.0), (-6.5, 145.5)], 0.8, 2),
];

/// How high the ranges make the ground at (lat, lon): 0 outside any, up to
/// a range's height at its spine, falling off to its edge. `tile`: degrees
/// a tile there (of latitude): every range is a few tiles wide at least, or
/// it would be too thin to hold mountains in hills.
fn range_height(lat: f32, lon: f32, tile: f32) -> f32 {
    // (Each range's box of latitudes and longitudes, with room for its
    // width: most ranges are far from any one spot, and measuring every
    // tile against every range was most of the time to make the map.)
    static BOXES: std::sync::OnceLock<Vec<(f32, f32, f32, f32)>> = std::sync::OnceLock::new();
    let boxes = BOXES.get_or_init(|| {
        RANGES.iter().map(|&(line, half, _)| {
            let m = half + 5.0;
            let lat = line.iter().map(|p| p.0);
            let lon = line.iter().map(|p| p.1);
            (lat.clone().fold(f32::MAX, f32::min) - m, lat.fold(f32::MIN, f32::max) + m, lon.clone().fold(f32::MAX, f32::min) - m * 4.0, lon.fold(f32::MIN, f32::max) + m * 4.0)
        }).collect()
    });
    let mut best = 0.0f32;
    let k = lat.to_radians().cos().max(0.2);
    // (Also, a range measured from a spot round the other side of the world
    // could have its line wrap past the spot: the Brooks Range made faint
    // hills in Lapland. In its box that can't happen.)
    for (&(line, half, height), &(la0, la1, lo0, lo1)) in RANGES.iter().zip(boxes) {
        if lat < la0 || lat > la1 || lon < lo0 || lon > lo1 {
            continue;
        }
        // (Degrees of longitude are shorter away from the equator.)
        let p = |a: (f32, f32)| ((a.1 - lon + 540.0).rem_euclid(360.0) - 180.0) * k;
        let mut d = f32::MAX;
        for (j, &a) in line.iter().enumerate() {
            let b = *line.get(j + 1).unwrap_or(&a);
            let (ax, ay, bx, by) = (p(a), a.0 - lat, p(b), b.0 - lat);
            let (vx, vy) = (bx - ax, by - ay);
            let t = if vx == 0.0 && vy == 0.0 { 0.0 } else { (-(ax * vx + ay * vy) / (vx * vx + vy * vy)).clamp(0.0, 1.0) };
            d = d.min((ax + vx * t).hypot(ay + vy * t));
        }
        let half = half.max(3.0 * tile) + tile;
        if d < half {
            best = best.max(height as f32 * (1.0 - d / half).sqrt());
        }
    }
    best
}

/// Where the towns can stand: (latitude, longitude) of a homeland.
const HOMES: [(f32, f32); 7] = [
    (50.0, 18.0),   // Europe
    (34.0, 108.0),  // China
    (40.0, -98.0),  // North America
    (-10.0, -55.0), // South America
    (8.0, 22.0),    // Africa
    (23.0, 78.0),   // India
    (-25.0, 134.0), // Australia
];
/// Towns start at least this far apart.
const HOME_GAP: f32 = 90.0;
const FISH_NEAR_BASE: usize = 7;
const SITE_FROM_BASE: f32 = 48.0;
const SITE_GAP: f32 = 34.0;
const GAP: f32 = 4.0;

/// Build the World map for `players` (2 to 4). Returns the map, its
/// deposits, one base centre per player, and the barbarian sites.
pub fn generate_world(seed: u32, players: usize, shape: Shape) -> (Map, Vec<Deposit>, Vec<(i32, i32)>, Vec<Site>) {
    let players = players.clamp(2, 4);
    let globe = shape == Shape::Globe;
    let (w, h) = if globe { (cube::W, cube::H) } else { (RADIUS * 2 + 2, RADIUS * 2 + 2) };
    // A tile's index, on the Globe over seams onto the face beyond.
    let ix = |x: i32, y: i32| -> usize {
        if globe {
            let (x, y) = cube::resolve_tile(x, y);
            (y * w + x) as usize
        } else {
            (y * w + x) as usize
        }
    };
    // How far apart two points are (on the Globe the short way, over seams).
    let gdist = |a: (f32, f32), b: (f32, f32)| {
        if globe {
            let (dx, dy, _) = cube::delta_turn(a.0, a.1, b.0, b.1);
            (dx * dx + dy * dy).sqrt()
        } else {
            dist(a, b)
        }
    };
    let n = (w * h) as usize;
    let centre = (w as f32 / 2.0, h as f32 / 2.0);
    let syms: &[Sym] = &[Sym::Id];
    let pick = |k: i32, lo: f32, hi: f32| lo + (hi - lo) * hash(k, 919, seed);
    let grid = earth();
    let lakes = decode(LAKES_RLE);
    // A tile for a place on the globe, and back.
    let tile_of = |lat: f32, lon: f32| {
        if globe {
            let (x, y) = globe_tile(lat, lon);
            return (x as i32, y as i32);
        }
        let (d, a) = ((90.0 - lat) / (90.0 - SOUTH) * LAT_RADIUS, lon.to_radians());
        ((centre.0 + d * a.sin()) as i32, (centre.1 + d * a.cos()) as i32)
    };
    let globe_of = |p: (f32, f32)| {
        if globe {
            return lat_lon(p.0, p.1);
        }
        let (dx, dy) = (p.0 - centre.0, p.1 - centre.1);
        (90.0 - dist(p, centre) / LAT_RADIUS * (90.0 - SOUTH), dx.atan2(dy).to_degrees())
    };
    // Is p in the world, `margin` tiles or more from its end? (On the
    // Globe: from a seam, so whatever is made there lies on one face.)
    let in_world = |p: (f32, f32), margin: f32| {
        if globe {
            cube::seam_dist(p.0, p.1) >= margin
        } else {
            dist(p, centre) <= LAT_RADIUS - margin
        }
    };
    // Open sea where the world ends: south of the disc's last latitude.
    let no_land = |lat: f32, _lon: f32| !globe && lat < SOUTH + 1.0;
    // Noise: on the Globe read where a point is on the ball, so it joins
    // up across seams.
    let fbm_round = |x: f32, y: f32, scale: f32, off: f32, seed: u32| {
        if globe {
            let d = cube::dir(x, y);
            return fbm3(d.map(|v| v * cube::RADIUS / scale + off), seed);
        }
        fbm(x / scale + off, y / scale + off, seed)
    };

    // The towns: homelands in an order the seed picks, far enough apart.
    let mut order: Vec<usize> = (0..HOMES.len()).collect();
    for i in (1..order.len()).rev() {
        let j = (hash(i as i32, 921, seed) * (i + 1) as f32) as usize;
        order.swap(i, j.min(i));
    }
    // Each town stands near a coast of its homeland (the nearest spot with
    // solid land round it and the sea about 10 tiles off): its houses want
    // fish, and a town far inland ran out of wood feeding itself without.
    let land_at = |x: f32, y: f32| {
        let (lat, lon) = globe_of((x, y));
        if no_land(lat, lon) { 0.0 } else { land(&grid, lat, lon) }
    };
    let by_the_sea = |home: (i32, i32)| -> (i32, i32) {
        let dirs: Vec<(f32, f32)> = (0..16).map(|k| (k as f32 / 16.0 * std::f32::consts::TAU).sin_cos()).collect();
        for ring in 0..=45 {
            for k in 0..(8 * ring).max(1) {
                let (dx, dy) = if ring == 0 { (0, 0) } else { ring_point(ring, k) };
                let (x, y) = ((home.0 + dx) as f32 + 0.5, (home.1 + dy) as f32 + 0.5);
                if !in_world((x, y), 24.0) {
                    continue;
                }
                let solid = dirs.iter().all(|&(s, c)| land_at(x + s * 6.0, y + c * 6.0) >= 0.8);
                let sea = dirs.iter().any(|&(s, c)| land_at(x + s * 7.0, y + c * 7.0) >= 0.5 && land_at(x + s * 11.0, y + c * 11.0) < 0.3);
                if solid && sea {
                    return (home.0 + dx, home.1 + dy);
                }
            }
        }
        home
    };
    let mut bases: Vec<(i32, i32)> = Vec::new();
    for gap in [HOME_GAP, HOME_GAP * 0.75, 0.0] {
        for &k in &order {
            let b = by_the_sea(tile_of(HOMES[k].0, HOMES[k].1));
            if bases.len() < players && bases.iter().all(|&o| o != b && gdist((o.0 as f32, o.1 as f32), (b.0 as f32, b.1 as f32)) >= gap) {
                bases.push(b);
            }
        }
    }
    let all_bases: Vec<(f32, f32)> = bases.iter().map(|&(x, y)| (x as f32 + 0.5, y as f32 + 0.5)).collect();
    let near_base = |p: (f32, f32)| all_bases.iter().map(|&b| gdist(p, b)).fold(f32::MAX, f32::min);

    let coast_scale = pick(1, 7.0, 11.0);
    let water_at = 0.45;
    let hill_at = pick(3, 0.64, 0.72);
    let wood_scale = pick(4, 6.0, 10.0);
    let wood_at = pick(5, 0.54, 0.62);
    let mut terrain = vec![WATER; n];
    let mut shade = vec![0u8; n];
    let mut feat = vec![Feat::None; n];
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) as usize;
            let p = (x as f32 + 0.5, y as f32 + 0.5);
            let d = dist(p, centre);
            if (!globe && d > RADIUS as f32) || (globe && !cube::real_tile(x, y)) {
                terrain[i] = EDGE;
                shade[i] = 10;
                continue;
            }
            let (lat, lon) = globe_of(p);
            let noise = fbm_round(x as f32, y as f32, coast_scale, 0.0, seed);
            // The atlas says where the land is; noise makes the coast.
            let mut ht = if no_land(lat, lon) { 0.1 } else { 0.08 + land(&grid, lat, lon) * 0.5 + noise * 0.24 };
            let near = near_base(p);
            if near < 9.0 {
                ht = ht.max(0.53 + (9.0 - near) / 9.0 * 0.1);
            }
            let hills = fbm_round(x as f32, y as f32, 9.0, 70.0, seed ^ 0x411);
            // The world's ranges: mountains along their spines, broken by
            // passes where the noise is low, in hills that run out to their
            // edges. Elsewhere hills here and there, as on other maps.
            // (A tile's size in degrees: on the Globe Mercator's, smaller
            // toward the poles; on the disc about the same everywhere.)
            let tile = if globe { (1.0 / cube::RADIUS).to_degrees() } else { (90.0 - SOUTH) / LAT_RADIUS };
            let range = range_height(lat, lon, tile) * (0.3 + hills);
            terrain[i] = if ht < water_at {
                WATER
            } else if ht < water_at + 0.03 {
                SAND
            } else if range > 1.4 && near > 20.0 && (!globe || cube::seam_dist(p.0, p.1) > 3.0) {
                MOUNTAIN
            } else if (hills > hill_at || range > 0.55) && near > 14.0 {
                HILL
            } else {
                GRASS
            };
            // Polar ice: the Arctic from 72° north, sea and land (so the pole
            // can be walked across from Siberia and Canada), Greenland's inland ice,
            // Antarctica and its ice shelves.
            if globe && terrain[i] != SHALLOW {
                let wet = terrain[i] == WATER;
                let greenland = lat > 60.0 && (-58.0..-18.0).contains(&lon) && land(&grid, lat, lon) > 0.97 && land(&grid, lat + 0.8, lon) > 0.97 && land(&grid, lat - 0.8, lon) > 0.97;
                // (Where the pack ice ends: further north where the Gulf
                // Stream warms the Barents Sea, further south off Alaska
                // and Labrador, and ragged with noise, not a circle.)
                let ragged = (fbm_round(x as f32, y as f32, 14.0, 130.0, seed ^ 0x1CE) - 0.5) * 9.0;
                let bump = |at: f32, wide: f32| (-(((lon - at + 540.0).rem_euclid(360.0) - 180.0) / wide).powi(2)).exp();
                let pack_n = 72.5 + 6.0 * bump(30.0, 35.0) - 3.5 * bump(-165.0, 25.0) - 3.0 * bump(-60.0, 20.0) + ragged;
                let pack_s = -73.0 + ragged * 0.7;
                let icy = lat > pack_n || greenland || (lat < -62.0 && !wet) || lat < pack_s;
                if icy {
                    terrain[i] = ICE;
                    // (Drawn just above the sea: flat, like the pack ice it is.)
                    ht = if wet { water_at + 0.035 } else { ht.max(water_at + 0.05) };
                }
            }
            let drawn = if terrain[i] == WATER { ht } else { (water_at + 0.05 + (ht - water_at) * 0.4).min(0.62) + if matches!(terrain[i], HILL | MOUNTAIN) { 0.18 } else { 0.0 } };
            shade[i] = ((drawn - water_at + SHADE_WATER).clamp(0.0, 1.0) * 255.0) as u8;
            // Forests, thinner in the desert belts and the far north.
            let dry_belt = (lat.abs() > 15.0 && lat.abs() < 32.0) || lat > 68.0;
            let f = fbm_round(x as f32, y as f32, wood_scale, 40.0, seed ^ 0xBEEF);
            if matches!(terrain[i], GRASS | HILL) && f > wood_at + if dry_belt { 0.1 } else { 0.0 } && hash(x, y, seed ^ 7) < 0.82 && near > 11.0 {
                feat[i] = Feat::Tree;
            }
        }
    }

    // Placing a cluster of a deposit, as on the other maps (`map::in_shape`).
    let mut keep_clear: Vec<(f32, f32, f32)> = all_bases.iter().map(|&(x, y)| (x, y, 10.0)).collect();
    // A point `d` from (x, y) the way of angle `a`: on the Globe over a
    // seam onto the face beyond.
    let out_from = |x: i32, y: i32, a: f32, d: f32| -> (i32, i32) {
        if globe {
            let (x, y, _) = cube::travel(x as f32 + 0.5, y as f32 + 0.5, a.cos() * d, a.sin() * d);
            (x as i32, y as i32)
        } else {
            (x + (a.cos() * d) as i32, y + (a.sin() * d) as i32)
        }
    };
    let place = |terrain: &mut Vec<u8>, feat: &mut Vec<Feat>, keep: &[(f32, f32, f32)], cx: i32, cy: i32, f: Feat, r: f32, ring_max: i32| -> bool {
        let far = reach(f, r);
        let fits = |terrain: &[u8], feat: &[Feat], x: i32, y: i32| {
            if !in_world((x as f32, y as f32), far + 3.0) {
                return false;
            }
            let tiles = shape_tiles(terrain, w, h, f, x, y, r, seed);
            tiles.iter().all(|&(a, b)| keep.iter().all(|&(kx, ky, k)| gdist(((x + a) as f32, (y + b) as f32), (kx, ky)) > k + 1.5))
                && shape_fits(terrain, feat, w, h, syms, &tiles, x, y, f, GAP, &[WATER, SAND, EDGE, ICE]) == (true, true)
        };
        let mut at = None;
        'search: for liked in [true, false] {
            for ring in 0..=if liked { ring_max.min(7) } else { ring_max } {
                for k in 0..(8 * ring).max(1) {
                    let (dx, dy) = if ring == 0 { (0, 0) } else { ring_point(ring, k) };
                    let (x, y) = (cx + dx, cy + dy);
                    if x < 4 || y < 4 || x >= w - 4 || y >= h - 4 || (globe && !in_world((x as f32 + 0.5, y as f32 + 0.5), far + 4.0)) {
                        continue;
                    }
                    if (!liked || liking(terrain, w, h, f, x, y, far).is_some()) && fits(terrain, feat, x, y) {
                        at = Some((x, y));
                        break 'search;
                    }
                }
            }
        }
        let Some((cx, cy)) = at else { return false };
        let tiles = shape_tiles(terrain, w, h, f, cx, cy, r, seed);
        let ri = far.ceil() as i32 + 3;
        for dy in -ri..=ri {
            for dx in -ri..=ri {
                let i = ix(cx + dx, cy + dy);
                let d = tiles.iter().map(|&(a, b)| (((dx - a) * (dx - a) + (dy - b) * (dy - b)) as f32).sqrt()).fold(f32::MAX, f32::min);
                if d <= 2.3 && f != Feat::Tree && feat[i] == Feat::Tree {
                    feat[i] = Feat::None;
                }
                if d < 0.5 {
                    feat[i] = f;
                }
            }
        }
        true
    };

    // Round every town, as on Frontier: wood by the town, the rest in
    // bands further out, each in a direction of its own (trying others
    // where that one is sea). The later eras' deposits are out in the
    // world (below).
    let bands: [(f32, f32, &[(Feat, f32)]); 5] = [
        (12.0, 15.0, &[(Feat::Tree, 3.0), (Feat::Tree, 3.0)]),
        (26.0, 40.0, &[(Feat::Stone, 1.5), (Feat::Fertile, 2.4), (Feat::Game, 2.2)]),
        (40.0, 58.0, &[(Feat::Stone, 1.5), (Feat::Fertile, 2.2), (Feat::Game, 2.0), (Feat::Horses, 1.6)]),
        (58.0, 80.0, &[(Feat::Clay, 1.6), (Feat::Hills, 1.6), (Feat::Iron, 1.5)]),
        (80.0, 100.0, &[(Feat::Nitrate, 1.4), (Feat::Iron, 1.5), (Feat::Clay, 1.6)]),
    ];
    for (bi, &(bx, by)) in bases.iter().enumerate() {
        let turn = hash(bi as i32, 923, seed) * std::f32::consts::TAU;
        let mut k = 0;
        for &(lo, hi, kinds) in &bands {
            for (j, &(f, r)) in kinds.iter().enumerate() {
                k += 1;
                // (After 12 tries, on a small continent where the band is
                // mostly sea, the search round each spot widens.)
                for t in 0..36 {
                    let a = turn + (j as f32 + 0.5) / kinds.len() as f32 * std::f32::consts::TAU + t as f32 * 2.4;
                    let d = lo + (hi - lo) * hash(bi as i32 * 64 + k, 53 + t, seed);
                    let (px, py) = out_from(bx, by, a, d);
                    let (x, y) = if globe { (px as f32, py as f32) } else { (bx as f32 + a.cos() * d, by as f32 + a.sin() * d) };
                    // (Not in another town's backyard.)
                    if bases.iter().enumerate().any(|(o, &(ox, oy))| o != bi && gdist((x, y), (ox as f32, oy as f32)) < 34.0) {
                        continue;
                    }
                    // (The search round a spot covers a square, so it can
                    // come nearer than the band: it keeps 20 tiles from every
                    // town, where only wood stands.)
                    let keep: Vec<(f32, f32, f32)> = keep_clear.iter().copied().chain(all_bases.iter().map(|&(x, y)| (x, y, 20.0))).collect();
                    if place(&mut terrain, &mut feat, &keep, px, py, f, r, if t < 12 { 6 } else { 14 }) {
                        break;
                    }
                }
            }
        }
    }

    // Barbarian sites: spots on land, apart from each other and from the
    // towns; the further from every town, the later the era they reach.
    let dry = |terrain: &[u8], cx: i32, cy: i32, r: i32| (-r..=r).all(|dy| (-r..=r).all(|dx| matches!(terrain[ix(cx + dx, cy + dy)], GRASS | HILL)));
    let mut sites: Vec<Site> = Vec::new();
    let mut tries = 0;
    while sites.len() < 14 && tries < 20000 {
        tries += 1;
        let (x, y) = ((hash(tries, 61, seed) * w as f32) as i32, (hash(tries, 63, seed) * h as f32) as i32);
        let p = (x as f32 + 0.5, y as f32 + 0.5);
        // (The real coasts are ragged and the ranges wide: past half the
        // tries, a smaller patch of open land and closer neighbours will do.)
        let late = tries > 10000;
        if !in_world(p, 12.0) || !dry(&terrain, x, y, if late { 4 } else { 7 }) {
            continue;
        }
        let from = near_base(p);
        if from < SITE_FROM_BASE || sites.iter().any(|s| gdist(p, (s.x as f32 + 0.5, s.y as f32 + 0.5)) < if late { SITE_GAP * 0.75 } else { SITE_GAP }) {
            continue;
        }
        sites.push(Site { x, y, era: (((from - SITE_FROM_BASE) / if globe { 45.0 } else { 20.0 }) as u8).min(5) });
    }
    for s in &sites {
        keep_clear.push((s.x as f32 + 0.5, s.y as f32 + 0.5, 6.0));
    }
    for (si, s) in sites.iter().enumerate() {
        let mut kinds: Vec<(Feat, f32)> = vec![(Feat::Tree, 3.4), (Feat::Stone, 1.5), (Feat::Fertile, 2.4), (Feat::Game, 2.4), (Feat::Fertile, 2.2), (Feat::Game, 2.2), (Feat::Stone, 1.5)];
        if s.era >= 1 {
            kinds.extend([(Feat::Iron, 1.5), (Feat::Clay, 1.6), (Feat::Hills, 1.6), (Feat::Horses, 1.6), (Feat::Clay, 1.5)]);
        }
        if s.era >= 2 {
            kinds.extend([(Feat::Nitrate, 1.3), (Feat::Iron, 1.6)]);
        }
        if s.era >= 3 {
            kinds.extend([(Feat::Coal, 1.6), (Feat::Iron, 1.6), (Feat::Clay, 1.6)]);
        }
        if s.era >= 4 {
            kinds.extend([(Feat::Oil, 1.4), (Feat::Bauxite, 1.4), (Feat::Coal, 1.6)]);
        }
        let n0 = kinds.len();
        for (j, &(f, r)) in kinds.iter().enumerate() {
            let a0 = (j as f32 / n0 as f32 + hash(si as i32, 65, seed)) * std::f32::consts::TAU;
            for t in 0..56 {
                let a = a0 + t as f32 * 0.7;
                let d = 9.0 + 2.0 * ((j + t) % 6) as f32 + if t >= 40 { 7.0 } else if t >= 24 { 4.0 } else { 0.0 };
                let (px, py) = out_from(s.x, s.y, a, d);
                if place(&mut terrain, &mut feat, &keep_clear, px, py, f, r, 3) {
                    break;
                }
                if t == 55 {
                    place(&mut terrain, &mut feat, &keep_clear, s.x, s.y, f, r, 18);
                }
            }
        }
    }

    // The rest of the world's deposits, scattered over the land away from
    // the towns: more of everything, and the later eras' (oil, bauxite,
    // uranium) only out here.
    let world: [(Feat, f32, usize); 12] = [
        (Feat::Stone, 1.5, 8), (Feat::Fertile, 2.2, 8), (Feat::Game, 2.2, 8), (Feat::Horses, 1.6, 5), (Feat::Hills, 1.6, 5), (Feat::Iron, 1.5, 8),
        (Feat::Clay, 1.6, 8), (Feat::Nitrate, 1.4, 7), (Feat::Coal, 1.5, 9), (Feat::Oil, 1.3, 9), (Feat::Bauxite, 1.4, 8), (Feat::Uranium, 1.3, 6),
    ];
    let mut t = 0;
    for &(f, r, count) in &world {
        let mut put = 0;
        for _ in 0..300 {
            if put >= count {
                break;
            }
            t += 1;
            let (x, y) = ((hash(t, 75, seed) * w as f32) as i32, (hash(t, 77, seed) * h as f32) as i32);
            let p = (x as f32 + 0.5, y as f32 + 0.5);
            if !in_world(p, 10.0) || !matches!(terrain[ix(x, y)], GRASS | HILL) || near_base(p) < if matches!(f, Feat::Coal | Feat::Oil | Feat::Bauxite | Feat::Uranium) { 100.0 } else { 34.0 } {
                continue;
            }
            put += place(&mut terrain, &mut feat, &keep_clear, x, y, f, r, 4) as usize;
        }
    }

    // Clear the town and camp sites themselves.
    let clear_round = |terrain: &mut Vec<u8>, feat: &mut Vec<Feat>, x: i32, y: i32, r: i32| {
        for yy in y - r..=y + r {
            for xx in x - r..=x + r {
                let i = ix(xx, yy);
                feat[i] = Feat::None;
                terrain[i] = GRASS;
            }
        }
    };
    for &(x, y) in &bases {
        clear_round(&mut terrain, &mut feat, x, y, 4);
    }
    for s in &sites {
        clear_round(&mut terrain, &mut feat, s.x, s.y, 4);
    }

    // Tidy the shores (as in `map::generate`).
    for _ in 0..2 {
        let before = terrain.clone();
        let rim = if globe { 0 } else { 1 };
        for y in rim..h - rim {
            for x in rim..w - rim {
                let i = (y * w + x) as usize;
                if feat[i] != Feat::None || before[i] == EDGE || all_bases.iter().any(|&b| gdist((x as f32, y as f32), b) < 6.0) {
                    continue;
                }
                let wet = [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)].iter().filter(|&&(dx, dy)| matches!(before[ix(x + dx, y + dy)], WATER | EDGE)).count();
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

    // Straits narrower than a tile, opened so ships get through: Gibraltar,
    // the Dardanelles and the Bosporus, the Danish straits, Bab-el-Mandeb,
    // Hormuz and Hudson Strait.
    const STRAITS: &[&[(f32, f32)]] = &[
        &[(36.0, -6.6), (36.0, -5.6), (36.1, -4.6)],
        &[(39.9, 25.9), (40.3, 26.6), (40.8, 27.6), (41.0, 28.9), (41.4, 29.3), (41.6, 29.8)],
        &[(57.6, 10.9), (56.6, 11.6), (55.7, 12.7), (55.2, 13.1), (55.0, 14.5), (55.4, 16.0)],
        &[(13.2, 42.9), (12.5, 43.5), (12.0, 44.0)],
        &[(27.0, 55.8), (26.5, 56.4), (25.8, 57.0)],
        &[(63.0, -79.0), (62.4, -73.0), (61.3, -66.0)],
    ];
    for line in STRAITS {
        for k in 0..line.len() - 1 {
            let (a, b) = (tile_of(line[k].0, line[k].1), tile_of(line[k + 1].0, line[k + 1].1));
            // (On the Globe the short way, over a seam if one lies between.)
            let o = if globe { 0.5 } else { 0.0 };
            let (a, (bx, by)) = ((a.0 as f32 + o, a.1 as f32 + o), (b.0 as f32 + o, b.1 as f32 + o));
            let (ddx, ddy) = if globe { let (x, y, _) = cube::delta_turn(a.0, a.1, bx, by); (x, y) } else { (bx - a.0, by - a.1) };
            let steps = ((ddx * ddx + ddy * ddy).sqrt() * 2.0).ceil().max(1.0) as i32;
            for t in 0..=steps {
                let f = t as f32 / steps as f32;
                let (cx, cy) = if globe { let (x, y, _) = cube::travel(a.0, a.1, ddx * f, ddy * f); (x, y) } else { (a.0 + ddx * f, a.1 + ddy * f) };
                for dy in -1..=1 {
                    for dx in -1..=1 {
                        let (x, y) = (cx.floor() as i32 + dx, cy.floor() as i32 + dy);
                        if (!globe && (x < 0 || y < 0 || x >= w || y >= h)) || near_base((x as f32 + 0.5, y as f32 + 0.5)) < 6.0 {
                            continue;
                        }
                        let i = ix(x, y);
                        if terrain[i] != EDGE {
                            terrain[i] = WATER;
                            feat[i] = Feat::None;
                            shade[i] = shade[i].min(80);
                        }
                    }
                }
            }
        }
    }

    // The sea is the water the atlas has as open water (oceans and seas,
    // the Caspian too) and whatever water that reaches; the rest (the
    // atlas's lakes, and ponds the noise makes on land) is shallow, for
    // people to wade and boats to sail.
    let mut sea = vec![false; n];
    let mut stack: Vec<(i32, i32)> = Vec::new();
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) as usize;
            if terrain[i] != WATER {
                continue;
            }
            let (lat, lon) = globe_of((x as f32 + 0.5, y as f32 + 0.5));
            if no_land(lat, lon) || (land(&grid, lat, lon) < 0.25 && land(&lakes, lat, lon) < 0.25) {
                sea[i] = true;
                stack.push((x, y));
            }
        }
    }
    while let Some((x, y)) = stack.pop() {
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            // (On the Globe the ocean goes on across the seams.)
            let (nx, ny) = if globe { cube::resolve_tile(x + dx, y + dy) } else { (x + dx, y + dy) };
            if nx >= 0 && ny >= 0 && nx < w && ny < h && !sea[(ny * w + nx) as usize] && terrain[(ny * w + nx) as usize] == WATER {
                sea[(ny * w + nx) as usize] = true;
                stack.push((nx, ny));
            }
        }
    }
    for i in 0..n {
        if terrain[i] == WATER && !sea[i] {
            terrain[i] = SHALLOW;
            shade[i] = shade[i].max(88);
        }
    }

    // Fishing spots: the sea nearest each town, and shoals over the oceans.
    let open = |terrain: &[u8], x: i32, y: i32| (-1..=1).all(|dy| (-1..=1).all(|dx| terrain[if globe { ix(x + dx, y + dy) } else { ((y + dy).clamp(0, h - 1) * w + (x + dx).clamp(0, w - 1)) as usize }] == WATER));
    let mut spots: Vec<(i32, i32)> = Vec::new();
    for &(bx, by) in &bases {
        let mut near: Vec<(i32, i32, i32)> = Vec::new();
        for y in (by - 60).max(1)..(by + 60).min(h - 1) {
            for x in (bx - 60).max(1)..(bx + 60).min(w - 1) {
                // (On the Globe, only this face's: the town is far from seams.)
                if sea[(y * w + x) as usize] && (!globe || cube::tile_face(x, y) == cube::tile_face(bx, by)) {
                    near.push(((x - bx).pow(2) + (y - by).pow(2), x, y));
                }
            }
        }
        near.sort();
        let mut mine = 0;
        for (_, x, y) in near {
            if mine >= FISH_NEAR_BASE {
                break;
            }
            if open(&terrain, x, y) && spots.iter().all(|&(sx, sy)| (sx - x).abs().max((sy - y).abs()) >= 4) {
                spots.push((x, y));
                mine += 1;
            }
        }
    }
    let mut shoals = 0;
    for t in 0..4000 {
        if shoals >= 60 {
            break;
        }
        let (x, y) = ((hash(t, 71, seed) * w as f32) as i32, (hash(t, 73, seed) * h as f32) as i32);
        if x < 2 || y < 2 || x >= w - 2 || y >= h - 2 || !sea[(y * w + x) as usize] || !open(&terrain, x, y) || (globe && cube::seam_dist(x as f32 + 0.5, y as f32 + 0.5) < 3.0) {
            continue;
        }
        if spots.iter().all(|&(sx, sy)| (sx - x).abs().max((sy - y).abs()) >= 12) {
            spots.push((x, y));
            shoals += 1;
        }
    }
    for (x, y) in spots {
        feat[(y * w + x) as usize] = Feat::Fish;
    }
    raise_sheep_hills(&mut terrain, &mut shade, &feat, w, h);
    // (Last of the terrain's changes: what came after the first pass, the
    // towns' clearings and the shores, can leave a mountain by the lowland.)
    settle_mountains(&mut terrain, &mut shade, &mut feat, w, h);
    thin_forests(&mut feat, w, h, &[Sym::Id], seed);
    place_whales(&terrain, &mut feat, w, h, &[Sym::Id], &bases, 30, 40.0, seed);

    let mut deps = Vec::new();
    let mut blocked = vec![false; n];
    let mut dep_at = vec![-1; n];
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) as usize;
            if matches!(terrain[i], WATER | EDGE) {
                blocked[i] = true;
                if matches!(feat[i], Feat::Fish | Feat::Whales) {
                    dep_at[i] = deps.len() as i32;
                    deps.push(Deposit { kind: if feat[i] == Feat::Fish { Dep::Fish } else { Dep::Whales }, tx: x, ty: y });
                }
                continue;
            }
            let kind = match feat[i] {
                Feat::None | Feat::Fish | Feat::Whales => continue,
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
    // Beaches one tile wide, only by the water (as in `map::generate`).
    let floor = (SHADE_BEACH * 255.0).ceil() as u8;
    let wet = |x: i32, y: i32| if globe { terrain[ix(x, y)] == WATER } else { x >= 0 && y >= 0 && x < w && y < h && terrain[(y * w + x) as usize] == WATER };
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) as usize;
            if !matches!(terrain[i], WATER | EDGE) && !(-1..=1).any(|dy| (-1..=1).any(|dx| wet(x + dx, y + dy))) {
                shade[i] = shade[i].max(floor);
            }
        }
    }
    let map = Map::new(w, h, terrain, shade, blocked, dep_at, vec![-1; n]);
    (map, deps, bases, sites)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every town stands on land with what a start needs near it, the towns
    /// are apart, nothing lies past the rim, and there are barbarian sites.
    #[test]
    fn every_start_has_its_deposits() {
        for (players, shape) in [(2usize, Shape::Disc), (4, Shape::Disc), (2, Shape::Globe), (4, Shape::Globe)] {
            for seed in 0..5u32 {
                let (m, deps, bases, sites) = generate_world(seed, players, shape);
                crate::map::use_wrap(&m);
                let dist = |a: (f32, f32), b: (f32, f32)| crate::map::pdist(a.0, a.1, b.0, b.1);
                assert_eq!(bases.len(), players);
                assert!(sites.len() >= 8, "seed {seed}: only {} sites", sites.len());
                for (i, &(bx, by)) in bases.iter().enumerate() {
                    assert_eq!(m.terrain[m.idx(bx, by)], GRASS, "seed {seed}: town {i} not on land");
                    for o in &bases[i + 1..] {
                        assert!(dist((bx as f32, by as f32), (o.0 as f32, o.1 as f32)) >= HOME_GAP * 0.75, "seed {seed}: towns too close");
                    }
                    // Spread out as on Frontier: only wood by the town.
                    let near = |d: &Deposit| dist((d.tx as f32, d.ty as f32), (bx as f32, by as f32));
                    if let Some(d) = deps.iter().find(|d| !matches!(d.kind, Dep::Forest | Dep::Fish) && near(d) < 18.0) {
                        panic!("{players}p seed {seed}: town {i} has {:?} {} tiles away", d.kind, near(d));
                    }
                    for k in [Dep::Forest, Dep::Stone, Dep::Fertile, Dep::Game, Dep::Iron, Dep::Clay, Dep::Fish] {
                        let far = match k {
                            Dep::Forest => 25.0,
                            Dep::Fish => 70.0,
                            Dep::Iron | Dep::Clay => 110.0,
                            _ => 65.0,
                        };
                        assert!(deps.iter().any(|d| d.kind == k && dist((d.tx as f32, d.ty as f32), (bx as f32, by as f32)) < far), "{players}p seed {seed}: town {i} has no {k:?} near (town at {bx},{by}, {})", if shape == Shape::Globe { "Globe" } else { "disc" });
                    }
                }
                assert!(deps.iter().all(|d| m.terrain[m.idx(d.tx, d.ty)] != EDGE));
            }
        }
    }

    /// On the Globe the ocean is one: no shallow (walkable) water where the
    /// map's edges meet, and the tiles on either side of the line match.
    #[test]
    fn the_globe_seams_join() {
        // The ground on either side of every seam is the same kind (land,
        // sea, ice) nearly everywhere: the coast doesn't jump at a seam.
        crate::map::use_wrap(&generate_world(0, 2, Shape::Globe).0);
        for seed in 0..3u32 {
            let (m, ..) = generate_world(seed, 2, Shape::Globe);
            let (mut seen, mut differ) = (0, 0);
            for y in 0..m.h {
                for x in 0..m.w {
                    if !cube::real_tile(x, y) || cube::seam_dist(x as f32 + 0.5, y as f32 + 0.5) > 1.0 {
                        continue;
                    }
                    for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                        let (nx, ny) = cube::resolve_tile(x + dx, y + dy);
                        if cube::tile_face(nx, ny) == cube::tile_face(x, y) {
                            continue;
                        }
                        seen += 1;
                        let kind = |t: u8| match t { WATER | SHALLOW => 0, ICE => 2, _ => 1 };
                        differ += (kind(m.terrain[m.idx(x, y)]) != kind(m.terrain[m.idx(nx, ny)])) as usize;
                    }
                }
            }
            assert!(seen > 2000, "seed {seed}: only {seen} tiles across seams");
            assert!(differ * 25 < seen, "seed {seed}: {differ} of {seen} tiles change kind across a seam");
        }
    }

    /// The Globe's tiles round trip through latitude and longitude.
    #[test]
    fn globe_places_round_trip() {
        for (lat, lon) in [(59.3, 18.1), (-33.9, 151.2), (40.7, -74.0), (0.0, 0.0), (89.0, 10.0), (-80.0, -120.0)] {
            let (x, y) = globe_tile(lat, lon);
            let (la, lo) = lat_lon(x, y);
            assert!((la - lat).abs() < 0.6 && (((lo - lon + 540.0) % 360.0) - 180.0).abs() < if lat.abs() > 85.0 { 10.0 } else { 0.6 }, "({lat}, {lon}) came back as ({la}, {lo})");
        }
    }

    /// The atlas's seas are seas (deep water, not wadeable lakes) and the
    /// straits are open: from the Atlantic a boat reaches the Mediterranean,
    /// the Black Sea, the Baltic, the Red Sea, the Persian Gulf and Hudson
    /// Bay. The Great Lakes are lakes.
    #[test]
    fn the_seas_are_open_and_the_lakes_are_lakes() {
        for shape in [Shape::Globe, Shape::Disc] {
            let (m, ..) = generate_world(3, 2, shape);
            let globe = shape == Shape::Globe;
            crate::map::use_wrap(&m);
            let tile = |lat: f32, lon: f32| -> (i32, i32) {
                if globe {
                    let (x, y) = globe_tile(lat, lon);
                    (x as i32, y as i32)
                } else {
                    let (d, a) = ((90.0 - lat) / (90.0 - SOUTH) * LAT_RADIUS, lon.to_radians());
                    ((m.w as f32 / 2.0 + d * a.sin()) as i32, (m.h as f32 / 2.0 + d * a.cos()) as i32)
                }
            };
            // Every sea tile the Atlantic reaches.
            let start = tile(30.0, -40.0);
            let mut seen = vec![false; (m.w * m.h) as usize];
            let mut todo = vec![start];
            seen[m.idx(start.0, start.1)] = true;
            while let Some((x, y)) = todo.pop() {
                for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                    let (nx, ny) = (x + dx, y + dy);
                    if m.inside(nx, ny) && !seen[m.idx(nx, ny)] && m.terrain[m.idx(nx, ny)] == WATER {
                        seen[m.idx(nx, ny)] = true;
                        todo.push(m.tile_on(nx, ny));
                    }
                }
            }
            for (name, lat, lon) in [("Mediterranean", 35.0, 18.0), ("Black Sea", 43.0, 34.0), ("Baltic", 58.0, 20.0), ("Red Sea", 20.0, 38.5), ("Persian Gulf", 27.0, 51.0), ("Hudson Bay", 59.0, -86.0)] {
                let (x, y) = tile(lat, lon);
                assert!(seen[m.idx(x, y)], "{name} not reached from the Atlantic ({})", if globe { "Globe" } else { "disc" });
            }
            let (x, y) = tile(47.7, -87.5);
            assert_eq!(m.terrain[m.idx(x, y)], SHALLOW, "Lake Superior is a lake");
        }
    }

    /// The poles can be crossed on foot: the ice at the North Pole is one
    /// piece of land with Siberia and with Canada.
    #[test]
    fn the_north_pole_can_be_walked_across() {
        let (m, ..) = generate_world(2, 2, Shape::Globe);
        let at = |lat: f32, lon: f32| {
            let (x, y) = globe_tile(lat, lon);
            m.land[m.idx(x as i32, y as i32)]
        };
        let pole = at(89.5, 0.0);
        assert!(pole != 0, "ice at the pole");
        assert_eq!(at(89.0, 179.0), pole, "the pole's ice is one piece");
        assert_eq!(at(65.0, 100.0), pole, "Siberia walks to the pole");
        assert_eq!(at(65.0, -110.0), pole, "Canada walks to the pole");
    }

    /// A picture (PPM) for a look: `VC_OUT=/tmp cargo test --release
    /// world_picture -- --ignored --nocapture`, seeds 1 to 4.
    #[test]
    #[ignore]
    fn world_picture() {
        let out = std::env::var("VC_OUT").unwrap_or("/tmp".into());
        for seed in 1..=4u32 {
            let players = 2 + (seed as usize % 3);
            let shape = if std::env::var("VC_GLOBE").is_ok() { Shape::Globe } else { Shape::Disc };
            let (m, deps, bases, sites) = generate_world(seed, players, shape);
            let mut px = vec![0u8; (m.w * m.h * 3) as usize];
            let mut put = |x: i32, y: i32, c: [u8; 3]| {
                let i = m.idx(x, y);
                px[i * 3..i * 3 + 3].copy_from_slice(&c);
            };
            for y in 0..m.h {
                for x in 0..m.w {
                    put(x, y, match m.terrain[m.idx(x, y)] { EDGE => [12, 14, 30], WATER => [30, 80, 170], SHALLOW => [90, 170, 210], SAND => [210, 190, 120], HILL => [120, 140, 70], MOUNTAIN => [175, 120, 190], ICE => [235, 240, 248], _ => [90, 170, 70] });
                }
            }
            let mut count = [0u32; 16];
            for d in &deps {
                count[d.kind as usize] += 1;
                put(d.tx, d.ty, match d.kind {
                    Dep::Forest => [30, 100, 40], Dep::Stone => [150, 150, 150], Dep::Clay => [200, 110, 60], Dep::Iron => [150, 40, 40], Dep::Coal => [20, 20, 20],
                    Dep::Fertile => [240, 220, 60], Dep::Game => [240, 150, 200], Dep::Horses => [130, 80, 30], Dep::Hills => [255, 255, 255], Dep::Nitrate => [200, 240, 240],
                    Dep::Oil => [90, 0, 120], Dep::Bauxite => [255, 120, 0], Dep::Uranium => [0, 255, 0], _ => [200, 230, 255],
                });
            }
            for &(bx, by) in &bases { for dy in -2..=2 { for dx in -2..=2 { put(bx + dx, by + dy, [230, 30, 30]); } } }
            for s in &sites { for dy in -1..=1 { for dx in -1..=1 { put(s.x + dx, s.y + dy, [40 + s.era * 40, 0, 0]); } } }
            println!("seed {seed} {players}p: {} sites (eras {:?}), deposits {:?}", sites.len(), sites.iter().map(|s| s.era).collect::<Vec<_>>(), &count[..14]);
            let mut f = format!("P6 {} {} 255\n", m.w, m.h).into_bytes();
            f.extend_from_slice(&px);
            std::fs::write(format!("{out}/world-{seed}.ppm"), f).unwrap();
        }
    }
}

