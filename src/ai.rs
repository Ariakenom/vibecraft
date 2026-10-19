//! The computer opponent. It plays by the same rules as you: it pays for
//! everything, its citizens walk and gather, its buildings take time.
//! (It does see through fog of war, and gathers faster on Hard.)

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
    have: [u32; 32],
    unfinished: Vec<u32>,
    gatherers: [u32; 4],
    /// Which citizens are on each resource, so we can move them around.
    workers: [Vec<u32>; 4],
}

// A second `impl Game` block, in a different file. Rust lets you split a
// type's methods across modules, which keeps the AI code out of game.rs.
impl Game {
    pub fn ai_think(&mut self, me: u8) {
        let Some(cap) = self.find_first(me, Kind::Capitol) else { return };
        let (bx, by) = (self.ents[cap].x, self.ents[cap].y);
        let diff = self.ais[me as usize].difficulty;
        let mut c = self.census(me);

        // 0. Can we feed another mouth? Each food gatherer brings in roughly
        //    20 food a minute, so that sets how much upkeep we can afford.
        let upkeep = self.players[me as usize].upkeep;
        let affordable = c.gatherers[Res::Food.idx()] as f32 * 20.0 + 4.0;
        let well_fed = |extra: f32| upkeep + extra <= affordable;

        // 1. Keep making citizens.
        let max_cit = [18usize, 26, 34][diff.min(2) as usize];
        let want_cit = (8 + (self.time / 18.0) as usize).min(max_cit);
        let q = self.ents[cap].queue.len();
        if c.citizens.len() + q < want_cit && q < 2 && (well_fed(3.0) || c.citizens.len() < 8) {
            let _ = self.queue_unit(cap as u32, Kind::Citizen);
        }


        // 3. Build order, triggered by economy size.
        let n = c.citizens.len();
        // (building, citizens needed before we start it, how many we want)
        // The order follows the tech tree, so each step is unlocked in time.
        let plan: [(Kind, usize, u32); 14] = [
            (Kind::Barracks, 7, 1),
            (Kind::Settlement, 9, 1),
            (Kind::Sawmill, 11, 1),
            (Kind::Granary, 12, 1),
            (Kind::Range, 13, 1),
            (Kind::Mason, 15, 1),
            (Kind::Smithy, 18, 1),
            (Kind::Stable, 19, 1),
            (Kind::Tower, 20, 1),
            (Kind::Market, 22, 1),
            (Kind::Barracks, 24, 2),
            (Kind::Temple, 26, 1),
            (Kind::Tower, 28, 2),
            (Kind::Wonder, 30, if diff >= 1 { 1 } else { 0 }),
        ];
        for (kind, at, count) in plan {
            // Easier AIs stop growing earlier, so cap the trigger at their maximum.
            if n < at.min(max_cit) || c.have[kind as usize] >= count {
                continue;
            }
            if !self.unlocked(me, kind) {
                continue; // a requirement is still being built
            }
            if kind == Kind::Settlement {
                // Put the settlement next to a forest some way off, if there is one.
                let spot = self.nearest_node(Res::Wood, bx, by, 40.0).map(|r| self.res[r].center());
                let (sx, sy) = spot.filter(|&(rx, ry)| (rx - bx).hypot(ry - by) > 9.0).unwrap_or((bx, by));
                self.ai_build(kind, sx, sy, 2, 8, &mut c);
            } else {
                let far = if kind == Kind::Wonder { 16 } else { 14 };
                if kind == Kind::Wonder && self.ai_build(kind, bx, by, 5, far, &mut c) {
                    self.ais[me as usize].wonder_started = true;
                } else if kind != Kind::Wonder {
                    self.ai_build(kind, bx, by, 5, far, &mut c);
                }
            }
            break; // one new project at a time
        }

        // 3b. A Wonder is a big job: keep several citizens on it.
        if let Some(w) = c.unfinished.iter().copied().find(|&b| self.ents[b as usize].kind == Kind::Wonder) {
            let builders = self.ents.iter().filter(|e| e.alive && e.order == Order::Build(w)).count();
            let want = [0, 6, 9][diff.min(2) as usize];
            for _ in builders..want {
                let Some(id) = c.workers[Res::Wood.idx()].pop().or_else(|| c.workers[Res::Gold.idx()].pop()) else { break };
                self.order_build(id, w);
            }
        }

        // 4. Put idle citizens to work: finish buildings first, then gather.
        let idle = std::mem::take(&mut c.idle);
        for id in idle {
            let lonely = c.unfinished.iter().copied().find(|&b| !self.has_builder(b));
            match lonely {
                Some(b) => self.order_build(id, b),
                None => self.ai_assign(id, bx, by, &mut c),
            }
        }

        // 4b. Rebalance: if we're short of food, move a citizen off whichever
        //     resource has the biggest surplus. Berries run out; farms don't.
        let want = self.ai_wants(&c);
        if (c.gatherers[0] as f32) < want[0] - 0.5 {
            let surplus = |r: usize| c.gatherers[r] as f32 - want[r];
            let from = (1..4).max_by(|&a, &b| surplus(a).total_cmp(&surplus(b))).unwrap();
            if surplus(from) > 0.5 {
                if let Some(id) = c.workers[from].pop() {
                    if self.ai_feed(id, bx, by, &mut c) {
                        c.gatherers[from] -= 1;
                    }
                }
            }
        }

        // 5. Train soldiers from every military building with an empty queue.
        if n >= 9 {
            let qmax = if diff >= 2 { 2 } else { 1 };
            let producers: Vec<u32> = self
                .ents
                .iter()
                .filter(|e| e.alive && e.owner == me && e.built >= 1.0 && e.kind != Kind::Capitol && !e.kind.trains().is_empty() && e.queue.len() < qmax)
                .map(|e| e.id)
                .collect();
            for b in producers {
                let unit = self.ents[b as usize].kind.trains()[0];
                let cost = unit.stats().cost;
                let stock = self.players[me as usize].stock;
                if !well_fed(unit.stats().upkeep) {
                    continue; // Can't feed it: put more citizens on food first.
                }
                // Keep a little in reserve for citizens and buildings.
                if (0..4).all(|r| stock[r] >= cost[r] as f32 + if cost[r] > 0 { 40.0 } else { 0.0 }) {
                    let _ = self.queue_unit(b, unit);
                }
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
        let mut c = Census { me, ..Default::default() };
        for e in self.ents.iter().filter(|e| e.alive && e.owner == me) {
            if e.is_building() {
                c.have[e.kind as usize] += 1;
                if e.built < 1.0 {
                    c.unfinished.push(e.id);
                }
            } else if e.kind == Kind::Citizen {
                c.citizens.push(e.id);
                match e.order {
                    Order::Idle => c.idle.push(e.id),
                    Order::Gather(n) | Order::Return(n) => {
                        let r = self.node_kind(n).idx();
                        c.gatherers[r] += 1;
                        c.workers[r].push(e.id);
                    }
                    _ => {}
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

    /// Pick a builder and a spot near (x, y), and place the building.
    fn ai_build(&mut self, kind: Kind, x: f32, y: f32, rmin: i32, rmax: i32, c: &mut Census) -> bool {
        let builder = c.idle.pop().or_else(|| {
            c.citizens.iter().copied().find(|&id| matches!(self.ents[id as usize].order, Order::Gather(_)))
        });
        let Some(builder) = builder else { return false };
        let Some((tx, ty)) = self.find_spot(c.me, kind, x, y, rmin, rmax) else { return false };
        match self.place(c.me, kind, tx, ty, &[builder]) {
            Ok(id) => {
                c.unfinished.push(id);
                c.have[kind as usize] += 1;
                true
            }
            Err(_) => {
                // Couldn't afford it: let the builder go back to gathering.
                if self.ents[builder as usize].order == Order::Idle {
                    c.idle.push(builder);
                }
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

    /// Send a citizen to whichever resource is most under-staffed.
    /// How many citizens we'd like on each resource.
    fn ai_wants(&self, c: &Census) -> [f32; 4] {
        let weights = [0.44, 0.34, 0.1, 0.12];
        let total = c.gatherers.iter().sum::<u32>() as f32 + 1.0;
        // Enough food gatherers to feed everyone, with a margin for growth.
        // A farmer brings in roughly 20 food a minute.
        let upkeep = self.players[c.me as usize].upkeep;
        let food = (weights[0] * total).max(upkeep / 20.0 + 2.0);
        // `array::map` builds a new array by running a closure on each element.
        let mut want = weights.map(|w| w * total);
        want[0] = food;
        want
    }

    /// Put a citizen on food: berries nearby, else an empty farm, else a new farm.
    /// Returns false if none of that was possible.
    fn ai_feed(&mut self, id: u32, bx: f32, by: f32, c: &mut Census) -> bool {
        if let Some(n) = self.nearest_node(Res::Food, bx, by, 18.0) {
            self.order_gather(id, ResNode::Node(n));
        } else if let Some(f) = self.free_farm(c.me) {
            self.order_gather(id, ResNode::Farm(f));
        } else {
            let Some((tx, ty)) = self.find_spot(c.me, Kind::Farm, bx, by, 4, 14) else { return false };
            if self.place(c.me, Kind::Farm, tx, ty, &[id]).is_err() {
                return false;
            }
        }
        c.gatherers[0] += 1;
        true
    }

    fn ai_assign(&mut self, id: u32, bx: f32, by: f32, c: &mut Census) {
        let want = self.ai_wants(c);
        let mut pick = 0;
        let mut worst = f32::MIN;
        for r in 0..4 {
            let deficit = want[r] - c.gatherers[r] as f32;
            if deficit > worst {
                worst = deficit;
                pick = r;
            }
        }
        let kind = Res::from_idx(pick);
        if kind == Res::Food && self.ai_feed(id, bx, by, c) {
            return;
        }
        // Fall back to wood if food wasn't possible.
        let kind = if kind == Res::Food { Res::Wood } else { kind };
        let (x, y) = (self.ents[id as usize].x, self.ents[id as usize].y);
        if let Some(n) = self.nearest_node(kind, x, y, 80.0) {
            c.gatherers[kind.idx()] += 1;
            self.order_gather(id, ResNode::Node(n));
        }
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
