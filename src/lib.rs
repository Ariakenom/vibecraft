//! The boundary between Rust and JavaScript.
//!
//! WebAssembly functions can only pass numbers (i32, i64, f32, f64) back and
//! forth. So instead of returning structs, we write game state into flat
//! `Vec<f32>` buffers and hand JavaScript a *pointer* into wasm memory; JS wraps
//! that address in a `Float32Array` and reads the numbers directly. No copying,
//! no serialization, no binding generator.

mod ai;
mod defs;
mod game;
mod map;
mod path;
mod save;

use defs::Kind;
use defs::Res;
use game::{Command, Game, Intent, Order, ResNode};
use std::cell::RefCell;

/// Floats per entity in the render buffer. Keep in sync with `ENT_STRIDE` in the JS.
const ENT_STRIDE: usize = 18;

struct World {
    game: Game,
    ents: Vec<f32>,
    res: Vec<f32>,
    proj: Vec<f32>,
    events: Vec<f32>,
    scratch: Vec<u32>,
    /// Bytes going out of (`save_game`) or into (`load_game`) a saved game.
    save: Vec<u8>,
}

// Global mutable state, the safe way: a thread-local `RefCell`. Wasm here is
// single-threaded, and `RefCell` checks the borrow rules at runtime instead of
// compile time, so we never need `unsafe` or `static mut`.
thread_local! {
    static WORLD: RefCell<Option<World>> = const { RefCell::new(None) };
}

/// Run `f` with the world, or return a default value if the game hasn't started.
/// The `R: Default` bound means callers get 0 / false / () for free.
fn with<R: Default>(f: impl FnOnce(&mut World) -> R) -> R {
    WORLD.with(|w| match w.borrow_mut().as_mut() {
        Some(world) => f(world),
        None => R::default(),
    })
}

fn game<R: Default>(f: impl FnOnce(&mut Game) -> R) -> R {
    with(|w| f(&mut w.game))
}

#[unsafe(no_mangle)]
/// Start a new game for `players` (2 to 4). Player 1 is this computer;
/// the others are computer players until `setup_multiplayer` says otherwise.
pub extern "C" fn init(seed: u32, difficulty: u32, players: u32) {
    let world = World { game: Game::new(seed, difficulty, players.clamp(2, 4) as u8), ents: Vec::new(), res: Vec::new(), proj: Vec::new(), events: Vec::new(), scratch: vec![0; 512], save: Vec::new() };
    WORLD.with(|w| *w.borrow_mut() = Some(world));
}

#[unsafe(no_mangle)]
pub extern "C" fn tick() {
    game(|g| g.tick())
}

// ---------------------------------------------------------------------------
// Reading state

/// Fill the render buffers; returns the number of entities written.
#[unsafe(no_mangle)]
pub extern "C" fn render() -> u32 {
    with(|w| {
        let g = &w.game;
        w.ents.clear();
        for e in g.ents.iter().filter(|e| e.alive) {
            let visible = e.owner == g.local || g.visible_to_player(e.x, e.y);
            if !visible && !(e.is_building() && e.seen) {
                continue;
            }
            let st = e.kind.stats();
            let mut flags = 0u32;
            if e.selected {
                flags |= 1;
            }
            if e.built < 1.0 {
                flags |= 2;
            }
            if visible {
                flags |= 4;
            }
            if e.hit_flash > 0.0 {
                flags |= 8;
            }
            let progress = if e.built < 1.0 { e.built } else { e.progress };
            let order = match e.order {
                Order::Idle => 0,
                Order::Move { .. } => 1,
                Order::AttackMove { .. } => 2,
                Order::Attack { .. } => 3,
                Order::Gather(_) => 4,
                Order::Return(_) => 5,
                Order::Build(_) => 6,
            };
            let (rx, ry) = e.rally.unwrap_or((f32::NAN, f32::NAN));
            w.ents.extend_from_slice(&[
                e.id as f32,
                e.kind as u32 as f32,
                e.owner as f32,
                e.x,
                e.y,
                e.px,
                e.py,
                e.hp.max(0.0),
                st.hp,
                flags as f32,
                progress,
                e.anim as u32 as f32,
                e.carry_kind as u32 as f32,
                e.carry,
                e.facing,
                order as f32,
                rx,
                ry,
            ]);
        }
        w.res.clear();
        for r in g.res.iter().filter(|r| r.alive) {
            let i = g.map.idx(r.tx, r.ty);
            if g.fog[i] > 0 {
                w.res.extend_from_slice(&[r.tx as f32, r.ty as f32, r.kind as u32 as f32, r.amount, r.max]);
            }
        }
        w.proj.clear();
        for p in g.proj.iter() {
            if g.visible_to_player(p.x, p.y) {
                w.proj.extend_from_slice(&[p.x, p.y, p.px, p.py]);
            }
        }
        (w.ents.len() / ENT_STRIDE) as u32
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn ents_ptr() -> *const f32 {
    with(|w| w.ents.as_ptr() as usize) as *const f32
}
#[unsafe(no_mangle)]
pub extern "C" fn res_ptr() -> *const f32 {
    with(|w| w.res.as_ptr() as usize) as *const f32
}
#[unsafe(no_mangle)]
pub extern "C" fn res_count() -> u32 {
    with(|w| w.res.len() / 5) as u32
}
#[unsafe(no_mangle)]
pub extern "C" fn proj_ptr() -> *const f32 {
    with(|w| w.proj.as_ptr() as usize) as *const f32
}
#[unsafe(no_mangle)]
pub extern "C" fn proj_count() -> u32 {
    with(|w| w.proj.len() / 4) as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn map_w() -> i32 {
    game(|g| g.map.w)
}
#[unsafe(no_mangle)]
pub extern "C" fn map_h() -> i32 {
    game(|g| g.map.h)
}
#[unsafe(no_mangle)]
pub extern "C" fn terrain_ptr() -> *const u8 {
    game(|g| g.map.terrain.as_ptr() as usize) as *const u8
}
#[unsafe(no_mangle)]
pub extern "C" fn shade_ptr() -> *const u8 {
    game(|g| g.map.shade.as_ptr() as usize) as *const u8
}
#[unsafe(no_mangle)]
pub extern "C" fn fog_ptr() -> *const u8 {
    game(|g| g.fog.as_ptr() as usize) as *const u8
}

#[unsafe(no_mangle)]
pub extern "C" fn stock(r: u32) -> f32 {
    game(|g| g.players[g.local as usize].stock[(r as usize).min(3)])
}
#[unsafe(no_mangle)]
pub extern "C" fn pop() -> u32 {
    game(|g| g.players[g.local as usize].pop)
}
/// Food eaten per minute by all the player's units.
#[unsafe(no_mangle)]
pub extern "C" fn upkeep() -> f32 {
    game(|g| g.players[g.local as usize].upkeep)
}
#[unsafe(no_mangle)]
pub extern "C" fn starving() -> u32 {
    game(|g| g.players[g.local as usize].starving as u32)
}
#[unsafe(no_mangle)]
/// 0 playing; from the local player's point of view: 1 won by conquest,
/// 2 lost by conquest, 3 won with a Wonder, 4 lost to a Wonder,
/// 5 you're out but the others play on (watch, or leave).
pub extern "C" fn state() -> u32 {
    game(|g| match (g.winner, g.by_wonder) {
        (0, _) if g.players[g.local as usize].defeated => 5,
        (0, _) => 0,
        (w, false) if w == g.local => 1,
        (_, false) => 2,
        (w, true) if w == g.local => 3,
        _ => 4,
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn game_time() -> f32 {
    game(|g| g.time)
}

/// End-of-game numbers. which: 0 trained, 1 lost, 2 gathered.
#[unsafe(no_mangle)]
pub extern "C" fn player_stat(player: u32, which: u32) -> f32 {
    game(|g| {
        let p = &g.players[(player as usize).min(g.n_players as usize)];
        match which {
            0 => p.trained as f32,
            1 => p.lost as f32,
            _ => p.gathered,
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn queue_len(id: u32) -> u32 {
    game(|g| g.ents.get(id as usize).map_or(0, |e| e.queue.len() as u32))
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_kind(id: u32, k: u32) -> i32 {
    game(|g| g.ents.get(id as usize).and_then(|e| e.queue.get(k as usize)).map_or(-1, |&q| q as i32))
}

/// Moves pending events into a buffer JS can read; returns the float count.
#[unsafe(no_mangle)]
pub extern "C" fn take_events() -> u32 {
    with(|w| {
        w.events.clear();
        w.events.append(&mut w.game.events);
        w.events.len() as u32
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn events_ptr() -> *const f32 {
    with(|w| w.events.as_ptr() as usize) as *const f32
}

// ---------------------------------------------------------------------------
// Commands

#[unsafe(no_mangle)]
pub extern "C" fn select_rect(x0: f32, y0: f32, x1: f32, y1: f32, add: u32, filter: i32) {
    game(|g| g.select_rect(x0, y0, x1, y1, add != 0, filter))
}
#[unsafe(no_mangle)]
pub extern "C" fn select_at(x: f32, y: f32, add: u32) -> i32 {
    with(|w| w.game.select_at(x, y, add != 0))
}
#[unsafe(no_mangle)]
pub extern "C" fn clear_selection() {
    game(|g| g.clear_selection())
}
/// JS writes up to 512 ids here, then calls `select_ids(n)` (used for control groups).
#[unsafe(no_mangle)]
pub extern "C" fn scratch_ptr() -> *mut u32 {
    with(|w| w.scratch.as_mut_ptr() as usize) as *mut u32
}
#[unsafe(no_mangle)]
pub extern "C" fn select_ids(n: u32) {
    with(|w| {
        w.game.clear_selection();
        for &id in w.scratch.iter().take(n as usize) {
            if let Some(e) = w.game.ents.get_mut(id as usize) {
                if e.alive && e.owner == w.game.local {
                    e.selected = true;
                }
            }
        }
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn idle_citizen() -> i32 {
    game(|g| g.select_idle_citizen())
}

/// Read `n` entity ids that JavaScript wrote into the scratch buffer.
fn scratch_ids(w: &World, n: u32) -> Vec<u32> {
    w.scratch.iter().take((n as usize).min(w.scratch.len())).copied().collect()
}

/// Apply one player command. JS writes the unit/building ids into the
/// scratch buffer first. `code`: 1 right-click, 2 attack-move, 3 stop,
/// 4 train (`arg` = unit kind), 5 cancel training, 6 place a building
/// (`arg` = kind, x/y = tile), 7 the computer takes over player `arg`
/// (sent with owner 0 by the multiplayer host when someone leaves).
/// Returns 0 or a `CmdError` code.
///
/// In single player the page calls this at once. In multiplayer it calls
/// it on both computers, on the same tick, with the same arguments.
#[unsafe(no_mangle)]
pub extern "C" fn command(owner: u32, code: u32, n: u32, x: f32, y: f32, arg: u32) -> i32 {
    with(|w| {
        if code == 7 {
            w.game.set_ai(arg.min(4) as u8, true);
            return 0;
        }
        if owner < 1 || owner > w.game.n_players as u32 {
            return 0;
        }
        let ids = scratch_ids(w, n);
        let cmd = match code {
            1 => Command::Smart { ids, x, y },
            2 => Command::AttackMove { ids, x, y },
            3 => Command::Stop { ids },
            4 => match Kind::from_u32(arg) {
                Some(kind) => Command::Train { ids, kind },
                None => return 11,
            },
            5 => match ids.first() {
                Some(&id) => Command::Cancel { id },
                None => return 0,
            },
            6 => match Kind::from_u32(arg) {
                Some(kind) => Command::Place { ids, kind, tx: x as i32, ty: y as i32 },
                None => return 12,
            },
            _ => return 0,
        };
        match w.game.apply(owner as u8, cmd) {
            Ok(()) => 0,
            Err(e) => e.code(),
        }
    })
}

/// What right-clicking (x, y) would do with the `n` ids in the scratch
/// buffer, for the mouse cursor: 0 nothing, 1 move, 2 attack, 3 forage,
/// 4 build, 5 rally, 6 chop wood, 7 mine, 8 drop off, 9 farm.
#[unsafe(no_mangle)]
pub extern "C" fn intent(n: u32, x: f32, y: f32) -> u32 {
    with(|w| {
        let ids = scratch_ids(w, n);
        let g = &w.game;
        match g.intent(&ids, x, y, g.local, true) {
            Intent::Nothing => 0,
            Intent::Move => 1,
            Intent::Attack(_) => 2,
            Intent::Build(_) => 4,
            Intent::Rally => 5,
            Intent::DropOff => 8,
            Intent::Gather(ResNode::Farm(_)) => 9,
            Intent::Gather(node) => match g.node_kind(node) {
                Res::Food => 3,
                Res::Wood => 6,
                _ => 7,
            },
        }
    })
}

/// Could the local player put a building here? Also requires the ground to
/// have been explored (the simulation itself doesn't check fog).
#[unsafe(no_mangle)]
pub extern "C" fn can_place(kind: u32, tx: i32, ty: i32) -> u32 {
    let Some(kind) = Kind::from_u32(kind) else { return 0 };
    game(|g| {
        let s = kind.stats().size;
        let explored = (ty..ty + s).all(|y| (tx..tx + s).all(|x| g.map.inside(x, y) && g.fog[g.map.idx(x, y)] > 0));
        (explored && g.can_place(kind, tx, ty, g.local, 0)) as u32
    })
}

/// Make this a two-player game seen through player `local`'s eyes (1 or 2).
#[unsafe(no_mangle)]
pub extern "C" fn setup_multiplayer(local: u32) {
    game(|g| g.setup_multiplayer(local.clamp(1, g.n_players as u32) as u8))
}
/// Hand a player slot to the computer (1) or to a person (0).
#[unsafe(no_mangle)]
pub extern "C" fn set_ai(player: u32, on: u32) {
    game(|g| g.set_ai(player.min(4) as u8, on != 0))
}
#[unsafe(no_mangle)]
pub extern "C" fn n_players() -> u32 {
    game(|g| g.n_players as u32)
}
/// 1 if player `p` has lost their Capitol.
#[unsafe(no_mangle)]
pub extern "C" fn defeated(p: u32) -> u32 {
    game(|g| g.players.get(p as usize).is_some_and(|pl| pl.defeated) as u32)
}
#[unsafe(no_mangle)]
pub extern "C" fn local_player() -> u32 {
    game(|g| g.local as u32)
}
/// Fingerprint of the game state, to detect multiplayer desyncs.
#[unsafe(no_mangle)]
pub extern "C" fn checksum() -> u32 {
    game(|g| g.checksum())
}

/// Debug/testing helper: how many living entities of a kind an owner has.
#[unsafe(no_mangle)]
pub extern "C" fn debug_count(owner: u32, kind: u32) -> u32 {
    game(|g| g.ents.iter().filter(|e| e.alive && e.owner as u32 == owner && e.kind as u32 == kind).count() as u32)
}
#[unsafe(no_mangle)]
pub extern "C" fn debug_stock(owner: u32, r: u32) -> f32 {
    game(|g| g.players[(owner as usize).min(g.n_players as usize)].stock[(r as usize).min(3)])
}
#[unsafe(no_mangle)]
pub extern "C" fn debug_idle(owner: u32) -> u32 {
    game(|g| g.ents.iter().filter(|e| e.alive && e.owner as u32 == owner && !e.is_building() && e.order == Order::Idle).count() as u32)
}

/// Unit/building data for the UI, so costs live in one place (defs.rs).
#[unsafe(no_mangle)]
pub extern "C" fn kind_cost(kind: u32, r: u32) -> u32 {
    Kind::from_u32(kind).map_or(0, |k| k.stats().cost[(r as usize).min(3)])
}
/// which: 0 hp, 1 attack, 2 range, 3 speed, 4 sight, 5 time, 6 size, 7 upkeep, 8 cooldown
#[unsafe(no_mangle)]
pub extern "C" fn kind_stat(kind: u32, which: u32) -> f32 {
    let Some(k) = Kind::from_u32(kind) else { return 0.0 };
    let s = k.stats();
    match which {
        0 => s.hp,
        1 => s.attack,
        2 => s.range,
        3 => s.speed,
        4 => s.sight,
        5 => s.time,
        6 => s.size as f32,
        7 => s.upkeep,
        _ => s.cooldown,
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn kind_radius(kind: u32) -> f32 {
    Kind::from_u32(kind).map_or(0.3, |k| k.radius())
}
/// Debug: citizens of `owner` gathering resource `r` (4 = idle, 5 = building).
#[unsafe(no_mangle)]
pub extern "C" fn debug_workers(owner: u32, r: u32) -> u32 {
    game(|g| {
        g.ents
            .iter()
            .filter(|e| e.alive && e.owner as u32 == owner && e.kind == Kind::Citizen)
            .filter(|e| match (e.order, r) {
                (Order::Gather(n) | Order::Return(n), r) if r < 4 => g.node_kind(n) as u32 == r,
                (Order::Idle, 4) => true,
                (Order::Build(_), 5) => true,
                _ => false,
            })
            .count() as u32
    })
}

// ---------------------------------------------------------------------------
// Economy and tech tree, for the HUD

/// The player's average income of resource `r` per minute, over the last minute.
#[unsafe(no_mangle)]
pub extern "C" fn income(r: u32) -> f32 {
    game(|g| g.players[g.local as usize].income_per_min((r as usize).min(3), g.time))
}
/// How many of the player's citizens are gathering resource `r`.
#[unsafe(no_mangle)]
pub extern "C" fn workers(r: u32) -> u32 {
    debug_workers(game(|g| g.local as u32), r)
}
/// How many living units/buildings of a kind the player has.
#[unsafe(no_mangle)]
pub extern "C" fn count(kind: u32) -> u32 {
    debug_count(game(|g| g.local as u32), kind)
}
/// The player's gathering multiplier from buildings, for resource `r`.
#[unsafe(no_mangle)]
pub extern "C" fn gather_bonus(r: u32) -> f32 {
    game(|g| g.players[g.local as usize].bonus.gather[(r as usize).min(3)])
}
/// 0 attack multiplier, 1 regen per second, 2 gold per minute.
#[unsafe(no_mangle)]
pub extern "C" fn bonus(which: u32) -> f32 {
    game(|g| {
        let b = g.players[g.local as usize].bonus;
        match which {
            0 => b.attack,
            1 => b.regen,
            _ => b.gold_per_min,
        }
    })
}
/// The n-th building `kind` requires, or -1 when there are no more.
#[unsafe(no_mangle)]
pub extern "C" fn requires(kind: u32, n: u32) -> i32 {
    Kind::from_u32(kind).and_then(|k| k.requires().get(n as usize)).map_or(-1, |&k| k as i32)
}
/// 1 if the player may build `kind` now.
#[unsafe(no_mangle)]
pub extern "C" fn unlocked(kind: u32) -> u32 {
    let Some(k) = Kind::from_u32(kind) else { return 0 };
    game(|g| g.unlocked(g.local, k) as u32)
}
/// 1 if the player owns a finished `kind`.
#[unsafe(no_mangle)]
pub extern "C" fn has_built(kind: u32) -> u32 {
    let Some(k) = Kind::from_u32(kind) else { return 0 };
    game(|g| g.has_built(g.local, k) as u32)
}
/// Construction progress (0..1) of the furthest-along rival Wonder, or -1 if none.
#[unsafe(no_mangle)]
pub extern "C" fn enemy_wonder() -> f32 {
    game(|g| {
        g.ents
            .iter()
            .filter(|e| e.alive && e.owner != g.local && e.kind == Kind::Wonder)
            .map(|e| e.built)
            .fold(-1.0, f32::max)
    })
}

/// Debug/testing: fully heal the player's buildings (for long headless test games).
#[unsafe(no_mangle)]
pub extern "C" fn debug_heal_player() {
    game(|g| {
        for e in g.ents.iter_mut().filter(|e| e.alive && e.owner == g.local && e.is_building()) {
            e.hp = e.kind.stats().hp;
        }
    })
}

/// How many resource nodes the map has in total (explored or not). The 3D
/// view sizes its tree and rock meshes from this.
#[unsafe(no_mangle)]
pub extern "C" fn res_total() -> u32 {
    game(|g| g.res.len() as u32)
}
/// Who won (1-4), or 0 while the game is on.
#[unsafe(no_mangle)]
pub extern "C" fn winner_player() -> u32 {
    game(|g| g.winner as u32)
}

// ---------------------------------------------------------------------------
// Saving and loading (single player). See save.rs for the format.
//
// Saving: `save_game()` returns the byte count, and JS copies that many bytes
// from `save_ptr()`. Loading: JS asks `load_buffer(n)` for room for n bytes,
// writes the save there, then calls `load_game(n)`.

/// Write the current game into the save buffer; returns its length in bytes.
#[unsafe(no_mangle)]
pub extern "C" fn save_game() -> u32 {
    with(|w| {
        w.save = w.game.save();
        w.save.len() as u32
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn save_ptr() -> *const u8 {
    with(|w| w.save.as_ptr() as usize) as *const u8
}

/// Room for `n` bytes of a save to load. Works before any game has started.
#[unsafe(no_mangle)]
pub extern "C" fn load_buffer(n: u32) -> *mut u8 {
    LOAD.with(|b| {
        let mut b = b.borrow_mut();
        *b = vec![0; n as usize];
        b.as_mut_ptr() as usize
    }) as *mut u8
}

/// Replace the current game with the save in the load buffer. Returns 1 on
/// success, 0 if the bytes aren't a save this version can read (the current
/// game is then left as it was).
#[unsafe(no_mangle)]
pub extern "C" fn load_game(n: u32) -> u32 {
    let bytes = LOAD.with(|b| std::mem::take(&mut *b.borrow_mut()));
    let Some(game) = Game::load(&bytes[..(n as usize).min(bytes.len())]) else { return 0 };
    let world = World { game, ents: Vec::new(), res: Vec::new(), proj: Vec::new(), events: Vec::new(), scratch: vec![0; 512], save: Vec::new() };
    WORLD.with(|w| *w.borrow_mut() = Some(world));
    1
}

thread_local! {
    static LOAD: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// The current game's map seed (the page uses it to colour the terrain).
#[unsafe(no_mangle)]
pub extern "C" fn game_seed() -> u32 {
    game(|g| g.seed)
}
/// The computer players' difficulty: 0 easy, 1 normal, 2 hard.
#[unsafe(no_mangle)]
pub extern "C" fn game_difficulty() -> u32 {
    game(|g| g.ais.last().map_or(1, |a| a.difficulty))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The JS round trip: save_game/save_ptr out, load_buffer/load_game in.
    #[test]
    fn exported_save_and_load() {
        init(99, 2, 3);
        for _ in 0..400 {
            tick();
        }
        let n = save_game();
        let bytes = unsafe { std::slice::from_raw_parts(save_ptr(), n as usize) }.to_vec();
        let sum = checksum();
        init(5, 0, 2); // a different game in between
        assert_ne!(checksum(), sum);
        let dst = load_buffer(n);
        unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), dst, n as usize) };
        assert_eq!(load_game(n), 1);
        assert_eq!((checksum(), game_seed(), game_difficulty(), n_players()), (sum, 99, 2, 3));
        assert_eq!(load_game(0), 0, "an empty buffer is refused");
        assert_eq!(checksum(), sum, "a refused load leaves the game alone");
    }
}
