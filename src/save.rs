//! Saving and loading a game.
//!
//! `Game::save` writes the whole simulation into a compact little-endian
//! byte string, and `Game::load` reads one back. Everything that affects
//! what happens next is stored (entities with their orders and paths, the
//! map's blocked/occupied tiles, deposits, players, AI brains, timers), so
//! a loaded game carries on exactly as the saved one would have: same
//! checksum, tick for tick. Scratch space (pathfinder buffers, the spatial
//! grid) is rebuilt instead, and pending UI events are dropped. Supply and
//! use of slots aren't stored either: they follow from what exists, and are
//! recounted on load.
//!
//! No serde here (the crate has no dependencies), so it's done by hand with a
//! tiny writer and reader. The reader never panics on bad input: every read
//! is bounds-checked and returns `None`, which `load` passes on.

use crate::ai::Ai;
use crate::defs::{Dep, Kind};
use crate::game::*;
use crate::map::{Deposit, Map};
use crate::path::Goal;

const MAGIC: &[u8; 4] = b"VCSV";
/// Bump when the layout changes. Old saves are then refused, not misread.
/// 2: slots replace stockpiles (economy Phase 1).
/// 3: people, houses, builders (economy Phase 2).
/// 4: explored ground, eras, the AI's scout (economy Phase 3).
/// 5: arrows remember where they were loosed from.
/// 6: people are units (workers, the campfire, recruits); no residents.
/// 7: the Medieval era (new kinds, deposits for iron, clay and sheep).
const VERSION: u32 = 7;

// ---------------------------------------------------------------------------
// Writer

struct W(Vec<u8>);

impl W {
    fn u8(&mut self, v: u8) {
        self.0.push(v);
    }
    fn bool(&mut self, v: bool) {
        self.u8(v as u8);
    }
    fn u32(&mut self, v: u32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn i32(&mut self, v: i32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    /// Floats are stored bit for bit, so a loaded game matches exactly.
    fn f32(&mut self, v: f32) {
        self.u32(v.to_bits());
    }
    fn len(&mut self, n: usize) {
        self.u32(n as u32);
    }
    fn pt(&mut self, p: (f32, f32)) {
        self.f32(p.0);
        self.f32(p.1);
    }
    fn opt_pt(&mut self, p: Option<(f32, f32)>) {
        self.bool(p.is_some());
        if let Some(p) = p {
            self.pt(p);
        }
    }
    fn kind(&mut self, k: Kind) {
        self.u8(k as u8);
    }
    fn order(&mut self, o: Order) {
        match o {
            Order::Idle => self.u8(0),
            Order::Move { x, y } => {
                self.u8(1);
                self.pt((x, y));
            }
            Order::AttackMove { x, y } => {
                self.u8(2);
                self.pt((x, y));
            }
            Order::Attack { target, auto } => {
                self.u8(3);
                self.u32(target);
                self.bool(auto);
            }
            Order::Build(id) => {
                self.u8(6);
                self.u32(id);
            }
            Order::Work(id) => {
                self.u8(7);
                self.u32(id);
            }
            Order::Enlist(id) => {
                self.u8(8);
                self.u32(id);
            }
        }
    }
    fn goal(&mut self, g: Option<Goal>) {
        self.bool(g.is_some());
        if let Some(g) = g {
            for v in [g.x0, g.y0, g.x1, g.y1, g.reach] {
                self.f32(v);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Reader

struct R<'a> {
    b: &'a [u8],
    at: usize,
}

impl R<'_> {
    fn take(&mut self, n: usize) -> Option<&[u8]> {
        let s = self.b.get(self.at..self.at.checked_add(n)?)?;
        self.at += n;
        Some(s)
    }
    fn u8(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }
    fn bool(&mut self) -> Option<bool> {
        match self.u8()? {
            0 => Some(false),
            1 => Some(true),
            _ => None,
        }
    }
    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?))
    }
    fn i32(&mut self) -> Option<i32> {
        Some(i32::from_le_bytes(self.take(4)?.try_into().ok()?))
    }
    fn f32(&mut self) -> Option<f32> {
        Some(f32::from_bits(self.u32()?))
    }
    /// A length, sanity-checked against the bytes left so junk can't make
    /// us allocate gigabytes. `min_size` is the smallest an item can be.
    fn len(&mut self, min_size: usize) -> Option<usize> {
        let n = self.u32()? as usize;
        (n.checked_mul(min_size.max(1))? <= self.b.len() - self.at).then_some(n)
    }
    fn pt(&mut self) -> Option<(f32, f32)> {
        Some((self.f32()?, self.f32()?))
    }
    fn opt_pt(&mut self) -> Option<Option<(f32, f32)>> {
        Some(if self.bool()? { Some(self.pt()?) } else { None })
    }
    fn kind(&mut self) -> Option<Kind> {
        Kind::from_u32(self.u8()? as u32)
    }
    fn order(&mut self) -> Option<Order> {
        Some(match self.u8()? {
            0 => Order::Idle,
            1 => {
                let (x, y) = self.pt()?;
                Order::Move { x, y }
            }
            2 => {
                let (x, y) = self.pt()?;
                Order::AttackMove { x, y }
            }
            3 => Order::Attack { target: self.u32()?, auto: self.bool()? },
            6 => Order::Build(self.u32()?),
            7 => Order::Work(self.u32()?),
            8 => Order::Enlist(self.u32()?),
            _ => return None,
        })
    }
    fn goal(&mut self) -> Option<Option<Goal>> {
        if !self.bool()? {
            return Some(None);
        }
        Some(Some(Goal { x0: self.f32()?, y0: self.f32()?, x1: self.f32()?, y1: self.f32()?, reach: self.f32()? }))
    }
}

// ---------------------------------------------------------------------------

impl Game {
    /// The whole game as bytes. See the module comment.
    pub fn save(&self) -> Vec<u8> {
        let mut w = W(Vec::with_capacity(64 * 1024));
        w.0.extend_from_slice(MAGIC);
        w.u32(VERSION);

        // Settings
        w.u32(self.seed);
        w.u8(self.n_players);
        w.u8(self.local);

        // The map. Terrain never changes, but storing it is simpler and
        // safer than regenerating it (a generator tweak would break saves).
        let m = &self.map;
        w.i32(m.w);
        w.i32(m.h);
        let n = (m.w * m.h) as usize;
        w.0.extend_from_slice(&m.terrain[..n]);
        w.0.extend_from_slice(&m.shade[..n]);
        for &b in &m.blocked[..n] {
            w.bool(b);
        }
        for &v in &m.dep_at[..n] {
            w.i32(v);
        }
        for &v in &m.bld_at[..n] {
            w.i32(v);
        }
        w.0.extend_from_slice(&self.fog[..n]);
        w.0.extend_from_slice(&self.explored[..n]);

        w.len(self.deps.len());
        for d in &self.deps {
            w.u8(d.kind as u8);
            w.i32(d.tx);
            w.i32(d.ty);
        }

        w.len(self.ents.len());
        for e in &self.ents {
            w.u32(e.id);
            w.kind(e.kind);
            w.u8(e.owner);
            w.bool(e.alive);
            for v in [e.x, e.y, e.px, e.py, e.hp, e.facing] {
                w.f32(v);
            }
            w.u8(e.anim as u8);
            w.f32(e.hit_flash);
            w.bool(e.selected);
            w.bool(e.seen);
            w.order(e.order);
            w.opt_pt(e.resume);
            w.len(e.path.len());
            for &p in &e.path {
                w.pt(p);
            }
            w.goal(e.goal);
            for v in [e.repath, e.stuck, e.cooldown, e.scan] {
                w.f32(v);
            }
            w.f32(e.sfx);
            w.i32(e.tx);
            w.i32(e.ty);
            w.f32(e.built);
            w.len(e.queue.len());
            for &k in &e.queue {
                w.kind(k);
            }
            w.f32(e.progress);
            w.opt_pt(e.rally);
            w.u8(e.builders_in);
            w.u8(e.recruits);
            w.bool(e.hiring);
            w.u32(e.goods);
        }

        w.len(self.players.len());
        for p in &self.players {
            w.u32(p.supply_pct as u32);
            w.f32(p.arrive_timer);
            w.u8(p.era);
            w.bool(p.defeated);
            w.bool(p.short);
            w.u32(p.trained);
            w.u32(p.lost);
            w.u32(p.built);
        }

        w.len(self.proj.len());
        for p in &self.proj {
            for v in [p.x, p.y, p.px, p.py] {
                w.f32(v);
            }
            w.u32(p.target);
            w.f32(p.damage);
            w.u32(p.attacker);
            w.bool(p.alive);
            w.pt((p.sx, p.sy));
            w.kind(p.shooter);
            w.bool(p.at_building);
        }

        w.len(self.ais.len());
        for a in &self.ais {
            w.bool(a.on);
            w.f32(a.timer);
            w.u32(a.difficulty);
            w.f32(a.next_attack);
            w.u32(a.wave_size as u32);
            w.opt_pt(a.alarm);
            w.bool(a.wonder_started);
            w.bool(a.scout.is_some());
            w.u32(a.scout.unwrap_or(0));
            w.u8(a.scout_leg);
            w.bool(a.last_grew);
        }

        w.f32(self.time);
        w.u8(self.state);
        w.u8(self.winner);
        w.bool(self.by_wonder);
        let (fog_timer, alert_cooldown, idle_cursor) = self.save_timers();
        w.f32(fog_timer);
        w.f32(alert_cooldown);
        w.u32(idle_cursor);
        w.0
    }

    /// Rebuild a game from `save`'s bytes, or `None` if they aren't a save
    /// this version understands (or are damaged).
    pub fn load(bytes: &[u8]) -> Option<Game> {
        let r = &mut R { b: bytes, at: 0 };
        if r.take(4)? != MAGIC || r.u32()? != VERSION {
            return None;
        }
        let seed = r.u32()?;
        let n_players = r.u8()?;
        let local = r.u8()?;
        if !(2..=MAX_PLAYERS as u8).contains(&n_players) || !(1..=n_players).contains(&local) {
            return None;
        }

        let (mw, mh) = (r.i32()?, r.i32()?);
        if !(8..=512).contains(&mw) || !(8..=512).contains(&mh) {
            return None;
        }
        let n = (mw * mh) as usize;
        let terrain = r.take(n)?.to_vec();
        let shade = r.take(n)?.to_vec();
        let blocked = (0..n).map(|_| r.bool()).collect::<Option<Vec<_>>>()?;
        let dep_at = (0..n).map(|_| r.i32()).collect::<Option<Vec<_>>>()?;
        let bld_at = (0..n).map(|_| r.i32()).collect::<Option<Vec<_>>>()?;
        let fog = r.take(n)?.to_vec();
        let explored = r.take(n)?.to_vec();
        let map = Map { w: mw, h: mh, terrain, shade, blocked, dep_at, bld_at };

        let ndeps = r.len(9)?;
        let mut deps = Vec::with_capacity(ndeps);
        for _ in 0..ndeps {
            deps.push(Deposit { kind: Dep::from_u8(r.u8()?)?, tx: r.i32()?, ty: r.i32()? });
        }

        let nents = r.len(56)?;
        let mut ents = Vec::with_capacity(nents);
        for i in 0..nents {
            let id = r.u32()?;
            let kind = r.kind()?;
            let owner = r.u8()?;
            if id as usize != i || owner as usize > n_players as usize {
                return None;
            }
            let mut e = Entity::blank(id, kind, owner);
            e.alive = r.bool()?;
            e.x = r.f32()?;
            e.y = r.f32()?;
            e.px = r.f32()?;
            e.py = r.f32()?;
            e.hp = r.f32()?;
            e.facing = r.f32()?;
            e.anim = match r.u8()? {
                0 => Anim::Idle,
                1 => Anim::Walk,
                2 => Anim::Work,
                3 => Anim::Fight,
                _ => return None,
            };
            e.hit_flash = r.f32()?;
            e.selected = r.bool()?;
            e.seen = r.bool()?;
            e.order = r.order()?;
            e.resume = r.opt_pt()?;
            let np = r.len(8)?;
            e.path = (0..np).map(|_| r.pt()).collect::<Option<Vec<_>>>()?;
            e.goal = r.goal()?;
            e.repath = r.f32()?;
            e.stuck = r.f32()?;
            e.cooldown = r.f32()?;
            e.scan = r.f32()?;
            e.sfx = r.f32()?;
            e.tx = r.i32()?;
            e.ty = r.i32()?;
            e.built = r.f32()?;
            let nq = r.len(1)?;
            e.queue = (0..nq).map(|_| r.kind()).collect::<Option<Vec<_>>>()?;
            e.progress = r.f32()?;
            e.rally = r.opt_pt()?;
            e.builders_in = r.u8()?;
            e.recruits = r.u8()?;
            e.hiring = r.bool()?;
            e.goods = r.u32()?;
            ents.push(e);
        }

        let nplayers = r.len(1)?;
        if nplayers != n_players as usize + 1 {
            return None;
        }
        let mut players = Vec::with_capacity(nplayers);
        for _ in 0..nplayers {
            let pct = r.u32()?;
            if pct > 1000 {
                return None;
            }
            let mut p = Player::new(pct as u16);
            p.arrive_timer = r.f32()?;
            p.era = r.u8()?.min(5);
            p.defeated = r.bool()?;
            p.short = r.bool()?;
            p.trained = r.u32()?;
            p.lost = r.u32()?;
            p.built = r.u32()?;
            players.push(p);
        }

        let nproj = r.len(29)?;
        let mut proj = Vec::with_capacity(nproj);
        for _ in 0..nproj {
            let mut p = Projectile { x: r.f32()?, y: r.f32()?, px: r.f32()?, py: r.f32()?, target: r.u32()?, damage: r.f32()?, attacker: r.u32()?, alive: r.bool()?, sx: 0.0, sy: 0.0, shooter: Kind::Archer, at_building: false };
            (p.sx, p.sy) = r.pt()?;
            p.shooter = r.kind()?;
            p.at_building = r.bool()?;
            proj.push(p);
        }

        let nais = r.len(1)?;
        if nais != nplayers {
            return None;
        }
        let mut ais = Vec::with_capacity(nais);
        for _ in 0..nais {
            let mut a = Ai::new(1, false, 0.0);
            a.on = r.bool()?;
            a.timer = r.f32()?;
            a.difficulty = r.u32()?.min(2);
            a.next_attack = r.f32()?;
            a.wave_size = r.u32()? as usize;
            a.alarm = r.opt_pt()?;
            a.wonder_started = r.bool()?;
            let has_scout = r.bool()?;
            let scout = r.u32()?;
            a.scout = has_scout.then_some(scout);
            a.scout_leg = r.u8()?;
            a.last_grew = r.bool()?;
            if a.scout.is_some_and(|s| s as usize >= ents.len()) {
                return None;
            }
            ais.push(a);
        }

        let time = r.f32()?;
        let state = r.u8()?;
        let winner = r.u8()?;
        let by_wonder = r.bool()?;
        let timers = (r.f32()?, r.f32()?, r.u32()?);
        if r.at != bytes.len() {
            return None;
        }

        // References between things (ids, resource indexes) must point at
        // something that exists, or a damaged save could crash the game later.
        let ok_ent = |id: u32| (id as usize) < ents.len();
        let refs_ok = ents.iter().all(|e| match e.order {
            Order::Attack { target, .. } => ok_ent(target),
            Order::Build(id) | Order::Work(id) | Order::Enlist(id) => ok_ent(id),
            _ => true,
        }) && proj.iter().all(|p| ok_ent(p.target) && ok_ent(p.attacker))
            && map.dep_at.iter().all(|&v| v < deps.len() as i32)
            && map.bld_at.iter().all(|&v| v < ents.len() as i32)
            && map.dep_at.iter().chain(&map.bld_at).all(|&v| v >= -1)
            && deps.iter().all(|x| map.inside(x.tx, x.ty));
        // Positions must be on the map, or indexing the tile grid would fail.
        let on_map = |x: f32, y: f32| x.is_finite() && y.is_finite() && x >= 0.0 && y >= 0.0 && x < mw as f32 && y < mh as f32;
        let places_ok = ents.iter().all(|e| {
            let size = e.kind.stats().size;
            let footprint = !e.kind.is_building() || (map.inside(e.tx, e.ty) && map.inside(e.tx + size - 1, e.ty + size - 1));
            footprint && (!e.alive || (on_map(e.x, e.y) && on_map(e.px, e.py) && e.hp.is_finite()))
        }) && proj.iter().all(|p| on_map(p.x, p.y));
        if !refs_ok || !places_ok {
            return None;
        }

        let mut g = Game::from_parts(seed, map, deps, ents, players, n_players, proj, fog, ais, local);
        g.explored = explored;
        g.time = time;
        g.state = state;
        g.winner = winner;
        g.by_wonder = by_wonder;
        g.load_timers(timers);
        Some(g)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Play a while, save, load, then play both copies on: they must stay
    /// identical, byte for byte, the whole way.
    #[test]
    fn round_trip_stays_in_lockstep() {
        for (players, diff) in [(2u8, 2u32), (4, 1)] {
            let mut a = Game::new(1234, diff, players);
            // Let the computer play the human slot too, so lots happens.
            a.set_ai(1, true);
            for _ in 0..20 * 60 * 6 {
                a.tick();
            }
            let bytes = a.save();
            let mut b = Game::load(&bytes).expect("load");
            let again = b.save();
            if let Some(i) = (0..bytes.len().min(again.len())).find(|&i| bytes[i] != again[i]) {
                let n = (a.map.w * a.map.h) as usize;
                panic!("save → load → save changed byte {i} of {} (map tiles {n}; fog ends at {})", bytes.len(), 22 + n * 11);
            }
            assert_eq!(again, bytes, "save → load → save changed the length");
            for t in 0..20 * 60 * 4 {
                a.tick();
                b.tick();
                if t % 200 == 0 {
                    assert_eq!(a.checksum(), b.checksum(), "drifted at tick {t}");
                }
            }
            assert_eq!(a.save(), b.save(), "drifted apart after loading");
            assert!(a.ents.len() > 20, "the test game should have grown");
        }
    }

    #[test]
    fn junk_is_refused_not_crashed_on() {
        let g = Game::new(7, 1, 2);
        let bytes = g.save();
        assert!(Game::load(&[]).is_none());
        assert!(Game::load(b"VCSV").is_none());
        assert!(Game::load(&bytes[..bytes.len() - 1]).is_none());
        let mut longer = bytes.clone();
        longer.push(0);
        assert!(Game::load(&longer).is_none());
        // Flip bytes all over: whatever happens, no panic.
        for i in (0..bytes.len()).step_by(97) {
            let mut b = bytes.clone();
            b[i] ^= 0xA5;
            let _ = Game::load(&b);
        }
    }
}

#[cfg(test)]
mod fuzz {
    use super::*;

    /// Slow (a minute or so), so not run by default:
    /// `cargo test --release -- --ignored`. Flips bits all through a save;
    /// anything `load` accepts must then run without crashing.
    #[test]
    #[ignore]
    fn damaged_saves_never_crash_the_game() {
        let mut g = Game::new(7, 1, 2);
        g.set_ai(1, true);
        for _ in 0..20 * 120 {
            g.tick();
        }
        let bytes = g.save();
        let mut crashed = Vec::new();
        for i in 0..bytes.len() {
            for mask in [0x01u8, 0x80, 0xFF] {
                let mut b = bytes.clone();
                b[i] ^= mask;
                if let Some(mut h) = Game::load(&b) {
                    let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        for _ in 0..40 {
                            h.tick();
                        }
                    }));
                    if run.is_err() {
                        crashed.push((i, mask));
                    }
                }
            }
        }
        assert!(crashed.is_empty(), "loads that later crashed (byte, mask): {crashed:?}");
    }
}
