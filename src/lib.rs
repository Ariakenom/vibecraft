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

use defs::{Kind, Res};
use game::{Command, Game, Intent, Order};
use std::cell::RefCell;

/// Floats per entity in the render buffer. Keep in sync with `ENT_STRIDE` in the JS.
const ENT_STRIDE: usize = 18;

struct World {
    game: Game,
    /// Multiplayer only: the confirmed copy of the game (see `mp_save`).
    other: Option<Game>,
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
    let world = World { game: Game::new(seed, difficulty, players.clamp(2, 4) as u8), other: None, ents: Vec::new(), res: Vec::new(), proj: Vec::new(), events: Vec::new(), scratch: vec![0; 512], save: Vec::new() };
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
            if e.unsupplied && e.owner == g.local {
                flags |= 16;
            }
            let progress = if e.built < 1.0 { e.built } else { e.progress };
            let order = match e.order {
                Order::Idle => 0,
                Order::Move { .. } => 1,
                Order::AttackMove { .. } => 2,
                Order::Attack { .. } => 3,
                Order::Build(_) => 6,
                Order::Arrive(_) => 7,
            };
            // A producer short of workers makes nothing: the page shows it idle.
            if e.built >= 1.0 && !e.crewed && e.owner == g.local {
                flags |= 32;
            }
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
                e.residents as f32, // houses: who lives there...
                e.beds() as f32,    // ...and how many beds it has
                e.facing,
                order as f32,
                rx,
                ry,
            ]);
        }
        // Deposits on explored ground: [tx, ty, kind (defs::Dep), 1, 1]. The
        // last two were a resource's amount and maximum; deposits never run out.
        w.res.clear();
        for d in g.deps.iter() {
            let i = g.map.idx(d.tx, d.ty);
            if g.fog[i] > 0 {
                w.res.extend_from_slice(&[d.tx as f32, d.ty as f32, d.kind as u32 as f32, 1.0, 1.0]);
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
pub extern "C" fn pop() -> u32 {
    game(|g| g.players[g.local as usize].pop)
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

/// End-of-game numbers. which: 0 trained, 1 lost, 2 buildings built.
#[unsafe(no_mangle)]
pub extern "C" fn player_stat(player: u32, which: u32) -> f32 {
    game(|g| {
        let p = &g.players[(player as usize).min(g.n_players as usize)];
        match which {
            0 => p.trained as f32,
            1 => p.lost as f32,
            _ => p.built as f32,
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
                if e.alive && e.owner == w.game.local && e.kind != Kind::Arrival {
                    e.selected = true;
                }
            }
        }
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn idle_builder() -> i32 {
    game(|g| g.select_idle_builder())
}

/// Read `n` entity ids that JavaScript wrote into the scratch buffer.
fn scratch_ids(w: &World, n: u32) -> Vec<u32> {
    w.scratch.iter().take((n as usize).min(w.scratch.len())).copied().collect()
}

/// Apply one player command. JS writes the unit/building ids into the
/// scratch buffer first. `code`: 1 right-click, 2 attack-move, 3 stop,
/// 4 train (`arg` = unit kind), 5 cancel training, 6 place a building
/// (`arg` = kind, x/y = tile), 7 the computer takes over player `arg`
/// (sent with owner 0 by the multiplayer host when someone leaves), 8
/// surrender, 9 demolish the buildings in the scratch buffer.
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
            8 => Command::Surrender,
            9 => Command::Demolish { ids },
            _ => return 0,
        };
        match w.game.apply(owner as u8, cmd) {
            Ok(()) => 0,
            Err(e) => e.code(),
        }
    })
}

/// What right-clicking (x, y) would do with the `n` ids in the scratch
/// buffer, for the mouse cursor: 0 nothing, 1 move, 2 attack, 4 build,
/// 5 rally. (3 and 6–9 were gathering.)
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

/// Like `can_place`, but without the deposit check: tells "wrong spot" from
/// "not next to its deposit" in the message the player sees.
#[unsafe(no_mangle)]
pub extern "C" fn can_place_ignoring_deposit(kind: u32, tx: i32, ty: i32) -> u32 {
    let Some(kind) = Kind::from_u32(kind) else { return 0 };
    game(|g| g.spot_free(kind, tx, ty, g.local, 0) as u32)
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
// ---- Multiplayer: two copies of the game ----
// The LIVE copy is the one you play in and see: your commands go into it at
// once. The CONFIRMED copy only moves forward with commands the host has put
// in their final order. When the confirmed order turns out different from
// what the live copy assumed (a friend's command came in), the live copy is
// replaced by the confirmed one and the last few ticks are run again.
// Every other export works on whichever copy is in `game`, so to step the
// confirmed copy, JS swaps it in, steps it, and swaps it back.

/// Make the confirmed copy: a copy of the game as it is now.
#[unsafe(no_mangle)]
pub extern "C" fn mp_save() {
    with(|w| w.other = Some(w.game.clone()))
}

/// Swap the live and confirmed copies.
#[unsafe(no_mangle)]
pub extern "C" fn mp_swap() {
    with(|w| {
        if let Some(o) = w.other.as_mut() {
            std::mem::swap(&mut w.game, o);
        }
    })
}

/// Throw away the live copy: make it a copy of the confirmed one.
/// `clone_from` reuses the live copy's memory instead of allocating anew.
#[unsafe(no_mangle)]
pub extern "C" fn mp_restore() {
    // Two fields of the same struct can be borrowed separately, one
    // mutably and one not: Rust tracks borrows per field.
    with(|w| {
        if let Some(o) = &w.other {
            w.game.clone_from(o);
        }
    })
}

/// Back to one copy (multiplayer is over).
#[unsafe(no_mangle)]
pub extern "C" fn mp_end() {
    with(|w| w.other = None)
}

/// Fingerprint of one player's things only.
#[unsafe(no_mangle)]
pub extern "C" fn checksum_owner(owner: u32) -> u32 {
    game(|g| g.checksum_owner(owner as u8))
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
/// Unit/building data for the UI, so costs live in one place (defs.rs).
/// A kind's slot lists: `which` 0 cost, 1 what it produces, 2 what it
/// consumes. `kind_slots_n` says how many entries; `kind_slots_res` and
/// `kind_slots_amt` read the n-th.
fn slots_of(kind: u32, which: u32) -> defs::Slots {
    let Some(k) = Kind::from_u32(kind) else { return &[] };
    let s = k.stats();
    match which {
        0 => s.cost,
        1 => s.produces,
        _ => s.consumes,
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn kind_slots_n(kind: u32, which: u32) -> u32 {
    slots_of(kind, which).len() as u32
}
#[unsafe(no_mangle)]
pub extern "C" fn kind_slots_res(kind: u32, which: u32, n: u32) -> i32 {
    slots_of(kind, which).get(n as usize).map_or(-1, |&(r, _)| r as i32)
}
#[unsafe(no_mangle)]
pub extern "C" fn kind_slots_amt(kind: u32, which: u32, n: u32) -> u32 {
    slots_of(kind, which).get(n as usize).map_or(0, |&(_, k)| k as u32)
}
/// The deposit a kind has to be built next to (`defs::Dep`), or -1.
#[unsafe(no_mangle)]
pub extern "C" fn kind_deposit(kind: u32) -> i32 {
    Kind::from_u32(kind).and_then(|k| k.stats().needs_deposit).map_or(-1, |d| d as i32)
}
/// which: 0 hp, 1 attack, 2 range, 3 speed, 4 sight, 5 time, 6 size, 7 workers, 8 cooldown,
/// 9 builders needed, 10 house tier (-1 if not a house)
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
        7 => s.workers as f32,
        9 => s.builders as f32,
        10 => k.house_tier().map_or(-1.0, |t| t as f32),
        _ => s.cooldown,
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn kind_radius(kind: u32) -> f32 {
    Kind::from_u32(kind).map_or(0.3, |k| k.radius())
}

// ---------------------------------------------------------------------------
// Slots and tech tree, for the HUD

/// How many kinds of resource there are.
#[unsafe(no_mangle)]
pub extern "C" fn n_res() -> u32 {
    defs::N_RES as u32
}
/// The era resource `r` first matters in (0 Ancient … 5 Atomic).
#[unsafe(no_mangle)]
pub extern "C" fn res_era(r: u32) -> u32 {
    Res::from_idx(r as usize).map_or(0, |r| r.era() as u32)
}
/// The local player's supply of resource `r`: slots their producers make.
#[unsafe(no_mangle)]
pub extern "C" fn supply(r: u32) -> u32 {
    player_supply(game(|g| g.local as u32), r)
}
/// The local player's use of resource `r`: slots their things hold.
#[unsafe(no_mangle)]
pub extern "C" fn used(r: u32) -> u32 {
    player_used(game(|g| g.local as u32), r)
}
/// Player `p`'s supply of resource `r` (spectators' scoreboard too).
#[unsafe(no_mangle)]
pub extern "C" fn player_supply(p: u32, r: u32) -> u32 {
    game(|g| g.players.get(p as usize).zip(Res::from_idx(r as usize)).map_or(0, |(pl, r)| pl.supply[r.idx()] as u32))
}
#[unsafe(no_mangle)]
pub extern "C" fn player_used(p: u32, r: u32) -> u32 {
    game(|g| g.players.get(p as usize).zip(Res::from_idx(r as usize)).map_or(0, |(pl, r)| pl.used[r.idx()] as u32))
}
/// The first resource the local player lacks free slots of for `kind`, or -1.
#[unsafe(no_mangle)]
pub extern "C" fn short_of(kind: u32) -> i32 {
    let Some(k) = Kind::from_u32(kind) else { return -1 };
    game(|g| g.short_of(g.local, k).map_or(-1, |r| r as i32))
}
/// The local player's people: `which` 0 residents at home, 1 beds, 2 units
/// (each holds a bed; queued ones too), 3 residents at work, 4 newcomers on
/// their way.
#[unsafe(no_mangle)]
pub extern "C" fn people(which: u32) -> u32 {
    player_people(game(|g| g.local as u32), which)
}
#[unsafe(no_mangle)]
pub extern "C" fn player_people(p: u32, which: u32) -> u32 {
    game(|g| {
        g.players.get(p as usize).map_or(0, |pl| match which {
            0 => pl.residents,
            1 => pl.beds,
            2 => pl.units,
            3 => pl.working,
            _ => pl.arriving,
        })
    })
}
/// Slots of resource `r` the local player's houses hold.
#[unsafe(no_mangle)]
pub extern "C" fn housed(r: u32) -> u32 {
    game(|g| Res::from_idx(r as usize).map_or(0, |r| g.players[g.local as usize].housed[r.idx()] as u32))
}
/// The goods a house gets, one bit per resource.
#[unsafe(no_mangle)]
pub extern "C" fn house_goods(id: u32) -> u32 {
    game(|g| g.ents.get(id as usize).map_or(0, |e| e.goods))
}
/// Builders who have reached a foundation so far.
#[unsafe(no_mangle)]
pub extern "C" fn builders_in(id: u32) -> u32 {
    game(|g| g.ents.get(id as usize).map_or(0, |e| e.builders_in as u32))
}
/// 1 if resource `r` is something houses want.
#[unsafe(no_mangle)]
pub extern "C" fn is_house_good(r: u32) -> u32 {
    Res::from_idx(r as usize).is_some_and(|r| r.is_house_good()) as u32
}
/// The most goods a house of `tier` can use.
#[unsafe(no_mangle)]
pub extern "C" fn house_max_goods(tier: u32) -> u32 {
    defs::house_max_goods(tier.min(5) as u8) as u32
}

/// How many of the local player's units are unsupplied right now.
#[unsafe(no_mangle)]
pub extern "C" fn unsupplied() -> u32 {
    game(|g| g.ents.iter().filter(|e| e.alive && e.owner == g.local && e.unsupplied).count() as u32)
}
/// How many living units/buildings of a kind the player has.
#[unsafe(no_mangle)]
pub extern "C" fn count(kind: u32) -> u32 {
    debug_count(game(|g| g.local as u32), kind)
}
/// How many *finished* buildings of a kind the player has.
#[unsafe(no_mangle)]
pub extern "C" fn count_built(kind: u32) -> u32 {
    game(|g| g.ents.iter().filter(|e| e.alive && e.owner == g.local && e.kind as u32 == kind && e.built >= 1.0).count() as u32)
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

/// Debug/testing: set an entity's health (0 destroys it on the next tick).
/// Changes the game outside of commands, so never use it in multiplayer.
#[unsafe(no_mangle)]
pub extern "C" fn debug_set_hp(id: u32, hp: f32) {
    game(|g| {
        if let Some(e) = g.ents.get_mut(id as usize).filter(|e| e.alive) {
            e.hp = hp.clamp(0.0, e.kind.stats().hp);
        }
    })
}

/// How many deposit tiles the map has in total (explored or not). The 3D
/// view sizes its tree and rock meshes from this.
#[unsafe(no_mangle)]
pub extern "C" fn res_total() -> u32 {
    game(|g| g.deps.len() as u32)
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
    let world = World { game, other: None, ents: Vec::new(), res: Vec::new(), proj: Vec::new(), events: Vec::new(), scratch: vec![0; 512], save: Vec::new() };
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

    /// Surrender puts you out at once. With two computer players left they
    /// play on (you can watch); with one left, it has won.
    #[test]
    fn surrender_puts_you_out() {
        init(3, 1, 3);
        for _ in 0..100 {
            tick();
        }
        assert_eq!(command(1, 8, 0, 0.0, 0.0, 0), 0);
        tick();
        assert_eq!((defeated(1), state_of(1), state_of(2)), (1, 5, 0));
        assert_eq!(debug_count(1, 0) + debug_count(1, 64), 0, "everything of theirs fell");
        assert_eq!(command(1, 8, 0, 0.0, 0.0, 0), 0, "surrendering twice is harmless");

        init(3, 1, 2);
        command(1, 8, 0, 0.0, 0.0, 0);
        tick();
        assert_eq!((state_of(1), state_of(2), winner_player()), (2, 1, 2));
    }

    /// Lifting the fog, or looking through another player's eyes, changes
    /// only what's shown: the game runs exactly the same.
    #[test]
    fn the_view_never_changes_the_game() {
        init(11, 2, 4);
        set_ai(1, 1);
        for _ in 0..1200 {
            tick();
        }
        mp_save(); // a second copy, to run side by side
        set_view(3, 1); // both copies: the whole map, seen as Green
        with(|w| {
            let o = w.other.as_mut().unwrap(); // then the second one back to normal
            o.local = 1;
            o.reveal = false;
        });
        for t in 0..2400 {
            tick();
            take_events();
            mp_swap();
            tick();
            take_events();
            let other = checksum();
            mp_swap();
            assert_eq!(checksum(), other, "the views made the games differ at tick {t}");
        }
        assert_eq!((local_player(), view_reveal()), (3, 1));
        mp_swap();
        assert_eq!((local_player(), view_reveal()), (1, 0));
    }

}

// ---------------------------------------------------------------------------
// Watching: spectators, replays, and players who are out of the game.

/// Look at the game through player `player`'s eyes (their fog, HUD numbers
/// and alerts), or with `reveal` the whole map. Through a player's eyes the
/// fog starts afresh: the parts they can see now, the rest unexplored. Only changes what this
/// computer shows, never the game itself, so it's safe in multiplayer. Both
/// multiplayer copies get it, so a correction doesn't undo it.
#[unsafe(no_mangle)]
pub extern "C" fn set_view(player: u32, reveal: u32) {
    with(|w| {
        for g in std::iter::once(&mut w.game).chain(w.other.as_mut()) {
            g.local = player.clamp(1, g.n_players as u32) as u8;
            g.reveal = reveal != 0;
            if !g.reveal {
                // Only one player's fog is ever kept, so we can't know what
                // this one has explored before: start from what they see now.
                g.fog.iter_mut().for_each(|v| *v = 0);
                let local = g.local;
                for e in g.ents.iter_mut() {
                    e.seen = e.owner == local;
                }
            }
            g.update_fog();
        }
    })
}
/// Like `state()`, but from player `p`'s point of view, whoever we're
/// looking through: 0 playing, 1 won by conquest, 2 lost by conquest, 3 won
/// with a Wonder, 4 lost to a Wonder, 5 out while the others play on.
#[unsafe(no_mangle)]
pub extern "C" fn state_of(p: u32) -> u32 {
    game(|g| {
        let out = g.players.get(p as usize).is_some_and(|pl| pl.defeated);
        match (g.winner as u32, g.by_wonder) {
            (0, _) if out => 5,
            (0, _) => 0,
            (w, false) if w == p => 1,
            (_, false) => 2,
            (w, true) if w == p => 3,
            _ => 4,
        }
    })
}
/// 1 while the fog is lifted (see `set_view`).
#[unsafe(no_mangle)]
pub extern "C" fn view_reveal() -> u32 {
    game(|g| g.reveal as u32)
}
/// 1 if the winner won by finishing a Wonder.
#[unsafe(no_mangle)]
pub extern "C" fn by_wonder() -> u32 {
    game(|g| g.by_wonder as u32)
}
/// For the spectators' scoreboard: living units of player `p`
/// (`which` 0), or just their soldiers (1).
#[unsafe(no_mangle)]
pub extern "C" fn player_units(p: u32, which: u32) -> u32 {
    game(|g| g.ents.iter().filter(|e| e.alive && e.owner as u32 == p && !e.is_building() && (which == 0 || e.kind.is_military())).count() as u32)
}
