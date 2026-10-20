//! The computer opponent. It plays by the same rules as you: it holds slots
//! for everything it has, it needs people at home to work its producers,
//! its builders walk and are used up, its buildings take time. It only
//! builds on ground it has explored, so it sends a scout out early. (It
//! does see enemy units through the fog, and gets more supply on Hard.)
//!
//! Every half second it thinks, in three parts:
//! - the **economy**: keep a few builders; keep beds ahead of people (a hut
//!   when there's food for it, otherwise a producer of the scarcest food);
//!   work down a build plan, building the producer of whatever it's short
//!   of first; never use up the last free residents, and tear down a
//!   producer nobody needs when everyone is at work;
//! - the **army**: train soldiers until a share of its people is under arms
//!   (more on Hard), from residents with no job;
//! - **fighting**: defend home, then attack in waves that grow.

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
    /// The unit out exploring, if any, and which leg of its round it's on.
    /// `scout_leg` counts on past the last leg once the round is done.
    pub scout: Option<u32>,
    pub scout_leg: u8,
    /// The last project was for beds: the build plan gets the next turn.
    pub last_grew: bool,
}

impl Ai {
    pub fn new(difficulty: u32, on: bool, phase: f32) -> Ai {
        let (first, wave) = match difficulty {
            0 => (540.0, 4),
            1 => (420.0, 6),
            _ => (300.0, 8),
        };
        Ai { on, timer: 1.0 + phase, difficulty, next_attack: first, wave_size: wave, alarm: None, wonder_started: false, scout: None, scout_leg: 0, last_grew: false }
    }
}

/// How the AI plays at each difficulty (Easy, Normal, Hard).
struct Style {
    /// Builders to keep around.
    builders: usize,
    /// Share of all people to keep under arms.
    army_share: f32,
    /// Units a military building may have queued at once.
    queue: usize,
    /// Build a Wonder?
    wonder: bool,
}

const STYLES: [Style; 3] = [
    Style { builders: 2, army_share: 0.2, queue: 1, wonder: false },
    Style { builders: 3, army_share: 0.3, queue: 1, wonder: true },
    Style { builders: 3, army_share: 0.4, queue: 2, wonder: true },
];

/// Free residents the AI keeps at home: one to crew the next food producer
/// when the houses fill up, one more for whatever comes next.
const KEEP_FREE: u32 = 2;

/// The build plan: (building, how many we want), in order. It follows the
/// tech tree, so each step is unlocked in time. Producers for whatever runs
/// short are added along the way (`ai_project`), and beds come first.
const PLAN: [(Kind, u32); 18] = [
    (Kind::LumberCamp, 1),
    (Kind::Farm, 1),
    (Kind::Barracks, 1),
    (Kind::Quarry, 1),
    (Kind::Range, 1),
    (Kind::Pasture, 1),
    (Kind::Stable, 1),
    (Kind::Tower, 1),
    (Kind::Quarry, 2),
    (Kind::Barracks, 2),
    (Kind::Pasture, 2),
    (Kind::Quarry, 3),
    (Kind::FishingHut, 1),
    (Kind::HuntingLodge, 1),
    (Kind::Orchard, 1),
    (Kind::Wonder, 1),
    (Kind::Range, 2),
    (Kind::Stable, 2),
];

/// A snapshot of what the AI owns, gathered once per think.
#[derive(Default)]
struct Census {
    /// The player this AI plays for.
    me: u8,
    /// Where its Capitol stands.
    home: (f32, f32),
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
    /// Not yet: waiting for builders, people or slots.
    Waiting,
    /// No spot for it, or nothing makes what it needs.
    Blocked,
}

/// The building that makes a resource, if any does yet.
fn producer_of(r: Res) -> Option<Kind> {
    Kind::BUILDABLE.into_iter().find(|k| k.stats().produces.iter().any(|&(p, _)| p == r))
}

/// The foods houses want in the Ancient era.
const FOODS: [Res; 4] = [Res::Grain, Res::Fruit, Res::Meat, Res::Fish];

// A second `impl Game` block, in a different file. Rust lets you split a
// type's methods across modules, which keeps the AI code out of game.rs.
impl Game {
    pub fn ai_think(&mut self, me: u8) {
        let Some(cap) = self.find_first(me, Kind::Capitol) else { return };
        let mut c = self.census(me, (self.ents[cap].x, self.ents[cap].y));
        let style = &STYLES[self.ais[me as usize].difficulty.min(2) as usize];
        let next = self.ai_economy(cap, style, &mut c);
        self.ai_army(style, next, &mut c);
        self.ai_scout(&mut c);
        self.ai_fight(&c);
    }

    fn census(&self, me: u8, home: (f32, f32)) -> Census {
        let mut c = Census { me, home, have: vec![0; 128], ..Default::default() };
        let scout = self.ais[me as usize].scout;
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
            } else if e.kind != Kind::Arrival && Some(e.id) != scout {
                c.army.push(e.id);
            }
        }
        let p = &self.players[me as usize];
        c.spare = p.residents.saturating_sub(p.working);
        c
    }

    // -----------------------------------------------------------------------
    // Economy

    /// Builders, beds and the build plan. Returns the plan's next project,
    /// whose slots the army leaves free.
    fn ai_economy(&mut self, cap: usize, style: &Style, c: &mut Census) -> Option<Kind> {
        let me = c.me;
        // Builders: each is a person, used up at a foundation.
        // A foundation waiting with no builder anywhere may take the last
        // free resident.
        let q = self.ents[cap].queue.len();
        let waiting = c.builders.is_empty() && c.unfinished.iter().any(|&b| self.builders_missing(b) > 0);
        let keep = if waiting { 0 } else { KEEP_FREE };
        if c.builders.len() + q < style.builders && q < 1 && c.spare > keep && self.queue_unit(cap as u32, Kind::Builder).is_ok() {
            c.spare -= 1;
        }
        // Everyone at work and nobody free to crew a new producer: tear
        // down one that makes what nobody uses.
        if c.spare == 0 {
            self.ai_release(c);
        }
        // One project at a time: wait while a foundation still needs builders.
        let busy = c.unfinished.iter().any(|&b| self.builders_missing(b) > 0) || c.unfinished.len() >= 2;
        let p = self.players[me as usize];
        // Beds ahead of people: grow before the houses are full.
        let tight = p.residents + p.units + p.arriving + 2 >= p.beds;
        // Beds and the plan take turns, so neither starves the other.
        let mut acted = busy;
        let plan_turn = self.ais[me as usize].last_grew;
        if !acted && (tight || c.spare == 0) && !plan_turn {
            let step = self.ai_grow(c);
            acted = step != Step::Blocked;
            if step == Step::Started {
                self.ais[me as usize].last_grew = true;
            }
        }
        // The plan: the first project that isn't impossible.
        let mut next = None;
        for (kind, n) in PLAN {
            if c.have[kind as usize] >= n || !self.unlocked(me, kind) || (kind == Kind::Wonder && !style.wonder) {
                continue;
            }
            let step = if acted { Step::Waiting } else { self.ai_project(kind, c, false) };
            if step == Step::Started {
                self.ais[me as usize].last_grew = false;
            }
            if step != Step::Blocked {
                next = Some(kind);
                break;
            }
        }
        // Nothing in the plan could go: the next turn is for beds again.
        if next.is_none() || (!acted && plan_turn) {
            self.ais[me as usize].last_grew = false;
        }
        // Idle builders go to foundations that still need them.
        for id in std::mem::take(&mut c.idle) {
            if let Some(b) = c.unfinished.iter().copied().find(|&b| self.builders_missing(b) > 0) {
                self.order_build(id, b);
            }
        }
        next
    }

    /// Builders a foundation still needs, counting the ones on their way.
    fn builders_missing(&self, b: u32) -> u32 {
        let f = &self.ents[b as usize];
        let coming = self.ents.iter().filter(|e| e.alive && e.order == Order::Build(b)).count() as u32;
        (f.kind.stats().builders as u32).saturating_sub(f.builders_in as u32 + coming)
    }

    /// More beds: a hut if some food is left over for it, otherwise a
    /// producer of whichever food is scarcest (where there's a spot).
    fn ai_grow(&mut self, c: &mut Census) -> Step {
        let p = self.players[c.me as usize];
        if FOODS.iter().any(|&r| p.spare(r) > 0) {
            return self.ai_project(Kind::Hut, c, true);
        }
        let mut by_supply = FOODS.to_vec();
        by_supply.sort_by_key(|r| (p.supply[r.idx()], r.idx()));
        for r in by_supply {
            let Some(k) = producer_of(r) else { continue };
            let step = self.ai_project(k, c, true);
            if step != Step::Blocked {
                return step;
            }
        }
        Step::Blocked
    }

    /// Tear down the newest crewed producer whose whole output is spare, so
    /// its workers come free. Food in houses counts as used.
    fn ai_release(&mut self, c: &Census) -> bool {
        let p = self.players[c.me as usize];
        let unneeded = |k: Kind| {
            let st = k.stats();
            st.workers > 0 && st.produces.iter().all(|&(r, n)| p.spare(r) >= n as i32)
        };
        let Some(id) = self.ents.iter().rev().find(|e| e.alive && e.owner == c.me && e.crewed && e.built >= 1.0 && unneeded(e.kind)).map(|e| e.id) else {
            return false;
        };
        self.apply(c.me, Command::Demolish { ids: vec![id] }).is_ok()
    }

    /// Build `kind`, or, if it's short of some resource, the producer of
    /// that resource instead (one level deep: a quarry short of wood gets a
    /// lumber camp, which is free). A producer needs its crew and leaves
    /// `KEEP_FREE` residents at home, except when it's for beds (`for_beds`),
    /// which may use the last of them.
    fn ai_project(&mut self, kind: Kind, c: &mut Census, for_beds: bool) -> Step {
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
            return Step::Blocked; // short of something nothing makes yet
        }
        let crew = what.stats().workers as u32;
        let keep = if for_beds { 0 } else { KEEP_FREE };
        if crew > 0 && c.spare < crew + keep {
            return Step::Waiting;
        }
        if !self.ai_place(what, c) {
            return Step::Blocked;
        }
        if what == Kind::Wonder {
            self.ais[me as usize].wonder_started = true;
        }
        Step::Started
    }

    /// Find a spot for `kind` on explored ground and place it, with idle
    /// builders if there are any (otherwise they come to it later).
    fn ai_place(&mut self, kind: Kind, c: &mut Census) -> bool {
        let (me, (bx, by)) = (c.me, c.home);
        let spot = match kind.stats().needs_deposit {
            // Next to a deposit: try the nearest ones we've seen.
            Some(dep) if dep != Dep::Water => {
                let mut near: Vec<(f32, usize)> = self
                    .deps
                    .iter()
                    .enumerate()
                    .filter(|(_, d)| d.kind == dep && self.explored_by(me, d.tx, d.ty))
                    .map(|(i, d)| ((d.center().0 - bx).powi(2) + (d.center().1 - by).powi(2), i))
                    .collect();
                // `total_cmp` orders floats totally, and the index breaks
                // ties, so both multiplayer copies pick the same deposit.
                near.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
                // Every other tile: neighbours share most of their spots.
                near.iter().step_by(2).take(150).find_map(|&(_, i)| {
                    let (x, y) = self.deps[i].center();
                    self.find_spot(me, kind, x, y, 1, 3)
                })
            }
            Some(_) => self.find_spot(me, kind, bx, by, 3, 24),
            None => self.find_spot(me, kind, bx, by, 5, 24),
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

    /// Spiral outward looking for a free spot, with a one-tile gap around
    /// it, that we have explored.
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
                let seen = self.explored_by(me, tx, ty) && self.explored_by(me, tx + s - 1, ty + s - 1);
                if seen && self.can_place(kind, tx, ty, me, 1) {
                    return Some((tx, ty));
                }
            }
        }
        None
    }

    // -----------------------------------------------------------------------
    // Army

    /// Train soldiers from residents with no job, until a share of all our
    /// people is under arms, keeping free what the next project needs: its
    /// slots, and its crew.
    fn ai_army(&mut self, style: &Style, next: Option<Kind>, c: &mut Census) {
        let me = c.me;
        let reserve: &[(Res, u16)] = next.map_or(&[], |k| k.stats().cost);
        let crew = next.map_or(0, |k| k.stats().workers as u32 + KEEP_FREE);
        let producers: Vec<u32> = self
            .ents
            .iter()
            .filter(|e| e.alive && e.owner == me && e.built >= 1.0 && e.kind != Kind::Capitol && !e.kind.trains().is_empty() && e.queue.len() < style.queue)
            .map(|e| e.id)
            .collect();
        let queued: usize = self.ents.iter().filter(|e| e.alive && e.owner == me && e.kind != Kind::Capitol).map(|e| e.queue.len()).sum();
        let mut army = c.army.len() + queued;
        for b in producers {
            let pl = self.players[me as usize];
            let people = (pl.residents + pl.units) as f32;
            if c.spare <= crew || army as f32 >= people * style.army_share {
                break;
            }
            let unit = self.ents[b as usize].kind.trains()[0];
            let spare = |r: Res| pl.free(r) - reserve.iter().find(|&&(x, _)| x == r).map_or(0, |&(_, k)| k as i32);
            if unit.stats().cost.iter().all(|&(r, k)| spare(r) >= k as i32) && self.queue_unit(b, unit).is_ok() {
                army += 1;
                c.spare -= 1;
            }
        }
    }

    /// The first soldier goes round the map once, so we learn where the
    /// deposits are. Then it joins the army.
    fn ai_scout(&mut self, c: &mut Census) {
        let me = c.me;
        let (w, h) = (self.map.w as f32, self.map.h as f32);
        // A round of the map, starting from the corner nearest home.
        let mut legs = [(0.25, 0.25), (0.75, 0.25), (0.75, 0.75), (0.25, 0.75)].map(|(fx, fy)| (fx * w, fy * h));
        let first = (0..4).min_by(|&a, &b| {
            let d = |i: usize| (legs[i].0 - c.home.0).powi(2) + (legs[i].1 - c.home.1).powi(2);
            d(a).total_cmp(&d(b))
        });
        legs.rotate_left(first.unwrap_or(0));
        let ai = &self.ais[me as usize];
        let (scout, leg) = (ai.scout, ai.scout_leg as usize);
        if leg > legs.len() {
            return; // done
        }
        let Some(id) = scout.filter(|&id| self.alive(id)) else {
            // Pick one: the first soldier we have.
            if let Some(&id) = c.army.first() {
                c.army.remove(0);
                self.ais[me as usize].scout = Some(id);
                self.order_move(id, legs[leg.min(3)].0, legs[leg.min(3)].1);
            }
            return;
        };
        if self.ents[id as usize].order != Order::Idle {
            return;
        }
        let ai = &mut self.ais[me as usize];
        ai.scout_leg += 1;
        if ai.scout_leg as usize >= legs.len() {
            // Round done: back home, and into the army.
            ai.scout_leg = legs.len() as u8 + 1;
            ai.scout = None;
            self.order_move(id, c.home.0, c.home.1 + 4.0);
        } else {
            let (x, y) = legs[ai.scout_leg as usize];
            self.order_move(id, x, y);
        }
    }

    // -----------------------------------------------------------------------
    // Fighting

    fn ai_fight(&mut self, c: &Census) {
        let me = c.me;
        let (bx, by) = c.home;
        let diff = self.ais[me as usize].difficulty;
        // Defend: anything of ours being hit near home pulls the army back.
        let threat = self.enemy_unit_near(me, bx, by, 16.0).or_else(|| self.ais[me as usize].alarm.take().filter(|&(x, y)| (x - bx).hypot(y - by) < 22.0));
        if let Some((tx, ty)) = threat {
            for &id in &c.army {
                if !matches!(self.ents[id as usize].order, Order::Attack { .. }) {
                    self.order_attack_move(id, tx, ty);
                }
            }
            return;
        }
        // Attack in waves that grow over time, but never beyond what our
        // people can field.
        let p = &self.players[me as usize];
        let most = ((p.residents + p.units) as f32 * STYLES[diff.min(2) as usize].army_share * 0.8) as usize;
        let wave = self.ais[me as usize].wave_size.min(most.max(4));
        if self.time >= self.ais[me as usize].next_attack && c.army.len() >= wave {
            if let Some((tx, ty)) = self.target_for(me, bx, by) {
                for &id in &c.army {
                    self.order_attack_move(id, tx, ty);
                }
            }
            self.ais[me as usize].next_attack = self.time + 110.0;
            self.ais[me as usize].wave_size += 2 + diff as usize;
        }
    }

    /// Is a hostile soldier or builder near (x, y)? (Any other player counts.)
    fn enemy_unit_near(&self, me: u8, x: f32, y: f32, r: f32) -> Option<(f32, f32)> {
        self.ents
            .iter()
            .find(|e| e.alive && e.owner != me && e.owner != 0 && e.kind.holds_bed() && (e.x - x).hypot(e.y - y) < r)
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
