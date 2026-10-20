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
    builders: Vec<u32>,
    idle: Vec<u32>,
    army: Vec<u32>,
    /// Residents at home with no job: who can crew a new producer.
    spare: u32,
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

        let p = self.players[me as usize];
        // Residents at home who aren't working: the people free to become
        // builders, soldiers or the crew of a new producer.
        let spare_people = p.residents.saturating_sub(p.working);
        c.spare = spare_people;

        // 1. Keep a few builders. Each is a person, used up at a foundation.
        let want_builders = [2usize, 3, 3][diff.min(2) as usize];
        let q = self.ents[cap].queue.len();
        // Two residents always stay free, so there's someone to crew the
        // next food producer when the houses are full.
        if c.builders.len() + q < want_builders && q < 1 && spare_people >= 2 {
            let _ = self.queue_unit(cap as u32, Kind::Builder);
        }

        // 2. The build plan: (building, how many we want), in order. The
        //    order follows the tech tree, so each step is unlocked in time.
        let plan: [(Kind, u32); 19] = [
            (Kind::LumberCamp, 1),
            (Kind::Farm, 1),
            (Kind::Barracks, 1),
            (Kind::Quarry, 1),
            (Kind::LumberCamp, 2),
            (Kind::Range, 1),
            (Kind::Farm, 2),
            (Kind::Pasture, 1),
            (Kind::Stable, 1),
            (Kind::LumberCamp, 3),
            (Kind::Tower, 1),
            (Kind::Quarry, 2),
            (Kind::Barracks, 2),
            (Kind::LumberCamp, 4),
            (Kind::Pasture, 2),
            (Kind::FishingHut, 1),
            (Kind::HuntingLodge, 1),
            (Kind::Orchard, 1),
            (Kind::Wonder, if diff >= 1 { 1 } else { 0 }),
        ];
        // One project at a time: wait while a foundation still needs builders.
        let busy = c.unfinished.iter().any(|&b| self.builders_missing(b) > 0) || c.unfinished.len() >= 2;
        // When the houses are full, or nobody is free to work, grow first:
        // a hut if there's food to put in it, otherwise more food.
        let full = p.residents + p.units + p.arriving + 1 >= p.beds;
        let mut grew = false;
        if !busy && (full || spare_people == 0) {
            grew = self.ai_grow(bx, by, &mut c) != Step::Blocked;
        }
        // The first project that isn't impossible. Its cost is kept free
        // from soldiers (below), so it gets built eventually.
        let mut next = None;
        for (kind, n) in plan {
            if c.have[kind as usize] >= n || !self.unlocked(me, kind) {
                continue;
            }
            let step = if busy || grew { Step::Waiting } else { self.ai_project(kind, bx, by, &mut c) };
            if step != Step::Blocked {
                next = Some(kind);
                break;
            }
        }

        // 3. Idle builders go to foundations that still need them.
        let idle = std::mem::take(&mut c.idle);
        for id in idle {
            if let Some(b) = c.unfinished.iter().copied().find(|&b| self.builders_missing(b) > 0) {
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
        // Every soldier is a resident who won't work. Aim for a share of all
        // our people under arms; past that, only train from idle residents.
        let share = [0.2f32, 0.3, 0.35][diff.min(2) as usize];
        let queued: usize = producers.iter().map(|&b| self.ents[b as usize].queue.len()).sum();
        let mut army = c.army.len() + queued;
        for b in producers {
            let pl = &self.players[me as usize];
            let people = (pl.residents + pl.units) as f32;
            let idle = pl.residents.saturating_sub(pl.working);
            if idle <= 2 || ((army as f32) >= people * share && idle <= 4) {
                break;
            }
            let unit = self.ents[b as usize].kind.trains()[0];
            let spare = |r: Res| pl.free(r) - reserve.iter().find(|&&(x, _)| x == r).map_or(0, |&(_, k)| k as i32);
            if unit.stats().cost.iter().all(|&(r, k)| spare(r) >= k as i32) && self.queue_unit(b, unit).is_ok() {
                army += 1;
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
            } else if e.kind == Kind::Builder {
                c.builders.push(e.id);
                if e.order == Order::Idle {
                    c.idle.push(e.id);
                }
            } else if e.kind != Kind::Arrival {
                c.army.push(e.id);
            }
        }
        c
    }

    /// Builders a foundation still needs, counting the ones on their way.
    fn builders_missing(&self, b: u32) -> u32 {
        let f = &self.ents[b as usize];
        let coming = self.ents.iter().filter(|e| e.alive && e.order == Order::Build(b)).count() as u32;
        (f.kind.stats().builders as u32).saturating_sub(f.builders_in as u32 + coming)
    }

    /// More beds: a hut if some food is left over for it, otherwise a
    /// producer of whichever food is scarcest (that has a spot).
    fn ai_grow(&mut self, bx: f32, by: f32, c: &mut Census) -> Step {
        let p = self.players[c.me as usize];
        let foods = [Res::Grain, Res::Fruit, Res::Meat, Res::Fish];
        if foods.iter().any(|&r| p.spare(r) > 0) {
            return self.ai_project(Kind::Hut, bx, by, c);
        }
        if c.spare == 0 {
            return Step::Waiting; // nobody to work a new producer yet
        }
        let mut by_supply: Vec<Res> = foods.to_vec();
        by_supply.sort_by_key(|r| (p.supply[r.idx()], r.idx()));
        for r in by_supply {
            let Some(k) = producer_of(r) else { continue };
            // More beds matter most: this may use the last free resident.
            c.spare += 1;
            let step = self.ai_project(k, bx, by, c);
            c.spare -= 1;
            if step != Step::Blocked {
                return step;
            }
        }
        Step::Blocked
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
        // A producer needs its crew, and two residents stay free (one for
        // the next food producer when the houses fill up). `ai_grow` lends
        // one extra for food.
        let crew = what.stats().workers as u32;
        if crew > 0 && c.spare < crew + 2 {
            return Step::Waiting;
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
        let n = kind.stats().builders as usize;
        let builders: Vec<u32> = (0..n).filter_map(|_| c.idle.pop()).collect();
        match self.place(me, kind, tx, ty, &builders) {
            Ok(id) => {
                c.spare = c.spare.saturating_sub(kind.stats().workers as u32);
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
