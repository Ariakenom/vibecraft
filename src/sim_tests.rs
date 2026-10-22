//! Tests of the simulation's rules: slots, people, houses, the AI.
//! (Saves have their own tests in save.rs.)

use crate::defs::*;
use crate::game::*;


/// What a player has, for printing: kind name → count, people, slots.
pub fn census(g: &Game, p: u8) -> String {
    let mut out = String::new();
    for k in Kind::ALL {
        let n = g.ents.iter().filter(|e| e.alive && e.owner == p && e.kind == k).count();
        if n > 0 {
            out += &format!("{k:?} {n}, ");
        }
    }
    let pl = &g.players[p as usize];
    out += &format!("| people {}/{} beds: {} free, {} working, {} soldiers | ", pl.people, pl.beds, pl.free, pl.working, pl.soldiers);
    out += &format!("era {} | ", pl.era);
    if std::env::var("VC_HOUSES").is_ok() {
        for h in g.houses_by_distance(p) {
            let e = &g.ents[h];
            out += &format!("{}{}/{}g{} ", if e.kind == Kind::Hut { "h" } else { "c" }, e.residents, e.beds(), e.goods.count_ones());
        }
        out += &format!("| spare {:?} | ", Res::ALL.iter().take(7).map(|&r| pl.spare(r)).collect::<Vec<_>>());
        for e in g.ents.iter().filter(|e| e.alive && e.owner == p && e.is_building() && e.built < 1.0) {
            out += &format!("[unfinished {:?} at {},{} builders {} built {:.2}] ", e.kind, e.tx, e.ty, e.builders_in, e.built);
        }
    }
    for r in Res::ALL.iter().take(13) {
        out += &format!("{r:?} {}/{} ", pl.used[r.idx()], pl.supply[r.idx()]);
    }
    out
}

/// A spot near player 1's Capitol where `kind` can go, searching outward.
fn spot(g: &Game, kind: Kind) -> (i32, i32) {
    let cap = &g.ents[g.find_first(1, Kind::Capitol).unwrap()];
    let (cx, cy) = (cap.tx, cap.ty);
    for r in 3..30 {
        for y in cy - r..=cy + r {
            for x in cx - r..=cx + r {
                if g.can_place(kind, x, y, 1, 1) {
                    return (x, y);
                }
            }
        }
    }
    panic!("no spot for {kind:?}");
}

/// A finished building of player 1's, put straight on the map, with its
/// crew standing at it (new workers, not ones from the campfire).
fn build(g: &mut Game, kind: Kind) -> u32 {
    let (x, y) = spot(g, kind);
    let id = g.spawn_building(kind, 1, x, y, 1.0);
    for _ in 0..kind.stats().workers {
        let w = g.spawn_unit(Kind::Worker, 1, x as f32 - 0.3, y as f32 - 0.3);
        g.ents[w as usize].order = Order::Work(id);
    }
    g.resolve();
    id
}

fn free(g: &Game, r: Res) -> i32 {
    g.players[1].free(r)
}

fn run(g: &mut Game, seconds: f32) {
    for _ in 0..(seconds * 20.0) as u32 {
        g.tick();
        g.events.clear();
    }
}

/// Take every free worker away, so tests can control who goes where.
fn empty_campfire(g: &mut Game) {
    for i in 0..g.ents.len() {
        if g.ents[i].owner == 1 && g.is_free_worker(&g.ents[i]) {
            g.ents[i].alive = false;
        }
    }
    g.resolve();
}

#[test]
fn a_new_game_starts_with_free_workers_and_nobody_short() {
    for players in 2..=4 {
        let mut g = Game::new(9, 1, players);
        g.tick();
        for p in 1..=players {
            let pl = &g.players[p as usize];
            assert!(Res::ALL.iter().all(|&r| pl.free(r) >= 0), "player {p} starts short");
            assert_eq!((pl.people, pl.free, pl.beds), (8, 8, 8), "player {p}: 8 people, all free at the campfire, 8 beds");
        }
    }
}

#[test]
fn slots_come_free_the_tick_after_a_unit_dies() {
    let mut g = Game::new(5, 1, 2);
    build(&mut g, Kind::LumberCamp);
    let barracks = build(&mut g, Kind::Barracks);
    let wood = free(&g, Res::Wood);
    let soldier = g.spawn_unit(Kind::Spearman, 1, 30.0, 30.0);
    g.tick();
    assert_eq!(free(&g, Res::Wood), wood - 1, "a soldier holds a wood slot");
    g.ents[soldier as usize].hp = 0.0;
    g.tick(); // dies at the end of this tick
    g.tick();
    assert_eq!(free(&g, Res::Wood), wood, "and gives it back once dead");
    // Queued units hold their slots too; cancelling frees them at once.
    g.apply(1, Command::Train { ids: vec![barracks], kind: Kind::Spearman }).unwrap();
    assert_eq!(free(&g, Res::Wood), wood - 1);
    g.apply(1, Command::Cancel { id: barracks }).unwrap();
    assert_eq!(free(&g, Res::Wood), wood);
}

#[test]
fn two_placements_in_one_tick_cannot_share_a_slot() {
    let mut g = Game::new(5, 1, 2);
    build(&mut g, Kind::LumberCamp);
    // Use up wood until exactly 3 are free: one Barracks' worth.
    while free(&g, Res::Wood) > 3 {
        g.spawn_unit(Kind::Spearman, 1, 30.0, 30.0);
        g.resolve();
    }
    let (x, y) = spot(&g, Kind::Barracks);
    assert!(g.apply(1, Command::Place { ids: vec![], kind: Kind::Barracks, tx: x, ty: y }).is_ok());
    let (x, y) = spot(&g, Kind::Barracks);
    let second = g.apply(1, Command::Place { ids: vec![], kind: Kind::Barracks, tx: x, ty: y });
    assert_eq!(second.err(), Some(CmdError::Short(Res::Wood)));
    g.tick();
    assert_eq!(free(&g, Res::Wood), 0);
}

#[test]
fn extractors_need_their_deposit() {
    let mut g = Game::new(5, 1, 2);
    // A quarry right beside the Capitol is nowhere near stone.
    let cap = &g.ents[g.find_first(1, Kind::Capitol).unwrap()];
    let (x, y) = (cap.tx - 3, cap.ty - 3);
    assert!(!g.near_deposit(Kind::Quarry, x, y));
    let r = g.apply(1, Command::Place { ids: vec![], kind: Kind::Quarry, tx: x, ty: y });
    assert_eq!(r.err(), Some(CmdError::NoDeposit(Dep::Stone)));
    // Next to stone it works, and with its crew it makes stone.
    let stone = g.players[1].supply[Res::Stone.idx()];
    build(&mut g, Kind::Quarry);
    assert_eq!(g.players[1].supply[Res::Stone.idx()], stone + 4);
}

#[test]
fn a_lost_producer_leaves_the_newest_units_unsupplied() {
    let mut g = Game::new(5, 1, 2);
    let pasture = build(&mut g, Kind::Pasture);
    assert_eq!(free(&g, Res::Horses), 2);
    let older = g.spawn_unit(Kind::Horseman, 1, 30.0, 30.0);
    let newer = g.spawn_unit(Kind::Horseman, 1, 31.0, 30.0);
    g.tick();
    assert_eq!(free(&g, Res::Horses), 0);
    // The pasture burns: 2 horses held, none made. Nothing crashes.
    g.ents[pasture as usize].hp = 0.0;
    g.tick();
    g.tick();
    assert_eq!(free(&g, Res::Horses), -2);
    assert!(g.ents[newer as usize].unsupplied && g.ents[older as usize].unsupplied);
    // A second pasture covers two again; with one more horseman, only the
    // newest goes without.
    build(&mut g, Kind::Pasture);
    let newest = g.spawn_unit(Kind::Horseman, 1, 32.0, 30.0);
    let hp = g.ents[newest as usize].hp;
    let older_hp = g.ents[older as usize].hp;
    run(&mut g, 1.0);
    assert!(!g.ents[older as usize].unsupplied && !g.ents[newer as usize].unsupplied);
    assert!(g.ents[newest as usize].unsupplied);
    let lost = hp - g.ents[newest as usize].hp;
    let expect = Kind::Horseman.stats().hp * UNSUPPLIED_DAMAGE; // one second's worth
    assert!((lost - expect).abs() < 0.01, "lost {lost}, expected {expect}");
    assert_eq!(g.ents[older as usize].hp, older_hp, "supplied units don't lose health");
}

#[test]
fn saves_keep_slots_in_step() {
    let mut a = Game::new(77, 2, 2);
    a.set_ai(1, true);
    let start = a.ents.len();
    run(&mut a, 100.0);
    assert!(a.ents.len() > start + 5, "the AI should have built things by now");
    let mut b = Game::load(&a.save()).expect("load");
    assert_eq!((a.players[1].supply, a.players[1].used), (b.players[1].supply, b.players[1].used));
    for _ in 0..2000 {
        a.tick();
        b.tick();
    }
    assert_eq!(a.checksum(), b.checksum());
}

fn houses(g: &Game, p: u8) -> Vec<usize> {
    g.houses_by_distance(p)
}

#[test]
fn beds_are_two_per_good() {
    let mut g = Game::new(5, 1, 2);
    // The Capitol's grain and fruit: both huts get 2 goods, 4 beds each.
    for h in houses(&g, 1) {
        assert_eq!((g.ents[h].goods.count_ones(), g.ents[h].beds()), (2, 4));
    }
    // Meat from a hunting lodge makes it 3 goods: 6 beds.
    build(&mut g, Kind::HuntingLodge);
    g.resolve();
    for h in houses(&g, 1) {
        assert_eq!((g.ents[h].goods.count_ones(), g.ents[h].beds()), (3, 6));
    }
    // A hut uses at most 3 goods, however many there are; a full hut
    // with 3 goods has become a cottage, which uses all 4.
    build(&mut g, Kind::FishingHut);
    g.resolve();
    for h in houses(&g, 1) {
        let e = &g.ents[h];
        assert_eq!(e.beds(), if e.kind == Kind::Hut { 6 } else { 8 }, "{:?}", e.kind);
    }
}

#[test]
fn losing_a_farm_empties_the_furthest_houses_first() {
    let mut g = Game::new(5, 1, 2);
    build(&mut g, Kind::LumberCamp); // wood for the huts
    let farm = build(&mut g, Kind::Farm); // grain 2 + 2 = 4
    build(&mut g, Kind::Hut);
    build(&mut g, Kind::Hut);
    g.resolve();
    let hs = houses(&g, 1);
    assert_eq!(hs.len(), 4);
    let grain = 1 << Res::Grain.idx();
    assert!(hs.iter().all(|&h| g.ents[h].goods & grain != 0), "4 grain for 4 huts");
    g.ents[farm as usize].hp = 0.0;
    g.tick();
    g.tick();
    let has: Vec<bool> = hs.iter().map(|&h| g.ents[h].goods & grain != 0).collect();
    assert_eq!(has, [true, true, false, false], "the two nearest keep their grain");
}

#[test]
fn a_free_worker_walks_over_and_becomes_the_soldier() {
    let mut g = Game::new(5, 1, 2);
    build(&mut g, Kind::LumberCamp);
    let barracks = build(&mut g, Kind::Barracks);
    g.tick();
    let (people, free_before) = (g.players[1].people, g.players[1].free);
    g.apply(1, Command::Train { ids: vec![barracks], kind: Kind::Spearman }).unwrap();
    g.tick();
    g.tick();
    let walking = g.ents.iter().filter(|e| e.alive && e.order == Order::Enlist(barracks)).count();
    assert_eq!(walking, 1, "one free worker sets off for the barracks");
    assert_eq!(g.players[1].free, free_before - 1);
    run(&mut g, 40.0);
    let soldiers = g.ents.iter().filter(|e| e.alive && e.owner == 1 && e.kind == Kind::Spearman).count();
    assert_eq!(soldiers, 1, "and comes out a spearman");
    assert_eq!(g.players[1].people, people, "the same number of people: a worker became a soldier");
    // With nobody free at the campfire, training is refused.
    empty_campfire(&mut g);
    let r = g.apply(1, Command::Train { ids: vec![barracks], kind: Kind::Spearman });
    assert_eq!(r.err(), Some(CmdError::NoPeople));
}

#[test]
fn a_foundation_waits_for_all_its_builders() {
    let mut g = Game::new(5, 1, 2);
    // Plenty of everything, so the Wonder's slots don't empty the houses.
    g.players[1].supply_pct = 400;
    empty_campfire(&mut g);
    let (x, y) = spot(&g, Kind::Wonder);
    let w = g.spawn_building(Kind::Wonder, 1, x, y, 0.0);
    // Workers away from the campfire aren't free: nobody sends them.
    let far = |k: u32| (x as f32 + 1.0 + k as f32, y as f32 + 5.5);
    let b: Vec<u32> = (0..3).map(|k| g.spawn_unit(Kind::Worker, 1, far(k).0, far(k).1)).collect();
    g.order_build(b[0], w);
    g.order_build(b[1], w);
    run(&mut g, 10.0);
    let wonder = &g.ents[w as usize];
    assert_eq!((wonder.builders_in, wonder.built), (2, 0.0), "two of three builders: nothing happens");
    assert!(!g.alive(b[0]) && !g.alive(b[1]), "builders are used up at the foundation");
    g.order_build(b[2], w);
    run(&mut g, 10.0);
    assert_eq!(g.ents[w as usize].builders_in, 3);
    assert!(g.ents[w as usize].built > 0.0, "with the third it rises by itself");
}

#[test]
fn free_workers_go_to_work_by_themselves() {
    let mut g = Game::new(5, 1, 2);
    // 8 free workers, four lumber camps of 2 placed without crews: they all
    // fill, in id order. A fifth gets nobody.
    let camps: Vec<u32> = (0..5)
        .map(|_| {
            let (x, y) = spot(&g, Kind::LumberCamp);
            let id = g.spawn_building(Kind::LumberCamp, 1, x, y, 1.0);
            g.resolve();
            id
        })
        .collect();
    run(&mut g, 30.0);
    let crewed: Vec<bool> = camps.iter().map(|&c| g.ents[c as usize].crewed).collect();
    assert_eq!(crewed, [true, true, true, true, false]);
    assert_eq!(g.players[1].supply[Res::Wood.idx()], 4 + 4 * 4, "the camp with nobody makes nothing");
    assert_eq!(g.players[1].free, 0);
}

#[test]
fn moving_workers_away_pauses_a_producer() {
    let mut g = Game::new(5, 1, 2);
    let (x, y) = spot(&g, Kind::LumberCamp);
    let camp = g.spawn_building(Kind::LumberCamp, 1, x, y, 1.0);
    run(&mut g, 30.0);
    assert!(g.ents[camp as usize].crewed);
    let crew: Vec<u32> = g.ents.iter().filter(|e| e.alive && e.order == Order::Work(camp)).map(|e| e.id).collect();
    assert_eq!(crew.len(), 2);
    let wood = g.players[1].supply[Res::Wood.idx()];
    // Send one of them off: the camp stops, and doesn't hire anyone else.
    g.apply(1, Command::Smart { ids: vec![crew[0]], x: 20.0, y: 20.0 }).unwrap();
    run(&mut g, 20.0);
    assert!(!g.ents[camp as usize].hiring && !g.ents[camp as usize].crewed);
    assert_eq!(g.players[1].supply[Res::Wood.idx()], wood - 4);
    // Sending a worker back starts it hiring again: it fills up.
    g.apply(1, Command::Smart { ids: vec![crew[0]], x: g.ents[camp as usize].x, y: g.ents[camp as usize].y }).unwrap();
    run(&mut g, 30.0);
    assert!(g.ents[camp as usize].hiring && g.ents[camp as usize].crewed);
}

#[test]
fn a_killed_worker_stops_the_producer_until_someone_replaces_them() {
    let mut g = Game::new(5, 1, 2);
    let (x, y) = spot(&g, Kind::LumberCamp);
    let camp = g.spawn_building(Kind::LumberCamp, 1, x, y, 1.0);
    run(&mut g, 30.0);
    let w = g.ents.iter().find(|e| e.alive && e.order == Order::Work(camp)).unwrap().id;
    g.ents[w as usize].hp = 0.0;
    g.tick();
    g.tick();
    assert!(!g.ents[camp as usize].crewed, "one worker short: no wood");
    run(&mut g, 30.0);
    assert!(g.ents[camp as usize].crewed && g.ents[camp as usize].hiring, "a free worker took their place");
}

#[test]
fn newcomers_fill_free_beds_faster_in_a_bigger_town() {
    assert!(growth_interval(80) < growth_interval(40) && growth_interval(40) < growth_interval(8));
    let mut g = Game::new(5, 1, 2);
    build(&mut g, Kind::HuntingLodge); // a third good: 12 beds
    build(&mut g, Kind::LumberCamp);
    g.tick();
    let p = g.players[1];
    assert_eq!((p.people, p.beds), (11, 12));
    run(&mut g, growth_interval(12) * 2.0 + 0.2);
    assert_eq!(g.players[1].people, 12, "one newcomer came, and no more: every bed is taken");
    let newest = g.ents.iter().rev().find(|e| e.alive && e.kind == Kind::Worker).unwrap();
    assert!(g.is_free_worker(newest), "they turn up at the campfire");
}

#[test]
fn when_beds_run_short_free_workers_leave_first() {
    let mut g = Game::new(5, 1, 2);
    let lodge = build(&mut g, Kind::HuntingLodge); // 12 beds
    let camp = build(&mut g, Kind::LumberCamp);
    run(&mut g, 20.0);
    let soldiers: Vec<u32> = (0..3).map(|k| g.spawn_unit(Kind::Spearman, 1, 28.0 + k as f32, 28.0)).collect();
    g.tick();
    // The lodge burns: back to 8 beds for 15 people. The free go first.
    g.ents[lodge as usize].hp = 0.0;
    g.tick();
    g.tick();
    let p = g.players[1];
    assert!(p.people <= p.beds, "{} people, {} beds", p.people, p.beds);
    assert!(soldiers.iter().all(|&s| g.alive(s)), "soldiers keep their beds");
    assert!(g.ents[camp as usize].crewed, "workers at work stay while the free ones can go");
}

#[test]
fn demolishing_frees_slots_and_sends_workers_home() {
    let mut g = Game::new(5, 1, 2);
    let quarry = build(&mut g, Kind::Quarry);
    let crew: Vec<u32> = g.ents.iter().filter(|e| e.alive && e.order == Order::Work(quarry)).map(|e| e.id).collect();
    let wood = free(&g, Res::Wood);
    g.apply(1, Command::Demolish { ids: vec![quarry] }).unwrap();
    run(&mut g, 15.0);
    assert!(!g.alive(quarry));
    assert_eq!(free(&g, Res::Wood), wood + 2, "the quarry's wood is free");
    assert!(crew.iter().all(|&w| g.is_free_worker(&g.ents[w as usize])), "its workers walked back to the campfire");
    let cap = g.find_first(1, Kind::Capitol).unwrap() as u32;
    g.apply(1, Command::Demolish { ids: vec![cap] }).unwrap();
    g.tick();
    assert!(g.alive(cap), "the Capitol can't be demolished");
}

#[test]
fn nothing_is_built_on_the_campfire() {
    let g = Game::new(5, 1, 2);
    let (cx, cy) = g.campfire(1).unwrap();
    assert!(!g.can_place(Kind::Hut, cx as i32 - 1, cy as i32 - 1, 1, 0));
}

/// Two Normal computer players grow their towns into the Medieval era
/// within 45 minutes: guards against the AI stalling. (They no longer
/// finish each other off within the hour: two equal AIs raid each other
/// for a long time. See the plan's open questions.)
#[test]
fn normal_ais_reach_the_medieval_era() {
    for seed in [1, 99, 1234] {
        let mut g = Game::new(seed, 1, 2);
        g.set_ai(1, true);
        run(&mut g, 45.0 * 60.0);
        for p in 1..=2u8 {
            assert!(g.players[p as usize].era >= 1, "seed {seed}: P{p} is still Ancient: {}", census(&g, p));
            assert!(g.players[p as usize].people >= 40, "seed {seed}: P{p} stayed small: {}", census(&g, p));
            // It explored beyond its start, and only built where it had.
            let seen = g.explored.iter().filter(|&&b| b & (1 << p) != 0).count();
            assert!(seen > g.explored.len() / 4, "seed {seed}: P{p} saw only {seen} tiles");
            for e in g.ents.iter().filter(|e| e.alive && e.is_building() && e.owner == p) {
                assert!(g.explored_by(p, e.tx, e.ty), "built on unexplored ground");
            }
        }
    }
}

#[test]
#[ignore]
fn watch_the_ai() {
    // VC_SEED, VC_MINUTES and VC_EVERY tune the run from the shell.
    let env = |k: &str, d: u32| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
    let (seed, minutes, every) = (env("VC_SEED", 1234), env("VC_MINUTES", 14), env("VC_EVERY", 1));
    let (diff, players) = (env("VC_DIFF", 1), env("VC_PLAYERS", 2) as u8);
    let mut g = Game::new(seed, diff, players);
    g.set_ai(1, true);
    for min in 1..=minutes {
        run(&mut g, 60.0);
        if min % every == 0 || g.state != 0 {
            println!("{min:2} min  P1: {}", census(&g, 1));
            for p in 2..=players {
                println!("        P{p}: {}", census(&g, p));
            }
        }
        if g.state != 0 {
            println!("winner {} wonder {}", g.winner, g.by_wonder);
            break;
        }
    }
}



// ---------------------------------------------------------------------------
// Phase 4: house tiers, eras, converters, classes

#[test]
fn a_full_hut_with_every_good_becomes_a_cottage_and_back() {
    let mut g = Game::new(5, 1, 2);
    g.players[1].supply_pct = 200; // wood and stone to spare
    build(&mut g, Kind::HuntingLodge); // meat: 3 goods for both huts, 12 beds
    for _ in 0..4 {
        g.spawn_worker(1, None);
    }
    run(&mut g, 0.5);
    let used = |g: &Game| (g.players[1].used[Res::Wood.idx()], g.players[1].used[Res::Stone.idx()]);
    let hs = houses(&g, 1);
    assert!(hs.iter().all(|&h| g.ents[h].kind == Kind::Cottage), "full, 3 goods, materials free: both grow");
    // A cottage holds 2 wood and a stone (a hut held 1 wood); the lodge 1 wood.
    assert_eq!(used(&g), (2 * 2 + 1, 2));
    // The lodge burns: 2 goods is too few for a cottage, so they fall back
    // and give the extra materials back.
    let lodge = g.find_first(1, Kind::HuntingLodge).unwrap();
    g.ents[lodge].hp = 0.0;
    run(&mut g, 0.5);
    assert!(houses(&g, 1).iter().all(|&h| g.ents[h].kind == Kind::Hut));
    assert_eq!(used(&g), (2, 0));
}

#[test]
fn ten_houses_of_the_next_tier_bring_the_next_era() {
    let mut g = Game::new(5, 1, 2);
    g.players[1].supply_pct = 1000; // plenty of slots, so nothing else gets in the way
    build(&mut g, Kind::HuntingLodge); // and a third good, so cottages keep their tier
    let cottages = |g: &Game| g.ents.iter().filter(|e| e.alive && e.owner == 1 && e.kind == Kind::Cottage).count() as u32;
    // Add cottages one by one (the two huts may grow into some too): the
    // era comes on the tick there are ten, not before.
    while g.players[1].era == 0 {
        let before = cottages(&g);
        assert!(before < HOUSES_FOR_ERA, "{before} cottages and still Ancient");
        let (x, y) = spot(&g, Kind::Hut);
        g.spawn_building(Kind::Cottage, 1, x, y, 1.0);
        g.events.clear();
        g.tick();
    }
    assert!(cottages(&g) >= HOUSES_FOR_ERA);
    assert!(g.events.chunks(4).any(|e| e[0] == Ev::EraReached as u32 as f32 && e[3] == 17.0), "event: player 1, era 1");
    // Medieval kinds are unlocked now; the era is kept even if houses fall back.
    assert!(g.unlocked(1, Kind::IronMine));
    for i in 0..g.ents.len() {
        if g.ents[i].kind == Kind::Cottage {
            g.ents[i].hp = 0.0;
        }
    }
    run(&mut g, 1.0);
    assert_eq!(g.players[1].era, 1);
}

#[test]
fn medieval_things_wait_for_the_medieval_era() {
    let mut g = Game::new(5, 1, 2);
    g.players[1].supply_pct = 200;
    let (x, y) = spot(&g, Kind::Bakery);
    let r = g.apply(1, Command::Place { ids: vec![], kind: Kind::Bakery, tx: x, ty: y });
    assert_eq!(r.err(), Some(CmdError::Era(1)));
    let barracks = build(&mut g, Kind::Barracks);
    let r = g.apply(1, Command::Train { ids: vec![barracks], kind: Kind::Swordsman });
    assert_eq!(r.err(), Some(CmdError::Era(1)));
    assert!(g.apply(1, Command::Train { ids: vec![barracks], kind: Kind::Spearman }).is_ok());
}

#[test]
fn converters_hold_their_inputs_and_the_newest_stops_first() {
    let mut g = Game::new(5, 1, 2);
    g.players[1].era = 1;
    let supply = |g: &Game, r: Res| g.players[1].supply[r.idx()];
    // The Capitol's 2 grain feed one bakery: 2 bread.
    let first = build(&mut g, Kind::Bakery);
    assert!(g.ents[first as usize].fed);
    assert_eq!((supply(&g, Res::Bread), free(&g, Res::Grain)), (2, 0));
    // A second bakery finds no grain free: it stops, the first goes on.
    let second = build(&mut g, Kind::Bakery);
    assert!(g.ents[first as usize].fed && !g.ents[second as usize].fed);
    assert_eq!(supply(&g, Res::Bread), 2);
    // A farm feeds it too.
    build(&mut g, Kind::Farm);
    assert!(g.ents[second as usize].fed);
    assert_eq!(supply(&g, Res::Bread), 4);
    // Paused, a bakery makes nothing but still holds its grain.
    g.apply(1, Command::Hire { ids: vec![first], on: false }).unwrap();
    g.resolve();
    assert_eq!(supply(&g, Res::Bread), 2);
    assert_eq!(free(&g, Res::Grain), 0);
}

#[test]
fn counters_go_by_class_across_eras() {
    use Kind::*;
    for (a, t, m) in [(Spearman, Horseman, 2.5), (Swordsman, Knight, 2.5), (Spearman, Knight, 2.5), (Knight, Crossbowman, 2.0), (Crossbowman, Swordsman, 1.5), (Trebuchet, Barracks, 3.0), (Trebuchet, Spearman, 0.3), (Archer, Barracks, 0.2), (Tower, Knight, 1.3), (Worker, Worker, 1.0)] {
        assert_eq!(damage_mult(a, t), m, "{a:?} against {t:?}");
    }
}
