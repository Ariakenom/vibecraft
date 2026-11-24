//! The Globe's ground: a ball cut into the six faces of a cube, each a
//! square of `N` by `N` tiles.
//!
//! A flat map of square tiles can't cover a ball evenly. The old Globe was
//! a Mercator map: everything shrank toward the poles (to 41% at 66°) and
//! was squeezed thin past them (to 9% across at 85°). On a cube every face
//! is an ordinary square grid like any other map, and the faces only meet
//! at their 12 edges. Each face is drawn on the ball with equal angles per
//! tile (`dir`), so a tile is drawn 0.67 to 1.15 times its size at a face's
//! middle (the most a tile's area varies is 1.4x), and only near the cube's
//! 8 corners, which the World places at sea, are tiles skewed.
//!
//! The game plays on an atlas of the faces, `W` by `H` tiles:
//!
//! ```text
//!   y 0      +------+------+------+
//!            |  F0  |  F1  |  F2  |    strip A: one band round the ball
//!   y N      +------+------+------+
//!            |       (gap)        |    never stood on: `GAP` rows
//!   y N+GAP  +------+------+------+
//!            |  F3  |  F4  |  F5  |    strip B: the band the other way round
//!   y 2N+GAP +------+------+------+
//! ```
//!
//! Each strip is three faces in a row that really are side by side on the
//! ball, so within a strip the atlas is the ground: walk east off F0 and
//! you are on F1. Their other edges are **seams**: off the top of F0 is the
//! bottom of F3, turned. A point past a seam ("virtual": as if the face went
//! on) is brought back by `resolve`, which says how many quarter turns a
//! heading picks up on the way (`Turn`). Which side of the gap a virtual
//! point is on says which strip it belongs to, so offsets of up to `GAP / 2`
//! tiles from a real point resolve right without knowing where they came
//! from (sight, building footprints, a path's next step); a longer trip
//! goes by `travel`.
//!
//! Everything here is exact in floating point: turns swap and negate
//! coordinates, and shifts add whole numbers of tiles. So every computer
//! gets the same answers.

use std::sync::OnceLock;

/// Tiles along a face's side: four faces make the equator 640 tiles round,
/// as the Mercator Globe had.
pub const N: i32 = 160;
/// Rows between the strips. Half of it is how far past a seam a point may
/// be and still resolve (`resolve`); more than any sight, footprint or
/// search round a unit reaches.
pub const GAP: i32 = 96;
pub const W: i32 = 3 * N;
pub const H: i32 = 2 * N + GAP;
/// Where strip B starts.
const B0: i32 = N + GAP;
/// The ball's radius in tiles: a tile at a face's middle is drawn a tile
/// wide (equal angles: π/2 across a face's N tiles).
pub const RADIUS: f32 = 2.0 * N as f32 / std::f32::consts::PI;

/// Quarter turns, counted the way `atan2(dy, dx)` grows: a heading of `a`
/// becomes `a + turn * π/2`, and a vector (x, y) becomes (-y, x) per turn.
pub type Turn = u8;

/// A vector turned by `k` quarter turns.
#[inline]
pub fn turn(k: Turn, x: f32, y: f32) -> (f32, f32) {
    match k & 3 {
        0 => (x, y),
        1 => (-y, x),
        2 => (-x, -y),
        _ => (y, -x),
    }
}
#[inline]
fn turn_i(k: Turn, x: i32, y: i32) -> (i32, i32) {
    match k & 3 {
        0 => (x, y),
        1 => (-y, x),
        2 => (-x, -y),
        _ => (y, -x),
    }
}

/// A face's place on the ball: its middle `c`, and the directions its
/// atlas x (`u`, "east") and y (`v`, "south") run in. Every face has
/// u × v = -c, as east × south is down, so no face is drawn mirrored.
#[derive(Clone, Copy)]
struct Face {
    c: [i32; 3],
    u: [i32; 3],
    v: [i32; 3],
    /// The atlas tile of its north-west corner.
    at: (i32, i32),
}

const FACES: [Face; 6] = [
    Face { c: [1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], at: (0, 0) },
    Face { c: [0, 0, 1], u: [-1, 0, 0], v: [0, 1, 0], at: (N, 0) },
    Face { c: [-1, 0, 0], u: [0, 0, -1], v: [0, 1, 0], at: (2 * N, 0) },
    Face { c: [0, 1, 0], u: [0, 0, -1], v: [1, 0, 0], at: (0, B0) },
    Face { c: [0, 0, -1], u: [0, -1, 0], v: [1, 0, 0], at: (N, B0) },
    Face { c: [0, -1, 0], u: [0, 0, 1], v: [1, 0, 0], at: (2 * N, B0) },
];

/// A face's sides.
const LEFT: usize = 0;
const RIGHT: usize = 1;
const TOP: usize = 2;
const BOTTOM: usize = 3;

/// A rigid move of the atlas: turn by `k`, then shift by `t` (whole tiles).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Move {
    pub k: Turn,
    pub t: (i32, i32),
}

impl Move {
    const ID: Move = Move { k: 0, t: (0, 0) };
    #[inline]
    pub fn point(&self, x: f32, y: f32) -> (f32, f32) {
        let (x, y) = turn(self.k, x, y);
        (x + self.t.0 as f32, y + self.t.1 as f32)
    }
    /// The tile a tile goes to (its middle's image, floored).
    #[inline]
    pub fn tile(&self, x: i32, y: i32) -> (i32, i32) {
        let (x, y) = turn_i(self.k, x, y);
        let c = [(0, 0), (-1, 0), (-1, -1), (0, -1)][(self.k & 3) as usize];
        (x + self.t.0 + c.0, y + self.t.1 + c.1)
    }
    /// This, then `then`.
    fn then(&self, then: &Move) -> Move {
        let (tx, ty) = turn_i(then.k, self.t.0, self.t.1);
        Move { k: (self.k + then.k) & 3, t: (tx + then.t.0, ty + then.t.1) }
    }
    fn inverse(&self) -> Move {
        let k = (4 - self.k) & 3;
        let (tx, ty) = turn_i(k, self.t.0, self.t.1);
        Move { k, t: (-tx, -ty) }
    }
}

/// What the cube's edges do, worked out once from `FACES`.
pub struct Cube {
    /// For each face and side: the face beyond it, and the move taking a
    /// point past that side (as if the face went on) to that face. None for
    /// a side the atlas already joins (inside a strip).
    seam: [[Option<(usize, Move)>; 4]; 6],
    /// For each pair of faces (a, b): moves taking b's tiles to where they
    /// lie as seen from a, unfolded over at most two edges. The shortest
    /// way from a point on a to one on b is the shortest of these.
    unfold: Vec<Vec<Move>>,
}

pub fn cube() -> &'static Cube {
    static CUBE: OnceLock<Cube> = OnceLock::new();
    CUBE.get_or_init(Cube::new)
}

fn corner(f: &Face, s: i32, t: i32) -> [i32; 3] {
    // (s, t) a corner in tiles (0 or N): its point on the cube, ±1 each way.
    let (a, b) = (if s == 0 { -1 } else { 1 }, if t == 0 { -1 } else { 1 });
    [0, 1, 2].map(|i| f.c[i] + a * f.u[i] + b * f.v[i])
}

/// The ends of a side, in a face's own tiles.
fn side_ends(side: usize) -> ((i32, i32), (i32, i32)) {
    match side {
        LEFT => ((0, 0), (0, N)),
        RIGHT => ((N, 0), (N, N)),
        TOP => ((0, 0), (N, 0)),
        _ => ((0, N), (N, N)),
    }
}

impl Cube {
    fn new() -> Cube {
        let mut seam = [[None; 4]; 6];
        // Moves from face a (atlas) to its neighbour beyond each side.
        let mut over: [[(usize, Move); 4]; 6] = [[(0, Move::ID); 4]; 6];
        for (fi, f) in FACES.iter().enumerate() {
            for side in 0..4 {
                let (p1, p2) = side_ends(side);
                let (c1, c2) = (corner(f, p1.0, p1.1), corner(f, p2.0, p2.1));
                let mut found = None;
                for (gi, g) in FACES.iter().enumerate() {
                    if gi == fi {
                        continue;
                    }
                    let local = |c: [i32; 3]| [(0, 0), (N, 0), (0, N), (N, N)].into_iter().find(|&(s, t)| corner(g, s, t) == c);
                    if let (Some(q1), Some(q2)) = (local(c1), local(c2)) {
                        found = Some((gi, q1, q2));
                    }
                }
                let (gi, q1, q2) = found.expect("every side of a cube's face meets another face");
                let g = &FACES[gi];
                // The turn taking the side's run (p2 - p1) to the other's.
                let run = (p2.0 - p1.0, p2.1 - p1.1);
                let want = (q2.0 - q1.0, q2.1 - q1.1);
                let k = (0..4u8).find(|&k| turn_i(k, run.0, run.1) == want).expect("faces meet at a quarter turn");
                // Atlas p (on or past f's side) -> atlas on g:
                // turn(k, p - f.at - p1) + q1 + g.at.
                let base = (f.at.0 + p1.0, f.at.1 + p1.1);
                let (bx, by) = turn_i(k, base.0, base.1);
                let m = Move { k, t: (q1.0 + g.at.0 - bx, q1.1 + g.at.1 - by) };
                over[fi][side] = (gi, m);
                // A side the atlas joins already: the move is no move.
                if m != Move::ID {
                    seam[fi][side] = Some((gi, m));
                }
            }
        }
        // Unfoldings: b's tiles as seen from a, over 0, 1 or 2 edges.
        let mut unfold = vec![Vec::new(); 36];
        let mut add = |a: usize, b: usize, m: Move| {
            let v: &mut Vec<Move> = &mut unfold[a * 6 + b];
            if !v.contains(&m) {
                v.push(m);
            }
        };
        for a in 0..6 {
            add(a, a, Move::ID);
            for s1 in 0..4 {
                let (h, m1) = over[a][s1];
                let back1 = m1.inverse(); // h's atlas -> a's frame
                add(a, h, back1);
                for s2 in 0..4 {
                    let (b, m2) = over[h][s2];
                    if b != a {
                        add(a, b, m2.inverse().then(&back1));
                    }
                }
            }
        }
        Cube { seam, unfold }
    }
}

/// The face a real point is on, or None for a virtual one.
#[inline]
pub fn face_of(x: f32, y: f32) -> Option<usize> {
    if !(0.0..W as f32).contains(&x) {
        return None;
    }
    let col = ((x / N as f32) as usize).min(2);
    if (0.0..N as f32).contains(&y) {
        Some(col)
    } else if (B0 as f32..(B0 + N) as f32).contains(&y) {
        Some(3 + col)
    } else {
        None
    }
}

#[inline]
pub fn tile_face(x: i32, y: i32) -> Option<usize> {
    if !(0..W).contains(&x) {
        return None;
    }
    let col = (x / N) as usize;
    if (0..N).contains(&y) {
        Some(col)
    } else if (B0..B0 + N).contains(&y) {
        Some(3 + col)
    } else {
        None
    }
}

/// Is this atlas tile on a face (not in the gap)?
#[inline]
pub fn real_tile(x: i32, y: i32) -> bool {
    tile_face(x, y).is_some()
}

/// Which face's side a virtual point is past (x first, then y), by which
/// strip's side of the gap it lies on.
#[inline]
fn past(x: f32, y: f32) -> (usize, usize) {
    let strip = if y < (N + GAP / 2) as f32 { 0 } else { 3 };
    let ly = y - if strip == 0 { 0.0 } else { B0 as f32 };
    if x < 0.0 {
        (strip, LEFT)
    } else if x >= W as f32 {
        (strip + 2, RIGHT)
    } else {
        let col = ((x / N as f32) as usize).min(2);
        (strip + col, if ly < 0.0 { TOP } else { BOTTOM })
    }
}

/// A point brought onto a face, and the quarter turns a heading picks up
/// getting there.
#[inline]
pub fn resolve(mut x: f32, mut y: f32) -> (f32, f32, Turn) {
    let c = cube();
    let mut k = 0;
    for _ in 0..8 {
        if face_of(x, y).is_some() {
            return (x, y, k & 3);
        }
        let (f, side) = past(x, y);
        match c.seam[f][side] {
            Some((_, m)) => {
                (x, y) = m.point(x, y);
                k += m.k;
            }
            // (Past a side the strip joins: only beyond the gap's middle,
            // which nothing should reach. Keep it on its own face.)
            None => break,
        }
    }
    clamp_onto(x, y, k)
}

/// The nearest real point, for something too far off to resolve.
fn clamp_onto(x: f32, y: f32, k: Turn) -> (f32, f32, Turn) {
    let x = x.clamp(0.0, W as f32 - 1e-3);
    let y = if y < (N + GAP / 2) as f32 { y.clamp(0.0, N as f32 - 1e-3) } else { y.clamp(B0 as f32, (B0 + N) as f32 - 1e-3) };
    (x, y, k & 3)
}

/// A tile brought onto a face (as `resolve`, for whole tiles).
#[inline]
pub fn resolve_tile(mut x: i32, mut y: i32) -> (i32, i32) {
    let c = cube();
    for _ in 0..8 {
        if real_tile(x, y) {
            return (x, y);
        }
        let (f, side) = past(x as f32 + 0.5, y as f32 + 0.5);
        match c.seam[f][side] {
            Some((_, m)) => (x, y) = m.tile(x, y),
            None => break,
        }
    }
    let (x, y, _) = clamp_onto(x as f32 + 0.5, y as f32 + 0.5, 0);
    (x as i32, y as i32)
}

/// The shortest way from a to b, in a's frame (east, south as a sees
/// them), and the quarter turns that take a vector in a's frame into b's.
#[inline]
pub fn delta_turn(ax: f32, ay: f32, bx: f32, by: f32) -> (f32, f32, Turn) {
    // (Both on the same face: straight across it.)
    let (fa, fb) = (face_of(ax, ay), face_of(bx, by));
    if let (Some(a), Some(b)) = (fa, fb) {
        if a == b {
            return (bx - ax, by - ay, 0);
        }
    }
    let (rax, ray, ka) = resolve(ax, ay);
    let (rbx, rby, kb) = resolve(bx, by);
    let (fa, fb) = (face_of(rax, ray).unwrap_or(0), face_of(rbx, rby).unwrap_or(0));
    let mut best = (rbx - rax, rby - ray, 0);
    let mut d2 = f32::MAX;
    for m in &cube().unfold[fa * 6 + fb] {
        let (x, y) = m.point(rbx, rby);
        let (dx, dy) = (x - rax, y - ray);
        let e = dx * dx + dy * dy;
        if e < d2 {
            d2 = e;
            // (m turns b's frame into a's by m.k: back is -m.k.)
            best = (dx, dy, (4 - m.k) & 3);
        }
    }
    // Into a's own frame if a was virtual (it picked up ka resolving), and
    // the turn from there to b's frame as b was given.
    let (dx, dy) = turn((4 - ka) & 3, best.0, best.1);
    (dx, dy, (best.2 + ka + 4 - kb) & 3)
}

/// From a, `d` along the ground: over seams as often as it takes. Where it
/// ends and the turns picked up.
pub fn travel(ax: f32, ay: f32, dx: f32, dy: f32) -> (f32, f32, Turn) {
    let (mut x, mut y, mut k) = resolve(ax, ay);
    let (mut dx, mut dy) = turn(k, dx, dy);
    // Steps short enough to always resolve.
    let len = (dx * dx + dy * dy).sqrt();
    let steps = (len / (GAP as f32 * 0.4)).ceil().max(1.0);
    let (sx, sy) = (dx / steps, dy / steps);
    (dx, dy) = (sx, sy);
    for _ in 0..steps as i32 {
        let (nx, ny, nk) = resolve(x + dx, y + dy);
        (x, y) = (nx, ny);
        (dx, dy) = turn(nk, dx, dy);
        k = (k + nk) & 3;
    }
    (x, y, k)
}

/// Where a circle round a real point at (x, y) lies on the faces beyond
/// the seams it reaches past: the point's image in each such face's frame
/// (its own frame continued past the side). For looking things up round a
/// point near a seam.
pub fn seam_images(x: f32, y: f32, r: f32) -> impl Iterator<Item = (f32, f32)> {
    let f = face_of(x, y);
    let c = cube();
    (0..4).filter_map(move |side| {
        let f = f?;
        let at = FACES[f].at;
        let (s, t) = (x - at.0 as f32, y - at.1 as f32);
        let close = match side {
            LEFT => s < r,
            RIGHT => s > N as f32 - r,
            TOP => t < r,
            _ => t > N as f32 - r,
        };
        if !close {
            return None;
        }
        c.seam[f][side].map(|(_, m)| m.point(x, y))
    })
}

/// How far a real point is from the nearest seam of its face (sides the
/// atlas joins don't count); 0 off the faces.
pub fn seam_dist(x: f32, y: f32) -> f32 {
    let Some(f) = face_of(x, y) else { return 0.0 };
    let at = FACES[f].at;
    let (s, t) = (x - at.0 as f32, y - at.1 as f32);
    let c = cube();
    [s, N as f32 - s, t, N as f32 - t].into_iter().enumerate().filter(|&(side, _)| c.seam[f][side].is_some()).map(|(_, d)| d).fold(f32::MAX, f32::min)
}

/// The direction from the ball's middle through a point of the atlas, in
/// the cube's own frame (before the world's turn, `map_world`). Equal
/// angles per tile across each face. For making the map and testing only:
/// the game never needs it.
pub fn dir(x: f32, y: f32) -> [f32; 3] {
    let (rx, ry, _) = resolve(x, y);
    let f = face_of(rx, ry).unwrap_or(0);
    let face = &FACES[f];
    let (s, t) = (rx - face.at.0 as f32, ry - face.at.1 as f32);
    let q = std::f32::consts::FRAC_PI_4;
    let (a, b) = (((2.0 * s / N as f32) - 1.0) * q, ((2.0 * t / N as f32) - 1.0) * q);
    let (ta, tb) = (a.tan(), b.tan());
    let p: [f32; 3] = [0, 1, 2].map(|i| face.c[i] as f32 + ta * face.u[i] as f32 + tb * face.v[i] as f32);
    let l = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt();
    p.map(|v| v / l)
}

/// The atlas point a direction (in the cube's frame) is drawn at.
pub fn at_dir(d: [f32; 3]) -> (f32, f32) {
    // The face: the axis it's furthest along.
    let f = (0..6)
        .max_by(|&a, &b| {
            let dot = |f: usize| (0..3).map(|i| d[i] * FACES[f].c[i] as f32).sum::<f32>();
            dot(a).total_cmp(&dot(b))
        })
        .unwrap();
    let face = &FACES[f];
    let dot = |v: [i32; 3]| (0..3).map(|i| d[i] * v[i] as f32).sum::<f32>();
    let (dc, du, dv) = (dot(face.c), dot(face.u), dot(face.v));
    let q = std::f32::consts::FRAC_PI_4;
    let s = ((du / dc).atan() / q + 1.0) * 0.5 * N as f32;
    let t = ((dv / dc).atan() / q + 1.0) * 0.5 * N as f32;
    (face.at.0 as f32 + s.clamp(0.0, N as f32 - 1e-3), face.at.1 as f32 + t.clamp(0.0, N as f32 - 1e-3))
}

/// For the page: the faces' frames and the seams' moves, as numbers
/// (`lib.rs` `cube_info`). Per face 11: c, u, v (3 each), its corner.
pub fn face_numbers(f: usize) -> [i32; 11] {
    let face = &FACES[f];
    [face.c[0], face.c[1], face.c[2], face.u[0], face.u[1], face.u[2], face.v[0], face.v[1], face.v[2], face.at.0, face.at.1]
}
/// Per face and side: the move past it (k, tx, ty), or k = -1 inside a strip.
pub fn seam_numbers(f: usize, side: usize) -> [i32; 3] {
    match cube().seam[f][side] {
        Some((_, m)) => [m.k as i32, m.t.0, m.t.1],
        None => [-1, 0, 0],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn near(a: [f32; 3], b: [f32; 3]) -> f32 {
        (0..3).map(|i| (a[i] - b[i]).powi(2)).sum::<f32>().sqrt()
    }

    #[test]
    fn seams_join_the_ground() {
        // Just past any side is just inside the face beyond it, at the same
        // spot on the ball, and back again.
        let eps = 0.01;
        for f in 0..6 {
            let face = &FACES[f];
            for side in 0..4 {
                for k in 0..=8 {
                    let along = 0.5 + (N as f32 - 1.0) * k as f32 / 8.0;
                    let (x, y) = match side {
                        LEFT => (face.at.0 as f32 - eps, face.at.1 as f32 + along),
                        RIGHT => ((face.at.0 + N) as f32 + eps, face.at.1 as f32 + along),
                        TOP => (face.at.0 as f32 + along, face.at.1 as f32 - eps),
                        _ => (face.at.0 as f32 + along, (face.at.1 + N) as f32 + eps),
                    };
                    let inside = match side {
                        LEFT => (x + 2.0 * eps, y),
                        RIGHT => (x - 2.0 * eps, y),
                        TOP => (x, y + 2.0 * eps),
                        _ => (x, y - 2.0 * eps),
                    };
                    let (rx, ry, _) = resolve(x, y);
                    assert!(face_of(rx, ry).is_some(), "face {f} side {side}: ({x}, {y}) resolved off the faces");
                    let gap = near(dir(rx, ry), dir(inside.0, inside.1)) * RADIUS;
                    assert!(gap < 0.05, "face {f} side {side} at {along}: {gap} tiles apart on the ball");
                    // And 0.02 tiles on the ground, the shortest way.
                    let (dx, dy, _) = delta_turn(inside.0, inside.1, rx, ry);
                    assert!((dx * dx + dy * dy).sqrt() < 0.03, "face {f} side {side}: delta ({dx}, {dy})");
                }
            }
        }
    }

    #[test]
    fn headings_turn_with_the_ground() {
        // A walk in eight directions from near seams: after crossing, the
        // turned heading still points (nearly) the way it was going.
        for (sx, sy) in [(5.0, 80.0), (475.0, 40.0), (80.0, 3.0), (200.0, 158.0), (250.0, B0 as f32 + 2.0), (400.0, (B0 + N) as f32 - 1.0)] {
            for a in 0..8 {
                let ang = a as f32 * std::f32::consts::FRAC_PI_4;
                let (hx, hy) = (ang.cos() * 0.25, ang.sin() * 0.25);
                let (mut x, mut y, mut dx, mut dy) = (sx, sy, hx, hy);
                for _ in 0..60 {
                    let before = dir(x, y);
                    let (nx, ny, k) = resolve(x + dx, y + dy);
                    let ahead = dir(x + dx, y + dy);
                    assert!(near(dir(nx, ny), ahead) * RADIUS < 0.02);
                    // The step after: straight on, on the ball.
                    (dx, dy) = turn(k, dx, dy);
                    (x, y) = (nx, ny);
                    let next = dir(x + dx, y + dy);
                    // Straight on in the tiles. On the ball the way bends a
                    // little where a seam is crossed away from its middle
                    // (faces' grids meet at up to 30° by the corners), never
                    // more. A heading turned the wrong way would bend 90°.
                    let (s1, s2) = ([0, 1, 2].map(|i| ahead[i] - before[i]), [0, 1, 2].map(|i| next[i] - ahead[i]));
                    let dot: f32 = (0..3).map(|i| s1[i] * s2[i]).sum();
                    let cos = dot / (near(s1, [0.0; 3]) * near(s2, [0.0; 3]));
                    assert!(cos > 30f32.to_radians().cos() - 0.02, "a bend of {:.0}° at ({x}, {y})", cos.clamp(-1.0, 1.0).acos().to_degrees());
                }
            }
        }
    }

    #[test]
    fn delta_is_the_short_way() {
        // Symmetric, and a little longer than the straight line through the
        // ball (the ground's way round), never much more.
        let pts = [(10.5, 10.5), (150.0, 2.0), (470.0, 150.0), (240.0, 80.0), (30.0, B0 as f32 + 20.0), (300.0, (B0 + N) as f32 - 3.0), (159.0, 159.0), (321.0, 1.0)];
        for &a in &pts {
            for &b in &pts {
                let (dx, dy, _) = delta_turn(a.0, a.1, b.0, b.1);
                let (ex, ey, _) = delta_turn(b.0, b.1, a.0, a.1);
                let (l1, l2) = ((dx * dx + dy * dy).sqrt(), (ex * ex + ey * ey).sqrt());
                assert!((l1 - l2).abs() < 1e-2 * l1.max(1.0), "{a:?} {b:?}: {l1} one way, {l2} back");
                let (da, db) = (dir(a.0, a.1), dir(b.0, b.1));
                let arc = (da[0] * db[0] + da[1] * db[1] + da[2] * db[2]).clamp(-1.0, 1.0).acos() * RADIUS;
                assert!(l1 >= arc * 0.6 - 0.5 && l1 <= arc * 1.6 + 0.5, "{a:?} {b:?}: {l1} on the ground, {arc} round the ball");
                // The step along it lands on b.
                let (tx, ty, _) = travel(a.0, a.1, dx, dy);
                let (bx, by, _) = resolve(b.0, b.1);
                assert!(near(dir(tx, ty), dir(bx, by)) * RADIUS < 0.05, "{a:?} to {b:?}: travel ends at ({tx}, {ty})");
            }
        }
    }

    #[test]
    fn tiles_resolve_as_their_middles() {
        for (x, y) in [(-1, 5), (-3, 150), (480, 10), (482, 100), (10, -1), (200, -4), (300, N), (300, N + 3), (50, B0 - 2), (400, B0 + N + 1), (-1, B0 + 40), (480, B0 + 5)] {
            let (tx, ty) = resolve_tile(x, y);
            let (px, py, _) = resolve(x as f32 + 0.5, y as f32 + 0.5);
            assert_eq!((tx, ty), (px.floor() as i32, py.floor() as i32), "tile ({x}, {y})");
            assert!(real_tile(tx, ty));
        }
    }

    #[test]
    fn directions_round_trip() {
        for (x, y) in [(10.5, 10.5), (150.0, 2.0), (470.0, 150.0), (240.0, 80.0), (30.0, B0 as f32 + 20.0), (300.0, (B0 + N) as f32 - 3.0)] {
            let (bx, by) = at_dir(dir(x, y));
            assert!((bx - x).abs() < 0.01 && (by - y).abs() < 0.01, "({x}, {y}) came back as ({bx}, {by})");
        }
    }
}
