//! The computer opponent. It plays by the same rules as you: it holds slots
//! for everything it has, its citizens walk and build, its buildings take
//! time. (It does see through fog of war, and gets more supply on Hard.)
//!
//! This is the simple version for the first step of the new economy: work
//! down a build plan, and when something is short of slots, build the
//! producer that makes them first. Phase 3 of the plan rewrites it.

use crate::defs::*;
use crate::game::*;

#[derive(Clone)]
pub struct Ai {
    /// Is the computer playing this slot?
    pub on: bool,
    pub timer: f32,
    pub difficulty: u32,
    pub next_attack: f32,
    pub wave_size: usize,
    /// Last place one of our things was hit, if any.
    pub alarm: Option<(f32, f32)>,
    pub wonder_started: bool,
}

impl Ai {
    pub fn new(difficulty: u32, on: bool, phase: f32) -> Ai {
        let (first, wave) = match difficulty {
            0 => (540.0, 4),
            1 => (390.0, 6),
            _ => (280.0, 8),
        };
        Ai { on, timer: 1.0 + phase, difficulty, next_attack: first, wave_size: wave, alarm: None, wonder_started: false }
    }
}

/// A snapshot of what the AI owns, gathered once per think.
#[derive(Default)]
struct Census {
    /// The player this AI plays for.
    me: u8,
    citizens: Vec<u32>,
    idle: Vec<u32>,
    army: Vec<u32>,
    /// How many of each kind, buildings under construction included.
    /// Indexed by `Kind as usize`.
    have: Vec<u32>,
    unfinished: Vec<u32>,
}

/// How a build project went.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Step {
    /// Placed it (or the producer it was short of).
    Started,
    /// Not yet: waiting for builders or for slots to come free.
    Waiting,
    /// No spot for it, or nothing makes what it needs.
    Blocked,
}

/// The building that makes a resource, if any does yet.
fn producer_of(r: Res) -> Option<Kind> {
    Kind::BUILDABLE.into_iter().find(|k| k.stats().produces.iter().any(|&(p, _)| p == r))
}

// A second `impl Game` block, in a different file. Rust lets you split a
// type's methods across modules, which keeps the AI code out of game.rs.
impl Game {
    pub fn ai_think(&mut self, me: u8) {
        let Some(cap) = self.find_first(me, Kind::Capitol) else { return };
        let (bx, by) = (self.ents[cap].x, self.ents[cap].y);
        let diff = self.ais[me as usize].difficulty;
        let mut c = self.census(me);

        // 1. Keep a few citizens to build with. Each one holds a grain slot;
        //    if grain is short, the plan below builds a farm.
        let want_cit = [4usize, 6, 8][diff.min(2) as usize];
        let q = self.ents[cap].queue.len();
        let grain_short = self.short_of(me, Kind::Citizen).is_some();
        if c.citizens.len() + q < want_cit && q < 1 && !grain_short {
            let _ = self.queue_unit(cap as u32, Kind::Citizen);
        }

        // 2. The build plan: (building, how many we want), in order. The
        //    order follows the tech tree, so each step is unlocked in time.
        let plan: [(Kind, u32); 19] = [
            (Kind::Farm, 1),
            (Kind::LumberCamp, 2),
            (Kind::Barracks, 1),
            (Kind::Quarry, 1),
            (Kind::LumberCamp, 3),
            (Kind::Range, 1),
            (Kind::Farm, 2),
            (Kind::Pasture, 1),
            (Kind::Stable, 1),
            (Kind::LumberCamp, 4),
            (Kind::Tower, 1),
            (Kind::Quarry, 2),
            (Kind::Barracks, 2),
            (Kind::LumberCamp, 6),
            (Kind::Pasture, 2),
            (Kind::FishingHut, 1),
            (Kind::HuntingLodge, 1),
            (Kind::Orchard, 1),
            (Kind::Wonder, if diff >= 1 { 1 } else { 0 }),
        ];
        // One project at a time: wait while a foundation has no builder.
        let busy = c.unfinished.iter().any(|&b| !self.has_builder(b)) || c.unfinished.len() >= 2;
        // The first project that isn't impossible. Its cost is kept free
        // from soldiers (below), so it gets built eventually.
        let mut next = None;
        for (kind, n) in plan {
            if c.have[kind as usize] >= n || !self.unlocked(me, kind) {
                continue;
            }
            let step = if busy { Step::Waiting } else { self.ai_project(kind, bx, by, &mut c) };
            if step != Step::Blocked {
                next = Some(kind);
                break;
            }
        }

        // 3. A Wonder is a big job: keep several citizens on it.
        if let Some(w) = c.unfinished.iter().copied().find(|&b| self.ents[b as usize].kind == Kind::Wonder) {
            let builders = self.ents.iter().filter(|e| e.alive && e.order == Order::Build(w)).count();
            let want = [0, 4, 6][diff.min(2) as usize];
            for _ in builders..want {
                let Some(id) = c.idle.pop() else { break };
                self.order_build(id, w);
            }
        }

        // 4. Idle citizens finish buildings: ones nobody works on first.
        let idle = std::mem::take(&mut c.idle);
        for id in idle {
            let lonely = c.unfinished.iter().copied().find(|&b| !self.has_builder(b)).or_else(|| c.unfinished.first().copied());
            if let Some(b) = lonely {
                self.order_build(id, b);
            }
        }

        // 5. Train soldiers from every military building with room in its
        //    queue, keeping free what the next project needs.
        let qmax = if diff >= 2 { 2 } else { 1 };
        let reserve: &[(Res, u16)] = next.map_or(&[], |k| k.stats().cost);
        let producers: Vec<u32> = self
            .ents
            .iter()
            .filter(|e| e.alive && e.owner == me && e.built >= 1.0 && e.kind != Kind::Capitol && !e.kind.trains().is_empty() && e.queue.len() < qmax)
            .map(|e| e.id)
            .collect();
        for b in producers {
            let unit = self.ents[b as usize].kind.trains()[0];
            let p = &self.players[me as usize];
            let spare = |r: Res| p.free(r) - reserve.iter().find(|&&(x, _)| x == r).map_or(0, |&(_, k)| k as i32);
            if unit.stats().cost.iter().all(|&(r, k)| spare(r) >= k as i32) {
                let _ = self.queue_unit(b, unit);
            }
        }

        // 6. Defend: anything of ours being hit near home pulls the army back.
        let threat = self.enemy_unit_near(me, bx, by, 16.0).or_else(|| self.ais[me as usize].alarm.take().filter(|&(x, y)| (x - bx).hypot(y - by) < 22.0));
        if let Some((tx, ty)) = threat {
            for &id in &c.army {
                if !matches!(self.ents[id as usize].order, Order::Attack { .. }) {
                    self.order_attack_move(id, tx, ty);
                }
            }
            return;
        }

        // 7. Attack in waves that grow over time.
        if self.time >= self.ais[me as usize].next_attack && c.army.len() >= self.ais[me as usize].wave_size {
            if let Some((tx, ty)) = self.target_for(me, bx, by) {
                for &id in &c.army {
                    self.order_attack_move(id, tx, ty);
                }
            }
            self.ais[me as usize].next_attack = self.time + 110.0;
            self.ais[me as usize].wave_size += 2 + diff as usize;
        }
    }

    fn census(&self, me: u8) -> Census {
        let mut c = Census { me, have: vec![0; 128], ..Default::default() };
        for e in self.ents.iter().filter(|e| e.alive && e.owner == me) {
            if e.is_building() {
                c.have[e.kind as usize] += 1;
                if e.built < 1.0 {
                    c.unfinished.push(e.id);
                }
            } else if e.kind == Kind::Citizen {
                c.citizens.push(e.id);
                if e.order == Order::Idle {
                    c.idle.push(e.id);
                }
            } else {
                c.army.push(e.id);
            }
        }
        c
    }

    fn has_builder(&self, b: u32) -> bool {
        self.ents.iter().any(|e| e.alive && e.order == Order::Build(b))
    }

    /// Build `kind`, or, if it's short of some resource, the producer of
    /// that resource instead (one level deep: a quarry short of wood gets a
    /// lumber camp, which is free).
    fn ai_project(&mut self, kind: Kind, bx: f32, by: f32, c: &mut Census) -> Step {
        let me = c.me;
        let mut what = kind;
        for _ in 0..2 {
            match self.short_of(me, what).and_then(producer_of) {
                Some(p) if p != what => what = p,
                Some(_) => return Step::Waiting, // short of what it makes itself
                None => break,
            }
        }
        if self.short_of(me, what).is_some() {
            // Short of something nobody makes yet: this can't happen.
            return Step::Blocked;
        }
        if !self.ai_place(what, bx, by, c) {
            return Step::Blocked;
        }
        if what == Kind::Wonder {
            self.ais[me as usize].wonder_started = true;
        }
        Step::Started
    }

    /// Find a spot for `kind` and place it, with an idle citizen if there is
    /// one (otherwise idle citizens come to it later).
    fn ai_place(&mut self, kind: Kind, bx: f32, by: f32, c: &mut Census) -> bool {
        let me = c.me;
        let spot = match kind.stats().needs_deposit {
            // On land: try the nearest few deposits of the kind, nearest first.
            Some(dep) if dep != Dep::Water => {
                let mut near: Vec<(f32, usize)> = self.deps.iter().enumerate().filter(|(_, d)| d.kind == dep).map(|(i, d)| ((d.center().0 - bx).powi(2) + (d.center().1 - by).powi(2), i)).collect();
                // `total_cmp` orders floats totally, and the index breaks
                // ties, so both multiplayer copies pick the same deposit.
                near.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
                // Every other tile: neighbours share most of their spots.
                near.iter().step_by(2).take(40).find_map(|&(_, i)| {
                    let (x, y) = self.deps[i].center();
                    self.find_spot(me, kind, x, y, 1, 3)
                })
            }
            Some(_) => self.find_spot(me, kind, bx, by, 3, 24),
            None => {
                let far = if kind == Kind::Wonder { 16 } else { 14 };
                self.find_spot(me, kind, bx, by, 5, far)
            }
        };
        let Some((tx, ty)) = spot else { return false };
        let builders: Vec<u32> = c.idle.pop().into_iter().collect();
        match self.place(me, kind, tx, ty, &builders) {
            Ok(id) => {
                c.unfinished.push(id);
                c.have[kind as usize] += 1;
                true
            }
            Err(_) => {
                c.idle.extend(builders);
                false
            }
        }
    }

    /// Spiral outward looking for a free spot with a one-tile gap around it.
    fn find_spot(&self, me: u8, kind: Kind, x: f32, y: f32, rmin: i32, rmax: i32) -> Option<(i32, i32)> {
        let s = kind.stats().size;
        let (cx, cy) = (x as i32 - s / 2, y as i32 - s / 2);
        for r in rmin..=rmax {
            // Start the ring at a time-dependent angle so buildings don't all line up.
            let offset = (self.time as i32 * 7) % (8 * r).max(1);
            for k in 0..8 * r {
                let t = (k + offset) % (8 * r);
                let (dx, dy) = ring_point(r, t);
                let (tx, ty) = (cx + dx, cy + dy);
                if self.can_place(kind, tx, ty, me, 1) {
                    return Some((tx, ty));
                }
            }
        }
        None
    }

    /// Is a hostile soldier or citizen near (x, y)? (Any other player counts.)
    fn enemy_unit_near(&self, me: u8, x: f32, y: f32, r: f32) -> Option<(f32, f32)> {
        self.ents
            .iter()
            .find(|e| e.alive && e.owner != me && e.owner != 0 && !e.is_building() && (e.x - x).hypot(e.y - y) < r)
            .map(|e| (e.x, e.y))
    }

    /// Where to send an attack wave: the nearest rival Capitol still standing.
    fn target_for(&self, me: u8, bx: f32, by: f32) -> Option<(f32, f32)> {
        self.ents
            .iter()
            .filter(|e| e.alive && e.kind == Kind::Capitol && e.owner != me && e.owner != 0)
            .min_by(|a, b| (a.x - bx).hypot(a.y - by).total_cmp(&(b.x - bx).hypot(b.y - by)))
            .map(|e| (e.x, e.y))
    }
}

/// The t-th point on the square ring of radius r (8r points in total).
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
