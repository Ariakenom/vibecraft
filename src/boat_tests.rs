//! Tests of boats: the sea and the harbours, sailing, transports, fishing.

use crate::defs::*;
use crate::game::*;
use crate::map::Map;

fn run(g: &mut Game, seconds: f32) {
    for _ in 0..(seconds * 20.0) as u32 {
        g.tick();
        g.events.clear();
    }
}

/// Which water tiles a boat could reach from (x, y).
fn sea_from(m: &Map, x: i32, y: i32) -> Vec<bool> {
    let mut seen = vec![false; (m.w * m.h) as usize];
    let mut stack = vec![(x, y)];
    seen[m.idx(x, y)] = true;
    while let Some((x, y)) = stack.pop() {
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            let (nx, ny) = (x + dx, y + dy);
            if m.sailable(nx, ny) && !seen[m.idx(nx, ny)] {
                seen[m.idx(nx, ny)] = true;
                stack.push((nx, ny));
            }
        }
    }
    seen
}

/// The open sea's water tile nearest `owner`'s Capitol: its harbour.
fn harbour(g: &Game, owner: u8) -> Option<(i32, i32)> {
    let sea = sea_from(&g.map, 1, 1);
    let c = &g.ents[g.home_capitol(owner).unwrap()];
    let (cx, cy) = (c.x as i32, c.y as i32);
    let mut best: Option<(i32, (i32, i32))> = None;
    for y in cy - 20..=cy + 20 {
        for x in cx - 20..=cx + 20 {
            if g.map.inside(x, y) && sea[g.map.idx(x, y)] {
                let d = (x - cx).pow(2) + (y - cy).pow(2);
                if best.is_none_or(|(b, _)| d < b) {
                    best = Some((d, (x, y)));
                }
            }
        }
    }
    best.map(|(_, p)| p)
}

/// Dry land next to a water tile: where a transport puts its cargo ashore.
fn shore_by(g: &Game, (x, y): (i32, i32)) -> (f32, f32) {
    for r in 1..6 {
        for dy in -r..=r {
            for dx in -r..=r {
                if g.map.passable(x + dx, y + dy) {
                    return ((x + dx) as f32 + 0.5, (y + dy) as f32 + 0.5);
                }
            }
        }
    }
    panic!("no shore near {x},{y}");
}

/// A quiet game: nobody plays the other seats, and player 1 holds no slots.
fn quiet(seed: u32, players: u8) -> Game {
    let mut g = Game::new(seed, 1, players);
    for p in 2..=players {
        g.set_ai(p, false);
    }
    g.players[1].cheat = true;
    g
}

/// Every start has a harbour within reach of its Capitol, on the sea that
/// goes round the map: boats from any of them can reach all the others.
#[test]
fn every_harbour_is_on_the_open_sea() {
    for seed in 0..30 {
        for players in [2u8, 4] {
            let g = Game::new(seed, 1, players);
            let mut far = 0;
            for p in 1..=players {
                let (hx, hy) = harbour(&g, p).unwrap_or_else(|| panic!("seed {seed}/{players}: P{p} has no sea within 20 tiles"));
                let c = &g.ents[g.home_capitol(p).unwrap()];
                far = far.max(((hx as f32 - c.x).hypot(hy as f32 - c.y)) as i32);
            }
            assert!(far <= 16, "seed {seed}/{players}: a harbour {far} tiles from its Capitol");
        }
    }
}

/// Boats never leave the water, whatever they're told.
#[test]
fn boats_stay_on_the_water() {
    let mut g = quiet(4, 2);
    let (hx, hy) = harbour(&g, 1).unwrap();
    let b = g.spawn_unit(Kind::Galley, 1, hx as f32 + 0.5, hy as f32 + 0.5);
    // Inland, to the enemy's Capitol: it gets as close as the water goes.
    let c2 = &g.ents[g.home_capitol(2).unwrap()];
    let (tx, ty) = (c2.x, c2.y);
    g.apply(1, Command::Smart { ids: vec![b], x: tx, y: ty }).unwrap();
    let start = (g.ents[b as usize].x, g.ents[b as usize].y);
    for _ in 0..20 * 90 {
        g.tick();
        let e = &g.ents[b as usize];
        assert!(g.map.sailable(e.x as i32, e.y as i32), "a galley on land at {:.1},{:.1}", e.x, e.y);
    }
    let e = &g.ents[b as usize];
    assert!((e.x - start.0).hypot(e.y - start.1) > 20.0, "the galley went nowhere");
}

/// Soldiers go aboard a transport, sail round to the enemy's harbour and
/// go ashore there.
#[test]
fn a_transport_carries_soldiers_to_another_coast() {
    let mut g = quiet(4, 2);
    let (hx, hy) = harbour(&g, 1).unwrap();
    let t = g.spawn_unit(Kind::Transport, 1, hx as f32 + 0.5, hy as f32 + 0.5);
    let (sx, sy) = shore_by(&g, (hx, hy));
    let men: Vec<u32> = (0..3).map(|k| g.spawn_unit(Kind::Spearman, 1, sx + k as f32 * 0.1, sy)).collect();
    let (tx, ty) = (g.ents[t as usize].x, g.ents[t as usize].y);
    assert_eq!(g.intent(&men, tx, ty, 1, false), Intent::Board(t));
    g.apply(1, Command::Smart { ids: men.clone(), x: tx, y: ty }).unwrap();
    run(&mut g, 20.0);
    for &m in &men {
        assert_eq!(g.ents[m as usize].aboard, t + 1, "spearman #{m} didn't board: {:?}", g.ents[m as usize].order);
    }
    assert_eq!(g.cargo(t).count(), 3);
    // Aboard, they can't be picked, selected or shot.
    let (bx, by) = (g.ents[t as usize].x, g.ents[t as usize].y);
    assert!(!matches!(g.pick(bx, by, false), Pick::Ent(id) if men.contains(&id)), "a unit aboard can be picked");
    // Across the sea, to the shore by the other town's harbour.
    let h2 = harbour(&g, 2).unwrap();
    let (lx, ly) = shore_by(&g, h2);
    assert_eq!(g.intent(&[t], lx, ly, 1, false), Intent::Unload);
    g.apply(1, Command::Smart { ids: vec![t], x: lx, y: ly }).unwrap();
    let mut landed = false;
    for _ in 0..20 * 240 {
        g.tick();
        if g.cargo(t).count() == 0 {
            landed = true;
            break;
        }
    }
    assert!(landed, "still aboard; transport at {:.1},{:.1} order {:?}", g.ents[t as usize].x, g.ents[t as usize].y, g.ents[t as usize].order);
    run(&mut g, 5.0);
    for &m in &men {
        let e = &g.ents[m as usize];
        assert!(e.alive && e.aboard == 0 && g.map.passable(e.x as i32, e.y as i32), "spearman #{m} at {:.1},{:.1}", e.x, e.y);
        assert!((e.x - lx).hypot(e.y - ly) < 6.0, "spearman #{m} landed {:.1} tiles off", (e.x - lx).hypot(e.y - ly));
    }
}

/// A transport that sinks takes everyone aboard with it.
#[test]
fn a_sunk_transport_takes_its_cargo_down() {
    let mut g = quiet(4, 2);
    let (hx, hy) = harbour(&g, 1).unwrap();
    let t = g.spawn_unit(Kind::Transport, 1, hx as f32 + 0.5, hy as f32 + 0.5);
    let (sx, sy) = shore_by(&g, (hx, hy));
    let m = g.spawn_unit(Kind::Archer, 1, sx, sy);
    g.apply(1, Command::Smart { ids: vec![m], x: g.ents[t as usize].x, y: g.ents[t as usize].y }).unwrap();
    run(&mut g, 15.0);
    assert_eq!(g.ents[m as usize].aboard, t + 1);
    g.ents[t as usize].hp = 0.0;
    run(&mut g, 0.2);
    assert!(!g.ents[t as usize].alive && !g.ents[m as usize].alive);
}

/// A fishing boat makes fish while it lies still, and none while it sails.
#[test]
fn fishing_boats_fish_while_they_lie_still() {
    let mut g = quiet(4, 2);
    g.players[1].cheat = false;
    let shoal = nearest_shoal(&g, 1);
    let fish = |g: &Game| g.players[1].supply[Res::Fish.idx()];
    let before = fish(&g);
    let b = g.spawn_unit(Kind::FishingBoat, 1, shoal.0, shoal.1);
    run(&mut g, 0.2);
    assert_eq!(fish(&g), before + 3, "a boat on a shoal makes 3 fish");
    // Sailing: no fish on the way.
    let (fx, fy) = water_between(&g, (shoal.0 as i32, shoal.1 as i32), 8, 14);
    g.order_move(b, fx, fy);
    run(&mut g, 0.5);
    assert_eq!(fish(&g), before);
    // Lying still on open water, away from any shoal: none either.
    run(&mut g, 20.0);
    let e = &g.ents[b as usize];
    assert_eq!(e.order, Order::Idle);
    if !g.on_shoal(e.x, e.y) {
        assert_eq!(fish(&g), before, "fishing off a shoal");
    }
}

/// The fish shoal nearest `p`'s Capitol.
fn nearest_shoal(g: &Game, p: u8) -> (f32, f32) {
    let c = &g.ents[g.home_capitol(p).unwrap()];
    let (cx, cy) = (c.x, c.y);
    g.deps.iter().filter(|d| d.kind == Dep::Fish).map(|d| d.center()).min_by(|a, b| (a.0 - cx).hypot(a.1 - cy).total_cmp(&(b.0 - cx).hypot(b.1 - cy))).expect("no shoal on the map")
}

/// Every start has a fish shoal in its harbour, on the open sea, and the
/// same number of shoals as every other start (the map is symmetric).
#[test]
fn every_start_has_a_shoal_in_its_harbour() {
    for seed in 0..30 {
        for players in [2u8, 4] {
            let g = Game::new(seed, 1, players);
            let sea = sea_from(&g.map, 1, 1);
            let shoals: Vec<_> = g.deps.iter().filter(|d| d.kind == Dep::Fish).collect();
            assert!(shoals.iter().all(|d| g.map.terrain[g.map.idx(d.tx, d.ty)] == crate::map::WATER), "seed {seed}: a shoal on land");
            assert!(shoals.len() >= players as usize * 5, "seed {seed}/{players}: only {} shoal tiles", shoals.len());
            for p in 1..=players {
                let c = &g.ents[g.home_capitol(p).unwrap()];
                let near = shoals.iter().filter(|d| sea[g.map.idx(d.tx, d.ty)] && (d.center().0 - c.x).hypot(d.center().1 - c.y) < 18.0).count();
                assert!(near >= 3, "seed {seed}/{players}: P{p} has {near} shoal tiles on the sea near home");
            }
        }
    }
}

/// A dock's boats come out on the water.
#[test]
fn a_dock_launches_its_boats_on_the_water() {
    let mut g = quiet(4, 2);
    let (hx, hy) = harbour(&g, 1).unwrap();
    // A spot for it on the shore.
    let mut at = None;
    'find: for r in 1..8 {
        for dy in -r..=r {
            for dx in -r..=r {
                if g.can_place(Kind::Dock, hx + dx, hy + dy, 1, 0) {
                    at = Some((hx + dx, hy + dy));
                    break 'find;
                }
            }
        }
    }
    let (dx, dy) = at.expect("no room for a dock by the harbour");
    let d = g.spawn_building(Kind::Dock, 1, dx, dy, 1.0);
    run(&mut g, 30.0); // newcomers to train
    g.queue_unit(d, Kind::Galley).unwrap();
    run(&mut g, 60.0);
    let boat = g.ents.iter().find(|e| e.alive && e.kind == Kind::Galley).expect("no galley came out");
    assert!(g.map.sailable(boat.x as i32, boat.y as i32));
}

/// Saving with soldiers aboard: the loaded game plays on exactly the same.
#[test]
fn saves_keep_the_cargo() {
    let mut g = quiet(4, 2);
    let (hx, hy) = harbour(&g, 1).unwrap();
    let t = g.spawn_unit(Kind::Transport, 1, hx as f32 + 0.5, hy as f32 + 0.5);
    let (sx, sy) = shore_by(&g, (hx, hy));
    let m = g.spawn_unit(Kind::Spearman, 1, sx, sy);
    g.apply(1, Command::Smart { ids: vec![m], x: g.ents[t as usize].x, y: g.ents[t as usize].y }).unwrap();
    run(&mut g, 15.0);
    assert_eq!(g.ents[m as usize].aboard, t + 1);
    let h2 = harbour(&g, 2).unwrap();
    let (lx, ly) = shore_by(&g, h2);
    g.apply(1, Command::Smart { ids: vec![t], x: lx, y: ly }).unwrap();
    run(&mut g, 2.0);
    let mut l = Game::load(&g.save()).expect("the save loads");
    assert_eq!(l.ents[m as usize].aboard, t + 1);
    for _ in 0..20 * 60 {
        g.tick();
        l.tick();
        assert_eq!(g.checksum(), l.checksum());
    }
}


/// A warship lying in wait sinks an enemy boat that comes near.
#[test]
fn a_galley_sinks_a_fishing_boat() {
    let mut g = quiet(4, 2);
    let (hx, hy) = harbour(&g, 2).unwrap();
    let prey = g.spawn_unit(Kind::FishingBoat, 2, hx as f32 + 0.5, hy as f32 + 0.5);
    // The nearest open water a few tiles off.
    let sea = sea_from(&g.map, hx, hy);
    let mut at = None;
    'find: for r in 4..12 {
        for dy in -r..=r {
            for dx in -r..=r {
                let (x, y) = (hx + dx, hy + dy);
                if g.map.inside(x, y) && sea[g.map.idx(x, y)] {
                    at = Some((x, y));
                    break 'find;
                }
            }
        }
    }
    let (x, y) = at.unwrap();
    let galley = g.spawn_unit(Kind::Galley, 1, x as f32 + 0.5, y as f32 + 0.5);
    run(&mut g, 60.0);
    assert!(!g.ents[prey as usize].alive, "the fishing boat is still afloat");
    assert!(g.ents[galley as usize].alive);
}

/// Open water, connected to the sea, `r0` to `r1` tiles from (x, y).
fn water_between(g: &Game, (x, y): (i32, i32), r0: i32, r1: i32) -> (f32, f32) {
    let sea = sea_from(&g.map, 1, 1);
    for r in r0..=r1 {
        for dy in -r..=r {
            for dx in -r..=r {
                let (tx, ty) = (x + dx, y + dy);
                if dx.abs().max(dy.abs()) == r && g.map.inside(tx, ty) && sea[g.map.idx(tx, ty)] {
                    return (tx as f32 + 0.5, ty as f32 + 0.5);
                }
            }
        }
    }
    panic!("no open water near {x},{y}");
}

/// A submarine is hidden until something of yours comes within a few
/// tiles, or a destroyer has it in sight; hidden, nobody can target it.
#[test]
fn submarines_are_hidden_until_close() {
    let mut g = quiet(4, 2);
    let h = harbour(&g, 1).unwrap();
    let (gx, gy) = (h.0 as f32 + 0.5, h.1 as f32 + 0.5);
    let galley = g.spawn_unit(Kind::Galley, 1, gx, gy);
    // Out of reach of everything of player 1's but the galley's sight (8).
    let (sx, sy) = water_between(&g, h, 6, 7);
    let sub = g.spawn_unit(Kind::Submarine, 2, sx, sy);
    run(&mut g, 0.1);
    let d = (g.ents[galley as usize].x - sx).hypot(g.ents[galley as usize].y - sy);
    assert!(d > SUB_DETECT + 1.0, "test setup: galley only {d:.1} away");
    assert!(!Game::spotted_by(&g.ents[sub as usize], 1), "spotted from {d:.1} tiles");
    assert!(Game::spotted_by(&g.ents[sub as usize], 2), "its owner always sees it");
    assert_eq!(g.nearest_enemy(galley as usize, 8.0), None, "the galley targets a hidden submarine");
    assert_ne!(g.intent(&[galley], sx, sy, 1, false), Intent::Attack(sub));
    // Right next to it: seen.
    g.ents[galley as usize].x = sx + 1.0;
    g.ents[galley as usize].y = sy;
    run(&mut g, 0.1);
    assert!(Game::spotted_by(&g.ents[sub as usize], 1), "not spotted from a tile away");
    // A destroyer sees it from its sight away.
    let mut g = quiet(4, 2);
    let d = g.spawn_unit(Kind::Destroyer, 1, gx, gy);
    let (sx, sy) = water_between(&g, h, 6, 8);
    let sub = g.spawn_unit(Kind::Submarine, 2, sx, sy);
    run(&mut g, 0.1);
    let dist = (g.ents[d as usize].x - sx).hypot(g.ents[d as usize].y - sy);
    assert!(dist > SUB_DETECT + 1.0 && dist < Kind::Destroyer.stats().sight);
    assert!(Game::spotted_by(&g.ents[sub as usize], 1), "a destroyer {dist:.1} away doesn't see it");
}

/// Torpedoes sink ships, but a submarine can't hit anything on land.
#[test]
fn submarines_torpedo_ships_and_nothing_else() {
    assert!(Kind::Submarine.can_hit(Kind::Galley) && Kind::Submarine.can_hit(Kind::FishingBoat));
    assert!(!Kind::Submarine.can_hit(Kind::Dock) && !Kind::Submarine.can_hit(Kind::Spearman) && !Kind::Submarine.can_hit(Kind::Fighter));
    assert!(!Kind::Archer.can_hit(Kind::Submarine) && !Kind::Tower.can_hit(Kind::Submarine) && !Kind::Bomber.can_hit(Kind::Submarine));
    let mut g = quiet(4, 2);
    let h = harbour(&g, 2).unwrap();
    let galley = g.spawn_unit(Kind::Galley, 2, h.0 as f32 + 0.5, h.1 as f32 + 0.5);
    let (sx, sy) = water_between(&g, h, 4, 5);
    let sub = g.spawn_unit(Kind::Submarine, 1, sx, sy);
    g.apply(1, Command::Smart { ids: vec![sub], x: g.ents[galley as usize].x, y: g.ents[galley as usize].y }).unwrap();
    run(&mut g, 60.0);
    assert!(!g.ents[galley as usize].alive, "the galley is still afloat");
    assert!(g.ents[sub as usize].alive);
}

/// A nuclear submarine arms its nuke only at one of its docks (it pauses
/// while away), then launches it from anywhere at sea.
#[test]
fn a_nuclear_submarine_arms_at_its_dock_and_launches_at_sea() {
    let mut g = quiet(4, 2);
    g.players[1].era = 5;
    let h = harbour(&g, 1).unwrap();
    // A dock on the shore by the harbour, and the submarine beside it.
    let mut at = None;
    'find: for r in 1..8 {
        for dy in -r..=r {
            for dx in -r..=r {
                if g.can_place(Kind::Dock, h.0 + dx, h.1 + dy, 1, 0) {
                    at = Some((h.0 + dx, h.1 + dy));
                    break 'find;
                }
            }
        }
    }
    let (dx, dy) = at.unwrap();
    g.spawn_building(Kind::Dock, 1, dx, dy, 1.0);
    let (sx, sy) = g.free_tile_near_for(true, dx, dy, 2, h.0 as f32, h.1 as f32).unwrap();
    let sub = g.spawn_unit(Kind::NuclearSub, 1, sx, sy);
    // Out at sea it can't start.
    let (fx, fy) = water_between(&g, h, 10, 14);
    g.ents[sub as usize].x = fx;
    g.ents[sub as usize].y = fy;
    assert!(g.apply(1, Command::Arm { id: sub }).is_err(), "armed away from a dock");
    (g.ents[sub as usize].x, g.ents[sub as usize].y) = (sx, sy);
    g.apply(1, Command::Arm { id: sub }).unwrap();
    run(&mut g, NUKE_ARM_TIME / 2.0);
    let half = g.ents[sub as usize].progress;
    // Away from the dock, arming waits.
    g.order_move(sub, fx, fy);
    run(&mut g, 30.0);
    let away = g.ents[sub as usize].progress;
    assert!((half - away).abs() < 0.13, "it went on arming away from the dock: {half:.2} -> {away:.2}");
    g.order_move(sub, sx, sy);
    run(&mut g, NUKE_ARM_TIME);
    assert_eq!(g.ents[sub as usize].nuke, 2, "not armed after its time at the dock");
    // Out to sea, and launch at the other Capitol.
    g.order_move(sub, fx, fy);
    run(&mut g, 20.0);
    let c2 = g.home_capitol(2).unwrap();
    let (tx, ty) = (g.ents[c2].x, g.ents[c2].y);
    g.apply(1, Command::Launch { id: sub, x: tx, y: ty }).unwrap();
    assert_eq!(g.nukes.len(), 1);
    assert_eq!(g.ents[sub as usize].nuke, 0);
    run(&mut g, NUKE_FLIGHT + 1.0);
    assert!(!g.ents[c2].alive, "the nuke didn't take the Capitol");
}

/// Aircraft away from an airfield or carrier run out of fuel and slow
/// down; next to a carrier they fill up again.
#[test]
fn aircraft_run_low_away_from_base_and_refuel_at_a_carrier() {
    let mut g = quiet(4, 2);
    let h = harbour(&g, 1).unwrap();
    let (cx, cy) = water_between(&g, h, 8, 12);
    let f = g.spawn_unit(Kind::Fighter, 1, cx, cy);
    assert_eq!(g.ents[f as usize].fuel, air_fuel(Kind::Fighter));
    // Circling far from any base: it runs dry.
    let full = Kind::Fighter.stats().speed * DT;
    run(&mut g, air_fuel(Kind::Fighter) + 1.0);
    assert_eq!(g.ents[f as usize].fuel, 0.0);
    let (x0, y0) = (g.ents[f as usize].x, g.ents[f as usize].y);
    g.order_move(f, x0 + 30.0_f32.min(g.map.w as f32 - x0 - 1.0), y0);
    run(&mut g, 0.05);
    let step = (g.ents[f as usize].x - x0).hypot(g.ents[f as usize].y - y0);
    assert!((step - full * OUT_OF_FUEL_SPEED).abs() < 1e-3, "out of fuel it moved {step:.3} a tick, not {:.3}", full * OUT_OF_FUEL_SPEED);
    // A carrier comes alongside: it fills up.
    let (fx, fy) = (g.ents[f as usize].x, g.ents[f as usize].y);
    g.order_move(f, fx, fy);
    let c = g.spawn_unit(Kind::Carrier, 1, fx, fy);
    run(&mut g, REFUEL_TIME + 0.5);
    assert!(g.ents[c as usize].alive);
    assert_eq!(g.ents[f as usize].fuel, air_fuel(Kind::Fighter), "not refuelled at the carrier");
}

/// An aircraft has so many shots; empty, it stops fighting until it's
/// back at an airfield or carrier, where it rearms.
#[test]
fn aircraft_run_out_of_ammunition_and_rearm_at_base() {
    let mut g = quiet(4, 2);
    let h = harbour(&g, 2).unwrap();
    let (x, y) = water_between(&g, h, 6, 9);
    // A boat for the fighter to strafe: tough enough to outlast its guns
    // (and held for free, so it doesn't lose health unsupplied).
    g.players[2].cheat = true;
    let target = g.spawn_unit(Kind::Transport, 2, x, y); // (no guns: 12 strafes leave it afloat)
    let f = g.spawn_unit(Kind::Fighter, 1, x + 1.0, y);
    g.apply(1, Command::Smart { ids: vec![f], x, y }).unwrap();
    run(&mut g, 30.0);
    let e = &g.ents[f as usize];
    assert_eq!(e.ammo, 0, "still has {} shots", e.ammo);
    assert!(g.ents[target as usize].alive, "test setup: the target sank");
    assert!(!matches!(e.order, Order::Attack { .. }), "fighting with no ammunition: {:?}", e.order);
    let hp = g.ents[target as usize].hp;
    run(&mut g, 5.0);
    assert!(g.ents[target as usize].hp >= hp - 1.0, "an empty fighter still hurts it");
    // Back at a carrier of its own: full again.
    let (fx, fy) = (g.ents[f as usize].x, g.ents[f as usize].y);
    g.order_move(f, fx, fy);
    g.spawn_unit(Kind::Carrier, 1, fx, fy);
    run(&mut g, REFUEL_TIME + 0.5);
    assert!(g.ents[f as usize].alive);
    assert_eq!(g.ents[f as usize].ammo, air_ammo(Kind::Fighter));
}
