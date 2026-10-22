//! People: beds, workers, builders and recruits.
//!
//! Everyone is a unit you can see. Workers with nothing to do stand around
//! the **campfire** in front of the Capitol: they are the free people.
//! - A producer needs workers standing at it (`Stats::workers`); without its
//!   full crew there it makes nothing. Workers can be killed there.
//! - A foundation needs builders: workers who walk to it and are used up.
//! - Training a soldier turns a free worker into one: they walk from the
//!   campfire to the barracks, and training starts when they get there.
//! Free workers go where they're needed by themselves (`recruit`), nearest
//! first. Moving a worker away from a producer pauses it: it keeps holding
//! its slots but stops hiring, until it's given workers again or resumed.
//!
//! Houses give beds, which cap how many people there are (soldiers count).
//! While a bed is free, newcomers turn up at the campfire, faster in a
//! bigger town (`growth_interval`). If beds run short, the free workers
//! leave first, then workers at producers that don't make house goods.

use crate::defs::*;
use crate::game::*;

/// How far around the campfire an idle worker counts as free (tiles).
pub const CAMPFIRE_AREA: f32 = 3.0;
/// Nothing may be built this close to a campfire.
pub const CAMPFIRE_CLEAR: f32 = 2.4;
/// A worker this close to a building's edge is at work there.
pub const AT_WORK: f32 = 1.0;
/// The campfire burns this far in front of the Capitol's centre (+y, the
/// side with the door).
pub const CAMPFIRE_AHEAD: f32 = 3.2;

/// Who's waiting for people at a building, worked out for `recruit`.
#[derive(Clone, Copy, Default)]
struct Wants {
    builders_coming: u8,
    recruits_coming: u8,
}

impl Game {
    // -----------------------------------------------------------------------
    // Where people are

    /// Where `owner`'s campfire burns, if they still have a Capitol.
    pub fn campfire(&self, owner: u8) -> Option<(f32, f32)> {
        self.find_first(owner, Kind::Capitol).map(|c| (self.ents[c].x, self.ents[c].y + CAMPFIRE_AHEAD))
    }

    /// A spot on the ring around the campfire for worker `id` to stand on.
    pub(crate) fn campfire_spot(&self, owner: u8, id: u32) -> Option<(f32, f32)> {
        let (cx, cy) = self.campfire(owner)?;
        // The golden angle spreads people evenly, whatever their ids.
        let a = id as f32 * 2.399_963;
        let r = 1.2 + (id % 3) as f32 * 0.5;
        Some((cx + a.cos() * r, cy + a.sin() * r))
    }

    /// Is this a free worker: idle, at the campfire?
    pub fn is_free_worker(&self, e: &Entity) -> bool {
        if !e.alive || e.kind != Kind::Worker || e.order != Order::Idle {
            return false;
        }
        self.campfire(e.owner).is_some_and(|(cx, cy)| (e.x - cx).powi(2) + (e.y - cy).powi(2) <= CAMPFIRE_AREA * CAMPFIRE_AREA)
    }

    /// Send a worker back to stand at the campfire.
    pub(crate) fn go_home(&mut self, i: usize) {
        let (owner, id) = (self.ents[i].owner, self.ents[i].id);
        match self.campfire_spot(owner, id) {
            Some((x, y)) => self.ents[i].set_order(Order::Move { x, y }),
            None => self.ents[i].set_order(Order::Idle),
        }
    }

    /// Remove a unit without a death: a builder used up at a foundation, a
    /// recruit who went into the barracks, someone who moved away.
    pub(crate) fn vanish(&mut self, i: usize) {
        let e = &mut self.ents[i];
        e.alive = false;
        e.selected = false;
    }

    /// Spawn a worker at `owner`'s campfire (or at (x, y), walking home).
    pub(crate) fn spawn_worker(&mut self, owner: u8, at: Option<(f32, f32)>) -> Option<u32> {
        let id = self.ents.len() as u32;
        let (x, y) = match at {
            Some(p) => p,
            None => self.campfire_spot(owner, id)?,
        };
        let id = self.spawn_unit(Kind::Worker, owner, x, y);
        if at.is_some() {
            self.go_home(id as usize);
        }
        Some(id)
    }

    // -----------------------------------------------------------------------
    // The economy, every tick

    /// Work out each player's economy from scratch, from what exists, in
    /// the design's fixed order (docs/design/economy-and-eras.md,
    /// *Resolution order*). Cheap enough to do every tick, which means slots
    /// come free the tick after something dies.
    ///
    /// 1. Crews: who is standing at work where.
    /// 2. Supply from producers with their full crew.
    /// 3. Use: every building, foundation, unit and queued unit.
    /// 4. Converters take their inputs, in id order, if they're free.
    /// 5. Units over a shortage are unsupplied (`supply_units`).
    /// 6. Houses take one slot of each good they can use from what's left,
    ///    shared out evenly, nearest the Capitol first (`house_goods`).
    /// 7. If there are more people than beds, some leave.
    pub(crate) fn resolve(&mut self) {
        self.resolve_with(true);
    }

    /// Work out all the counts `resolve` does, without changing anything
    /// that's saved (houses' goods, units' health, who lives where).
    pub(crate) fn recount(&mut self) {
        self.resolve_with(false);
    }

    fn resolve_with(&mut self, settle: bool) {
        let n = self.players.len();
        // 1. Crews: workers with a Work order, and which of them are there.
        let mut crew = vec![0u8; self.ents.len()];
        let mut hired = vec![0u8; self.ents.len()];
        let mut people = vec![0u32; n];
        let mut free = vec![0u32; n];
        let mut working = vec![0u32; n];
        let mut soldiers = vec![0u32; n];
        for i in 0..self.ents.len() {
            let e = &self.ents[i];
            if !e.alive {
                continue;
            }
            let o = e.owner as usize;
            if e.is_building() {
                people[o] += e.recruits as u32;
                soldiers[o] += e.recruits as u32;
                continue;
            }
            people[o] += 1;
            if e.kind != Kind::Worker {
                soldiers[o] += 1;
            } else if let Order::Work(b) = e.order {
                working[o] += 1;
                if let Some(t) = self.ents.get(b as usize).filter(|t| t.alive && t.owner == e.owner) {
                    hired[b as usize] = hired[b as usize].saturating_add(1);
                    if t.edge_dist(e.x, e.y) <= AT_WORK {
                        crew[b as usize] = crew[b as usize].saturating_add(1);
                    }
                }
            } else if self.is_free_worker(e) {
                free[o] += 1;
            }
        }
        // 2–3. Supply from crewed producers; use by everything.
        let mut supply = vec![[0u32; N_RES]; n];
        let mut used = vec![[0u32; N_RES]; n];
        for e in self.ents.iter_mut().filter(|e| e.alive) {
            let o = e.owner as usize;
            let st = e.kind.stats();
            e.crew = crew[e.id as usize];
            e.hired = hired[e.id as usize];
            e.crewed = e.built >= 1.0 && e.crew >= st.workers;
            if e.crewed && st.consumes.is_empty() {
                for &(r, k) in st.produces {
                    supply[o][r.idx()] += k as u32;
                }
            }
            for &(r, k) in st.cost {
                used[o][r.idx()] += k as u32;
            }
            for q in &e.queue {
                for &(r, k) in q.stats().cost {
                    used[o][r.idx()] += k as u32;
                }
            }
        }
        // 4. Converters, earlier eras first, then oldest first: each built
        //    one borrows its inputs if they're free (crewed or not: a
        //    paused bakery still holds its grain), and adds its outputs if
        //    its crew is there too. One whose inputs aren't free stops
        //    (`fed` false), and anything downstream may stop with it.
        let mut conv: Vec<(u8, usize)> = (0..self.ents.len())
            .filter(|&i| self.ents[i].alive && self.ents[i].built >= 1.0 && !self.ents[i].kind.stats().consumes.is_empty())
            .map(|i| (self.ents[i].kind.era(), i))
            .collect();
        conv.sort();
        for e in self.ents.iter_mut() {
            e.fed = false;
        }
        // In passes until nothing more can be fed, so a chain works
        // whatever order its buildings were built in (a radio factory
        // older than the power plant it needs is fed in the second pass).
        loop {
            let mut progress = false;
            for &(_, i) in &conv {
                let e = &mut self.ents[i];
                if e.fed {
                    continue;
                }
                let st = e.kind.stats();
                let o = e.owner as usize;
                let pct = self.players[o].supply_pct as u32;
                let has = |r: Res| (supply[o][r.idx()] * pct / 100) as i64 - used[o][r.idx()] as i64;
                if !st.consumes.iter().all(|&(r, k)| has(r) >= k as i64) {
                    continue;
                }
                e.fed = true;
                progress = true;
                for &(r, k) in st.consumes {
                    used[o][r.idx()] += k as u32;
                }
                if e.crewed {
                    for &(r, k) in st.produces {
                        // Outputs are counted before the handicap like any
                        // supply, so add them so the handicap leaves them whole.
                        supply[o][r.idx()] += (k as u32 * 100).div_ceil(pct.max(1));
                    }
                }
            }
            if !progress {
                break;
            }
        }
        for (o, p) in self.players.iter_mut().enumerate() {
            for r in 0..N_RES {
                // Integer percent, rounded down: exact on every computer.
                p.supply[r] = (supply[o][r] * p.supply_pct as u32 / 100).min(u16::MAX as u32) as u16;
                p.used[r] = used[o][r].min(u16::MAX as u32) as u16;
            }
            p.people = people[o];
            p.free = free[o];
            p.working = working[o];
            p.soldiers = soldiers[o];
        }
        // 5.
        self.supply_units(settle);
        // 6–7, player by player, then house tiers and eras.
        for owner in self.player_ids() {
            self.house_goods(owner, settle);
            if settle {
                self.leave(owner);
            }
            self.fill_houses(owner);
            if settle {
                self.raise_era(owner);
                self.house_tiers(owner);
            }
        }
    }

    /// One house a tick may change tier. A house **upgrades** when every
    /// bed is taken, it uses as many goods as its tier allows, and the
    /// bigger house's extra materials are free (a cottage holds more wood
    /// and stone than a hut); nearest the Capitol first. A house that no
    /// longer gets the goods its old tier needed **downgrades**, giving the
    /// extra materials back; furthest first. Houses can reach one tier past
    /// the player's era: that's how the next era is reached.
    fn house_tiers(&mut self, owner: u8) {
        let houses = self.houses_by_distance(owner);
        for &i in houses.iter().rev() {
            let e = &self.ents[i];
            let Some(lower) = e.kind.downgrade() else { continue };
            if e.built < 1.0 || e.goods.count_ones() >= house_max_goods(lower.house_tier().unwrap_or(0)) as u32 {
                continue;
            }
            self.change_house(i, lower);
            return;
        }
        let era = self.players[owner as usize].era;
        for &i in &houses {
            let e = &self.ents[i];
            let (Some(tier), Some(next)) = (e.kind.house_tier(), e.kind.upgrade()) else { continue };
            if e.built < 1.0 || next.house_tier().unwrap_or(0) > era + 1 || e.residents < e.beds() || e.goods.count_ones() < house_max_goods(tier) as u32 {
                continue;
            }
            let p = &self.players[owner as usize];
            let affordable = next.stats().cost.iter().all(|&(r, k)| {
                let had = e.kind.stats().cost.iter().find(|&&(q, _)| q == r).map_or(0, |&(_, k)| k);
                p.free(r) >= k as i32 - had as i32
            });
            if affordable {
                self.change_house(i, next);
                return;
            }
        }
    }

    /// Turn house `i` into `kind`: it holds the new kind's slots instead of
    /// the old one's, and keeps its share of health.
    fn change_house(&mut self, i: usize, kind: Kind) {
        let e = &mut self.ents[i];
        let (old, new) = (e.kind.stats(), kind.stats());
        let up = kind.house_tier() > e.kind.house_tier();
        e.hp = (e.hp / old.hp * new.hp).min(new.hp);
        e.kind = kind;
        let (owner, x, y) = (e.owner, e.x, e.y);
        let p = &mut self.players[owner as usize];
        for &(r, k) in old.cost {
            p.used[r.idx()] -= k;
        }
        for &(r, k) in new.cost {
            p.used[r.idx()] += k;
        }
        if owner == self.local {
            self.push_event(if up { Ev::Upgraded } else { Ev::Downgraded }, x, y, kind as u32 as f32);
        }
    }

    /// A player enters the next era when `HOUSES_FOR_ERA` of their houses
    /// have reached its tier. Eras are never lost.
    fn raise_era(&mut self, owner: u8) {
        let era = self.players[owner as usize].era;
        if era >= LAST_ERA {
            return;
        }
        if self.houses_past_era(owner) >= HOUSES_FOR_ERA {
            self.players[owner as usize].era = era + 1;
            self.push_event(Ev::EraReached, 0.0, 0.0, (owner as u32 * 16 + era as u32 + 1) as f32);
        }
    }

    /// Houses of `owner`, nearest the Capitol first (ties by id): squared
    /// distance in whole tiles, so it's exact on every computer.
    pub(crate) fn houses_by_distance(&self, owner: u8) -> Vec<usize> {
        let (cx, cy) = self.find_first(owner, Kind::Capitol).map_or((0, 0), |c| (self.ents[c].tx, self.ents[c].ty));
        let mut hs: Vec<(i32, usize)> = self
            .ents
            .iter()
            .enumerate()
            .filter(|(_, e)| e.alive && e.owner == owner && e.kind.house_tier().is_some())
            .map(|(i, e)| ((e.tx - cx).pow(2) + (e.ty - cy).pow(2), i))
            .collect();
        hs.sort();
        hs.into_iter().map(|(_, i)| i).collect()
    }

    /// Step 6 for one player: the goods each house gets, and so its beds.
    /// With `settle` false, only count what the houses hold now.
    fn house_goods(&mut self, owner: u8, settle: bool) {
        let houses = self.houses_by_distance(owner);
        if settle {
            let p = &self.players[owner as usize];
            // What's left for houses after buildings and units.
            let mut left: [i32; N_RES] = std::array::from_fn(|r| p.free(Res::ALL[r]).max(0));
            let wanted = |r: Res, tier: u8| r.is_house_good() && r.era() <= tier;
            let mut goods = vec![0u32; houses.len()];
            // Level by level: every house gets a first good, then a second,
            // and so on, nearest first, so goods are shared out evenly and
            // a shortage takes the furthest houses' last goods first. At
            // each level a house keeps a good it already had before it takes
            // a new one, so supply that doesn't change shuffles nothing.
            let top = houses.iter().filter_map(|&i| self.ents[i].kind.house_tier()).map(house_max_goods).max().unwrap_or(0) as u32;
            for level in 1..=top {
                for keep in [true, false] {
                    for (h, &i) in houses.iter().enumerate() {
                        let e = &self.ents[i];
                        let Some(tier) = e.kind.house_tier().filter(|_| e.built >= 1.0) else { continue };
                        let most = level.min(house_max_goods(tier) as u32);
                        // New goods: the latest era's first, leaving older
                        // goods to houses that can't use the new ones.
                        let order: [Res; N_RES] = if keep { Res::ALL } else { std::array::from_fn(|k| Res::ALL[N_RES - 1 - k]) };
                        for r in order {
                            if goods[h].count_ones() >= most {
                                break;
                            }
                            let had = e.goods & (1 << r.idx()) != 0;
                            if had == keep && goods[h] & (1 << r.idx()) == 0 && wanted(r, tier) && left[r.idx()] > 0 {
                                goods[h] |= 1 << r.idx();
                                left[r.idx()] -= 1;
                            }
                        }
                    }
                }
            }
            for (h, &i) in houses.iter().enumerate() {
                self.ents[i].goods = goods[h];
            }
        }
        let p = &mut self.players[owner as usize];
        p.housed = [0; N_RES];
        p.beds = 0;
        for &i in &houses {
            let e = &self.ents[i];
            for (r, slot) in p.housed.iter_mut().enumerate() {
                *slot += (e.goods >> r & 1) as u16;
            }
            p.beds += e.beds() as u32;
        }
    }

    /// Step 7: more people than beds. Free workers leave first (newest
    /// first), then workers at producers that don't make house goods, then
    /// any worker. Soldiers stay: they hold their beds while they live.
    fn leave(&mut self, owner: u8) {
        let p = self.players[owner as usize];
        let mut over = p.people.saturating_sub(p.beds);
        if over == 0 {
            return;
        }
        let makes_goods = |g: &Game, e: &Entity| match e.order {
            Order::Work(b) => g.ents.get(b as usize).is_some_and(|t| t.kind.stats().produces.iter().any(|&(r, _)| r.is_house_good())),
            _ => false,
        };
        for pass in 0..3 {
            for i in (0..self.ents.len()).rev() {
                if over == 0 {
                    break;
                }
                let e = &self.ents[i];
                if !e.alive || e.owner != owner || e.kind != Kind::Worker {
                    continue;
                }
                let go = match pass {
                    0 => self.is_free_worker(e),
                    1 => !makes_goods(self, e),
                    _ => true,
                };
                if go {
                    self.vanish(i);
                    over -= 1;
                    let p = &mut self.players[owner as usize];
                    p.people -= 1;
                    p.free = p.free.saturating_sub(pass.eq(&0) as u32);
                }
            }
        }
    }

    /// Who lives where, for the page: people fill houses nearest the
    /// Capitol first. Nothing depends on it but the drawing and the house
    /// tiers (a house is full when every bed is taken).
    fn fill_houses(&mut self, owner: u8) {
        let mut left = self.players[owner as usize].people;
        for i in self.houses_by_distance(owner) {
            let e = &mut self.ents[i];
            let n = left.min(e.beds() as u32);
            e.residents = n as u8;
            left -= n;
        }
    }

    // -----------------------------------------------------------------------
    // Growth and hiring, every tick

    /// Newcomers: while there's a free bed, someone turns up at the
    /// campfire every `growth_interval(beds)` seconds.
    pub(crate) fn grow(&mut self) {
        for owner in self.player_ids() {
            let p = &mut self.players[owner as usize];
            if p.defeated {
                continue;
            }
            p.arrive_timer -= DT;
            if p.arrive_timer > 0.0 {
                continue;
            }
            p.arrive_timer += growth_interval(p.beds);
            if p.people >= p.beds {
                continue;
            }
            if self.spawn_worker(owner, None).is_some() {
                let p = &mut self.players[owner as usize];
                p.people += 1;
                p.free += 1;
            }
        }
    }

    /// Free workers go where people are needed, nearest first: builders to
    /// foundations and recruits to training queues first (the player asked
    /// for those), then crews to producers that are hiring, producers of
    /// house goods before the rest. Producers with more workers than they
    /// need send the newest home.
    pub(crate) fn recruit(&mut self) {
        let n = self.ents.len();
        let mut wants = vec![Wants::default(); n];
        for e in self.ents.iter().filter(|e| e.alive) {
            match e.order {
                Order::Build(b) if (b as usize) < n => wants[b as usize].builders_coming += 1,
                Order::Enlist(b) if (b as usize) < n => wants[b as usize].recruits_coming += 1,
                _ => {}
            }
        }
        // Too many at a producer: the newest go home.
        let mut extra = vec![0u8; n];
        for e in self.ents.iter().filter(|e| e.alive && e.is_building()) {
            extra[e.id as usize] = e.hired.saturating_sub(e.kind.stats().workers);
        }
        for i in (0..n).rev() {
            if let Order::Work(b) = self.ents[i].order {
                if self.ents[i].alive && (b as usize) < n && extra[b as usize] > 0 {
                    extra[b as usize] -= 1;
                    self.ents[b as usize].hired -= 1;
                    self.go_home(i);
                }
            }
        }
        for owner in self.player_ids() {
            let mut free: Vec<usize> = (0..n).filter(|&i| self.ents[i].owner == owner && self.is_free_worker(&self.ents[i])).collect();
            if free.is_empty() {
                continue;
            }
            // (building, order to give) in priority order.
            let mut jobs: Vec<(usize, Order)> = Vec::new();
            for i in 0..n {
                let b = &self.ents[i];
                if !b.alive || b.owner != owner || !b.is_building() {
                    continue;
                }
                let st = b.kind.stats();
                if b.built < 1.0 {
                    let need = st.builders.saturating_sub(b.builders_in + wants[i].builders_coming);
                    jobs.extend((0..need).map(|_| (i, Order::Build(i as u32))));
                }
                let need = (b.queue.len() as u8).saturating_sub(b.recruits + wants[i].recruits_coming);
                jobs.extend((0..need).map(|_| (i, Order::Enlist(i as u32))));
            }
            for goods_first in [true, false] {
                for i in 0..n {
                    let b = &self.ents[i];
                    if !b.alive || b.owner != owner || b.built < 1.0 || !b.hiring {
                        continue;
                    }
                    let st = b.kind.stats();
                    if st.workers == 0 || st.produces.iter().any(|&(r, _)| r.is_house_good()) != goods_first {
                        continue;
                    }
                    let need = st.workers.saturating_sub(b.hired);
                    jobs.extend((0..need).map(|_| (i, Order::Work(i as u32))));
                }
            }
            for (b, order) in jobs {
                if free.is_empty() {
                    break;
                }
                // The nearest free worker; ties go to the lower id.
                let t = &self.ents[b];
                let k = (0..free.len()).min_by(|&a, &c| {
                    let d = |j: usize| t.edge_dist(self.ents[free[j]].x, self.ents[free[j]].y);
                    d(a).total_cmp(&d(c)).then(free[a].cmp(&free[c]))
                });
                let w = free.remove(k.unwrap_or(0));
                self.ents[w].set_order(order);
                self.ents[w].resume = None;
                if let Order::Work(_) = order {
                    self.ents[b].hired += 1;
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Workers' orders

    /// A worker walks to a producer and works there, standing at its edge.
    pub(crate) fn do_work(&mut self, i: usize, target: u32) {
        let owner = self.ents[i].owner;
        let ok = self.ents.get(target as usize).is_some_and(|t| t.alive && t.owner == owner && t.is_building() && t.built >= 1.0);
        if !ok {
            return self.go_home(i);
        }
        let t = &self.ents[target as usize];
        let (bx, by) = (t.x, t.y);
        let goal = t.goal(AT_WORK * 0.6);
        match self.travel(i, goal, 3.0) {
            Travel::Moving => {}
            Travel::Blocked => self.go_home(i),
            Travel::Arrived => {
                let e = &mut self.ents[i];
                e.anim = Anim::Work;
                e.facing = (by - e.y).atan2(bx - e.x);
            }
        }
    }

    /// A builder walks to a foundation. On arrival, if it still needs
    /// builders, they're used up there (`builders_in` counts them);
    /// otherwise they go back to the campfire.
    pub(crate) fn do_build(&mut self, i: usize, target: u32) {
        let owner = self.ents[i].owner;
        let needed = self.ents.get(target as usize).is_some_and(|t| t.alive && t.owner == owner && t.built < 1.0 && t.builders_in < t.kind.stats().builders);
        if !needed {
            return self.go_home(i);
        }
        let goal = self.ents[target as usize].goal(0.75);
        match self.travel(i, goal, 3.0) {
            Travel::Moving => {}
            Travel::Blocked => self.go_home(i),
            Travel::Arrived => {
                let b = &mut self.ents[target as usize];
                b.builders_in += 1;
                let (bx, by) = (b.x, b.y);
                self.push_event(Ev::Hammer, bx, by, 0.0);
                self.vanish(i);
            }
        }
    }

    /// A free worker walks to a training building and goes in to be trained.
    /// If it's gone, or no longer needs anyone, they go back to the campfire.
    pub(crate) fn do_enlist(&mut self, i: usize, target: u32) {
        let owner = self.ents[i].owner;
        let ok = self.ents.get(target as usize).is_some_and(|t| t.alive && t.owner == owner && t.built >= 1.0);
        if !ok {
            return self.go_home(i);
        }
        let goal = self.ents[target as usize].goal(0.6);
        match self.travel(i, goal, 3.0) {
            Travel::Moving => {}
            Travel::Blocked => self.go_home(i),
            Travel::Arrived => {
                let b = &mut self.ents[target as usize];
                if b.queue.len() > b.recruits as usize {
                    b.recruits += 1;
                    self.vanish(i);
                } else {
                    self.go_home(i);
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Training and building

    /// A foundation with all its builders rises by itself over its build time.
    pub(crate) fn rise(&mut self, i: usize) {
        let b = &mut self.ents[i];
        let st = b.kind.stats();
        if b.builders_in < st.builders {
            return;
        }
        b.built += DT / st.time;
        b.hp = (b.hp + st.hp * 0.9 * DT / st.time).min(st.hp);
        if b.built >= 1.0 {
            b.built = 1.0;
            let (owner, kind, bx, by) = (b.owner, b.kind, b.x, b.y);
            self.players[owner as usize].built += 1;
            if owner == self.local {
                self.push_event(Ev::Built, bx, by, kind as u32 as f32);
            }
        } else if self.work_stroke(i) {
            let (bx, by) = (self.ents[i].x, self.ents[i].y);
            self.push_event(Ev::Hammer, bx, by, 0.0);
        }
    }

    /// Free workers of `owner` not yet spoken for by a training queue.
    pub fn unclaimed_workers(&self, owner: u8) -> u32 {
        let free = self.ents.iter().filter(|e| e.owner == owner && self.is_free_worker(e)).count() as u32;
        let coming = self.ents.iter().filter(|e| e.alive && e.owner == owner && matches!(e.order, Order::Enlist(_))).count() as u32;
        let waiting: u32 = self.ents.iter().filter(|e| e.alive && e.owner == owner).map(|b| (b.queue.len() as u32).saturating_sub(b.recruits as u32)).sum();
        free.saturating_sub(waiting.saturating_sub(coming))
    }

    /// Queue a unit. It holds its slots at once; a free worker from the
    /// campfire walks over, and training starts when they arrive.
    pub fn queue_unit(&mut self, building: u32, kind: Kind) -> Result<(), CmdError> {
        let b = &self.ents[building as usize];
        if !b.alive || b.built < 1.0 || !b.kind.trains().contains(&kind) {
            return Err(CmdError::NoBuilding);
        }
        if b.queue.len() >= 5 {
            return Err(CmdError::QueueFull);
        }
        let owner = b.owner;
        if kind.era() > self.players[owner as usize].era {
            return Err(CmdError::Era(kind.era()));
        }
        if self.unclaimed_workers(owner) == 0 {
            return Err(CmdError::NoPeople);
        }
        self.pay(owner, kind.stats().cost)?; // `?` returns the error early if paying failed
        self.ents[building as usize].queue.push(kind);
        Ok(())
    }

    /// Take the last unit out of a queue. If its recruit had already gone
    /// in, they come back out and walk to the campfire.
    pub fn cancel_unit(&mut self, building: u32) {
        let Some(b) = self.ents.get_mut(building as usize) else { return };
        let Some(k) = b.queue.pop() else { return };
        if b.queue.is_empty() {
            b.progress = 0.0;
        }
        let (owner, tx, ty, size, x, y) = (b.owner, b.tx, b.ty, b.kind.stats().size, b.x, b.y);
        let out = b.recruits as usize > b.queue.len();
        if out {
            b.recruits -= 1;
        }
        self.unpay(owner, k.stats().cost);
        if out {
            let at = self.free_tile_near(tx, ty, size, x, y + size as f32).unwrap_or((x, y));
            self.spawn_worker(owner, Some(at));
        }
    }

    /// Start or stop a producer hiring. Stopping sends its workers home: it
    /// keeps holding its slots but makes nothing.
    pub(crate) fn set_hiring(&mut self, b: u32, on: bool) {
        let Some(t) = self.ents.get_mut(b as usize) else { return };
        if !t.is_building() || t.kind.stats().workers == 0 {
            return;
        }
        t.hiring = on;
        if !on {
            for i in 0..self.ents.len() {
                if self.ents[i].alive && self.ents[i].order == Order::Work(b) {
                    self.go_home(i);
                }
            }
        }
    }

    /// When a player holds more of a resource than they make (a producer was
    /// destroyed), their newest units holding it are unsupplied and slowly
    /// lose health, until supply is back or enough have died to fit.
    /// Buildings and queued units still hold their slots but don't suffer.
    /// With `settle` false, only mark them (no damage, no message).
    fn supply_units(&mut self, settle: bool) {
        for e in self.ents.iter_mut() {
            e.unsupplied = false;
        }
        for owner in self.player_ids() {
            let p = self.players[owner as usize];
            let mut any = false;
            let mut first_short = None;
            for r in Res::ALL {
                let mut deficit = -p.free(r);
                if deficit <= 0 {
                    continue;
                }
                first_short.get_or_insert(r);
                // Newest first: highest id first.
                for e in self.ents.iter_mut().rev() {
                    if deficit <= 0 {
                        break;
                    }
                    if !e.alive || e.owner != owner || e.is_building() {
                        continue;
                    }
                    if let Some(&(_, k)) = e.kind.stats().cost.iter().find(|&&(res, _)| res == r) {
                        e.unsupplied = true;
                        any = true;
                        deficit -= k as i32;
                    }
                }
            }
            if !settle {
                continue;
            }
            let was = self.players[owner as usize].short;
            self.players[owner as usize].short = any;
            if any && !was && owner == self.local {
                let r = first_short.map_or(0, |r| r.idx());
                self.push_event(Ev::Short, 0.0, 0.0, r as f32);
            }
        }
        if settle && UNSUPPLIED_DAMAGE > 0.0 {
            for e in self.ents.iter_mut().filter(|e| e.alive && e.unsupplied) {
                e.hp -= e.kind.stats().hp * UNSUPPLIED_DAMAGE * DT;
            }
        }
    }
}
