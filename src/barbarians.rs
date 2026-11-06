//! Frontier's barbarians: computer towns on the map's barbarian sites
//! (`map_frontier`). Each is an ordinary AI player in an owner slot after
//! the seats, held back by its site: it never passes the site's era, keeps
//! an army of at most `army_cap`, only builds and raids within reach of its
//! site, and never sails, flies or launches nukes. They fight everyone,
//! each other too. When one falls its site is free again, and new camps
//! settle free sites nobody can see, all game long.

use crate::ai::Ai;
use crate::defs::Kind;
use crate::game::{handicap, Game, Player, GAIA};
use crate::map_frontier::Site;

/// Barbarian owner slots: at most this many camps at once.
pub const MAX_BARBS: usize = 16;
/// Camps settled when the game starts; the rest come later.
const FIRST_CAMPS: usize = 8;
/// A new camp settles a free site this often (if a slot is free).
pub const CAMP_EVERY: f32 = 90.0;
/// No camp settles where a player has anything this close.
const UNSEEN: f32 = 32.0;
/// A camp's town: what it builds on and knows about, and how far it raids.
pub const BARB_RANGE: f32 = 36.0;
pub const RAID_RANGE: f32 = 70.0;

/// The Frontier part of a game: the sites and who holds them.
#[derive(Clone)]
pub struct Frontier {
    pub sites: Vec<Site>,
    /// Per barbarian slot (owner `n_players + 1 + k`): the site it holds,
    /// if it's alive.
    pub camps: Vec<Option<u16>>,
    /// Seconds until the next camp settles.
    pub next_camp: f32,
    /// How many camps have settled (picks the next site).
    pub settled: u32,
}

impl Frontier {
    pub fn new(sites: Vec<Site>) -> Frontier {
        let n = MAX_BARBS.min(sites.len());
        Frontier { sites, camps: vec![None; n], next_camp: CAMP_EVERY, settled: 0 }
    }
}

impl Game {
    /// Make this a Frontier game (a new one, or one just loaded).
    pub(crate) fn set_frontier(&mut self, f: Frontier) {
        self.frontier = Some(f);
        self.pf.limit = crate::path::SEARCH_LIMIT_FRONTIER;
    }

    /// A new Frontier game: the seats as in `new`, then the barbarian slots.
    pub fn new_frontier(seed: u32, difficulty: u32, n_players: u8) -> Game {
        let n_players = n_players.clamp(2, crate::game::MAX_PLAYERS as u8);
        let (map, deps, bases, sites) = crate::map_frontier::generate_frontier(seed, n_players as usize);
        let n = (map.w * map.h) as usize;
        let front = Frontier::new(sites);
        let owners = n_players as usize + front.camps.len();
        let hc = handicap(difficulty);
        let players = (0..=owners).map(|p| Player::new(if p > 1 { hc } else { 100 })).collect();
        let ais = (0..=owners).map(|p| Ai::new(difficulty, p > 1, p as f32 * 0.13)).collect();
        let mut g = Game::from_parts(seed, map, deps, Vec::new(), players, n_players, Vec::new(), vec![0; n], ais, crate::game::PLAYER);
        for p in n_players as usize + 1..=owners {
            g.players[p].defeated = true;
        }
        g.set_frontier(front);
        for (i, &(bx, by)) in bases.iter().enumerate() {
            let cap = g.spawn_building(Kind::Capitol, i as u8 + 1, bx - 1, by - 1, 1.0);
            g.ents[cap as usize].starting = true;
        }
        for _ in 0..FIRST_CAMPS {
            g.settle_camp();
        }
        g.resolve();
        g.update_fog();
        g.explore();
        g
    }

    /// Is `owner` a barbarian? (Frontier only.)
    pub fn is_barb(&self, owner: u8) -> bool {
        self.frontier.is_some() && owner > self.n_players
    }

    /// The site a barbarian holds.
    pub fn barb_site(&self, owner: u8) -> Option<Site> {
        let f = self.frontier.as_ref()?;
        let k = (owner as usize).checked_sub(self.n_players as usize + 1)?;
        f.camps.get(k).copied().flatten().map(|s| f.sites[s as usize])
    }

    /// The highest era `owner` may reach: its site's for a barbarian.
    pub fn era_cap(&self, owner: u8) -> u8 {
        if self.is_barb(owner) {
            self.barb_site(owner).map_or(0, |s| s.era)
        } else {
            crate::defs::LAST_ERA
        }
    }

    /// The most soldiers a barbarian keeps, by its site's era.
    pub fn army_cap(&self, owner: u8) -> usize {
        self.barb_site(owner).map_or(usize::MAX, |s| 6 + 5 * s.era as usize)
    }

    /// Every tick in a Frontier game: put out camps that have lost their
    /// Capitol, and settle a new one now and then.
    pub(crate) fn frontier_tick(&mut self) {
        if self.frontier.is_none() {
            return;
        }
        let first = self.n_players + 1;
        let slots = self.frontier.as_ref().unwrap().camps.len() as u8;
        for owner in first..first + slots {
            if !self.players[owner as usize].defeated && self.home_capitol(owner).is_none() {
                self.players[owner as usize].defeated = true;
                for e in self.ents.iter_mut().filter(|e| e.alive && e.owner == owner) {
                    e.hp = 0.0;
                }
                self.frontier.as_mut().unwrap().camps[(owner - first) as usize] = None;
            }
        }
        let f = self.frontier.as_mut().unwrap();
        f.next_camp -= crate::game::DT;
        if f.next_camp <= 0.0 {
            f.next_camp = CAMP_EVERY;
            self.settle_camp();
        }
    }

    /// A new camp on a free site nobody can see, in a free slot, if any.
    fn settle_camp(&mut self) {
        let f = self.frontier.as_ref().unwrap();
        let Some(slot) = f.camps.iter().position(|c| c.is_none()) else { return };
        let held: Vec<u16> = f.camps.iter().flatten().copied().collect();
        let n = f.sites.len();
        // Go round the sites from a different place each time.
        let start = (f.settled as usize * 7) % n;
        let owner = self.n_players + 1 + slot as u8;
        let free = (0..n).map(|k| (start + k) % n).find(|&s| {
            let site = f.sites[s];
            let (sx, sy) = (site.x as f32 + 0.5, site.y as f32 + 0.5);
            !held.contains(&(s as u16))
                && !self.ents.iter().any(|e| e.alive && e.owner != GAIA && !self.is_barb(e.owner) && (e.x - sx).hypot(e.y - sy) < UNSEEN)
                && (site.y - 2..site.y + 2).all(|y| (site.x - 2..site.x + 2).all(|x| self.map.passable(x, y) && self.map.bld_at[self.map.idx(x, y)] < 0))
        });
        let Some(s) = free else { return };
        let site = self.frontier.as_ref().unwrap().sites[s];
        let f = self.frontier.as_mut().unwrap();
        f.camps[slot] = Some(s as u16);
        f.settled += 1;
        // A fresh town: nothing carried over from the last camp in this slot.
        let (diff, phase) = (self.ais[owner as usize].difficulty, owner as f32 * 0.13);
        self.players[owner as usize] = Player::new(handicap(diff));
        self.ais[owner as usize] = Ai::new(diff, true, phase);
        let cap = self.spawn_building(Kind::Capitol, owner, site.x - 1, site.y - 1, 1.0);
        // Like a start's: it holds no slots.
        self.ents[cap as usize].starting = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(g: &mut Game, seconds: f32) {
        for _ in 0..(seconds * 20.0) as u32 {
            g.tick();
            g.events.clear();
        }
    }

    /// A Frontier game played by the computer in every seat, minute by
    /// minute: the camps, their eras and armies, and the tick time.
    /// `cargo test --release diag_frontier -- --ignored --nocapture`
    /// (VC_SEED, VC_PLAYERS, VC_MINUTES)
    #[test]
    #[ignore]
    fn diag_frontier() {
        let env = |k: &str, d: u32| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
        let mut g = Game::new_frontier(env("VC_SEED", 7), 1, env("VC_PLAYERS", 2) as u8);
        for p in g.seat_ids() {
            g.set_ai(p, true);
        }
        for m in 1..=env("VC_MINUTES", 20) {
            let t = std::time::Instant::now();
            run(&mut g, 60.0);
            let ms = t.elapsed().as_secs_f64() * 1000.0 / 1200.0;
            let f = g.frontier.as_ref().unwrap();
            let camps: Vec<String> = f
                .camps
                .iter()
                .enumerate()
                .filter_map(|(k, c)| c.map(|s| (k, s)))
                .map(|(k, s)| {
                    let o = g.n_players + 1 + k as u8;
                    let army = g.ents.iter().filter(|e| e.alive && e.owner == o && e.kind.is_military()).count();
                    format!("{}:e{}/{} p{} a{}", s, g.players[o as usize].era, f.sites[s as usize].era, g.players[o as usize].people, army)
                })
                .collect();
            let seats: Vec<String> = g.seat_ids().map(|p| format!("P{p} e{} p{}{}", g.players[p as usize].era, g.players[p as usize].people, if g.players[p as usize].defeated { " out" } else { "" })).collect();
            println!("{m:2} min {ms:.2} ms/tick | {} | {} camps: {}", seats.join(", "), camps.len(), camps.join("  "));
        }
    }

    /// Camps settle, stay within their era, and a Frontier game saves,
    /// loads and carries on exactly the same.
    #[test]
    fn frontier_camps_and_saves() {
        let mut g = Game::new_frontier(3, 1, 2);
        let f = g.frontier.as_ref().unwrap();
        assert_eq!(f.camps.iter().flatten().count(), FIRST_CAMPS);
        assert_eq!(g.players.len(), 3 + f.camps.len());
        for p in g.seat_ids() {
            g.set_ai(p, true);
        }
        run(&mut g, 200.0);
        // A new camp has come since.
        assert!(g.frontier.as_ref().unwrap().camps.iter().flatten().count() > FIRST_CAMPS);
        for o in g.player_ids().filter(|&o| g.is_barb(o) && !g.players[o as usize].defeated) {
            assert!(g.players[o as usize].era <= g.era_cap(o));
            assert!(g.home_capitol(o).is_some());
        }
        let bytes = g.save();
        let mut h = Game::load(&bytes).expect("a Frontier save loads");
        run(&mut g, 30.0);
        run(&mut h, 30.0);
        assert_eq!(g.checksum(), h.checksum());
        assert_eq!(g.frontier.as_ref().unwrap().camps, h.frontier.as_ref().unwrap().camps);
    }
}

#[cfg(test)]
mod perf {
    use super::*;
    /// Where a Frontier tick's time goes, after VC_MINUTES of play.
    #[test]
    #[ignore]
    fn diag_frontier_time() {
        let env = |k: &str, d: u32| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
        let mut g = Game::new_frontier(7, 1, 2);
        for p in g.seat_ids() {
            g.set_ai(p, true);
        }
        for _ in 0..env("VC_MINUTES", 12) * 1200 {
            g.tick();
            g.events.clear();
        }
        let time = |g: &mut Game| {
            let t = std::time::Instant::now();
            for _ in 0..200 {
                g.tick();
                g.events.clear();
            }
            t.elapsed().as_secs_f64() * 1000.0 / 200.0
        };
        let mut a = g.clone();
        let all = time(&mut a);
        let mut b = g.clone();
        for ai in b.ais.iter_mut() {
            ai.on = false;
        }
        let no_ai = time(&mut b);
        let t = std::time::Instant::now();
        let mut k = 0;
        for p in g.player_ids() {
            if let Some(c) = g.home_capitol(p) {
                let (x, y) = (g.ents[c].x, g.ents[c].y);
                std::hint::black_box(g.reach_for_tests(x, y));
                k += 1;
            }
        }
        let flood = t.elapsed().as_secs_f64() * 1000.0;
        let mut per = Vec::new();
        for p in g.player_ids().filter(|&p| !g.players[p as usize].defeated) {
            let mut c = g.clone();
            let t = std::time::Instant::now();
            c.ai_think(p);
            per.push(format!("{p}{}:{:.1}", if g.is_barb(p) { "b" } else { "" }, t.elapsed().as_secs_f64() * 1000.0));
        }
        println!("think ms: {}", per.join(" "));
        println!("{} of {} entities alive; tick {all:.2} ms, without the AI {no_ai:.2} ms; one flood fill per town: {flood:.2} ms for {k}", g.ents.iter().filter(|e| e.alive).count(), g.ents.len());
    }
}

#[cfg(test)]
mod why {
    use super::*;
    /// One camp after VC_MINUTES: its buildings, its houses and their goods,
    /// and the AI's reasons over its next few thinks. VC_SITE picks the camp
    /// (its site number), else the biggest.
    #[test]
    #[ignore]
    fn diag_camp() {
        let env = |k: &str, d: u32| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
        let mut g = Game::new_frontier(7, 1, 2);
        for _ in 0..env("VC_MINUTES", 10) * 1200 {
            g.tick();
            g.events.clear();
        }
        let f = g.frontier.as_ref().unwrap();
        let want = std::env::var("VC_SITE").ok().and_then(|v| v.parse::<u16>().ok());
        let slots: Vec<(u8, u16)> = f.camps.iter().enumerate().filter_map(|(k, c)| c.map(|s| (g.n_players + 1 + k as u8, s))).collect();
        let (me, site) = match want {
            Some(s) => *slots.iter().find(|&&(_, x)| x == s).expect("no camp there"),
            None => *slots.iter().max_by_key(|&&(o, _)| g.players[o as usize].people).unwrap(),
        };
        let p = &g.players[me as usize];
        println!("owner {me} site {site} (era cap {}): era {} people {} beds {} free {}", g.era_cap(me), p.era, p.people, p.beds, p.free);
        let mut by: std::collections::BTreeMap<String, u32> = Default::default();
        for e in g.ents.iter().filter(|e| e.alive && e.owner == me && e.is_building()) {
            *by.entry(format!("{:?}{}", e.kind, if e.built < 1.0 { "*" } else { "" })).or_default() += 1;
        }
        println!("{by:?}");
        for e in g.ents.iter().filter(|e| e.alive && e.owner == me && e.built >= 1.0 && e.kind.house_tier().is_some()) {
            println!("  {:?} residents {}/{} goods {:#b}", e.kind, e.residents, e.beds(), e.goods);
        }
        let free: Vec<String> = (0..crate::defs::N_RES).filter(|&r| p.supply[r] > 0).map(|r| format!("{:?} {}/{}", crate::defs::Res::ALL[r], p.used[r], p.supply[r])).collect();
        println!("slots used/supply: {}", free.join(", "));
        crate::ai::ai_log_start();
        for _ in 0..40 {
            g.tick();
            g.events.clear();
        }
        let log = crate::ai::ai_log_take();
        for l in log.iter().take(60) {
            println!("{l}");
        }
    }
}

#[cfg(test)]
mod prof {
    use super::*;
    /// VC_SAVE: play VC_MINUTES of a computer Frontier game and save it there.
    /// VC_LOAD: load such a save and run VC_TICKS ticks (for a profiler).
    #[test]
    #[ignore]
    fn prof_frontier() {
        let env = |k: &str, d: u32| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
        if let Ok(path) = std::env::var("VC_SAVE") {
            let mut g = Game::new_frontier(7, 1, 2);
            for p in g.seat_ids() {
                g.set_ai(p, true);
            }
            for _ in 0..env("VC_MINUTES", 22) * 1200 {
                g.tick();
                g.events.clear();
            }
            std::fs::write(path, g.save()).unwrap();
        }
        if let Ok(path) = std::env::var("VC_LOAD") {
            let mut g = Game::load(&std::fs::read(path).unwrap()).unwrap();
            if let Ok(p) = std::env::var("VC_THINK") {
                for _ in 0..5 {
                    g.ai_think(p.parse().unwrap());
                }
                return;
            }
            for _ in 0..env("VC_TICKS", 100) {
                g.tick();
                g.events.clear();
            }
        }
    }
}

#[cfg(test)]
mod paths {
    use super::*;
    use crate::path::{Goal, Pathfinder, SEARCH_LIMIT, SEARCH_LIMIT_FRONTIER};

    /// Long trips across a home continent, round its lakes and bays, arrive
    /// with Frontier's search limit (more than with Skirmish's).
    #[test]
    fn long_paths_arrive() {
        let g = Game::new_frontier(5, 1, 2);
        let c = g.home_capitol(1).unwrap();
        let (sx, sy) = (g.ents[c].x + 3.0, g.ents[c].y + 3.0);
        let reach = g.reach_for_tests(sx, sy);
        let land: Vec<(i32, i32)> = (0..g.map.h).flat_map(|y| (0..g.map.w).map(move |x| (x, y))).filter(|&(x, y)| reach[g.map.idx(x, y)]).collect();
        let (mut short, mut long, mut tried) = (0, 0, 0);
        let mut ms = [0.0f64; 2];
        for k in 0..400usize {
            let a = land[(k * 7919) % land.len()];
            let b = land[(k * 104729 + 13) % land.len()];
            if ((a.0 - b.0) as f32).hypot((a.1 - b.1) as f32) < 80.0 {
                continue;
            }
            tried += 1;
            let goal = Goal::point(b.0 as f32 + 0.5, b.1 as f32 + 0.5, 0.5);
            for (j, (limit, n)) in [(SEARCH_LIMIT, &mut short), (SEARCH_LIMIT_FRONTIER, &mut long)].into_iter().enumerate() {
                let mut pf = Pathfinder::new((g.map.w * g.map.h) as usize);
                pf.limit = limit;
                let t = std::time::Instant::now();
                let p = pf.find(&g.map, false, a.0 as f32 + 0.5, a.1 as f32 + 0.5, &goal);
                ms[j] = ms[j].max(t.elapsed().as_secs_f64() * 1000.0);
                if p.last() == Some(&b) {
                    *n += 1;
                }
            }
        }
        println!("trips over 80 tiles that arrive: {short} of {tried} with {SEARCH_LIMIT} (slowest {:.1} ms), {long} with {SEARCH_LIMIT_FRONTIER} (slowest {:.1} ms)", ms[0], ms[1]);
        let long = long * 20 / tried.max(1);
        assert!(long >= 18, "only {long} of 20 arrive");
    }
}
