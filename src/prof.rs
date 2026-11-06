//! Where a tick's time goes, part by part, for the trace (F8). Only when
//! switched on (`prof_enable`), and only into this table: the game itself
//! never reads it, so games stay the same on every computer.
//!
//! In the browser the clock is the page's (`performance.now`, imported as
//! `env.now_ms`); natively, `Instant`.

use std::cell::RefCell;

/// The parts timed. Their names, in this order, are `NAMES` (and the page
/// reads them through `prof_name`).
#[derive(Clone, Copy)]
pub enum Part {
    Tick,
    Resolve,
    Stake,
    Grow,
    Recruit,
    Grid,
    Subs,
    Units,
    Separate,
    Projectiles,
    Nukes,
    Reap,
    Fog,
    AiTowns,
    AiBarbarians,
    AiCensus,
    AiEconomy,
    AiArmy,
    AiNavy,
    AiScout,
    AiFight,
    AiAir,
    Frontier,
    Paths,
}

pub const NAMES: [&str; 24] = [
    "tick", "settle (resolve)", "foundations", "grow", "recruit", "grid", "submarines", "units", "separate", "projectiles", "nukes", "reap", "fog",
    "AI: towns", "AI: barbarians", "AI census", "AI economy", "AI army", "AI navy", "AI scout", "AI fight", "AI air", "barbarian camps", "paths",
];
pub const N: usize = NAMES.len();

/// Per part: milliseconds, then how many times, since the last reset.
/// Plus path tiles searched (`[2 * N]`).
pub struct Table {
    pub on: bool,
    pub ms: [f64; N],
    pub count: [f64; N],
    pub path_tiles: f64,
}

thread_local! {
    pub static TABLE: RefCell<Table> = const { RefCell::new(Table { on: false, ms: [0.0; N], count: [0.0; N], path_tiles: 0.0 }) };
}

#[cfg(target_arch = "wasm32")]
mod clock {
    #[link(wasm_import_module = "env")]
    unsafe extern "C" {
        fn now_ms() -> f64;
    }
    pub fn now() -> f64 {
        unsafe { now_ms() }
    }
}
#[cfg(not(target_arch = "wasm32"))]
mod clock {
    thread_local! { static T0: std::time::Instant = std::time::Instant::now(); }
    pub fn now() -> f64 {
        T0.with(|t| t.elapsed().as_secs_f64() * 1000.0)
    }
}

pub fn on() -> bool {
    TABLE.with(|t| t.borrow().on)
}

/// Times its part until dropped (nothing, when timing is off).
pub struct Span(Option<(Part, f64)>);

pub fn span(p: Part) -> Span {
    Span(if on() { Some((p, clock::now())) } else { None })
}

impl Drop for Span {
    fn drop(&mut self) {
        if let Some((p, t0)) = self.0 {
            let dt = clock::now() - t0;
            TABLE.with(|t| {
                let mut t = t.borrow_mut();
                t.ms[p as usize] += dt;
                t.count[p as usize] += 1.0;
            });
        }
    }
}

/// Count tiles a path search looked at.
pub fn path_tiles(n: usize) {
    TABLE.with(|t| {
        let mut t = t.borrow_mut();
        if t.on {
            t.path_tiles += n as f64;
        }
    });
}

pub fn set(on: bool) {
    TABLE.with(|t| t.borrow_mut().on = on);
}

pub fn reset() {
    TABLE.with(|t| {
        let mut t = t.borrow_mut();
        t.ms = [0.0; N];
        t.count = [0.0; N];
        t.path_tiles = 0.0;
    });
}

/// The table as numbers: N times, N counts, path tiles.
pub fn flat(out: &mut Vec<f64>) {
    TABLE.with(|t| {
        let t = t.borrow();
        out.clear();
        out.extend_from_slice(&t.ms);
        out.extend_from_slice(&t.count);
        out.push(t.path_tiles);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    /// Timing a game doesn't change it.
    #[test]
    fn timing_changes_nothing() {
        let run = |timed: bool| {
            set(timed);
            reset();
            let mut g = crate::game::Game::new(4, 1, 2);
            g.set_ai(1, true);
            g.set_ai(2, true);
            for _ in 0..1200 {
                g.tick();
                g.events.clear();
            }
            let parts = TABLE.with(|t| t.borrow().count[Part::Tick as usize]);
            set(false);
            (g.checksum(), parts)
        };
        let (a, none) = run(false);
        let (b, ticks) = run(true);
        assert_eq!(a, b);
        assert_eq!(none, 0.0);
        assert_eq!(ticks, 1200.0);
    }
}
