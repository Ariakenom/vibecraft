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
    let (hx, hy) = harbour(&g, 1).unwrap();
    let fish = |g: &Game| g.players[1].supply[Res::Fish.idx()];
    let before = fish(&g);
    let b = g.spawn_unit(Kind::FishingBoat, 1, hx as f32 + 0.5, hy as f32 + 0.5);
    run(&mut g, 0.2);
    assert_eq!(fish(&g), before + 3);
    // Out to sea: no fish on the way.
    g.order_move(b, 2.5, 2.5);
    run(&mut g, 0.5);
    assert_eq!(fish(&g), before);
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
