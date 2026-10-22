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
        Ai { on, timer: 1.0 + phase, difficulty, next_attack: first, wave_size: wave, alarm: None, scout: None, scout_leg: 0, last_grew: false }
    }
}

/// How the AI plays at each difficulty (Easy, Normal, Hard).
struct Style {
    /// Share of all people to keep under arms.
    army_share: f32,
    /// Units a military building may have queued at once.
    queue: usize,
}

const STYLES: [Style; 3] = [
    Style { army_share: 0.2, queue: 1 },
    Style { army_share: 0.3, queue: 1 },
    Style { army_share: 0.4, queue: 2 },
];

/// Free residents the AI keeps at home: one to crew the next food producer
/// when the houses fill up, one more for whatever comes next.
const KEEP_FREE: u32 = 2;

/// The build plan: (building, how many we want), in order. It follows the
/// tech tree, so each step is unlocked in time. Producers for whatever runs
/// short are added along the way (`ai_project`), and beds come first.
const PLAN: [(Kind, u32); 49] = [
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
    (Kind::Range, 2),
    (Kind::Stable, 2),
    // Medieval: iron for the army, then the new house goods.
    (Kind::IronMine, 1),
    (Kind::Bakery, 1),
    (Kind::SheepFarm, 1),
    (Kind::Weaver, 1),
    (Kind::Brickworks, 1),
    (Kind::Brewery, 1),
    (Kind::IronMine, 2),
    (Kind::SiegeWorkshop, 1),
    (Kind::Bakery, 2),
    (Kind::Weaver, 2),
    // Gunpowder: powder for the army, then furniture, books and the circus.
    (Kind::SaltpeterWorks, 1),
    (Kind::PowderMill, 1),
    (Kind::Carpenter, 1),
    (Kind::Printer, 1),
    (Kind::Circus, 1),
    (Kind::PowderMill, 2),
    // Industrial: steel first, then shells and the new house goods.
    (Kind::CoalMine, 1),
    (Kind::SteelMill, 1),
    (Kind::CoalYard, 1),
    (Kind::Cannery, 1),
    (Kind::ExplosivesWorks, 1),
    (Kind::Press, 1),
    (Kind::Factory, 1),
    (Kind::CoalMine, 2),
    // Modern: power, oil and aluminum, radios, then tanks and aircraft.
    (Kind::PowerPlant, 1),
    (Kind::OilWell, 1),
    (Kind::RadioFactory, 1),
    (Kind::BauxiteMine, 1),
    (Kind::TankWorks, 1),
    (Kind::Airfield, 1),
    (Kind::HaberBosch, 1),
    (Kind::PowerPlant, 2),
];

/// A snapshot of what the AI owns, gathered once per think.
#[derive(Default)]
struct Census {
    /// The player this AI plays for.
    me: u8,
    /// Where its Capitol stands.
    home: (f32, f32),
    army: Vec<u32>,
    /// Free workers at the campfire not yet spoken for: who can build,
    /// crew a new producer or become a soldier.
    spare: u32,
    /// How many of each kind, buildings under construction included.
    /// Indexed by `Kind as usize`.
    have: Vec<u32>,
    unfinished: Vec<u32>,
    /// Tiles a worker can walk to from the campfire.
    reach: Vec<bool>,
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

/// The house goods a player of `era` can make: food in the Ancient era;
/// bread, clothes and beer join them in the Medieval.
fn house_goods(era: u8) -> Vec<Res> {
    Res::ALL.into_iter().filter(|r| r.is_house_good() && r.era() <= era && producer_of(*r).is_some_and(|k| k.era() <= era)).collect()
}

// A second `impl Game` block, in a different file. Rust lets you split a
// type's methods across modules, which keeps the AI code out of game.rs.
impl Game {
    pub fn ai_think(&mut self, me: u8) {
        let Some(cap) = self.find_first(me, Kind::Capitol) else { return };
        let mut c = self.census(me, (self.ents[cap].x, self.ents[cap].y));
        // Cancel foundations nobody can reach (`census` left them out).
        let cut_off: Vec<u32> = self.ents.iter().filter(|e| e.alive && e.owner == me && e.is_building() && e.built < 1.0 && !c.unfinished.contains(&e.id)).map(|e| e.id).collect();
        if !cut_off.is_empty() {
            let _ = self.apply(me, Command::Demolish { ids: cut_off });
        }
        let style = &STYLES[self.ais[me as usize].difficulty.min(2) as usize];
        let next = self.ai_economy(&mut c);
        self.ai_army(style, next, &mut c);
        self.ai_scout(&mut c);
        self.ai_fight(&c);
    }

    /// Every tile a unit can walk to from (x, y), moving like the path
    /// finder does (eight ways, no cutting corners past walls).
    fn reachable_from(&self, x: f32, y: f32) -> Vec<bool> {
        let m = &self.map;
        let mut seen = vec![false; (m.w * m.h) as usize];
        let (sx, sy) = (x.floor() as i32, y.floor() as i32);
        if !m.inside(sx, sy) {
            return seen;
        }
        let mut stack = vec![(sx, sy)];
        seen[m.idx(sx, sy)] = true;
        while let Some((x, y)) = stack.pop() {
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)] {
                let (nx, ny) = (x + dx, y + dy);
                if !m.passable(nx, ny) || seen[m.idx(nx, ny)] {
                    continue;
                }
                if dx != 0 && dy != 0 && (!m.passable(x + dx, y) || !m.passable(x, y + dy)) {
                    continue;
                }
                seen[m.idx(nx, ny)] = true;
                stack.push((nx, ny));
            }
        }
        seen
    }

    fn census(&mut self, me: u8, home: (f32, f32)) -> Census {
        let mut c = Census { me, home, have: vec![0; 128], ..Default::default() };
        let (fx, fy) = self.campfire(me).unwrap_or(home);
        c.reach = self.reachable_from(fx, fy);
        let scout = self.ais[me as usize].scout;
        for e in self.ents.iter().filter(|e| e.alive && e.owner == me) {
            if e.is_building() {
                c.have[e.kind as usize] += 1;
                if e.built < 1.0 {
                    c.unfinished.push(e.id);
                }
            } else if e.kind != Kind::Worker && Some(e.id) != scout {
                c.army.push(e.id);
            }
        }
        // Foundations no worker can walk to never rise: they go.
        let cut_off: Vec<u32> = c.unfinished.iter().copied().filter(|&b| {
            let f = &self.ents[b as usize];
            f.builders_in < f.kind.stats().builders && !touches(&self.map, &c.reach, f.tx, f.ty, f.kind.stats().size)
        }).collect();
        c.unfinished.retain(|b| !cut_off.contains(b));
        // Free workers not yet spoken for by a queue or a foundation.
        let missing: u32 = c.unfinished.iter().map(|&b| self.builders_missing(b)).sum();
        c.spare = self.unclaimed_workers(me).saturating_sub(missing);
        c
    }

    // -----------------------------------------------------------------------
    // Economy

    /// Beds and the build plan. Builders and crews come by themselves from
    /// the campfire (people.rs); the AI only makes sure enough are free.
    /// Returns the plan's next project, whose slots the army leaves free.
    fn ai_economy(&mut self, c: &mut Census) -> Option<Kind> {
        let me = c.me;
        // Too few free to crew a new producer: tear down one that makes
        // what nobody uses, and its workers come free.
        if c.spare < 3 {
            self.ai_release(c);
        }
        // One project at a time: wait while a foundation still needs
        // builders. Far-off ones don't hold the town up: their builders may
        // be cut down on the way, again and again.
        let near: Vec<u32> = c.unfinished.iter().copied().filter(|&b| (self.ents[b as usize].x - c.home.0).hypot(self.ents[b as usize].y - c.home.1) < 22.0).collect();
        let busy = near.iter().any(|&b| self.builders_missing(b) > 0) || near.len() >= 2;
        let p = self.players[me as usize];
        // Beds ahead of people: grow before the houses are full.
        let tight = p.people + 2 >= p.beds;
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
            if c.have[kind as usize] >= n || !self.unlocked(me, kind) {
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
        next
    }

    /// Builders a foundation still needs, counting the ones on their way.
    fn builders_missing(&self, b: u32) -> u32 {
        let f = &self.ents[b as usize];
        let coming = self.ents.iter().filter(|e| e.alive && e.order == Order::Build(b)).count() as u32;
        (f.kind.stats().builders as u32).saturating_sub(f.builders_in as u32 + coming)
    }

    /// More beds. While some house lacks goods it could use, a producer of
    /// whichever good is scarcest: full houses with every good they can use
    /// become bigger houses, which is how the next era comes. Otherwise a
    /// hut, if some good is left over for it.
    fn ai_grow(&mut self, c: &mut Census) -> Step {
        let p = self.players[c.me as usize];
        // A house ready to grow a tier but for its materials: make them.
        if let Some(k) = self.upgrade_short(c.me).and_then(producer_of) {
            let step = self.ai_project(k, c, true);
            if step != Step::Blocked {
                return step;
            }
        }
        let goods = house_goods(p.era);
        let lacking = self.ents.iter().any(|e| {
            e.alive && e.owner == c.me && e.built >= 1.0 && e.kind.house_tier().is_some_and(|t| (e.goods.count_ones() as usize) < (house_max_goods(t) as usize).min(goods.len()))
        });
        // Short of houses for the next era: more huts come first anyway.
        let houses = self.ents.iter().filter(|e| e.alive && e.owner == c.me && e.kind.house_tier().is_some()).count() as u32;
        let few = p.era < LAST_ERA && houses < HOUSES_FOR_ERA + 1;
        let hut_first = (!lacking || few) && goods.iter().any(|&r| p.spare(r) > 0);
        if hut_first {
            let step = self.ai_project(Kind::Hut, c, true);
            if step != Step::Blocked {
                return step;
            }
        }
        let mut by_supply = goods.clone();
        by_supply.sort_by_key(|r| (p.supply[r.idx()], r.idx()));
        for r in by_supply {
            let Some(k) = producer_of(r) else { continue };
            let step = self.ai_project(k, c, true);
            if step != Step::Blocked {
                return step;
            }
        }
        if !hut_first && goods.iter().any(|&r| p.spare(r) > 0) {
            return self.ai_project(Kind::Hut, c, true);
        }
        Step::Blocked
    }

    /// The material a house that's ready to grow a tier is waiting for.
    fn upgrade_short(&self, me: u8) -> Option<Res> {
        let p = &self.players[me as usize];
        self.ents.iter().filter(|e| e.alive && e.owner == me && e.built >= 1.0).find_map(|e| {
            let (tier, next) = (e.kind.house_tier()?, e.kind.upgrade()?);
            if next.house_tier()? > p.era + 1 || e.residents < e.beds() || e.goods.count_ones() < house_max_goods(tier) as u32 {
                return None;
            }
            let had = |r: Res| e.kind.stats().cost.iter().find(|&&(q, _)| q == r).map_or(0, |&(_, k)| k as i32);
            next.stats().cost.iter().find(|&&(r, k)| p.free(r) < k as i32 - had(r)).map(|&(r, _)| r)
        })
    }

    /// What `kind` is short of to build and run: its cost, or a
    /// converter's inputs.
    fn ai_short_of(&self, me: u8, kind: Kind) -> Option<Res> {
        let p = &self.players[me as usize];
        // Inputs must be spare: a bakery fed with the houses' grain makes
        // bread for them and no more beds.
        self.short_of(me, kind).or_else(|| kind.stats().consumes.iter().find(|&&(r, k)| p.spare(r) < k as i32).map(|&(r, _)| r))
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
            match self.ai_short_of(me, what).and_then(producer_of) {
                Some(p) if p != what && self.unlocked(me, p) => what = p,
                Some(_) => return Step::Waiting, // short of what it makes itself
                None => break,
            }
        }
        if self.ai_short_of(me, what).is_some() || !self.unlocked(me, what) {
            return Step::Blocked; // short of something nothing makes yet
        }
        // Its builders and its crew, and some free workers kept back.
        let st = what.stats();
        let keep = if for_beds { 0 } else { KEEP_FREE };
        if c.spare < st.builders as u32 + st.workers as u32 + keep {
            return Step::Waiting;
        }
        if !self.ai_place(what, c) {
            return Step::Blocked;
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
                near.iter().step_by(2).take(400).find_map(|&(_, i)| {
                    let (x, y) = self.deps[i].center();
                    self.find_spot(me, kind, x, y, 1, 3, &c.reach)
                })
            }
            Some(_) => self.find_spot(me, kind, bx, by, 3, 24, &c.reach),
            // Further out as the town fills up, leaving the ground next to
            // deposits to the producers that need it (if there's room).
            None => {
                let s = kind.stats().size;
                let clear = |tx: i32, ty: i32| !self.next_to_deposit(tx, ty, s);
                self.find_spot_where(me, kind, bx, by, 5, 36, &c.reach, &clear).or_else(|| self.find_spot(me, kind, bx, by, 5, 36, &c.reach))
            }
        };
        let Some((tx, ty)) = spot else { return false };
        // Builders come from the campfire by themselves.
        match self.place(me, kind, tx, ty, &[]) {
            Ok(id) => {
                let st = kind.stats();
                c.spare = c.spare.saturating_sub(st.workers as u32 + st.builders as u32);
                c.unfinished.push(id);
                c.have[kind as usize] += 1;
                true
            }
            Err(_) => false,
        }
    }

    /// Spiral outward looking for a free spot, with a one-tile gap around
    /// it, that we have explored and our workers can walk to.
    #[allow(clippy::too_many_arguments)]
    fn find_spot(&self, me: u8, kind: Kind, x: f32, y: f32, rmin: i32, rmax: i32, reach: &[bool]) -> Option<(i32, i32)> {
        self.find_spot_where(me, kind, x, y, rmin, rmax, reach, &|_, _| true)
    }

    /// Is any tile around a footprint a deposit other than forest (which
    /// there's plenty of)?
    fn next_to_deposit(&self, tx: i32, ty: i32, size: i32) -> bool {
        let m = &self.map;
        (ty - 1..=ty + size).any(|y| {
            (tx - 1..=tx + size).any(|x| m.inside(x, y) && m.dep_at[m.idx(x, y)] >= 0 && self.deps[m.dep_at[m.idx(x, y)] as usize].kind != Dep::Forest)
        })
    }

    /// `find_spot`, with an extra test each spot must pass.
    #[allow(clippy::too_many_arguments)]
    fn find_spot_where(&self, me: u8, kind: Kind, x: f32, y: f32, rmin: i32, rmax: i32, reach: &[bool], ok: &dyn Fn(i32, i32) -> bool) -> Option<(i32, i32)> {
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
                if seen && self.can_place(kind, tx, ty, me, 1) && touches(&self.map, reach, tx, ty, s) && ok(tx, ty) {
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
            let people = pl.people as f32;
            // Well short of its army, it takes the next free worker even if
            // the next project then waits; otherwise the economy goes first.
            let behind = (army as f32) < people * style.army_share * 0.5;
            if c.spare == 0 || (!behind && c.spare <= crew) || army as f32 >= people * style.army_share {
                break;
            }
            let spare = |r: Res| pl.free(r) - reserve.iter().find(|&&(x, _)| x == r).map_or(0, |&(_, k)| k as i32);
            // The best unit it can train and afford: the latest era's.
            let affordable = |u: &Kind| u.era() <= pl.era && u.stats().cost.iter().all(|&(r, k)| spare(r) >= k as i32);
            let Some(unit) = self.ents[b as usize].kind.trains().iter().rev().copied().find(affordable) else { continue };
            if self.queue_unit(b, unit).is_ok() {
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
        let most = (p.people as f32 * STYLES[diff.min(2) as usize].army_share * 0.8) as usize;
        let wave = self.ais[me as usize].wave_size.min(most.max(4));
        // A town with every bed taken and nobody free can't field a bigger
        // wave: two minutes late, go with what there is. Losses free beds,
        // newcomers fill them, and the town moves again.
        let due = self.ais[me as usize].next_attack;
        let stuck = p.people >= p.beds && c.spare <= 1 && c.army.len() >= 4 && self.time >= due + 120.0;
        if (self.time >= due && c.army.len() >= wave) || stuck {
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

/// Does a footprint have a tile next to it (corners included) in `reach`?
fn touches(map: &crate::map::Map, reach: &[bool], tx: i32, ty: i32, size: i32) -> bool {
    (ty - 1..=ty + size).any(|y| (tx - 1..=tx + size).any(|x| (x < tx || y < ty || x >= tx + size || y >= ty + size) && map.inside(x, y) && reach[map.idx(x, y)]))
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
