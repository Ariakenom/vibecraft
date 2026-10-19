//! A* pathfinding on the tile grid.

use crate::map::Map;
use std::cmp::Ordering;
use std::collections::BinaryHeap;

/// Where a unit wants to go: within `reach` of a rectangle (in tile units).
/// A point is just a zero-sized rectangle; a building is its footprint.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Goal {
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
    pub reach: f32,
}

impl Goal {
    pub fn point(x: f32, y: f32, reach: f32) -> Goal {
        Goal { x0: x, y0: y, x1: x, y1: y, reach }
    }
    pub fn rect(tx: i32, ty: i32, size: i32, reach: f32) -> Goal {
        Goal { x0: tx as f32, y0: ty as f32, x1: (tx + size) as f32, y1: (ty + size) as f32, reach }
    }
    pub fn dist(&self, x: f32, y: f32) -> f32 {
        let dx = (self.x0 - x).max(0.0).max(x - self.x1);
        let dy = (self.y0 - y).max(0.0).max(y - self.y1);
        (dx * dx + dy * dy).sqrt()
    }
    pub fn reached(&self, x: f32, y: f32) -> bool {
        self.dist(x, y) <= self.reach
    }
    pub fn nearest_point(&self, x: f32, y: f32) -> (f32, f32) {
        (x.clamp(self.x0, self.x1), y.clamp(self.y0, self.y1))
    }
}

/// An entry in the open set. `BinaryHeap` is a max-heap, so `Ord` is
/// implemented *backwards* to make it pop the lowest cost first.
#[derive(Clone, Copy)]
struct Open {
    f: f32,
    idx: u32,
}
impl PartialEq for Open {
    fn eq(&self, o: &Self) -> bool {
        self.f == o.f && self.idx == o.idx
    }
}
impl Eq for Open {}
impl Ord for Open {
    fn cmp(&self, o: &Self) -> Ordering {
        o.f.partial_cmp(&self.f).unwrap_or(Ordering::Equal).then_with(|| o.idx.cmp(&self.idx))
    }
}
impl PartialOrd for Open {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}

/// Reusable scratch buffers. Instead of clearing `g` and `parent` for every
/// search, each search bumps `generation`, and a slot only counts as valid if
/// its stamp equals the current generation.
pub struct Pathfinder {
    g: Vec<f32>,
    parent: Vec<u32>,
    seen: Vec<u32>,
    closed: Vec<u32>,
    generation: u32,
    heap: BinaryHeap<Open>,
}

const DIRS: [(i32, i32); 8] = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)];

// Copying a game (for multiplayer's two copies) doesn't need to copy these
// scratch buffers: no search result depends on what an earlier search left in
// them. So a "copy" gets fresh buffers, and copying over an existing game
// keeps that game's own buffers. Writing `Clone` by hand instead of
// `#[derive(Clone)]` is how you say "copying this type means something special".
impl Clone for Pathfinder {
    fn clone(&self) -> Self {
        Pathfinder::new(self.g.len())
    }
    fn clone_from(&mut self, _source: &Self) {}
}

impl Pathfinder {
    pub fn new(n: usize) -> Self {
        Pathfinder { g: vec![0.0; n], parent: vec![0; n], seen: vec![0; n], closed: vec![0; n], generation: 0, heap: BinaryHeap::new() }
    }

    /// Returns tile coordinates from (but not including) the start tile to the goal.
    /// If the goal can't be reached, returns a path to the closest tile we found.
    pub fn find(&mut self, map: &Map, sx: f32, sy: f32, goal: &Goal) -> Vec<(i32, i32)> {
        self.generation += 1;
        let stamp = self.generation;
        self.heap.clear();
        let w = map.w;
        let sx = (sx.floor() as i32).clamp(0, w - 1);
        let sy = (sy.floor() as i32).clamp(0, map.h - 1);
        let start = map.idx(sx, sy) as u32;
        let center = |x: i32, y: i32| (x as f32 + 0.5, y as f32 + 0.5);
        let h_of = |x: i32, y: i32| {
            let (cx, cy) = center(x, y);
            (goal.dist(cx, cy) - goal.reach).max(0.0)
        };

        self.g[start as usize] = 0.0;
        self.seen[start as usize] = stamp;
        self.heap.push(Open { f: h_of(sx, sy), idx: start });
        let (mut best, mut best_h) = (start, f32::MAX);
        let mut expanded = 0;

        while let Some(Open { idx, .. }) = self.heap.pop() {
            let i = idx as usize;
            if self.closed[i] == stamp {
                continue;
            }
            self.closed[i] = stamp;
            let (x, y) = (idx as i32 % w, idx as i32 / w);
            let (cx, cy) = center(x, y);
            if goal.dist(cx, cy) <= goal.reach + 0.36 {
                best = idx;
                break;
            }
            let hh = h_of(x, y);
            if hh < best_h {
                best_h = hh;
                best = idx;
            }
            expanded += 1;
            if expanded > 5000 {
                break;
            }
            for (dx, dy) in DIRS {
                let (nx, ny) = (x + dx, y + dy);
                if !map.passable(nx, ny) {
                    continue;
                }
                let diagonal = dx != 0 && dy != 0;
                // No cutting corners past walls.
                if diagonal && (!map.passable(x + dx, y) || !map.passable(x, y + dy)) {
                    continue;
                }
                let ng = self.g[i] + if diagonal { std::f32::consts::SQRT_2 } else { 1.0 };
                let ni = map.idx(nx, ny);
                if self.seen[ni] != stamp || ng < self.g[ni] {
                    self.seen[ni] = stamp;
                    self.g[ni] = ng;
                    self.parent[ni] = idx;
                    self.heap.push(Open { f: ng + h_of(nx, ny), idx: ni as u32 });
                }
            }
        }

        let mut out = Vec::new();
        let mut cur = best;
        while cur != start {
            out.push((cur as i32 % w, cur as i32 / w));
            cur = self.parent[cur as usize];
        }
        out.reverse();
        out
    }
}
