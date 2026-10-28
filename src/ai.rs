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
use crate::econ;

// A log of the computer's reasons, for diagnosing it in tests: off (None)
// in the game, so nothing is formatted or kept.
thread_local! {
    static AI_LOG: std::cell::RefCell<Option<Vec<String>>> = const { std::cell::RefCell::new(None) };
}
macro_rules! ailog {
    ($($t:tt)*) => { AI_LOG.with(|l| if let Some(v) = l.borrow_mut().as_mut() { v.push(format!($($t)*)); }) };
}
/// Start keeping the computer's reasons (tests only).
#[cfg(test)]
pub fn ai_log_start() {
    AI_LOG.with(|l| *l.borrow_mut() = Some(Vec::new()));
}
/// What it kept since `ai_log_start`, and stop keeping.
#[cfg(test)]
pub fn ai_log_take() -> Vec<String> {
    AI_LOG.with(|l| l.borrow_mut().take().unwrap_or_default())
}
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
    /// An attack wave gathering here before it goes, until `gather_until`
    /// at the latest, so it arrives together instead of one by one.
    pub gather: Option<(f32, f32)>,
    pub gather_until: f32,
}

impl Ai {
    pub fn new(difficulty: u32, on: bool, phase: f32) -> Ai {
        let (first, wave) = match difficulty {
            0 => (540.0, 4),
            1 => (420.0, 6),
            _ => (300.0, 8),
        };
        Ai { on, timer: 1.0 + phase, difficulty, next_attack: first, wave_size: wave, alarm: None, scout: None, scout_leg: 0, last_grew: false, gather: None, gather_until: 0.0 }
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
    Style { army_share: 0.1, queue: 1 },
    Style { army_share: 0.3, queue: 1 },
    Style { army_share: 0.4, queue: 2 },
];

/// Free residents the AI keeps at home: one to crew the next food producer
/// when the houses fill up, one more for whatever comes next.
const KEEP_FREE: u32 = 2;
/// Wood and stone left free after a tower or a second barracks.
const LUXURY_RESERVE: i32 = 4;
/// Wood and stone the army leaves free for house upgrades while the town grows.
const HOUSE_RESERVE: i32 = 4;
/// Supply the computer keeps ahead of use in wood, stone and brick.
const RAW_MARGIN: i32 = 6;
/// Wood and stone every other project leaves free for the next quarry or sawmill.
const MATERIAL_RESERVE: i32 = 2;

/// The build plan: (building, how many we want), in order. It follows the
/// tech tree, so each step is unlocked in time. Producers for whatever runs
/// short are added along the way (`ai_project`), and beds come first.
const PLAN: [(Kind, u32); 61] = [
    (Kind::LumberCamp, 1),
    (Kind::Farm, 1),
    (Kind::Barracks, 1),
    (Kind::Quarry, 1),
    (Kind::Range, 1),
    (Kind::Tower, 1),
    (Kind::Quarry, 2),
    (Kind::Quarry, 3),
    // A fourth, for slack: cottages eat every spare stone, and the Sawmill
    // (2 stone) that gets the town out of its wood ceiling needs some.
    (Kind::Quarry, 4),
    (Kind::FishingHut, 1),
    (Kind::HuntingLodge, 1),
    (Kind::Orchard, 1),
    // Medieval: iron for the army, then the new house goods.
    (Kind::Sawmill, 1),
    (Kind::Pasture, 1),
    (Kind::Stable, 1),
    (Kind::Pasture, 2),
    (Kind::Barracks, 2),
    (Kind::Range, 2),
    (Kind::Stable, 2),
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
    // Gunpowder: a second Capitol, stone and brick in bulk, powder for the
    // army, then furniture, books and the circus.
    (Kind::Capitol, 2),
    (Kind::Kiln, 1),
    (Kind::Stoneworks, 1),
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
    (Kind::AirDefense, 1),
    (Kind::HaberBosch, 1),
    (Kind::PowerPlant, 2),
    // Atomic: uranium, the reactor, cars and TVs, and the silo.
    (Kind::UraniumMine, 1),
    (Kind::Reactor, 1),
    (Kind::CarPlant, 1),
    (Kind::TvPlant, 1),
    (Kind::MissileSilo, 1),
    (Kind::AirDefense, 2),
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
    /// Build past the town's target for a kind: the target's own goods
    /// have nowhere to go (no free deposit), so the houses need others.
    relax: bool,
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

/// The first building that makes a resource, if any does.
fn producer_of(r: Res) -> Option<Kind> {
    Kind::BUILDABLE.into_iter().find(|&k| k != Kind::Capitol && k.stats().produces.iter().any(|&(p, _)| p == r))
}

/// The house goods a player of `era` can make: food in the Ancient era;
/// bread, clothes and beer join them in the Medieval.
/// What the town of a player in `era` is working toward: the fewest
/// buildings (`econ.rs`) for the next era's houses, or for the silo once
/// they are in the last one. The computer builds no more of a kind than this
/// needs (one over, for slack) and lets go of what it no longer needs.
fn target(era: u8) -> &'static econ::Plan {
    static PLANS: std::sync::OnceLock<Vec<econ::Plan>> = std::sync::OnceLock::new();
    &PLANS.get_or_init(|| (1..=5).map(econ::era_plan).chain(std::iter::once(econ::silo_plan())).collect())[era.min(5) as usize]
}

/// Kinds the computer keeps one of for its army, whatever the target says:
/// iron for swordsmen, horses for riders.
const ARMY_SUPPLY: [Kind; 2] = [Kind::IronMine, Kind::Pasture];

fn house_goods(era: u8) -> Vec<Res> {
    Res::ALL.into_iter().filter(|r| r.is_house_good() && r.era() <= era && producer_of(*r).is_some_and(|k| k.era() <= era)).collect()
}

// A second `impl Game` block, in a different file. Rust lets you split a
// type's methods across modules, which keeps the AI code out of game.rs.
impl Game {
    /// The most of `kind` this player's town needs now: what `target` has,
    /// plus one, and never past `MAX_SAME`. Houses and fields have no limit,
    /// nor do the soldiers' buildings (the plan and a reserve keep those).
    fn ai_max(&self, me: u8, kind: Kind) -> usize {
        let mut hard = Self::max_of(kind);
        // A dozen houses are all the next era asks for; more huts only hold
        // the wood the upgrades are waiting for.
        if kind == Kind::Hut {
            let houses = self.ents.iter().filter(|e| e.alive && e.owner == me && e.kind.house_tier().is_some()).count();
            return if houses < HOUSES_FOR_ERA as usize + 2 { usize::MAX } else { 0 };
        }
        // Fields are unlimited for a player; the computer keeps to what the
        // target needs (and a few spare), or its farms hold all the wood.
        if kind == Kind::Farm {
            hard = target(self.players[me as usize].era).count(kind) as usize + 3;
        }
        // The Kiln makes three Brickworks' worth: once it can be built, no
        // more of the old ones (they would take the stone it waits for).
        if kind == Kind::Brickworks && self.unlocked(me, Kind::Kiln) {
            return 2;
        }
        // Materials (wood, stone, brick, iron, coal, steel ...) pay for
        // everything, the army included: as many of their producers as it
        // takes for the supply to stay `RAW_MARGIN` ahead of use. (Houses'
        // goods follow the target instead.)
        let material = kind.stats().produces.first().filter(|&&(r, _)| !r.is_house_good() && kind.house_tier().is_none() && kind != Kind::Capitol);
        if let Some(&(res, out)) = material {
            let pl = &self.players[me as usize];
            let built = self.ents.iter().filter(|e| e.alive && e.owner == me && e.kind == kind && e.built >= 1.0).count() as i32;
            let others = pl.supply[res.idx()] as i32 - built * out as i32;
            let need = pl.used[res.idx()] as i32 + RAW_MARGIN - others;
            return hard.min((need.max(0) as usize).div_ceil(out as usize));
        }
        if kind == Kind::Farm || hard == usize::MAX || matches!(kind, Kind::Barracks | Kind::Range | Kind::Stable | Kind::SiegeWorkshop | Kind::Tower) {
            return hard;
        }
        let want = target(self.players[me as usize].era).count(kind) as usize;
        let army = ARMY_SUPPLY.contains(&kind) as usize;
        let wide = if want > 0 { want + 1 } else { 0 };
        hard.min(wide.max(army))
    }

    /// The producer to build for more of `r`: of those `me` may build now
    /// (unlocked, and not at `MAX_SAME` yet), the one that makes the most
    /// among those it can afford right away, else the one that makes the
    /// most (and then its own needs come first).
    fn ai_producer(&self, me: u8, r: Res) -> Option<Kind> {
        self.ai_producer_ex(me, r, &[])
    }

    /// `ai_producer`, leaving out the kinds in `skip`.
    fn ai_producer_ex(&self, me: u8, r: Res, skip: &[Kind]) -> Option<Kind> {
        let makes = |k: Kind| k.stats().produces.iter().find(|&&(q, _)| q == r).map_or(0, |&(_, n)| n);
        let ok = |k: Kind| makes(k) > 0 && k != Kind::Capitol && !skip.contains(&k) && self.unlocked(me, k) && self.count_of(me, k) < self.ai_max(me, k);
        let best = |pool: &mut dyn Iterator<Item = Kind>| pool.max_by_key(|&k| (makes(k), k as u32));
        best(&mut Kind::BUILDABLE.into_iter().filter(|&k| ok(k) && self.ai_short_of(me, k).is_none()))
            .or_else(|| best(&mut Kind::BUILDABLE.into_iter().filter(|&k| ok(k))))
            .or_else(|| producer_of(r).filter(|k| !skip.contains(k)))
    }

    pub fn ai_think(&mut self, me: u8) {
        let Some(cap) = self.home_capitol(me) else { return };
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
        self.ai_nuke(me, c.home);
    }

    /// A silo: arm a nuke when its slots are free, and launch it at the
    /// nearest rival Capitol.
    fn ai_nuke(&mut self, me: u8, home: (f32, f32)) {
        let Some(s) = self.find_first(me, Kind::MissileSilo) else { return };
        let (id, state, built) = (self.ents[s].id, self.ents[s].nuke, self.ents[s].built);
        if built < 1.0 {
            return;
        }
        if state == 0 {
            let _ = self.apply(me, Command::Arm { id });
        } else if state == 2 {
            if let Some((x, y)) = self.target_for(me, home.0, home.1) {
                let _ = self.apply(me, Command::Launch { id, x, y });
            }
        }
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
        let near: Vec<u32> = c.unfinished.iter().copied().filter(|&b| (self.ents[b as usize].x - c.home.0).hypot(self.ents[b as usize].y - c.home.1) < 30.0).collect();
        let busy = near.iter().any(|&b| self.builders_missing(b) > 0) || near.len() >= 2;
        let p = self.players[me as usize];
        // Beds ahead of people: grow before the houses are full.
        let tight = p.people + 2 >= p.beds;
        // Beds and the plan take turns, so neither starves the other.
        let mut acted = busy;
        let plan_turn = self.ais[me as usize].last_grew;
        ailog!("economy: people {}/{} spare {} busy {busy} tight {tight} plan_turn {plan_turn} era {} houses past {}", p.people, p.beds, c.spare, p.era, self.houses_past_era(me));
        if !acted && (tight || c.spare == 0) && !plan_turn {
            let step = self.ai_grow(c);
            ailog!("grow -> {step:?}");
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
            // Soldiers' buildings only from a surplus: what `ai_free_up`
            // tears down for a house must not be rebuilt before the house
            // has used the room.
            if matches!(kind, Kind::Tower | Kind::Range | Kind::Stable | Kind::SiegeWorkshop) || (n >= 2 && matches!(kind, Kind::Barracks | Kind::Capitol)) {
                if kind.stats().cost.iter().any(|&(r, k)| p.free(r) < k as i32 + LUXURY_RESERVE) {
                    continue;
                }
            }
            let step = if acted { Step::Waiting } else { self.ai_project(kind, c, false) };
            ailog!("plan {kind:?} (have {} want {n}): {step:?}", c.have[kind as usize]);
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
        let st = f.kind.stats();
        (st.builders.max(st.workers) as u32).saturating_sub(coming) // (builders at work keep their order; its crew builds it)
    }

    /// More beds. While some house lacks goods it could use, a producer of
    /// whichever good is scarcest: full houses with every good they can use
    /// become bigger houses, which is how the next era comes. Otherwise a
    /// hut, if some good is left over for it.
    fn ai_grow(&mut self, c: &mut Census) -> Step {
        let p = self.players[c.me as usize];
        // A house ready to grow a tier but for its materials: make them.
        if let Some(r) = self.upgrade_short(c.me) {
            ailog!("grow: an upgrade waits for {r:?}");
            // Every way of making it, the best first: one may have nowhere
            // to stand (no free clay), another want a slot it can free.
            let mut tried: Vec<Kind> = Vec::new();
            for _ in 0..3 {
                let Some(k) = self.ai_producer_ex(c.me, r, &tried) else { break };
                tried.push(k);
                if self.count_of(c.me, k) >= self.ai_max(c.me, k) {
                    continue;
                }
                let step = self.ai_project(k, c, true);
                ailog!("grow: {r:?} from {k:?}: {step:?}");
                if step != Step::Blocked {
                    return step;
                }
                // The producer itself is short (a Kiln needs stone, and
                // the old brickworks hold it): make room.
                if let Some(q) = self.ai_short_of(c.me, k) {
                    if self.ai_free_up(c.me, q) {
                        return Step::Started;
                    }
                }
            }
            // Nothing could be built: make room for the material itself.
            if self.ai_free_up(c.me, r) {
                return Step::Started;
            }
        }
        let all = house_goods(p.era);
        let goods: Vec<Res> = target(p.era).goods.iter().copied().filter(|r| all.contains(r)).collect();
        let lacking = self.ents.iter().any(|e| {
            e.alive && e.owner == c.me && e.built >= 1.0 && e.kind.house_tier().is_some_and(|t| (e.goods.count_ones() as usize) < (house_max_goods(t) as usize).min(goods.len()))
        });
        // Short of houses for the next era: more huts come first anyway.
        let houses = self.ents.iter().filter(|e| e.alive && e.owner == c.me && e.kind.house_tier().is_some()).count() as u32;
        let few = p.era < LAST_ERA && houses < HOUSES_FOR_ERA + 1;
        let hut_first = (!lacking || few) && goods.iter().any(|&r| p.spare(r) > 0);
        ailog!("grow: goods {goods:?} lacking {lacking} houses {houses} hut_first {hut_first} spare {:?}", goods.iter().map(|&r| (r, p.spare(r))).collect::<Vec<_>>());
        if hut_first {
            let step = self.ai_project(Kind::Hut, c, true);
            if step != Step::Blocked {
                return step;
            }
        }
        // Producers of goods for a house that lacks one, or for the next
        // house when none of a good is spare. More than that only hold slots
        // (and get torn down again for them).
        let mut by_supply: Vec<Res> = goods.iter().copied().filter(|&r| lacking || p.spare(r) <= 0).collect();
        by_supply.sort_by_key(|r| (p.supply[r.idx()], r.idx()));
        for r in by_supply {
            let Some(k) = self.ai_producer(c.me, r) else { continue };
            let step = self.ai_project(k, c, true);
            ailog!("grow: good {r:?} (supply {}) from {k:?}: {step:?}", p.supply[r.idx()]);
            if step != Step::Blocked {
                return step;
            }
        }
        // The target's goods have nowhere to go: any other the houses can use.
        c.relax = true;
        let mut others = if lacking { all.clone() } else { Vec::new() };
        others.retain(|r| !goods.contains(r));
        others.sort_by_key(|r| (p.supply[r.idx()], r.idx()));
        for r in others {
            let Some(k) = producer_of(r).filter(|&k| self.unlocked(c.me, k) && self.count_of(c.me, k) < Self::max_of(k)) else { continue };
            let step = self.ai_project(k, c, true);
            if step != Step::Blocked {
                c.relax = false;
                return step;
            }
        }
        c.relax = false;
        if !hut_first && goods.iter().any(|&r| p.spare(r) > 0) {
            return self.ai_project(Kind::Hut, c, true);
        }
        Step::Blocked
    }

    /// The material a house that's ready to grow a tier is waiting for.
    pub(crate) fn upgrade_short(&self, me: u8) -> Option<Res> {
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
        ailog!("P{} release (few free workers): tear down {:?}", c.me, self.ents[id as usize].kind);
        self.apply(c.me, Command::Demolish { ids: vec![id] }).is_ok()
    }

    /// Short of `r` with every producer of it at the limit (`MAX_SAME`):
    /// tear down something that holds it and can be spared, the newest
    /// first: a second military building of a kind, a tower, a hut past the
    /// houses the next era needs. Returns whether it did.
    fn ai_free_up(&mut self, me: u8, r: Res) -> bool {
        let holds = |k: Kind| k.stats().cost.iter().any(|&(q, _)| q == r);
        let spare = |g: &Game, e: &Entity| {
            if !e.alive || e.owner != me || !e.is_building() || !holds(e.kind) || e.kind == Kind::Capitol {
                return false;
            }
            match e.kind {
                Kind::Barracks => g.count_of(me, e.kind) > 1 && e.queue.is_empty(),
                // Luxuries when a house upgrade has waited for stone: the
                // plan doesn't rebuild them meanwhile (see `hold`).
                Kind::Range | Kind::Stable | Kind::SiegeWorkshop => e.queue.is_empty(),
                Kind::Tower => true,
                // The Kiln (4 stone) makes three times a Brickworks' bricks,
                // and the old ones hold the stone it is waiting for.
                Kind::Brickworks => g.unlocked(me, Kind::Kiln) && g.count_of(me, Kind::Kiln) == 0 && g.count_of(me, Kind::Brickworks) > 1,
                // A food or cloth producer nobody is eating from holds
                // slots a house upgrade needs. Never the raw materials.
                // Only past what the town needs, though: one the target
                // wants would be rebuilt at once with the slots it gave up
                // (playtest: a Printer torn down and rebuilt every 20 s).
                k => {
                    let st = k.stats();
                    let n = g.count_of(me, k);
                    let over = n > g.ai_max(me, k);
                    e.crewed && e.built >= 1.0 && st.workers > 0 && over && st.produces.iter().all(|&(q, n)| g.players[me as usize].spare(q) >= n as i32)
                }
            }
        };
        let Some(id) = self.ents.iter().rev().find(|e| spare(self, e)).map(|e| e.id).or_else(|| self.ai_disband_one(me, r)) else {
            ailog!("  free up {r:?}: nothing to spare");
            return false;
        };
        ailog!("  P{me} free up {r:?}: tear down {:?} (t {:.0})", self.ents[id as usize].kind, self.time);
        self.apply(me, Command::Demolish { ids: vec![id] }).is_ok()
    }

    /// Nothing left to tear down: let a soldier go. Soldiers hold wood,
    /// iron and horses, and the town's next era is worth more than the
    /// tenth swordsman. The one that holds most of `r`, never the last few,
    /// and only one standing at home.
    fn ai_disband_one(&self, me: u8, r: Res) -> Option<u32> {
        const KEEP_SOLDIERS: u32 = 14;
        if self.players[me as usize].soldiers <= KEEP_SOLDIERS {
            return None;
        }
        let held = |k: Kind| k.stats().cost.iter().find(|&&(q, _)| q == r).map_or(0, |&(_, n)| n);
        let home = self.campfire(me)?;
        self.ents
            .iter()
            .filter(|e| e.alive && e.owner == me && !e.is_building() && e.kind.is_military() && held(e.kind) > 0)
            .filter(|e| ((e.x - home.0).powi(2) + (e.y - home.1).powi(2)).sqrt() < 30.0)
            .max_by_key(|e| (held(e.kind), std::cmp::Reverse(e.id)))
            .map(|e| e.id)
    }

    /// Build `kind`, or, if it's short of some resource, the producer of
    /// that resource instead (one level deep: a quarry short of wood gets a
    /// lumber camp, which is free). A producer needs its crew and leaves
    /// `KEEP_FREE` residents at home, except when it's for beds (`for_beds`),
    /// which may use the last of them.
    fn ai_project(&mut self, kind: Kind, c: &mut Census, for_beds: bool) -> Step {
        let me = c.me;
        if !c.relax && self.count_of(me, kind) >= self.ai_max(me, kind) {
            ailog!("  project {kind:?}: has {} of max {}", self.count_of(me, kind), self.ai_max(me, kind));
            return Step::Blocked; // the town has all of these it needs
        }
        let mut what = kind;
        let mut seen = vec![kind];
        for _ in 0..3 {
            let Some(short) = self.ai_short_of(me, what) else { break };
            let Some(p) = self.ai_producer(me, short) else { break };
            // Every producer of it is at the limit, or the chain comes back
            // round (a sawmill needs stone, a quarry needs wood, the best
            // wood is a sawmill): make room instead.
            if self.count_of(me, p) >= self.ai_max(me, p) || seen.contains(&p) {
                ailog!("  project {kind:?}: {what:?} short of {short:?}, {p:?} at its max {}: free up", self.ai_max(me, p));
                return if self.ai_free_up(me, short) { Step::Started } else { Step::Blocked };
            }
            if !self.unlocked(me, p) {
                break;
            }
            seen.push(p);
            what = p;
        }
        if self.ai_short_of(me, what).is_some() || !self.unlocked(me, what) {
            ailog!("  project {kind:?}: {what:?} short of {:?} (unlocked {})", self.ai_short_of(me, what), self.unlocked(me, what));
            return Step::Blocked; // short of something nothing makes yet
        }
        // Everything but the material producers leaves the last wood and
        // stone: a quarry costs wood, a sawmill stone, and with both used
        // up neither can be built again (playtest: towns stood still with
        // every slot of both held).
        let makes_material = what.stats().produces.first().is_some_and(|&(r, _)| !r.is_house_good());
        if !makes_material && self.players[me as usize].era >= 1 {
            let p = &self.players[me as usize];
            if let Some(&(r, k)) = what.stats().cost.iter().find(|&&(r, k)| matches!(r, Res::Wood | Res::Stone) && p.free(r) - (k as i32) < MATERIAL_RESERVE) {
                ailog!("  project {kind:?}: {what:?} would leave less than {MATERIAL_RESERVE} {r:?} (needs {k})");
                return Step::Blocked;
            }
        }
        // Its builders and its crew, and some free workers kept back.
        let st = what.stats();
        let keep = if for_beds { 0 } else { KEEP_FREE };
        // (Builders become its crew when it's done.)
        if c.spare < (st.builders.max(st.workers)) as u32 + keep {
            ailog!("  project {kind:?}: {what:?} waits for workers ({} spare)", c.spare);
            return Step::Waiting;
        }
        if !self.ai_place(what, c) {
            ailog!("  project {kind:?}: nowhere to put {what:?}");
            return Step::Blocked;
        }
        ailog!("  project {kind:?}: placed {what:?}");
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
            Some(_) => self.find_spot(me, kind, bx, by, 3, 32, &c.reach),
            // A second Capitol well away from the first, so losing one
            // doesn't take the other's town with it.
            None if kind == Kind::Capitol => {
                let clear = |tx: i32, ty: i32| !self.next_to_deposit(tx, ty, 3);
                self.find_spot_where(me, kind, bx, by, 16, 34, &c.reach, &clear)
            }
            // Further out as the town fills up, leaving the ground next to
            // deposits to the producers that need it (if there's room).
            None => {
                let s = kind.stats().size;
                let clear = |tx: i32, ty: i32| !self.next_to_deposit(tx, ty, s);
                self.find_spot_where(me, kind, bx, by, 5, 40, &c.reach, &clear).or_else(|| self.find_spot(me, kind, bx, by, 5, 40, &c.reach))
            }
        };
        let Some((tx, ty)) = spot else {
            if let Some(dep) = kind.stats().needs_deposit {
                let seen = self.deps.iter().filter(|d| d.kind == dep && self.explored_by(me, d.tx, d.ty)).count();
                let all = self.deps.iter().filter(|d| d.kind == dep).count();
                ailog!("  place {kind:?}: {dep:?} tiles explored {seen} of {all}, none with room");
            }
            return false;
        };
        // Builders come from the campfire by themselves.
        match self.place(me, kind, tx, ty, &[]) {
            Ok(id) => {
                let st = kind.stats();
                c.spare = c.spare.saturating_sub(st.workers.max(st.builders) as u32);
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
            // While the town is still growing into its next era, its house
            // upgrades come before more soldiers: they need wood and stone.
            let growing = self.houses_past_era(me) < HOUSES_FOR_ERA && pl.era < LAST_ERA;
            let spare = |r: Res| {
                let house = if growing && matches!(r, Res::Wood | Res::Stone) { HOUSE_RESERVE } else { 0 };
                pl.free(r) - house - reserve.iter().find(|&&(x, _)| x == r).map_or(0, |&(_, k)| k as i32)
            };
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
        // First two rings round home, where a start's deposits lie (clay for
        // brick, iron, sheep hills ... are 20 to 30 tiles out, past what the
        // Capitol sees: playtest, the computer never found its clay, so it
        // never made brick or a Sawmill and stood still in the Medieval era).
        let mut legs: Vec<(f32, f32)> = Vec::new();
        for (radius, n) in [(24.0f32, 10), (33.0, 14)] {
            for k in 0..n {
                let a = k as f32 / n as f32 * std::f32::consts::TAU;
                legs.push(((c.home.0 + a.cos() * radius).clamp(4.0, w - 5.0), (c.home.1 + a.sin() * radius).clamp(4.0, h - 5.0)));
            }
        }
        let ai = &self.ais[me as usize];
        let (scout, leg) = (ai.scout, ai.scout_leg as usize);
        // Where to look next: a ring leg, then the nearest ground nobody has
        // seen that our workers could walk to (a town runs out of stone and
        // clay round its start: playtest, a third of the map's stone was
        // never found, so its houses stopped growing).
        let next = |g: &Game, from: (f32, f32), leg: usize| -> Option<(f32, f32)> {
            if leg < legs.len() {
                return Some(legs[leg]);
            }
            let m = &g.map;
            let mut best: Option<(f32, (f32, f32))> = None;
            for ty in (2..m.h - 2).step_by(3) {
                for tx in (2..m.w - 2).step_by(3) {
                    if g.explored_by(me, tx, ty) || !c.reach[m.idx(tx, ty)] {
                        continue;
                    }
                    let (x, y) = (tx as f32 + 0.5, ty as f32 + 0.5);
                    let d = (x - c.home.0).hypot(y - c.home.1) + 0.5 * (x - from.0).hypot(y - from.1);
                    if best.is_none_or(|(b, _)| d < b) {
                        best = Some((d, (x, y)));
                    }
                }
            }
            best.map(|(_, p)| p)
        };
        let Some(id) = scout.filter(|&id| self.alive(id)) else {
            // Pick one: the first soldier we have.
            if let Some(&id) = c.army.first() {
                if let Some(l) = next(self, (self.ents[id as usize].x, self.ents[id as usize].y), leg) {
                    c.army.remove(0);
                    self.ais[me as usize].scout = Some(id);
                    self.order_move(id, l.0, l.1);
                }
            }
            return;
        };
        c.army.retain(|&a| a != id);
        // A scout that stopped to fight (soldiers fight what they see when
        // they stand still) goes on instead: it's there to look, and one
        // rider picking off workers for minutes isn't an attack.
        let fighting = matches!(self.ents[id as usize].order, Order::Attack { auto: true, .. });
        if self.ents[id as usize].order != Order::Idle && !fighting {
            return;
        }
        let ai = &mut self.ais[me as usize];
        ai.scout_leg = ai.scout_leg.saturating_add(1).min(legs.len() as u8);
        let leg = ai.scout_leg as usize;
        match next(self, (self.ents[id as usize].x, self.ents[id as usize].y), leg) {
            Some((x, y)) => self.order_move(id, x, y),
            None => {
                // Everything in reach is seen: back home, and into the army.
                self.ais[me as usize].scout = None;
                self.order_move(id, c.home.0, c.home.1 + 4.0);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Fighting

    fn ai_fight(&mut self, c: &Census) {
        let me = c.me;
        let (bx, by) = c.home;
        let diff = self.ais[me as usize].difficulty;
        // Defend: enemies near home or by any of our buildings, or anything
        // of ours being hit near home, pull the army back.
        let threat = self.intruder(me, bx, by).or_else(|| self.ais[me as usize].alarm.take().filter(|&(x, y)| (x - bx).hypot(y - by) < 22.0));
        if let Some((tx, ty)) = threat {
            self.ais[me as usize].gather = None;
            for &id in &c.army {
                if !matches!(self.ents[id as usize].order, Order::Attack { .. }) {
                    self.order_attack_move(id, tx, ty);
                }
            }
            return;
        }
        // A wave gathering: go once most of it is there, or it's been long enough.
        if let Some((gx, gy)) = self.ais[me as usize].gather {
            let there = c.army.iter().filter(|&&id| (self.ents[id as usize].x - gx).hypot(self.ents[id as usize].y - gy) < 6.0).count();
            if there * 10 >= c.army.len() * 8 || self.time >= self.ais[me as usize].gather_until {
                self.ais[me as usize].gather = None;
                if let Some((tx, ty)) = self.target_for(me, bx, by) {
                    let spots = formation_around(c.army.len(), tx, ty);
                    for (&id, &(x, y)) in c.army.iter().zip(&spots) {
                        self.order_attack_move(id, x, y);
                    }
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
                // First gather a third of the way there, then go together.
                let (gx, gy) = (bx + (tx - bx) * 0.3, by + (ty - by) * 0.3);
                let spots = formation_around(c.army.len(), gx, gy);
                for (&id, &(x, y)) in c.army.iter().zip(&spots) {
                    self.order_move(id, x, y);
                }
                let ai = &mut self.ais[me as usize];
                ai.gather = Some((gx, gy));
                ai.gather_until = self.time + 45.0;
            }
            self.ais[me as usize].next_attack = self.time + 110.0;
            self.ais[me as usize].wave_size += 2 + diff as usize;
        }
    }

    /// An enemy soldier in our town: near home, or close to any of our
    /// buildings. Enemy workers building nearby don't count.
    fn intruder(&self, me: u8, bx: f32, by: f32) -> Option<(f32, f32)> {
        if let Some(p) = self.enemy_unit_near(me, bx, by, 16.0) {
            return Some(p);
        }
        let ours: Vec<(f32, f32)> = self.ents.iter().filter(|e| e.alive && e.owner == me && e.is_building()).map(|e| (e.x, e.y)).collect();
        self.ents
            .iter()
            .filter(|e| e.alive && e.owner != me && e.owner != 0 && e.kind.is_military() && !e.kind.is_air())
            .find(|e| (e.x - bx).hypot(e.y - by) < 34.0 && ours.iter().any(|&(x, y)| (e.x - x).hypot(e.y - y) < 8.0))
            .map(|e| (e.x, e.y))
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

/// Spots in a loose square around (x, y), one per unit, so a wave doesn't
/// pile onto one point.
fn formation_around(n: usize, x: f32, y: f32) -> Vec<(f32, f32)> {
    let cols = (n as f32).sqrt().ceil().max(1.0) as usize;
    let off = (cols as f32 - 1.0) / 2.0;
    (0..n).map(|k| (x + ((k % cols) as f32 - off) * 0.9, y + ((k / cols) as f32 - off) * 0.9)).collect()
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
